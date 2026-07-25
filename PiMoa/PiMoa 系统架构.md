# PiMoa 系统架构与使用手册

> 版本：**v2.1**（2026-07-25，实战调优 + 第四轮对抗审 + MoA 自审后）｜项目根：`<PIMOA_ROOT>/`
> 本文所有文件/目录一律用**绝对路径**。设计意图真源见 `<PIMOA_ROOT>/DESIGN.md`；本文是**实现态**的架构与用法说明。
> **当前安全状态：🟢 良好·可上线**——经三轮对抗审（含独立复审）+ 逐条修复，§8.2 的 15 项漏洞（4 条 RCE / profile 提权 / 硬链接 / symlink / 注入等）全部实证修复并重审确认；verify 执行改为 **macOS `sandbox-exec` 内运行**（无网络 / 写限 scratch / 读不到 `$HOME`+密钥 / 子进程剥 key），主 containment 从脆弱的命令 allowlist 升级为 OS 级沙箱。残余风险（非 darwin fail-closed、blame/grep repo-local exec 被沙箱围等）见 §8.3，均已评估可接受。
> **v2.1 增量（2026-07-25）**：① **侦查前置**（§4.9 `files`/`recon_query` + 行号确定性）——把任务边界在进模型前画好，真实审计 `53.2s 失败 → 22.7s ok`、输入 token `251,808 → ~27k`；② **取证预算**（5 轮 / 20 万 token，§4.3）+ **compaction 打开** + **retry 打开**；③ **检索三件套** rg / ast-grep / rtk 取代 grep/find（§4.8），经**第四轮对抗审**修掉 2 项（ast-grep `-c` 别名绕过、sgconfig 动态库自动加载）；④ **quorum 分模式** `tolerate-one`（§4.4，仅 synthesize；verify 恒 fail-closed）——其兄弟-abort 交界缺陷由 **PiMoa 自审发现并修复**；⑤ 聚合器**去偏**（随机打乱顺序 + 反 verbosity/position/majority 偏差准则）与 **prompt 缓存友好顺序**；⑥ 聚合器换 `deepseek-v4-pro` 直连、MiniMax `maxTokens` 限 4096（整轮 `53.2s → 22.7s`）；⑦ **`models.json` 的 `contextWindow` 修正**：MiniMax-M3 / mimo 原误配 200k（实际 1M），低报 5 倍会让 compaction 提前触发、白丢上下文——这是打开 compaction 的前置条件。**端到端实战验收已完成（§11）**，并已发布 [pimoa-v2 release](https://github.com/jerryxugit-2026/Ai-learning/releases/tag/pimoa-v2)。

---

## 1. 这是什么 / 解决什么问题

**PiMoa = 开发侧的专职 MoA（Mixture-of-Agents）工具**：多个模型并行给提议 → 一个聚合器综合成最终结论，经 **MCP** 暴露给 Claude / codex / antigravity 等编码 agent 调用，**替代原先的 Hermes CLI MoA**。

**相比 Hermes MoA 的改进**：
| Hermes 现状 | PiMoa |
|---|---|
| 自然语言意图门 + `::moa-delivery` 首行 JSON + done_marker 末行等脆协议 | **结构化 MCP 工具调用**，无字符串契约 |
| 拓扑锁死在 preset | **配置文件驱动**，per-call 可临时覆盖 |
| 只回聚合正文，看不到各提议 | 返回**结构化 proposals[] + receipt**（含每模型 tokens/cost/耗时/sessionId） |
| 无实时流、无法单独干预 | 每 proposer 一个 pi 会话，**分阶段 MCP 通知**，会话落 jsonl 可 attach |
| 为防父模型绕过而建刚性门控 | **无父模型**，MCP 工具即入口，整类复杂度消失 |

**三个能力（= 三个 MCP 工具）**：
- `moa_run`：**聚合模式**（synthesize）——多模型提议 → 综合结论。
- `moa_verify`：**验真模式**（verify）——只读取证、多模型独立核验 → 聚合裁决。
- `moa_deliver`：聚合/验真 + **确定性落盘**（系统原子写 + SHA-256 回读 + DONE marker 校验）。

---

## 2. 目录结构（全绝对路径）

```
<PIMOA_ROOT>/
├── PiMoa 系统架构.md              ← 本文
├── DESIGN.md                      ← 设计真源（不变量/决策/审核收口）
├── package.json                   ← 依赖与脚本
├── tsconfig.json
├── .gitignore                     ← 忽略 node_modules/、config/auth.json、config/agent-empty/
│
├── config/                        ← 配置（代码只读配置，绝不写死）
│   ├── moa.yaml                   ← MoA 真源：providers / presets / timeouts / defaults
│   ├── models.json                ← pi ModelRuntime 模型注册（真正生效的 endpoint 与 key 引用）
│   ├── models-store.json          ← pi 运行期模型存储（自动生成）
│   └── auth.json                  ← pi 凭证文件（空 {}，已 gitignore）
│
├── src/
│   ├── m0-smoke.ts                ← M0 单会话冒烟（验证 pi SDK + 本地模型出流）
│   ├── config/
│   │   ├── types.ts               ← ★共享契约：MoaConfig / Preset / WorkerRef / Timeouts
│   │   └── load.ts                ← 配置加载 + 加载期不变量强校验（fail-loud）
│   ├── moa/
│   │   ├── types.ts               ← ★共享契约：MoaRequest / ProposalResult / Receipt / MoaResult
│   │   ├── session.ts             ← 单会话 runner + 工具 allowlist + 隔离 loader + 资源回收
│   │   ├── recon.ts               ← ★侦查前置：files 预读（打真实行号）+ recon_query（rg 机械检索）
│   │   └── orchestrate.ts         ← MoA 编排核心：并行 proposers → quorum fail-closed → aggregator
│   ├── mcp/
│   │   ├── events.ts              ← StageEvent 类型 + 渲染成 MCP notification
│   │   ├── tools.ts               ← 三个工具的 zod schema / description / 核心逻辑
│   │   └── server.ts              ← MCP stdio server + 在途追踪 + 优雅关闭
│   ├── deliver/
│   │   └── write.ts               ← 确定性写盘：原子写 + SHA-256 回读 + DONE marker + 路径 jail
│   └── tools/
│       ├── bash_readonly.ts       ← verify 用命令级只读工具（execFile shell:false 执行）
│       └── bash_readonly_policy.ts← ★安全关键：命令解析与放行/拒绝判定
│
├── test/                          ← 381 个断言，全部 npx tsx 直跑
│   ├── config.test.ts             ← 13：加载期不变量正/负例
│   ├── moa.test.ts                ← 29：编排 mock 确定性 + fail-closed 负例 + gated live smoke
│   ├── mcp.test.ts                ← 33：三工具 handler + onStageEvent 事件序列 + abort
│   ├── deliver.test.ts            ← 30：原子写五负例 + 端到端交付
│   ├── bash_readonly.test.ts      ← 64：放行 24 / 拒绝 36 + execFile 冒烟
│   └── security.test.ts           ← 10：防孙 agent 工具 allowlist 断言
│
├── reviews/                       ← 审计存档
│   ├── 00_SUMMARY.md              ← 三方审核整合总表 + 待决策
│   ├── 01_robustness.md           ← 鲁棒性（对照 Hermes 硬化清单 19 项）
│   ├── 02_completeness.md         ← 完整性（评分 6/10 + 三件阻断）
│   ├── 03_reuse.md                ← 代码复用核验（基座选型）
│   └── 04_permission_eval.md      ← verify 只读方案评估（pi-permission-system）
│
└── refs/                          ← 只读参考源码（均已建 codegraph 图谱，不参与运行）
    ├── pi/                        ← earendil-works/pi 单仓（SDK 来源，958 文件已索引）
    ├── pi-mcp/                    ← Baseline-Systems/pi-mcp（MCP 外壳蓝本，15 文件已索引）
    ├── pi-permission-system/      ← gotgenes/pi-packages（命令级权限参考，534 文件已索引）
    └── taskflow/                  ← heggria/taskflow（备选框架，未采用）
```

> ⚠️ `refs/` 是第三方参考代码，**含 OpenRouter 实现与测试用假 key 字符串**。PiMoa 自身运行代码（`src/` + `config/`）零 OpenRouter、零明文 key（Hermes 验真已核）。发布/审计时应排除 `refs/`。

---

## 3. 架构总览

```
Claude / codex / antigravity（调用方）
        │ MCP stdio：moa_run / moa_verify / moa_deliver
        ▼
<PIMOA_ROOT>/src/mcp/server.ts     ← MCP 前门（启动期 loadConfig + ModelRuntime，缓存复用）
        │   · 在途调用登记 inFlight，链接 MCP signal → 自建 AbortController
        │   · SIGTERM/SIGINT → abort 在途 → drain ≤5s → dispose → exit 0
        ▼
<PIMOA_ROOT>/src/mcp/tools.ts      ← 入参 zod 校验 → MoaRequest；结果 → MCP structuredContent
        ▼
<PIMOA_ROOT>/src/moa/orchestrate.ts  runMoa(config, req, deps)
        │  ① 解析 preset + 临时覆盖
        │  ② 建 1 个隔离 loader，复用给全部会话
        │  ③ 并行 N proposers ──┐
        │  ④ proposer success 硬定义：agent_end && 正文非空 && 无 error && 未超时/取消
        │  ⑤ quorum=all，任一不达标 → status:failed、不跑 aggregator、aggregated=""
        │  ⑥ aggregator 会话 → 正文直接作为最终答案（不二次改写）
        │  ⑦ 组装 MoaResult：proposals[] + receipt（阶段标记/成本/sha256）
        ▼
<PIMOA_ROOT>/src/moa/session.ts    runSession（每 proposer/aggregator 各一次）
        │  · modelRuntime.getModel(provider, id) → createAgentSession({model, tools, customTools})
        │  · subscribe 收 text_delta / agent_end；per-call timeout → session.abort()
        │  · ★assertNoGrandchildCapability：工具必须 ⊆ SAFE_SESSION_TOOLS
        │  · finally：dispose + clearTimeout + removeEventListener + unsubscribe
        ▼
   三个模型端点（分散，避免单点依赖）
   ├── proposer  MiniMax-M3     → https://api.minimaxi.com/anthropic        （Anthropic 协议，直连）
   ├── proposer  mimo-v2.5-pro  → https://token-plan-sgp.xiaomimimo.com/v1  （OpenAI 协议，直连）
   └── aggregator deepseek-v4-pro → https://api.deepseek.com                （直连，1M 上下文）
   （历史：proposer 2 曾用 xiaomi/mimo-v2.5-pro，现为 minimax/MiniMax-M3；`xiaomi` provider 仍在 `providers:` 段保留 endpoint，但当前**未被任何 preset 引用**）

（moa_deliver 额外一步）→ <PIMOA_ROOT>/src/deliver/write.ts
        · 系统（非 LLM）原子写：同目录 tmp(wx) → fsync → rename
        · 回读核对 SHA-256 + 末非空行 === DONE marker；失败即整体 failed 并清理 tmp
```

---

## 4. 核心模块详解

### 4.1 `<PIMOA_ROOT>/src/config/types.ts`（45 行）
共享契约，**改动须经架构负责人**。定义：`ProviderKind`(openai|anthropic)、`ProviderCfg`(kind/baseUrl/apiKeyEnv)、`ProfileName`(synthesize-worker|verify-worker|delivery-readonly-worker)、`WorkerRef`(provider/model/profile)、`Mode`(synthesize|verify)、`Preset`、`Timeouts`、`MoaConfig`。

### 4.2 `<PIMOA_ROOT>/src/config/load.ts`（314 行）
`loadConfig({ moaYaml })` → 读 YAML → 结构解析 → **加载期不变量强校验**，违反即 `throw ConfigError`（前缀 `[config]`）：
1. preset 的 proposer + **aggregator** 的 provider 必须已注册；两者都必须带 `profile`。
2. **verify preset 的 aggregator.profile ∈ {verify-worker, delivery-readonly-worker}**（防聚合器可写）。
3. **`quorum` 分模式**（2026-07-25）：取值仅 `"all"` | `"tolerate-one"`，缺省 `"all"`；**verify 模式强制 `"all"`**（加载期拒绝其它值）。其它任何值（如数字 1）一律 fail-loud 拒绝（防误配破坏 fail-closed）。
4. `apiKeyEnv` 指向的环境变量必须存在（避免运行时才 401）。
5. 超时三嵌套：`moaTotalBackstopMs ≥ aggregatorPerCallMs`、`≥ referencePerCallMs`、`≥ max(reference)+aggregator`，且各值 ≤ 30 分钟绝对上限。
6. `defaults.preset` 必须存在于 presets。
另导出 `validateConfig(cfg)` 供内存态校验。

### 4.3 `<PIMOA_ROOT>/src/moa/session.ts`（340 行）
- `createIsolatedLoader(cwd, agentDir)`：`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全开 → **杜绝扩展注入工具**（防孙 agent 第二道闸）。
- `PROFILE_TOOLS`（2026-07-25 收紧）：synthesize-worker=**`[]`（无工具）**；verify-worker=`[read,ls,bash_readonly]`；delivery-readonly-worker=`[read,ls,bash_readonly]`。
  · synthesize 去工具：大输入下 proposer 会自行扫库 → 多轮重发历史 → 上游断流吐空正文 → fail-closed。综合任务应就 `context`/`files` 作答。
  · verify/delivery 去 pi 自带 `find`/`grep`（输出量 PiMoa 封不了顶，曾一次吐 5w+ 字符）：检索一律走 `bash_readonly` 的 rg / ast-grep / rtk（见 §4.8）。
  · `read` 为**同名覆盖**的预算版（`src/tools/read_budgeted.ts`）：计入会话取证预算 + 路径 jail（pi 内置 read 无 jail）。
  · **会话取证预算**（`src/tools/budget.ts`，read 与 bash_readonly 共用一本账）：**轮数 ≤5**、**输出 ≤20 万 token**，任一触顶即拒并要求模型立即出结论。
  · **compaction 已打开**（M0 冒烟期误关一路带到生产）：主防线=上述预算闸，compaction 为最后兜底。
- ★`SAFE_SESSION_TOOLS` + `assertNoGrandchildCapability(tools)`：**allowlist 强制**，越界即抛。拦 `subagent/delegate/task/moa_run/bash/execute_code/write`。
- **`retry` 已打开**（2026-07-25）：上游（gemini/antigravity 等）在长/多轮生成上会间歇性 `Stream ended without finish_reason`——这是**瞬时可恢复**错误；此前 `retry:{enabled:false}` 使其直接坐实成空正文 → fail-closed 核平整轮。重试吃 per-call 超时预算，已配套上调超时 +50%。
- **usage 含缓存字段**：`extractUsage` 汇总全部 assistant 消息的 `cacheRead`/`cacheWrite`（pi 的 `getSessionStats()` 只回 input/output/total 会丢掉它们）。**命中率低 = prompt 前缀被破坏**，是明确的可优化信号（实测：直连 DeepSeek 逐轮追加命中 83–86%）。
- `runSession(...)`：**绝不抛**，所有失败折成 `{text,usage,costUsd,durationMs,timedOut,aborted,sawAgentEnd,sessionId,error}` 回传，判决交编排层。

### 4.4 `<PIMOA_ROOT>/src/moa/orchestrate.ts`（366 行）
`runMoa(config, req, deps)`，`deps = {modelRuntime, signal?, runSessionImpl?, onStageEvent?}`（后两个为测试注入/观测，可选）。
**不变量**：① proposer success 硬定义；② **quorum 分模式**——verify 恒 `all`（任一失败即整体失败）；synthesize 可配 `tolerate-one`：允许**最多 1 个**失败且**成功数 ≥2**（少于 2 份不再是多模型交叉、退化成单模型答案，故仍拒），降级时**只把成功的 proposal 送进聚合**、`receipt.quorum` 诚实标注 `k/N (degraded)`、发 `quorum:degraded`（warning 级）事件；③ aggregator 正文直返不改写；④ 每次产 receipt。失败即 `status:"failed"` + `error{stage}`，**不产出、不降级**（`all` 语义；`tolerate-one` 下的降级是显式标注的例外）。
> ⚠️ 兄弟 abort 与降级的交界（2026-07-25 MoA 自审实证的真缺陷，已修）：proposer 失败时 abort 兄弟会话用的 `sessionSignal` 与 aggregator **共用同一个 `internalAc`**，故原先的**无条件** abort 会让降级路径的 aggregator 一启动就 `aborted` ⇒ 降级形同虚设。现改为**按容忍额度**：`all` ⇒ 额度 0（首个失败即 abort，行为不变）；`tolerate-one` ⇒ 额度 1（第 2 个失败才 abort）。

**聚合器提示的三项构造规则**（`buildAggregatorPrompt`）：
1. **nonce 信任边界**：每份 proposal 用 `node:crypto` 随机 nonce 包裹，前言层声明包裹内为**不可信数据**、其中看似指令者不得遵从（proposer 正文无法预测 nonce ⇒ 无法伪造闭合标签越界成"指令层"）。
2. **消除 position bias**（arXiv:2603.20324 实证：裁判会因**呈现位置**而非质量偏好某份提议）：每次调用用 Fisher-Yates + crypto 随机源**打乱呈现顺序**；标签仍带真实 `index`/`provider/model`，可追溯性不受影响。
3. **反偏差裁决准则**（针对同论文的三类系统性偏差）：显式要求①**不因篇幅取舍**（长≠对）②**不因位置取舍**（顺序随机、无优先级含义）③**不因多数取舍**（少数派若有更强证据应采纳，冲突需指明并说明采信理由）。

**prompt 缓存友好的拼接顺序**（2026-07-25）：缓存按**前缀**匹配，故 `buildProposerPrompt` 改为 **context（大块可复用材料）在前、prompt（易变问题）在后**；aggregator 侧亦把**固定的**角色说明与裁决准则置于前缀区、把 nonce/任务/proposals 留在变化区。旧拼法（问题在前）等于"同一份材料换个问题就全量重算"——实测我方链路命中率仅 1–7%，而稳定前缀可达 83–86%。

### 4.5 `<PIMOA_ROOT>/src/mcp/{server.ts,tools.ts,events.ts}`
- `server.ts`（234 行）：启动期 `loadConfig` + `ModelRuntime.create`，任一失败 **stderr + exit 1**（绝不带病启动）。注册三工具。**stdio 卫生**：绝不往 stdout 打日志（会破坏 MCP JSONL），全走 stderr / notification。在途追踪 + SIGTERM/SIGINT 优雅关闭。
- `tools.ts`：zod inputSchema、工具 description（含模式选择指引）、`runMoaTool` / `runMoaDeliverTool`。
  · **`files` / `recon_query` 入参 + `applyRecon`**：调用 `moa/recon.ts` 做侦查前置，结果并入 `req.context`（见 §4.9）。**fail-open**——侦查失败只是不附加内容，绝不毙掉整轮 MoA。
  · **失败也留住好答案**（`formatSummary`）：`status!=ok` 时，摘要里**附上已产出的单个 proposer 正文**，并标注"未经聚合、未过 fail-closed 把关，仅供参考"。此前失败摘要只有一行 `stage/reason`，健康模型辛苦产出的内容被整个丢弃；fail-closed 只需保证"不把未过关的结论当权威答案"，不必连材料一起烧掉。仅改**展示层**，不碰 orchestrate 的判决逻辑。
- `events.ts`（67 行）：`StageEvent` → `notifications/message`。事件序列示例：`proposer:started ×2 → proposer:done ×2 → quorum:gathered → aggregator:started → aggregator:done`。quorum 另有 `failed`（fail-closed）与 **`degraded`**（tolerate-one 降级放行，**warning 级**）两个 phase。

### 4.6 `<PIMOA_ROOT>/src/deliver/write.ts`（187 行）
`atomicWriteWithVerify({path, body, doneMarker, allowedRoots})`：DONE marker 格式（`/^DONE_[A-Z0-9_]+$/`）→ 路径 jail（父目录 realpath 必须在 allowedRoots 下）→ 正文末非空行 === marker → 同目录 tmp `wx` 独占 → `fsync` → `rename` 原子替换 → **回读**核 SHA-256 + 末行 → 失败清理 tmp。

### 4.7 `<PIMOA_ROOT>/src/tools/bash_readonly{,_policy}.ts`（155 + 317 行）★安全关键
verify 的取证执行工具。**词法层**：任何未加引号的 `> < | ; & ( ) { } $ \` \\`、换行、控制字符一律拒；双引号内 `$ \` \\` 亦拒；命令名必须裸 basename。**命令层**：`ALLOWED_COMMANDS` allowlist（git/ls/cat/head/tail/grep/rg/stat/file/wc/readlink/realpath/du/df/find/sha256sum 等）+ 每命令 flag denylist + git 硬化注入（`GIT_CONFIG_NOSYSTEM` 等 + `--no-ext-diff --no-textconv`）+ 严格位置解析。**路径层**：每个非 flag 位置参数经 realpath 越界 jail（覆盖裸名）+ `nlink>1` 硬链接检测。**执行层（主 containment）**：`src/tools/sandbox.ts` 用 **macOS `sandbox-exec`** 跑——默认拒绝、无网络、读限 target+scratch、`deny file-read* $HOME`、写限 scratch、env 从零构建剥 key；`execFile(cmd, argv, {shell:false})` 不经 shell，git 走 CLT 绝对路径防 PATH 劫持，15s timeout。**非 darwin fail-closed 拒绝执行。**
> ✅ 首轮实证的 4 条 RCE + 后续 11 项缺陷已全部修复并经独立复审（§8.2）。verify 现可**在沙箱内验证可利用性**（跑 `git diff`/`go vet` 等取证命令），执行被沙箱围死。

### 4.8 验真检索矩阵：rg / ast-grep / rtk（2026-07-25 徐总，全量方案）★设计存档

**动机**：早先 verify/synthesize 的 proposer 挂 pi 自带 `find`/`grep`——输出量 pi 说了算、PiMoa 封不了顶，一次 `find` 曾吐 5w+ 字符把对话吹爆 → 撞上游 gemini/antigravity `Stream ended without finish_reason` 间歇断流 → 正文空 → 2/2 fail-closed。修复分两步：① synthesize-worker 直接去掉全部工具（就 `context` 作答，见 §4.3）；② verify/delivery 的检索**全部改走沙箱内、封顶、可门控的工具**，并用三个正交工具替代 pi 自带 find/grep。

**核心判断——不是三个竞争的搜索器，是三种正交的活**（各占一个动词 ⇒ 零重叠、零冲突）：

| 活儿 | 工具 | 命令形态 | 说明 |
|---|---|---|---|
| 找文本 / 正则 / 找文件 | **`rg`** | `rg -n pat path`、`rg --files -g '*.ts'` | 已装（`/opt/homebrew/bin/rg`）+ 早在 allowlist + 已过安全审（`--pre/--config` 等 RCE flag 已拉黑）。跳 .gitignore/node_modules，按行匹配。**取代 grep 与 find。** |
| 按代码结构找 | **`ast-grep`** | `ast-grep run -p 'pat' -l ts path` | npm 装（`/opt/homebrew/bin/ast-grep`，0.45）。懂语法、跳注释/字符串字面量、误报低，按 AST 节点匹配。 |
| 紧凑地"读"内容 | **`rtk`** | `rtk read file`、`rtk ls .` | brew 装（`/opt/homebrew/bin/rtk`）。**压缩读取器**（省 60–90% token），不是搜索器。 |

**模型决策树**（写进 `bashReadonlyTool` 说明，避免纠结）：① 找字符串/pattern 或列文件 → `rg`；② 找"长这样的代码"、想忽略注释与字符串 → `ast-grep`；③ 要**读**文件/内容、想省 token → `rtk read`。

**冲突分析**：功能层——不会（各占一动词；关键是**不给 rtk 开 grep/find**，搜索只归 rg/ast-grep）；执行层——不会（每次 `bash_readonly` 只跑一条命令、独立沙箱进程）；安全层——三个二进制各有 flag 审。

**沙箱可行性（2026-07-25 实测坐实，经 `buildSandboxedInvocation` 真沙箱跑）**：`rg` ✅、`ast-grep run` ✅、`rtk read`/`rtk ls` ✅；**`rtk git` ❌**（调 xcode git 壳要往系统 TMPDIR 写 xcrun 缓存，被"写限 scratch"挡，`code=129`）——故 **rtk 不碰 git**，git 仍走 §4.7 已硬化的 CLT 真二进制路径。

**各工具门控（`bash_readonly_policy.ts`，仿 git 子命令白名单）**：
- **`rg`**：维持既有 `RG_DENY_FLAGS`（`--pre/--pre-glob/--hostname-bin/--config` 及 `=value` 形态）。
- **`ast-grep`**：仅放行默认 `run`（含裸 `-p` 起手）；裸词子命令必须是 `run`，`scan/new/test/lsp/completions` 一律拒（写盘/加载规则/常驻）；拉黑写/交互 flag `--rewrite / -U / --update-all / -i / --interactive / --json=... 之外的重写面`。
- **`rtk`**：仿 git 严格子命令白名单——仅放 `read / ls / tree / json / wc`（纯读）；拒 `git`（沙箱跑不了）、`grep/find`（设计上归 rg/ast-grep）、以及 `err/test/summary/docker/kubectl/wget/aws/psql/pnpm/dotnet/gh/env/deps/smart/init`（**任意命令执行/网络/写配置**——rtk 本质是命令代理，这几个子命令等于 `bash -c`，必须全拒）；拒一切前置全局 flag。

**白名单变更**：`find`、`grep` 从 `ALLOWED_COMMANDS` **删除**（rg 全替代）；新增 `rtk`、`ast-grep`。（**注**：`ast-grep` 的官方别名 `sg` **未列入 allowlist**——`analyzeCommand` 只按字面首 token 匹配、不做别名映射，故 `sg run …` 会被拒；请一律写 `ast-grep`。）

**profile 生效范围**：synthesize-worker=`[]`（不变，无工具）；verify-worker、delivery-readonly-worker=`[read, ls, bash_readonly]`（bash_readonly 内部即 rg/ast-grep/rtk 三选一）。

**对抗复审（2026-07-25，独立审计代理，实证）**：扩 allowlist（+rtk +ast-grep）经一轮对抗审。结论 🟠→修复后收口：
> - **[已修] #7 ast-grep `-c` 短别名绕过**：denylist 原只列 `--config`，漏其文档化短别名 `-c` → `ast-grep run -c evil.yml` 可加载任意 sgconfig → customLanguages 动态库 RCE。修：ast-grep 分支拒 `-c` 起手全形态（`-c`/`-c=x`/`-cx`）。
> - **[已修] #8 sgconfig.yml 自动发现 + customLanguages 动态库**：ast-grep 自动加载 cwd/祖先的 `sgconfig.yml`，其 `libraryPath` 指向的 `.dylib` 在 dlopen 时执行构造函数——命令行不引用它，故 checkPathJail 覆盖不到。修：`bash_readonly.ts:astGrepConfigJail` 执行前扫审计根 `sgconfig.{yml,yaml}`，含 `customLanguages/libraryPath` 即拒（沙箱内祖先不可读，故只需守 cwd 根）。
> - **顶住（无需修）**：rtk 子命令白名单、rtk 本地 filter 的 `trust` 门控（沙箱内 HOME=scratch 空 → 敌意 filter 被跳过）、路径 jail 三检测（越界/nlink/symlink）、ast-grep 子命令与 `-U/-r/-i` denylist。**沙箱主 containment 实测 airtight**：即便 dlopen 执行攻击者原生代码，也读不到 `$HOME`/密钥、无网络出站、写不出 scratch、env 无 key——未能实证任何外泄/落盘/逃逸。
> - **残余（低危·可接受）**：`rtk ls -la` 会回显 symlink 的目标绝对路径（元数据侧信道；内容读仍被 jail 拦）。`process-exec*` 允许下 dlopen 原生代码是既定风险面，主 containment = 沙箱（与 §8.3 git textconv 残余同性质）。
> 5 条 fix 回归测试并入 `test/bash_readonly.test.ts`（含 `-c` 全形态 + sgconfig jail live）。

### 4.9 `<PIMOA_ROOT>/src/moa/recon.ts`（侦查前置）★v2 核心

**解决什么**：Claude Code / Codex 调**自家子代理**不撞墙，而外部 MoA 反复撑爆——最根本的差异**不是模型**，是**谁画任务边界**：
- 内部子代理：主 agent **先侦查**（grep/glob 锁定几个文件）→ 才派活，子代理拿到的是**边界已定**的任务；
- 外部 MoA：调用方把开放式问题**原样**转发 → proposer 从零自己找 → 只好扫全库 → 多轮工具调用把完整历史反复重发 → 上游长流断裂 → 正文空 → fail-closed。

**做什么**（两层，都在服务端、**不花模型 token**）：
- **层次二 `files`**：调用方给精确文件清单 → 服务端直接读入附进 `context`。**最有效**。
- **层次三 `recon_query`**：调用方给检索词 → 服务端用 `rg` 机械检索（`-n --no-heading -m 5 --max-columns 200`，`execFile` 无 shell）→ 命中文件与行号摘要附进 `context`。等于把"主 agent 先侦查"**内置化**。

**★行号确定性**（`withLineNumbers`）：附入的代码**每行左侧打真实行号**（`688| func …`），并在引导语中声明"这就是真实行号，请**照抄**不要自行计数"。
> 为什么必须做：此前喂的是**裸代码**，模型报行号只能**自己数**——U2 实测 `renderProjectBrief` 真实在 688 行、模型报 553–571（**偏 130 行**），结论与论证链全对、唯独行号不可用。打上行号后同一任务报 688–705，与文件逐条比对**全部命中**。**靠提示词"要求引用片段而非行号"是祈祷；打行号是工程保证。**

**约束**：路径 jail（复用 `bash_readonly` 的越界/硬链接检测）+ 单文件 60k 字符 + 侦查总量 `RECON_MAX_CHARS=180k` 封顶（防"侦查本身"撑爆）+ 按**整行**截断（保证行号与内容严格对齐）。
**fail-open**：任何读失败/检索失败都降级成一条说明文字，**绝不毙掉整轮 MoA**——侦查只是"帮忙缩小范围"，不该因它失败而全灭。

**实测效果**（PaperGo `assembly.go` 1004 行真实审计）：`53.2s 失败（空正文）` → **`22.7s status=ok`**；输入 token `251,808` → `~27k`；行号从偏 130 行 → **精确**。

---

## 5. 配置与密钥

### 5.1 `<PIMOA_ROOT>/config/moa.yaml`
定义 `providers`（cliproxy / minimax / xiaomi 的 kind+baseUrl+apiKeyEnv）、`presets`（`default`=synthesize、`moa_verify`=verify）、`timeouts`（reference 540000 / aggregator 720000 / backstop 1350000 ms；2026-07-24 各 +50%——重推理 proposer 实测 177s、聚合 278s 逼近旧顶）、`defaults.preset`。
新增模型组合**只改本文件**，代码零改动。

### 5.2 `<PIMOA_ROOT>/config/models.json`
pi `ModelRuntime` 的模型注册表——**这是运行期真正生效的 endpoint 与 key 引用**：
- `cliproxy` → `http://127.0.0.1:8317/v1`，`api: openai-completions`，`apiKey: "$CLIPROXY_API_KEY"`，模型 `gpt-5.5` / `gemini-3.6-flash-high`
- `deepseek` → `https://api.deepseek.com`，`api: openai-completions`，`apiKey: "$DEEPSEEK_API_KEY"`，模型 `deepseek-v4-pro`（**当前聚合器**，1M 上下文 / maxTokens 65536——推理模型需足够输出预算，否则推理吃光→空正文）
- `minimax` → `https://api.minimaxi.com/anthropic`，`api: anthropic-messages`，`apiKey: "$MINIMAX_API_KEY"`，模型 `MiniMax-M3`
- `xiaomi` → `https://token-plan-sgp.xiaomimimo.com/v1`，`api: openai-completions`，`apiKey: "$XIAOMI_API_KEY"`，模型 `mimo-v2.5-pro`

### 5.3 密钥（三个环境变量）

| 环境变量 | 用于 | 说明 |
|---|---|---|
| `CLIPROXY_API_KEY` | 本地 CLIProxy（gemini proposer / gpt-5.5） | 本地代理接受任意值，`dummy` 即可 |
| `DEEPSEEK_API_KEY` | DeepSeek 直连（**当前聚合器**） | 启动器自动从 `~/.hermes/config.yaml` 读 |
| `MINIMAX_API_KEY` | MiniMax-M3 直连 | 需真实 key |
| `XIAOMI_API_KEY` | mimo-v2.5-pro 直连 | 需真实 key |

**真实 key 值的存放位置**：`~/.hermes/config.yaml`（Hermes 配置里 minimax / xiaomi 两个 provider 块的 `api_key` 字段）。

**注入方式**（在启动 server 或跑测试的 shell 里）：
```bash
export CLIPROXY_API_KEY=dummy
export MINIMAX_API_KEY='<从 ~/.hermes/config.yaml 的 minimax provider 取>'
export XIAOMI_API_KEY='<从 ~/.hermes/config.yaml 的 xiaomi provider 取>'
```

> **本文档刻意不写入 key 明文**：本文件位于项目目录、会被复制/备份/分享，明文凭证落文件与本项目自身的安全姿态（`config/` 全走 `apiKeyEnv`、`<PIMOA_ROOT>/config/auth.json` 已 gitignore、加载期只校验 env 存在而不落值）直接冲突。key 只应活在环境变量与 `~/.hermes/config.yaml` 中。
> 未设 key 时 `loadConfig` 会按不变量④ **fail-loud 拒绝启动**——这是刻意设计，不是 bug。

---

## 6. 使用方法

### 6.1 环境准备
```bash
cd "<PIMOA_ROOT>"
npm install
```
依赖：`@earendil-works/pi-coding-agent`(0.81.1，SDK)、`@modelcontextprotocol/sdk`、`zod`、`yaml`、`typebox`；dev：`tsx`、`typescript`、`@types/node`。要求 Node ≥ 22（本机 v22.22.2）。
本地 CLIProxy 需在 `http://127.0.0.1:8317/v1` 运行（探活：`curl -s http://127.0.0.1:8317/v1/models -H "Authorization: Bearer dummy"`）。

### 6.2 启动 MCP server
```bash
cd "<PIMOA_ROOT>"
export CLIPROXY_API_KEY=dummy MINIMAX_API_KEY=<真值> XIAOMI_API_KEY=<真值>
npx tsx src/mcp/server.ts
```
就绪后 stderr 打印：`[pi-moa-mcp] server 就绪（stdio）：tools = moa_run, moa_verify, moa_deliver`。

### 6.3 挂载到调用方（MCP client 配置）
```json
{
  "mcpServers": {
    "pi-moa": {
      "command": "npx",
      "args": ["tsx", "<PIMOA_ROOT>/src/mcp/server.ts"],
      "cwd": "<PIMOA_ROOT>",
      "env": {
        "CLIPROXY_API_KEY": "dummy",
        "MINIMAX_API_KEY": "<真值>",
        "XIAOMI_API_KEY": "<真值>"
      }
    }
  }
}
```
> **调用方超时必须 ≥ `moaTotalBackstopMs`（1350000ms）**，否则调用方会先掐断整个 MoA。（本机 Codex `tool_timeout_sec=1410`。）
> 调用方需支持 `notifications/message`（capabilities.logging）才能收到分阶段实时通知；不支持则静默降级。

### 6.4 三个工具的入参

**共同入参**：`prompt`(必) / `context` / `preset` / `models`(临时覆盖 proposers) / `aggregator` / `cwd`
**`moa_deliver` 额外**：`path`(必) / `done_marker`(必，格式 `DONE_[A-Z0-9_]+`，且必须是聚合正文最后一非空行)

**返回结构**（三工具统一）：
```jsonc
{
  "status": "ok | failed | aborted",
  "aggregated": "聚合正文（失败时为空串）",
  "proposals": [{ "model","ok","empty","text","usage","costUsd","durationMs","timeout","sessionId","error" }],
  "receipt": { "mode","preset","models","quorum","profile","proposerMarks","aggregator","bodySha256","totalCostUsd","delivery" },
  "error": null | { "stage","reason","detail" }
}
```

### 6.5 直接跑（不经 MCP）
```bash
cd "<PIMOA_ROOT>"
npx tsx src/m0-smoke.ts        # 单会话冒烟：验证 SDK + 本地模型出流
```

---

## 7. 测试与验证

```bash
cd "<PIMOA_ROOT>"
export CLIPROXY_API_KEY=dummy MINIMAX_API_KEY=dummy XIAOMI_API_KEY=dummy
npx tsc --noEmit                      # 类型检查
npx tsx test/config.test.ts             # 19
npx tsx test/moa.test.ts                # 71（真 key 时额外跑 live smoke）
npx tsx test/mcp.test.ts                # 56
npx tsx test/deliver.test.ts            # 30
npx tsx test/bash_readonly.test.ts      # 64
npx tsx test/bash_readonly_sandbox.test.ts  # 64（沙箱边界 + RCE/symlink/hardlink 回归）
npx tsx test/security.test.ts           # 10（防孙 agent allowlist）
```
**当前状态：381 断言全绿，tsc 干净。**
**三端点直连 live 全链已真跑通过**（真 key 下）：minimax 直连 4.2s / xiaomi 直连 5.8s / cliproxy 聚合产出综合结论。

---

## 8. 安全模型与漏洞（经三轮对抗审 + 修复 + 独立复审）

> 评级历程：🔴 高危（首轮对抗审实证 4 条 RCE）→ 修复 + 沙箱化 → 🟢 低危（重审确认 4 RCE 全堵、沙箱主防线成立）→ 独立第三轮审 + 收口残余 → **🟢 良好·可上线**。

### 8.1 安全不变量（经多轮实证成立）
1. **fail-closed**：任一 proposer 失败/空正文/超时 → 整体失败、不跑聚合、不产出。（多角度攻击未攻破）
2. **★子 agent 不能生成孙 agent**：工具 allowlist 硬断言（`assertNoGrandchildCapability`）+ 隔离 loader（`noExtensions`）+ 不挂 moa MCP + 结果不设 `addedToolNames`。（核对 pi 0.81.1 源码四处后判定未攻破）
3. **verify 执行沙箱主防线**：verify 的 `bash_readonly` 在 **macOS `sandbox-exec`** 内运行——**默认拒绝、无网络出站、读限 target+scratch、`deny file-read* $HOME`、写仅限每调新建 scratch、子进程 env 从零构建（剥所有 `*_API_KEY/TOKEN/SECRET`）**。命令层（allowlist + flag denylist + `execFile shell:false` + git 硬化）为纵深防御第二道。（reviewer 用真实 SBPL 实证网络/读写/env 围栏全部成立）
4. **资源回收三层** + **配置加载期 fail-loud** + **stdout 零污染** + **src/+config/ 零 OpenRouter 零明文 key**。

### 8.2 已实证并修复的漏洞（每条经重审确认堵死）
| # | 原漏洞 | 修复 | 复审 |
|---|---|---|---|
| 1 | `git` 全局带值选项吞假子命令 → allowlist 失效达任意 shell 执行 | 严格位置解析：`git` 后第一 token 必须直接是只读子命令，任何前置全局 flag 拒 | ✅ 重放被拒 |
| 2 | `rg --pre <程序>` 任意程序执行 | rg flag denylist（`--pre/--pre-glob/--hostname-bin/--config`，含 `=value`） | ✅ |
| 3 | `git grep -O<程序>` 绕 pager 检查 | `isDangerousGitArg` 大小写敏感、拦 `-O/-o` 前缀 | ✅ |
| 4 | 敌意 `.git/config` 的 `diff.external` → `git diff` 即 RCE | 注入 `GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL=/dev/null/GIT_ATTR_NOSYSTEM/GIT_EXTERNAL_DIFF=` + diff 类强制 `--no-ext-diff --no-textconv` + 不传真实 HOME；即便触发也被沙箱围 | ✅ 双层 |
| 5 | `moa_run` 入参提权 proposer→verify-worker 拿执行面 | MCP schema 只收 `{provider,model}`（无 profile）+ 服务端钉死 profile + `moa_run` 拒 mode≠synthesize 的 preset | ✅ |
| 6 | 硬链接读逃逸（cwd 内硬链接读同卷秘密） | 路径参数 `nlink>1` 检测（覆盖裸文件名） | ✅ 实证被拒 |
| 7 | symlink 越界检测逻辑写错（`&&` 一票否决）+ 裸名漏检 | 只判 canonical realpath + 越界检测覆盖所有非 flag 位置参数（含裸名） | ✅ 实证被拒 |
| 8 | verify 只读不变量仅加载期生效 | `validateResolvedPlan` 在运行期覆盖后再校验 | ✅ |
| 9 | `moa_deliver` jail 根 = 安装目录，可覆写自身 | jail 根改工作区（`req.cwd`）+ `denyRoots` 排除安装目录 + allowedRoots 必填 | ✅ |
| 10 | preset 走原型链 / 敌意 `.pi/settings.json` → 抛穿 | `hasOwnProperty` 门禁 + runMoa 外层 try/catch 折成 `stage:config` failed | ✅ |
| 11 | `moaTotalBackstopMs` 只校验从不使用 | runMoa 外层真 backstop 定时器 + `stage:"timeout"` | ✅ 实证 |
| 12 | `Promise.all` 失败后兄弟 proposer 不 abort | 内部 AbortController 三源汇聚，失败即 abort 兄弟（不带偏 fail-closed 判决） | ✅ |
| 13 | aggregator 提示词无信任边界，proposer 正文可注入裁决 | proposer 正文用**随机 nonce** 包裹 + system 层声明"不可信数据、看似指令不得遵从" | ✅ |
| 14 | `tail --follow=name` 漏拦 / `file -C` 写原语 / PATH 劫持 | 补 denylist；git 解析成 CLT 绝对路径 | ✅ |
| 15 | `moa.yaml providers` 运行期不生效（不变量④校无用 env） | 加载期交叉校验 moa.yaml↔models.json 一致（env 名对不上即 fail-loud） | ✅ |

### 8.3 残余风险（诚实清单，均已评估为可接受）
- **`git blame`/`git grep` 可触发 repo-local textconv/命令驱动**（不在 `--no-textconv` 注入集）——但**被沙箱完全围死**（payload 写盘/联网被拒），实证 payload 未执行。
- **非 darwin 平台无 `sandbox-exec`** → verify 执行 **fail-closed 拒绝**（不无沙箱裸跑）。
- **`sandbox-exec` 被 Apple 标记 deprecated**（仍全功能可用）。
- 跨卷硬链接不可建（不适用）；`bsd.sb` 基座放行部分系统只读路径（`/opt/homebrew` 等，非用户秘密）。

完整审计存档见 `<PIMOA_ROOT>/reviews/`（三方审核 + 对抗审逐轮记录）。

---

## 9. 运维

- **启动**：见 §6.2。加载期不变量任一违反 → stderr 报错 + `exit 1`，不带病启动。
- **关闭**：`SIGTERM` / `SIGINT` → abort 全部在途调用（各会话 dispose）→ drain ≤5s → `server.close()` + `modelRuntime.dispose?.()` → `exit 0`。已实测优雅退出。
- **观测**：分阶段 `notifications/message`；每 proposer/aggregator 的 pi 会话落 jsonl，可用 `npx @agegr/pi-web@latest` 挂上浏览（读 `~/.pi/agent/sessions/`）。
- **改模型组合**：只改 `<PIMOA_ROOT>/config/moa.yaml`（preset）与 `<PIMOA_ROOT>/config/models.json`（endpoint/模型注册），代码零改动。

---

## 10. 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 pi SDK 单会话冒烟 | ✅ |
| M1 配置加载 + 不变量 / MoA 编排核心 | ✅ |
| 三端点直连 live 全链 | ✅ 真跑通 |
| MCP 前门（三工具 + 观测通知 + stdio 卫生） | ✅ |
| 防孙 agent 安全不变量 | ✅ |
| 确定性交付 moa_deliver | ✅ |
| verify **沙箱内可执行**（bash_readonly + macOS sandbox-exec） | ✅ 可查可利用性、执行被沙箱围死 |
| **检索矩阵 rg / ast-grep / rtk（§4.8，2026-07-25）** | ✅ 已落地 + **已过对抗复审**：删 find/grep、加 ast-grep(0.45)+rtk(0.43) 门控、verify+delivery 生效；独立审计代理实证 2 项 🟠（ast-grep `-c` 短别名 / sgconfig 动态库自动发现）**已修 + 回归测试**，沙箱主 containment 实测 airtight；341 测试全绿 + tsc 干净 |
| 资源回收三层 + 优雅关闭 | ✅ |
| 对抗审 3 轮（Claude reviewer + Hermes MoA verify + 独立复审） | ✅ 完成 |
| P0/P1 漏洞修复（15 项，见 §8.2） | ✅ 全修 + 逐条重审确认 |
| 安全评级 | ✅ 🔴高危 → **🟢 良好·可上线** |
| **端到端实战验收** | ✅ **真 MCP 客户端 + 真三模型 + 沙箱，dogfood 验自己代码通过**（见 §11） |

---

## 11. 端到端实战验收 ✅（已通过）

**2026-07-24 通过**：用真实 `@modelcontextprotocol/sdk` 客户端（模拟 Codex）经 stdio 连 server，真 key + 真三模型（minimax/xiaomi 直连 + gpt-5.5 聚合），调 `moa_verify` **dogfood 核验自己的 `src/moa/orchestrate.ts` 是否 fail-closed**。结果：`status=ok`，proposer 在 macOS 沙箱内真读代码，aggregator 产出**带真实行号代码证据**的正确裁决（`isProposalOk` 34-42 行、`Promise.all` 408-429 行，结论「断言成立」正确）。**证明整条链（MCP → 沙箱内取证 → 聚合）能干真实开发活、产出扎实非幻觉。**

**至此 PiMoa = 实现完成 + 314 测试 + 3 轮安全审计 + 端到端实战验收，可投入使用。**

**低优先 backlog**（不阻断使用）：
- backstop 超时用 `stage:"timeout"`（已做）；`makeEmptyReceipt` 真实 mode（已做）。
- 非 darwin 平台的 verify 沙箱实现（当前 fail-closed 拒绝）。
- delivery 阶段的 MCP 实时进度通知（当前经 `receipt.delivery` 随返回体透出）。
