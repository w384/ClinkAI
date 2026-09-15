// grep 工具：在工作区内正则搜索文件内容。
// ACI 设计：pattern 是 JS 正则；输出固定为 "文件:行号: 内容"；
//           内置跳过 node_modules/.git/二进制，避免 Windows 全盘扫描卡死。
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { resolveInWorkspace, clipOutput, timed } from "./common.ts";

/** 跳过的目录（依赖与 VCS 元数据，内容搜索几乎永远不需要它们） */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".npm-cache"]);
/** 按扩展名判定的二进制文件（不读内容，省 IO） */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".zip", ".gz", ".tar", ".7z", ".rar", ".pdf",
  ".woff", ".woff2", ".ttf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pyc", ".class", ".jar",
]);

export const grepTool: Tool = {
  name: "grep",
  description:
    "用 JavaScript 正则在文件内容中搜索。参数：pattern（必填，JS 正则，如 'function\\s+\\w+'，" +
    "不区分大小写）；path（可选，限定目录，默认工作区）；include（可选，文件名 glob 过滤，如 '*.ts'）；" +
    "max_results（可选，最多返回条数，默认 100，上限 500）。" +
    "输出每行：相对路径:行号: 匹配内容（匹配行过长时截断）。自动跳过 node_modules/.git/二进制。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JS 正则表达式，如 TODO|FIXME" },
      path: { type: "string", description: "限定搜索的目录，默认工作区" },
      include: { type: "string", description: "文件名过滤 glob，如 *.ts、*.{ts,tsx}（不支持花括号扩展，只支持 *.ts 形式）" },
      max_results: { type: "integer", description: "最多返回匹配条数，默认 100" },
    },
    required: ["pattern"],
  },
  // 执行器
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 计时 + 异常兜底
    return timed(async () => {
      // 基准目录
      let base = ctx.workspace;
      if (typeof args.path === "string" && args.path.trim().length > 0) {
        const r = await resolveInWorkspace(ctx, String(args.path));
        if (!r.ok || !r.abs) {
          return { ok: false, text: r.text ?? "路径解析失败" };
        }
        base = r.abs;
        if (!fs.existsSync(base)) {
          return { ok: false, text: `目录不存在：${base}` };
        }
      }

      // 编译正则：无效正则给模型明确错误（而不是让它无限重试）
      let re: RegExp;
      try {
        // 全局标志（多行匹配需要 g）；i 标志统一（Windows 习惯）
        re = new RegExp(String(args.pattern), "gi");
      } catch (e) {
        // 正则语法错误：直接报给模型修正
        return { ok: false, text: `pattern 不是合法的正则表达式：${e instanceof Error ? e.message : String(e)}。请检查转义字符。` };
      }

      // include 文件名过滤器：转成"以 .ext 结尾"的简易判断（只支持 *.ext 与裸扩展名）
      const include = typeof args.include === "string" && args.include.trim().length > 0 ? args.include.trim() : null;
      const matchInclude = (fileName: string): boolean => {
        // 未指定过滤：全部通过
        if (!include) {
          return true;
        }
        // 支持 "*.ts" → 以 .ts 结尾
        if (include.startsWith("*.")) {
          return fileName.toLowerCase().endsWith(include.slice(1).toLowerCase());
        }
        // 支持 "ts" → 以 .ts 结尾（容忍省略星号的写法）
        if (!include.includes(".")) {
          return fileName.toLowerCase().endsWith("." + include.toLowerCase());
        }
        // 其余情况：按小写包含匹配兜底
        return fileName.toLowerCase().includes(include.toLowerCase());
      };

      // 结果收集
      const results: string[] = [];
      // 条数上限：默认 100，硬顶 500
      const maxResults = Math.min(500, Math.max(1, Math.floor(Number(args.max_results ?? 100) || 100)));
      let scannedFiles = 0;

      // 深度优先遍历 + 逐文件搜索
      const walk = (dir: string, depth: number): void => {
        // 深度上限 8 / 结果够多时剪枝
        if (depth > 8 || results.length >= maxResults) {
          return;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          // 不可读目录跳过
          return;
        }
        for (const e of entries) {
          // 结果已满：停止
          if (results.length >= maxResults) {
            return;
          }
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            // 跳过依赖/元数据目录
            if (SKIP_DIRS.has(e.name)) {
              continue;
            }
            // 递归
            walk(full, depth + 1);
            continue;
          }
          // 文件：扩展名黑名单 + include 过滤
          const ext = path.extname(e.name).toLowerCase();
          if (BINARY_EXT.has(ext)) {
            continue;
          }
          if (!matchInclude(e.name)) {
            continue;
          }
          // 读文本（大小保护：>1MB 的文件跳过，避免把巨型生成文件读进来）
          let text: string;
          try {
            const st = fs.statSync(full);
            // 超大文件跳过（通常是被误提交的构建产物）
            if (st.size > 1_000_000) {
              continue;
            }
            text = fs.readFileSync(full, "utf8");
          } catch {
            // 读失败（权限/二进制解码错误）：跳过
            continue;
          }
          scannedFiles++;
          // 二进制内容兜底判定：出现 NUL 即视为二进制，放弃
          if (text.includes("\u0000")) {
            continue;
          }
          // 逐行匹配（比整块正则更省内存且输出带行号）
          const lines = text.split("\n");
          for (let li = 0; li < lines.length; li++) {
            // 每行重新 lastIndex=0（全局标志正则的 lastIndex 是有状态的）
            re.lastIndex = 0;
            // 行内匹配
            const m = re.exec(lines[li]);
            // 命中：记录 相对路径:行号: 内容
            if (m) {
              const rel = path.relative(base, full).split(path.sep).join("/");
              // 匹配行截断到 400 字符（长行不炸上下文）
              const lineText = lines[li].replace(/\r$/, "").slice(0, 400);
              results.push(`${rel}:${li + 1}: ${lineText}`);
              // 满额提前结束
              if (results.length >= maxResults) {
                return;
              }
            }
          }
        }
      };
      // 从基准目录开始
      walk(base, 0);

      // 无结果：提示可能原因（模式过严/目录不对）
      if (results.length === 0) {
        return { ok: true, text: `在 ${base} 下扫描 ${scannedFiles} 个文件，未匹配到 "${args.pattern}"。可尝试放宽正则或检查 include 过滤。` };
      }
      // 有结果：格式化
      const head = `匹配 ${results.length} 条（扫描 ${scannedFiles} 个文件，上限 ${maxResults}）：\n`;
      return { ok: true, text: clipOutput(ctx, head + results.join("\n")) };
    });
  },
};
