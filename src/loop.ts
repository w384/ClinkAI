// agent 循环：ClinkAI 的核心状态机（PDF §5.1.2 核心循环 + §5.1.5 故障三层）。
//
// 一轮 = 一次模型调用 +（如有）一次并行工具批。
// 终止条件（优先级从高到低）：
//   1. 模型自然结束（finish_reason=stop 且无工具调用）→ done
//   2. 重复指纹熔断：同一 tool+参数连续 3 次 → breaker-repeat（防死循环，PDF §2.7.4）
//   3. 连续失败熔断：同一工具连续失败 3 次 → breaker-failure
//   4. 全局轮数上限 → max-rounds
//   5. 模型/工具异常 → error
// 输出截断（finish_reason=length）：自动追加"请继续"，最多 2 次（防续写死循环）。
import type { Config } from "./config.ts";
import type { AgentReport, ChatMessage, LoopState, ToolCall, ToolResult, Usage } from "./types.ts";
import { streamChat } from "./model-client.ts";
import { validateArgs, findTool } from "./tools/registry.ts";
import type { Tool } from "./tools/registry.ts";
import type { ToolContext } from "./policy.ts";
import { buildStatusLine } from "./prompt.ts";
import { estimateMessagesTokens, archiveOldest } from "./compress.ts";

/** 重复指纹熔断阈值：同一 tool+参数连续出现 N 次即停（PDF §2.7.4 重复指纹） */
const REPEAT_BREAKER = 3;
/** 连续失败熔断阈值：同一工具连续失败 N 次即停 */
const FAILURE_BREAKER = 3;
/** finish_reason=length 的自动续写次数上限 */
const MAX_CONTINUATIONS = 2;

/** CLI 渲染器接口（bin 层实现具体打印） */
export interface Renderer {
  /** 新一轮开始 */
  onRound(state: LoopState): void;
  /** 模型正文增量 */
  onDelta(text: string): void;
  /** 模型思考增量 */
  onReasoning(text: string): void;
  /** 一个工具开始执行 */
  onToolStart(call: ToolCall): void;
  /** 一个工具执行结束 */
  onToolResult(call: ToolCall, result: ToolResult): void;
  /** 一轮的用量统计 */
  onUsage(usage: Usage): void;
  /** 系统级说明（归档、熔断、截断续写等） */
  onMeta(text: string): void;
  /** 一轮正文结束（用于打印分隔） */
  onRoundEnd(): void;
}

/** runAgent 的入参 */
export interface AgentOptions {
  /** 本轮任务（用户输入） */
  task: string;
  cfg: Config;
  tools: Tool[];
  ctx: ToolContext;
  /** 会话记录（append） */
  record: (role: "user" | "assistant" | "tool", msg: ChatMessage, extra?: Record<string, unknown>) => void;
  /** 元事件落盘（归档/熔断等系统动作） */
  meta: (note: string, extra?: Record<string, unknown>) => void;
  /** resume 时继承的历史消息（system 之后、本任务之前） */
  inherited: ChatMessage[];
  renderer: Renderer;
  /** 系统提示词（已冻结的静态前缀） */
  system: string;
  /** git 分支（状态栏用，取不到为空串） */
  gitBranch: string;
}

/**
 * 运行一个完整的 agent 任务。
 * 返回结构化报告；过程事件通过 renderer 实时输出、通过 record/meta 落盘。
 */
export async function runAgent(opts: AgentOptions): Promise<AgentReport> {
  const { cfg, tools, ctx, renderer, record, meta, system } = opts;

  // ── 消息列表：[system(冻结), ...继承历史, 本任务 user 消息] ──
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...opts.inherited,
    { role: "user", content: opts.task },
  ];
  // 记录用户任务（会话留痕）
  record("user", messages[messages.length - 1]);

  // ── 循环状态 ──
  let round = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let continuations = 0; // 已用续写次数
  // 重复指纹：上一轮每个工具调用签名（name+args）的出现计数
  let lastFingerprint: string | null = null;
  let repeatCount = 0;
  // 每工具连续失败计数（成功即清零该工具）
  const failStreak = new Map<string, number>();
  // 归档摘要只允许发生一次：失败后不再重试（防"压缩失败死循环"）
  let archiveAttempted = false;
  // 上下文估算基准：上一次模型调用返回的真实 prompt token 数 + 当时的消息数。
  // 真实计数最准（模型自己的分词器），增量部分用 estimateMessagesTokens 粗估。
  let actualPromptBaseline = 0;
  let baselineMsgCount = 0;

  /** 计算当前轨迹的上下文估算值（真实基准 + 新增长度） */
  const estimateContext = (): number => {
    // 有真实基准时：基准 + 基准之后新增消息的估算
    if (actualPromptBaseline > 0) {
      const delta = messages.length > baselineMsgCount ? estimateMessagesTokens(messages.slice(baselineMsgCount)) : 0;
      return actualPromptBaseline + delta;
    }
    // 首次调用前：整列表粗估
    return estimateMessagesTokens(messages);
  };

  // 组装工具定义（发给模型；整个会话不变 → 前缀稳定）
  const toolDefs = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  // ── 主循环 ──
  for (;;) {
    // 轮数上限检查（全局保险丝）
    if (round >= cfg.maxRounds) {
      // 熔断：达到全局轮数上限
      meta("breaker-max-rounds", { rounds: round });
      renderer.onMeta(`⛔ 达到全局轮数上限（${cfg.maxRounds}），循环终止。`);
      return finishReport("max-rounds", `达到全局轮数上限 ${cfg.maxRounds}`, round, totalPrompt, totalCompletion, totalCached);
    }
    round++;

    // 状态栏（发送时临时追加在轨迹末尾；不落盘、不动前缀）
    const estTokens = estimateContext();
    const state: LoopState = {
      round,
      maxRounds: cfg.maxRounds,
      estTokens,
      ctxBudget: cfg.ctxBudget,
      workspace: cfg.workspace,
      gitBranch: opts.gitBranch,
    };
    renderer.onRound(state);

    // ── 归档摘要检查（M2 压缩层）：轨迹超预算且未尝试过 ──
    if (!archiveAttempted && estTokens > cfg.ctxBudget) {
      // 自适应保留数：短轨迹少留（保证可压缩量≥3条），长轨迹多留近期上下文
      const nonSystem = messages.length - 1;
      const keepRecent = Math.max(2, Math.min(8, Math.floor(nonSystem / 3)));
      // 触发一次归档；失败保持原状继续（截断仍可用）
      renderer.onMeta(`↻ 上下文约 ${estTokens} tokens 超预算 ${cfg.ctxBudget}，执行归档摘要（保留最近 ${keepRecent} 条）…`);
      const archived = await archiveOldest(cfg, messages, keepRecent);
      // 无论成败都标记"已尝试"，绝不重试（熔断思想）
      archiveAttempted = true;
      if (archived.ok) {
        // 替换消息列表（system + 摘要 + 近期）
        messages.length = 0;
        messages.push(...archived.messages);
        // 归档后轨迹变短：估算基准作废，等下次模型调用刷新
        actualPromptBaseline = 0;
        baselineMsgCount = 0;
        // 留痕：归档是重要状态变更
        meta("archive-summary", { before: estTokens, kept: keepRecent });
        renderer.onMeta(`↻ 归档完成：最旧消息压缩为一条摘要。`);
      } else {
        // 归档未生效：给出准确原因（内容太少是正常情况，网络错误才需要关注）
        meta("archive-skipped", { estTokens, error: archived.error });
        renderer.onMeta(`↻ 归档未执行（${archived.error}），继续使用截断策略。`);
      }
    }

    // 本轮发送的消息 = 现有轨迹 + 临时状态栏（状态栏不进 messages，保持落盘与发送一致的历史）
    const sendMessages: ChatMessage[] = [...messages, { role: "user", content: buildStatusLine(state) }];

    // ── 模型调用（流式） ──
    let result;
    try {
      result = await streamChat(cfg, sendMessages, {
        tools: toolDefs,
        handlers: {
          // 正文增量：实时打印
          onDelta: (t) => renderer.onDelta(t),
          // 思考增量：实时打印（渲染层负责折叠/截断）
          onReasoning: (t) => renderer.onReasoning(t),
        },
      });
    } catch (e) {
      // 模型级错误（网络/超时/HTTP）：记录后终止（重试已在客户端层做过 1 次）
      const msg = e instanceof Error ? e.message : String(e);
      meta("error-model", { message: msg, round });
      renderer.onMeta(`⛔ 模型调用失败：${msg}`);
      return finishReport("error", `模型调用失败：${msg}`, round, totalPrompt, totalCompletion, totalCached);
    }

    // 用量累计（cached 是前缀冻结生效的可观测指标）
    if (result.usage) {
      totalPrompt += result.usage.promptTokens;
      totalCompletion += result.usage.completionTokens;
      totalCached += result.usage.cachedTokens;
      // 用真实 prompt 计数刷新估算基准（最准的上下文信号）
      actualPromptBaseline = result.usage.promptTokens;
      baselineMsgCount = messages.length;
      renderer.onUsage(result.usage);
    }

    // 组装 assistant 消息并落盘（工具调用参数原样保存）
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    };
    messages.push(assistantMsg);
    record("assistant", assistantMsg, { finish_reason: result.finishReason, usage: result.usage });
    renderer.onRoundEnd();

    // ── 分支 A：无工具调用 → 检查是否被截断 ──
    if (result.toolCalls.length === 0) {
      // 被 max_tokens 截断（length）且还有续写额度 → 自动续写（PDF 风险表）
      if (result.finishReason === "length" && continuations < MAX_CONTINUATIONS) {
        continuations++;
        // 续写指令作为 user 消息进入轨迹（这是真实对话的一部分，要落盘）
        const cont: ChatMessage = { role: "user", content: "（上一轮输出被 max_tokens 截断，请继续完成，不要重复已说过的内容。）" };
        messages.push(cont);
        record("user", cont, { continuation: true });
        meta("continuation", { round, continuations });
        renderer.onMeta(`↻ 输出被截断（finish_reason=length），自动续写（${continuations}/${MAX_CONTINUATIONS}）。`);
        continue;
      }
      // 正常结束：模型给出最终回答
      meta("done", { rounds: round });
      return finishReport("done", undefined, round, totalPrompt, totalCompletion, totalCached);
    }

    // ── 分支 B：有工具调用 → 逐个解析/校验/授权，再并行执行 ──
    // 每个调用的处理结果：要么可执行（tool+args），要么错误文本（回填给模型）
    const prepared: { call: ToolCall; tool?: Tool; args?: Record<string, unknown>; errorText?: string }[] = [];
    for (const call of result.toolCalls) {
      // 查工具：必须在"本次会话提供的 tools 列表"里找（与发给模型的数组同源）
      // 不存在的名字给可理解错误（模型可能幻觉出不存在的工具）
      const tool = findTool(call.function.name, tools);
      if (!tool) {
        // 工具不存在：错误回填（纠正层）
        const errText = `未知工具 "${call.function.name}"。可用工具：${tools.map((t) => t.name).join(", ")}。`;
        prepared.push({ call, errorText: errText });
        continue;
      }
      // 解析参数 JSON：模型可能输出残缺 JSON（max_tokens 截断或格式错误）
      let args: unknown;
      try {
        // 空参数串视为 {}（部分模型对无参工具会输出空串）
        args = call.function.arguments.trim().length > 0 ? JSON.parse(call.function.arguments) : {};
      } catch (e) {
        // JSON 损坏：把原文带回给模型让它修正（比直接报错更有信息量）
        const snippet = call.function.arguments.slice(0, 200);
        const errText = `工具 ${call.function.name} 的参数不是合法 JSON：${e instanceof Error ? e.message : String(e)}。参数原文（前 200 字符）：${snippet}。请重新输出完整参数。`;
        prepared.push({ call, errorText: errText });
        continue;
      }
      // Schema 校验：类型/必填/枚举
      const schemaErrors = validateArgs(tool.parameters, args);
      if (schemaErrors.length > 0) {
        // 校验失败：逐条列出错误（模型通常能一次改对）
        const errText = `工具 ${call.function.name} 参数校验失败：\n- ${schemaErrors.join("\n- ")}\n请修正后重试。`;
        prepared.push({ call, errorText: errText });
        continue;
      }
      // 通过：进入待执行队列
      prepared.push({ call, tool, args: args as Record<string, unknown> });
    }

    // 先打印所有"开始"（执行是并行的，统一呈现批次开始更清晰）
    for (const p of prepared) {
      if (p.tool) {
        renderer.onToolStart(p.call);
      }
    }

    // 并行执行所有已准备好的工具（错误项直接回填，不参与执行）
    const executed = await Promise.all(
      prepared.map(async (p) => {
        // 校验失败项：不执行，直接给错误结果
        if (!p.tool || !p.args) {
          return { call: p.call, result: { ok: false, text: p.errorText ?? "内部错误", durationMs: 0 } };
        }
        // 真正执行（工具内部自行处理授权确认；确认经 PolicyGate 串行队列）
        const t0 = Date.now();
        let result: ToolResult;
        try {
          result = await p.tool.execute(p.args, ctx);
        } catch (e) {
          // 工具抛出未捕获异常（common.timed 已兜底，这里是双保险）
          const msg = e instanceof Error ? e.message : String(e);
          result = { ok: false, text: `工具内部异常：${msg}`, durationMs: Date.now() - t0 };
        }
        // 渲染结果卡片
        renderer.onToolResult(p.call, result);
        return { call: p.call, result };
      })
    );

    // 回填 tool 消息（顺序与模型调用顺序一致，保证协议正确）
    for (const { call, result } of executed) {
      // 工具结果一律作为观察值回填：成功=文本，失败=错误描述（模型据此自纠，PDF 纠正层）
      const toolMsg: ChatMessage = { role: "tool", content: result.text, tool_call_id: call.id };
      messages.push(toolMsg);
      record("tool", toolMsg, { tool: call.function.name, ok: result.ok, duration_ms: result.durationMs });
    }

    // 清零失败计数：本批有成功的工具，其连续失败计数归零
    const succeeded = new Set(executed.filter((x) => x.result.ok).map((x) => x.call.function.name));
    for (const name of succeeded) {
      failStreak.set(name, 0);
    }

    // ── 熔断检查 1：连续失败 ──
    for (const { call, result } of executed) {
      // 只统计真实执行过的（校验失败项不算工具失败）
      if (result.ok) {
        continue;
      }
      // 错误文本里含"权限策略拒绝"的，不算工具故障（用户拒绝是正常分支）
      if (result.text.includes("权限策略拒绝") || result.text.includes("未知工具") || result.text.includes("参数校验失败") || result.text.includes("不是合法 JSON")) {
        // 这些属于"模型输出问题/用户决定"，不计入工具故障熔断
        continue;
      }
      // 累加该工具连续失败
      const name = call.function.name;
      const streak = (failStreak.get(name) ?? 0) + 1;
      failStreak.set(name, streak);
      // 达到阈值：熔断
      if (streak >= FAILURE_BREAKER) {
        // 留痕 + 报告
        meta("breaker-failure", { tool: name, streak, round });
        renderer.onMeta(`⛔ 工具 ${name} 连续失败 ${streak} 次，触发熔断终止（避免无意义重试）。`);
        return finishReport("breaker-failure", `工具 ${name} 连续失败 ${streak} 次`, round, totalPrompt, totalCompletion, totalCached);
      }
    }

    // ── 熔断检查 2：重复指纹（同一 tool+参数连续 N 轮） ──
    // 指纹取"本轮工具批的集合签名"：所有调用的 name+args 排序拼接
    const fingerprint = executed
      .map((x) => `${x.call.function.name}::${hashString(x.call.function.arguments)}`)
      .sort()
      .join("|");
    // 与上一轮指纹比较：相同则计数+1，不同则重置为 1
    if (lastFingerprint !== null && lastFingerprint === fingerprint) {
      repeatCount++;
    } else {
      repeatCount = 1;
    }
    lastFingerprint = fingerprint;
    // 达到阈值：熔断（模型在原地打转）
    if (repeatCount >= REPEAT_BREAKER) {
      meta("breaker-repeat", { fingerprint, streak: repeatCount, round });
      renderer.onMeta(`⛔ 检测到同一工具调用连续重复 ${repeatCount} 轮（疑似死循环），触发熔断终止。`);
      return finishReport("breaker-repeat", `同一工具调用重复 ${repeatCount} 轮`, round, totalPrompt, totalCompletion, totalCached);
    }
  }
}

/** 组装结束报告（统一出口） */
function finishReport(
  status: AgentReport["status"],
  reason: string | undefined,
  rounds: number,
  prompt: number,
  completion: number,
  cached: number
): AgentReport {
  // 直接构造（AgentReport 是纯数据，无额外逻辑）
  return { status, reason, rounds, totalPromptTokens: prompt, totalCompletionTokens: completion, totalCachedTokens: cached };
}

/**
 * 轻量字符串哈希（重复指纹用）。
 * 不需要加密强度，只需稳定区分不同参数串（djb2 足够）。
 */
function hashString(s: string): string {
  // djb2 算法：h = h*33 + c，取无符号
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // 逐字符累加（>>> 0 保持无符号）
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
