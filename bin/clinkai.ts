#!/usr/bin/env node
// ClinkAI CLI 入口：参数解析 + 终端渲染器 + 会话装配。
// 用法：
//   ClinkAI "任务描述..."
//   ClinkAI --resume auto "接着上次的任务继续"
//   ClinkAI --doctor
// 设计原则：零依赖、输出可管道（非 TTY 时自动关色）、错误信息可行动。
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { AgentOptions, Renderer } from "../src/loop.ts";
import { runAgent } from "../src/loop.ts";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { streamChat, listModels, ModelError } from "../src/model-client.ts";
import { Session } from "../src/session.ts";
import { PolicyGate, type SecurityMode } from "../src/policy.ts";
import { BUILTIN_TOOLS, type Tool } from "../src/tools/registry.ts";
import { delegateTool } from "../src/capabilities/delegate.ts";
import { runGoal, GOAL_DEFAULT_MAX_ROUNDS } from "../src/capabilities/goal.ts";
import { loadExtTools, extendTools, ExtToolError } from "../src/capabilities/tools-ext.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { dim, cyan, red, green, yellow } from "../src/ansi.ts";
import type { ChatMessage, LoopState, ToolCall, ToolResult, Usage } from "../src/types.ts";

// ─────────────────────────────── 参数解析 ───────────────────────────────

/** 解析后的命令行参数 */
interface CliArgs {
  /** 任务文本（非 flag 参数拼接） */
  task: string;
  /** resume：auto=最近会话；否则为具体文件路径 */
  resume?: string;
  /** goal 模式：目标文本（有界轮次自动续跑；显式启用） */
  goal?: string;
  /** goal 总轮次上限（默认 3，clamp 1-10；每轮内部上限仍由 maxRounds 控制） */
  goalRounds?: number;
  maxRounds?: number;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  workspace?: string;
  verbose?: boolean;
  security?: SecurityMode;
  doctor?: boolean;
  version?: boolean;
  help?: boolean;
}

/** 帮助文本（--help / 无参数时显示） */
const HELP = `ClinkAI — 最小可行 Agent Harness（本机 + 本地 llama.cpp）

用法：
  ClinkAI "任务描述" [选项]
  ClinkAI --resume auto "继续上次任务"
  ClinkAI --doctor

选项：
  --resume <file|auto>  恢复指定会话（auto=最近一个）
  --goal <目标>         目标模式：有界轮次自动续跑（默认 3 轮；每轮内部轮数上限仍由 --max-rounds 控制）
  --goal-rounds <n>     goal 总轮次上限（默认 3，clamp 1-10）
  --max-rounds <n>      全局轮数上限（默认 15）
  --model <id>          模型 id（默认 qwen3.8-27b-local）
  --base-url <url>      OpenAI 兼容端点（默认 http://127.0.0.1:18080/v1）
  --api-key <key>       Bearer 密钥
  --workspace <dir>     工作区根目录（默认当前目录；路径围栏边界）
  --security <mode>     三档安全：read-only | workspace-write(默认) | danger-full-access
  -v, --verbose         展开完整思考内容
  --doctor              自检：连通性 + 模型列表 + 一次最小调用
  --version             显示版本
  --help                显示本帮助

环境变量：CLINKAI_BASE_URL / CLINKAI_API_KEY / CLINKAI_MODEL /
          CLINKAI_MAX_ROUNDS / CLINKAI_CTX_BUDGET / CLINKAI_TOOL_OUT /
          CLINKAI_SECURITY_MODE
能力开关（默认全关，显式启用）：
          CLINKAI_DELEGATE=1        启用 delegate 子代理工具
          CLINKAI_TOOLS_EXT=<路径>  启用进程内扩展工具（本地 .mjs 模块）

会话文件：~/.clinkai/sessions/*.jsonl（append-only，可用 --resume 续跑）
`;

/**
 * 手动解析 argv（零依赖，不用 commander）。
 * 规则：以 "--" 开头的为 flag（部分带值）；其余按顺序拼成任务文本。
 */
function parseArgs(argv: string[]): CliArgs {
  // 结果累加器
  const out: CliArgs = { task: "" };
  // 任务片段（多个位置参数用空格拼接，支持不引号包裹的多词任务）
  const taskParts: string[] = [];
  // 需要值的 flag 集合
  const VALUE_FLAGS = new Set(["--resume", "--goal", "--goal-rounds", "--max-rounds", "--model", "--base-url", "--api-key", "--workspace", "--security"]);
  // 顺序扫描
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 分支 1：带值的 flag
    if (VALUE_FLAGS.has(a)) {
      // 取下一个参数作为值；缺失时报错（给可行动的提示）
      const v = argv[i + 1];
      if (v === undefined) {
        throw new CliError(`${a} 需要一个值。示例：${a} <值>`);
      }
      i++; // 消费值
      // 按 flag 分派
      if (a === "--resume") {
        out.resume = v;
      } else if (a === "--goal") {
        out.goal = v;
      } else if (a === "--goal-rounds") {
        // 总轮次必须是正整数（runGoal 内部还会 clamp 到 1-10）
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new CliError(`--goal-rounds 需要正整数，收到 "${v}"`);
        }
        out.goalRounds = n;
      } else if (a === "--max-rounds") {
        // 轮数必须是正整数
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new CliError(`--max-rounds 需要正整数，收到 "${v}"`);
        }
        out.maxRounds = n;
      } else if (a === "--model") {
        out.model = v;
      } else if (a === "--base-url") {
        out.baseUrl = v;
      } else if (a === "--api-key") {
        out.apiKey = v;
      } else if (a === "--security") {
        // 安全档位：只接受三个合法值（非法值给明确错误，不静默回退）
        if (v !== "read-only" && v !== "workspace-write" && v !== "danger-full-access") {
          throw new CliError(`--security 取值非法："${v}"（允许：read-only / workspace-write / danger-full-access）`);
        }
        out.security = v as SecurityMode;
      } else {
        // --workspace
        out.workspace = v;
      }
      continue;
    }
    // 分支 2：布尔 flag
    if (a === "-v" || a === "--verbose") {
      out.verbose = true;
      continue;
    }
    if (a === "--doctor") {
      out.doctor = true;
      continue;
    }
    if (a === "--version") {
      out.version = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    // 分支 3：未知 --flag：报错（防止静默吞掉拼写错误的选项）
    if (a.startsWith("--")) {
      throw new CliError(`未知选项 ${a}。使用 --help 查看可用选项。`);
    }
    // 分支 4：位置参数 → 任务文本
    taskParts.push(a);
  }
  // 拼接任务
  out.task = taskParts.join(" ").trim();
  return out;
}

/** CLI 参数错误（与模型错误区分，提示语不同） */
class CliError extends Error {}

// ─────────────────────────────── 渲染器 ───────────────────────────────

/**
 * 终端渲染器：实现 loop.ts 的 Renderer 接口。
 * 思考内容默认折叠（只留首 200 字符 + 计数），-v 展开全文——
 * 本地 27B 的思考又长又噪，默认折叠让正文可读（PDF §2.6 状态显式化的另一面：噪音隐式化）。
 */
class TerminalRenderer implements Renderer {
  /** 当前轮已输出的思考字符数 */
  private reasoningShown = 0;
  /** 当前轮思考全文缓冲（-v 模式下轮末补打剩余部分） */
  private reasoningBuf = "";
  /** verbose 开关 */
  private verbose: boolean;
  /** 上一行输出（正文/思考）是否以非换行字符结尾——下一行打印前先补换行，
   *  避免"用量行/卡片"贴在上文行尾的排版事故 */
  private needNL = false;

  /** @param verbose 是否展开完整思考 */
  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  /** 需要补换行时补一个（所有"成行"输出前的统一入口） */
  private flushNL(): void {
    // 有待补换行标记时输出换行并清标记
    if (this.needNL) {
      process.stdout.write("\n");
      this.needNL = false;
    }
  }

  /** 标记"刚输出的内容没有行尾换行" */
  private markNL(): void {
    this.needNL = true;
  }

  /** 新一轮开始：打印分隔头 */
  onRound(state: LoopState): void {
    // 先补换行（上一轮遗留的无换行输出）
    this.flushNL();
    // 轮次 + 估算上下文（状态栏的终端版）
    const pct = state.ctxBudget > 0 ? Math.round((state.estTokens / state.ctxBudget) * 100) : 0;
    process.stdout.write(`\n${cyan(`── 轮次 ${state.round}/${state.maxRounds} ──`)}`);
    // 估算上下文占用（前缀冻结后 prompt 应稳定在预算内）
    process.stdout.write(dim(`  估算上下文 ${state.estTokens} tokens（预算 ${pct}%）`));
    // git 分支（如取到）
    if (state.gitBranch) {
      process.stdout.write(dim(`  ${state.gitBranch}`));
    }
    process.stdout.write("\n");
    // 每轮重置思考折叠状态
    this.reasoningShown = 0;
    this.reasoningBuf = "";
  }

  /** 思考增量：默认只留首 200 字符（折叠），-v 全量输出 */
  onReasoning(text: string): void {
    // 全文入缓冲（-v 轮末补打）
    this.reasoningBuf += text;
    // verbose：实时全量
    if (this.verbose) {
      process.stdout.write(dim(text));
      this.reasoningShown = this.reasoningBuf.length;
      // 标记可能欠换行（思考内容通常不含行尾换行）
      this.markNL();
      return;
    }
    // 折叠模式：只输出前 200 字符
    if (this.reasoningShown < 200) {
      const remaining = 200 - this.reasoningShown;
      const chunk = text.slice(0, remaining);
      process.stdout.write(dim(chunk));
      this.reasoningShown += chunk.length;
      // 欠换行标记
      this.markNL();
    }
  }

  /** 正文增量：原样实时输出（用户最关心的内容） */
  onDelta(text: string): void {
    // 直接写 stdout（零缓冲，流式体验）
    process.stdout.write(text);
    // 正文以换行结尾时清标记，否则欠一个换行
    if (text.endsWith("\n")) {
      this.needNL = false;
    } else {
      this.markNL();
    }
  }

  /** 一轮结束：补换行 + 折叠提示 */
  onRoundEnd(): void {
    // 欠换行先补（正文/思考可能没以换行收尾）
    this.flushNL();
    // 思考折叠提示（非 verbose 且思考超长时）
    if (!this.verbose && this.reasoningBuf.length > 200) {
      process.stdout.write(dim(`  💭 思考 ${this.reasoningBuf.length} 字符已折叠（-v 展开）\n`));
    }
    // verbose 模式下补打剩余思考
    if (this.verbose && this.reasoningShown < this.reasoningBuf.length) {
      process.stdout.write(dim(this.reasoningBuf.slice(this.reasoningShown)) + "\n");
    }
  }

  /** 工具开始：打印调用头（参数摘要 120 字符） */
  onToolStart(call: ToolCall): void {
    // 先补换行
    this.flushNL();
    // 参数美化：尝试 JSON 格式化，失败就截断原文
    let argPreview = "";
    try {
      // 解析后重新 stringify（去转义，可读性更好）
      argPreview = JSON.stringify(JSON.parse(call.function.arguments || "{}"));
    } catch {
      // 非法 JSON：直接截断原文
      argPreview = call.function.arguments.slice(0, 120);
    }
    // 过长截断
    if (argPreview.length > 120) {
      argPreview = argPreview.slice(0, 120) + "…";
    }
    process.stdout.write(`  ${cyan("⚙ " + call.function.name)} ${dim(argPreview)}\n`);
  }

  /** 工具结果：单行卡片（成功绿勾 / 失败红叉 + 结果首行） */
  onToolResult(call: ToolCall, result: ToolResult): void {
    // 先补换行
    this.flushNL();
    // 取结果首行做摘要（多行输出的首行通常就是结论）
    const firstLine = result.text.split("\n").find((l) => l.trim().length > 0) ?? "";
    const summary = firstLine.slice(0, 160);
    // 成功/失败分色：成功暗色正文，失败红色正文
    const mark = result.ok ? green("✓") : red("✗");
    const body = result.ok ? dim(summary) : red(summary);
    process.stdout.write(`    ${mark} ${dim(result.durationMs + "ms")} ${body}\n`);
  }

  /** 用量统计：暗色一行（缓存命中是前缀冻结的可观测指标） */
  onUsage(usage: Usage): void {
    // 先补换行
    this.flushNL();
    // 缓存命中率：cached/prompt（前缀冻结生效时应 >90%）
    const hit = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0;
    process.stdout.write(dim(`  ↑${usage.promptTokens}(缓存${hit}%) ↓${usage.completionTokens} tokens\n`));
  }

  /** 系统级说明：黄色（归档/熔断/续写/失败） */
  onMeta(text: string): void {
    // 先补换行
    this.flushNL();
    process.stdout.write(`  ${yellow(text)}\n`);
  }
}

// ─────────────────────────────── 辅助 ───────────────────────────────

/** 取工作区 git 分支（状态栏用）；取不到返回空串（不阻塞） */
function getGitBranch(workspace: string): string {
  // 3s 短超时：git 不应卡住启动
  try {
    // execFileSync：同步、短命；stdio pipe 捕获 stdout
    const out = execFileSync("git", ["branch", "--show-current"], { cwd: workspace, timeout: 3000, stdio: "pipe" }).toString("utf8").trim();
    // 空分支（detached）返回 HEAD
    if (out.length === 0) {
      return "HEAD";
    }
    return out;
  } catch {
    // 非 git 仓库 / git 不存在：静默降级
    return "";
  }
}

/** --doctor：连通性 + 模型列表 + 一次最小调用 */
async function runDoctor(cfg: Config): Promise<void> {
  // 打印配置摘要（敏感项脱敏：key 只显示后 4 位）
  const keyMask = cfg.apiKey.length > 4 ? "****" + cfg.apiKey.slice(-4) : "(空)";
  console.log(`端点   ${cfg.baseUrl}`);
  console.log(`密钥   ${keyMask}`);
  console.log(`模型   ${cfg.model}`);
  console.log(`工作区 ${cfg.workspace}`);
  // 1) 模型列表（验证 key 与服务存活）
  console.log("\n[1/2] 获取模型列表…");
  let models: string[] = [];
  try {
    models = await listModels(cfg);
    // 成功：列出全部 id
    for (const m of models) {
      console.log(`  - ${m}${m === cfg.model ? "  ← 当前配置" : ""}`);
    }
  } catch (e) {
    // 失败：红色提示（常见原因：18080 没启动 / key 错）
    console.log(red(`  失败：${e instanceof Error ? e.message : String(e)}`));
    console.log(red("  请确认 llama.cpp 已启动（默认 http://127.0.0.1:18080），且密钥正确（无 key 会 401）。"));
    return; // 连不上就停止，不做第 2 步
  }
  // 配置里的模型不在列表里：警告（不致命，服务端可能按名加载）
  if (!models.includes(cfg.model)) {
    console.log(yellow(`  警告：配置模型 "${cfg.model}" 不在服务端列表中（仍会尝试调用）。`));
  }
  // 2) 一次最小调用（验证推理 + 流式）
  console.log("\n[2/2] 最小调用（Say OK）…");
  try {
    // 短文本、短超时；打印首 200 字符
    const result = await streamChat(
      { ...cfg, maxTokens: 128, temperature: 0 },
      [{ role: "user", content: "只回复两个字：OK" }],
      { handlers: { onDelta: () => undefined, onReasoning: () => undefined } }
    );
    // 成功：显示回复 + 用量（cached 提示前缀缓存状态）
    console.log(green(`  回复：${result.content.trim().slice(0, 200)}`));
    if (result.usage) {
      console.log(dim(`  用量：prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}`));
    }
    console.log(green("\n✓ 自检通过：端点、密钥、推理均正常。"));
  } catch (e) {
    // 推理失败
    console.log(red(`  失败：${e instanceof Error ? e.message : String(e)}`));
  }
}

// ─────────────────────────────── 主流程 ───────────────────────────────

/** 进程入口 */
async function main(): Promise<void> {
  // 参数解析（错误直接退出码 2）
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    // 参数错误：打印帮助提示
    console.error(red(`参数错误：${e instanceof Error ? e.message : String(e)}`));
    process.exit(2);
  }

  // 帮助 / 版本：即显即退
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    // 版本与 package.json 保持一致（单一来源：读包文件，避免硬编码漂移）
    console.log("ClinkAI 0.1.0");
    return;
  }

  // 组装配置
  const cfg = loadConfig({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    maxRounds: args.maxRounds,
    workspace: args.workspace ? path.resolve(args.workspace) : undefined,
    verbose: args.verbose,
    securityMode: args.security,
  });

  // doctor 分支：自检后退出
  if (args.doctor) {
    await runDoctor(cfg);
    return;
  }

  // 任务文本必须有（resume 模式也允许空任务=纯继续，但 MVP 要求给指令；goal 模式的目标走 --goal 参数）
  if (!args.goal && args.task.length === 0 && !args.resume) {
    // 无任务无 resume 无 goal：打印帮助
    process.stdout.write(HELP);
    process.exit(2);
  }
  // goal 模式：目标文本只允许来自 --goal（避免"位置任务被静默忽略"的歧义）
  if (args.goal && args.task.length > 0) {
    throw new CliError("--goal 模式下目标请用 --goal 参数提供，不要同时给位置任务文本。");
  }

  // ── 会话装配 ──
  // 会话目录取自配置（环境变量 CLINKAI_SESSIONS 可覆盖，默认用户主目录）
  const sessionsDir = cfg.sessionsDir;
  // resume 解析：auto → 最近文件；具体路径 → 原样
  let resumeFile: string | undefined;
  if (args.resume) {
    // auto：取目录下最新
    if (args.resume.toLowerCase() === "auto") {
      // 没有历史会话时报错（给可行动提示）
      resumeFile = Session.latestIn(sessionsDir) ?? undefined;
      if (!resumeFile) {
        console.error(red(`没有找到可恢复的会话（目录：${sessionsDir}）。`));
        process.exit(2);
      }
    } else {
      // 具体路径：转绝对路径
      resumeFile = path.resolve(args.resume);
    }
  }
  // 创建/复用会话（goal 模式无顶层会话：每轮自动建独立会话文件）
  const session = args.goal ? undefined : new Session(sessionsDir, resumeFile);

  // 策略闸门（工作区围栏 + 三档安全档位）
  const policy = new PolicyGate(cfg.workspace, cfg.securityMode);

  // 工具上下文：日志回调落到会话 meta 事件
  const ctx = {
    workspace: cfg.workspace,
    policy,
    toolOutLimit: cfg.toolOutLimit,
    log: (evt: Record<string, unknown>) => session?.append(evt),
  };

  // 继承历史（resume 时回放；新会话为空；goal 模式可注入第 1 轮）
  const inherited: ChatMessage[] = resumeFile ? Session.replay(resumeFile) : [];
  // 继承消息数提示
  if (inherited.length > 0 && session) {
    console.log(dim(`已恢复会话：${session.file}（${inherited.length} 条历史消息）`));
  }

  // 冻结系统提示词（静态前缀，整个会话不再变化）
  const system = buildSystemPrompt(cfg);

  // 渲染器
  const renderer = new TerminalRenderer(Boolean(cfg.verbose));

  // 任务文本：resume + 无任务 → 默认继续指令
  const task = args.task.length > 0 ? args.task : "请继续上次未完成的对话。";

  // 状态栏用的 git 分支
  const gitBranch = getGitBranch(cfg.workspace);

  // 工具集：内置六件套 +（显式启用时）delegate 子代理 +（显式启用时）扩展工具
  // CLINKAI_DELEGATE=1 启用 delegate（默认关闭、显式启用——能力单元的通用纪律）
  let tools: Tool[] =
    process.env.CLINKAI_DELEGATE === "1"
      ? [...BUILTIN_TOOLS, delegateTool(cfg)]
      : BUILTIN_TOOLS;
  // CLINKAI_TOOLS_EXT=<本地 .mjs 路径> 启用进程内扩展工具（默认关闭；
  // 加载失败 → 结构化诊断 + 退出码 2，不带病运行）
  const extPath = process.env.CLINKAI_TOOLS_EXT;
  if (extPath) {
    try {
      const ext = await loadExtTools(extPath, cfg.workspace);
      tools = extendTools(tools, ext);
      console.log(dim(`已加载 ${ext.length} 个扩展工具（${extPath}）`));
    } catch (e) {
      throw new CliError(e instanceof ExtToolError ? `[${e.code}] ${e.message}` : String(e));
    }
  }

  // ── goal 模式：有界轮次 + max-rounds 自动续跑（--goal 显式启用，默认关闭）──
  if (args.goal) {
    const goalBudget = args.goalRounds ?? GOAL_DEFAULT_MAX_ROUNDS;
    console.log(dim(`goal 模式 · 目标「${args.goal}」 · 总轮次上限 ${goalBudget}（每轮内部上限 ${cfg.maxRounds} 模型轮）`));
    const goal = await runGoal({
      objective: args.goal,
      cfg,
      ctx,
      tools,
      inherited,
      renderer,
      system,
      gitBranch,
      maxRounds: args.goalRounds,
    });
    // 逐轮回执（状态分色：done 绿、max-rounds 黄、硬停红）
    const goalStatusText: Record<string, string> = {
      done: "完成",
      "max-rounds": "轮数用尽",
      "breaker-repeat": "重复熔断",
      "breaker-failure": "失败熔断",
      error: "错误",
    };
    for (const r of goal.rounds) {
      const label = goalStatusText[r.status] ?? r.status;
      const color = r.status === "done" ? green : r.status === "max-rounds" ? yellow : red;
      console.log(color(`第 ${r.index} 轮：${label}`) + (r.reason ? dim(`（${r.reason}）`) : "") + dim(` · ${r.rounds} 个模型轮 · 会话文件 ${r.sessionFile}`));
    }
    if (goal.done) {
      console.log(green(`■ goal 完成（共 ${goal.rounds.length}/${goal.effectiveMaxRounds} 轮）`));
    } else {
      console.log(red(`■ goal 未完成（共 ${goal.rounds.length}/${goal.effectiveMaxRounds} 轮）——可回放各轮会话文件，调整目标后重试`));
      process.exitCode = 1;
    }
    return;
  }

  // goal 分支在上面已 return：普通模式下 session 必已创建（TS 无法跨函数调用推断
  // args.goal 的收窄，这里显式兜底——不可达，但杜绝 undefined 解引用）
  if (!session) {
    console.error(red("内部错误：会话未创建（非 goal 路径必然创建会话）。"));
    process.exit(1);
  }

  // 组装循环参数
  const opts: AgentOptions = {
    task,
    cfg,
    tools,
    ctx,
    record: (role, msg, extra) => session.recordMessage(role, msg, extra),
    meta: (note, extra) => session.append({ type: "meta", note, ...(extra ?? {}) }),
    inherited,
    renderer,
    system,
    gitBranch,
  };

  // 启动横幅（暗色一行，含端点与模型，便于排错）
  console.log(dim(`ClinkAI · ${cfg.baseUrl} · ${cfg.model} · 工作区 ${cfg.workspace}`));

  // 运行 agent 循环
  const report = await runAgent(opts);

  // ── 结束报告 ──
  // 状态分色：done 绿；breaker/error 红
  const statusText: Record<string, string> = {
    "done": "完成",
    "max-rounds": "达到轮数上限",
    "breaker-repeat": "重复熔断",
    "breaker-failure": "失败熔断",
    "error": "错误",
  };
  const statusLabel = statusText[report.status] ?? report.status;
  // 非 done 状态用红色，done 用绿色
  const color = report.status === "done" ? green : red;
  console.log(`\n${color(`■ ${statusLabel}`)}${report.reason ? dim(`（${report.reason}）`) : ""} · ${report.rounds} 轮 · prompt ${report.totalPromptTokens} / completion ${report.totalCompletionTokens} / 缓存命中 ${report.totalCachedTokens}`);
  // 会话文件：告诉用户怎么续
  console.log(dim(`会话文件 ${session.file}（下次可用 --resume ${session.file} 继续）`));
  // 非正常结束：退出码 1（脚本化场景可据此判断）
  if (report.status !== "done") {
    process.exitCode = 1;
  }
}

// 启动；顶层异常兜底（参数错误已在内部处理，这里是真正的意外错误）
main().catch((e) => {
  // 打印错误（保留 stack 便于本地调试）
  console.error(red(`未处理异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  // ModelError 给一行友好提示
  if (e instanceof ModelError) {
    console.error(dim("提示：--doctor 可运行完整自检。"));
  }
  process.exit(1);
});
