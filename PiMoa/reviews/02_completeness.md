# Pi-MoA 完整性审核（子代理 ada7，2026-07-23）

> 审核对象：DESIGN.md（最新）；对照 hermes experience.md + 01_robustness.md（重叠只补完整性角度）。
> 总评 **6/10**：骨架扎实、证据充分、诚实边界写得好、receipt/观测契约甚至比 Hermes 全——但**不能直接施工**，缺三件关键。

## 🔴 阻断

**#1 Aggregator 无 capability profile → verify 只读有洞**
§4.5 `aggregator:{provider,model}` 无 `profile` 字段；§5 三 profile 全按 proposer 写。但 Hermes §4.1/§4.2/§5：Reference 与 Aggregator **同 worker profile**。verify 的 aggregator（GPT 裁判两份只读证据）本身必须只读。robustness P0#2 只覆盖 proposer 只读、漏了 aggregator——而聚合器恰是唯一看到全部证据、最能"顺手改被审对象"的角色。
→ 配置 aggregator 必须带 `profile`；加载期校验 verify/deliver 的 aggregator.profile ∈ {verify-worker, delivery-readonly-worker}，否则 fail-loud。

**#2 verify-worker 覆盖不全，"不给 bash"反而阉割了 Hermes verify 的取证能力**
§5 verify-worker = read/grep/find/ls。但 Hermes §4.2 verify 保留 web_search/web_extract + **机械只读 terminal allowlist**（stat/file/wc/readlink/realpath/du/df/hash/受控只读 git），且把"检查 git diff/status/log、核对 hash"列为 verify 显式用途。"干脆不给 bash"= 同时删掉 verify 赖以取证的读命令 → 只会 read/grep 的 verifier 完不成 Hermes verify 一半任务。**verify 需要的是命令级只读 allowlist（照抄 Hermes 白名单），不是二元给/不给 bash**；pi-mcp 无命令白名单（robustness #8），此块必须自建、不建即功能不全。
→ verify-worker 明列只读命令白名单（对齐 Hermes §4.2），§5 标注依赖自建命令级门。

## 🟠 重要
- **#3 MCP 契约在 §4 与 §4.6 两处定义、形状不一致、无单一真源**：§4 缺 status/error/cost/duration/empty/timeout；§4 入参无 preset/mode 而 §4.5 全程用 preset。→ 以 §4.6 B 为唯一权威 schema，§4 只留链接；入参明列 preset/mode/models/aggregator/context/cwd + 优先级。
- **#4 两模式适用边界未进 MCP tool description，调用方无从选模式**：删了意图门后，调用 LLM 没信号判断该 run 还是 verify（很可能给 verify 发要跑测试的任务→空转）。→ 把 §4.1/§4.2 适用清单 + "verify 不能执行代码"写进两工具 description。
- **#5 Aggregator 无 tokens/cost/duration 出口**：它通常是最贵的一段，不落账则 §0.5#3"成本可观测"名不副实、M6 比价缺块。→ receipt 加 `aggregator:{tokens,cost,duration_ms,sha256}` + `total_cost`。
- **#6 输出无 session_id/trace 引用 →"无头也能 attach"承诺落空**：§2/§0.5#4/#6 主打 per-agent 会话可 attach/fork，但 §4.6 输出无 session_id/jsonl 路径。→ 每 proposer+aggregator 带 session_id 与路径/attach URL，`started` 通知也附上。
- **#7 §6 交付"降可选"与 Hermes 真实审计用法冲突**：Hermes 整个审计流核心就是 verify+确定性落盘+DONE+REPORT_WRITTEN（最反复硬化、最实战）。"两个口头例子"不足以推翻成体系的既有用法。→ 向徐总确认真实使用频率；至少 moa_verify+deliver 作一等组合保留。
- **#8 §2 架构图未随术语校正更新**：图里 synchronizer 仍画成核心内联落盘 stage，与"降可选、synchronizer 改指聚合"矛盾。→ 图改"聚合(synthesize)"或标"可选 moa_deliver"。
- **#9 里程碑漏 §4.6 观测契约**：徐总点名的"杀探针"功能在 M0-M6 无构建/验收。→ 新增里程碑验收"分阶段通知+失败精确到 stage+取消杀树"。
- **#10 M2 验收太软，与 robustness P0#2 冲突**："verify 下写操作被拦截"会放过 `echo x > file`。→ M2 验收硬化三条：①命令级写（重定向/sed -i/git 写）被拦 ②git diff/hash/stat 只读仍可用 ③aggregator 在 verify 下也只读。

## 🟡 建议
- **#11** §0.5 表格 #7/#8/#10 加"前提/待建"脚注；#8 改"结构上消除父模型绕过，但不保证调用方一定用本工具"。
- **#12** synthesize-worker 缺 web_extract/process，bash 含糊替代 execute_code；对齐 Hermes §4.1 或声明能力缺口。
- **#13** 加载期不变量校验无里程碑归属 → 并入 M1 验收。
- **#14** M6 平价验收无量化门槛 → 给 rubric/metric/成本延迟 pass bar。
- **#15** 长静默相位（proposer 思考 170s 无 token）像卡死（Hermes 2.1 §1 barrier 观感）→ 加周期 heartbeat 通知。
- **#16** M0 缺"验证已删 OpenRouter、多 provider 生效"验收（徐总红线）；M1 缺"空/静默 proposal fail-closed"；M3 缺 symlink 穿越验收；M5"看 3 条流"与 2-proposer 不一致需澄清；§8.5 涉安全第三方包缺"过源码+命令级只读验收"硬关。
- **#17** quorum 字段矛盾：既锁死 all 就别做成字段；要留字段支持 3-of-N 就配套 fail-closed 语义。二选一。

## 结论
补齐三件关键（🔴#1 aggregator profile、🔴#2 verify 命令级只读 allowlist、🟠#3/#4/#6 契约收敛为单一权威 schema+模式语义+session 引用）+ 与徐总对齐交付优先级（#7），并硬化 M2/M6 验收，可升 8 分进入施工。
