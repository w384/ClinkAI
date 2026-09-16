// 配置模块：端点 / 密钥 / 模型 / 各类预算。
// 全部支持环境变量覆盖，默认值对准本机 llama.cpp（见规划文档 §2、§9.3）。
import os from "node:os";
import path from "node:path";
import type { SecurityMode } from "./policy.ts";

/** 全部运行参数（只读视图） */
export interface Config {
  baseUrl: string; // 模型服务 OpenAI 兼容根路径
  apiKey: string; // Bearer 密钥
  model: string; // 模型 id
  maxRounds: number; // agent 循环最大轮数（全局上限）
  maxTokens: number; // 每轮生成上限（含思考，qwen3.8 思考恒开；对齐模型最大输出 32768）
  temperature: number; // 采样温度
  ctxBudget: number; // 轨迹估算 token 超过该值 → 触发归档摘要
  toolOutLimit: number; // 单条工具输出截断阈值（字符）
  securityMode: SecurityMode; // 三档安全开关（read-only/workspace-write/danger-full-access）
  workspace: string; // 工作区根目录（路径围栏边界）
  sessionsDir: string; // 会话 JSONL 目录
  verbose: boolean; // 是否展开完整思考内容
}

/** 命令行覆盖项（未提供的字段用默认值/环境变量） */
export interface ConfigOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxRounds?: number;
  workspace?: string;
  verbose?: boolean;
  securityMode?: SecurityMode; // CLI --security 显式覆盖（优先级最高）
}

/**
 * 组装最终配置。
 * 优先级：命令行覆盖 > 环境变量 > 内置默认值。
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  // 工作区默认为进程启动目录；会话目录固定放在用户主目录，避免污染工作区
  const workspace = overrides.workspace ?? process.env.CLINKAI_WORKSPACE ?? process.cwd();
  return {
    // 模型服务端点：默认指向本机 3090 上的 llama.cpp
    baseUrl: overrides.baseUrl ?? env("CLINKAI_BASE_URL", "http://127.0.0.1:18080/v1"),
    // 密钥：本机约定值 local-3090；生产部署必须用环境变量注入
    apiKey: overrides.apiKey ?? env("CLINKAI_API_KEY", "local-3090"),
    model: overrides.model ?? env("CLINKAI_MODEL", "qwen3.8-27b-local"),
    // 全局轮数上限：防止"Agent 可能永远跑下去"（PDF §5.1.5 终止层）
    maxRounds: overrides.maxRounds ?? intEnv("CLINKAI_MAX_ROUNDS", 15),
    // 每轮 max_tokens 上限：对齐模型最大输出 32768（与 DSH 一致），给恒开思考留足空间，
    // 避免"思考+工具调用"超上限被截断成 "{"（4096 已实测会截断长思考）；
    // 这是天花板不是目标——模型仍按 finish_reason 提前结束，不会无脑写满
    maxTokens: intEnv("CLINKAI_MAX_TOKENS", 32768),
    temperature: floatEnv("CLINKAI_TEMP", 0.3),
    // 128K 上下文取 ~70% 作为轨迹预算，留出前缀与本轮生成空间
    ctxBudget: intEnv("CLINKAI_CTX_BUDGET", 90000),
    // 单条工具输出截断阈值（PDF §2.7.4 第 1 层：工具结果预算）
    toolOutLimit: intEnv("CLINKAI_TOOL_OUT", 8192),
    // 三档安全开关：默认 workspace-write（保持既有行为）；
    // read-only 更保守（只读），danger-full-access 更宽松（全放行）
    securityMode: overrides.securityMode ?? parseSecurityMode(env("CLINKAI_SECURITY_MODE", "workspace-write")),
    workspace,
    // 会话目录：环境变量优先（受限环境/多项目隔离），默认用户主目录
    sessionsDir:
      (process.env.CLINKAI_SESSIONS && process.env.CLINKAI_SESSIONS.trim().length > 0
        ? path.resolve(process.env.CLINKAI_SESSIONS)
        : path.join(os.homedir(), ".clinkai", "sessions")),
    verbose: overrides.verbose ?? (process.env.CLINKAI_VERBOSE === "1"),
  };
}

/** 读取字符串环境变量，缺省返回默认值 */
function env(name: string, fallback: string): string {
  // 空字符串视为未设置，避免误传空值
  const v = process.env[name];
  if (v === undefined || v === "") {
    return fallback;
  }
  return v;
}

/** 读取整数环境变量；非法值回退默认（不抛错，配置错误不应炸掉启动） */
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number(v);
  // 非有限正数一律回退，防止把循环上限设成 0 或 NaN
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

/** 解析安全档位；只接受三个合法值，非法值回退 workspace-write（fail-safe，不炸启动） */
function parseSecurityMode(v: string): SecurityMode {
  // 白名单校验：只接受三个合法档位（大小写敏感，与 DSH/Codex 命名一致）
  const trimmed = v.trim();
  if (trimmed === "read-only" || trimmed === "workspace-write" || trimmed === "danger-full-access") {
    return trimmed;
  }
  // 非法值：回退默认档（配置错误不应炸掉启动，保持既有行为）
  return "workspace-write";
}

/** 读取浮点环境变量；非法值回退默认 */
function floatEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number(v);
  // 温度只允许 0~2 的常见范围，越界视为配置错误
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    return fallback;
  }
  return n;
}
