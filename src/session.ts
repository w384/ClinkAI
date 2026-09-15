// 会话持久化：append-only JSONL（dsh "模型可见 ⟺ 已记录" 不变量的最小版）。
// 每一行一个事件；崩溃后文件仍是合法前缀，可继续追加（append-only 的核心好处）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatMessage } from "./types.ts";

/** 事件类型：覆盖循环中所有需要留痕的动作 */
export type SessionEventType = "init" | "user" | "assistant" | "tool" | "error" | "meta";

/** 一条会话事件（结构随 type 变化，ts/type 固定） */
export interface SessionEvent {
  ts: number;
  type: SessionEventType;
  [key: string]: unknown;
}

/**
 * 会话文件封装。
 * 职责：目录准备、追加事件、按时间戳命名、resume 时回放成消息列表。
 */
export class Session {
  /** 会话 JSONL 文件绝对路径 */
  file: string;

  /**
   * @param dir 会话目录（不存在则创建）
   * @param resumeFile 非空时以该文件作为本会话延续（同一文件继续追加）
   */
  constructor(dir: string, resumeFile?: string) {
    // 确保目录存在（首次运行）
    fs.mkdirSync(dir, { recursive: true });
    if (resumeFile && fs.existsSync(resumeFile)) {
      // resume 模式：沿用旧文件，历史事件不复制、直接继续追加
      this.file = path.resolve(resumeFile);
    } else {
      // 新会话：时间戳 + 短随机后缀命名，避免同秒冲突
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const rand = Math.random().toString(36).slice(2, 6);
      this.file = path.join(dir, `${ts}-${rand}.jsonl`);
      // 先落一个 init 事件标记创建时间（即使后续全部失败，文件也有头）
      this.append({ type: "init", task: undefined });
    }
  }

  /** 追加一条事件并立即刷盘（fs.appendFileSync 在 Windows 上同步完成） */
  append(evt: Record<string, unknown>): void {
    // 统一补 ts（已有则保留），调用方不用关心
    const line = JSON.stringify({ ts: Date.now(), ...evt });
    // 序列化失败（理论上不会，事件都是纯数据）不应中断 agent 循环
    fs.appendFileSync(this.file, line + "\n", "utf8");
  }

  /** 记录一条消息（user/assistant/tool 的统一入口） */
  recordMessage(role: "user" | "assistant" | "tool", msg: ChatMessage, extra?: Record<string, unknown>): void {
    // assistant 消息可能携带工具调用，一并落盘以便回放
    this.append({ type: role, role: msg.role, content: msg.content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id, ...extra });
  }

  /**
   * 回放会话文件为消息列表（resume 用）。
   * 只还原 role=user/assistant/tool 三类消息；init/meta/error 跳过。
   */
  static replay(file: string): ChatMessage[] {
    // 文件不存在时抛错，让 CLI 给出明确提示
    if (!fs.existsSync(file)) {
      throw new Error(`会话文件不存在：${file}`);
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const messages: ChatMessage[] = [];
    // 逐行解析；单行损坏跳过（append-only 的容错：坏行不影响其余历史）
    for (const line of lines) {
      let evt: SessionEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        // 半行（写入时进程被杀）是 append-only 的已知边界，静默跳过
        continue;
      }
      // 只回放消息类事件
      if (evt.type !== "user" && evt.type !== "assistant" && evt.type !== "tool") {
        continue;
      }
      // 按事件类型还原成协议消息
      if (evt.type === "user") {
        messages.push({ role: "user", content: String(evt.content ?? "") });
      } else if (evt.type === "assistant") {
        const msg: ChatMessage = { role: "assistant", content: String(evt.content ?? ""), tool_calls: evt.tool_calls as ChatMessage["tool_calls"] };
        messages.push(msg);
      } else {
        // tool 事件：tool_call_id 是回填关联键，必须原样还原
        messages.push({ role: "tool", content: String(evt.content ?? ""), tool_call_id: String(evt.tool_call_id ?? "") });
      }
    }
    return messages;
  }

  /** 取会话目录下最新的一个会话文件（--resume auto 用） */
  static latestIn(dir: string): string | null {
    // 目录不存在视为没有历史会话
    if (!fs.existsSync(dir)) {
      return null;
    }
    // 按 mtime 排序取最新；过滤非 jsonl 文件
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    // 没有任何会话时返回 null
    if (files.length === 0) {
      return null;
    }
    return path.join(dir, files[0].f);
  }
}

/** 默认会话目录：用户主目录下的 .clinkai/sessions；
 *  可用 CLINKAI_SESSIONS 环境变量覆盖（受限环境/多项目隔离时用） */
export function defaultSessionsDir(): string {
  // 环境变量优先：允许把会话存到工作区或任意位置
  const override = process.env.CLINKAI_SESSIONS;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  // os.homedir() 在 Windows 上解析 %USERPROFILE%，不依赖 shell 展开
  return path.join(os.homedir(), ".clinkai", "sessions");
}
