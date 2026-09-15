// 离线测试套件入口：不需要模型服务，不访问外网（只允许 127.0.0.1）。
// 用法：node test/run-tests.ts
// 说明：
//   - 每个测试模块 import 即注册用例（注册顺序=import 顺序）；
//   - 结束后统一清理临时目录与假服务器；
//   - 有失败 → 退出码 1（可接 CI）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAll } from "./harness.ts";

// ── 导入测试模块（顺序即执行顺序）──
import "./unit.config.ts";
import "./unit.compress.ts";
import "./unit.policy.ts";
import "./unit.registry.ts";
import "./unit.session.ts";
import "./unit.prompt.ts";
import "./unit.memory.ts";
import "./loop.test.ts";
import "./cap.delegate.ts";
import "./cap.goal.ts";
import "./cap.tools-ext.ts";
import "./gate.test.ts";
import { closeServer } from "./model-client.test.ts";

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");

async function main(): Promise<void> {
  console.log("═══ ClinkAI 离线测试套件 ═══\n");
  let failed = 0;
  try {
    const r = await runAll();
    failed = r.failed;
  } finally {
    // 清理：假服务器 + 临时目录（失败也清，避免残留占用）
    await closeServer().catch(() => undefined);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
  console.log(failed === 0 ? "\n✅ 全部通过" : `\n❌ ${failed} 个用例失败`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(`测试运行器异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
