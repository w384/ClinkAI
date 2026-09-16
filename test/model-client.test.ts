// model-client.ts 的离线集成测试：用一个 127.0.0.1 假 SSE 服务器驱动真实的
// streamChat/listModels 代码路径（SSE 解析、工具调用聚合、usage、错误分类）。
// 全程只访问回环地址——与"本地/隐私"承诺一致。
import http from "node:http";
import { test } from "./harness.ts";
import { streamChat, listModels, ModelError, isContextOverflow } from "../src/model-client.ts";
import type { Config } from "../src/config.ts";

/** 服务器侧请求计数（用于确定性断言"HTTP 错误不重试"，避免基于耗时的脆弱断言） */
export const stats = { badKeyRequests: 0 };

/** 假模型服务器：按路由/鉴权返回固定响应 */
function startFakeServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      // 鉴权：非 "Bearer k" 一律 401（模拟无效密钥）。计数用于断言"HTTP 错误不重试"
      if (req.headers.authorization !== "Bearer k") {
        stats.badKeyRequests++;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      // SSE 流：正文增量 + 思考增量 + 畸形帧（容错） + 工具调用分片 + usage + [DONE]
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      res.write(frame({ choices: [{ delta: { content: "Hel" } }] }));
      res.write(frame({ choices: [{ delta: { reasoning_content: "思考中" } }] }));
      res.write("data: {this-is-not-valid-json\n\n"); // 畸形帧必须被跳过而不是崩溃
      res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pat' } }] } }] }));
      res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'h":"a.txt"}' } }] }, finish_reason: "tool_calls" }] }));
      res.write(frame({ choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 5 } }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("无法取得监听端口");
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function cfg(port: number, apiKey = "k"): Config {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    model: "fake",
    maxRounds: 5,
    maxTokens: 100,
    temperature: 0,
    ctxBudget: 1000,
    toolOutLimit: 100,
    workspace: "D:\\ws",
    sessionsDir: "D:\\ws\\sessions",
    verbose: false,
  };
}

/** 服务器生命周期：首个需要它的测试启动，run-tests 统一关闭 */
let serverPromise: Promise<{ port: number; close: () => Promise<void> }> | null = null;
function ensureServer() {
  serverPromise ??= startFakeServer();
  return serverPromise;
}
/** 供 run-tests 调用：关闭假服务器，释放端口 */
export async function closeServer(): Promise<void> {
  if (serverPromise) {
    const s = await serverPromise;
    await s.close();
    serverPromise = null;
  }
}

test("streamChat：SSE 聚合正文+思考+工具调用分片+usage（含畸形帧容错）", async (t) => {
  const s = await ensureServer();
  const r = await streamChat(cfg(s.port), [{ role: "user", content: "hi" }]);
  t.eq(r.content, "Hel", "正文增量应聚合");
  t.eq(r.reasoning, "思考中", "reasoning_content 应被收集");
  t.eq(r.toolCalls.length, 1, "工具调用应聚合为一条");
  t.eq(r.toolCalls[0].id, "call_1");
  t.eq(r.toolCalls[0].function.name, "read");
  t.eq(r.toolCalls[0].function.arguments, '{"path":"a.txt"}', "跨帧参数应拼接成合法 JSON");
  t.eq(r.finishReason, "tool_calls");
  t.assert(r.usage !== undefined, "stream_options.include_usage 应带出 usage");
  t.eq(r.usage?.promptTokens, 100);
  t.eq(r.usage?.cachedTokens, 80, "cached_tokens 应映射（前缀缓存可观测指标）");
  t.eq(r.usage?.completionTokens, 5);
});

test("streamChat：返回结构稳定（content/reasoning/toolCalls/finishReason/usage 字段齐备）", async (t) => {
  const s = await ensureServer();
  const r = await streamChat(cfg(s.port), [{ role: "user", content: "hi" }]);
  t.assert(typeof r.content === "string");
  t.assert(typeof r.reasoning === "string");
  t.assert(Array.isArray(r.toolCalls));
  t.assert(typeof r.finishReason === "string" && r.finishReason.length > 0);
});

test("streamChat：401 抛 ModelError(kind=http, status=401) 且不重试", async (t) => {
  const s = await ensureServer();
  const before = stats.badKeyRequests;
  await t.rejects(streamChat(cfg(s.port, "bad-key"), [{ role: "user", content: "hi" }]), "401");
  // 确定性断言：HTTP 错误不触发网络重试（服务器恰好收到 1 次请求）
  t.eq(stats.badKeyRequests, before + 1, "401 不应重试（服务器应恰好收到 1 次请求）");
});

test("streamChat：连接拒绝抛 ModelError(kind=network)，自动重试 1 次", async (t) => {
  // 找一个没有监听的端口：先监听再立刻关闭
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const addr = probe.address();
  await new Promise<void>((r) => probe.close(() => r()));
  if (typeof addr !== "object" || addr === null) throw new Error("无法取得探测端口");
  const start = Date.now();
  await t.rejects(streamChat(cfg(addr.port), [{ role: "user", content: "hi" }]), "无法连接");
  const elapsed = Date.now() - start;
  // 重试 1 次 = 中间有 1s 等待（验证重试路径确实发生）
  t.assert(elapsed >= 900, `应观察到约 1s 的重试间隔（实际 ${elapsed}ms）`);
});

test("listModels：解析 data[] 模型列表", async (t) => {
  const s = await ensureServer();
  const ids = await listModels(cfg(s.port));
  t.eq(ids, ["model-a", "model-b"]);
});

test("listModels：连接失败抛 ModelError", async (t) => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const addr = probe.address();
  await new Promise<void>((r) => probe.close(() => r()));
  if (typeof addr !== "object" || addr === null) throw new Error("无法取得探测端口");
  await t.rejects(listModels(cfg(addr.port)), "无法连接");
});

test("ModelError：kind/status 字段可区分错误分类", async (t) => {
  const s = await ensureServer();
  try {
    await streamChat(cfg(s.port, "bad-key"), [{ role: "user", content: "hi" }]);
    t.assert(false, "应当抛错");
  } catch (e) {
    t.assert(e instanceof ModelError, "应为 ModelError 实例");
    if (e instanceof ModelError) {
      t.eq(e.kind, "http");
      t.eq(e.status, 401);
    }
  }
});

// ── isContextOverflow：溢出判定的正/负样本（纯函数，无需假服务器） ──
// 三条件同时满足才判溢出：ModelError+http、状态码在溢出集合、信息含溢出关键词。
test("isContextOverflow：识别各类溢出/非溢出错误", async (t) => {
  // 正样本：HTTP 400 + "context length exceeded"（llama.cpp/OpenAI 常见措辞）
  t.eq(
    isContextOverflow(new ModelError("模型服务返回 HTTP 400：context length exceeded", "http", 400)),
    true,
    "400 + context 关键词应判为溢出"
  );
  t.eq(
    isContextOverflow(new ModelError("prompt is too long: exceeds context window", "http", 413)),
    true,
    "413 + length/window 关键词应判为溢出"
  );
  t.eq(
    isContextOverflow(new ModelError("模型服务返回 HTTP 500：上下文超限，请缩短输入", "http", 500)),
    true,
    "500 + 中文溢出关键词应判为溢出"
  );
  // 负样本：401 认证错误（状态码不在溢出集合）
  t.eq(isContextOverflow(new ModelError("模型服务拒绝访问（401）", "http", 401)), false, "401 不是溢出");
  // 负样本：网络错误（kind 不是 http）
  t.eq(isContextOverflow(new ModelError("无法连接模型服务", "network", 0)), false, "网络错误不是溢出");
  // 负样本：超时（kind 是 timeout）
  t.eq(isContextOverflow(new ModelError("单次调用超过 30 分钟上限", "timeout", 0)), false, "超时不是溢出");
  // 负样本：400 但无溢出关键词（参数错误等，避免误判触发压缩）
  t.eq(
    isContextOverflow(new ModelError("模型服务返回 HTTP 400：invalid parameter 'foo'", "http", 400)),
    false,
    "400 但无溢出关键词不判为溢出"
  );
  // 负样本：非 ModelError（普通 Error / null / undefined）
  t.eq(isContextOverflow(new Error("boom")), false, "非 ModelError 不是溢出");
  t.eq(isContextOverflow(null), false, "null 不是溢出");
  t.eq(isContextOverflow(undefined), false, "undefined 不是溢出");
});
