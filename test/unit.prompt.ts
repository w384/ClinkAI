// prompt.ts 的离线单测：静态前缀组装、占位符替换、AGENTS.md 注入、状态栏。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { buildSystemPrompt, buildStatusLine } from "../src/prompt.ts";
import type { Config } from "../src/config.ts";
import type { LoopState } from "../src/types.ts";

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");

function fakeCfg(workspace: string): Config {
  return {
    baseUrl: "http://127.0.0.1:18080/v1",
    apiKey: "test",
    model: "test-model",
    maxRounds: 5,
    maxTokens: 100,
    temperature: 0,
    ctxBudget: 1000,
    toolOutLimit: 100,
    workspace,
    sessionsDir: path.join(workspace, "sessions"),
    verbose: false,
  };
}

test("buildStatusLine：包含轮次、上下文占用与预算百分比", (t) => {
  const st: LoopState = { round: 2, maxRounds: 5, estTokens: 500, ctxBudget: 1000, workspace: "D:\\ws", gitBranch: "main" };
  const line = buildStatusLine(st);
  t.assert(line.includes("2/5"), `应含轮次 2/5：${line}`);
  t.assert(line.includes("500"), `应含估算 token 数：${line}`);
  t.assert(line.includes("50%"), `应含 50% 占比：${line}`);
  t.assert(line.includes("main"), `应含 git 分支：${line}`);
});

test("buildStatusLine：预算为 0 时不产生 NaN", (t) => {
  const st: LoopState = { round: 1, maxRounds: 5, estTokens: 100, ctxBudget: 0, workspace: "D:\\ws", gitBranch: "" };
  const line = buildStatusLine(st);
  t.assert(!line.includes("NaN"), `不应出现 NaN：${line}`);
});

test("buildSystemPrompt：{{workspace}} 占位符被替换", (t) => {
  const ws = path.join(TMP, "prompt-ws1");
  fs.mkdirSync(ws, { recursive: true });
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(!sys.includes("{{workspace}}"), "占位符应被替换掉");
  t.assert(sys.includes(ws), `应包含工作区路径：${ws}`);
});

test("buildSystemPrompt：注入工作区 AGENTS.md 内容", (t) => {
  const ws = path.join(TMP, "prompt-ws2");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "项目规则：注释用中文；提交前跑测试\n", "utf8");
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(sys.includes("注释用中文"), "应包含 AGENTS.md 内容");
  t.assert(sys.includes("项目指令"), "应带 AGENTS.md 区块标题");
});

test("buildSystemPrompt：无 AGENTS.md 时正常组装（不注入该区块）", (t) => {
  const ws = path.join(TMP, "prompt-ws3");
  fs.mkdirSync(ws, { recursive: true });
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(sys.length > 50, "前缀应非空");
  t.assert(!sys.includes("项目指令（来自工作区 AGENTS.md）"), "无 AGENTS.md 时不应有该区块");
});

test("buildSystemPrompt：同一 cfg 两次调用字节级一致（静态前缀纪律）", (t) => {
  const ws = path.join(TMP, "prompt-ws4");
  fs.mkdirSync(ws, { recursive: true });
  const a = buildSystemPrompt(fakeCfg(ws));
  const b = buildSystemPrompt(fakeCfg(ws));
  t.eq(a, b, "前缀必须字节级稳定（KV cache 命中的前提）");
});
