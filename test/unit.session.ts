// session.ts 的离线单测：append-only JSONL、回放、坏行容错、latestIn。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { Session } from "../src/session.ts";

// 测试用临时目录（工作区内，避免触碰平台临时区；runner 结束后统一清理）
const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");

test("Session：新会话创建文件并写 init 事件", (t) => {
  const s = new Session(path.join(TMP, "s1"));
  t.assert(fs.existsSync(s.file), "会话文件应存在");
  const lines = fs.readFileSync(s.file, "utf8").trim().split("\n");
  t.assert(lines.length >= 1, "至少有一个事件行");
  const first = JSON.parse(lines[0]) as { type: string };
  t.eq(first.type, "init", "首行应为 init 事件");
});

test("Session：recordMessage 落盘并带 ts", (t) => {
  const s = new Session(path.join(TMP, "s2"));
  s.recordMessage("user", { role: "user", content: "你好" });
  const lines = fs.readFileSync(s.file, "utf8").trim().split("\n");
  const evt = JSON.parse(lines[lines.length - 1]) as { type: string; ts: number; content: string };
  t.eq(evt.type, "user");
  t.eq(evt.content, "你好");
  t.assert(typeof evt.ts === "number" && evt.ts > 0, "ts 应为正数");
});

test("Session：replay 还原 user/assistant/tool（tool_call_id 原样保留）", (t) => {
  const s = new Session(path.join(TMP, "s3"));
  s.recordMessage("user", { role: "user", content: "做个事" });
  s.recordMessage("assistant", {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
  });
  s.recordMessage("tool", { role: "tool", content: "文件内容", tool_call_id: "c1" });
  s.append({ type: "meta", note: "应被跳过" });
  s.append({ type: "error", note: "应被跳过" });

  const msgs = Session.replay(s.file);
  t.eq(msgs.length, 3, "只回放消息类事件（user/assistant/tool）");
  t.eq(msgs[0].role, "user");
  t.eq(msgs[0].content, "做个事");
  t.eq(msgs[1].role, "assistant");
  t.assert(Array.isArray(msgs[1].tool_calls) && msgs[1].tool_calls?.length === 1, "assistant 的 tool_calls 应还原");
  t.eq(msgs[2].role, "tool");
  t.eq(msgs[2].tool_call_id, "c1", "tool_call_id 是回填关联键，必须原样还原");
});

test("Session：replay 对坏行容错（完整坏行跳过，其余历史保留）", (t) => {
  const s = new Session(path.join(TMP, "s4"));
  s.recordMessage("user", { role: "user", content: "好行" });
  // 一行完整但非法的 JSON（带行尾换行）
  fs.appendFileSync(s.file, '{"type":"user","conten"corrupted"\n', "utf8");
  s.recordMessage("user", { role: "user", content: "也好行" });
  const msgs = Session.replay(s.file);
  t.eq(msgs.length, 2, "坏行跳过，其余历史保留");
  t.eq(msgs[0].content, "好行");
  t.eq(msgs[1].content, "也好行");
});

test("Session：replay 对半行（写入时进程被杀）不崩溃", (t) => {
  const s = new Session(path.join(TMP, "s4b"));
  s.recordMessage("user", { role: "user", content: "幸存行" });
  // 模拟进程被杀留下的半行 JSON（无行尾换行）——真实边界：它会与下一次追加粘连
  fs.appendFileSync(s.file, '{"type":"user","conten', "utf8");
  s.recordMessage("user", { role: "user", content: "被粘连的行（丢失可接受）" });
  // 契约：回放不崩溃；至少第一条完好历史保留
  const msgs = Session.replay(s.file);
  t.assert(msgs.length >= 1, "回放不应崩溃");
  t.eq(msgs[0].content, "幸存行");
});

test("Session.replay：文件不存在时抛出明确错误", (t) => {
  t.throws(() => Session.replay(path.join(TMP, "no-such-session.jsonl")), "不存在");
});

test("Session.latestIn：返回目录内最新会话文件", (t) => {
  const dir = path.join(TMP, "s5");
  const s1 = new Session(dir);
  // 间隔 5ms 确保 mtime 有差异（Windows mtime 分辨率约 10ms，用 20ms 保险）
  const start = Date.now();
  while (Date.now() - start < 20) {
    /* 忙等一小段 */
  }
  const s2 = new Session(dir);
  const latest = Session.latestIn(dir);
  t.assert(latest !== null, "应有最新会话");
  t.assert(latest === s1.file || latest === s2.file, "最新文件应是两个会话之一");
  t.assert(latest === s2.file, "后创建的应是最新");
});

test("Session.latestIn：空目录/不存在目录返回 null", (t) => {
  const empty = path.join(TMP, "s6-empty");
  fs.mkdirSync(empty, { recursive: true });
  t.eq(Session.latestIn(empty), null);
  t.eq(Session.latestIn(path.join(TMP, "s6-missing")), null);
});

test("Session：resume 模式沿用旧文件继续追加", (t) => {
  const dir = path.join(TMP, "s7");
  const s1 = new Session(dir);
  s1.recordMessage("user", { role: "user", content: "第一段" });
  // 用同一文件 resume
  const s2 = new Session(dir, s1.file);
  t.eq(s2.file, s1.file, "resume 应沿用同一文件");
  s2.recordMessage("user", { role: "user", content: "第二段" });
  const msgs = Session.replay(s1.file);
  t.eq(msgs.length, 2, "两段历史都应在同一文件中");
});
