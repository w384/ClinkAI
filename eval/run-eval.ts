// eval 运行器：7 个固定任务 × 各 3 次，客观校验器判分（不靠模型自述）。
// 用法：node eval/run-eval.ts
// 说明：
//   - 每个任务用独立工作区副本 eval/ws（避免跨任务状态污染）；
//   - 校验器基于"文件系统状态 + 输出文本"两个客观信号；
//   - memory/ext 任务分别验收 MEMORY.md 记忆注入与 tools-ext 扩展工具（能力级回归）；
//   - 结果落盘 eval/results.json，终端打印汇总表。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 项目根目录（ClinkAI/）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// eval 目录与评估用工作区
const EVAL_DIR = path.join(ROOT, "eval");
const WS = path.join(EVAL_DIR, "ws");
// 会话目录放 eval 下（受限沙箱里主目录可能不可写）
const SESSIONS = path.join(EVAL_DIR, "sessions");

/** 从会话 JSONL 提取一次运行的结构化结果（判分依据） */
interface SessionDigest {
  /** 所有 assistant 消息正文拼接 */
  assistantText: string;
  /** 工具调用事件（名字 + 是否成功 + 结果文本） */
  toolEvents: { name: string; ok: boolean; content: string }[];
  /** 是否以 done 元事件结束 */
  finishedDone: boolean;
  /** 原始输出行数（排查用） */
  eventCount: number;
}

/** 读取会话目录下最新 JSONL 并解析为摘要（判分数据源，避免依赖管道捕获） */
function readLatestSession(): SessionDigest {
  // 会话目录不存在 → 空摘要（运行没跑起来）
  if (!fs.existsSync(SESSIONS)) {
    return { assistantText: "", toolEvents: [], finishedDone: false, eventCount: 0 };
  }
  // 按 mtime 取最新文件
  const files = fs
    .readdirSync(SESSIONS)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(SESSIONS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  // 没有会话文件
  if (files.length === 0) {
    return { assistantText: "", toolEvents: [], finishedDone: false, eventCount: 0 };
  }
  // 逐行解析（坏行跳过，与 session.replay 同策略）
  const lines = fs.readFileSync(path.join(SESSIONS, files[0].f), "utf8").split("\n");
  const digest: SessionDigest = { assistantText: "", toolEvents: [], finishedDone: false, eventCount: 0 };
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    digest.eventCount++;
    // 按事件类型归集
    if (evt.type === "assistant") {
      digest.assistantText += String(evt.content ?? "") + "\n";
    } else if (evt.type === "tool") {
      digest.toolEvents.push({ name: String(evt.tool ?? "?"), ok: Boolean(evt.ok), content: String(evt.content ?? "") });
    } else if (evt.type === "meta" && evt.note === "done") {
      digest.finishedDone = true;
    }
  }
  return digest;
}

/** 一次单任务运行的结果 */
interface RunResult {
  taskId: string;
  run: number;
  pass: boolean;
  failedChecks: string[];
  seconds: number;
  exitCode: number;
}

/** 校验器：拿到工作区路径与该次运行的会话摘要，返回是否通过 */
type Check = (ws: string, d: SessionDigest) => boolean;

/** 一个评估任务 */
interface EvalTask {
  id: string;
  /** 给 ClinkAI 的任务指令 */
  prompt: string;
  /** 该任务专属的环境变量（能力开关等；默认无） */
  env?: Record<string, string>;
  /** 客观校验器列表（全部通过才算 pass） */
  checks: { name: string; ok: Check }[];
}

// ─────────────────────────── 评估任务定义 ───────────────────────────

/** 读取工作区文件文本（校验用；失败返回 null） */
function readWs(p: string): string | null {
  try {
    return fs.readFileSync(path.join(WS, p), "utf8");
  } catch {
    return null;
  }
}

const TASKS: EvalTask[] = [
  {
    id: "qa",
    // 任务 1：纯问答（验证模型调用 + 流式 + 不滥用工具）
    prompt: "用一到两句话解释什么是 agent loop（agent 循环）。不要使用任何工具。",
    checks: [
      {
        name: "有实质回答（≥20 字符）",
        ok: (ws, d) => d.assistantText.replace(/\s/g, "").length >= 20,
      },
      {
        name: "未调用工具",
        ok: (ws, d) => d.toolEvents.length === 0,
      },
      {
        name: "以 done 结束",
        ok: (ws, d) => d.finishedDone,
      },
    ],
  },
  {
    id: "create",
    // 任务 2：write + read 闭环（文件真实落盘且内容正确）
    prompt: "在工作区创建 reports/summary.md，内容恰好为三行：A、B、C（每行一个字母）。写完后 read 回确认，最后报告结果。",
    checks: [
      {
        name: "reports/summary.md 存在",
        ok: (ws) => readWs("reports/summary.md") !== null,
      },
      {
        name: "内容含 A/B/C 三行",
        ok: (ws) => {
          const t = readWs("reports/summary.md");
          if (t === null) {
            return false;
          }
          const lines = t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
          // 三行分别以 A/B/C 开头（允许模型加了标点）
          return lines.some((l) => l.startsWith("A")) && lines.some((l) => l.startsWith("B")) && lines.some((l) => l.startsWith("C"));
        },
      },
      {
        name: "有 read 回确认动作",
        ok: (ws, d) => d.toolEvents.some((t) => t.name === "read" && t.ok),
      },
    ],
  },
  {
    id: "edit",
    // 任务 3：edit 精确替换（重命名函数 + export 同步改）
    prompt: "修改 src/app.ts：把函数 sub 重命名为 subtract（函数定义与 export 处都要改），其余内容保持不变。改完 read 回确认。",
    checks: [
      {
        name: "含 subtract",
        ok: (ws) => (readWs("src/app.ts") ?? "").includes("subtract"),
      },
      {
        name: "不再含旧名 sub(",
        ok: (ws) => !(readWs("src/app.ts") ?? "").includes("sub("),
      },
      {
        name: "add 函数保留",
        ok: (ws) => (readWs("src/app.ts") ?? "").includes("function add"),
      },
    ],
  },
  {
    id: "find",
    // 任务 4：ls/grep 检索（能找出 .ts 文件并报告路径）
    prompt: "找出工作区里所有 .ts 文件（用 ls 或 grep），在最终回答中列出每个文件的相对路径。",
    checks: [
      {
        name: "回答提及 app.ts",
        ok: (ws, d) => d.assistantText.includes("app.ts"),
      },
      {
        name: "有检索动作（ls 或 grep）",
        ok: (ws, d) => d.toolEvents.some((t) => (t.name === "ls" || t.name === "grep") && t.ok),
      },
    ],
  },
  {
    id: "bash",
    // 任务 5：bash 白名单命令 + 输出回填（echo 属白名单，免确认）
    prompt: "用 bash 工具执行命令：echo hello-ClinkAI 。执行后把命令的输出原样报告出来。",
    checks: [
      {
        name: "bash 调用成功",
        ok: (ws, d) => d.toolEvents.some((t) => t.name === "bash" && t.ok),
      },
      {
        name: "结果含 hello-ClinkAI",
        ok: (ws, d) => d.assistantText.includes("hello-ClinkAI"),
      },
    ],
  },
  {
    id: "memory",
    // 任务 6（能力：MEMORY.md）：答案只存在于工作区记忆文件中
    // 记忆注入是自动的（工作区根 MEMORY.md 非空即注入系统提示词），
    // 客观信号 = 回答含只有 MEMORY.md 里才有的代号（模型无法从其他文件/常识得到）
    prompt: "我们的项目内部代号是什么？直接回答代号本身，不要解释。",
    checks: [
      {
        name: "回答含记忆中的代号 NEBULA-7",
        ok: (ws, d) => d.assistantText.includes("NEBULA-7"),
      },
      {
        name: "以 done 结束",
        ok: (ws, d) => d.finishedDone,
      },
    ],
  },
  {
    id: "ext",
    // 任务 7（能力：tools-ext）：调用仅经 CLINKAI_TOOLS_EXT 注入的扩展工具
    // 客观信号 = 会话里有 ext_marker 成功事件 + 回答含工具返回的固定口令
    prompt: "调用 ext_marker 工具拿到今日口令，然后在回答中原样复述该口令。",
    env: { CLINKAI_TOOLS_EXT: path.join(EVAL_DIR, "ext-tools.mjs") },
    checks: [
      {
        name: "ext_marker 被调用且成功",
        ok: (ws, d) => d.toolEvents.some((t) => t.name === "ext_marker" && t.ok),
      },
      {
        name: "回答含工具返回的口令 KAL-PA-2026",
        ok: (ws, d) => d.assistantText.includes("KAL-PA-2026"),
      },
      {
        name: "以 done 结束",
        ok: (ws, d) => d.finishedDone,
      },
    ],
  },
];

// ─────────────────────────── 工作区准备 ───────────────────────────

/** 重建干净的评估工作区（每个完整 eval 前调用一次） */
function resetWorkspace(): void {
  // 整体删除后重建，保证 3 次运行的初始状态一致
  if (fs.existsSync(WS)) {
    fs.rmSync(WS, { recursive: true, force: true });
  }
  // 基础目录
  fs.mkdirSync(path.join(WS, "src"), { recursive: true });
  fs.mkdirSync(path.join(WS, "data"), { recursive: true });
  // 基础文件 1：说明
  fs.writeFileSync(path.join(WS, "README.md"), "# eval 工作区\n\n用于 ClinkAI 评估。\n", "utf8");
  // 基础文件 2：带 sub 函数的 TS 文件（edit 任务的对象）
  fs.writeFileSync(
    path.join(WS, "src", "app.ts"),
    "function add(a: number, b: number): number {\n  return a + b;\n}\n\nfunction sub(a: number, b: number): number {\n  return a - b;\n}\n\nexport { add, sub };\n",
    "utf8"
  );
  // 基础文件 3：数据笔记
  fs.writeFileSync(path.join(WS, "data", "notes.md"), "line-1: 评估数据行 1\nline-2: 评估数据行 2\n", "utf8");
  // 基础文件 4：长期记忆（memory 任务的答案来源；注入系统提示词）
  fs.writeFileSync(path.join(WS, "MEMORY.md"), "# 项目记忆\n\n- 内部代号：NEBULA-7\n", "utf8");
  // 会话目录
  fs.mkdirSync(SESSIONS, { recursive: true });
}

// ─────────────────────────── 运行与判定 ───────────────────────────

/** 运行一次 ClinkAI CLI，返回 {exitCode, seconds}（输出直显终端；判分读会话文件） */
function runOnce(prompt: string, timeoutMs: number, extraEnv?: Record<string, string>): Promise<{ exitCode: number; seconds: number }> {
  return new Promise((resolve) => {
    // 环境：会话目录指到 eval 下（沙箱可写区域）+ 任务专属开关（如 tools-ext）
    const env = { ...process.env, CLINKAI_SESSIONS: SESSIONS, ...(extraEnv ?? {}) };
    // 启动子进程：stdio 用 inherit（本沙箱禁止管道捕获，inherit 允许；
    // 判分数据改从会话 JSONL 读取，不依赖 stdout 捕获）
    const child = spawn(
      process.execPath,
      ["bin/clinkai.ts", "--workspace", WS, "--max-rounds", "8", prompt],
      { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true }
    );
    const start = Date.now();
    // 超时保护：单任务 5 分钟硬顶
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 可能已退出
      }
    }, timeoutMs);
    // 结束（正常/异常/超时杀）后结算
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, seconds: Math.round((Date.now() - start) / 1000) });
    });
    // 启动失败（node 不存在等）
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, seconds: 0 });
      void e;
    });
  });
}

/** 主流程：任务 × 轮次 矩阵 */
async function main(): Promise<void> {
  // 打印评估参数
  console.log(`工作区 ${WS}`);
  console.log(`任务数 ${TASKS.length}，每任务 3 次`);
  console.log("");
  const results: RunResult[] = [];

  // 外层：任务
  for (const task of TASKS) {
    // 每次任务开始前重置工作区（edit/create 类任务会改状态，保证 3 次运行同一起点）
    resetWorkspace();
    // 内层：3 次运行
    for (let run = 1; run <= 3; run++) {
      // 执行（输出直显终端；判分数据从会话文件取；任务可带专属 env 开关）
      const { exitCode, seconds } = await runOnce(task.prompt, 300_000, task.env);
      // 读取本次运行的会话摘要（最新一个 JSONL）
      const digest = readLatestSession();
      // 逐个校验器判定
      const failed: string[] = [];
      for (const c of task.checks) {
        let ok = false;
        try {
          // 校验器异常视为失败（记录名字）
          ok = c.ok(WS, digest);
        } catch {
          ok = false;
        }
        if (!ok) {
          failed.push(c.name);
        }
      }
      // 汇总本次结果
      const pass = failed.length === 0 && exitCode === 0;
      results.push({ taskId: task.id, run, pass, failedChecks: failed, seconds, exitCode });
      // 单行实时进度
      const mark = pass ? "PASS" : "FAIL";
      const detail = failed.length > 0 ? ` 未过: ${failed.join(" | ")}` : "";
      console.log(`[${mark}] ${task.id} #${run} ${seconds}s exit=${exitCode}${detail}`);
      // FAIL 时打印摘要要点便于排查
      if (!pass) {
        // 工具事件一览（名字 + ok + 结果前 60 字符）
        const tools = digest.toolEvents
          .map((t) => `  | ${t.name} ok=${t.ok} :: ${t.content.replace(/\n/g, "⏎").slice(0, 60)}`)
          .join("\n");
        // 正文尾部
        const tail = digest.assistantText.trim().split("\n").slice(-6).join("\n");
        console.log(`  | 事件数=${digest.eventCount} done=${digest.finishedDone}\n${tools}\n  | 正文尾部:\n${tail.split("\n").map((l) => "  | " + l).join("\n")}`);
      }
    }
  }

  // ── 汇总表 ──
  console.log("\n── 汇总 ──");
  // 按任务聚合
  for (const task of TASKS) {
    const rs = results.filter((r) => r.taskId === task.id);
    const passed = rs.filter((r) => r.pass).length;
    const total = rs.length;
    const avg = Math.round(rs.reduce((s, r) => s + r.seconds, 0) / Math.max(1, total));
    console.log(`${task.id.padEnd(8)} ${passed}/${total} 通过 · 平均 ${avg}s`);
  }
  // 总计
  const totalPass = results.filter((r) => r.pass).length;
  console.log(`总计     ${totalPass}/${results.length} 通过`);

  // 落盘结果（供后续对比模型/配置变化）
  fs.writeFileSync(
    path.join(EVAL_DIR, "results.json"),
    JSON.stringify({ at: new Date().toISOString(), totalPass, total: results.length, results }, null, 2),
    "utf8"
  );
  console.log(`结果已写入 ${path.join(EVAL_DIR, "results.json")}`);
  // 非全过 → 非零退出码（脚本化场景可判定）
  if (totalPass < results.length) {
    process.exitCode = 1;
  }
}

// 启动
main().catch((e) => {
  // 顶层异常：打印并退出 1
  console.error(`eval 运行失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
