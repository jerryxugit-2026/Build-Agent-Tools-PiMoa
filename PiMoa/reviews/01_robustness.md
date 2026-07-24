# Pi-MoA 鲁棒性审核（子代理 A70c，2026-07-23）

> 审核对象：DESIGN.md；对照 `hermes experience.md` 全文 + pi-mcp 源码逐行。
> 结论一句话：离「不劣于 Hermes」还差 4 件关键 —— ① 阶段分级 timeout + backstop 不变量 ② verify 命令级机械只读真实落实 ③ proposer success 硬定义 + fail-closed 聚合 ④ 多 provider 凭证双轨注入。

## 一、Hermes 硬化 → 方案覆盖对照（19 项）

| # | Hermes 硬化项 | 解决的故障 | 覆盖 | 缺口 |
|---|---|---|---|---|
| 1 | fail-closed / no fallback | 假成功、父模型兜底 | ✅ | §0.5#8 无父模型，结构更强 |
| 2 | 严格 quorum 2/2 | 部分结果当完整 | ⚠️ | §4.5 quorum 可配置→误配成 1 破坏 fail-closed；须加载期锁死 all |
| 3 | 无隐式 fallback/轮换/canary | 不可复现、降质 | ✅ | 方案无自动换模型 |
| 4 | Aggregator 正文直返不改写 | 父模型污染 | ✅ | §4 不变量2 |
| 5 | 运行时机械门控（防绕过） | 父模型偷懒绕过 | ✅结构规避 | 责任转移到调用方 |
| 6 | 完成 receipt | 无法审计 | ⚠️ | 缺每 proposer 阶段状态 |
| 7 | 能力 profile 机械化 | 越权写/执行 | ⚠️ | tools:[] ≠ 机械强制 |
| 8 | **verify 命令级只读 allowlist** | 审计污染被审对象、重定向副作用 | ⚠️ | **最大安全缺口**：tools:[] 不拦 bash 写重定向；pi-mcp 只能全给/全不给 bash，无命令白名单 |
| 9 | 确定性交付（原子写+sha256回读+DONE+receipt） | LLM 假称写了/写错/写假 | ⚠️降可选 | pi-mcp allowWrites 是 LLM 自己写、非系统确定性写 |
| 10 | 交付路径白名单 + 防穿越/symlink | 路径逃逸 | ⚠️ | §6 未明确 symlink 防护；可复用 pi-mcp resolveWorkspace(realpath+jail) |
| 11 | 交付降级 delivery-readonly-worker | 交付阶段副作用 | ✅ | §6.2 |
| 12 | **阶段分级 timeout 且真正传入**（ref180s/agg240s） | 级联超时、子超时被全局掩盖 | ❌ | **重大缺口**：只有全局 300s，无分级、无 backstop>各阶段和 |
| 13 | 硬信号完成契约（四项齐全才成功） | 假成功误判 | ⚠️ | 无 proposer success 硬定义；空正文 ok:true 照过 quorum |
| 14 | 阶段诊断标记 MOA_REFERENCE_* | 无法定位卡点 | ⚠️ | receipt 未落每 proposer 阶段 |
| 15 | profile 求交削空修复 | profile 被静默清空 | ✅结构规避 | 换 subagent 底座需复验 |
| 16 | subagent 不递归 re-arm | 递归扇出爆炸 | ⚠️ | 新形态：proposer 会话若挂 moa 工具→moa_run 内再调 moa_run |
| 17 | 异常 fail-closed 分类 | 异常被吞假成功 | ⚠️ | 聚合须 Promise.all（任一 reject 传播），不能 allSettled 吞 |
| 18 | 加载期不变量强校验 | 配置错运行时才炸 | ✅ | §4.5 有 + pi-mcp zod |
| 19 | 上游 401/凭证双轨路由 | 小米401、异构协议握手 | ⚠️ | pi-mcp 写死 openrouter 单 key（pi-client.ts:110/pi.ts:539），fork 必改 |

## 二、pi-mcp 已提供（可继承）vs 必须自建

**可继承**：硬 timeout 双保险(session 300s+绝对30min，pi-session.ts:185-206)/abort 传播/detached 进程组 kill 树(pi.ts:330-361)/stderr64KB·stdout1MB 上限/JSONL 容错(pi-client.ts:6-35)/429·5xx auto_retry(pi-session.ts:212)/workspace jail realpath+startsWith(pi.ts:127-142)/env allowlist 9项(pi.ts:47-57)/argv 安全/进程退出 reject 全 pending/成本统计。

**必自建**：① 命令级只读 allowlist ② 确定性交付 ③ quorum/fail-closed 多会话聚合 ④ 阶段分级 timeout+backstop ⑤ receipt+硬信号完成契约 ⑥ 多 provider 凭证双轨。

## 三、必补清单（按优先级）

**P0（不补即劣于 Hermes）**
1. **阶段分级 timeout + backstop 不变量**（拷问②会重演）：config 加 `reference_timeout_ms`/`aggregator_timeout_ms`；编排总超时=二者和×1.2；MCP client 超时≥编排总超时。
2. **verify 机械只读真落实**：verify 首选直接不给 bash（`allowShell:false`，只 read/grep/find/ls）；若给 bash，M2 permission-system/gondolin 必须过「命令级 allowlist」验收，不能只测 write 工具被拦。
3. **proposer success 硬定义 + fail-closed 聚合**：成功=agent_end 且正文非空且无 error；Promise.all 语义任一失败即整体 throw；receipt 记每 proposer ok/tokens/timeout。（pi-mcp extractFinalAssistantResult 会空串 ok:true）
4. **quorum 锁死**：加载期只接受 all，拒绝更小值 fail-loud。

**P1**
5. **多 provider 凭证双轨**：fork 去 openrouter 写死→per-proposer `{provider,base_url,api_key_env}`；加载期校验 env 存在。
6. **确定性交付模块**（启用时）：原子写+回读 sha256+DONE+REPORT_WRITTEN，复用 resolveWorkspace 防 symlink。
7. **receipt 落阶段硬信号**：每 proposer started/completed/timeout/failed+duration+hash。

**P2**
8. **MCP stdio 不被日志污染**：server 绝不往 stdout 打日志，走 stderr / MCP logging（沿用 pi-mcp sendNotification）。

## 四、新架构独有风险
1 并发 moa_run 无上限→加信号量/队列。2 proposer 进程泄漏→编排 finally 全 close。3 递归扇出→proposer 会话严禁挂 moa 工具。4 aggregator 吃空 proposal→见 P0#3。5 api_key_env 缺失运行时才炸→加载期校验。6 endpoint 抖动→无断路器，M0 压测。7 event 数组无上限膨胀→只留最终 message。8 aggregator context 超限→proposal 长度预算/截断。

## 五、三处拷问结论
- ① 代理抖动 85-97% failover：⚠️ 本文件无此直接记录（最接近 MoA2.1 §根因1 CliRelay 上游失效、§10 Xiaomi 180s 瞬态）；不会天然规避，M0 需压测。
- ② 聚合器 backstop<per_call 被掐断：❌ **会重演**，最该补（P0#1）。
- ③ 父模型绕过：✅ 天然规避，但责任转移到调用方（本系统无法强制调用方一定调 moa_run，须对徐总明说）。
