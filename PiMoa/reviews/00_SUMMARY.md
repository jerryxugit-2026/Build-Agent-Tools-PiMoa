# Pi-MoA 三方审核整合总表（2026-07-23）

> 三份源：`01_robustness.md`（鲁棒性）/`02_completeness.md`（完整性 6/10）/`03_reuse.md`（代码复用）。
> 本表去重合并、按优先级排，交叉标注来源。**两个需徐总拍板的决策见文末。**

## ⭐ 头号发现（改变基座判断）：pi SDK 内核 > pi-mcp 的 rpc-spawn 内核
复用审核实证：我们打算复用的 pi-mcp `runPiSession`（spawn 内核）**恰是最该扔的三重坑**——
① OpenRouter 写死 5 处（pi-client.ts:108-110 / pi.ts:566-571,533-540,67-73 / pi-session.ts:81）
② `dispatchProgress` 不吐 text_delta（拿不到 proposer 实时流）
③ rpc-session 子进程**逃过全局 kill**（pi.ts:330 只杀 activeChildren，rpc 路径从不注册 → 宿主 SIGTERM 时 detached pi 泄漏）
而**同一个 pi 包的 SDK（`createAgentSession`）原生消掉三点**：ModelRuntime 走 models.json/auth.json 多 provider（零 OpenRouter）、`session.subscribe` 原生 text_delta、`SessionManager.create` 落 jsonl、`session.steer` 原生干预。
**→ 决策 A（见文末）：基座是"fork pi-mcp 外壳 + pi SDK 内核"，还是"修好 pi-mcp 的 spawn"。**

## P0（不补即劣于 Hermes / 阻断施工）

| # | 问题 | 来源 | 修法 |
|---|---|---|---|
| P0-1 | **verify 只读三处洞**：①aggregator 无 profile 字段（聚合器可写）②verify-worker"不给 bash"反而删掉 Hermes verify 取证的只读 git/hash/stat（功能缺失）③需命令级只读 allowlist 非二元给/不给 bash | 完整#1#2 / 鲁棒 P0#2#8 | aggregator 带 profile+加载期校验只读；verify-worker 照抄 Hermes §4.2 只读命令白名单；命令级门必自建（pi-mcp 无） |
| P0-2 | **阶段分级 timeout + backstop 不变量**（会重演 Hermes backstop<per_call 被掐断） | 鲁棒 P0#1 | ✅ 已 port PaperGo A/B 组+加载期不变量进 DESIGN §4.5 |
| P0-3 | **proposer success 硬定义 + fail-closed 聚合**：pi-mcp `extractFinalAssistantResult`(pi-session.ts:297) 空串也 ok:true → aggregator 吃空 proposal 照过 quorum | 鲁棒 P0#3 / 复用 | 成功=agent_end 且正文非空且无 error；Promise.all（任一 reject 传播），不用 allSettled |
| P0-4 | **MCP 契约两处矛盾（§4 vs §4.6）无单一真源**；入参无 preset/mode | 完整#3 | 以 §4.6 B 为唯一权威 I/O schema，§4 只留链接 |
| P0-5 | **quorum 锁死 all**（配置化误配成 1 破坏 fail-closed）；且既锁死就别做成字段 | 鲁棒#2 / 完整#17 | 加载期只接受 all/=proposer 数，fail-loud；字段矛盾二选一 |

## P1（覆盖 Hermes 完整硬化面 / 完整性）

| # | 问题 | 来源 | 修法 |
|---|---|---|---|
| P1-1 | 多 provider 凭证双轨（去 OpenRouter 写死→per-proposer {provider,base_url,api_key_env}+加载期校验 env 存在） | 鲁棒 P1#5 / 复用 | **若走决策 A 的 SDK 路径，此项大半消解**（SDK 原生多 provider） |
| P1-2 | 两模式适用边界未进 tool description，调用方无从选 run/verify | 完整#4 | Hermes §4.1/§4.2 适用清单 + "verify 不能执行代码"写进 description |
| P1-3 | 输出无 session_id/trace 引用 →"无头也能 attach"落空 | 完整#6 | 每 proposer+aggregator 带 session_id+jsonl 路径/attach URL |
| P1-4 | aggregator 无 tokens/cost/duration 出口（最贵一段不落账） | 完整#5 | receipt 加 aggregator 成本 + total_cost |
| P1-5 | receipt 落每 proposer 阶段硬信号（started/completed/timeout/failed+duration+hash） | 鲁棒 P1#7 / #14 | 对齐 Hermes MOA_REFERENCE_* |
| P1-6 | 确定性交付模块（启用时）：原子写+回读 sha256+DONE+REPORT_WRITTEN+防 symlink | 鲁棒 P1#6 / 完整#7 | 复用 pi-mcp resolveWorkspace |
| P1-7 | §4.6 观测契约无里程碑 + M2/M6 验收太软 | 完整#9#10#14 | 新增观测里程碑；M2 硬化三条；M6 给量化门槛 |

## P2（新架构卫生 / 建议）
- MCP stdio 不被日志污染（走 stderr/notification）—鲁棒 P2#8
- 并发 moa_run 限流（信号量/队列）—鲁棒新风险#1
- proposer 进程泄漏：编排 finally 全 close + 补 rpc-child 纳入 shutdown（若走 spawn 路径）—鲁棒#2/复用
- 递归扇出：proposer 会话严禁挂 moa 工具—鲁棒#3
- aggregator context 超限：proposal 长度预算/截断—鲁棒#8
- 长静默 heartbeat 通知（防"看起来死了"）—完整#15
- §2 架构图随术语校正更新（synchronizer 改指聚合、交付标可选）—完整#8
- §0.5 表格 #7/#8/#10 加"前提/待建"脚注—完整#11
- synthesize-worker 补 web_extract/process 或声明缺口—完整#12
- endpoint 抖动 M0 压测（无断路器）—鲁棒拷问①
- §8.5 涉安全第三方包过源码+命令级只读验收—完整#16

## 天然规避 / 已 OK（三份共识）
- 父模型绕过：无父模型天然规避（但责任转移到调用方，须对徐总明说）
- fail-closed / 无隐式 fallback / aggregator 不改写：结构更优
- pi-mcp 白送：workspace jail 防 symlink、JSONL 容错、双超时、429/5xx 重试、argv 安全、cost 统计、MCP 脚手架

---

## 需徐总拍板的两个决策

**决策 A：基座架构**（头号发现）
- 选项①（复用审核推荐）：**fork pi-mcp 外壳（MCP 脚手架+jail+安全细节）+ pi SDK 内核驱动 proposer**。优点：原生多 provider/流/jsonl/steer、无 OpenRouter 可拆、无 rpc-child 泄漏。代价：proposer 进程内跑，**Cmux 分进程分屏透明变难**（pi-web 仍可，因落 jsonl）。
- 选项②：**修好 pi-mcp 的 spawn**（分进程、每 proposer 独立 pi 进程）。优点：进程隔离 + Cmux 分屏自然。代价：要改 5 处 OpenRouter 写死 + 扩 dispatchProgress 吐流 + 补 rpc-child kill 泄漏。
- 权衡核心：**进程内(SDK，透明偏 pi-web) vs 分进程(spawn，透明偏 Cmux)**。

**决策 B：确定性交付优先级**
- 完整性审核#7 指出：Hermes 整个审计流核心就是 verify+确定性落盘+DONE+REPORT_WRITTEN，是被替代对象里最实战的一块。徐总"两个口头例子不落盘"不足以推翻。
- 问：确定性交付是 **day-1 一等公民**（moa_verify+deliver 组合），还是**可选后置**？取决于你真实审计流是否重度依赖"审计→落盘报告"。
