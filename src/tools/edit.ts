// edit 工具：精确字符串替换（old_string → new_string）。
// ACI 设计（防呆核心）：old_string 必须唯一出现一次，否则拒绝执行——
// "让错误无法发生"：重复片段导致的多处误改是最常见的编辑事故。
import fs from "node:fs";
import type { Tool } from "./registry.ts";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { resolveInWorkspace, timed } from "./common.ts";

export const editTool: Tool = {
  name: "edit",
  description:
    "在文件中精确替换一段文本。参数：path（必填）；old_string（必填，要被替换的原文，" +
    "必须与文件内容逐字符一致且唯一出现一次）；new_string（必填，替换后的新文本，可为空字符串表示删除）；" +
    "replace_all（可选，布尔，true 时替换全部出现位置，默认 false）。" +
    "用法：先 read 文件，把 read 输出里的原文（含缩进）作为 old_string。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件路径" },
      old_string: { type: "string", description: "要被替换的原文片段（必须唯一）" },
      new_string: { type: "string", description: "替换后的新文本" },
      replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  // 执行器
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // 计时 + 异常兜底
    return timed(async () => {
      // 路径解析 + 围栏授权
      const r = await resolveInWorkspace(ctx, String(args.path));
      if (!r.ok || !r.abs) {
        return { ok: false, text: r.text ?? "路径解析失败" };
      }
      const abs = r.abs;
      // 文件必须已存在（edit 不创建文件——创建请用 write，语义分离防误用）
      if (!fs.existsSync(abs)) {
        return { ok: false, text: `文件不存在：${abs}。新建文件请用 write 工具。` };
      }
      const oldString = String(args.old_string);
      const newString = String(args.new_string);
      const replaceAll = args.replace_all === true;
      // old_string 为空没有替换意义（会把空串插到处）：直接拒绝
      if (oldString.length === 0) {
        return { ok: false, text: "old_string 不能为空：请提供要替换的原文片段。" };
      }
      // 读全文（edit 只支持文本；二进制由 existsSync+替换失败兜底提示）
      const text = fs.readFileSync(abs, "utf8");
      // 统计出现次数：indexOf 循环（只读扫描，不改字符串）
      let count = 0;
      let idx = text.indexOf(oldString);
      // 从第一个匹配开始逐次向后找
      while (idx >= 0) {
        count++;
        // 从匹配末尾继续找下一个
        idx = text.indexOf(oldString, idx + oldString.length);
      }
      // 未匹配：给模型可行动的诊断（常见原因：缩进/引号/行尾差异）
      if (count === 0) {
        return {
          ok: false,
          text: `old_string 在文件中未找到。请重新 read 该文件，逐字符核对原文（注意缩进、引号、行尾差异）后再试。`,
        };
      }
      // 默认要求唯一；replace_all 时要求至少一处（0 处已在上面拦截）
      if (!replaceAll && count > 1) {
        // 多处匹配：拒绝并告知数量，让模型扩大上下文使片段唯一
        return {
          ok: false,
          text: `old_string 在文件中出现 ${count} 次（默认要求唯一）。请包含更多上下文使其唯一，或传 replace_all=true 替换全部。`,
        };
      }
      // 执行替换：replaceAll 或单次 replace
      const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      // 写回（保持 UTF-8）
      fs.writeFileSync(abs, updated, "utf8");
      // 回执：替换了几处 + 路径（模型据此确认动作生效）
      const n = replaceAll ? count : 1;
      return { ok: true, text: `已替换 ${n} 处 → ${abs}` };
    });
  },
};
