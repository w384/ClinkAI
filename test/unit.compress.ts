// compress.ts 的离线单测：截断、token 估算（纯函数，无需模型/网络）。
import { test } from "./harness.ts";
import { truncateMiddle, estimateTokens, estimateMessagesTokens, findSafeArchiveBoundary } from "../src/compress.ts";

test("truncateMiddle：未超阈值原样返回", (t) => {
  const r = truncateMiddle("hello world", 100);
  t.eq(r.text, "hello world");
  t.eq(r.truncated, false);
});

test("truncateMiddle：超阈值保留头尾并带省略标记", (t) => {
  const text = "A".repeat(500) + "MIDDLE" + "B".repeat(500);
  const r = truncateMiddle(text, 200);
  t.assert(r.truncated, "应标记为截断");
  t.assert(r.text.startsWith("AAAA"), "头部应保留");
  t.assert(r.text.endsWith("BBBB"), "尾部应保留");
  t.assert(r.text.includes("中间省略"), "应含省略标记");
  t.assert(r.text.includes("806"), `标记中应含被省略字符数（1006-200=806）：${r.text.slice(90, 200)}`);
  t.assert(r.text.length < text.length, "截断后应变短");
});

test("truncateMiddle：恰好等于阈值不截断", (t) => {
  const text = "x".repeat(50);
  const r = truncateMiddle(text, 50);
  t.eq(r.truncated, false);
  t.eq(r.text, text);
});

test("estimateTokens：CJK 约 1 token/字，ASCII 约 4 字符/token", (t) => {
  t.eq(estimateTokens("中文"), 2, "两个 CJK 字符 = 2 token");
  t.eq(estimateTokens("a".repeat(40)), 10, "40 个 ASCII = 10 token");
  // 混合：2 CJK + 40 ASCII = 2 + 10 = 12
  t.eq(estimateTokens("中文" + "a".repeat(40)), 12);
  // 空串 = 0
  t.eq(estimateTokens(""), 0);
});

test("estimateMessagesTokens：计入 tool_calls 的参数", (t) => {
  const plain = estimateMessagesTokens([{ role: "user", content: "中文" }]);
  const withTools = estimateMessagesTokens([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "x", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
    },
  ]);
  t.assert(withTools > plain, "带工具调用的估算应大于纯文本");
  // assistant 空正文 + name("read"=1) + arguments(16 字符=4) = 5
  t.eq(withTools, 5);
});

// ── 压缩安全边界（不拆 assistant tool_calls 与 tool 结果，行业共识）──

test("findSafeArchiveBoundary：期望点非 tool → 原样返回", (t) => {
  // 下标 0=system；下标 4 是 assistant（非 tool）→ 切割点无需调整
  const msgs = [
    { role: "user", content: "sys" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
  ];
  t.eq(findSafeArchiveBoundary(msgs, 4), 4, "期望点非 tool 应原样");
});

test("findSafeArchiveBoundary：期望点落在 tool 结果 → 回退到其 assistant 之前", (t) => {
  // 下标 2=assistant(tool_calls)，下标 3=tool 结果
  // desiredCut=3 落在 tool 上 → 回退到 2（assistant，非 tool）→ tool 对完整保留
  const msgs = [
    { role: "user", content: "sys" },
    { role: "user", content: "a" },
    { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", content: "result1", tool_call_id: "x" },
    { role: "assistant", content: "b" },
  ];
  t.eq(findSafeArchiveBoundary(msgs, 3), 2, "tool 对不得被拆开");
});

test("findSafeArchiveBoundary：连续多个 tool 结果 → 回退到整组 assistant 之前", (t) => {
  // 下标 2=assistant(两次 tool_calls)，下标 3、4=两个 tool 结果
  // desiredCut=4 落在 tool 上 → 回退 3（tool）→ 回退 2（assistant，非 tool）
  const msgs = [
    { role: "user", content: "sys" },
    { role: "user", content: "a" },
    { role: "assistant", content: "", tool_calls: [
        { id: "x", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "y", type: "function", function: { name: "ls", arguments: "{}" } },
      ] },
    { role: "tool", content: "r1", tool_call_id: "x" },
    { role: "tool", content: "r2", tool_call_id: "y" },
    { role: "assistant", content: "b" },
  ];
  t.eq(findSafeArchiveBoundary(msgs, 4), 2, "整组 tool 对不得被拆开");
});

test("findSafeArchiveBoundary：期望点 <1 → 夹到 1（system 永不归档）", (t) => {
  // desiredCut=0 → 夹到 1；下标 1 虽是 tool 但 c=1 不满足 c>1，停在 1
  const msgs = [
    { role: "user", content: "sys" },
    { role: "tool", content: "r" },
    { role: "user", content: "c" },
  ];
  t.eq(findSafeArchiveBoundary(msgs, 0), 1, "system 永远不被归档");
  t.eq(findSafeArchiveBoundary(msgs, -5), 1, "负值同样夹到 1");
});
