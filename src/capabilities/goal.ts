// goal 续跑（能力单元）：把一个目标按"有界轮次"执行——
// 每一轮是一次 runAgent（独立会话文件、独立轮次上限）；
// 某轮因"时间用尽"（max-rounds）收尾时，自动继承该轮完整轨迹开启下一轮；
// 遇到"方向性/环境性问题"（error、breaker-*）则硬停并给出结构化回执，不浪费重试。
//
// 契约（test/cap.goal.ts，契约先行）：
//   输入  : { objective, cfg, ctx, tools?, inherited?, maxRounds? }
//           maxRounds = goal 总轮次上限（每轮内部的轮数上限仍由 cfg.maxRounds 控制）
//   续跑  : 仅 max-rounds 触发续跑（时间用尽=方向对，值得继续）；
//           error/breaker-repeat/breaker-failure 硬停（同上下文重试大概率重蹈覆辙，
//           交给用户看回执决策——Archify"结构化失败诊断"纪律）
//   回执  : GoalReport.rounds = 逐轮 { index, status, rounds, sessionFile }
//           GoalReport.done = 是否有某一轮达到 done
// 显式非目标：
//   - 轮次间不并行（轨迹继承要求顺序）
//   - 不做轮次间上下文压缩（继承完整轨迹；单轮内的归档由循环层负责）
//   - 不跨 goal 记忆（跨会话记忆走 MEMORY.md 能力）
// 启用方式：bin 侧 --goal 显式启用（默认关闭——Archify 纪律④）。
import type { Config } from "../config.ts";
import type { ToolContext } from "../policy.ts";
import type { AgentReport, ChatMessage } from "../types.ts";
import { runAgent, type Renderer } from "../loop.ts";
import { buildSystemPrompt } from "../prompt.ts";
import { BUILTIN_TOOLS, type Tool } from "../tools/registry.ts";
import { Session } from "../session.ts";

/** goal 默认总轮次上限（"有界默认 3"——超出说明目标该拆了） */
export const GOAL_DEFAULT_MAX_ROUNDS = 3;
/** goal 总轮次上限的封顶值 */
const GOAL_MAX_ROUNDS_CAP = 10;

/** 单轮回执：该轮的状态、轮数与独立会话文件 */
export interface RoundReceipt {
  /** 第几轮（1 起） */
  index: number;
  /** 该轮 runAgent 的结束状态 */
  status: AgentReport["status"];
  /** 失败原因（done 时为空） */
  reason?: string;
  /** 该轮消耗的模型轮数 */
  rounds: number;
  /** 该轮独立会话文件（可回放/审计） */
  sessionFile: string;
}

/** goal 总回执 */
export interface GoalReport {
  /** 目标文本 */
  objective: string;
  /** 是否有某一轮达到 done */
  done: boolean;
  /** 逐轮回执（按执行顺序） */
  rounds: RoundReceipt[];
  /** 生效的总轮次上限（经 clamp；诊断用） */
  effectiveMaxRounds: number;
}

/** goal 运行参数 */
export interface GoalOptions {
  /** 目标描述（第 1 轮的 task；续跑轮的指令中也会引用） */
  objective: string;
  /** 模型端点/轮次上限/会话目录等（每轮共用） */
  cfg: Config;
  /** 工作区围栏/工具输出限制（每轮共用，安全边界统一） */
  ctx: ToolContext;
  /** 工具集（默认内置六件） */
  tools?: Tool[];
  /** 第 1 轮的继承轨迹（通常为空） */
  inherited?: ChatMessage[];
  /** 渲染器（默认静默） */
  renderer?: Renderer;
  /** 系统提示词（默认 buildSystemPrompt(cfg)） */
  system?: string;
  /** git 分支（状态栏展示用） */
  gitBranch?: string;
  /** 总轮次上限（默认 3，clamp 到 1-10） */
  maxRounds?: number;
}

/** 静默渲染器（测试与脚本场景） */
function silentRenderer(): Renderer {
  const f = () => {};
  return { onRound: f, onDelta: f, onReasoning: f, onToolStart: f, onToolResult: f, onUsage: f, onMeta: f, onRoundEnd: f };
}

/**
 * 执行一个 goal：有界轮次 + max-rounds 自动续跑 + 结构化回执。
 * 永不抛出（单轮内部错误已转为 status=error 回执）；调用方据 GoalReport 决策。
 */
export async function runGoal(opts: GoalOptions): Promise<GoalReport> {
  const effectiveMaxRounds = Math.min(Math.max(opts.maxRounds ?? GOAL_DEFAULT_MAX_ROUNDS, 1), GOAL_MAX_ROUNDS_CAP);
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const renderer = opts.renderer ?? silentRenderer();
  const system = opts.system ?? buildSystemPrompt(opts.cfg);
  const rounds: RoundReceipt[] = [];
  let inherited = opts.inherited ?? [];
  let done = false;

  for (let i = 1; i <= effectiveMaxRounds; i++) {
    // 每轮独立会话文件：轮次间可回放、可审计、互不污染
    const session = new Session(opts.cfg.sessionsDir);
    // 续跑轮的任务：引用原目标 + 明确"从断点继续"（不重复已完成的事）
    const task =
      i === 1
        ? opts.objective
        : `goal 续跑（第 ${i}/${effectiveMaxRounds} 轮）：原目标为「${opts.objective}」。` +
          `回顾上方历史，确认已完成部分与中断点，从中断处继续，不要重复已完成的工作。若目标已完成，直接输出完成总结。`;

    let report: AgentReport;
    try {
      report = await runAgent({
        task,
        cfg: opts.cfg,
        tools,
        ctx: opts.ctx,
        record: (role, msg, extra) => session.recordMessage(role, msg, extra),
        meta: (note, extra) => session.append({ type: "meta", note, ...(extra ?? {}) }),
        inherited,
        renderer,
        system,
        gitBranch: opts.gitBranch ?? "",
      });
    } catch (e) {
      // 双保险：runAgent 内部已兜底，这里防意外（异常也转成结构化回执，不抛出）
      const msg = e instanceof Error ? e.message : String(e);
      rounds.push({ index: i, status: "error", reason: `goal 运行异常：${msg}`, rounds: 0, sessionFile: session.file });
      break;
    }

    rounds.push({ index: i, status: report.status, reason: report.reason, rounds: report.rounds, sessionFile: session.file });

    if (report.status === "done") {
      // 目标达成：收工
      done = true;
      break;
    }
    if (report.status === "error" || report.status === "breaker-repeat" || report.status === "breaker-failure") {
      // 硬停分支：模型/环境异常或方向性问题——同上下文续跑大概率重蹈覆辙，
      // 交结构化回执给用户决策（而不是烧额度重试）
      break;
    }
    // max-rounds：时间用尽、方向正确 → 继承本轮完整轨迹续跑
    inherited = [...inherited, ...Session.replay(session.file)];
  }

  return { objective: opts.objective, done, rounds, effectiveMaxRounds };
}
