// 提示词组装：静态前缀（冻结）+ 状态栏（轨迹尾部，发送时临时追加）。
// 前缀纪律（规划 D6 / PDF §2.3）：system 消息一经组装字节级不变，
// 保证 KV Cache 前缀全程命中（本机已实测 cached_tokens 有效）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { LoopState } from "./types.ts";

/** 项目根目录（src/ 的上一级），用于定位 prompts/system.md */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * MEMORY.md 注入上限（字符）。
 * 契约：长期记忆应被"策展"（精炼、常新）；超限只保留头部并带明确标记，
 * 提示用户瘦身——而不是静默丢弃或无限膨胀前缀（前缀膨胀=每轮多付 token）。
 */
export const MEMORY_MD_CAP = 8192;

/**
 * 构建冻结的系统提示词（会话内只构建一次）。
 * 组成：系统人格与纪律（prompts/system.md 模板）+ 工作区信息
 *      + 项目指令 AGENTS.md（如有）+ 长期记忆 MEMORY.md（如有且非空）。
 */
export function buildSystemPrompt(cfg: Config): string {
  // 读取模板文件；缺失时给最小兜底（系统不应因提示词文件丢失而无法启动）
  let template = "";
  try {
    template = fs.readFileSync(path.join(PROJECT_ROOT, "prompts", "system.md"), "utf8");
  } catch {
    // 模板丢失：退化为一句最小角色说明，功能仍可跑
    template = "你是 ClinkAI，一个运行在本机的编码助手。先读后改，验证后交付。";
  }
  // 一次性替换工作区占位符（之后不再改动，保证前缀稳定）
  let system = template.replace(/\{\{workspace\}\}/g, cfg.workspace);

  // 项目指令文件：AGENTS.md 是"这个仓库里该怎么干活"的约定（PDF §5.1.3 项目文档化）
  const agentsMd = path.join(cfg.workspace, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    // 读取项目指令；失败（权限等）静默跳过，不阻塞启动
    try {
      const content = fs.readFileSync(agentsMd, "utf8");
      // 附加到前缀末尾——它同样属于"静态"部分，随会话冻结
      system += `\n\n# 项目指令（来自工作区 AGENTS.md）\n${content.trim()}\n`;
    } catch {
      // 文件存在但读不了：忽略（罕见，不致命）
    }
  }

  // 长期记忆：MEMORY.md 是"跨会话该记住的事"（用户策展的本地记忆）。
  // 契约（见 test/unit.memory.ts）：存在且非空=启用；空文件=不存在；
  // 超限保留头部+截断标记；顺序恒在 AGENTS.md 之后（前缀稳定）。
  const memoryMd = path.join(cfg.workspace, "MEMORY.md");
  if (fs.existsSync(memoryMd)) {
    try {
      const content = fs.readFileSync(memoryMd, "utf8").trim();
      if (content.length > 0) {
        // 超限：保留头部 + 明确标记（总数/上限），引导用户瘦身而不是静默截断
        const body =
          content.length > MEMORY_MD_CAP
            ? `${content.slice(0, MEMORY_MD_CAP)}\n\n[MEMORY.md 过长（总 ${content.length} 字），仅注入前 ${MEMORY_MD_CAP} 字；请精简该文件保持常新]`
            : content;
        system += `\n\n# 长期记忆（来自工作区 MEMORY.md）\n${body}\n`;
      }
    } catch {
      // 文件存在但读不了：忽略（与 AGENTS.md 同一 fail-safe）
    }
  }
  return system;
}

/**
 * 生成状态栏短消息（PDF §2.6：把隐式状态显式化）。
 * 放在轨迹末尾发送、不落盘——避免污染会话日志，也避免动前缀。
 */
export function buildStatusLine(state: LoopState): string {
  // 估算用量百分比：给模型一个"快用完了"的信号，促使它收敛
  const pct = state.ctxBudget > 0 ? Math.round((state.estTokens / state.ctxBudget) * 100) : 0;
  return (
    `[系统状态（非用户输入）] 轮次 ${state.round}/${state.maxRounds} · ` +
    `估算上下文 ${state.estTokens} tokens（预算 ${state.ctxBudget}，${pct}%） · ` +
    `工作区 ${state.workspace} · git 分支 ${state.gitBranch || "未知"}。` +
    `若上下文接近预算，请收敛动作并优先给出阶段性结论。`
  );
}
