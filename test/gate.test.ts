// 守护门（gate）：把"本地 + 隐私 + 零依赖"的差异化承诺变成可执行的检查。
// 这些检查是离线、确定性的，作为回归门长期有效。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./harness.ts";
import { loadConfig } from "../src/config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("零依赖门：package.json 无运行时依赖（dependencies 必须为空）", (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  t.assert(
    pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0,
    `dependencies 必须为空（零运行时依赖承诺），实际：${JSON.stringify(pkg.dependencies)}`
  );
  // devDependencies 允许存在（构建/测试用），这里只记录不限制
  void pkg.devDependencies;
});

test("零依赖门：src 与 bin 只使用 node: 内置模块（无第三方 import）", (t) => {
  const violations: string[] = [];
  const importRe = /(?:import\s[^'"]*from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
        continue;
      }
      if (!/\.(ts|mjs|js)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      for (const m of text.matchAll(importRe)) {
        const spec = m[1];
        // 允许的规格：node: 前缀、相对路径、.ts 本地模块
        const ok = spec.startsWith("node:") || spec.startsWith(".") || spec.endsWith(".ts") || spec === "process";
        if (!ok) violations.push(`${path.relative(ROOT, p)}: ${spec}`);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  walk(path.join(ROOT, "bin"));
  t.assert(violations.length === 0, `发现非内置模块引用：${violations.join("; ")}`);
});

test("隐私门：默认端点必须是回环地址（本地模型，不外发）", (t) => {
  // 清掉可能干扰的环境变量，测"出厂默认"
  const saved = process.env.CLINKAI_BASE_URL;
  delete process.env.CLINKAI_BASE_URL;
  try {
    const c = loadConfig({ workspace: "D:\\ws" });
    t.assert(
      /^(http|https):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/.test(c.baseUrl),
      `默认 baseUrl 应指向本机回环，实际：${c.baseUrl}`
    );
  } finally {
    if (saved === undefined) delete process.env.CLINKAI_BASE_URL;
    else process.env.CLINKAI_BASE_URL = saved;
  }
});

test("隐私门：src 中无直连网络原语（全部 HTTP 走唯一 fetch 客户端）", (t) => {
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(p, "utf8");
      const patterns: [RegExp, string][] = [
        [/from\s+["']node:net["']/, "node:net（直连套接字）"],
        [/from\s+["']node:dns["']/, "node:dns"],
        [/from\s+["']node:tls["']/, "node:tls"],
        [/\bhttps?\.request\s*\(/, "http(s).request（绕过统一客户端）"],
      ];
      for (const [re, label] of patterns) {
        if (re.test(text)) bad.push(`${path.relative(ROOT, p)}: ${label}`);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  t.assert(bad.length === 0, `发现直连网络原语：${bad.join("; ")}`);
});

test("隐私门：无遥测/上报类调用（src 中不得出现 analytics/telemetry 字样）", (t) => {
  const hits: string[] = [];
  const re = /\b(telemetry|analytics|tracking|beacon|phone[\s_-]?home)\b/i;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
        continue;
      }
      if (!/\.(ts|mjs|js)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      if (re.test(text)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "src"));
  t.assert(hits.length === 0, `发现疑似遥测代码：${hits.join("; ")}`);
});
