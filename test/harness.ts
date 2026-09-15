// 零依赖微型测试框架：test 注册 + assert 族 + 顺序执行器。
// 用法：
//   import { test } from "./harness.ts";
//   test("名称", (t) => { t.assert(x > 0); t.eq(a, b); });
// 设计取舍：不引入任何测试库（零依赖承诺的一部分）；
//   - 顺序执行（测试间无共享状态假设，简单可控）；
//   - 失败信息带测试名，便于定位；
//   - async 一等公民（大多数被测函数是 async）。

/** 每个测试拿到的断言上下文 */
export interface T {
  /** 断言条件为真（falsy 即失败） */
  assert: (cond: unknown, msg?: string) => void;
  /** 断言两值 JSON 相等（对象/数组友好） */
  eq: (actual: unknown, expected: unknown, msg?: string) => void;
  /** 断言同步函数抛出，可选匹配错误信息 */
  throws: (fn: () => void, match?: RegExp | string, msg?: string) => void;
  /** 断言 Promise 被拒绝，可选匹配错误信息 */
  rejects: (p: Promise<unknown>, match?: RegExp | string, msg?: string) => Promise<void>;
}

interface TestCase {
  name: string;
  fn: (t: T) => void | Promise<void>;
}

const cases: TestCase[] = [];

/** 注册一个测试用例（按注册顺序执行） */
export function test(name: string, fn: (t: T) => void | Promise<void>): void {
  cases.push({ name, fn });
}

/** 当前注册的用例数（runner 报告用） */
export function caseCount(): number {
  return cases.length;
}

/** 把值格式化为失败信息片段（长串截断，避免刷屏） */
function show(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? JSON.stringify(v) : String(v);
  } catch {
    s = Object.prototype.toString.call(v);
  }
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

/** 构造绑定测试名的断言集（失败时自动带上测试名） */
function makeT(name: string): T {
  const fail = (msg: string): never => {
    throw new Error(`[${name}] ${msg}`);
  };
  return {
    assert: (cond, msg) => {
      if (!cond) fail(msg ?? "断言失败（条件为假）");
    },
    eq: (actual, expected, msg) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(`${msg ?? "相等断言"}：实际=${show(actual)} 期望=${show(expected)}`);
      }
    },
    throws: (fn, match, msg) => {
      let threw = false;
      try {
        fn();
      } catch (e) {
        threw = true;
        const text = e instanceof Error ? e.message : String(e);
        if (match !== undefined && !(match instanceof RegExp ? match.test(text) : text.includes(match))) {
          fail(`${msg ?? "throws 断言"}：抛出的信息 "${text}" 不匹配 ${String(match)}`);
        }
        return;
      }
      if (threw) return;
      fail(msg ?? "期望抛出异常，但函数正常返回");
    },
    rejects: async (p, match, msg) => {
      let threw = false;
      try {
        await p;
      } catch (e) {
        threw = true;
        const text = e instanceof Error ? e.message : String(e);
        if (match !== undefined && !(match instanceof RegExp ? match.test(text) : text.includes(match))) {
          fail(`${msg ?? "rejects 断言"}：拒绝信息 "${text}" 不匹配 ${String(match)}`);
        }
        return;
      }
      if (threw) return;
      fail(msg ?? "期望 Promise 被拒绝，但它正常 resolve 了");
    },
  };
}

/** 运行全部已注册用例；打印逐条结果与汇总；返回统计 */
export async function runAll(): Promise<{ passed: number; failed: number; failures: string[] }> {
  const failures: string[] = [];
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const t = makeT(c.name);
    try {
      await c.fn(t);
      passed++;
      console.log(`  ok   ${c.name}`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(msg);
      console.log(`  FAIL ${msg}`);
    }
  }
  console.log(`\n${passed} 通过 / ${failed} 失败（共 ${cases.length} 例）`);
  return { passed, failed, failures };
}
