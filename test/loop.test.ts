// loop.ts 的离线集成测试：用状态化假 SSE 服务器驱动真实的 runAgent 代码路径。
// 核心契约（findTool 修复验收）：模型看到的工具列表 = opts.tools，
// 执行期查找必须同源——自定义工具（非 BUILTIN_TOOLS）能被解析并执行；
// 不在列表里的名字回填"未知工具"而不是静默执行内置工具。
// 全程只访问 127.0.0.1 回环——与"本地/隐私"承诺一致。
import http from "node:http";
import { test } from "./harness.ts";
import { runAgent, type Renderer } from "../src/loop.ts";
import type { Config } from "../src/config.ts";
import type { ChatMessage, ToolResult } from "../src/types.ts";
import { PolicyGate, type ToolContext } from "../src/policy.ts";
import type { Tool } from "../src/tools/registry.ts";

/** 第一请求要返回的工具调用脚本（null=第一请求即纯正文结束） */
interface FirstCallScript {
  name: string;
  args: string;
}

/** 状态化假模型：第一请求返回脚本里的工具调用；之后返回纯正文 stop */
function startFakeModel(script: FirstCallScript | null): Promise<{ port: number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    if (requests === 1 && script) {
      // 第一请求：一次完整工具调用（不拆分，聚焦 loop 侧行为）
      res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_loop_1", function: { name: script.name, arguments: script.args } }] }, finish_reason: "tool_calls" }] }));
    } else {
      // 第二请求起：纯正文收尾
      res.write(frame({ choices: [{ delta: { content: "done" } }] }));
      res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    }
    res.write(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    res.write("data: [DONE]\n\n");
    res.end();
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

function cfg(port: number): Config {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "k",
    model: "fake",
    maxRounds: 5,
    maxTokens: 100,
    temperature: 0,
    ctxBudget: 100_000, // 高预算：不触发归档，聚焦工具解析路径
    toolOutLimit: 100,
    workspace: "D:\\ws",
    sessionsDir: "D:\\ws\\sessions",
    verbose: false,
  };
}

/** 无操作渲染器（测试只关心落盘与报告） */
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

test("loop：自定义工具（非内置）被解析并成功执行（findTool 同源契约）", async (t) => {
  const server = await startFakeModel({ name: "custom_echo", args: '{"msg":"hi"}' });
  try {
    // 自定义工具：不在 BUILTIN_TOOLS 里；记录执行入参
    const executedArgs: Record<string, unknown>[] = [];
    const customEcho: Tool = {
      name: "custom_echo",
      description: "测试用自定义工具",
      parameters: {
        type: "object",
        properties: { msg: { type: "string", description: "要回显的文本" } },
        required: ["msg"],
      },
      execute: async (args) => {
        executedArgs.push(args);
        const r: ToolResult = { ok: true, text: `echo:${String(args.msg)}`, durationMs: 1 };
        return r;
      },
    };

    const recorded: ChatMessage[] = [];
    const ctx: ToolContext = {
      workspace: "D:\\ws",
      policy: new PolicyGate("D:\\ws"),
      toolOutLimit: 100,
    };

    const report = await runAgent({
      task: "用 custom_echo 回显 hi",
      cfg: cfg(server.port),
      tools: [customEcho], // 关键：会话只暴露这一个自定义工具
      ctx,
      record: (role, msg) => recorded.push(msg),
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: "test-system",
      gitBranch: "",
    });

    t.eq(report.status, "done", "两请求后应自然结束（工具执行成功 → 模型收尾）");
    t.eq(report.rounds, 2, "第一请求=工具调用，第二请求=收尾");
    t.eq(executedArgs.length, 1, "自定义工具应恰好执行一次（修复前会被判'未知工具'而 0 次执行）");
    t.eq(executedArgs[0].msg, "hi", "参数应完整传递到执行器");
    // 落盘：user + assistant(tool_calls) + tool + assistant(收尾)
    const toolMsgs = recorded.filter((m) => m.role === "tool");
    t.eq(toolMsgs.length, 1, "应落盘一条工具观察值");
    t.assert((toolMsgs[0]?.content ?? "").includes("echo:hi"), "工具结果应回填进轨迹");
  } finally {
    await server.close();
  }
});

test("loop：调用不在会话列表里的工具 → 回填'未知工具'，且不得静默执行内置工具", async (t) => {
  const server = await startFakeModel({ name: "read", args: '{"path":"a.txt"}' });
  try {
    // 会话只暴露 custom_echo；模型却调用 read（内置里有，但本次会话未提供）
    const customEcho: Tool = {
      name: "custom_echo",
      description: "测试用自定义工具",
      parameters: { type: "object", properties: { msg: { type: "string" } } },
      execute: async () => ({ ok: true, text: "ok", durationMs: 0 }),
    };

    const recorded: ChatMessage[] = [];
    const ctx: ToolContext = {
      workspace: "D:\\ws",
      policy: new PolicyGate("D:\\ws"),
      toolOutLimit: 100,
      log: () => {},
    };
    // 用 read 工具本身做探针：若被静默执行会读真实文件（D:\ws\a.txt 不存在 → ok:false），
    // 但更直接的断言是"观察值文本"——未知工具回填必含"未知工具"
    const report = await runAgent({
      task: "t",
      cfg: cfg(server.port),
      tools: [customEcho],
      ctx,
      record: (role, msg) => recorded.push(msg),
      meta: () => {},
      inherited: [],
      renderer: noopRenderer(),
      system: "test-system",
      gitBranch: "",
    });

    t.eq(report.status, "done", "未知工具回填后模型应仍能收尾");
    const toolMsgs = recorded.filter((m) => m.role === "tool");
    t.eq(toolMsgs.length, 1);
    t.assert((toolMsgs[0]?.content ?? "").includes("未知工具"), "观察值应明确提示'未知工具'");
    t.assert((toolMsgs[0]?.content ?? "").includes("custom_echo"), "错误提示应列出本会话实际可用的工具");
  } finally {
    await server.close();
  }
});
