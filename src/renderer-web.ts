// Web 渲染器：实现 loop.ts 的 Renderer 接口，把循环事件以 JSON 事件推给 sink 回调。
// 与终端渲染器（bin/clinkai.ts 的 TerminalRenderer）完全同构——
// 核心循环只依赖 Renderer 接口，不关心事件最终落到 stdout 还是 SSE 流。
// 事件均为纯数据（可 JSON 序列化），不含任何活动对象引用。
import type { Renderer } from "./loop.ts";
import type { LoopState, ToolCall, ToolResult, Usage } from "./types.ts";

/** Web 事件 sink：每收到一个事件调用一次；参数必须是 JSON 可序列化的纯数据 */
export type WebSink = (evt: Record<string, unknown>) => void;

/**
 * Web 渲染器。
 * 事件协议（t 字段区分类型）：
 *   round / reasoning / delta / tool_start / tool_result / usage / meta / round_end
 * 前端按序消费即可还原终端版的全部视觉信息（轮次头、思考折叠、工具卡片、用量行）。
 */
export class WebRenderer implements Renderer {
  /** 事件出口 */
  private sink: WebSink;
  /** 当前轮思考字符累计（round_end 时报告，前端显示"N 字符已折叠"） */
  private reasoningChars = 0;

  /** @param sink 事件接收函数（SSE 发射器） */
  constructor(sink: WebSink) {
    this.sink = sink;
  }

  /** 新一轮开始：轮次头事件（前端显示"轮次 N/M · 估算上下文 X tokens"） */
  onRound(state: LoopState): void {
    // 每轮重置思考计数
    this.reasoningChars = 0;
    this.sink({
      t: "round",
      round: state.round,
      maxRounds: state.maxRounds,
      estTokens: state.estTokens,
      ctxBudget: state.ctxBudget,
      gitBranch: state.gitBranch,
      workspace: state.workspace,
    });
  }

  /** 模型正文增量：原样转发（前端流式追加到当前回答气泡） */
  onDelta(text: string): void {
    this.sink({ t: "delta", text });
  }

  /** 模型思考增量：原样转发（前端累加进折叠块，默认收起） */
  onReasoning(text: string): void {
    this.reasoningChars += text.length;
    this.sink({ t: "reasoning", text });
  }

  /** 工具开始：调用头事件（名称 + 参数原文，前端做 JSON 美化） */
  onToolStart(call: ToolCall): void {
    this.sink({
      t: "tool_start",
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }

  /** 工具结束：结果卡片事件（成功/失败 + 耗时 + 结果全文，前端折叠显示） */
  onToolResult(call: ToolCall, result: ToolResult): void {
    this.sink({
      t: "tool_result",
      id: call.id,
      name: call.function.name,
      ok: result.ok,
      durationMs: result.durationMs,
      text: result.text,
    });
  }

  /** 用量统计：缓存命中率一并算好（前缀冻结的可观测指标） */
  onUsage(usage: Usage): void {
    // 命中率：cached/prompt（prompt 为 0 时记 0，避免除零）
    const hit = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0;
    this.sink({
      t: "usage",
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      cacheHit: hit,
    });
  }

  /** 系统级说明（归档/熔断/续写/失败）：原样转发 */
  onMeta(text: string): void {
    this.sink({ t: "meta", text });
  }

  /** 一轮结束：携带思考总字符数（前端决定折叠提示的措辞） */
  onRoundEnd(): void {
    this.sink({ t: "round_end", reasoningChars: this.reasoningChars });
  }
}
