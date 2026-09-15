// ls 工具：列目录 / 按 glob 找文件。
// ACI 设计：pattern 语义写清楚（* 匹配单层、** 递归），
// 输出格式固定（[dir]/[file] + 相对路径 + 大小），便于模型解析。
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { resolveInWorkspace, clipOutput, timed } from "./common.ts";

/** 无需遍历的巨型目录：一律跳过（node_modules 是 Windows 上 ls 卡死的头号来源） */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv"]);

export const lsTool: Tool = {
  name: "ls",
  description:
    "列出目录内容或按 glob 模式查找文件。参数：path（可选，目录路径，默认工作区）；" +
    "pattern（可选，glob 模式如 'src/**/*.ts' 或 '*.md'，只匹配文件名部分或相对路径）。" +
    "输出每行：[dir] 或 [file] 路径 (字节数)。结果最多 500 条，超出部分被省略并提示。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认工作区根目录" },
      pattern: { type: "string", description: "glob 模式，如 *.ts、src/**/*.md（** 表示任意层级）" },
    },
  },
  // 执行器
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 计时 + 异常兜底
    return timed(async () => {
      // 基准目录：默认工作区；给了 path 则解析+授权
      let base = ctx.workspace;
      if (typeof args.path === "string" && args.path.trim().length > 0) {
        const r = await resolveInWorkspace(ctx, String(args.path));
        if (!r.ok || !r.abs) {
          return { ok: false, text: r.text ?? "路径解析失败" };
        }
        base = r.abs;
        // 基准必须是目录（对文件 ls 没有意义）
        if (!fs.existsSync(base)) {
          return { ok: false, text: `目录不存在：${base}` };
        }
        if (!fs.statSync(base).isDirectory()) {
          return { ok: false, text: `${base} 是文件不是目录；列文件请用 read，找文件请用 pattern。` };
        }
      }

      const pattern = typeof args.pattern === "string" && args.pattern.trim().length > 0 ? args.pattern.trim() : null;

      // ── 分支 1：无 pattern —— 单层列目录（快、直观）──
      if (!pattern) {
        // 读目录项；权限错误由 timed 兜底
        const entries = fs.readdirSync(base, { withFileTypes: true });
        // 按名字排序，输出稳定（模型依赖顺序稳定性做对比）
        entries.sort((a, b) => a.name.localeCompare(b.name));
        // 上限 500 条：防止超大目录灌爆上下文
        const MAX = 500;
        const lines: string[] = [];
        // 逐个条目格式化：[dir]/[file] + 名字 + 文件大小（目录省略）
        for (const e of entries.slice(0, MAX)) {
          // 目录标记 dir，文件标记 file（符号链接按 file 处理，够用）
          const kind = e.isDirectory() ? "dir" : "file";
          let sizeStr = "";
          // 文件大小：仅文件尝试 stat，失败忽略（权限等）
          if (!e.isDirectory()) {
            try {
              sizeStr = ` (${fs.statSync(path.join(base, e.name)).size}B)`;
            } catch {
              // stat 失败不影响列表
              sizeStr = "";
            }
          }
          lines.push(`[${kind}] ${e.name}${sizeStr}`);
        }
        // 超出上限的提示
        if (entries.length > MAX) {
          lines.push(`[... 还有 ${entries.length - MAX} 个条目未显示，请用 pattern 缩小范围]`);
        }
        return { ok: true, text: clipOutput(ctx, `目录 ${base}：\n${lines.join("\n")}`) };
      }

      // ── 分支 2：有 pattern —— 递归 glob 匹配 ──
      // glob → 正则：先处理 **（跨层），再处理 *（单层），其余转义
      const re = globToRegex(pattern);
      const results: string[] = [];
      let scanned = 0;
      // 深度优先遍历；深度上限 8（防止误伤无限深目录）
      const walk = (dir: string, depth: number): void => {
        // 达到深度上限或结果已超上限时剪枝
        if (depth > 8 || results.length >= 500) {
          return;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          // 无权限/消失的目录：跳过（不中断整体遍历）
          return;
        }
        // 逐条目：目录递归、文件匹配
        for (const e of entries) {
          // 结果已够多：提前结束
          if (results.length >= 500) {
            return;
          }
          const full = path.join(dir, e.name);
          // 巨型依赖目录整体跳过
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) {
              continue;
            }
            // 递归子目录（深度+1）
            walk(full, depth + 1);
          } else {
            // 文件：用相对基准目录的路径做匹配（与模型给 pattern 的直觉一致）
            scanned++;
            const rel = path.relative(base, full).split(path.sep).join("/");
            // 匹配完整相对路径或仅文件名（两种写法都支持，降低误用）
            if (re.test(rel) || re.test(e.name)) {
              // 记录相对路径（模型后续工具调用更省字符）
              results.push(rel);
            }
          }
        }
      };
      // 从基准目录开始遍历
      walk(base, 0);
      // 无结果：给可行动的提示（模式写错/目录为空）
      if (results.length === 0) {
        return { ok: true, text: `在 ${base} 下没有匹配 "${pattern}" 的文件（扫描 ${scanned} 个文件）。请检查 pattern 写法（** 表示跨层）。` };
      }
      // 格式化输出
      const head = `匹配 ${pattern}（基准 ${base}），共 ${results.length} 个：\n`;
      return { ok: true, text: clipOutput(ctx, head + results.join("\n")) };
    });
  },
};

/**
 * glob 模式转正则（极简实现，覆盖本工具集需要的场景）。
 * 规则：** → 跨任意层级；* → 单层内任意字符；? → 单字符；其余字面量。
 */
function globToRegex(glob: string): RegExp {
  // 逐字符扫描，按顺序产出正则片段
  let out = "^";
  let i = 0;
  // 主扫描循环
  while (i < glob.length) {
    const c = glob[i];
    // 分支 1：**（两个星号）—— 跨层通配
    if (c === "*" && glob[i + 1] === "*") {
      // **/ 或 ** 单独出现都等价"任意深度"
      out += "(.*/)?";
      // 跳过已消费的 * 和 *，以及紧跟的 /
      i += 2;
      if (glob[i] === "/") {
        i += 1;
      }
      continue;
    }
    // 分支 2：单个 * —— 单层内任意（不含分隔符）
    if (c === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    // 分支 3：? —— 单字符
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    // 分支 4：正则特殊字符需转义（. + ( ) | ^ $ { } 等）
    if (".+()|^${}[]\\".includes(c)) {
      out += "\\" + c;
      i += 1;
      continue;
    }
    // 分支 5：普通字符（含 / 与中文）原样保留
    out += c;
    i += 1;
  }
  // 锚定结尾
  out += "$";
  // 大小写不敏感：Windows 文件系统不区分大小写，匹配也应如此
  return new RegExp(out, "i");
}
