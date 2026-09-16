// 工具公共助手：路径解析+授权、输出截断、耗时包装。
// 各工具共用，避免每个工具里重复"围栏检查+截断"的样板代码。
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { truncateMiddle } from "../compress.ts";

/**
 * 解析模型给的路径并完成授权（工作区外会触发确认）。
 * @param kind 操作类型：read=只读（默认）；write=写入（write/edit 传 write，read-only 档会拒绝）
 * @returns 绝对路径；被拒绝时 ok=false（调用方把拒绝原因回填给模型）
 */
export async function resolveInWorkspace(ctx: ToolContext, p: string, kind: "read" | "write" = "read"): Promise<{ ok: boolean; abs?: string; text?: string }> {
  // 空路径直接视为非法（模型偶尔会传空串）
  if (typeof p !== "string" || p.trim().length === 0) {
    return { ok: false, text: "路径为空：请提供文件路径参数" };
  }
  // 围栏解析（纯字符串级，不触发 IO）
  const { abs, outside } = ctx.policy.resolvePath(p);
  // 三档安全：工作区内写入在 read-only 档被禁（authorizePath 内部已判，这里给出模式感知的提示）
  if (!outside && kind === "write" && ctx.policy.mode === "read-only") {
    return { ok: false, text: `read-only 模式禁止写入文件：${abs}。如需修改，请用 --security workspace-write（或 danger-full-access）重新启动会话。` };
  }
  // 工作区外需要授权；authorizePath 内部已做串行确认
  if (outside) {
    // 未获授权：返回拒绝文本（作为观察值回填，让模型换路径或向用户说明）
    const allowed = await ctx.policy.authorizePath(abs, kind);
    if (!allowed) {
      // 模式感知的拒绝原因（read-only 是策略拒绝，其余是用户未授权）
      const reason = ctx.policy.mode === "read-only"
        ? (kind === "write" ? "read-only 模式禁止写入" : "read-only 模式禁止访问工作区外路径")
        : "用户未授权";
      return { ok: false, text: `权限策略拒绝访问 ${abs}（${reason}）。请改用工作区内路径，或在回答中告知用户。` };
    }
  }
  return { ok: true, abs };
}

/**
 * 把工具输出截断到预算内（PDF 第 1 层压缩：工具结果预算）。
 * 截断信息会写进会话日志 meta 事件，便于事后核对。
 */
export function clipOutput(ctx: ToolContext, text: string): string {
  // 按会话配置的阈值截断（默认 8192 字符）
  const { text: clipped, truncated } = truncateMiddle(text, ctx.toolOutLimit);
  if (truncated && ctx.log) {
    // 留痕：被截断的工具输出是事后排查的高频对象
    ctx.log({ type: "meta", note: "tool-output-truncated", chars: text.length, limit: ctx.toolOutLimit });
  }
  return clipped;
}

/**
 * 耗时包装：统一计时 + 异常兜底。
 * 工具执行器不应抛出未捕获异常——任何异常都转成 ok=false 的文本结果。
 */
export async function timed<T extends { ok: boolean; text: string }>(fn: () => Promise<T>): Promise<ToolResult> {
  // 记录起点；finally 里统一算耗时
  const start = Date.now();
  try {
    // 正常路径：透传工具结果
    const r = await fn();
    return { ...r, durationMs: Date.now() - start };
  } catch (e) {
    // 异常路径：转文本返回（错误也是给模型看的观察值，PDF 纠正层）
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, text: `工具内部异常：${msg}`, durationMs: Date.now() - start };
  }
}
