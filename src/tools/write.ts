// write 工具：整文件覆盖写入。
// ACI 设计：描述里明确"覆盖"语义 + "改已有文件优先用 edit"，
// 防止模型用 write 去"改"文件（丢内容的高危误用，PDF 防呆原则）。
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { resolveInWorkspace, timed } from "./common.ts";

export const writeTool: Tool = {
  name: "write",
  description:
    "创建新文件或整体覆盖已有文件（整文件替换，不是追加！）。" +
    "参数：path（必填，目标文件路径）；content（必填，完整文件内容字符串）。" +
    "修改已有文件的一小部分请优先用 edit 工具（更省 token 且不易丢内容）。" +
    "目录不存在时会自动创建。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径，如 notes/todo.md" },
      content: { type: "string", description: "完整文件内容（UTF-8 文本）" },
    },
    required: ["path", "content"],
  },
  // 执行器
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 计时 + 异常兜底
    return timed(async () => {
      // 路径解析 + 围栏授权（工作区外需确认；write 传 write，read-only 档会拒绝）
      const r = await resolveInWorkspace(ctx, String(args.path), "write");
      if (!r.ok || !r.abs) {
        return { ok: false, text: r.text ?? "路径解析失败" };
      }
      const abs = r.abs;
      // content 必须是非空字符串（循环层已校验类型，这里补业务规则）
      const content = String(args.content ?? "");
      if (content.length === 0) {
        // 空内容写入几乎总是模型失误：明确拒绝
        return { ok: false, text: "content 为空：write 需要完整文件内容。想清空文件请确认后再传空字符串以外的说明。" };
      }
      // 覆盖写前记录原大小（便于事后审计"改了什么"）
      let prevSize = 0;
      // 文件已存在时读大小；不存在则视为新建
      if (fs.existsSync(abs)) {
        try {
          prevSize = fs.statSync(abs).size;
        } catch {
          // stat 失败按新建处理
          prevSize = 0;
        }
      }
      // 确保父目录存在（模型经常一次写多级新目录）
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // 写入 UTF-8；Windows 下默认行尾保持模型给的 \n（不强制 CRLF，避免 diff 噪音）
      fs.writeFileSync(abs, content, "utf8");
      // 返回写入回执：新建/覆盖 + 字符数 + 路径（给模型确认信号）
      const kind = prevSize === 0 ? "已创建" : `已覆盖（原 ${prevSize} 字节）`;
      return { ok: true, text: `${kind} ${abs}（${content.length} 字符）` };
    });
  },
};
