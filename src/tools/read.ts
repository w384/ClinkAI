// read 工具：按行号读取文本文件（先读后改的"读"）。
// ACI 设计（PDF §4.2.4 工具描述的艺术）：
//   - 明确返回格式（带行号），模型 edit 时可直接引用行内容；
//   - offset/limit 默认值写进描述，避免模型漏传；
//   - 二进制文件给明确错误而不是乱码。
import fs from "node:fs";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { resolveInWorkspace, clipOutput, timed } from "./common.ts";

export const readTool: Tool = {
  name: "read",
  description:
    "读取文本文件内容，返回带行号（每行前缀 '行号\\t'）。" +
    "参数：path（必填，文件或目录路径，相对工作区或绝对路径）；" +
    "offset（可选，从第几行开始，1 起，默认 1）；limit（可选，最多读多少行，默认 2000）。" +
    "用途：修改文件前必须先 read；查看目录内容请改用 ls。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径，如 src/main.ts 或 D:\\proj\\data.json" },
      offset: { type: "integer", description: "起始行号（1 起），默认 1" },
      limit: { type: "integer", description: "最多读取行数，默认 2000" },
    },
    required: ["path"],
  },
  // 执行器：参数已由循环层校验过类型，这里只做业务检查
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 统一计时 + 异常兜底
    return timed(async () => {
      // 路径解析 + 围栏授权
      const r = await resolveInWorkspace(ctx, String(args.path));
      if (!r.ok || !r.abs) {
        return { ok: false, text: r.text ?? "路径解析失败" };
      }
      const abs = r.abs;
      // 文件存在性检查：不存在是最高频错误，给模型可行动的提示
      if (!fs.existsSync(abs)) {
        return { ok: false, text: `文件不存在：${abs}。请先用 ls 工具确认目录结构。` };
      }
      // 读原始 Buffer：先判二进制再按 utf8 解析（避免把图片当文本读出乱码）
      const buf = fs.readFileSync(abs);
      // 二进制判定：前 8KB 出现 NUL 字节即视为二进制
      const head = buf.subarray(0, 8192);
      if (head.includes(0)) {
        return { ok: false, text: `这是二进制文件（${buf.length} 字节），read 只支持文本。可用 ls 查看大小，或改用 bash 处理。` };
      }
      const text = buf.toString("utf8");
      // 行号参数：缺省 1 起、2000 行上限（防止一次把 10 万行灌进上下文）
      const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
      const limit = Math.max(1, Math.min(20000, Math.floor(Number(args.limit ?? 2000) || 2000)));
      // 切行：split 会保留 \r（Windows CRLF），统一去掉行尾 \r 再编号
      const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
      // 越界保护：offset 超出总行数时给明确提示而不是返回空
      if (offset > lines.length) {
        return { ok: false, text: `offset=${offset} 超过文件总行数 ${lines.length}。` };
      }
      // 截取 [offset, offset+limit) 并加行号前缀（行号用原始全局行号，方便模型引用）
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
      // 头尾元信息：让模型知道"文件还有多少行没看到"
      const footer = `\n[文件共 ${lines.length} 行；已显示 ${offset}–${Math.min(offset + slice.length, lines.length)}；总大小 ${buf.length} 字节]`;
      // 输出截断（预算控制）
      return { ok: true, text: clipOutput(ctx, numbered + footer) };
    });
  },
};
