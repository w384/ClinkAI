// delegate 子代理（能力单元）：把一个小而完整的子任务交给隔离上下文的子代理执行，
// 返回结构化回执（status + rounds + 子代理结论摘要）。
//
// 契约（test/cap.delegate.ts，契约先行）：
//   输入  : { task: string（必填，自包含描述）, maxRounds?: 1-10（默认 5） }
//   执行  : 独立子会话（独立 JSONL 文件）+ 受限工具集（内置六件）+ 有界轮次
//   成功  : ToolResult.ok=true，text=结构化回执
//   失败  : ToolResult.ok=false，回执含子状态与原因（非零退出绝不描述为成功）
// 显式非目标（Archify 式：写明边界）：
//   - 不并行（避免同文件写冲突；需要时父代理自行拆多次调用）
//   - 不嵌套（子工具集恒为内置六件，不含 delegate）
//   - 不继承父轨迹（子代理只看到 task + 工作区文件——隔离是特性不是缺陷）
//   - 不继承父自定义工具（子工具集固定为内置六件）
// 启用方式：默认关闭，bin 侧 CLINKAI_DELEGATE=1 显式启用（Archify 纪律④）。
import type { Config } from "../config.ts";
import type { ToolContext } from "../policy.ts";
import type { ChatMessage, ToolResult } from "../types.ts";
import { runAgent, type Renderer } from "../loop.ts";
import { buildSystemPrompt } from "../prompt.ts";
import { BUILTIN_TOOLS, type Tool } from "../tools/registry.ts";
import { Session } from "../session.ts";

/** 子代理默认轮次上限（子任务应小而完整，5 轮足够；再大就该拆任务了） */
export const DELEGATE_DEFAULT_MAX_ROUNDS = 5;
/** 子代理轮次上限的封顶值（防止父代理把大活整包丢给子代理） */
const DELEGATE_MAX_ROUNDS_CAP = 10;
/** 子代理 system 标记（测试路由 + 模型自我认知用） */
export const CHILD_MARKER = "子代理（delegate）";

/**
 * 构建 delegate 工具。cfg 决定子代理的模型端点/会话目录/工作区围栏。
 */
export function delegateTool(cfg: Config): Tool {
  return {
    name: "delegate",
    description:
      "把一个小而完整的子任务交给子代理在隔离上下文里执行（适合：多文件调研、大范围搜索汇总、独立验证步骤）。" +
      "子代理看不到主对话历史，task 必须自包含（目标+约束+期望产出）。" +
      "返回子代理的结构化回执：status/rounds + 结论摘要。" +
      "不适合：需要与主对话来回确认的任务、对同一批文件的密集修改。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "自包含的子任务描述（目标+约束+期望产出）" },
        maxRounds: { type: "integer", description: "子代理轮次上限（1-10，默认 5）" },
      },
      required: ["task"],
    },
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const t0 = Date.now();
      const task = String(args.task ?? "").trim();
      if (task.length === 0) {
        // 空任务：直接失败（结构化错误，不发起无意义子循环）
        return { ok: false, text: "delegate 失败：task 不能为空，请给出自包含的子任务描述。", durationMs: Date.now() - t0 };
      }
      // 轮次上限：clamp 到 [1, 10]（模型可能输出越界值）
      let maxRounds = DELEGATE_DEFAULT_MAX_ROUNDS;
      const mr = args.maxRounds;
      if (typeof mr === "number" && Number.isInteger(mr)) {
        maxRounds = Math.min(Math.max(mr, 1), DELEGATE_MAX_ROUNDS_CAP);
      }

      // ── 子代理装配：隔离上下文 + 独立会话 + 受限工具集 ──
      const childSession = new Session(cfg.sessionsDir);
      const childCfg: Config = { ...cfg, maxRounds };
      const childSystem =
        buildSystemPrompt(cfg) +
        `\n\n# ${CHILD_MARKER}\n` +
        `你正在以子代理身份执行一个子任务：你看不到主对话历史，只依据本任务描述与工作区文件行事。` +
        `完成后输出一段简洁中文结论（结论+关键依据+已验证/未验证）。` +
        `不要把任务再转交（你没有 delegate 工具），不要扩大任务范围。`;

      const recorded: ChatMessage[] = [];
      // 静默渲染器：子代理输出只落子会话文件，不打扰主终端
      const silent: Renderer = {
        onRound: () => {}, onDelta: () => {}, onReasoning: () => {},
        onToolStart: () => {}, onToolResult: () => {}, onUsage: () => {},
        onMeta: () => {}, onRoundEnd: () => {},
      };

      let report;
      try {
        report = await runAgent({
          task,
          cfg: childCfg,
          tools: BUILTIN_TOOLS, // 固定受限集：不含 delegate（不可嵌套）、不含父自定义工具
          ctx, // 同一工作区围栏与安全策略（安全边界统一，不放松）
          record: (role, msg, extra) => {
            recorded.push(msg);
            childSession.recordMessage(role, msg, extra);
          },
          meta: (note, extra) => childSession.append({ type: "meta", note, ...(extra ?? {}) }),
          inherited: [], // 隔离：不继承父轨迹
          renderer: silent,
          system: childSystem,
          gitBranch: "",
        });
      } catch (e) {
        // 子循环异常（理论上 loop 内部已兜底，这里是双保险）：失败回执
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, text: `[delegate 回执] status=error · 子代理运行异常：${msg}`, durationMs: Date.now() - t0 };
      }

      // 提取子代理结论：最后一条有正文的 assistant 消息
      let summary = "";
      for (let i = recorded.length - 1; i >= 0; i--) {
        const m = recorded[i];
        if (m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 0) {
          summary = m.content.trim();
          break;
        }
      }

      const header = `[delegate 回执] status=${report.status} · rounds=${report.rounds}`;
      if (report.status === "done") {
        // 成功回执：状态 + 结论摘要（摘要缺失时如实说明，不编造）
        const text = summary.length > 0 ? `${header}\n子代理结论：\n${summary}` : `${header}\n（子代理未输出结论正文）`;
        return { ok: true, text, durationMs: Date.now() - t0 };
      }
      // 失败回执（非零退出绝不描述为成功）：状态 + 原因 + 可行动建议
      const reason = report.reason ?? "未知原因";
      const text = `${header}\n子代理未完成任务（原因：${reason}）。建议：把子任务拆得更小、约束更明确后重试。`;
      return { ok: false, text, durationMs: Date.now() - t0 };
    },
  };
}
