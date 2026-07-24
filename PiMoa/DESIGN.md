# Pi-MoA 开发侧壳 · 设计方案 v0（基于真代码，非闭门造车）

> 目标：用 Pi 做一个**专职 MoA 的开发侧壳**，经 MCP 暴露 `moa_run` / `moa_verify` / `moa_deliver`，
> 让 Claude / codex / antigravity 做项目开发时**不再调用 Hermes**，同时拿到「每个模型的流可见 + 可单独 steer」的透明。
> 语言：**Pi 保持 Node/Bun 不重写**（决策已定：开发工具，非产品运行时，见对话）。
>
> 项目目录：`<PIMOA_ROOT>/`（所有内容在此）。
> 证据基线：`refs/pi`=earendil Pi 源码（codegraph 已建，958 文件/15531 节点/65150 边）；
> `refs/pi-mcp`=前门 fork 基座；`refs/taskflow`=备选框架。本文每条映射都指向真实文件/API。
>
> **模型接入（决策：换咱们自己的 + 配置文件驱动，徐总 2026-07-23）**：**绝不写死在代码里**，读一个配置文件（见 §4.5）。
> 当前组合 = 聚合器 `gpt-5.5`（本地 CLIProxy `http://127.0.0.1:8317/v1`，OpenAI 兼容）+ proposer `MiniMax-M3`（Anthropic 兼容 `https://api.minimaxi.com/anthropic`）+ `mimo-v2.5-pro`。
> **但会随发展变化、且要支持多套 preset 组合**——所以模型集/聚合器/endpoint/profile 全在配置文件里，代码只读配置。**不走 OpenRouter**（pi-mcp 默认要改）。

---

## 0. 一句话结论

**Pi 的 SDK + subagent 扩展已经提供了 MoA 所需的全部原语**（并行扇出、per-agent 模型/工具 profile、chain 串联、流式、单独 steer）。
我们**不重写 Pi**，只写三块自有代码：**① MoA 编排层（无头）② 确定性交付 synchronizer ③ 对外 MCP server 前门**。
透明层用现成的（Cmux 分屏 / subagent 父 TUI 并行流 / pi-web WebUI 三选一或叠加）。

---

## 0.5 为什么 Pi 版能比 Hermes-MoA 更优（不然不如不做）

徐总铁律：**做了就要做得比现状好。** 摸清两边后，Pi-MoA 在 10 个具体点上是**结构性更优**，不是重复造轮子。
每条都锚定一个 Hermes 现状痛点（据 `hermes experience.md`）。

| # | Hermes-MoA 现状痛点 | Pi-MoA 改进 | 性质 |
|---|---|---|---|
| 1 | **调用协议 stringly-typed 脆**：自然语言意图门（"用 MoA 验真模式…"必须首非空行/命令式）；交付要 `::moa-delivery{json}` 首行 + `done_marker` 末行；`-z "/moa"` 不走斜杠解析、模式各有 quirk | **结构化 MCP 调用** `moa_run({prompt,models,aggregator,mode})`：无 NL 分类、无首行/末行字符串契约、codex/claude/antigravity 调用形状一致 | **严格更优（你点的那条）** |
| 2 | 拓扑锁死在 preset（default=MiniMax+mimo+gpt5.5），改要动 config.yaml | **per-call `models[]`+`aggregator`**：换模型/变 N/AB 测，纯参数、不改配置 | 灵活性 |
| 3 | 输出不透明：只回 aggregated，看不到每个 reference 的 proposal | **返回结构化 `proposals[]`**（每模型正文+tokens+cost）+ aggregated，可审分歧/debug 坏聚合（pi-mcp 已原生统计 cost/token） | 可观测 |
| 4 | 无实时透明、无单独 steer | 每 proposer 一个 pi 会话 → Cmux/pi-web 实时流 + `session.steer()` 单独干预 | **Hermes 结构上做不到** |
| 5 | 交付过度约束：path 必须 `/private/tmp/pg-specs/` 直属、名必 `_report.md`、done_marker 正则 | 保**安全**（原子写+sha256 回读+`PI_MCP_ALLOWED_ROOTS` 工作区门，pi-mcp 已有），去掉武断路径/命名约束 | 同安全少摩擦 |
| 6 | 一次性，无 resume/fork | pi 会话落 jsonl，pi-mcp 已暴露 continue/fork：**改 aggregator 提示重跑聚合、不必重跑 proposers** | 省成本+debug |
| 7 | verify 只读靠手搓 terminal allowlist；synthesize 仍有 bash 副作用风险 | `allowWrites:false`+`allowShell:false`+只读 tools（pi-mcp 原生）+ 工作区 jail，可叠 permission-system 包做 OS 级 | 更干净 |
| 8 | **为防父模型偷懒绕过 MoA**，被迫建刚性意图门 + 运行时机械门控（MoA 2.2 才真堵住） | **根本没有父模型**：MCP 工具即入口，codex/claude 直调——整类「绕过防护」复杂度蒸发 | **更简且更可靠** |
| 9 | MoA 是 Hermes 内部单体 | Pi-MoA = MCP 工具（+可选 pi 扩展）→ 可被 taskflow DAG / 其它 pi 工作流 / 任意 MCP client 组合 | 可组合 |
| 10 | tool-using proposer 跑在同一宿主工作区（synthesize 有副作用风险） | 每 proposer 可各自 git worktree（dynamic-workflows）→ 并行不打架 | 更安全并行 |

**诚实边界（不吹）**：以上是**设计天花板，不是 day-1 现实**。Hermes-MoA 有 44k+ 测试、硬化收据、实战过的机械只读——
Pi-MoA 是新地。**必须先把安全不变量追平（quorum 2/2 / fail-closed / 机械只读 / 确定性交付+回读 / receipt），这些优化才算数。**
只追平不做这 10 点 = 你说得对，不如不做。**做的意义 = 这个优化 delta；其中第 1、4、8 是任何时候都成立的净胜。**

---

## 1. Hermes 三件套 → Pi 落点映射（逐条，附真代码）

> **⚠️ 术语校正（徐总 2026-07-23，推翻先前误判）**：徐总脑子里的三件套 =
> **① MoA**（整个机制）**② verifier = 验真模式**（只读裁判：「用 MoA 验真模式，只读核验…的结构与证据」）
> **③ synchronizer = 聚合模式 / synthesizer**（「MoA 聚合模式，对比两个方案给综合结论」）。
> **"synchronizer" 是 "synthesizer（合成/聚合器）" 的意思，不是确定性落盘交付**（我先前误判为交付层，已纠正）。
> 因此核心 = **两个模式：聚合(synthesize) + 验真(verify)**，都是 proposers+aggregator、只差只读 profile，正好对上 Hermes `default`/`moa_verify` 两 preset。
> **确定性落盘交付** = Hermes 独立可选件（`moa_deliver`），**不是**徐总所指的 synchronizer，见下表单列。


来源：`~/.hermes/hermes experience.md`（当前运行真源，2026-07-22）。

| Hermes 概念 | 现状定义 | Pi 落点（真代码引用） | 需自建? |
|---|---|---|---|
| **MoA / synthesize（= 徐总的 synchronizer）** | `default` preset：2 Reference（MiniMax-M3 + mimo-v2.5-pro）→ Aggregator（gpt-5.5），2/2 quorum，聚合正文即最终答案 | subagent 扩展并行 `{tasks:[]}`（proposers）+ chain `{previous}`（aggregator）。`packages/coding-agent/examples/extensions/subagent/{index.ts,README.md}` | 编排薄层自建 |
| **verifier / verify** | `moa_verify` preset：同拓扑，worker 机械只读（terminal 只放行 ls/rg/grep/cat/stat/只读git…），GPT 裁判两份只读证据 | 同结构 + agent 的 `tools:` 收窄只读 + `sandbox`/`gondolin` 扩展做 OS 级隔离。`examples/extensions/{sandbox,gondolin}/index.ts` | profile + 沙箱配置 |
| **synchronizer = 聚合模式（synthesize）** ✅徐总所指 | 同「MoA / synthesize」行——proposers 出提议 → aggregator 综合成一份结论。徐总原话「MoA 聚合模式，对比两个方案并给出综合结论」 | 同 MoA 行：subagent 并行 `{tasks:[]}` + chain `{previous}` 聚合 | 编排薄层自建 |
| 确定性落盘交付（`moa_deliver`，**day-1 一等公民**，徐总决策B 2026-07-23） | Hermes §5：聚合器出正文后系统（非 LLM）原子写盘→回读核 SHA-256+DONE marker→防 symlink 穿越→记 `REPORT_WRITTEN` 收据 | 无 Pi 现成物，自建确定性写盘模块（复用 Hermes 契约 + pi-mcp `resolveWorkspace` jail）。**moa_verify+deliver = 核心审计组合，首发就绪** | 自建（day-1） |
| **capability profile**（synthesize-worker / verify-worker / delivery-readonly-worker） | 每种 worker 一套工具白名单 | Pi agent 定义 = `.md` frontmatter `{name,description,tools,model,systemPrompt}`。解析见 `subagent/agents.ts` 的 `AgentConfig` + `parseFrontmatter` | profile 文件自建 |
| **preset**（default / moa_verify） | 一套官方 provider 上叠两个 preset | Pi 有 `examples/extensions/preset.ts`（预设机制）；我们用它固化 default/verify/deliver 三预设 | 复用 + 配置 |
| **刚性意图门** | 防父 Agent 抢在 MoA 前用自己工具偷懒（Hermes 内部问题） | **不需要**：MCP 是显式调用 `moa_run`，没有「父 agent 自行决定绕过」的场景 | 删除 |
| **完成收据 receipt** | 记 mode/preset/models/2-2 quorum/profile/正文 hash/交付状态 | 我们的 MoA 编排层产出结构化 receipt，随 MCP 返回 + 落盘 | 自建 |
| **fail-closed / no fallback** | 任一 Reference 失败→整体失败，不回退父模型「看似成功」 | 编排层不变量：quorum 未满即 throw，绝不降级 | 自建（不变量）|

**关键判断**：subagent 扩展的 `agents.ts` 里 `AgentConfig{ name, description, tools?, model?, systemPrompt }`
**逐字段对应** Hermes 的 capability profile（工具白名单 + 模型 + 系统提示）。这不是巧合——两者都是「给某个角色配模型+限工具+定人设」。迁移是**配置级**，不是重写。

---

## 2. 总体架构

```
Claude / codex / antigravity  （异构调用方）
        │  MCP:  moa_run / moa_verify / moa_deliver
        ▼
┌──────────────────────────────────────────────┐
│ [pi-moa MCP server]  ← 自建（@modelcontextprotocol/sdk）│   ← pi-mcp-adapter 不提供此层（它是 client 方向）
│   把 MCP 调用翻成 MoA 编排                        │
└───────────────┬──────────────────────────────┘
                │ Pi SDK: createAgentSession({ model, tools })   （docs/sdk.md）
                ▼
┌──────────────────────────────────────────────┐
│ MoA 编排层  ← 自建（参照 subagent/index.ts 的进程扇出/流式）│
│   ├─ proposer A: pi session(MiniMax-M3, profile) ─┐        │
│   ├─ proposer B: pi session(mimo-v2.5,  profile) ─┼ quorum 2/2 · fail-closed │
│   └─ [verify 模式] 只读 tools + sandbox           ─┘        │
│   ▼ 收齐 proposals（steer/followUp 可单独干预）              │
│   aggregator: pi session(gpt-5.5, 收 {previous})            │
└───────────────┬──────────────────────────────┘
                ▼
┌──────────────────────────────────────────────┐
│ synchronizer  ← 自建：原子写 + 回读 SHA-256 + DONE marker + receipt │
└──────────────────────────────────────────────┘

透明层（旁路观测，三选一/可叠加）：
 (a) subagent 父 TUI 并行流   (b) Cmux 分屏 N 个 pi 进程   (c) pi-web WebUI（读 sessions/*.jsonl）
```

**两种消费模式**（同一套编排，两个入口）：
- **无头（程序化）**：Claude/codex 经 MCP 调 `moa_run` → 返回 JSON（proposals + aggregated + receipt）。看不到 pane。
- **值守（透明）**：人在 Cmux / pi-web 里看每个 proposer 的实时流，`session.steer()` 单独干预某一个。
- **两头兼得**：编排层始终把每个 proposer 跑成**独立 pi 会话/进程**（session 落 `~/.pi/agent/sessions/*.jsonl`），
  所以无头调用时人也能随时用 pi-web attach 进去看/分支。

---

## 3. Pi SDK 关键 API（docs/sdk.md 实证，MoA 直接用得上）

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
// ⚠️ M0 实证：getModel 不是 pi-coding-agent 顶层导出（在 @earendil-works/pi-ai）。统一用实例方法 modelRuntime.getModel(provider,id)。

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  model: modelRuntime.getModel("<provider>", "<model>"),   // ← 每个 proposer / aggregator 各自模型（M0 实证：走实例方法，含 models.json 自定义模型）
  tools: ["read", "grep", "bash"],             // ← capability profile：verify 收窄为只读集
  modelRuntime,
  sessionManager: SessionManager.create(cwd),  // 落 jsonl → pi-web 可读、可分支
});

session.subscribe((e) => {                     // ← 流式（透明）
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
    process.stdout.write(e.assistantMessageEvent.delta);
  if (e.type === "agent_end") { /* e.messages = 该 proposer 最终产出 */ }
});

await session.prompt(taskText);                // 跑
await session.steer("换个角度，重点核对 X");     // ← 单独 steer（值守干预）
await session.followUp("完成后再检查 Y");        // ← 排队追加
```

- **模型**：`getModel(provider,id)` / `modelRuntime.getModel()`（含 `models.json` 自定义模型）。
- **工具限制**：`tools:[...]` = profile。Pi **无内置权限系统**（`docs/usage.md:296` 明说），
  真只读隔离靠 `sandbox`/`gondolin` 扩展（OS 级），**不能只靠 `tools:[]`**（样例 reviewer.md 自己都注明"tool permissions not perfectly enforceable"）。
- **steer/followUp**：`streamingBehavior:"steer"|"followUp"`，正是「单独给某 agent 调整命令」。

---

## 4. MCP 契约（对外前门，自建 server）

Pi 本体不是 MCP server（`docs/usage.md:296`），pi-mcp-adapter 只做 client 方向。
**但 GitHub 上已有把 Pi 暴露成 MCP server 的现成物（2026-07-23 搜到），前门不必从零写：**

| 现成物 | 方向 | 关键能力 | 成熟度 | 用法 |
|---|---|---|---|---|
| **`Baseline-Systems/pi-mcp`** ⭐1 | 暴露 pi 为 MCP tools | `pi_ask/continue/fork/list`；**每调可选模型 + 工具子集 + `allowShell/allowWrites` 权限门 + 超时**；spawn `pi --mode rpc` 流式；处理 cancel/cleanup | v0.5，young | fork 首选 |
| **`sotayamashita/pi-mcp-export`** ⭐0 | 暴露 pi **扩展** 为 MCP server | pi `registerTool` → MCP tools/call；支持 Codex/Hermes/Claude Desktop/Cursor；jiti 动态 TS | **PoC，未上 npm** | 若 MoA 做成扩展 |
| **`heggria/taskflow`** ⭐42 | 多 agent DAG + 自带 MCP server | map/reduce/gate/**tournament(best-of-N)**/race；跨 Pi/Codex/Claude Code；resume；worktree | 相对最成熟 | 备选整体框架 |

**基座架构（徐总 2026-07-23 决策 A = 进程内 pi SDK；据代码复用审核）**：
**fork `Baseline-Systems/pi-mcp` 的「外壳」**（MCP server 脚手架 `McpServer`+stdio+zod / workspace jail `resolveWorkspace` / JSONL 容错 / argv 安全 / 错误分类 —— 这些真值钱、白拿），
**但 proposer/aggregator 用 pi SDK `createAgentSession` 进程内驱动，不用 pi-mcp 的 rpc-spawn 内核**。
理由（复用审核实证）：pi-mcp 的 spawn 内核 = OpenRouter 写死 5 处 + 不吐 token 流 + rpc 子进程逃过全局 kill（泄漏）三重坑；**同包 SDK 原生消掉三点**——`ModelRuntime` 走 models.json/auth.json 多 provider（**零 OpenRouter、无写死可拆**）、`session.subscribe` 原生 text_delta 流、`SessionManager.create` 落 jsonl（pi-web attach）、`session.steer` 原生干预。
**一个 MoA = 进程内并行起 N 个 `createAgentSession`（proposers，各自 model+profile）+ 收齐 quorum + 再起一个（aggregator）**。我们只加 MoA 专有的 quorum/fail-closed/aggregator 聚合/synchronizer 确定性交付。
> 取舍：进程内 SDK ⇒ 透明主力 = **pi-web**（读 jsonl）；Cmux 分进程分屏（每模型一 pane）不在此路径（徐总已接受，决策 A）。

**⚠️ fork pi-mcp 时的头号必改项（徐总红线：绝不用 OpenRouter）**：pi-mcp 现状把 `--provider openrouter` + 单一 `OPENROUTER_API_KEY` **写死**在 `pi-client.ts:110` / `pi.ts:539`。
fork 第一刀就是**删掉这个写死**，换成 §4.5 配置驱动的 per-proposer `{provider, base_url, api_key_env}`（本地 CLIProxy + minimax + xiaomi）。**本项目全程零 OpenRouter。**

下面契约即在此 fork 上新增的工具：

三个工具（或一个 `moa` 工具带 mode 参数，先按三个清晰）：

```jsonc
// moa_run — 聚合模式（synthesize）
{
  "name": "moa_run",
  "input": {
    "prompt":     "string, required",
    "context":    "string, optional（贴代码/文件片段）",
    "models":     "string[], optional，默认 [minimax-cn/MiniMax-M3, xiaomi/mimo-v2.5-pro]",
    "aggregator": "string, optional，默认 openai-cliproxy/gpt-5.5",
    "cwd":        "string, optional（worktree 根）"
  },
  "output": {
    "aggregated": "string（聚合正文=最终答案）",
    "proposals":  "[{model, text, tokens, ok}]",
    "receipt":    "{mode, preset, models, quorum:'2/2', profile, body_sha256, delivery:null}"
  }
}

// moa_verify — 验真模式（只读 + sandbox），入参同上，profile=verify-worker
// moa_deliver — synthesize/verify + 确定性交付，额外 { path, done_marker }，见 §6
```

> **⚠️ 契约单一真源（P0-4）**：本节 schema 仅示意；**唯一权威 I/O schema 以 §4.6 B 为准**（含 status/error/cost/duration/session_id）。入参真源：`preset`（可选，默认 default）+ `mode`/`models`/`aggregator`（临时覆盖）+ `context`/`cwd`；覆盖优先于 preset。
> **⚠️ 模式语义进 tool `description`（P1-2）**：删了 Hermes 意图门后，调用 LLM 靠工具 description 自解——`moa_run`/`moa_verify` 的 description 必须写清适用边界（Hermes §4.1/§4.2）+ 硬约束「**verify 只读、不能执行代码**；要跑测试用 synthesize 或先在隔离区跑完再让 verify 审」。

**不变量（写死在 server/编排层，fail-closed）**：
1. **proposer success 硬定义（P0-3）**：成功 = `agent_end` 且**正文非空**且无 error（pi SDK 空串不算成功）；收齐用 `Promise.all` 语义，**任一失败/空正文 → 整体 throw，不产出、不降级**（不用 allSettled 吞）。
2. `quorum` 锁死 = 全部 proposer 成功（2/2），加载期强校验。
3. aggregator 正文直接作为 `aggregated` 返回，**不经第二个模型改写**。
4. 每次调用产出 `receipt`（含每 proposer 阶段硬信号 + aggregator 成本 + session_id），落盘 + 随返回。

---

## 4.5 模型 / preset 配置（配置文件驱动，绝不写死；徐总 2026-07-23）

**铁律**：模型集、聚合器、endpoint、profile、quorum **全在配置文件里，代码只读配置**。理由：组合会随发展变化，且要支持多套 preset 并存。

配置文件 `PiMoa/config/moa.yaml`（草案，字段名可再定）：

```yaml
# 供给方 endpoint（与模型解耦，改 endpoint 不动 preset）
providers:
  cliproxy:  { kind: openai,    base_url: "http://127.0.0.1:8317/v1" }   # 本地 CLIProxy
  minimax:   { kind: anthropic, base_url: "https://api.minimaxi.com/anthropic" }
  xiaomi:    { kind: openai,    base_url: "<xiaomi endpoint>" }
  # 将来加 provider 只在此加一行；api_key 走 env 引用，不落配置明文

# 命名 preset（对齐 Hermes default / moa_verify，可自由增删多套组合）
presets:
  default:                    # = synthesize
    mode: synthesize
    quorum: all               # 全成才放行；否则 fail-closed
    proposers:
      - { provider: minimax, model: MiniMax-M3,    profile: synthesize-worker }
      - { provider: xiaomi,  model: mimo-v2.5-pro, profile: synthesize-worker }
    aggregator: { provider: cliproxy, model: gpt-5.5, profile: synthesize-worker }  # aggregator 也带 profile（P0-1）
  moa_verify:                 # = verify（只读）
    mode: verify
    quorum: all
    proposers:
      - { provider: minimax, model: MiniMax-M3,    profile: verify-worker }
      - { provider: xiaomi,  model: mimo-v2.5-pro, profile: verify-worker }
    aggregator: { provider: cliproxy, model: gpt-5.5, profile: verify-worker }  # ★verify 下聚合器也必须只读（P0-1，闭合审核🔴#1）
  # 例：将来另一套三提议组合，直接新增 preset，无需改代码
  # heavy3: { mode: synthesize, proposers: [ ...3 个... ], aggregator: {...} }

# 超时：直接 port PaperGo「A/B 组 + 加载期不变量强校验」成熟设计（架构文档 §8，他们踩过 backstop<per_call 的坑并治本）
timeouts:
  reference_per_call_ms:  180000   # 每个 proposer 的 per_call（编排层按阶段注入 pi-mcp 会话 timeoutMs）
  aggregator_per_call_ms: 480000   # 聚合器更宽：吃 N 份 proposal + 长输出（PaperGo 亲历聚合器 180s 卡死→独立宽 per_call）
  moa_total_backstop_ms:  720000   # MoA 总硬 backstop，必须覆盖整条串行链

defaults:
  preset: default
```

**加载期不变量（fail-loud，port PaperGo `checkTimeoutInvariants`；直接闭合鲁棒性 P0#1）**——启动即校验、违反即报错不启动：
- **① backstop ≥ 各阶段 per_call**：`moa_total_backstop_ms` ≥ `aggregator_per_call_ms` 且 ≥ `reference_per_call_ms`；且二者都必须 ≤ pi-mcp 绝对上限(30min) 与注入的会话 `timeoutMs`——否则外层先掐断，per_call 形同虚设（PaperGo 亲历）。
- **② MoA 总预算 ≥ 串行链**：`moa_total_backstop_ms` ≥ max(`reference_per_call_ms`) + `aggregator_per_call_ms` + 余量（proposers 并行取 max、再串 aggregator）。
- **③ 调用方超时 ≥ backstop**（文档强提醒）：codex/claude 调 `moa_run` 的 MCP client 侧超时必须 ≥ `moa_total_backstop_ms`，否则调用方先掐断整个 MoA。
- 聚合器可像 PaperGo 那样用**独立 preset 条目**给更宽 per_call，不动其它档。

MCP 调用两种用法：
- **用 preset**：`moa_run({ preset: "default", prompt, context })` —— 常态。
- **临时覆盖**：`moa_run({ prompt, models:[...], aggregator:{...}, mode })` —— 不改配置做 A/B。
- **加载期校验（fail-loud，学 Hermes「加载时不变量强校验」）**：① preset 引用的 provider 必须在 `providers`、proposer 与 **aggregator 都必须带 profile**（P0-1）；② **verify/deliver preset 的 aggregator.profile ∈ {verify-worker, delivery-readonly-worker}**（否则聚合器可写、只读被击穿，闭合审核🔴#1）；③ **`quorum` 锁死 = `all`（或 = proposer 数）**，拒绝更小值 fail-loud（配置化误配成 1 会破坏 fail-closed，P0-5）；④ `api_key_env` 指向的环境变量必须存在（否则运行时才 401）；⑤ 超时三条嵌套不变量（见上）。任一违反启动即报错。

> api_key **不入配置明文**：配置里写 `api_key_env: FOO_KEY` 之类的 env 引用，运行时从环境读（pi-mcp 的 env 注入路径可复用）。

---

## 4.6 观测 / 状态契约（流式 + MCP，杀"探针轮询"；徐总 2026-07-23）

**目标**：调用方（codex/claude/antigravity）不再靠探针戳「完成了吗/死了吗/错了吗/落盘了吗」。分两条路，都要做：

**A. 运行中：分阶段结构化进度通知（MCP `notifications/message`，复用 pi-mcp `sendNotification`）**
比 pi-mcp 现有的泛化通知更结构化——每个阶段一条：
- `proposer:<model> started / streaming(tokens) / done / timeout / failed`
- `quorum gathered N/N`（或 `fail-closed: proposer <x> failed → 整体失败`）
- `aggregator started / streaming / done`
- `delivery written <path> sha256=<...>`（若启用交付）

→ MCP 客户端 / 盯着的人**实时**看到 MoA 在哪一步、活没活、错没错。**主动上报，不用探针。**

**B. 结束：自描述结构化结果 + receipt（给 LLM 调用方，回合制、也不用探针）**
返回体自带完整状态，调用方拿到即知全貌：
```jsonc
{
  "status": "ok | failed | aborted",
  "aggregated": "...",                         // 成功时的最终结论
  "proposals": [ {model, ok, empty, tokens, cost, duration_ms, timeout} ],  // 每 proposer 硬状态（含空正文标记，闭合审核 #13）
  "receipt": { mode, preset, models, quorum:"2/2", profile,
               stage_marks:{proposer_x:"completed", aggregator:"completed"}, // 阶段硬信号，闭合审核 #14
               body_sha256, delivery: {written:true, path, sha256} | null },
  "error": null | {stage, reason, detail}      // 失败时精确到阶段
}
```

**资源回收（三层，徐总 2026-07-24 强调；闭合新架构风险 #2 泄漏）**：
1. **每会话**（`runSession` finally）：`session.dispose()` + `clearTimeout` + `removeEventListener(abort)` + `unsubscribe`，覆盖成功/报错/超时/取消全路径；`orchestrate` 建**一个**隔离 loader 复用（非 N+1）。
2. **bash_readonly**：`execFile` 带 `timeout` + `signal` → 子进程自动清理。
3. **server 级优雅关闭**（`server.ts`，对齐 pi-mcp `registerShutdownHandlers`）：每调登记 `inFlight`，SIGTERM/SIGINT → abort 全部在途（→ 各会话 dispose）→ drain ≤5s → `server.close()` + `modelRuntime.dispose?.()` → exit 0。实测 SIGTERM 优雅退出 0。
**取消支持**：MCP cancel/abort → 链到自建 AbortController → 透传 `runMoa`→`runSession` → 会话 abort + finally dispose。

**mid-flight 程序化 steer（可选、Phase-2）**：MCP 请求-响应不原生支持往在途调用注入指令。要做需自建 `run_id` + `moa_steer(run_id,msg)` 工具 + 运行中 MoA 消费 steer 消息；且 LLM 回合制使其不自然。**默认不做**——人的 mid-flight 干预走人类透明层（Cmux/pi-web `session.steer()`），程序化侧优先「取消 + 带新参数重跑」。

> 层次划分：**MCP 状态流** = 杀探针（本节）；**人类透明层（Cmux/pi-web）** = 看每条流 + 人单独 steer（§7）。两层正交、各司其职。

---

## 5. 三个 capability profile（`.md` frontmatter，放 `~/.pi/agent/agents/`）

对齐 Hermes 三 worker（`hermes experience.md` §4）：

```markdown
---
name: synthesize-worker
tools: read, grep, find, ls, bash, web_search   # 对齐 read_file/search_files/web_search/terminal/execute_code
model: <由编排层覆盖>
---
（synthesize 系统提示：多视角提议，给依据）
```
```markdown
---
name: verify-worker
tools: read, grep, find, ls, web_search, web_extract, bash_readonly   # ★命令级只读，非"不给 bash"（P0-1，闭合审核🔴#2）
model: <覆盖>
---
（verify 系统提示：只读取证，区分「实际读到的证据」vs「模型推断」，禁改被审对象）
```
> **★verify 只读必须"命令级"而非"二元给/不给 bash"（闭合审核🔴#2 + robustness P0#2）**：Hermes §4.2 verify **保留** `git diff/status/log`、`hash`、`stat/file/wc/readlink/realpath/du/df`、只读 find 等取证命令——"干脆不给 bash"会**删掉 verify 赖以取证的一半能力**（不能比对 git diff、不能核 hash）。故需自建一个 **`bash_readonly` 工具**：包一层 bash，只放行 Hermes §4.2 那张只读命令白名单，拒重定向 / `sed -i` / git 写 / pytest / execute_code。**落地（已评估定案 2026-07-24，详 reviews/04_permission_eval.md）**：自建 `bash_readonly` 工具 = **复用 `refs/pi-permission-system` 的 tree-sitter bash 解析**（`packages/pi-permission-system/src/access-intent/bash/`：`BashProgram.commands()` + wrapper 识别，省掉手搓 shell 解析这个安全关键活）+ 固定取证 allowlist（git diff/status/log、hash、stat/file/wc/readlink/realpath/du/df、只读 find）+ **显式 reject 任何 `file_redirect`/`>`/`>>`/wrapper**（`bash -c`/`eval`/`sudo`/`xargs`/`find -exec`）。**为什么不整包吞 pi-permission-system**：它偏重（~60 文件+authority/forwarding），且**白名单命令带 `>` 写重定向堵不干净**（`git diff > x` 会漏，因重定向被剥离出命令文本、path surface 无读写语义）——正是我们最在意的洞，故借其解析代码、自己 reject 重定向。**纵深防御**：叠官方 `sandbox` 扩展（macOS sandbox-exec）做 FS 只读兜底。进程内经 `createAgentSession({resourceLoader:{extensionFactories:[...]}})` 加载，verify 策略**无 ask 分支**保证 headless fail-closed。**验收（M2）：命令级 —— `echo x>f`/`sed -i`/`git diff > f` 被拦、`git diff`/`hash`/`stat` 仍可用。**

### ★ 安全不变量：子 agent 不能生成孙 agent（徐总 2026-07-24）

PiMoa 的 proposer/aggregator 是**子 agent**；它们**绝不能再 spawn 孙 agent**（否则递归扇出爆炸 + 提权洞）。两道闸，都已落 `src/moa/session.ts`：
1. **工具 allowlist（硬断言）**：`assertNoGrandchildCapability` —— 子会话工具必须 ⊆ `SAFE_SESSION_TOOLS`（M1 = read/grep/find/ls；M2 加 bash_readonly）。**allowlist 非 denylist**（防漏新危险工具）。越界即 throw。实测拦住 subagent/delegate/task/**moa_run（递归）**/bash/execute_code/write（`test/security.test.ts` 10/0）。
2. **loader 隔离**：会话必须用 `createIsolatedLoader`（`noExtensions/noSkills/...` 全 true）——杜绝扩展经 `registerTool` 注入派生工具（pi 里扩展能加工具，绕过 allowlist，故这道闸必不可少）。
3. **禁挂 moa MCP**：proposer/aggregator 会话绝不挂载 moa（或任何 agent-spawning）MCP server——否则子 agent 能调 `moa_run` 递归。
4. **未来给 synthesize 加 bash/execute_code 时**：命令层必须 deny 调用 agent CLI（`pi`/`hermes`/`moa`/`claude`/`codex`/`npx tsx …server.ts`），与 bash_readonly 同源。
```markdown
---
name: delivery-readonly-worker
tools: read, grep, find, ls
---
（交付前降级用，等同 verify 只读）
```

**只读的硬保证**：Pi `tools:[]` 只是「不给这个工具」，不拦 bash 内的写重定向。要达到 Hermes 那种「机械只读」，
verify/deliver 的 proposer **必须跑在 `sandbox` 或 `gondolin` 扩展里**（`examples/extensions/{sandbox,gondolin}/index.ts`），
或干脆不给 bash（只 read/grep/find/ls）。这是本方案**安全最敏感处，不可手挥而过**（对齐 Hermes「MoA 2.2 运行时机械门控才真正剥夺绕过权」的教训）。

---

## 6. synchronizer / 确定性交付（自建，不交给 LLM）

复用 Hermes 契约（`hermes experience.md` §5），由**我们的代码**做，不让 aggregator 自己写文件：

1. 入参 `{ path, done_marker }`，校验：`path` 在允许目录下、文件名后缀符合约定、`done_marker` 匹配 `DONE_[A-Z0-9_]+`。
2. proposer/aggregator 一律降 `delivery-readonly-worker`（只读，禁 execute_code/pytest）。
3. aggregator 返回后，**我们的代码**做受限**原子写**（临时文件 → fsync → rename）。
4. **回读**文件，核对 `SHA-256` 与 `body_sha256` 一致、最后一非空行 == `done_marker`。
5. 全过才记 `REPORT_WRITTEN`，receipt.delivery = 已验证；否则整体失败。
6. proposer/aggregator **不直接写最终文件**；无父模型兜底。

> ⚠️ **术语（徐总 2026-07-23）**：徐总的 **synchronizer = 聚合模式（synthesize）**，非本节落盘交付。
> **但本节「确定性落盘交付」= day-1 一等公民（决策B）**：完整性审核指出 Hermes 整个审计流核心就靠 verify+确定性落盘+DONE+REPORT_WRITTEN，是被替代对象最实战的一块。故 **`moa_verify + moa_deliver` 作核心审计组合、首发就绪**（`moa_deliver` 是独立工具名，语义上不叫 synchronizer）。

---

## 7. 透明层（你用 Cmux，不是 tmux）

三个现成选项，按投入从低到高：

| 选项 | 怎么做 | 拿到什么 | 成本 |
|---|---|---|---|
| **A. subagent 父 TUI 并行流** | 直接用 subagent 扩展的 parallel 视图 | 一个 pi TUI 里看全部 proposer 实时流 + 展开细节 | 最低（现成）|
| **B. Cmux 分屏** | 编排层把每个 proposer 跑成独立 pi 进程，各占一个 Cmux pane | 每模型独立 pane，各自 attach + `steer()` 单独干预 | 中（写 Cmux 编排脚本）|
| **C. pi-web WebUI** | `npx @agegr/pi-web@latest`，读 `~/.pi/agent/sessions/*.jsonl` | 浏览器看流 + worktree 切换 + 会话分支/fork | 中（现成，但 Bun/Next.js 另跑一进程）|

建议：**MVP 用 A**（零成本先跑通 MoA），**值守强需求上 B（Cmux）**，pi-web 作为随时可挂的旁路观测。
三者不互斥——proposer 都是标准 pi 会话，A/B/C 看的是同一批 session。

---

## 8. 与 Hermes 的差异（有意为之）

- **去掉刚性意图门**：MCP 显式调用，无「父 agent 偷懒绕过」问题。
- **去掉自然语言意图分类**：调用方是程序（Claude/codex），直接传结构化参数。
- **保留**：2/2 quorum、fail-closed 无 fallback、三 profile、确定性交付+回读校验、receipt。
- **强化透明**：Hermes 拿不到 per-agent 实时流；Pi 天然每个 proposer 一个可 attach 会话。

---

## 8.5 现成社区包评估（pi.dev/packages，能砍掉大半自建）

pi.dev/packages 已有大量可 `pi install npm:<name>` 的扩展。对口我们的缺口：

| 缺口 | 候选现成包 | 说明 |
|---|---|---|
| **并行扇出 + 模型路由 + worktree 隔离** | **`@quintinshaw/pi-dynamic-workflows`** | "fan a task out across 100s of subagents with real model routing, token/cost accounting, resume, git-worktree isolation" —— 几乎就是 MoA proposer 层 |
| 并行子代理 + chain + TUI | `pi-subagents`(nicopreme, 124K/mo) / `@tintinweb/pi-subagents`(43K/mo) | 我们上面读的 examples/subagent 的产品化版本 |
| 多 agent 编排 + worktree + TUI 面板 | `pi-squad` / `pi-crew` | 团队式协同 |
| 进程内子代理 + 实时 TUI 卡片 + JSONL 日志 | `pi-subagent-in-memory` | 低开销、透明友好 |
| **只读/权限强制**（填 Pi 无内置权限的坑） | **`@gotgenes/pi-permission-system`**(27K/mo) / `pi-landstrip`(sandbox-aware subagents) | verify/deliver 的机械只读靠它，不用手搓 sandbox |
| verifier 形态参考 | `@vigolium/piolium`(478K/mo, "specialist sub-agents, isolated context, capped concurrency, resumable") | 多阶段审计范式，可借 verify 结构 |

**修订判断**：MoA 的**扇出层大概率不用自建**——评估 `@quintinshaw/pi-dynamic-workflows`（首选，自带模型路由+worktree+成本核算）或 `pi-subagents` 作底座；
**只读强制**用 `@gotgenes/pi-permission-system` / `pi-landstrip` 替代手搓 sandbox。
我们**仍需自建的只剩三块**：① MoA 专有的 **quorum 2/2 + fail-closed + aggregator 聚合**胶水；② **synchronizer 确定性交付**；③ **对外 MCP server 前门**（没有任何包把 Pi 暴露成 MCP server，pi-mcp-adapter 是 client 方向）。

> ⚠️ 供应链：这些是社区第三方包（你 PaperGo 那边有供应链纪律，Pi 本体也 pin 死依赖）。**选 2-3 个候选真跑评估、看源码，别盲装**。开发工具容忍度高，但 verify/deliver 涉安全的包要过目。

---

## 9. 构建里程碑（已按 §8.5 现成包修订）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 环境** | node22 跑 pi（`npm run build:offline`）；接 3 个模型（MiniMax-M3 / mimo-v2.5-pro / gpt-5.5，经你现有 CliRelay/CLIProxy）；跑通单 `createAgentSession` | 单模型 prompt 出流 |
| **M1 扇出底座选型 + MoA 胶水** | 评估 `@quintinshaw/pi-dynamic-workflows` / `pi-subagents` 做扇出底座；在其上写 MoA 专有 quorum 2/2 + fail-closed + aggregator 聚合 + receipt | 同任务出 aggregated + receipt；杀一个 proposer 整体失败 |
| **M2 三 profile + 只读强制** | synthesize/verify/deliver profile；只读用 `@gotgenes/pi-permission-system` / `pi-landstrip`（评估后定），或退回 sandbox/gondolin | verify 下写操作被拦截 |
| **M3 synchronizer** | 确定性原子写 + 回读 SHA-256 + DONE marker | 交付 canary：改一字节 hash 不符即失败 |
| **M4 MCP 前门** | `moa_run/moa_verify/moa_deliver` stdio MCP server → 挂进 Claude/codex/antigravity 的 mcp 配置 | codex 里调 `moa_run` 拿到结果，全程不碰 Hermes |
| **M5 透明层** | 先 A（subagent 流），再 B（Cmux 分屏）；pi-web 可选 | 值守能看 3 条流 + 单独 steer 其一不影响另两 |
| **M6 平价验收** | 同一真实任务，Hermes-MoA vs Pi-MoA 比质量/成本/延迟 | 质量不劣、透明明确胜出才切换 |

---

## 10. 待你拍板的开放问题

1. ~~synchronizer 语义~~ ✅ **已定 = 聚合模式 synthesize**（徐总 2026-07-23，见 §1 术语校正）。「确定性落盘交付」是独立可选件 `moa_deliver`、非 synchronizer、非核心。
2. ~~模型接入方式~~ ✅ **已定 = 配置文件驱动**（§4.5），走本地 CLIProxy + minimax + xiaomi，不写死、不走 OpenRouter。剩余细节：xiaomi endpoint 具体值 + api_key env 名，M0 时从你环境取。
3. **Bun**：机器现无 bun（只 node22）。pi 本体 node22 够；pi-web 用 bun。要不要装 bun（只为 pi-web）？
4. **透明层优先级**：MVP 就用 subagent 父 TUI 流（A），还是一上来要 Cmux 分屏（B）？
5. **落地授权**：本文只是方案。M0/M1 要不要我起 `pi-moa/` 脚手架（package.json + 编排骨架 + profile 三 md），先把无头 MoA 在真模型上跑通？

---

## 附：证据索引（真代码位置）

- 仓库：`PiMoa/refs/pi`（earendil 源码，codegraph 已建，可 `codegraph explore/node/callers` 查）；`PiMoa/refs/pi-mcp`（前门 fork 基座，已读源码）；`PiMoa/refs/taskflow`（备选）
- SDK：`packages/coding-agent/docs/sdk.md`
- subagent 扩展（MoA 骨架参照）：`packages/coding-agent/examples/extensions/subagent/{index.ts,agents.ts,README.md,agents/*.md,prompts/*.md}`
- 沙箱：`packages/coding-agent/examples/extensions/{sandbox,gondolin}/index.ts`
- 预设：`packages/coding-agent/examples/extensions/preset.ts`
- 无内置 MCP 声明：`packages/coding-agent/docs/usage.md:296`
- provider 多家：`packages/ai/`
- Hermes 现状真源：`~/.hermes/hermes experience.md`（§2 拓扑 / §4 profile / §5 交付）
- 生态：pi-web = `github.com/agegr/pi-web`（透明 WebUI）；pi-mcp-adapter = `github.com/nicobailon/pi-mcp-adapter`（client 方向，非前门）
