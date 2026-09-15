// delegate 子代理的契约测试（契约先行：实现前先锁行为）。
// 契约要点（Archify 式：小契约 + 结构化回执 + 显式非目标）：
//   输入  : { task: string（必填，自包含）, maxRounds?: 1-10 }
//   执行  : 独立子会话（独立文件）+ 受限工具集（内置六件，无 delegate → 不可嵌套）+ 有界轮次（默认 5）
//   成功  : ToolResult.ok=true，text=结构化回执（status/rounds + 子代理结论摘要）
//   失败  : ToolResult.ok=false，回执含子代理 status+原因（非零退出绝不描述为成功）
//   非目标: 并行、嵌套、继承父轨迹、继承父自定义工具
// 假模型路由：按 system 消息是否含 CHILD_MARKER 区分父/子请求。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { runAgent, type Renderer } from "../src/loop.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { BUILTIN_TOOLS, type Tool, type ToolResult } from "../src/tools/registry.ts";
import { PolicyGate, type ToolContext } from "../src/policy.ts";
import type { Config } from "../src/config.ts";
import type { ChatMessage } from "../src/types.ts";
import { Session } from "../src/session.ts";
import { delegateTool, CHILD_MARKER } from "../src/capabilities/delegate.ts";

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");

function fakeCfg(workspace: string): Config {
  return {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test",
    model: "test-model",
    maxRounds: 8,
    maxTokens: 100,
    temperature: 0,
    ctxBudget: 100_000,
    toolOutLimit: 100,
    workspace,
    sessionsDir: path.join(workspace, "sessions"),
    verbose: false,
  };
}

function noopRenderer(): Renderer {
  const f = () => {};
  return { onRound: f, onDelta: f, onReasoning: f, onToolStart: f, onToolResult: f, onUsage: f, onMeta: f, onRoundEnd: f };
}

/**
 * 假模型：
 *  - 子请求（system 含 CHILD_MARKER）：childMode=done → 直接给结论；childMode=repeat → 永远重复同一 read 调用
 *  - 父请求：第一请求 → delegate 工具调用（args 由测试指定）；之后 → 收尾
 */
function startFakeModel(delegateArgs: string, childMode: "done" | "repeat", readPath: string): Promise<{ port: number; close: () => Promise<void> }> {
  let parentRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.on("data", (c: unknown) => (body += String(c)));
    req.on("end", () => {
      let parsed: { messages?: { content?: unknown }[] } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* 解析失败按父请求处理 */
      }
      const system = String(parsed.messages?.[0]?.content ?? "");
      const isChild = system.includes(CHILD_MARKER);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      if (isChild) {
        if (childMode === "done") {
          res.write(frame({ choices: [{ delta: { content: "child-conclusion: 2+2=4" } }] }));
          res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        } else {
          // 永远重复同一成功调用（read 存在的文件）→ 触发 breaker-repeat 而非 breaker-failure
          res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_c", function: { name: "read", arguments: JSON.stringify({ path: readPath }) } }] }, finish_reason: "tool_calls" }] }));
        }
      } else {
        parentRequests++;
        if (parentRequests === 1) {
          res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_p", function: { name: "delegate", arguments: delegateArgs } }] }, finish_reason: "tool_calls" }] }));
        } else {
          res.write(frame({ choices: [{ delta: { content: "parent done" } }] }));
          res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        }
      }
      res.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
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

test("delegate：工具定义契约（名字/必填 task/maxRounds 可选）", (t) => {
  const tool = delegateTool(fakeCfg("D:\\ws"));
  t.eq(tool.name, "delegate", "工具名应为 delegate");
  t.assert(tool.parameters.required.includes("task"), "task 必填");
  t.assert(tool.parameters.properties.task, "应声明 task 参数");
  t.assert(tool.parameters.properties.maxRounds, "应声明可选 maxRounds");
});

test("delegate：空 task → ok=false 且不发起子循环", async (t) => {
  const tool = delegateTool(fakeCfg("D:\\ws"));
  const ctx: ToolContext = { workspace: "D:\\ws", policy: new PolicyGate("D:\\ws"), toolOutLimit: 100 };
  const r = await tool.execute({ task: "   " }, ctx);
  t.assert(!r.ok, "空 task 必须失败");
  t.assert(r.text.includes("task"), "错误信息应指出 task 为空");
});

test("delegate：成功路径（子代理结论回传 + 独立子会话落盘 + 父循环收尾）", async (t) => {
  const ws = path.join(TMP, "deleg-ws-ok");
  fs.mkdirSync(ws, { recursive: true });
  fs.rmSync(path.join(ws, "sessions"), { recursive: true, force: true });
  const server = await startFakeModel('{"task":"compute 2+2"}', "done", "x");
  try {
    // 包装 delegate：捕获回执（工具与父循环共用同一 cfg → 子代理打到 fake server）
    const cfg = { ...fakeCfg(ws), baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const base = delegateTool(cfg);
    const captured: ToolResult[] = [];
    const delegate: Tool = { ...base, execute: async (a, c) => (async () => { const r = await base.execute(a, c); captured.push(r); return r; })() };

    const recorded: ChatMessage[] = [];
    const report = await runAgent({
      task: "用 delegate 算 2+2",
      cfg,
      tools: [...BUILTIN_TOOLS, delegate],
      ctx: { workspace: ws, policy: new PolicyGate(ws), toolOutLimit: 100 },
      record: (role, msg) => recorded.push(msg),
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: buildSystemPrompt(cfg),
      gitBranch: "",
    });

    t.eq(report.status, "done", "父循环应正常收尾");
    t.eq(report.rounds, 2, "父：第一请求=delegate 调用，第二请求=收尾");
    t.eq(captured.length, 1, "delegate 应恰好执行一次");
    t.assert(captured[0].ok, `成功路径回执必须 ok=true：${captured[0].text}`);
    t.assert(captured[0].text.includes("child-conclusion: 2+2=4"), "子代理结论应回传到回执");
    t.assert(captured[0].text.includes("status=done"), "回执应含子代理状态");
    // 父轨迹：工具观察值含子结论
    const toolMsgs = recorded.filter((m) => m.role === "tool");
    t.assert(toolMsgs.some((m) => (m.content ?? "").includes("child-conclusion: 2+2=4")), "父轨迹应落盘子代理结论");
    // 独立子会话：sessions 目录恰好一个文件，且可回放
    const files = fs.readdirSync(path.join(ws, "sessions")).filter((f) => f.endsWith(".jsonl"));
    t.eq(files.length, 1, "子代理应有且仅有一个独立会话文件");
    const replay = Session.replay(path.join(ws, "sessions", files[0]));
    t.assert(replay.some((m) => m.role === "user" && (m.content ?? "").includes("compute 2+2")), "子会话应含子任务描述");
    t.assert(replay.some((m) => m.role === "assistant" && (m.content ?? "").includes("child-conclusion: 2+2=4")), "子会话应含子代理结论");
  } finally {
    await server.close();
  }
});

test("delegate：子代理重复同一调用 → 熔断回执（ok=false + status=breaker-repeat）", async (t) => {
  const ws = path.join(TMP, "deleg-ws-repeat");
  fs.mkdirSync(ws, { recursive: true });
  fs.rmSync(path.join(ws, "sessions"), { recursive: true, force: true });
  fs.writeFileSync(path.join(ws, "x"), "hello-x\n", "utf8"); // 让重复 read 成功（隔离出 repeat 熔断）
  const server = await startFakeModel('{"task":"重复读 x"}', "repeat", "x");
  try {
    const cfg = { ...fakeCfg(ws), baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const base = delegateTool(cfg);
    const captured: ToolResult[] = [];
    const delegate: Tool = { ...base, execute: async (a, c) => (async () => { const r = await base.execute(a, c); captured.push(r); return r; })() };

    const report = await runAgent({
      task: "t",
      cfg,
      tools: [...BUILTIN_TOOLS, delegate],
      ctx: { workspace: ws, policy: new PolicyGate(ws), toolOutLimit: 100 },
      record: () => {},
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: buildSystemPrompt(cfg),
      gitBranch: "",
    });

    t.eq(report.status, "done", "父循环不受子熔断影响，仍应收尾");
    t.eq(captured.length, 1);
    t.assert(!captured[0].ok, "子代理未完成任务 → 回执必须 ok=false（非零退出绝不描述为成功）");
    t.assert(captured[0].text.includes("status=breaker-repeat"), `回执应标明子状态 breaker-repeat：${captured[0].text}`);
    t.assert(captured[0].text.includes("rounds=3"), "子代理应在 3 轮（重复阈值）熔断");
  } finally {
    await server.close();
  }
});

test("delegate：maxRounds 参数生效（子代理 2 轮即止 → status=max-rounds）", async (t) => {
  const ws = path.join(TMP, "deleg-ws-maxr");
  fs.mkdirSync(ws, { recursive: true });
  fs.rmSync(path.join(ws, "sessions"), { recursive: true, force: true });
  fs.writeFileSync(path.join(ws, "x"), "hello-x\n", "utf8");
  const server = await startFakeModel('{"task":"t","maxRounds":2}', "repeat", "x");
  try {
    const cfg = { ...fakeCfg(ws), baseUrl: `http://127.0.0.1:${server.port}/v1` };
    const base = delegateTool(cfg);
    const captured: ToolResult[] = [];
    const delegate: Tool = { ...base, execute: async (a, c) => (async () => { const r = await base.execute(a, c); captured.push(r); return r; })() };

    await runAgent({
      task: "t",
      cfg,
      tools: [...BUILTIN_TOOLS, delegate],
      ctx: { workspace: ws, policy: new PolicyGate(ws), toolOutLimit: 100 },
      record: () => {},
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: buildSystemPrompt(cfg),
      gitBranch: "",
    });

    t.eq(captured.length, 1);
    t.assert(!captured[0].ok, "子代理未完成任务 → ok=false");
    t.assert(captured[0].text.includes("status=max-rounds"), `回执应标明 max-rounds：${captured[0].text}`);
    t.assert(captured[0].text.includes("rounds=2"), "子代理应在 2 轮（指定上限）终止");
  } finally {
    await server.close();
  }
});
