// 权限闸门：fail-safe 默认（PDF §1.2.2 约束功能 + codex 审批思想）。
// 规则：
//   1. 路径围栏——文件工具的路径必须落在工作区内，越界需逐次确认；
//   2. bash 白名单——只读命令（ls/dir/echo...）直接放行，其余必须确认；
//   3. 确认支持"记住"——按命令首词记忆到会话结束（不持久化，重启失效，保持最小）。
import readline from "node:readline";
import path from "node:path";

/** 确认回调：返回 y(一次) / n(拒绝) / a(记住) */
export type ConfirmChoice = "y" | "n" | "a";

/** 工具上下文：传给每个工具执行函数的环境 */
export interface ToolContext {
  /** 工作区根目录（路径围栏边界） */
  workspace: string;
  /** 权限闸门实例 */
  policy: PolicyGate;
  /** 单条工具输出的截断上限（字符） */
  toolOutLimit: number;
  /** 会话日志（工具可写 meta 事件，如截断通知） */
  log?: (evt: Record<string, unknown>) => void;
}

/**
 * 权限闸门。
 * 每个会话一个实例；"记住"集合只在内存里（进程结束即失效）。
 */
export class PolicyGate {
  /** 工作区根（已归一化） */
  private workspace: string;
  // 本会话内被"记住放行"的 bash 命令首词集合
  private alwaysAllowed = new Set<string>();
  // 本会话内被"记住放行"的工作区外路径集合
  private allowedPaths = new Set<string>();
  // 确认串行化队列：并行工具同时需要确认时，按到达顺序逐个提问，
  // 避免两个 readline 同时抢 stdin 造成提示错位（fail-safe：串行=可理解）
  private confirmTail: Promise<unknown> = Promise.resolve();

  /** @param workspace 工作区根目录 */
  constructor(workspace: string) {
    // 统一转绝对路径并归一化分隔符，避免相对路径比较的坑
    this.workspace = path.resolve(workspace);
  }

  /**
   * 授权一个工作区外的路径（工作区内路径无需授权，直接返回 true）。
   * @param abs 已归一化的绝对路径
   */
  async authorizePath(abs: string): Promise<boolean> {
    // 工作区内：默认放行（围栏内操作不需要打扰用户）
    const inside = abs === this.workspace || abs.startsWith(this.workspace + path.sep);
    if (inside) {
      return true;
    }
    // 已"记住"的外部路径：直接放行（a 选项的记忆效果）
    if (this.allowedPaths.has(abs)) {
      return true;
    }
    // 外部路径：逐次确认
    const choice = await this.confirm(
      `⚠ 工具要访问工作区之外的路径：\n  ${abs}\n允许吗？[y=一次 / n=拒绝 / a=本会话记住] `
    );
    // y 放行一次；a 放行并记忆；n 拒绝
    if (choice === "y") {
      return true;
    }
    if (choice === "a") {
      this.allowedPaths.add(abs);
      return true;
    }
    return false;
  }

  /** 授权一条 bash 命令：白名单直接放行，否则确认（a=按首词记住） */
  async authorizeBash(command: string): Promise<boolean> {
    // 白名单（只读单命令）免确认
    if (this.isBashWhitelisted(command)) {
      return true;
    }
    // 取命令首词作为记忆键（"记住"的粒度=命令族，如 python/node/rm）
    const first = (command.trim().split(/\s+/)[0] ?? command).toLowerCase();
    if (this.alwaysAllowed.has(first)) {
      return true;
    }
    const choice = await this.confirm(
      `⚠ 将执行 shell 命令（pwsh -NoProfile）：\n  ${command}\n允许吗？[y=一次 / n=拒绝 / a=本会话记住 ${first} ...] `
    );
    if (choice === "y") {
      return true;
    }
    if (choice === "a") {
      this.alwaysAllowed.add(first);
      return true;
    }
    return false;
  }

  /**
   * 把一个用户/模型给的路径解析为绝对路径，并判断是否在工作区内。
   * 不执行 IO，只做字符串级围栏检查（真实存在性由工具自己校验）。
   */
  resolvePath(p: string): { abs: string; outside: boolean } {
    // 相对路径相对工作区解析（模型习惯给相对路径）
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(this.workspace, p));
    // 判断是否在围栏内：等于工作区本身或以工作区+分隔符开头
    // 注意：不能只 startsWith(workspace)，否则 D:\ws2 会被 D:\ws 误判为内部
    const inside = abs === this.workspace || abs.startsWith(this.workspace + path.sep);
    return { abs, outside: !inside };
  }

  /** bash 命令是否在只读白名单内（可直接放行，无需确认） */
  isBashWhitelisted(command: string): boolean {
    const cmd = command.trim();
    // 复合命令（管道/分号/换行/&&）一律不进白名单：
    // 白名单只保护"单个只读命令"，组合命令可能藏副作用
    if (/[|;&\n\r]/.test(cmd)) {
      return false;
    }
    // 取首词（去掉引号）作为命令名
    const first = cmd.split(/\s+/)[0] ?? "";
    // 白名单：纯只读命令（大小写不敏感；pwsh 下 Get-* 与 cmdlet 混用都放行）
    const whitelist = new Set([
      "ls", "dir", "echo", "pwd", "type",
      "get-childitem", "get-location", "get-date", "get-content",
      "node", "python", "git", // node/python 需再限定子命令
    ]);
    const name = first.toLowerCase().replace(/^"|"$/g, "");
    if (!whitelist.has(name)) {
      return false;
    }
    // node/python/git 的白名单只覆盖无副作用子命令
    if (name === "node" || name === "python" || name === "py") {
      // 只允许 --version / -v / --help
      return /^(--version|-v|--help)$/.test(cmd.split(/\s+/).slice(1).join(" ") || "");
    }
    if (name === "git") {
      // 只允许查询类子命令；commit/push 等有副作用的一律需确认
      const sub = (cmd.split(/\s+/)[1] ?? "").toLowerCase();
      return ["status", "log", "diff", "branch", "show", "remote"].includes(sub);
    }
    // 其余白名单命令直接放行
    return true;
  }

  /**
   * 交互式确认（串行化版本）。
   * 所有确认请求排进同一队列：即使多个工具并行触发确认，也保证
   * 用户一次只看到一个提示，且回答不会张冠李戴。
   * @param question 展示给用户的完整说明（含命令/路径）
   * @returns y/n/a 三选一
   */
  confirm(question: string): Promise<ConfirmChoice> {
    // 非 TTY（管道/CI）时无交互能力：直接拒绝——默认保守（fail-safe）
    if (!process.stdin.isTTY) {
      return Promise.resolve("n");
    }
    // 挂到队列尾部：前一个确认结束后才轮到本次提问
    const run = this.confirmTail.then(() => this.askOnce(question));
    // 推进队列（吞掉结果，只保留顺序语义）
    this.confirmTail = run.catch(() => undefined);
    return run;
  }

  /** 实际执行一次 readline 问答（私有；由串行队列调度） */
  private askOnce(question: string): Promise<ConfirmChoice> {
    // 每次确认新建 rl 实例：串行调度保证同一时刻只有一个活实例
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    return new Promise((resolve) => {
      // 提问并等待一行输入
      rl.question(question, (answer) => {
        rl.close();
        // 归一化：首字母小写，取 y/n/a
        const a = answer.trim().toLowerCase();
        if (a === "y" || a === "yes") {
          resolve("y");
        } else if (a === "a" || a === "always") {
          resolve("a");
        } else {
          // 其余任何输入（包括空）都视为拒绝——默认安全
          resolve("n");
        }
      });
      // 进程退出时避免 readline 挂住事件循环
      rl.on("close", () => {
        // 无需处理：close 即表示本轮问答结束
      });
    });
  }
}
