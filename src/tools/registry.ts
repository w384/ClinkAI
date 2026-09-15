// 工具注册表：Tool 接口、内置工具集合、OpenAI tools 数组转换、最小 JSON Schema 校验。
// ACI 原则（PDF §4.2）：工具的 description 就是模型看到的接口文档——
// 命名直观、参数带例子、边界写清楚，"用设计消除错误"。
import type { ToolResult } from "../types.ts";
import type { ToolContext } from "../policy.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { lsTool } from "./ls.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";

/** 参数 Schema（JSON Schema 的极小子集，校验器只实现这些关键字） */
export interface ParamSchema {
  type: "object";
  properties: Record<string, PropSchema>;
  required?: string[];
}

/** 单个属性 Schema */
export interface PropSchema {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  /** string 枚举 */
  enum?: string[];
  /** array 的元素类型（只支持 string 元素） */
  items?: { type: "string" };
}

/** 工具定义：描述（给模型看）+ 执行器（给 harness 跑） */
export interface Tool {
  /** 模型调用时使用的名字（必须与 description 里的动词一致，降低误用） */
  name: string;
  /** 接口文档：做什么、参数例子、边界与副作用（ACI） */
  description: string;
  /** 参数 JSON Schema（极小子集） */
  parameters: ParamSchema;
  /** 执行；必须返回 ToolResult 而不是抛异常——错误也是给模型看的观察值 */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 内置工具全集（最小六件套，取 pi 工具集 ∩ 本机需求） */
export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, lsTool, grepTool, bashTool];

/** 按名字查工具；找不到返回 undefined（调用方给模型一个可理解错误）
 *  第二个参数：本次会话实际提供的工具列表（默认内置全集）——
 *  必须与发给模型的 tools 数组同源，否则自定义工具（delegate/tools-ext）会被误判"未知工具" */
export function findTool(name: string, tools: Tool[] = BUILTIN_TOOLS): Tool | undefined {
  // 名字精确匹配；大小写不敏感兜底（模型偶尔会大写）
  return tools.find((t) => t.name === name || t.name.toLowerCase() === name.toLowerCase());
}

/** 转成 OpenAI tools 数组（发给模型的格式） */
export function toOpenAITools(tools: Tool[]): unknown[] {
  // 逐工具包装；description/parameters 原样透传
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ───────────────────────── 最小 JSON Schema 校验器 ─────────────────────────
// 只覆盖本注册表用到的关键字：type / properties / required / enum / items。
// 校验失败返回错误列表（拼进回填文本让模型自我纠正，PDF 纠正层）。

/** 校验参数对象；返回人类可读的错误描述列表（空数组=通过） */
export function validateArgs(schema: ParamSchema, args: unknown): string[] {
  const errors: string[] = [];
  // args 必须是一个普通对象（模型可能传 null/数组/字符串）
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [`参数必须是 JSON 对象，实际是 ${typeof args}`];
  }
  const obj = args as Record<string, unknown>;

  // required：缺参是最高频错误，单独检查并列出全部缺失项
  for (const key of schema.required ?? []) {
    if (!(key in obj) || obj[key] === undefined) {
      errors.push(`缺少必填参数 "${key}"`);
    }
  }

  // properties：逐个声明过的字段做类型检查
  for (const [key, prop] of Object.entries(schema.properties)) {
    // 未出现的可选参数跳过（required 已单独报告）
    if (!(key in obj) || obj[key] === undefined) {
      continue;
    }
    const v = obj[key];
    // 类型检查：JSON 类型名 → JS 判断
    if (prop.type === "string") {
      if (typeof v !== "string") {
        errors.push(`参数 "${key}" 应为 string，实际是 ${jsTypeName(v)}`);
      } else if (prop.enum && !prop.enum.includes(v)) {
        // 枚举越界：把允许值列出来，模型通常能一次改对
        errors.push(`参数 "${key}" 取值 "${v}" 不在允许范围 [${prop.enum.join(", ")}]`);
      }
    } else if (prop.type === "number" || prop.type === "integer") {
      // 数字检查；integer 额外要求整数
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`参数 "${key}" 应为 ${prop.type}，实际是 ${jsTypeName(v)}`);
      } else if (prop.type === "integer" && !Number.isInteger(v)) {
        errors.push(`参数 "${key}" 应为整数，实际是 ${v}`);
      }
    } else if (prop.type === "boolean") {
      if (typeof v !== "boolean") {
        errors.push(`参数 "${key}" 应为 boolean，实际是 ${jsTypeName(v)}`);
      }
    } else if (prop.type === "array") {
      if (!Array.isArray(v)) {
        errors.push(`参数 "${key}" 应为数组，实际是 ${jsTypeName(v)}`);
      } else if (prop.items?.type === "string") {
        // 元素类型检查：只报第一个坏元素（错误列表保持简短）
        const bad = v.findIndex((x) => typeof x !== "string");
        if (bad >= 0) {
          errors.push(`参数 "${key}" 的元素 ${bad} 应为 string，实际是 ${jsTypeName(v[bad])}`);
        }
      }
    }
  }
  return errors;
}

/** JS 值类型名（错误提示用） */
function jsTypeName(v: unknown): string {
  // null 单独判断（typeof null === "object" 的著名坑）
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "数组";
  }
  // 其余直接用 typeof
  return typeof v;
}
