// 上下文压缩：最小实现只取 PDF 五层压缩的前两层。
//   第 1 层 工具结果预算——超阈值输出截断（头尾保留，全文进会话日志）；
//   第 4 层 归档式摘要——轨迹超预算时把最旧的一批消息压成一条摘要（保留优先级见 summarize 提示词）。
// 明确不做：API 层微压缩、全量压缩、压缩熔断器（MVP 规模下归档摘要一次即够）。
import type { Config } from "./config.ts";
import type { ChatMessage } from "./types.ts";
import { streamChat } from "./model-client.ts";

/**
 * 中间截断：超长文本保留头尾，中间打标记。
 * 保留头尾是因为：文件开头=结构/导入，结尾=结论/最新状态（PDF §2.7.5 语义完整性）。
 */
export function truncateMiddle(text: string, limit: number): { text: string; truncated: boolean } {
  // 未超阈值直接返回，避免无谓字符串拷贝
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  // 头尾各占一半预算；截断量用于提示模型"还有内容"
  const half = Math.floor(limit / 2);
  const dropped = text.length - half * 2;
  const marker = `\n[... 中间省略 ${dropped} 字符（完整内容已存入会话日志，可用 read 工具查看） ...]\n`;
  return { text: text.slice(0, half) + marker + text.slice(text.length - half), truncated: true };
}

/**
 * 粗略估算一段文本的 token 数（不做精确分词，预算估算足够）。
 * 经验值：CJK 字符 ≈ 1 token/字；ASCII ≈ 4 字符/token（Qwen 词表实测量级）。
 */
export function estimateTokens(s: string): number {
  // 统计 CJK 区字符（含全角标点）
  const cjk = (s.match(/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  // 其余按 ASCII 折算
  const rest = Math.max(0, s.length - cjk);
  return Math.ceil(cjk * 1 + rest / 4);
}

/** 估算整个消息列表的 token 总量（用于触发归档摘要） */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  // 逐条累加：content + 工具调用参数（tool_calls 也是模型要"读"的上下文）
  for (const m of messages) {
    total += estimateTokens(m.content ?? "");
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
  }
  return total;
}

/** 归档摘要的保留优先级（PDF §2.7.5：压缩时什么不能丢） */
const SUMMARY_PROMPT = `你是会话轨迹压缩器。把下面这段 agent 工作轨迹压缩成一份紧凑摘要，供后续轮次作为背景。
必须保留（按优先级）：
1. 已做出的关键决策和理由（架构选择、方案取舍）；
2. 已创建/修改/删除的文件清单；
3. 各步骤的验证状态（成功/失败/未验证）；
4. 未解决的问题、TODO、回滚注意事项；
5. 用户提出的约束和偏好。
可以丢弃：重复的中间过程、工具的完整输出（只留结论）。
输出纯文本，不超过 600 字，不要寒暄。

=== 轨迹开始 ===
%s
=== 轨迹结束 ===`;

/** 归档摘要结果：成功=新消息列表；失败=原因文本（调用方据此给出准确提示） */
export type ArchiveResult = { ok: true; messages: ChatMessage[] } | { ok: false; error: string };

/**
 * 调用模型对最旧的一批消息做归档摘要（M2 触发条件：轨迹估算超 ctxBudget）。
 * 摘要结果替换掉被压缩的消息，返回新的消息列表。
 * 失败时返回原因（内容太少/模型错误），调用方不再重试（防"压缩失败死循环"，PDF §2.7.4 熔断思想）。
 */
export async function archiveOldest(
  cfg: Config,
  messages: ChatMessage[],
  keepRecent: number
): Promise<ArchiveResult> {
  // system 消息（下标 0）永远不参与压缩：它是冻结前缀
  const oldestCount = messages.length - keepRecent - 1;
  // 可压缩内容太少时摘要没有意义（摘要可能比原文还长）——这是正常情况，不是错误
  if (oldestCount < 3) {
    return { ok: false, error: `可压缩消息只有 ${Math.max(0, oldestCount)} 条（<3），轨迹尚小，无需归档` };
  }
  // 取出最旧的一批，拼成纯文本（只保留对模型有意义的字段）
  const oldest = messages.slice(1, 1 + oldestCount);
  const transcript = oldest
    .map((m) => {
      // 按角色加前缀；工具调用参数一并带入（决策证据）
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ");
        return `[assistant] 工具调用: ${calls}${m.content ? `；正文: ${m.content}` : ""}`;
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n");

  // 摘要调用：不带工具、低温度、固定输出上限（摘要不应跑飞）
  try {
    const result = await streamChat(
      { ...cfg, maxTokens: 1500, temperature: 0.2 },
      [{ role: "user", content: SUMMARY_PROMPT.replace("%s", transcript) }]
    );
    // 摘要为空视为失败（模型抽风），保持原状
    if (!result.content || result.content.trim().length < 50) {
      return { ok: false, error: `摘要输出过短（${result.content?.length ?? 0} 字符），视为失败` };
    }
    // 用一条 user 消息承载摘要，放在 system 之后、近期消息之前
    const summaryMsg: ChatMessage = {
      role: "user",
      content: `【历史轨迹摘要（系统生成，作为背景参考，其中结论已被后续轮次验证或修正时以后续为准）】\n${result.content.trim()}`,
    };
    return { ok: true, messages: [messages[0], summaryMsg, ...messages.slice(1 + oldestCount)] };
  } catch (e) {
    // 摘要失败（网络/超时/HTTP）不重试、不中断：轨迹虽长，但截断仍可用
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `摘要调用失败：${msg}` };
  }
}
