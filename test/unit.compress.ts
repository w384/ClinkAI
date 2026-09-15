// compress.ts 的离线单测：截断、token 估算（纯函数，无需模型/网络）。
import { test } from "./harness.ts";
import { truncateMiddle, estimateTokens, estimateMessagesTokens } from "../src/compress.ts";

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
