// registry.ts 的离线单测：内置工具集、OpenAI 转换、最小 Schema 校验器全分支。
import { test } from "./harness.ts";
import { validateArgs, toOpenAITools, findTool, BUILTIN_TOOLS } from "../src/tools/registry.ts";
import type { ParamSchema } from "../src/tools/registry.ts";

/** 覆盖校验器全部关键字的测试 schema */
const schema: ParamSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "文件路径" },
    limit: { type: "integer" },
    ratio: { type: "number" },
    flag: { type: "boolean" },
    mode: { type: "string", enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["path"],
};

test("validateArgs：合法参数通过（空错误列表）", (t) => {
  const errs = validateArgs(schema, { path: "a.txt", limit: 10, ratio: 0.5, flag: true, mode: "a", tags: ["x"] });
  t.eq(errs, []);
});

test("validateArgs：缺必填参数被报告", (t) => {
  const errs = validateArgs(schema, { limit: 1 });
  t.assert(errs.some((e) => e.includes("path")), `应报告缺少 path，实际：${errs.join("; ")}`);
});

test("validateArgs：string 字段传数字被报告", (t) => {
  const errs = validateArgs(schema, { path: 123 });
  t.assert(errs.some((e) => e.includes("string")), `应报告类型错误，实际：${errs.join("; ")}`);
});

test("validateArgs：number/integer 字段传字符串被报告", (t) => {
  const errs = validateArgs(schema, { path: "a", limit: "abc" });
  t.assert(errs.some((e) => e.includes("integer")));
  const errs2 = validateArgs(schema, { path: "a", ratio: "abc" });
  t.assert(errs2.some((e) => e.includes("number")));
});

test("validateArgs：integer 字段拒绝非整数", (t) => {
  const errs = validateArgs(schema, { path: "a", limit: 1.5 });
  t.assert(errs.some((e) => e.includes("整数")), `实际：${errs.join("; ")}`);
});

test("validateArgs：枚举越界列出允许值", (t) => {
  const errs = validateArgs(schema, { path: "a", mode: "z" });
  t.assert(errs.some((e) => e.includes("a, b")), `实际：${errs.join("; ")}`);
});

test("validateArgs：boolean 字段类型检查", (t) => {
  const errs = validateArgs(schema, { path: "a", flag: "true" });
  t.assert(errs.some((e) => e.includes("boolean")));
});

test("validateArgs：array 元素类型检查（只报第一个坏元素）", (t) => {
  const errs = validateArgs(schema, { path: "a", tags: ["x", 1, 2] });
  t.assert(errs.some((e) => e.includes("元素 1")), `实际：${errs.join("; ")}`);
  t.eq(errs.filter((e) => e.includes("tags")).length, 1, "应只报一个元素错误");
});

test("validateArgs：array 字段传非数组被报告", (t) => {
  const errs = validateArgs(schema, { path: "a", tags: "x" });
  t.assert(errs.some((e) => e.includes("数组")));
});

test("validateArgs：参数必须是对象（null/数组/字符串都拒绝）", (t) => {
  t.assert(validateArgs(schema, null).length > 0, "null 应被拒绝");
  t.assert(validateArgs(schema, ["a"]).length > 0, "数组应被拒绝");
  t.assert(validateArgs(schema, "str").length > 0, "字符串应被拒绝");
});

test("validateArgs：未声明的多余参数不报错（宽容策略）", (t) => {
  const errs = validateArgs(schema, { path: "a", unknownField: 1 });
  t.eq(errs, []);
});

test("BUILTIN_TOOLS：六件套齐备且名字稳定", (t) => {
  t.eq(BUILTIN_TOOLS.length, 6);
  const names = BUILTIN_TOOLS.map((x) => x.name).sort();
  t.eq(names, ["bash", "edit", "grep", "ls", "read", "write"]);
  // 每个工具的描述与 schema 必须完整（ACI：描述即契约，空描述=契约缺失）
  for (const tool of BUILTIN_TOOLS) {
    t.assert(tool.description.length > 10, `${tool.name} 描述过短`);
    t.assert(tool.parameters.type === "object");
    t.assert(Object.keys(tool.parameters.properties).length > 0, `${tool.name} 应有参数`);
  }
});

test("toOpenAITools：输出 OpenAI function 工具格式", (t) => {
  const oai = toOpenAITools(BUILTIN_TOOLS) as { type: string; function: { name: string; description: string; parameters: unknown } }[];
  t.eq(oai.length, 6);
  for (const x of oai) {
    t.eq(x.type, "function");
    t.assert(typeof x.function.name === "string" && x.function.name.length > 0);
    t.assert(typeof x.function.description === "string");
    t.assert(x.function.parameters !== undefined);
  }
});

test("findTool：精确匹配与大小写不敏感", (t) => {
  t.assert(findTool("read") !== undefined);
  t.assert(findTool("READ") !== undefined, "应大小写不敏感");
  t.assert(findTool("no-such-tool") === undefined);
});

// ── 契约：findTool(name, tools) 必须在"传入的工具列表"里找（loop 修复验收）──
// 背景：loop.ts 发给模型的是 opts.tools，执行期查找必须同源，
// 否则自定义工具（delegate/tools-ext）会被误判为"未知工具"。
test("findTool(name, tools)：在显式列表里解析自定义工具", (t) => {
  const custom = [
    {
      name: "custom_echo",
      description: "测试用自定义工具",
      parameters: { type: "object" as const, properties: { msg: { type: "string" as const } } },
      execute: async () => ({ ok: true, text: "ok", durationMs: 0 }),
    },
  ];
  const found = findTool("custom_echo", custom);
  t.assert(found !== undefined, "显式列表里的自定义工具应能解析");
  t.eq(found!.name, "custom_echo");
});

test("findTool(name, tools)：显式列表内大小写不敏感", (t) => {
  const custom = [
    {
      name: "custom_echo",
      description: "测试用自定义工具",
      parameters: { type: "object" as const, properties: {} },
      execute: async () => ({ ok: true, text: "ok", durationMs: 0 }),
    },
  ];
  t.assert(findTool("CUSTOM_ECHO", custom) !== undefined, "显式列表内也应大小写不敏感");
});

test("findTool(name, tools)：不在显式列表里 → undefined（即使内置有同名也不越界）", (t) => {
  const custom = [
    {
      name: "custom_only",
      description: "测试用自定义工具",
      parameters: { type: "object" as const, properties: {} },
      execute: async () => ({ ok: true, text: "ok", durationMs: 0 }),
    },
  ];
  t.assert(findTool("custom_only", custom) !== undefined);
  // 内置工具不在显式列表中 → 查不到（查找范围=会话实际提供的集合）
  t.assert(findTool("read", custom) === undefined, "查找不得越界到内置全集");
  // 不存在的名字 → undefined
  t.assert(findTool("no-such-tool", custom) === undefined);
});

test("findTool(name)：不传列表时回退内置全集（向后兼容）", (t) => {
  t.assert(findTool("bash") !== undefined, "不传列表应回退 BUILTIN_TOOLS");
  t.assert(findTool("write") !== undefined);
});
