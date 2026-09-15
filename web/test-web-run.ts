// Web 服务冒烟：POST /api/run 消费 SSE 流，校验事件序列与终态。
const BASE = "http://127.0.0.1:18090";

// 发起运行
const res = await fetch(BASE + "/api/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    task: "只回复一个词：web-ok。不要调用任何工具。",
    workspace: "D:\\AI\\dsh\\Projects\\ceshi4\\clinkai-eval\\ws1",
  }),
});
// 非 200 直接报
if (!res.ok || !res.body) {
  console.error("FAIL HTTP", res.status, await res.text());
  process.exit(1);
}
// 读 SSE 流
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const seen = new Set();
let doneEvt = null;
while (true) {
  const r = await reader.read();
  if (r.done) break;
  buf += dec.decode(r.value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    for (const line of block.split("\n")) {
      const l = line.trim();
      if (l.startsWith("data: ")) {
        const evt = JSON.parse(l.slice(6));
        seen.add(evt.t);
        // 摘要打印（长文本截断）
        const preview = evt.text ? evt.text.slice(0, 60).replace(/\n/g, " ") : "";
        console.log(`[${evt.t}]`, preview || Object.keys(evt).filter((k) => k !== "t").join(","));
        if (evt.t === "done") {
          doneEvt = evt;
        }
      }
    }
  }
}
// 校验：必须有 start 与 done
if (!seen.has("start") || !seen.has("done")) {
  console.error("FAIL 缺少事件", [...seen].join(","));
  process.exit(1);
}
// 校验：done 状态
if (doneEvt.status !== "done") {
  console.error("FAIL done 状态", doneEvt.status, doneEvt.reason);
  process.exit(1);
}
// 校验：会话文件真的落盘（服务端视角）
const sess = await (await fetch(BASE + "/api/sessions")).json();
const hit = sess.sessions.some((s) => s.file === doneEvt.sessionFile);
if (!hit) {
  console.error("FAIL 会话未出现在列表", doneEvt.sessionFile);
  process.exit(1);
}
// 校验：单会话事件接口
const ev = await (await fetch(BASE + "/api/sessions/" + encodeURIComponent(doneEvt.sessionFile))).json();
if (!ev.events || ev.events.length === 0) {
  console.error("FAIL 会话事件为空");
  process.exit(1);
}
console.log("PASS web SSE 冒烟（事件 " + [...seen].join(",") + " · 会话 " + ev.events.length + " 条事件）");
