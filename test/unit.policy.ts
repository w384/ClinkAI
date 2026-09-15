// policy.ts 的离线单测：路径围栏、bash 白名单、非交互 fail-safe（纯逻辑 + 非 TTY 行为）。
import path from "node:path";
import { test } from "./harness.ts";
import { PolicyGate } from "../src/policy.ts";

// 用不存在但合法的虚拟路径做围栏测试（resolvePath 是纯字符串级检查，不触发 IO）
const WS = "D:\\work\\app";

test("resolvePath：相对路径相对工作区解析且在围栏内", (t) => {
  const g = new PolicyGate(WS);
  const r = g.resolvePath("src/main.ts");
  t.eq(r.abs, path.resolve(WS, "src", "main.ts"));
  t.eq(r.outside, false);
});

test("resolvePath：绝对路径在围栏内", (t) => {
  const g = new PolicyGate(WS);
  t.eq(g.resolvePath("D:\\work\\app\\x.txt").outside, false);
});

test("resolvePath：工作区前缀不得误判（D:\\app2 vs D:\\app）", (t) => {
  const g = new PolicyGate("D:\\app");
  t.eq(g.resolvePath("D:\\app\\x").outside, false, "D:\\app\\x 在围栏内");
  t.eq(g.resolvePath("D:\\app2\\x").outside, true, "D:\\app2\\x 必须在围栏外（经典前缀陷阱）");
  t.eq(g.resolvePath("D:\\app").outside, false, "工作区本身视为内部");
});

test("isBashWhitelisted：只读单命令放行", (t) => {
  const g = new PolicyGate(WS);
  t.assert(g.isBashWhitelisted("echo hi"), "echo 应放行");
  t.assert(g.isBashWhitelisted("ls"), "ls 应放行");
  t.assert(g.isBashWhitelisted("Get-ChildItem -Name"), "Get-* 应放行（大小写不敏感）");
  t.assert(g.isBashWhitelisted("git status"), "git status 应放行");
  t.assert(g.isBashWhitelisted("git log --oneline -5"), "git log 应放行");
  t.assert(g.isBashWhitelisted("node --version"), "node --version 应放行");
  t.assert(g.isBashWhitelisted('echo "hello world"'), "带引号参数应放行");
});

test("isBashWhitelisted：复合命令与副作用命令拒绝", (t) => {
  const g = new PolicyGate(WS);
  t.assert(!g.isBashWhitelisted("echo hi | rm -rf /"), "管道复合命令应拒绝");
  t.assert(!g.isBashWhitelisted("echo a && echo b"), "&& 复合命令应拒绝");
  t.assert(!g.isBashWhitelisted("echo a; echo b"), "; 复合命令应拒绝");
  t.assert(!g.isBashWhitelisted("git commit -m x"), "git commit 应拒绝");
  t.assert(!g.isBashWhitelisted("git push"), "git push 应拒绝");
  t.assert(!g.isBashWhitelisted("node app.js"), "node 跑脚本应拒绝");
  t.assert(!g.isBashWhitelisted("rm -rf x"), "rm 应拒绝");
  t.assert(!g.isBashWhitelisted("python -c 'print(1)'"), "python -c 应拒绝");
  t.assert(!g.isBashWhitelisted("Get-Content x.txt | Out-File y.txt"), "PS 管道应拒绝");
});

test("authorizePath：工作区内直接放行（无需确认）", async (t) => {
  const g = new PolicyGate(WS);
  t.assert(await g.authorizePath(path.resolve(WS, "ok.txt")), "围栏内路径应直接放行");
});

test("authorizePath：非交互终端下工作区外路径自动拒绝（fail-safe）", async (t) => {
  // 交互终端上跳过（避免挂起等待输入）；CI/沙箱 stdin 非 TTY，走 fail-safe 分支
  if (process.stdin.isTTY) return;
  const g = new PolicyGate(WS);
  const denied = await g.authorizePath("D:\\elsewhere\\secret.txt");
  t.assert(!denied, "非 TTY 下外部路径必须拒绝（默认保守）");
});

test("authorizeBash：非白名单命令在非交互下自动拒绝（fail-safe）", async (t) => {
  if (process.stdin.isTTY) return;
  const g = new PolicyGate(WS);
  t.assert(await g.authorizeBash("echo ok"), "白名单命令应放行");
  t.assert(!(await g.authorizeBash("Remove-Item x")), "非白名单命令非 TTY 应拒绝");
});
