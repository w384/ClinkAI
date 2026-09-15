# ClinkAI 设计文档（DESIGN）

> 差异化定位：**本地 + 隐私 + 零依赖**的最小可行 Agent Harness。
> 一句话：把"能可靠跑完一个编码任务"这件事做到最小闭环，其余能力按单元增量、默认关闭。
>
> 本文只描述**已存在且被测试锁定**的行为；未实现内容见 [NON-GOALS.md](./NON-GOALS.md)。

## 1. 技术底座

| 项 | 取值 | 约束 |
|---|---|---|
| 运行时 | Node.js ≥ 22（实测 26.5.1） | 原生执行 `.ts`（type stripping），无构建步骤 |
| 依赖 | **0 运行时依赖** | `package.json` `dependencies` 必须为空（`test/gate.test.ts` 守护） |
| 网络 | 仅 `fetch` 到用户配置的 OpenAI 兼容端点（默认回环） | `src` 无 `node:net/dns/tls`、无 `http.request`（gate 守护） |
| 语言 | TypeScript ESM，`.ts` 扩展名 import | 只用 `node:` 内置模块 + 相对路径（gate 守护） |
| 模型 | 本地 llama.cpp（默认 `http://127.0.0.1:18080/v1`） | 默认端点必须是回环（gate 守护） |

## 2. 核心循环（`src/loop.ts`）

一轮 = 一次模型调用（流式 SSE）+ 工具执行 + 观察值回填，直到模型给出无工具调用的收尾正文。

```
task ──► [round 1..N] ──► 模型（流式）
           │  工具调用 ──► 参数校验(validateArgs) ──► execute ──► 观察值回填(role:tool)
           │  纯正文 ──► 结束(done)
           └─ 熔断/上限 ──► 结构化结束报告(AgentReport)
```

**有界与熔断（fail-safe，默认值）**

| 机制 | 阈值 | 语义 |
|---|---|---|
| `maxRounds` | 15 | 全局模型轮数上限（`--max-rounds` 可调） |
| repeat breaker | 3 | 连续 3 次**相同工具+相同参数且成功** → `breaker-repeat`（模型在打转） |
| failure breaker | 3 | 连续 3 次工具失败/校验失败 → `breaker-failure` |
| length continuation | 2 | `finish_reason=length` 时自动续写，最多 2 次 |

结束状态（`AgentReport.status`）：`done` / `max-rounds` / `breaker-repeat` / `breaker-failure` / `error`。
**非 `done` 一律非零退出**（`bin/clinkai.ts`）——非零退出绝不被描述为成功。

## 3. 工具层（`src/tools/`）

- **内置六件套**：`read` `write` `edit` `ls` `grep` `bash`（取"通用工具集 ∩ 本机需求"的最小交集）。
- **ACI 纪律**：`description` 就是模型看到的接口文档——命名直观、参数带例子、边界写清楚，用设计消除错误。
- **参数校验**：`validateArgs`（`registry.ts`）只实现 JSON Schema 极小子集（`type/properties/required/enum/items`）；失败信息回填给模型自我纠正。
- **同源查找**：`findTool(name, tools)` 按**本次会话实际提供的工具列表**查找（默认内置全集）——模型看到的工具数组与执行期查找必须同源，否则自定义工具会被误判"未知工具"（`test/loop.test.ts` 锁定）。
- **输出预算**：工具输出超 `toolOutLimit`（默认 8192 字符）按头尾保留截断，中间打标记（`compress.ts#truncateMiddle`）。

## 4. 上下文压缩（`src/compress.ts`，取 PDF 五层的前两层）

1. **工具结果预算**：超阈值输出截断（头尾保留，全文进会话日志）。
2. **归档式摘要**：轨迹估算超 `ctxBudget` 时把最旧一批消息压成一条摘要（经模型），新消息优先保留。

明确不做：API 层微压缩、全量压缩、压缩熔断器（MVP 规模下归档一次即够）。

## 5. 会话与记忆

- **会话文件**：`~/.clinkai/sessions/*.jsonl`（或 `CLINKAI_SESSIONS`），append-only，`时间戳-随机` 命名。
  事件类型：`init` / `assistant` / `user` / `tool` / `meta`。`Session.replay` 容错回放（坏行跳过）。
- **分段语义**：续跑/继承**不重放**进新会话文件（新文件只记本轮新增）；完整故事 = 按序拼接各轮文件（`test/cap.goal.ts` 锁定）。
- **`--resume <file|auto>`**：回放指定/最近会话，注入为新会话的继承轨迹。
- **长期记忆**：工作区根 `MEMORY.md` 非空时注入系统提示词（8192 字符上限 + 截断标记；空文件不注入；`test/unit.memory.ts` 锁定）。写记忆只应在用户确认后提议（`prompts/system.md` 约定）。

## 6. 策略闸门（`src/policy.ts`）

- **工作区围栏**：工具路径解析后若越出工作区 → `authorizePath` 串行确认；**非交互终端（非 TTY）一律拒绝**（fail-safe）。
- **bash 白名单**：只允许 `powershell` / `cmd` / 其等价调用形式；非白名单在非交互下自动拒绝。
- **授权是观察值**：拒绝原因作为工具结果回填给模型，让模型换路径或向用户说明，而不是静默失败。

## 7. 能力单元（`src/capabilities/`，全部默认关闭、显式启用）

| 能力 | 启用方式 | 语义 | 契约测试 |
|---|---|---|---|
| **delegate 子代理** | `CLINKAI_DELEGATE=1` | 进程内子 agent（独立会话、`BUILTIN_TOOLS` 固定工具集、有界轮次默认 5、摘要回执；不并行、不嵌套） | `test/cap.delegate.ts`（5 例） |
| **goal 续跑** | `--goal <目标>` | 有界总轮次（默认 3、clamp 1-10）；仅 `max-rounds` 触发续跑（继承完整轨迹），`error/breaker-*` 硬停 + 结构化回执 | `test/cap.goal.ts`（5 例） |
| **tools-ext 扩展工具** | `CLINKAI_TOOLS_EXT=<本地 .mjs>` | 本地 ESM 模块声明扩展工具；注册期校验 + 运行期四道闸（参数校验→异常兜底→返回归一→输出预算）；不得遮蔽内置 | `test/cap.tools-ext.ts`（16 例） |
| **MEMORY.md 记忆** | 工作区存在非空 `MEMORY.md` | 注入冻结系统提示词（见 §5） | `test/unit.memory.ts`（8 例） |

## 8. 质量纪律（借鉴 Archify，已落到代码）

1. **判断与正确性分离**：模型做判断，harness 用确定性代码保证正确性（参数校验、预算、熔断、退出码）。
2. **验证门禁 + 原子交付**：每步"契约测试先写 → 实现 → 跑绿 → 下一步"；非零退出绝不描述为成功。
3. **结构化失败诊断**：稳定错误码（`EXT_INVALID_SPEC` / `EXT_NAME_COLLISION` / `EXT_MODULE_LOAD` / `EXT_MODULE_SHAPE`）+ 可行动提示。
4. **一切默认关闭、显式启用**：delegate/goal/tools-ext 全部 opt-in（env / CLI / 文件存在性）。
5. **显式非目标 + 薄集成**：每个能力文件头部写明非目标；MCP stdio 推迟为 `integrations/` opt-in 薄集成。

## 9. 测试与验收

- **离线套件**：`node test/run-tests.ts`（101 例，含 gate 不变量）——不联网、不需要模型服务。
- **eval**：`node eval/run-eval.ts`（固定任务 × 多次，客观校验器判分：文件系统状态 + 会话摘要）；非全过 → 非零退出。
- **CLI**：`--doctor` 自检（连通性 + 模型列表 + 最小调用）。

## 10. 目录结构

```
ClinkAI/
├── bin/clinkai.ts        # CLI 入口（参数/渲染/会话装配/能力开关）
├── src/
│   ├── loop.ts               # 核心循环（有界/熔断/回填/续写）
│   ├── model-client.ts       # 唯一网络出口（SSE 流式 + 重试 + ModelError 分类）
│   ├── prompt.ts             # 冻结系统提示词 + AGENTS.md/MEMORY.md 注入
│   ├── compress.ts           # 两层压缩（工具预算 + 归档摘要）
│   ├── policy.ts             # 工作区围栏 + bash 白名单（fail-safe）
│   ├── session.ts            # JSONL 会话（append-only/replay/latestIn）
│   ├── config.ts             # 配置解析（env 覆盖，回环默认）
│   ├── registry.ts (tools/)  # Tool 接口/内置六件/findTool/validateArgs
│   ├── tools/{read,write,edit,ls,grep,bash,common}.ts
│   ├── capabilities/         # delegate.ts / goal.ts / tools-ext.ts（默认关闭）
│   └── {types,ansi}.ts
├── test/                     # 离线契约测试（101 例）+ gate 不变量
├── eval/                     # 固定任务 eval（客观判分）
├── prompts/system.md         # 系统提示词模板（含 MEMORY.md 约定）
└── docs/                     # DESIGN / NON-GOALS / PRIVACY（本文）
```
