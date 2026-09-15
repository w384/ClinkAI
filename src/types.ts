// 共享类型定义：OpenAI 兼容协议消息、工具调用、模型返回等
// 说明：Node 原生 TS 类型剥离只支持"可直接擦除"的类型，
//       因此本项目不使用 enum / namespace / 构造器参数属性。

/** 一条对话消息（OpenAI chat completions 协议子集） */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** 文本内容；assistant 带工具调用时可为空字符串 */
  content: string;
  /** assistant 消息上携带的工具调用列表 */
  tool_calls?: ToolCall[];
  /** tool 消息必填：对应哪个工具调用 */
  tool_call_id?: string;
}

/** 模型生成的一次工具调用 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串（模型可能输出畸形 JSON，需容错解析） */
    arguments: string;
  };
}

/** 一次模型调用的用量统计（llama.cpp 在流式末尾返回） */
export interface Usage {
  promptTokens: number;
  /** 命中 KV Cache 的 prompt token 数（前缀冻结是否生效的可观测指标） */
  cachedTokens: number;
  completionTokens: number;
}

/** 一次流式模型调用的完整结果 */
export interface ModelResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: Usage;
  /** 本轮模型生成的思考内容（qwen3.8 恒开） */
  reasoning: string;
}

/** 工具执行结果：一律返回文本，错误也作为观察值回填给模型 */
export interface ToolResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

/** agent 一轮循环内的状态快照（用于状态栏渲染） */
export interface LoopState {
  round: number;
  maxRounds: number;
  estTokens: number;
  ctxBudget: number;
  workspace: string;
  gitBranch: string;
}

/** agent 运行结束报告 */
export interface AgentReport {
  status: "done" | "max-rounds" | "breaker-repeat" | "breaker-failure" | "error";
  reason?: string;
  rounds: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
}
