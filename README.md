# ClinkAI —— 基于本机 + 本地 Llama 的最小可运行 Agent Harness

一个**零运行时依赖**（只用 Node.js 内置模块）的本地 agent harness：
把 `qwen3.8-27b-local`（llama.cpp，`http://127.0.0.1:18080/v1`）变成一个带工具、带权限门、带上下文管理、带会话持久化的最小 agent。

设计依据：《深入理解 AI Agent》（PDF）中的 agent 循环、静态前缀/KV-cache、五层上下文压缩、
失败三层熔断、ACI 工具设计等原则，逐条落地为可运行代码。

```
ClinkAI/
├── bin/clinkai.ts     CLI 入口：参数解析 + 终端渲染（思考折叠/工具卡片/用量）
├── web/
│   ├── server.ts          Web 服务（零依赖 http）：会话列表/回放 + SSE 运行流
│   ├── index.html         单页应用：深色聊天界面（会话侧栏/思考折叠/工具卡片/流式正文）
│   └── test-web-run.ts    Web 端 SSE 冒烟测试
├── src/
│   ├── types.ts           共享类型（消息/工具/用量/循环状态）
│   ├── config.ts          配置：默认值 + CLINKAI_* 环境变量覆盖
│   ├── model-client.ts    OpenAI 兼容流式客户端（SSE、reasoning、工具调用聚合、重试）
│   ├── session.ts         JSONL 追加式会话（init/user/assistant/tool/meta 事件流）
│   ├── policy.ts          权限门：路径围栏 + bash 白名单 + y/n/a 确认（非 TTY 自动拒绝）
│   ├── compress.ts        截断（中间省略）+ 归档摘要（模型压缩最旧轨迹，只试一次）
│   ├── prompt.ts          冻结系统前缀（模板 + 工作区 AGENTS.md）+ 状态栏
│   ├── loop.ts            agent 循环：轮次/续写/失败与重复指纹熔断/归档触发
│   ├── renderer-web.ts    Web 渲染器：同一套循环事件 → JSON 事件（SSE 发射）
│   ├── ansi.ts            零依赖终端颜色（非 TTY 自动关闭）
│   └── tools/             6 个内置工具（ACI 描述）
│       ├── registry.ts    工具注册表 + 参数 Schema 校验（中文错误信息）
│       ├── common.ts      工作区围栏 / 输出裁剪 / 计时包装
│       └── read|write|edit|ls|grep|bash.ts
├── prompts/system.md      系统提示模板（{{workspace}} 占位 + 六条工作纪律）
├── eval/run-eval.ts       评估器：5 任务 ×3 次，客观校验器判分，结果落 results.json
└── eval/ws/               评估用干净工作区（每次任务前自动重建）
```

## 快速开始

要求：Node.js ≥ 23.6（本环境为 v26.5.1，原生直接运行 `.ts`，无需编译）。

```powershell
# 1) 自检：列出模型 + 一次最小补全
node bin/clinkai.ts doctor

# 2) 跑一个任务（--workspace 指定 agent 的工作目录围栏）
node bin/clinkai.ts --workspace "D:\some\project" `
  "在这个项目里新建 notes/hello.md，内容 Hello，然后读回确认"

# 3) 继续上一个会话
node bin/clinkai.ts --workspace "D:\some\project" --resume auto "接着上一步…"

# 4) Web 界面（浏览器里用，DeepSeek 式深色聊天 + 会话侧栏）
node web/server.ts        # 打开 http://127.0.0.1:18090
#    端口可用 CLINKAI_WEB_PORT=9000 改；页面顶栏可改工作区
#    注意：Web 非 TTY，非白名单 bash / 工作区外路径自动拒绝（fail-safe）

# 5) 运行评估（5 任务 × 3 次）
node eval/run-eval.ts
```

## 核心设计（对应书中原则）

### 1. 静态前缀 + KV-cache（§2.4 缓存与静态前缀）
- 系统提示（模板 + 工作区 `AGENTS.md`）在会话内**只构建一次并冻结**，
  之后每轮消息只追加，前缀逐字节不变 → llama.cpp 的 prompt cache 全部命中。
- 状态栏（轮次/上下文%/git 分支/cwd）**发送时临时追加在轨迹末尾、不落盘**，
  不破坏前缀（PDF §2.6 的做法）。
- 可观测：每轮打印 `缓存命中 xx%`（来自 `usage.prompt_tokens_details.cached_tokens`），
  实测首轮 70%+、后续 90%+，证明前缀冻结生效。

### 2. 上下文压缩（§2.5/2.6，五层取两层）
| 层 | 实现 | 说明 |
|---|---|---|
| 工具输出预算 | `toolOutLimit`（默认 8192 字符） | 大输出中间省略、头尾保留、带标记 |
| 归档摘要 | `ctxBudget`（默认 90k tokens）超预算触发 | 模型把最旧轨迹压成一条摘要；**只试一次**，失败不重试（熔断），截断仍兜底 |
| （未实现）滑动窗口/重排/卸载 | — | 本地 128k 上下文 + 前两层足够，留作扩展位 |

上下文估算采用"上一次真实 prompt 计数 + 新增消息粗估"，比纯粗估准（实测纯粗估低估 2.7×）。

### 3. 失败熔断（§2.7.4）
- 轮次上限（默认 15）；
- 同一工具连续失败 3 次 → 停止并报告；
- **重复指纹**：同一 `工具名+参数` 连续 3 轮 → 停止并报告；
- `finish_reason=length` 自动续写，最多 2 次；
- 权限拒绝/参数校验失败**不计入**失败熔断（那是模型的合法反馈，应可重试修正）。

### 4. 权限门（fail-safe）
- 所有路径操作围栏在 `--workspace` 内（拒绝 `..` 逃逸）；
- bash 白名单：只放行只读命令（`ls/dir/echo/pwd/type`/`Get-*`/`git status` 等），
  复合命令（`|;&`）一律拒绝；
- 白名单外的命令走 **y/n/a 人工确认**；**非交互终端自动拒绝**（安全失败方向）；
- 拒绝文本回填给模型，要求它换思路而不是原样重试。

### 5. 会话（§3 持久化）
- 每次运行一个 JSONL 文件，事件流：`init / user / assistant / tool / meta`；
- `--resume <path>` 或 `--resume auto`（按 mtime 取最新）续跑；
- 会话文件是 append-only，崩溃不丢前文。

## 工具集（ACI：描述即契约）

| 工具 | 说明 |
|---|---|
| `read` | 读文本文件，行号+偏移/限长，二进制检测 |
| `write` | 覆盖/新建文件（自动建父目录） |
| `edit` | 精确替换（`old_string` 必须唯一，除非 `replace_all`） |
| `ls` | 单层目录 / `**` 递归 |
| `grep` | 正则搜索（文件内、行号、可限定 `*.ext`） |
| `bash` | PowerShell 白名单命令，超时 120s（上限 600s）。输出经临时文件捕获（不依赖管道 stdio，沙箱/策略环境可用）；shell 自动回退 `pwsh` → `powershell` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLINKAI_BASE_URL` | `http://127.0.0.1:18080/v1` | OpenAI 兼容端点 |
| `CLINKAI_API_KEY` | `local-3090` | 本地鉴权（形式上保留） |
| `CLINKAI_MODEL` | `qwen3.8-27b-local` | 模型名 |
| `CLINKAI_MAX_ROUNDS` | 15 | 轮次上限 |
| `CLINKAI_MAX_TOKENS` | 4096 | 单轮生成上限（思考常驻，勿调太小） |
| `CLINKAI_TEMPERATURE` | 0.3 | 温度 |
| `CLINKAI_CTX_BUDGET` | 90000 | 归档摘要触发线（tokens） |
| `CLINKAI_TOOL_OUT_LIMIT` | 8192 | 工具输出预算（字符） |
| `CLINKAI_SESSIONS` | `~/.clinkai/sessions` | 会话目录（受限环境建议指到项目内） |
| `CLINKAI_VERBOSE` | off | 展开思考全文（否则折叠 200 字符） |

## 评估（M3）

`eval/run-eval.ts`：5 个任务（问答 / 建文件 / 改函数 / 检索 / 白名单命令）× 3 次，
用**文件系统状态 + 会话事件流**两个客观信号判分（不采信模型自述），结果写 `eval/results.json`。

## 已知限制

- 模型思考常驻（`enable_thinking:false` 被 llama.cpp 忽略），每轮 max_tokens 需 ≥ 思考+正文；
- 非交互终端下人工确认一律自动拒绝（fail-safe 设计）——**Web 界面同样适用**（浏览器发起的请求非 TTY，非白名单 bash / 越界路径自动拒绝）；
- Web 界面为单页原生 JS（无框架无构建）；历史回放不显示思考内容（JSONL 未落盘 reasoning）；
- bash 仅白名单只读命令；写操作一律走 `write`/`edit`（工具与命令面分离是有意设计）；
- 单模型单端点；多模型路由/并行 agent 是后续扩展位。

## 里程碑状态

- [x] M0 骨架 + 流式问答 + doctor
- [x] M1 六工具 + 权限门 + 会话 + agent 循环（验收任务全过）
- [x] M2 静态前缀 + AGENTS.md + 状态栏 + 截断/归档 + 缓存 90%+
- [x] M3 渲染打磨 + eval 任务集 + 本文档
- [x] Web 界面（`web/`：会话侧栏 + SSE 流式聊天，与 CLI 共用同一 agent 内核）
