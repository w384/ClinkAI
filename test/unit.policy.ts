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

// ── 三档安全开关（read-only < workspace-write(默认) < danger-full-access）──
// 说明：以下均为纯逻辑分支（不触发交互确认），在 TTY / 非 TTY 下都应给出确定结果，
//       故不依赖 process.stdin.isTTY，保证 CI 与本地行为一致。

test("安全档位：默认档为 workspace-write（向后兼容既有行为）", (t) => {
  t.eq(new PolicyGate(WS).mode, "workspace-write", "不传 mode 应默认 workspace-write");
  t.eq(new PolicyGate(WS, "read-only").mode, "read-only", "显式传 read-only 生效");
  t.eq(new PolicyGate(WS, "danger-full-access").mode, "danger-full-access", "显式传 danger-full-access 生效");
});

test("read-only：工作区内只读——写入拒绝、读取放行", async (t) => {
  const g = new PolicyGate(WS, "read-only");
  const inside = path.resolve(WS, "ok.txt");
  t.assert(!(await g.authorizePath(inside, "write")), "read-only 工作区内写入应拒绝");
  t.assert(await g.authorizePath(inside, "read"), "read-only 工作区内读取应放行");
});

test("read-only：工作区外无论读写一律拒绝（fail-safe）", async (t) => {
  const g = new PolicyGate(WS, "read-only");
  const outside = "D:\\elsewhere\\secret.txt";
  t.assert(!(await g.authorizePath(outside, "read")), "read-only 工作区外读取应拒绝");
  t.assert(!(await g.authorizePath(outside, "write")), "read-only 工作区外写入应拒绝");
});

test("read-only：bash 白名单放行、非白名单拒绝", async (t) => {
  const g = new PolicyGate(WS, "read-only");
  t.assert(await g.authorizeBash("echo ok"), "read-only 白名单只读命令应放行");
  t.assert(!(await g.authorizeBash("Remove-Item x")), "read-only 非白名单命令应拒绝");
  t.assert(!(await g.authorizeBash("git commit -m x")), "read-only git commit 应拒绝");
});

test("workspace-write：工作区内读写放行（默认档保持既有行为）", async (t) => {
  const g = new PolicyGate(WS, "workspace-write");
  const inside = path.resolve(WS, "ok.txt");
  t.assert(await g.authorizePath(inside, "write"), "workspace-write 工作区内写入应放行");
  t.assert(await g.authorizePath(inside, "read"), "workspace-write 工作区内读取应放行");
});

test("danger-full-access：工作区外读写与 bash 全放行（无需确认）", async (t) => {
  const g = new PolicyGate(WS, "danger-full-access");
  const outside = "D:\\elsewhere\\secret.txt";
  t.assert(await g.authorizePath(outside, "read"), "danger 工作区外读取应放行");
  t.assert(await g.authorizePath(outside, "write"), "danger 工作区外写入应放行");
  t.assert(await g.authorizeBash("Remove-Item x"), "danger 非白名单 bash 应放行");
  t.assert(await g.authorizeBash("echo ok"), "danger 白名单 bash 应放行");
});

test("档位单调性：同一路径/命令在三档下的放行集合递增", async (t) => {
  // 用一个"工作区外路径 + 非白名单命令"同时刻画三档差异
  const outside = "D:\\elsewhere\\secret.txt";
  const ro = new PolicyGate(WS, "read-only");
  const ww = new PolicyGate(WS, "workspace-write");
  const da = new PolicyGate(WS, "danger-full-access");
  // 工作区外读取：read-only 拒绝 / workspace-write 需确认（非 TTY 拒绝）/ danger 放行
  if (!process.stdin.isTTY) {
    t.assert(!(await ro.authorizePath(outside, "read")), "read-only 外部读拒绝");
    t.assert(!(await ww.authorizePath(outside, "read")), "workspace-write 外部读需确认（非 TTY 拒绝）");
    t.assert(await da.authorizePath(outside, "read"), "danger 外部读放行");
  }
  // 非白名单 bash：read-only 拒绝 / danger 放行（workspace-write 需确认，TTY/非 TTY 不确定，跳过）
  t.assert(!(await ro.authorizeBash("Remove-Item x")), "read-only 非白名单 bash 拒绝");
  t.assert(await da.authorizeBash("Remove-Item x"), "danger 非白名单 bash 放行");
});
