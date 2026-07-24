# Pi-MoA 代码复用审核（子代理 adc5，2026-07-23）

> 真读 pi-mcp/src 全部 + pi subagent 扩展 + taskflow + sdk.md。
> 核心结论：**fork pi-mcp 的「外壳」，但用 pi SDK（`createAgentSession`）替换它的 rpc-spawn 内核**——被并行调的那个 spawn 内核正是最该扔的三重坑。

## 复用声明核验表
| 方案声明 | 代码真相 | 成立? | 备注 |
|---|---|---|---|
| fork pi-mcp「并行调 spawn N 次」做 proposers | `runPiSession`(pi-session.ts:64) 每次 new PiClient 独立 spawn、无共享态，N 并发天然隔离 | ✅ | 并行可行，但那块 spawn 正是要推翻的 OpenRouter 写死块 |
| per-call model/tools/allowShell/allowWrites/timeout 做 profile | PiSessionOptions(21-34)+resolveTools(pi.ts:144-172)+runInput(index.ts:49-83) 全有 | ✅ | profile 机制成立 |
| verify 只读=allowWrites/allowShell:false+read/grep/find/ls | READ_TOOLS(pi.ts:40)；allowShell:false 不加 bash | ✅ | 靠"根本不给 bash"达标、非命令白名单 |
| "绝不用 OpenRouter"，fork 第一刀删写死 | 写死 **5 处联动**：pi-client.ts:108-110 + pi.ts:566-571 + pi.ts:533-540(env 只注 OPENROUTER_API_KEY) + pi.ts:67-73(loadOpenRouterKey) + pi-session.ts:81 | ⚠️ | 方向对，但"第一刀"=5 处改写+env 注入重做，**工作量中不是小** |
| §4.6 分阶段进度"复用 sendNotification" | makeProgressHandler(index.ts:174-194) 管道可用；但 dispatchProgress(pi-session.ts:337-379) **只发 tool_start/end+retry，不发 text_delta、不发阶段标记** | ⚠️ | 通知**管道**可复用；proposer streaming/quorum/aggregator 阶段信号全自建 |
| "每 proposer 落 jsonl→pi-web attach、两头兼得" | pi-mcp runPiSession noSession:false **落 jsonl**；但 §8.5 首选的 subagent 扩展 spawn 用 `--no-session`(subagent/index.ts:294) **不落** | ⚠️ | 两条复用路径持久化相反；attach 叙事只在 pi-mcp 路径成立 |
| §8.5"扇出层大概率不用自建"，subagent 是 proposer 层 | subagent parallel{tasks}(583-664,并发4)+chain{previous}(530-581)，但 `successCount/total 尽力而为`(647-663) **best-effort 非 fail-closed** | ⚠️ | 是**骨架参照**非可插组件；partial-success 与 MoA quorum 2/2 fail-closed 相反、须重写 |
| "detached 进程组 kill 树可继承"(robustness §32) | registerShutdownHandlers(pi.ts:330) 只遍历 activeChildren；activeChildren.add **仅在 runChild(pi.ts:447)**；PiClient(rpc 路径=MoA 要用的) 从不注册 | ❌ | **具体 bug**：MoA 用的 rpc-session 子进程**不在**全局 shutdown 杀树内；宿主 SIGTERM 时 detached pi 泄漏（正常/abort 有 client.close 兜、SIGTERM 没有） |
| 现成包 pi-dynamic-workflows/pi-subagents/permission-system | refs 无源码、无法验证；下载量对小众 pi 生态偏高可疑 | ⚠️ | 未证；方案已有"别盲装"caveat（诚实）但不能当成立复用 |
| taskflow"自带 best-of-N+gate"做 MoA 基座 | tournament=N 选 1（README:218），MoA=聚合全部（应对 reduce）；taskflow"中间态隔离只回 finalOutput"(44,232) **与看每条 proposer 流相反** | ⚠️ | tournament≠MoA 聚合、类别错配；透明模型逆着需求 |

## 复用清单
**直接可用（小）**：MCP 前门脚手架(McpServer+stdio+zod+classifyError, index.ts:42-172)、workspace jail(resolveWorkspace realpath+startsWith, pi.ts:127-142)、JSONL 容错(pi-client.ts:6-35)、stderr/stdout 上限、argv 安全、双超时(pi-session.ts:185-206)、429/5xx auto_retry、session 列举/cost 统计。
**要改造（中）**：删 OpenRouter 写死→per-proposer{provider,base_url,api_key_env}（5 处+buildChildEnv 多 provider）；扩 dispatchProgress 吐 text_delta+叠阶段标记；扇出借 subagent 骨架但换 fail-closed+落 jsonl；shutdown 把 rpc-session 纳入 activeChildren（补 pi-mcp 漏）。
**必须自建（中/大）**：quorum 2/2 fail-closed 聚合胶水（中）；proposer success 硬定义（extractFinalAssistantResult pi-session.ts:297 空串也 ok:true）+ 阶段 receipt（中）；分级 timeout+加载期 backstop 不变量（中）；synchronizer 确定性交付（大、已降可选）；命令级只读 allowlist（若 verify 保留 bash）。

## 基座选型建议
**推荐：fork pi-mcp 的「外壳」，用 pi SDK（createAgentSession）替换它的 rpc-spawn 内核。**
理由：pi-mcp 值钱的是 MCP 脚手架+jail+安全细节；它的 pi-invocation 内核（spawn `pi --provider openrouter --mode rpc`）恰是 OpenRouter 写死+不吐 token 流+rpc-child 逃 shutdown 那块，而**同包 SDK 原生解决三点**：ModelRuntime(sdk.md:373) 走 models.json/auth.json 多 provider（零 OpenRouter）、session.subscribe 原生 text_delta 流(270)、session.steer/followUp 原生单独干预、SessionManager.create 原生落 jsonl。方案把"fork pi-mcp"等同"复用 runPiSession spawn"，但那 spawn 是最该扔的部分。
- **不推荐 taskflow 基座**：成熟但"编译 DAG+中间态隔离+只回终值"与 MoA"看流+steer+聚合全部"两处逆行；为 2 proposer 引入编译器/IR/DSL 过配。可作远期可组合目标（MoA 做成工具挂进 taskflow DAG）。
- **不推荐从零**：脚手架/jail/杀树/超时 pi-mcp 已打磨。

## 结论
大方向靠谱；**最大误判 = 把"fork pi-mcp 并行调 spawn"当廉价复用——被并行调的 spawn 内核正是 OpenRouter 写死+不吐流+rpc-child 逃全局 kill 三重坑，同包 SDK 原生消掉**。次误判：§8.5"扇出层大概率不用自建"（subagent 是 --no-session+best-effort，与 MoA jsonl+fail-closed 相反、是重写非插拔）。
