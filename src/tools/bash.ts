// bash 工具：在本机执行 shell 命令（Windows 下走 pwsh -NoProfile -Command）。
// 安全边界（规划 D5）：非白名单命令必须经 PolicyGate 确认；
// 输出合并 stdout/stderr；超时杀进程；退出码非零时明确标注（错误也是观察值）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { clipOutput, timed } from "./common.ts";

export const bashTool: Tool = {
  name: "bash",
  description:
    "在本机执行一条 shell 命令（Windows 下通过 pwsh -NoProfile 运行，语法用 PowerShell）。" +
    "参数：command（必填，完整命令字符串）；workdir（可选，工作目录，默认工作区）；" +
    "timeout_ms（可选，超时毫秒数，默认 120000，上限 600000）。" +
    "注意：非只读命令（安装、删除、网络写等）执行前会请求用户确认；" +
    "输出为 stdout+stderr 合并文本，末尾附退出码（0=成功）。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令，如 Get-ChildItem src 或 npm run build" },
      workdir: { type: "string", description: "工作目录，默认工作区根目录" },
      timeout_ms: { type: "integer", description: "超时毫秒数，默认 120000" },
    },
    required: ["command"],
  },
  // 执行器
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 计时 + 异常兜底
    return timed(async () => {
      // 命令必须是非空字符串
      const command = String(args.command ?? "").trim();
      if (command.length === 0) {
        return { ok: false, text: "command 为空：请提供要执行的命令。" };
      }

      // ── 权限闸门：白名单放行，其余确认（串行队列保证提示不交错）──
      const authorized = await ctx.policy.authorizeBash(command);
      // 拒绝：把拒绝作为观察值回填（模型应换方案或向用户说明，而不是重试同命令）
      if (!authorized) {
        // 模式感知的拒绝原因（read-only 是策略拒绝，workspace-write 是用户未授权）
        const reason = ctx.policy.mode === "read-only" ? "read-only 模式禁止执行非白名单命令" : "用户未授权";
        return { ok: false, text: `权限策略拒绝执行该命令（${reason}）：${command}。请勿原样重试；如确需执行，请在回答中向用户说明理由。` };
      }

      // 工作目录：可选；解析后必须存在
      let workdir = ctx.workspace;
      if (typeof args.workdir === "string" && args.workdir.trim().length > 0) {
        // workdir 也走围栏检查（防止借 bash 读工作区外文件）
        const { abs, outside } = ctx.policy.resolvePath(args.workdir);
        if (outside && !(await ctx.policy.authorizePath(abs))) {
          return { ok: false, text: `权限策略拒绝使用工作区外目录：${abs}` };
        }
        workdir = abs;
        if (!fs.existsSync(workdir)) {
          return { ok: false, text: `工作目录不存在：${workdir}` };
        }
      }

      // 超时参数：默认 120s，硬顶 600s（防止一条命令挂死整个会话）
      const timeoutMs = Math.min(600_000, Math.max(1000, Math.floor(Number(args.timeout_ms ?? 120_000) || 120_000)));

      // ── 启动子进程 ──
      // 关键决策：不用管道捕获输出（某些沙箱/策略环境禁止管道 stdio，spawn 直接 EPERM），
      // 改为"PowerShell 重定向到工作区内临时文件 + 退出后读文件"：
      //   & { <command> } *> '<out>'; <按 $LASTEXITCODE 退出>
      // 文件写在工作区内（围栏内、沙箱可写区），两种环境都可用。
      // 输出文件路径（工作区内隐藏目录，用完即删）
      const outDir = path.join(ctx.workspace, ".clinkai-bash");
      fs.mkdirSync(outDir, { recursive: true });
      // 唯一文件名：进程号 + 时间戳 + 随机后缀（防并发同毫秒碰撞）
      const outFile = path.join(outDir, `out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      // PowerShell 单引号转义：内部单引号翻倍
      const outQuoted = "'" + outFile.replace(/'/g, "''") + "'";

      // 包装命令（两种 PowerShell 版本都兼容）：
      //   & { 用户命令 2>&1 } —— 脚本块执行；2>&1 把错误流并入输出流
      //   | Out-File -Encoding utf8 —— 用 UTF-8 落盘（绕开控制台 GBK 代码页问题，
      //     且在受限语言模式下仍可用——Out-File 是 cmdlet，不是 .NET 静态调用）
      //   退出码：取 $LASTEXITCODE（原生命令的退出码）；纯 PowerShell 命令保持 0
      const wrapped = `& { ${command} 2>&1 } | Out-File -FilePath ${outQuoted} -Encoding utf8; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }; exit 0`;

      // ── 启动子进程（带 shell 回退）──
      // 候选顺序：pwsh（7.x，优先）→ powershell（Windows PowerShell 5.1，保底）。
      // stdio 用 inherit：部分沙箱环境只允许子进程继承父 stdio（pipe/ignore 会 EPERM）；
      // 输出捕获不依赖管道——包装命令已把全部流写入文件，inherit 只是载体。
      const SHELLS = ["pwsh", "powershell"];
      let child: ReturnType<typeof spawn> | undefined;
      // 已缓存的退出码（进程可能在判定窗口内就已结束——必须先挂监听再等待，防竞态）
      let cachedCode: number | null = null;
      let cachedErr: NodeJS.ErrnoException | null = null;
      // 从第一个候选开始尝试
      for (let i = 0; i < SHELLS.length; i++) {
        const shell = SHELLS[i];
        // 尝试启动
        const c = spawn(shell, ["-NoProfile", "-Command", wrapped], {
          cwd: workdir,
          stdio: ["ignore", "inherit", "inherit"],
          // 子进程环境变量原样继承（PATH 等）；不额外注入
          windowsHide: true,
        });
        // 关键：立即挂监听并缓存事件（进程可能在几百毫秒内就结束，
        // 若等判定完再挂监听，close 事件已错过 → 永久挂起。曾因此挂死）
        cachedCode = null;
        cachedErr = null;
        const settled = new Promise<void>((res) => {
          // 正常退出：缓存退出码
          c.on("close", (code) => {
            cachedCode = code ?? -1;
            res();
          });
          // 启动失败：缓存错误
          c.on("error", (e) => {
            cachedErr = e as NodeJS.ErrnoException;
            res();
          });
        });
        // 判定：等到 close/error，或 200ms 窗口结束（进程还在跑=存活）
        const verdict = await Promise.race<string>([
          // 事件先到：按事件类型判定
          settled.then(() => {
            // ENOENT → 换候选
            if (cachedErr?.code === "ENOENT") {
              return "enoent";
            }
            // 其他启动错误 → 环境问题
            if (cachedErr !== null) {
              return "other";
            }
            // close 先到 → 进程已跑完，采用
            return "alive";
          }),
          // 200ms 无事件 → 视为存活
          new Promise<string>((res) => setTimeout(() => res("alive"), 200)),
        ]);
        // 换候选
        if (verdict === "enoent") {
          continue;
        }
        // 启动被环境拒绝（EPERM 等）：换 shell 也解决不了，直接报告
        if (verdict === "other") {
          return {
            ok: false,
            text: `shell（${shell}）启动被环境拒绝（如沙箱禁止子进程）。命令未执行：${command}`,
          };
        }
        // 采用该 shell
        child = c;
        break;
      }
      // 所有候选都不存在
      if (!child) {
        // 明确报告（两种 PowerShell 都缺 → 环境问题）
        return {
          ok: false,
          text: `未找到可用的 PowerShell（已尝试 pwsh 与 powershell）。请安装 PowerShell 7 或确认 Windows PowerShell 可用。命令未执行：${command}`,
        };
      }

      let killed = false;
      // 超时控制：到点杀进程
      const timer = setTimeout(() => {
        killed = true;
        // 杀进程：Windows 上 kill 可能只杀 shell 壳（极简实现，接受该边界）
        try {
          child.kill();
        } catch {
          // 进程可能已退出，忽略
        }
      }, timeoutMs);

      // 等待退出：若判定窗口内已缓存退出码则直接用；否则等 close/error
      let exitCode: number;
      if (cachedCode !== null) {
        // 已缓存（进程在 200ms 窗口内就跑完了）
        exitCode = cachedCode;
      } else {
        // 还在跑：等它结束（error 事件也要能 resolve）
        exitCode = await new Promise<number>((resolve) => {
          // 正常退出
          child.on("close", (code) => resolve(code ?? -1));
          // 启动失败（EPERM 等）
          child.on("error", () => resolve(-1));
        });
      }
      clearTimeout(timer);

      // ── 读回输出文件并清理 ──
      // 读文件失败（被杀/未创建）按空输出处理
      let raw = "";
      try {
        if (fs.existsSync(outFile)) {
          // 大小保护：最多读 1MB（防止一条命令写出巨量文件撑爆上下文）
          const size = fs.statSync(outFile).size;
          if (size > 0) {
            // 大文件只取尾部（构建日志结论通常在尾部）
            const start = Math.max(0, size - 1_000_000);
            const fd = fs.openSync(outFile, "r");
            const buf = Buffer.alloc(Math.min(size, 1_000_000));
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            // Out-File -Encoding utf8 在 Windows PowerShell 5.1 下带 BOM → 去掉
            raw = buf.toString("utf8");
            if (raw.startsWith("\uFEFF")) {
              raw = raw.slice(1);
            }
          }
        }
      } catch {
        // 读失败视为无输出（保留退出码信息）
        raw = "";
      }
      // 清理临时文件（失败忽略，目录留待下次覆盖）
      try {
        fs.unlinkSync(outFile);
      } catch {
        // 忽略清理失败
      }

      // ── 组装观察值文本 ──
      // 超时被杀：明确标注（模型应减小工作量或换方案）
      if (killed) {
        return {
          ok: false,
          text: `命令超时（${timeoutMs}ms）被终止：${command}\n已有输出：\n${raw.slice(-4000) || "（无输出）"}`,
        };
      }
      // 退出码：0 成功，其余失败（$LASTEXITCODE 经包装透传）
      const ok = exitCode === 0;
      // 输出文本：尾部 8000 字符（完整流已在文件里，这里只取结论区）
      let text = raw.length > 0 ? raw.slice(-8000) : "（命令无输出）";
      // 退出码标注：非零时红字语义——"失败也是有效观察值"
      text += `\n[退出码 ${exitCode}${ok ? "（成功）" : "（失败）"}]`;
      // 预算截断
      return { ok, text: clipOutput(ctx, text) };
    });
  },
};
