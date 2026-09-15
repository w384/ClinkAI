// 模型客户端：OpenAI 兼容 /chat/completions 的 SSE 流式调用 + tool calling。
// 设计要点（规划 D2）：只认 OpenAI 兼容接口，未来换 vLLM/云模型零改动。
// 错误策略：网络错误重试 1 次；HTTP 错误不重试（401/400 重试无意义）；
//           超时分两段——首字节 90s（本地服务挂掉要快速失败）、整体 10 分钟（42 tok/s 下 4096 token 约 100s）。
import type { Config } from "./config.ts";
import type { ChatMessage, ModelResult, ToolCall, Usage } from "./types.ts";

/** 模型调用过程中的流式回调（CLI 渲染器实现） */
export interface StreamHandlers {
  /** 正文增量 */
  onDelta(text: string): void;
  /** 思考内容增量（qwen3.8 恒开，llama.cpp 用 reasoning_content 字段承载） */
  onReasoning(text: string): void;
}

/** 模型客户端抛出的结构化错误，CLI 可据此给出针对性提示 */
export class ModelError extends Error {
  /** HTTP 状态码；网络级错误为 0 */
  status: number;
  /** 错误分类：连接 / 超时 / HTTP / 协议 */
  kind: "network" | "timeout" | "http" | "protocol";
  constructor(message: string, kind: "network" | "timeout" | "http" | "protocol", status: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** 单次调用的运行参数 */
export interface CallOptions {
  handlers?: StreamHandlers;
  /** 工具定义（OpenAI tools 数组）；空数组=纯对话 */
  tools?: unknown[];
}

/**
 * 流式调用一次模型。
 * 成功返回完整消息（正文 + 工具调用 + 用量）；失败抛 ModelError。
 * 网络级错误自动重试 1 次（规划 §7：llama.cpp 服务重启的低成本兜底）。
 */
export async function streamChat(
  cfg: Config,
  messages: ChatMessage[],
  opts: CallOptions = {}
): Promise<ModelResult> {
  // 网络错误重试 1 次；其余错误直接抛出
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await doStreamCall(cfg, messages, opts);
    } catch (e) {
      lastError = e;
      // 仅网络级错误且还有重试机会才继续；HTTP/协议错误重试没有意义
      if (!(e instanceof ModelError) || e.kind !== "network" || attempt >= 2) {
        throw e;
      }
      // 等待 1s 再试（本地服务可能刚重启）
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // 理论上不可达：循环内要么 return 要么 throw
  throw lastError instanceof Error ? lastError : new ModelError(String(lastError), "network", 0);
}

/** 真正发起一次流式请求（内部函数，供重试循环调用） */
async function doStreamCall(
  cfg: Config,
  messages: ChatMessage[],
  opts: CallOptions
): Promise<ModelResult> {
  // ── 超时控制：首字节 90s，整体 600s ──
  const ac = new AbortController();
  // 首字节定时器：90 秒没收到任何数据就判定服务无响应
  const firstByteTimer = setTimeout(() => {
    // 超时原因写进异常消息，便于 CLI 提示"检查 18080 服务"
    ac.abort(new ModelError("90 秒内未收到模型服务响应（首字节超时）", "timeout", 0));
  }, 90_000);
  // 整体定时器：流式开始后继续兜底，防止半死不活的连接
  const overallTimer = setTimeout(() => {
    ac.abort(new ModelError("单次调用超过 10 分钟上限", "timeout", 0));
  }, 600_000);

  let resp: globalThis.Response;
  try {
    // 组装请求体：stream 必须为 true，llama.cpp 才返回 SSE
    resp = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 本机约定密钥；401 时提示用户检查 key
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        stream: true,
        // 流式模式下 usage 默认不下发，必须显式开启（llama.cpp/OpenAI 均遵守）
        stream_options: { include_usage: true },
      }),
      signal: ac.signal,
    });
  } catch (e) {
    // fetch 阶段失败：连接被拒 / DNS / 首字节超时（abort 抛出）
    clearTimeout(firstByteTimer);
    clearTimeout(overallTimer);
    // abort 抛出的是 ModelError（超时），原样上抛
    if (e instanceof ModelError) {
      throw e;
    }
    // 其余都按网络错误处理（连接拒绝、服务未启动等）
    const msg = e instanceof Error ? e.message : String(e);
    throw new ModelError(`无法连接模型服务 ${cfg.baseUrl}：${msg}`, "network", 0);
  }
  clearTimeout(firstByteTimer);

  // ── HTTP 错误处理：读取响应体里的 error 字段（llama.cpp 格式）──
  if (!resp.ok) {
    clearTimeout(overallTimer);
    // 尽力解析错误体，解析不了就带上状态码
    let detail = "";
    try {
      const body = await resp.text();
      // llama.cpp 错误体：{"error":{"code":500,"message":"...","type":"..."}}
      const j = JSON.parse(body) as { error?: { message?: string } };
      if (j?.error?.message) {
        detail = `：${j.error.message}`;
      } else {
        detail = `：${body.slice(0, 300)}`;
      }
    } catch {
      // 错误体不是 JSON（可能是 HTML 网关页），忽略细节
      detail = "";
    }
    // 401 单独给提示：本机常见原因是 key 没配
    if (resp.status === 401) {
      throw new ModelError("模型服务拒绝访问（401）：请检查 CLINKAI_API_KEY 是否正确", "http", 401);
    }
    throw new ModelError(`模型服务返回 HTTP ${resp.status}${detail}`, "http", resp.status);
  }

  // ── SSE 流解析 ──
  // 结果累加器：正文 / 思考 / 工具调用（按 index 聚合增量）
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: Usage | undefined;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  // 处理一行 data 负载（SSE 协议：以 "data:" 开头的行）
  const handleData = (payload: string): boolean => {
    // "[DONE]" 是 OpenAI 约定的结束标记（llama.cpp 也遵循）
    if (payload === "[DONE]") {
      return true;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      // 个别损坏帧：跳过而不是中断整个流（协议级容错）
      return false;
    }
    // llama.cpp 流式块：choices[0].delta 携带增量
    const choice = chunk?.choices?.[0];
    if (!choice) {
      // 有些实现把 usage 单独放在非 choice 块里
      if (chunk?.usage) {
        usage = mapUsage(chunk.usage);
      }
      return false;
    }
    // 结束原因：llama.cpp 用 "stop" / "length"（length=被 max_tokens 截断）
    if (choice.finish_reason) {
      finishReason = String(choice.finish_reason);
    }
    const delta = choice.delta ?? {};
    // 正文增量
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      opts.handlers?.onDelta(delta.content);
    }
    // 思考增量：qwen 系列经 llama.cpp 从 reasoning_content 流出
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      reasoning += delta.reasoning_content;
      opts.handlers?.onReasoning(delta.reasoning_content);
    }
    // 工具调用增量：每个调用按 index 分片到达（id/name/arguments 都是增量拼接）
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        // 取已有累加器或新建
        const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) {
          acc.id = tc.id;
        }
        if (tc.function?.name) {
          acc.name += tc.function.name;
        }
        if (typeof tc.function?.arguments === "string") {
          // arguments 是流式 JSON 字符串，必须拼接完整后再解析
          acc.args += tc.function.arguments;
        }
        toolAcc.set(idx, acc);
      }
    }
    // 部分实现把 usage 放在最后一个 choice 块里
    if (chunk?.usage) {
      usage = mapUsage(chunk.usage);
    }
    return false;
  };

  try {
    const reader = resp.body?.getReader();
    // 极端情况下没有 body（某些代理实现），退回一次性读取
    if (!reader) {
      const body = await resp.text();
      // 非流式返回：直接按完整响应解析
      const j = JSON.parse(body) as any;
      const msg = j?.choices?.[0]?.message;
      content = msg?.content ?? "";
      reasoning = msg?.reasoning_content ?? "";
      finishReason = j?.choices?.[0]?.finish_reason ?? "stop";
      if (j?.usage) {
        usage = mapUsage(j.usage);
      }
      if (Array.isArray(msg?.tool_calls)) {
        msg.tool_calls.forEach((tc: any, i: number) => {
          toolAcc.set(i, {
            id: tc.id ?? `call_${i}`,
            name: tc.function?.name ?? "",
            args: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
          });
        });
      }
    } else {
      // 逐块读取 SSE 流；TextDecoder 处理跨块的多字节 UTF-8 边界
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      // 循环直到流结束（done=true）
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        // 新块拼入缓冲区后按行切分（SSE 以换行分帧）
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        // 逐行处理，最后一行（可能不完整）留在 buffer 里等下一块
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          // 只关心 data: 行；空行/注释行（":") 忽略
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload.length === 0) {
            continue;
          }
          // handleData 返回 true 表示 [DONE]
          if (handleData(payload)) {
            // 结束标记出现后主动结束读取（不等流自然关闭）
            break;
          }
        }
        // 内层 break 只跳出 while；这里检查 content 无法区分 DONE，
        // 但 [DONE] 后服务端会立刻关流，下一次 read 即 done，无副作用
      }
    }
  } catch (e) {
    // 流读取中途失败（连接被掐）：带上下文抛出
    clearTimeout(overallTimer);
    if (e instanceof ModelError) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new ModelError(`模型响应流中断：${msg}`, "network", 0);
  }
  clearTimeout(overallTimer);

  // ── 组装最终结果 ──
  // 工具调用按 index 升序输出，保持模型给出的原始顺序
  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${v.name}`,
      type: "function" as const,
      function: { name: v.name, arguments: v.args },
    }));

  return { content, toolCalls, finishReason, usage, reasoning };
}

/** 把不同实现的 usage 字段映射到统一结构（llama.cpp: prompt_tokens_details.cached_tokens） */
function mapUsage(u: any): Usage {
  // 字段缺失时给 0，避免渲染层到处判空
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0),
    // llama.cpp 的缓存命中字段在 details 里；其他实现可能没有
    cachedTokens: Number(u?.prompt_tokens_details?.cached_tokens ?? 0),
    completionTokens: Number(u?.completion_tokens ?? 0),
  };
}

/** 自检：列出服务端模型（--doctor 用），顺带验证 key 有效 */
export async function listModels(cfg: Config): Promise<string[]> {
  // 6 秒短超时：自检命令不应长时间挂起
  const resp = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(6000),
  }).catch((e) => {
    // 连接失败统一包装成 ModelError，让 CLI 的提示逻辑一致
    throw new ModelError(`无法连接模型服务：${e instanceof Error ? e.message : String(e)}`, "network", 0);
  });
  if (!resp.ok) {
    // 401 说明 key 无效（本机实测：无 key 返回 401）
    throw new ModelError(`模型服务返回 HTTP ${resp.status}（401=密钥无效）`, "http", resp.status);
  }
  const j = (await resp.json()) as { data?: { id: string }[]; models?: { id?: string }[] };
  // llama.cpp 同时返回 data[] 和 models[]，优先 data
  if (Array.isArray(j.data)) {
    return j.data.map((m) => m.id);
  }
  if (Array.isArray(j.models)) {
    return j.models.map((m) => m.id ?? "").filter((s) => s.length > 0);
  }
  return [];
}
