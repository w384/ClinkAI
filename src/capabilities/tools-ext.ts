// tools-ext 进程内扩展工具（能力单元）：让用户以本地 JS 模块的形式给 ClinkAI
// 加自定义工具，而不必改 harness 代码。
//
// 契约（test/cap.tools-ext.ts，契约先行）：
//   defineExtTool(spec): Tool
//     - 注册期校验：name（小写字母开头、≤64 字符）/ description 非空 / execute 为函数 /
//       params 为 { type:"object", properties } 极小 schema（required 必须引用已声明参数）
//     - 坏 spec → ExtToolError（稳定错误码 EXT_INVALID_SPEC）——注册期失败，不给运行期惊喜
//   运行期（返回的 Tool.execute 包装层）：
//     - 参数先过 validateArgs（与内置同一校验器）：失败 → ok=false，执行器零调用
//     - execute 抛异常 → ok=false 结构化回执（错误是观察值，不炸循环）
//     - 返回非 { ok:boolean, text:string } → ok=false 诊断（不静默当成功）
//     - 输出过 clipOutput：受 ctx.toolOutLimit 预算（与内置工具同一纪律）
//   extendTools(base, ext): Tool[]
//     - 扩展工具不得遮蔽既有工具（含内置）：名字冲突（大小写不敏感）→ EXT_NAME_COLLISION
//   loadExtTools(modulePath, workspace): Promise<Tool[]>
//     - 动态 import 本地 ESM 模块；导出形态：default 数组 或 命名 tools 数组
//     - 任一环节失败 → ExtToolError 稳定码：EXT_MODULE_LOAD / EXT_MODULE_SHAPE / EXT_INVALID_SPEC
//     - fail fast：模块内任一坏 spec 失败整个加载（不允许部分注册）
// 显式非目标：
//   - 不做 MCP/stdio（推迟：integrations/ 下 opt-in 薄集成，见 docs/NON-GOALS.md）
//   - 扩展工具不得引入网络调用（网络只留给模型端点——"本地+隐私"差异化底线；
//     进程内 JS 技术上可 fetch，但这是用户自己的代码、自己的机器，责任边界写在文档里）
//   - 工具间无共享状态（每个 execute 无状态调用）
// 启用方式：CLINKAI_TOOLS_EXT=<本地 .mjs 路径>（默认关闭、显式启用——Archify 纪律④）
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext } from "../policy.ts";
import type { ToolResult } from "../types.ts";
import { validateArgs, type ParamSchema, type Tool } from "../tools/registry.ts";
import { clipOutput } from "../tools/common.ts";

/** 扩展工具错误：稳定错误码（诊断可程序化处理——Archify 纪律③） */
export class ExtToolError extends Error {
  /** 稳定错误码：EXT_INVALID_SPEC | EXT_NAME_COLLISION | EXT_MODULE_LOAD | EXT_MODULE_SHAPE */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtToolError";
    this.code = code;
  }
}

/** 扩展工具声明（用户模块导出的 spec 单元） */
export interface ExtToolSpec {
  /** 工具名（小写字母开头；模型调用时使用的名字） */
  name: string;
  /** 接口文档（模型可见——ACI：做什么、参数例子、边界） */
  description: string;
  /** 参数 schema（registry 的极小子集：object/properties/required + 基础类型） */
  params: ParamSchema;
  /** 执行器；应返回 { ok: boolean; text: string }（非规范返回按失败处理） */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

/** 工具名合法形式（OpenAI function name 约定的子集） */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** params.properties 允许的属性类型（与 ParamSchema 定义对齐） */
const PROP_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);

/** 安全序列化（诊断用；失败时退化为类型名） */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v;
  }
}

/**
 * 把一个扩展工具声明变成一个受治理的 Tool：
 * 注册期校验 spec，运行期统一"参数校验 → 执行 → 返回归一 → 输出预算"四道闸。
 */
export function defineExtTool(spec: ExtToolSpec): Tool {
  if (typeof spec !== "object" || spec === null) {
    throw new ExtToolError("EXT_INVALID_SPEC", "扩展工具 spec 必须是一个对象");
  }
  // ── 注册期校验（fail fast）──
  if (typeof spec.name !== "string" || !NAME_RE.test(spec.name)) {
    throw new ExtToolError(
      "EXT_INVALID_SPEC",
      `扩展工具名字非法："${String(spec.name)}"（要求：小写字母开头，仅小写字母/数字/下划线，≤64 字符）`,
    );
  }
  if (typeof spec.description !== "string" || spec.description.trim().length === 0) {
    throw new ExtToolError("EXT_INVALID_SPEC", `扩展工具 "${spec.name}" 缺少 description（模型把它当接口文档看，必填）`);
  }
  if (typeof spec.execute !== "function") {
    throw new ExtToolError("EXT_INVALID_SPEC", `扩展工具 "${spec.name}" 缺少 execute 函数`);
  }
  const params = spec.params;
  if (
    typeof params !== "object" ||
    params === null ||
    params.type !== "object" ||
    typeof params.properties !== "object" ||
    params.properties === null
  ) {
    throw new ExtToolError("EXT_INVALID_SPEC", `扩展工具 "${spec.name}" 的 params 必须是 { type:"object", properties:{...} }`);
  }
  for (const [key, prop] of Object.entries(params.properties)) {
    const type = (prop as { type?: unknown })?.type;
    if (typeof prop !== "object" || prop === null || typeof type !== "string" || !PROP_TYPES.has(type)) {
      throw new ExtToolError("EXT_INVALID_SPEC", `扩展工具 "${spec.name}" 的参数 "${key}" 类型声明非法（允许：string/number/integer/boolean/array）`);
    }
  }
  if (
    params.required &&
    (!Array.isArray(params.required) ||
      params.required.some((k) => typeof k !== "string" || !(k in params.properties)))
  ) {
    throw new ExtToolError("EXT_INVALID_SPEC", `扩展工具 "${spec.name}" 的 required 必须是已声明参数名的数组`);
  }

  const execute = spec.execute;
  return {
    name: spec.name,
    description: spec.description,
    parameters: params,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const start = Date.now();
      // 闸 1：参数校验（与内置工具同一校验器；失败不进业务逻辑）
      const errors = validateArgs(params, args);
      if (errors.length > 0) {
        return { ok: false, text: `参数校验失败：${errors.join("；")}`, durationMs: Date.now() - start };
      }
      // 闸 2：执行 + 异常兜底（错误也是给模型看的观察值）
      let raw: unknown;
      try {
        raw = await execute(args, ctx);
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        return { ok: false, text: `扩展工具 "${spec.name}" 内部异常：${msg}`, durationMs: Date.now() - start };
      }
      // 闸 3：返回归一（非规范返回按失败处理——不静默当成功）
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { ok?: unknown }).ok !== "boolean" ||
        typeof (raw as { text?: unknown }).text !== "string"
      ) {
        return {
          ok: false,
          text: `扩展工具 "${spec.name}" 返回非规范（应返回 { ok: boolean, text: string }）：${safeStringify(raw)}`,
          durationMs: Date.now() - start,
        };
      }
      const r = raw as { ok: boolean; text: string };
      // 闸 4：输出预算（与内置工具同一截断纪律）
      return { ok: r.ok, text: clipOutput(ctx, r.text), durationMs: Date.now() - start };
    },
  };
}

/**
 * 组合工具集：base（如内置六件套 + delegate）+ 扩展工具。
 * 名字冲突（含大小写变体）在注册期拒绝——扩展工具不得遮蔽既有工具。
 */
export function extendTools(base: Tool[], ext: Tool[]): Tool[] {
  const seen = new Set(base.map((t) => t.name.toLowerCase()));
  for (const t of ext) {
    const k = t.name.toLowerCase();
    if (seen.has(k)) {
      throw new ExtToolError(
        "EXT_NAME_COLLISION",
        `扩展工具 "${t.name}" 与既有工具重名（扩展工具不得遮蔽内置工具或先注册的工具）；请改名`,
      );
    }
    seen.add(k);
  }
  return [...base, ...ext];
}

/**
 * 从本地 ESM 模块加载扩展工具。
 * 导出形态（二选一）：
 *   export default [spec, ...]
 *   export const tools = [spec, ...]
 * 任一环节失败 → ExtToolError（稳定码），不部分注册。
 */
export async function loadExtTools(modulePath: string, workspace: string): Promise<Tool[]> {
  if (typeof modulePath !== "string" || modulePath.trim().length === 0) {
    throw new ExtToolError("EXT_MODULE_LOAD", "扩展工具模块路径为空");
  }
  // 相对路径按工作区解析（与工具路径语义一致；绝对路径原样）
  const abs = path.isAbsolute(modulePath) ? path.resolve(modulePath) : path.resolve(workspace, modulePath);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ExtToolError("EXT_MODULE_LOAD", `无法加载扩展工具模块 ${abs}：${msg}`);
  }
  // 导出形态识别
  const m = mod as { default?: unknown; tools?: unknown };
  let specs: unknown[];
  if (Array.isArray(m?.default)) {
    // Array.isArray 已保证是数组，断言为未知元素数组（后续逐个校验）
    specs = m.default as unknown[];
  } else if (Array.isArray(m?.tools)) {
    // 同上
    specs = m.tools as unknown[];
  } else {
    throw new ExtToolError(
      "EXT_MODULE_SHAPE",
      `扩展工具模块 ${abs} 导出形态非法：应为 "export default [spec, ...]" 或 "export const tools = [spec, ...]"`,
    );
  }
  // 逐个定义（fail fast：一个坏 spec 失败整个加载）
  const tools: Tool[] = [];
  for (const s of specs) {
    tools.push(defineExtTool(s as ExtToolSpec));
  }
  return tools;
}
