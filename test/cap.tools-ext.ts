// tools-ext 进程内扩展工具 —— 契约测试（契约先行）。
// 契约要点：
//   - defineExtTool(spec)：注册期校验（坏 spec 立即失败，稳定错误码，不给运行期惊喜）
//   - 运行期：参数先校验（坏参 → ok=false 且执行器零调用）、异常 → 结构化回执、
//     非规范返回 → 诊断、输出受 toolOutLimit 预算（与内置工具同一纪律）
//   - extendTools：扩展工具不得遮蔽内置（名字冲突注册期拒绝，大小写不敏感）
//   - loadExtTools：动态 import 本地模块（default 数组 / 命名 tools），任何失败 → 稳定错误码
//   - 集成：模型调用扩展工具 → 与内置同一 findTool 同源路径执行（①号契约的扩展）
// 显式非目标：不做 MCP/stdio、不引入网络、工具间无共享状态。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { BUILTIN_TOOLS } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/registry.ts";
import { PolicyGate } from "../src/policy.ts";
import type { ToolContext } from "../src/policy.ts";
import type { ChatMessage, ToolResult } from "../src/types.ts";
import { runAgent, type Renderer } from "../src/loop.ts";
import type { Config } from "../src/config.ts";
import {
  defineExtTool,
  extendTools,
  loadExtTools,
  ExtToolError,
} from "../src/capabilities/tools-ext.ts";

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "tmp");

function makeWs(name: string): string {
  const ws = path.join(TMP, name);
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function makeCtx(ws: string, toolOutLimit = 8192): ToolContext {
  return { workspace: ws, policy: new PolicyGate(ws), toolOutLimit };
}

/** 捕获 ExtToolError 的 code（没有则返回 null） */
function catchExtCode(fn: () => void): string | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExtToolError) return e.code;
    throw e;
  }
  return null;
}

// ─────────────────────── defineExtTool：注册期契约 ───────────────────────

test("tools-ext：defineExtTool 合法 spec → 生成 Tool（名字/描述/schema 保真）", async (t) => {
  const tool = defineExtTool({
    name: "echo_ext",
    description: "回显文本（测试用）",
    params: {
      type: "object",
      properties: { msg: { type: "string", description: "要回显的文本" } },
      required: ["msg"],
    },
    execute: async (args) => ({ ok: true, text: `echo:${String(args.msg)}` }),
  });
  t.eq(tool.name, "echo_ext");
  t.assert(tool.description.includes("回显"));
  t.eq(tool.parameters.required, ["msg"]);
  // 执行通路：参数透传、结果保真
  const ws = makeWs("ext-ws-1");
  const r = await tool.execute({ msg: "hi" }, makeCtx(ws));
  t.assert(r.ok);
  t.assert((r.text ?? "").includes("hi"));
});

test("tools-ext：defineExtTool 坏 spec → ExtToolError（稳定码，注册期失败）", async (t) => {
  // 坏名字（大写开头）
  t.eq(
    catchExtCode(() =>
      defineExtTool({
        name: "BadName",
        description: "x",
        params: { type: "object", properties: {} },
        execute: async () => ({ ok: true, text: "x" }),
      }),
    ),
    "EXT_INVALID_SPEC",
    "坏名字应注册期拒绝",
  );
  // 缺 execute
  t.eq(
    catchExtCode(() =>
      defineExtTool({
        name: "ok_name",
        description: "x",
        params: { type: "object", properties: {} },
      } as never),
    ),
    "EXT_INVALID_SPEC",
    "缺 execute 应注册期拒绝",
  );
  // 空描述
  t.eq(
    catchExtCode(() =>
      defineExtTool({
        name: "ok_name",
        description: "",
        params: { type: "object", properties: {} },
        execute: async () => ({ ok: true, text: "x" }),
      }),
    ),
    "EXT_INVALID_SPEC",
    "空描述应注册期拒绝",
  );
});

// ─────────────────────── extendTools：组合期契约 ───────────────────────

test("tools-ext：extendTools 无冲突 → [...base, ...ext] 且不改 base", async (t) => {
  const base = BUILTIN_TOOLS;
  const before = base.length;
  const ext = defineExtTool({
    name: "ext_alpha",
    description: "x",
    params: { type: "object", properties: {} },
    execute: async () => ({ ok: true, text: "x" }),
  });
  const merged = extendTools(base, [ext]);
  t.eq(merged.length, before + 1);
  t.eq(base.length, before, "base 数组不得被修改");
  t.assert(merged[merged.length - 1] === ext);
});

test("tools-ext：extendTools 与内置重名 → 注册期拒绝（不静默遮蔽）", async (t) => {
  const ext = defineExtTool({
    name: "read", // 与内置 read 重名
    description: "x",
    params: { type: "object", properties: {} },
    execute: async () => ({ ok: true, text: "x" }),
  });
  const code = catchExtCode(() => extendTools(BUILTIN_TOOLS, [ext]));
  t.eq(code, "EXT_NAME_COLLISION", "遮蔽内置工具必须注册期失败");
});

test("tools-ext：extendTools ext 内部重名 → 注册期拒绝", async (t) => {
  const mk = (name: string) =>
    defineExtTool({
      name,
      description: "x",
      params: { type: "object", properties: {} },
      execute: async () => ({ ok: true, text: "x" }),
    });
  const code = catchExtCode(() => extendTools(BUILTIN_TOOLS, [mk("ext_dup"), mk("ext_dup")]));
  t.eq(code, "EXT_NAME_COLLISION");
});

// ─────────────────────── 运行期契约 ───────────────────────

test("tools-ext：缺必填参数 → ok=false 且执行器零调用", async (t) => {
  let calls = 0;
  const tool = defineExtTool({
    name: "needs_arg",
    description: "x",
    params: {
      type: "object",
      properties: { p: { type: "string" } },
      required: ["p"],
    },
    execute: async (args) => {
      calls++;
      return { ok: true, text: String(args.p) };
    },
  });
  const ws = makeWs("ext-ws-2");
  const r = await tool.execute({}, makeCtx(ws));
  t.assert(!r.ok, "缺参必须失败");
  t.eq(calls, 0, "校验失败时执行器绝不被调用");
  t.assert((r.text ?? "").includes("p"), "错误信息应点出缺失参数名");
});

test("tools-ext：参数类型错误 → ok=false（执行器零调用）", async (t) => {
  let calls = 0;
  const tool = defineExtTool({
    name: "typed_arg",
    description: "x",
    params: {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    },
    execute: async () => {
      calls++;
      return { ok: true, text: "x" };
    },
  });
  const ws = makeWs("ext-ws-3");
  const r = await tool.execute({ n: "不是数字" }, makeCtx(ws));
  t.assert(!r.ok);
  t.eq(calls, 0);
});

test("tools-ext：执行器抛异常 → ok=false 结构化回执（不炸循环）", async (t) => {
  const tool = defineExtTool({
    name: "booms",
    description: "x",
    params: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("模拟内部故障");
    },
  });
  const ws = makeWs("ext-ws-4");
  const r = await tool.execute({}, makeCtx(ws));
  t.assert(!r.ok);
  t.assert((r.text ?? "").includes("模拟内部故障"), "异常信息应进回执文本");
});

test("tools-ext：执行器返回非规范结果 → ok=false 诊断（不静默当成功）", async (t) => {
  // 返回裸字符串（缺 ok/text 结构）
  const tool = defineExtTool({
    name: "sloppy",
    description: "x",
    params: { type: "object", properties: {} },
    execute: (async () => "裸字符串" as never) as never,
  });
  const ws = makeWs("ext-ws-5");
  const r = await tool.execute({}, makeCtx(ws));
  t.assert(!r.ok, "非规范返回必须按失败处理");
  t.assert((r.text ?? "").length > 0);
});

test("tools-ext：输出超 toolOutLimit → 按预算截断（与内置同一纪律）", async (t) => {
  const long = "A".repeat(200);
  const tool = defineExtTool({
    name: "chatty",
    description: "x",
    params: { type: "object", properties: {} },
    execute: async () => ({ ok: true, text: long }),
  });
  const ws = makeWs("ext-ws-6");
  const r = await tool.execute({}, makeCtx(ws, 60));
  t.assert(r.ok);
  t.assert((r.text ?? "").length < long.length, "超预算输出必须被截断");
  t.assert((r.text ?? "").includes("中间省略"), "截断标记应存在");
});

// ─────────────────────── loadExtTools：模块加载契约 ───────────────────────

test("tools-ext：loadExtTools 模块导出 default 数组 → 全部可用", async (t) => {
  const dir = makeWs("ext-mod-1");
  const file = path.join(dir, "tools-default.mjs");
  fs.writeFileSync(
    file,
    `export default [
      {
        name: "mod_alpha",
        description: "模块工具 A",
        params: { type: "object", properties: { m: { type: "string" } }, required: ["m"] },
        async execute(args) { return { ok: true, text: "A:" + String(args.m) }; },
      },
      {
        name: "mod_beta",
        description: "模块工具 B",
        params: { type: "object", properties: {} },
        async execute() { return { ok: true, text: "B" }; },
      },
    ];
`,
    "utf8",
  );
  const tools = await loadExtTools(file, dir);
  t.eq(tools.length, 2);
  const ws = makeWs("ext-ws-7");
  const a = await tools[0].execute({ m: "x" }, makeCtx(ws));
  t.assert((a.text ?? "").includes("A:x"));
});

test("tools-ext：loadExtTools 模块导出命名 tools → 加载成功", async (t) => {
  const dir = makeWs("ext-mod-2");
  const file = path.join(dir, "tools-named.mjs");
  fs.writeFileSync(
    file,
    `export const tools = [
      {
        name: "mod_gamma",
        description: "命名导出工具",
        params: { type: "object", properties: {} },
        async execute() { return { ok: true, text: "G" }; },
      },
    ];
`,
    "utf8",
  );
  const tools = await loadExtTools(file, dir);
  t.eq(tools.length, 1);
  t.eq(tools[0].name, "mod_gamma");
});

test("tools-ext：loadExtTools 模块导出形态非法 → EXT_MODULE_SHAPE", async (t) => {
  const dir = makeWs("ext-mod-3");
  const file = path.join(dir, "tools-bad-shape.mjs");
  fs.writeFileSync(file, `export const foo = 42;\n`, "utf8");
  let code: string | null = null;
  try {
    await loadExtTools(file, dir);
  } catch (e) {
    if (e instanceof ExtToolError) code = e.code;
    else throw e;
  }
  t.eq(code, "EXT_MODULE_SHAPE");
});

test("tools-ext：loadExtTools 文件不存在 → EXT_MODULE_LOAD（结构化诊断）", async (t) => {
  const dir = makeWs("ext-mod-4");
  let code: string | null = null;
  try {
    await loadExtTools(path.join(dir, "no-such-file.mjs"), dir);
  } catch (e) {
    if (e instanceof ExtToolError) code = e.code;
    else throw e;
  }
  t.eq(code, "EXT_MODULE_LOAD");
});

test("tools-ext：loadExtTools 模块内含坏 spec → 快速失败，不允许部分注册", async (t) => {
  const dir = makeWs("ext-mod-5");
  const file = path.join(dir, "tools-mixed.mjs");
  fs.writeFileSync(
    file,
    `export default [
      {
        name: "mod_good",
        description: "好的",
        params: { type: "object", properties: {} },
        async execute() { return { ok: true, text: "good" }; },
      },
      {
        name: "BadName",
        description: "坏名字",
        params: { type: "object", properties: {} },
        async execute() { return { ok: true, text: "bad" }; },
      },
    ];
`,
    "utf8",
  );
  let code: string | null = null;
  try {
    await loadExtTools(file, dir);
  } catch (e) {
    if (e instanceof ExtToolError) code = e.code;
    else throw e;
  }
  t.eq(code, "EXT_INVALID_SPEC", "一个坏 spec 必须拖垮整个模块加载（fail fast）");
});

// ─────────────────────── 集成：loop 同源执行 ───────────────────────

function noopRenderer(): Renderer {
  const f = () => {};
  return {
    onRound: f,
    onDelta: f,
    onReasoning: f,
    onToolStart: f,
    onToolResult: f,
    onUsage: f,
    onMeta: f,
    onRoundEnd: f,
  };
}

test("tools-ext 集成：模型调用扩展工具 → 同源解析并执行（findTool 契约覆盖扩展）", async (t) => {
  // 假模型（请求计数路由，与 loop.test.ts 同一模式）：第一请求调用 ext_echo，之后收尾
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      if (requests === 1) {
        res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_ext", function: { name: "ext_echo", arguments: '{"msg":"from-ext"}' } }] }, finish_reason: "tool_calls" }] }));
      } else {
        res.write(frame({ choices: [{ delta: { content: "done" } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }
      res.write(frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const ws = makeWs("ext-ws-int");
    const extEcho = defineExtTool({
      name: "ext_echo",
      description: "回显文本（测试用）",
      params: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: async (args) => ({ ok: true, text: `ext-echo:${String(args.msg)}` }),
    });
    const tools = extendTools(BUILTIN_TOOLS, [extEcho]);

    const recorded: ChatMessage[] = [];
    const ctx: ToolContext = { workspace: ws, policy: new PolicyGate(ws), toolOutLimit: 1000 };
    const cfg: Config = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "k",
      model: "fake",
      maxRounds: 5,
      maxTokens: 100,
      temperature: 0,
      ctxBudget: 100_000,
      toolOutLimit: 1000,
      workspace: ws,
      sessionsDir: path.join(ws, "sessions"),
      verbose: false,
    };
    const report = await runAgent({
      task: "用 ext_echo 回显 from-ext",
      cfg,
      tools,
      ctx,
      record: (role, msg) => recorded.push(msg),
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: "test-system",
      gitBranch: "",
    });
    t.eq(report.status, "done");
    const toolMsgs = recorded.filter((m) => m.role === "tool");
    t.eq(toolMsgs.length, 1, "扩展工具应被执行并回填一次");
    t.assert((toolMsgs[0]?.content ?? "").includes("ext-echo:from-ext"), "扩展工具结果应回填轨迹");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
