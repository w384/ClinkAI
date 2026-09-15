// eval 夹具：扩展工具模块（memory/ext 任务用）
// 导出形态：export default [spec, ...]（tools-ext 契约的合法形态之一）
export default [
  {
    name: "ext_marker",
    description: "返回今日口令（固定字符串 KAL-PA-2026）。无参数。（eval 夹具：tools-ext 能力验收）",
    params: { type: "object", properties: {} },
    async execute() {
      return { ok: true, text: "今日口令：KAL-PA-2026" };
    },
  },
];
