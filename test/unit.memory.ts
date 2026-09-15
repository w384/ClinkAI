// MEMORY.md 长期记忆的契约测试（契约先行：实现前先锁行为）。
// 契约要点（Archify 式：小契约 + 显式边界 + fail-safe）：
//   1. 工作区存在 MEMORY.md 且非空 → 注入到冻结前缀，带固定区块标题；
//   2. 不存在 / 空文件 / 纯空白 → 无该区块（不产生孤立标题，前缀不膨胀）；
//   3. AGENTS.md 与 MEMORY.md 同时存在 → 顺序稳定：AGENTS.md 在前；
//   4. 超过注入上限（8192 字符）→ 保留头部 + 明确截断标记（含总数与上限）；
//   5. 两次调用字节级一致（静态前缀纪律，KV cache 前提）；
//   6. 系统模板必须向模型说明 MEMORY.md 的用途约定（文档即契约）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { buildSystemPrompt, MEMORY_MD_CAP } from "../src/prompt.ts";
import type { Config } from "../src/config.ts";

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

const HEADER = "长期记忆（来自工作区 MEMORY.md）";

test("MEMORY：存在且非空 → 注入内容并带固定区块标题", (t) => {
  const ws = path.join(TMP, "mem-ws1");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "MEMORY.md"), "用户偏好：注释用中文；本地模型在 18080 端口\n", "utf8");
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(sys.includes("用户偏好：注释用中文"), "应包含 MEMORY.md 内容");
  t.assert(sys.includes(HEADER), "应带固定区块标题");
});

test("MEMORY：无 MEMORY.md → 无该区块（不回归，前缀不变）", (t) => {
  const ws = path.join(TMP, "mem-ws2");
  fs.mkdirSync(ws, { recursive: true });
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(!sys.includes(HEADER), "无 MEMORY.md 时不应出现该区块标题");
});

test("MEMORY：空文件/纯空白 → 视为不存在（不产生孤立标题）", (t) => {
  for (const [name, content] of [["empty", ""], ["blank", " \n\t \n"]] as const) {
    const ws = path.join(TMP, `mem-ws3-${name}`);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "MEMORY.md"), content, "utf8");
    const sys = buildSystemPrompt(fakeCfg(ws));
    t.assert(!sys.includes(HEADER), `${name}：空/空白 MEMORY.md 不应产生孤立标题`);
  }
});

test("MEMORY：与 AGENTS.md 并存 → 顺序稳定（AGENTS.md 在前）", (t) => {
  const ws = path.join(TMP, "mem-ws4");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "AGENTS-标记-内容\n", "utf8");
  fs.writeFileSync(path.join(ws, "MEMORY.md"), "MEMORY-标记-内容\n", "utf8");
  const sys = buildSystemPrompt(fakeCfg(ws));
  const iAgents = sys.indexOf("AGENTS-标记-内容");
  const iMemory = sys.indexOf("MEMORY-标记-内容");
  t.assert(iAgents >= 0 && iMemory >= 0, "两个区块都应存在");
  t.assert(iAgents < iMemory, "顺序应为 AGENTS.md 在前、MEMORY.md 在后（稳定顺序）");
});

test("MEMORY：超上限 → 保留头部并带截断标记（含总数与上限）", (t) => {
  const ws = path.join(TMP, "mem-ws5");
  fs.mkdirSync(ws, { recursive: true });
  const big = "A".repeat(MEMORY_MD_CAP + 100);
  fs.writeFileSync(path.join(ws, "MEMORY.md"), big, "utf8");
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(sys.includes(HEADER), "超限时仍应注入（头部保留）");
  t.assert(sys.includes(`总 ${MEMORY_MD_CAP + 100} 字`), `标记应含总字符数：${MEMORY_MD_CAP + 100}`);
  t.assert(sys.includes(String(MEMORY_MD_CAP)), "标记应含注入上限值");
  t.assert(sys.includes("A".repeat(1000)), "头部内容应保留");
});

test("MEMORY：上限值本身不触发截断（边界）", (t) => {
  const ws = path.join(TMP, "mem-ws6");
  fs.mkdirSync(ws, { recursive: true });
  const exact = "B".repeat(MEMORY_MD_CAP);
  fs.writeFileSync(path.join(ws, "MEMORY.md"), exact, "utf8");
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(!sys.includes("MEMORY.md 过长"), `恰好等于上限不应截断（总长 ${MEMORY_MD_CAP}）`);
});

test("MEMORY：两次调用字节级一致（静态前缀纪律）", (t) => {
  const ws = path.join(TMP, "mem-ws7");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "MEMORY.md"), "稳定记忆\n", "utf8");
  const a = buildSystemPrompt(fakeCfg(ws));
  const b = buildSystemPrompt(fakeCfg(ws));
  t.eq(a, b, "前缀必须字节级稳定");
});

test("MEMORY：系统模板向模型说明 MEMORY.md 用途约定（文档即契约）", (t) => {
  const ws = path.join(TMP, "mem-ws8");
  fs.mkdirSync(ws, { recursive: true });
  const sys = buildSystemPrompt(fakeCfg(ws));
  t.assert(sys.includes("MEMORY.md"), "系统模板应提及 MEMORY.md（让模型知道何时该读/更新它）");
});
