// goal 续跑的契约测试（契约先行：实现前先锁行为）。
// 契约要点：
//   - 每轮独立会话文件；max-rounds（时间用尽）→ 继承轨迹自动续跑；
//   - error（环境/模型异常）→ 硬停，不浪费重试（结构化失败诊断纪律）；
//   - GoalReport = 逐轮回执（index/status/rounds/sessionFile）+ done 标志 + 生效上限；
//   - 总轮次上限默认 3，clamp 到 1-10（有界默认，不无限烧额度）。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import type { Config } from "../src/config.ts";
import { PolicyGate, type ToolContext } from "../src/policy.ts";
import { Session } from "../src/session.ts";
import { runGoal, GOAL_DEFAULT_MAX_ROUNDS } from "../src/capabilities/goal.ts";

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");

function fakeCfg(workspace: string, port: number): Config {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    model: "test-model",
    maxRounds: 2, // 每轮内部轮次上限=2：两轮工具调用即触发 max-rounds（便于测试续跑）
    maxTokens: 100,
    temperature: 0,
    ctxBudget: 100_000,
    toolOutLimit: 100,
    workspace,
    sessionsDir: path.join(workspace, "sessions"),
    verbose: false,
  };
}

type Mode = "done" | "read-then-done" | "always-read" | "http-500";

/** 假模型（按请求序号脚本化）：
 *  done          每请求 → 纯正文收尾
 *  read-then-done 前 2 请求 → 同一成功 read 调用（凑满 max-rounds）；之后 → 收尾
 *  always-read   每请求 → 同一成功 read 调用（每轮都 max-rounds）
 *  http-500      每请求 → HTTP 500（模型调用失败 → error 硬停分支）
 */
function startFakeModel(mode: Mode, readPath: string): Promise<{ port: number; close: () => Promise<void> }> {
  let reqCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.on("data", (c: unknown) => (body += String(c)));
    req.on("end", () => {
      reqCount++;
      if (mode === "http-500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "forced 500" } }));
        return;
      }
      const shouldRead = mode === "always-read" || (mode === "read-then-done" && reqCount <= 2);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      if (shouldRead) {
        res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_g", function: { name: "read", arguments: JSON.stringify({ path: readPath }) } }] }, finish_reason: "tool_calls" }] }));
      } else {
        res.write(frame({ choices: [{ delta: { content: "goal-round-done" } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
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

function makeWs(name: string): string {
  const ws = path.join(TMP, name);
  fs.mkdirSync(ws, { recursive: true });
  fs.rmSync(path.join(ws, "sessions"), { recursive: true, force: true });
  fs.writeFileSync(path.join(ws, "x"), "goal-test-file\n", "utf8");
  return ws;
}

function makeCtx(ws: string): ToolContext {
  return { workspace: ws, policy: new PolicyGate(ws), toolOutLimit: 100 };
}

test("goal：第 1 轮即 done → 单轮回执，done=true", async (t) => {
  const ws = makeWs("goal-ws-1");
  const server = await startFakeModel("done", "x");
  try {
    const g = await runGoal({
      objective: "一个立刻能完成的目标",
      cfg: fakeCfg(ws, server.port),
      ctx: makeCtx(ws),
    });
    t.assert(g.done, "第 1 轮 done → goal 应为完成");
    t.eq(g.rounds.length, 1, "不应启动续跑轮");
    t.eq(g.rounds[0].status, "done");
    t.eq(g.effectiveMaxRounds, GOAL_DEFAULT_MAX_ROUNDS, "未指定 maxRounds 时应为默认 3");
    // 会话落盘
    const files = fs.readdirSync(path.join(ws, "sessions")).filter((f) => f.endsWith(".jsonl"));
    t.eq(files.length, 1, "第 1 轮应有独立会话文件");
  } finally {
    await server.close();
  }
});

test("goal：第 1 轮 max-rounds → 自动续跑，第 2 轮继承轨迹并 done", async (t) => {
  const ws = makeWs("goal-ws-2");
  const server = await startFakeModel("read-then-done", "x");
  try {
    const g = await runGoal({
      objective: "读 x 文件并总结（需要两轮）",
      cfg: fakeCfg(ws, server.port),
      ctx: makeCtx(ws),
      maxRounds: 2,
    });
    t.assert(g.done, "第 2 轮 done → goal 完成");
    t.eq(g.rounds.length, 2, "应有两轮");
    t.eq(g.rounds[0].status, "max-rounds", "第 1 轮应触发 max-rounds");
    t.eq(g.rounds[0].rounds, 2, "第 1 轮应消耗 2 个模型轮（每轮上限）");
    t.eq(g.rounds[1].status, "done");
    t.eq(g.rounds[1].rounds, 1, "第 2 轮第 1 请求即收尾");
    // 每轮独立会话文件（append-only：第 2 轮文件只记本轮新增；完整故事=按序拼接各轮文件）
    t.assert(g.rounds[0].sessionFile !== g.rounds[1].sessionFile, "每轮会话文件必须独立");
    const files = fs.readdirSync(path.join(ws, "sessions")).filter((f) => f.endsWith(".jsonl"));
    t.eq(files.length, 2, "应有两个独立会话文件");
    const round1Replay = Session.replay(g.rounds[0].sessionFile);
    t.assert(round1Replay.some((m) => m.role === "user" && (m.content ?? "").includes("读 x 文件并总结")), "第 1 轮文件应含目标任务");
    t.assert(round1Replay.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0), "第 1 轮文件应含工具调用");
    const round2Replay = Session.replay(g.rounds[1].sessionFile);
    t.assert(round2Replay.some((m) => m.role === "user" && (m.content ?? "").includes("goal 续跑")), "第 2 轮文件应含续跑指令");
    t.assert(round2Replay.some((m) => m.role === "assistant" && (m.content ?? "").includes("goal-round-done")), "第 2 轮文件应含收尾正文");
  } finally {
    await server.close();
  }
});

test("goal：连续 max-rounds → 达到总轮次上限后停止，done=false（有界，不无限续）", async (t) => {
  const ws = makeWs("goal-ws-3");
  const server = await startFakeModel("always-read", "x");
  try {
    const g = await runGoal({
      objective: "永远读不完的目标",
      cfg: fakeCfg(ws, server.port),
      ctx: makeCtx(ws),
      maxRounds: 2,
    });
    t.assert(!g.done, "两轮都 max-rounds → goal 未完成");
    t.eq(g.rounds.length, 2, "总轮次上限 2 → 恰好两轮后停止（有界）");
    t.assert(g.rounds.every((r) => r.status === "max-rounds"), "每轮都应是 max-rounds");
  } finally {
    await server.close();
  }
});

test("goal：模型调用失败（error）→ 硬停，不启动续跑轮（结构化失败诊断）", async (t) => {
  const ws = makeWs("goal-ws-4");
  const server = await startFakeModel("http-500", "x");
  try {
    const g = await runGoal({
      objective: "目标",
      cfg: fakeCfg(ws, server.port),
      ctx: makeCtx(ws),
      maxRounds: 3,
    });
    t.assert(!g.done, "error → 未完成");
    t.eq(g.rounds.length, 1, "error 后不应浪费额度续跑");
    t.eq(g.rounds[0].status, "error");
    t.assert(g.rounds[0].reason, "error 回执应带原因");
  } finally {
    await server.close();
  }
});

test("goal：总轮次上限 clamp（99→10，0→1）", async (t) => {
  const ws = makeWs("goal-ws-5");
  const server = await startFakeModel("done", "x");
  try {
    const a = await runGoal({ objective: "t", cfg: fakeCfg(ws, server.port), ctx: makeCtx(ws), maxRounds: 99 });
    t.eq(a.effectiveMaxRounds, 10, "99 应被 clamp 到上限 10");
    const b = await runGoal({ objective: "t", cfg: fakeCfg(ws, server.port), ctx: makeCtx(ws), maxRounds: 0 });
    t.eq(b.effectiveMaxRounds, 1, "0 应被 clamp 到 1");
  } finally {
    await server.close();
  }
});
