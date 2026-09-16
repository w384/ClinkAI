#!/usr/bin/env node
// ClinkAI Web 服务：零依赖（Node 内置 http），把同一个 agent 内核接到浏览器。
// 用法：
//   node web/server.ts                # 默认 http://127.0.0.1:18090
//   CLINKAI_WEB_PORT=9000 node web/server.ts
// 路由：
//   GET  /                     → web/index.html（单页应用）
//   GET  /api/health           → 健康检查 + 默认配置
//   GET  /api/sessions         → 会话列表（含任务预览）
//   GET  /api/sessions/<name>  → 单条会话的全部 JSONL 事件
//   POST /api/run              → 启动一次 agent 运行，SSE 流式回传循环事件
// 设计原则：与 CLI 共用同一套内核（loop/tools/policy/session），渲染器换成 SSE 发射器；
// Web 非 TTY → 权限确认自动拒绝（fail-safe 保持不变，白名单只读命令不受影响）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { Session } from "../src/session.ts";
import { PolicyGate } from "../src/policy.ts";
import { BUILTIN_TOOLS, type Tool } from "../src/tools/registry.ts";
import { delegateTool } from "../src/capabilities/delegate.ts";
import { loadExtTools, extendTools } from "../src/capabilities/tools-ext.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { WebRenderer } from "../src/renderer-web.ts";
import { runAgent } from "../src/loop.ts";
import type { AgentOptions } from "../src/loop.ts";

// ─────────────────────────────── 基础配置 ───────────────────────────────

/** 本文件所在目录（web/ 下，index.html 就在旁边） */
const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 监听端口：环境变量优先，默认 18090（避开模型服务 18080 与 DSH GUI 3080） */
const PORT = intEnv("CLINKAI_WEB_PORT", 18090);
/** 监听地址：默认仅本机（模型与数据都在本机，不对外暴露） */
const HOST = process.env.CLINKAI_WEB_HOST || "127.0.0.1";

// 正在运行中的会话（basename）：防止运行中被删除导致 append 重新建出孤儿文件
const activeSessions = new Set<string>();

/** 读取整数环境变量；非法值回退默认（与 config.ts 同纪律） */
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

// ─────────────────────────────── 响应工具 ───────────────────────────────

/** 输出 JSON（统一 UTF-8 + Content-Type） */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  // 序列化（事件都是纯数据，不会失败；失败也兜底成错误体）
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    text = JSON.stringify({ error: "响应序列化失败" });
  }
  // 状态码 + 头 + 正文
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

/** 读取请求体（限制 64KB：run 参数很小，超限一定是误用） */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // 累积块
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 65536) {
        reject(new Error("请求体过大（>64KB）"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 取工作区 git 分支（状态栏用）；取不到返回空串——与 CLI 版同逻辑 */
function getGitBranch(workspace: string): string {
  try {
    const out = execFileSync("git", ["branch", "--show-current"], { cwd: workspace, timeout: 3000, stdio: "pipe" }).toString("utf8").trim();
    // detached HEAD 显示 HEAD
    return out.length > 0 ? out : "HEAD";
  } catch {
    // 非 git 仓库：静默降级
    return "";
  }
}

// ─────────────────────────────── 会话查询 ───────────────────────────────

/** 会话列表项（前端侧栏渲染用） */
interface SessionInfo {
  file: string; // 文件名（basename，前端回传用它定位）
  mtimeMs: number; // 最后活动时间
  sizeBytes: number; // 文件大小
  task: string; // 任务预览（首个 user 事件，截断 80 字）
  messages: number; // user+assistant+tool 事件总数
}

/** 扫描会话目录生成列表（按最后活动时间倒序） */
function listSessions(dir: string): SessionInfo[] {
  // 目录不存在 → 空列表
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: SessionInfo[] = [];
  // 逐文件扫描（会话文件都是小文件，全量读没问题）
  for (const f of fs.readdirSync(dir)) {
    // 只要 jsonl
    if (!f.endsWith(".jsonl")) {
      continue;
    }
    const full = path.join(dir, f);
    let raw: string;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      // 读失败（被占用等）跳过，不影响其他会话
      continue;
    }
    // 解析事件：取任务预览 + 消息数
    let task = "";
    let messages = 0;
    for (const line of raw.split("\n")) {
      // 空行跳过
      if (line.trim().length === 0) {
        continue;
      }
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line);
      } catch {
        // 半行（写入时进程被杀）：append-only 的已知边界，跳过
        continue;
      }
      // 消息类事件计数
      if (evt.type === "user" || evt.type === "assistant" || evt.type === "tool") {
        messages++;
      }
      // 首个 user 事件作为任务预览
      if (task.length === 0 && evt.type === "user" && typeof evt.content === "string") {
        task = evt.content.trim().replace(/\s+/g, " ").slice(0, 80);
      }
    }
    // 没有 user 事件的会话（init 后立刻失败）用文件名当预览
    if (task.length === 0) {
      task = "(无任务)";
    }
    out.push({
      file: f,
      mtimeMs: fs.statSync(full).mtimeMs,
      sizeBytes: fs.statSync(full).size,
      task,
      messages,
    });
  }
  // 按活动时间倒序（新会话在上）
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // 最多返回 200 条（侧栏够用，避免目录巨大时刷屏）
  return out.slice(0, 200);
}

/** 读取单个会话的全部事件（basename 定位，防路径穿越） */
function readSession(dir: string, name: string): Record<string, unknown>[] | null {
  // basename：把 ".." 之类的东西直接消掉
  const base = path.basename(name);
  if (!base.endsWith(".jsonl")) {
    return null;
  }
  const full = path.join(dir, base);
  // 最终再校验一次：解析后必须仍落在会话目录内
  if (path.dirname(full) !== dir) {
    return null;
  }
  if (!fs.existsSync(full)) {
    return null;
  }
  const events: Record<string, unknown>[] = [];
  // 逐行解析；坏行跳过（append-only 容错）
  for (const line of fs.readFileSync(full, "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // 半行跳过
      continue;
    }
  }
  return events;
}

// ─────────────────────────────── 运行（SSE） ───────────────────────────────

/**
 * 处理一次 agent 运行：装配与 CLI main() 完全同构，
 * 只是渲染器换成 WebRenderer（SSE 发射）、确认在非 TTY 下自动拒绝。
 */
async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // ── 解析参数 ──
  let task = "";
  let workspace: string | undefined;
  let resume: string | undefined;
  let maxRounds: number | undefined;
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    // 各字段按类型取值（非法类型一律视为未提供）
    if (typeof body.task === "string") {
      task = body.task;
    }
    if (typeof body.workspace === "string" && body.workspace.trim().length > 0) {
      workspace = body.workspace.trim();
    }
    if (typeof body.resume === "string" && body.resume.trim().length > 0) {
      resume = body.resume.trim();
    }
    if (typeof body.maxRounds === "number" && Number.isFinite(body.maxRounds) && body.maxRounds > 0) {
      maxRounds = Math.floor(body.maxRounds);
    }
  } catch (e) {
    sendJson(res, 400, { error: `参数解析失败：${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  // 无任务且无 resume → 拒绝（与 CLI 纪律一致）
  if (task.trim().length === 0 && !resume) {
    sendJson(res, 400, { error: "缺少任务文本（或 resume 会话）。" });
    return;
  }

  // ── 装配（与 bin/clinkai.ts 的 main() 同构） ──
  const cfg: Config = loadConfig({ workspace, maxRounds });
  // resume 文件解析：basename 或完整路径
  let resumeFile: string | undefined;
  if (resume) {
    // basename 形式（前端侧栏点选）：拼到会话目录
    if (!path.isAbsolute(resume) && !resume.includes(path.sep) && !resume.includes("/")) {
      resumeFile = path.join(cfg.sessionsDir, resume);
    } else {
      resumeFile = path.resolve(resume);
    }
    // 文件必须存在（给可行动错误）
    if (!fs.existsSync(resumeFile)) {
      sendJson(res, 400, { error: `resume 会话不存在：${resumeFile}` });
      return;
    }
  }
  // 会话（新文件，或沿用 resume 文件继续追加）
  const session = new Session(cfg.sessionsDir, resumeFile);
  // 登记为运行中（删除路由据此拒绝；finally 里注销）
  activeSessions.add(path.basename(session.file));
  // 权限闸门（Web 非 TTY → confirm 自动拒绝，白名单只读命令不受影响）
  // 三档安全：与 CLI 同档（cfg.securityMode 来自 CLINKAI_SECURITY_MODE，默认 workspace-write）
  const policy = new PolicyGate(cfg.workspace, cfg.securityMode);
  // 工具上下文
  const ctx = {
    workspace: cfg.workspace,
    policy,
    toolOutLimit: cfg.toolOutLimit,
    log: (evt: Record<string, unknown>) => session.append(evt),
  };
  // 继承历史
  const inherited = resumeFile ? Session.replay(resumeFile) : [];
  // 冻结系统提示词
  const system = buildSystemPrompt(cfg);
  // 工具集：内置六件套 +（显式启用时）delegate + 扩展工具——与 CLI 同逻辑
  let tools: Tool[] =
    process.env.CLINKAI_DELEGATE === "1" ? [...BUILTIN_TOOLS, delegateTool(cfg)] : BUILTIN_TOOLS;
  const extPath = process.env.CLINKAI_TOOLS_EXT;
  if (extPath) {
    const ext = await loadExtTools(extPath, cfg.workspace);
    tools = extendTools(tools, ext);
  }
  // git 分支（状态栏）
  const gitBranch = getGitBranch(cfg.workspace);
  // 任务文本：resume + 无任务 → 默认继续指令
  const finalTask = task.trim().length > 0 ? task.trim() : "请继续上次未完成的对话。";

  // ── SSE 通道 ──
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // 发射一个事件（统一 data: 前缀 + 双换行分隔）
  const sink = (evt: Record<string, unknown>): void => {
    // 客户端断开后不再写（写会抛 EPIPE，捕获即可）
    if (res.writableEnded) {
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      // 连接已断：静默（前端会看到流中断）
    }
  };
  const renderer = new WebRenderer(sink);

  // 首事件：运行上下文（前端显示工作区/模型/继承条数 + Web 模式提示）
  sink({
    t: "start",
    sessionFile: path.basename(session.file),
    workspace: cfg.workspace,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    inherited: inherited.length,
    maxRounds: cfg.maxRounds,
    webMode: true,
  });

  // ── 跑 agent 循环 ──
  const opts: AgentOptions = {
    task: finalTask,
    cfg,
    tools,
    ctx,
    record: (role, msg, extra) => session.recordMessage(role, msg, extra),
    meta: (note, extra) => session.append({ type: "meta", note, ...(extra ?? {}) }),
    inherited,
    renderer,
    system,
    gitBranch,
  };

  // 运行；无论成败都发终事件
  let report: Awaited<ReturnType<typeof runAgent>>;
  try {
    report = await runAgent(opts);
  } catch (e) {
    // 循环外异常（理论不该发生）：发 error 事件后结束
    sink({ t: "error", message: e instanceof Error ? e.message : String(e) });
    res.end();
    return;
  } finally {
    // 无论成败，注销运行中登记（允许删除）
    activeSessions.delete(path.basename(session.file));
  }
  // 终事件：状态报告（前端显示"■ 完成/熔断… N 轮 · 用量"）
  sink({
    t: "done",
    status: report.status,
    reason: report.reason,
    rounds: report.rounds,
    promptTokens: report.totalPromptTokens,
    completionTokens: report.totalCompletionTokens,
    cachedTokens: report.totalCachedTokens,
    sessionFile: path.basename(session.file),
  });
  res.end();
}

// ─────────────────────────────── HTTP 服务器 ───────────────────────────────

/** 创建服务器（路由分发） */
function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    // 方法 + 路径
    const method = req.method ?? "GET";
    // 去掉 query 的裸路径
    const urlPath = (req.url ?? "/").split("?")[0];

    try {
      // ── 静态页 ──
      if (method === "GET" && urlPath === "/") {
        // 每次请求读盘（开发期改 index.html 不用重启）
        const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ── 健康检查 ──
      if (method === "GET" && urlPath === "/api/health") {
        const cfg = loadConfig();
        sendJson(res, 200, {
          ok: true,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          workspace: cfg.workspace,
          sessionsDir: cfg.sessionsDir,
          maxRounds: cfg.maxRounds,
          ctxBudget: cfg.ctxBudget,
        });
        return;
      }

      // ── 会话列表 ──
      if (method === "GET" && urlPath === "/api/sessions") {
        const cfg = loadConfig();
        sendJson(res, 200, {
          sessions: listSessions(cfg.sessionsDir),
          sessionsDir: cfg.sessionsDir,
          defaultWorkspace: cfg.workspace,
        });
        return;
      }

      // ── 单会话事件 ──
      if (method === "GET" && urlPath.startsWith("/api/sessions/")) {
        const name = decodeURIComponent(urlPath.slice("/api/sessions/".length));
        const cfg = loadConfig();
        const events = readSession(cfg.sessionsDir, name);
        // 不存在 → 404
        if (events === null) {
          sendJson(res, 404, { error: `会话不存在：${name}` });
          return;
        }
        sendJson(res, 200, { file: path.basename(name), events });
        return;
      }

      // ── 删除会话 ──
      if (method === "DELETE" && urlPath.startsWith("/api/sessions/")) {
        const name = decodeURIComponent(urlPath.slice("/api/sessions/".length));
        const base = path.basename(name);
        // 只允许删 .jsonl（杜绝删目录里其他东西）
        if (!base.endsWith(".jsonl")) {
          sendJson(res, 400, { error: "只能删除 .jsonl 会话文件" });
          return;
        }
        const cfg = loadConfig();
        const full = path.join(cfg.sessionsDir, base);
        // 再校验目录（防穿越）
        if (path.dirname(full) !== cfg.sessionsDir) {
          sendJson(res, 400, { error: "非法路径" });
          return;
        }
        if (!fs.existsSync(full)) {
          sendJson(res, 404, { error: `会话不存在：${base}` });
          return;
        }
        // 运行中的会话拒绝删除（删了 append 会重建孤儿文件）
        if (activeSessions.has(base)) {
          sendJson(res, 409, { error: "该会话正在运行，请等它结束后再删除" });
          return;
        }
        // 删除（不可恢复——前端已有二次确认）
        fs.unlinkSync(full);
        sendJson(res, 200, { ok: true, deleted: base });
        return;
      }

      // ── 运行（SSE） ──
      if (method === "POST" && urlPath === "/api/run") {
        await handleRun(req, res);
        return;
      }

      // ── 其余一律 404 ──
      sendJson(res, 404, { error: `未定义的路由：${method} ${urlPath}` });
    } catch (e) {
      // 兜底：500 + 可行动信息
      if (!res.headersSent) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      } else if (!res.writableEnded) {
        // SSE 已开：只能发一个 error 事件再关
        try {
          res.write(`data: ${JSON.stringify({ t: "error", message: e instanceof Error ? e.message : String(e) })}\n\n`);
          res.end();
        } catch {
          // 连接已断
        }
      }
    }
  });
}

// ─────────────────────────────── 启动 ───────────────────────────────

const server = createServer();
// 监听；端口占用给明确提示
server.on("error", (e: NodeJS.ErrnoException) => {
  // EADDRINUSE：端口被占
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。换一个：CLINKAI_WEB_PORT=9000 node web/server.ts`);
  } else {
    console.error(`服务器错误：${e.message}`);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  // 启动横幅（可复制的 URL + 配置摘要）
  const cfg = loadConfig();
  console.log(`ClinkAI web · http://${HOST}:${PORT}`);
  console.log(`  模型    ${cfg.model} @ ${cfg.baseUrl}`);
  console.log(`  工作区  ${cfg.workspace}（可在页面里改）`);
  console.log(`  会话    ${cfg.sessionsDir}`);
  console.log(`  提示    Web 模式非 TTY：非白名单 bash / 工作区外路径自动拒绝（fail-safe）`);
});
