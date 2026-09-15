// bash 工具单元自测：直接调 execute（不经模型），验证 文件重定向捕获 + 退出码透传。
import { bashTool } from "../src/tools/bash.ts";
import { PolicyGate } from "../src/policy.ts";

// 构造工具上下文（policy 用真实类；非 TTY 下确认自动拒绝——所以只用白名单命令）
const policy = new PolicyGate("D:/AI/dsh/Projects/ceshi4/clinkai-eval/ws1");
const ctx = { workspace: "D:/AI/dsh/Projects/ceshi4/clinkai-eval/ws1", policy, toolOutLimit: 8192 };

// 用例 1：白名单 echo —— 期望 ok + 输出含 hello-bash-test
const r1 = await bashTool.execute({ command: "echo hello-bash-test" }, ctx);
console.log("用例1 ok:", r1.ok, "text:", r1.text.replace(/\n/g, "⏎"));
// 用例 2：白名单 Get-ChildItem —— 期望 ok + 列表
const r2 = await bashTool.execute({ command: "Get-ChildItem D:/AI/dsh/Projects/ceshi4/clinkai-eval/ws1 -Name" }, ctx);
console.log("用例2 ok:", r2.ok, "text:", r2.text.replace(/\n/g, "⏎").slice(0, 120));
// 用例 3：白名单但非零退出码 —— git status 在无仓库目录应非零
const r3 = await bashTool.execute({ command: "git status" }, ctx);
console.log("用例3 ok(期望false):", r3.ok, "text:", r3.text.replace(/\n/g, "⏎").slice(0, 120));
