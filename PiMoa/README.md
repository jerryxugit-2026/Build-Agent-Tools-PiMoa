# PiMoa

Give your coding agent a review panel: several models answer in parallel, one model synthesizes the verdict, and none of them can touch your disk.

**v2 — the "it actually finishes" release.** v1 worked on toy questions and fell over on real ones. This release is the result of chasing down *why*, with measurements at every step.

[English](#english) · [中文](#中文)

`Mixture-of-Agents` · `MCP server` · `TypeScript / Node ≥ 22` · `381 tests` · `macOS sandbox`

**Releases**: [v2](https://github.com/jerryxugit-2026/Ai-learning/releases/tag/pimoa-v2) (current) · [v1](https://github.com/jerryxugit-2026/Ai-learning/releases/tag/pimoa-v1) ([README](https://github.com/jerryxugit-2026/Ai-learning/blob/pimoa-v1/PiMoa/README.md) · [source](https://github.com/jerryxugit-2026/Ai-learning/tree/pimoa-v1/PiMoa))

---

<a name="english"></a>

# English

## What v2 fixes

v1's failure mode was consistent and infuriating: ask MoA to review a real module and it would **fail with an empty answer** — after burning several minutes. Raising timeouts didn't help. The investigation produced a chain of causes, each measured:

| Symptom | Root cause found | Fix |
|---|---|---|
| Proposer returns empty text, whole run fails | Open-ended task → model **scans the whole repo** on its own | **Recon前置**: pass `files` (exact list) or `recon_query` (server-side `rg`) |
| 14k-token task balloons to **251k tokens** | Every tool call **resends the entire history**. 17.8× amplification, measured | Hard cap: **5 tool calls** + **200k-token** forensics budget per session |
| Cited line numbers off by ~130 lines | We fed the model **bare code** — it had to *count* lines | Feed code **with real line numbers** (`688| func …`); it copies instead of counting |
| One slow model drags everything | `MiniMax-M3` emitted **10,902 chars** (others: 350–540) at 28–36s | Cap its `maxTokens` → **4,305 chars / 21s**, no empty output |
| Context overflow with no safety net | `compaction: false`, left over from a smoke test | **Turned compaction on** |
| One proposer fails → entire run wasted | Unanimous quorum amplifies single-point failure | `quorum: "tolerate-one"` for synthesize (**verify stays strictly fail-closed**) |

**Measured result on a real audit** (PaperGo `assembly.go`, 1004 lines, hunting a real prompt-injection gap):

| | v1 | v2 |
|---|---|---|
| Outcome | ❌ **failed**, empty answer | ✅ **ok** |
| Wall time | 53.2s (wasted) | **22.7s** |
| Input tokens | 251,808 | ~27k |
| Line numbers | off by 130 | **exact**, verified line by line |

## The three things that mattered most

**1. Draw the task boundary *before* the model starts.** This is the single biggest lever, and it explains why in-house sub-agents (Claude Code, Codex) don't hit this wall while external MoA does. Inside those tools, the main agent *scouts first* — greps, narrows to three files — and only then delegates. An external MoA gets the raw open-ended question and has to find everything itself. So PiMoa now does the scouting server-side, mechanically, before any model runs:

```js
moa_verify({
  prompt: "Verify X holds; cite function + line numbers",
  files: ["internal/assembly/assembly.go"],   // you already know where to look
  cwd: "/abs/path/to/repo"
})
```

**2. Don't ask a model to compute what you can hand it.** Line-number drift wasn't a model flaw — we were feeding bare code and asking it to count. Attach real line numbers and drift disappears. The general principle: *anything you want the model to be accurate about, put the answer in its input rather than asking it to derive it.*

**3. Caps beat prompts.** "Reply in under 200 words" was ignored — MiniMax wrote 6,946 characters anyway. A `maxTokens` cap wasn't. Same for tool-call rounds: the recon header says "don't scan further," models still scan; the hard limit of 5 is what actually holds.

## What else changed

- **Search rebuilt**: `grep`/`find` retired in favour of three tools with distinct jobs — **`rg`** (text), **`ast-grep`** (code structure), **`rtk`** (compact reads). Each gated inside the sandbox; `rtk`'s command-proxy subcommands and `ast-grep`'s rewrite/config flags are denied.
- **Aggregator de-biased**: proposal order is now **randomly shuffled** each call, plus explicit rules against length/position/majority bias.
- **Prompt-cache friendly**: large reusable material moved *before* the volatile question. (Measured 83–86% cache hits on stable prefixes; our own chain was at 1–7% because the order was backwards.)
- **Honest receipts**: degraded runs report `2/3 (degraded)`, never a fake `3/3`. Failed runs now also surface whatever a healthy proposer produced, clearly marked as unvetted.
- **Aggregator swapped** to `deepseek-v4-pro` (direct, 1M context, 9.5s).
- **Cache observability**: `cacheRead`/`cacheWrite` now reported — a low hit rate is a signal the prefix got broken.

## Does it find real bugs?

We pointed v2 at **its own source code**. It found a defect I had written and the unit tests had missed:

> The `tolerate-one` degradation path shared one `AbortController` with the sibling-abort logic, so *any* proposer failure aborted the aggregator before it started. Degradation was dead on arrival. The tests missed it because the mock didn't respect `signal`.

Two proposers **disagreed** — one called it fatal, the other found no issue. The aggregator sided with the one carrying the stronger evidence chain. It was right. That disagreement *is* the value: a single model would have given one answer with no signal that it was contested. Fixed, plus signal-aware tests to close the blind spot.

A second run audited **code-vs-documentation consistency** and produced four findings — all four verified true, all four fixed.

---

## Primer: what is MoA?

MoA comes from Together AI's 2024 paper *[Mixture-of-Agents Enhances Large Language Model Capabilities](https://arxiv.org/abs/2406.04692)*. The observation: LLMs are collaborative — a model produces a better answer when it can see other models' answers, even worse ones.

```
      your question
            │
    ┌───────┴───────┐        Layer 1: proposers
    ▼               ▼        answer independently, blind to each other
 model A         model B
    │               │
    └───────┬───────┘
            ▼                Layer 2: aggregator
       aggregator            reads every proposal, synthesizes the verdict
            │
            ▼
       final answer
```

It works because different models' errors are largely uncorrelated. If A hallucinates a nonexistent API, B probably won't hallucinate the *same* one — and an aggregator facing two contradictory claims goes looking for the one backed by an actual line number. **Disagreement is signal.**

PiMoa adds: **fail-closed** (any proposer failing kills the run — no plausible-looking half-answers), and **verify mode** (proposers gather read-only evidence inside a sandbox rather than guessing).

## Usage

**Requirements**: Node ≥ 22 · macOS (verify's sandbox needs `sandbox-exec`; other platforms fail closed rather than running unsandboxed) · 3 model endpoints (OpenAI- or Anthropic-compatible).

```bash
git clone https://github.com/jerryxugit-2026/Ai-learning.git
cd Ai-learning/PiMoa && npm install
```

Point `config/models.json` and `config/moa.yaml` at your own models (env-var names only — never literal keys), then mount:

```jsonc
{
  "mcpServers": {
    "pi-moa": {
      "command": "/abs/path/to/PiMoa/node_modules/.bin/tsx",
      "args": ["/abs/path/to/PiMoa/bin/pi-moa-mcp.mts"],
      "tool_timeout_sec": 1410
    }
  }
}
```

⚠️ Client timeout must be **≥ 1350s** (`moaTotalBackstopMs`).

**Three tools**: `moa_run` (synthesize — proposers get **no tools**, they answer from what you give them) · `moa_verify` (read-only forensics in the sandbox) · `moa_deliver` (either, plus an atomic write verified by SHA-256 + DONE marker, performed by system code rather than the model).

**Key inputs**: `prompt` (required) · **`files`** (strongly recommended — exact file list) · **`recon_query`** (server-side `rg` when you're unsure which files) · `cwd` · `context` · `preset` · `models`/`aggregator` overrides.

## Security model

1. **Fail-closed** — any proposer failing/empty/timing out kills the run. `tolerate-one` is opt-in, synthesize-only, requires ≥2 successes, and is always labelled in the receipt.
2. **No grandchild agents** — hard tool allowlist + isolated loader; MoA's own MCP is never handed to a child.
3. **OS sandbox is the primary containment** — `sandbox-exec` with deny-by-default, no network, reads limited to the target, `deny file-read* $HOME`, writes limited to scratch, child env stripped of keys. Command allowlist and flag denylists are defence in depth.
4. **Deterministic delivery** — path jail → exclusive tmp → `fsync` → atomic `rename` → read-back verifying SHA-256 and the trailing marker.

Three rounds of adversarial review closed 15 findings including 4 demonstrated RCEs; a fourth round on the new search tools found 2 more (an `ast-grep` `-c` alias bypass and `sgconfig.yml` dynamic-library autoloading), both fixed. Details in [`reviews/`](./reviews) and the architecture doc.

## Standing on whose shoulders

| Source | What was taken |
|---|---|
| [Mixture-of-Agents](https://arxiv.org/abs/2406.04692) (Together AI, 2024) | The proposer/aggregator structure itself |
| [Rethinking MoA](https://arxiv.org/abs/2502.00674) (ICLR 2025) | Quality outweighs diversity (α ≫ β across 200+ experiments) — kept the proposer pool small and strong instead of chasing variety |
| [When Agents Disagree: The Selection Bottleneck](https://arxiv.org/abs/2603.20324) (2026) | The aggregator's **position / verbosity / majority** biases — motivated shuffling proposal order and adding explicit anti-bias rules |
| [RMoA](https://arxiv.org/abs/2505.24442) (ACL 2025 Findings) | Diversity selection & residual compensation — evaluated, **deliberately not adopted**: it targets multi-layer MoA and pays off at 5+ proposers, not at 2 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `createAgentSession` SDK, multi-provider abstraction, per-session tool allowlists — **runtime dependency** |
| [Baseline-Systems/pi-mcp](https://github.com/Baseline-Systems/pi-mcp) | The shape of wrapping Pi sessions as MCP tools, workspace jail, cost accounting — architectural blueprint (not forked: hardcodes OpenRouter, doesn't stream, leaks processes) |
| [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) | tree-sitter command-permission parsing — security reference for the stricter read-only variant |
| [Hermes MoA](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents) (NousResearch) | Its `partial tolerance` design prompted `tolerate-one`; its prompt-cache preservation prompted the cache audit. Also the origin of the safety invariants (fail-closed, unanimous quorum, receipts, deterministic write + read-back) |
| [ripgrep](https://github.com/BurntSushi/ripgrep) · [ast-grep](https://github.com/ast-grep/ast-grep) · [rtk](https://github.com/rtk-ai/rtk) | The three-tool search matrix replacing grep/find |

## Honest limitations

- **Non-macOS**: verify's command execution is refused outright. Linux sandbox is on the backlog. `sandbox-exec` is deprecated by Apple (still fully functional).
- **MoA is expensive and slow** — N+1 model calls. Save it for problems that genuinely benefit from cross-model checking.
- **Verify only sees the `cwd` you hand it** — that's the price and the point of the sandbox.
- **Line numbers are reliable now, but still worth spot-checking** — habit, not distrust.
- **Developer-side tool** — designed for you and your colleagues, not for exposure on the open internet.

---

<a name="中文"></a>

# 中文

## v2 解决了什么

v1 的失败模式很一致也很气人：让 MoA 审一个真实模块，它会**返回空正文、整轮失败**——而且是在烧掉几分钟之后。调高超时完全没用。这次把根因一条条挖出来了，每条都有实测：

| 症状 | 挖到的根因 | 修法 |
|---|---|---|
| proposer 空正文，整轮失败 | 开放式任务 → 模型**自己扫全库** | **侦查前置**：传 `files`（精确清单）或 `recon_query`（服务端 `rg`） |
| 14k token 的任务膨胀到 **251k** | 每次工具调用都**重发完整历史**，实测 **17.8 倍** | 硬限制：**5 轮**工具调用 + **20 万 token** 取证预算 |
| 引用行号偏 130 行 | 我们喂的是**裸代码**，模型只能**自己数行** | 喂**带真实行号**的代码（`688| func …`），让它照抄而非计数 |
| 一个慢模型拖垮全部 | `MiniMax-M3` 吐 **10,902 字符**（别人 350–540），28–36s | 给它套 `maxTokens` → **4,305 字符 / 21s**，且不空正文 |
| 上下文涨爆没有兜底 | `compaction: false`，冒烟测试期关的一路带到生产 | **打开 compaction** |
| 一个 proposer 挂，整轮白跑 | 全票制把单点失败率平方级放大 | synthesize 可配 `quorum: "tolerate-one"`（**verify 恒 fail-closed**） |

**真实审计实测**（PaperGo `assembly.go`，1004 行，查一个真实的 prompt 注入缺口）：

| | v1 | v2 |
|---|---|---|
| 结果 | ❌ **失败**，空正文 | ✅ **ok** |
| 耗时 | 53.2s（白跑） | **22.7s** |
| 输入 token | 251,808 | ~27k |
| 行号 | 偏 130 行 | **精确**，逐条核对无误 |

## 最要紧的三件事

**1. 在模型开跑之前，先把任务边界画好。** 这是最大的一根杠杆，也解释了为什么 Claude Code / Codex 调自家子代理不会撞墙、外部 MoA 却会：在那些工具里，主 agent **先侦查**——grep 一遍、锁定三个文件——然后才派活；外部 MoA 拿到的是原始的开放式问题，只能自己去翻。所以 PiMoa 现在把侦查放到服务端、机械地做完，再让模型开跑：

```js
moa_verify({
  prompt: "核验 X 是否成立，给函数名+行号",
  files: ["internal/assembly/assembly.go"],   // 你本来就知道该看哪
  cwd: "/abs/path/to/repo"
})
```

**2. 能直接给的东西，别让模型算。** 行号漂移不是模型的毛病——是我们喂了裸代码却要它数行。打上真实行号，漂移就消失了。推广开来就是：**凡是希望模型准确的东西，把答案放进它的输入里，而不是要求它推导出来。**

**3. 硬限制胜过提示词。** "200 字以内"被无视了——MiniMax 照样写 6,946 字符；`maxTokens` 则不会被无视。工具轮数同理：侦查材料的开头写着"别再扫了"，模型照扫，真正管用的是 5 轮的硬上限。

## 其它改动

- **检索重建**：`grep`/`find` 下线，换成三个各司其职的工具——**`rg`**（文本）、**`ast-grep`**（代码结构）、**`rtk`**（紧凑读）。三者都在沙箱内受门控：`rtk` 的命令代理类子命令、`ast-grep` 的 rewrite/config flag 一律拒。
- **聚合器去偏**：每次调用**随机打乱**提议顺序，另加明确的反篇幅/位置/多数偏差准则。
- **缓存友好**：大块可复用材料移到易变问题**之前**。（实测稳定前缀能命中 83–86%，而我们自己的链路只有 1–7%——因为顺序反了。）
- **诚实收据**：降级时报 `2/3 (degraded)`，绝不谎报 `3/3`。失败时也会把健康 proposer 已产出的正文透出，并明确标注"未过把关"。
- **聚合器换成** `deepseek-v4-pro`（直连、1M 上下文、9.5s）。
- **缓存可观测**：新增 `cacheRead`/`cacheWrite`——命中率低就是前缀被破坏的信号。

## 它真能找出 bug 吗

我们让 v2 审**它自己的源码**。它找出了一个我写的、单测也没抓到的缺陷：

> `tolerate-one` 降级路径与"兄弟 abort"共用同一个 `AbortController`，导致**任何** proposer 失败都会让 aggregator 在启动前就被 abort——降级机制从落地那天起就是废的。单测没抓到，是因为 mock 不检查 `signal`。

两个 proposer **给出了相反结论**——一个判致命，一个判无问题。聚合器采信了证据链更硬的那一方，事后证明是对的。**这个分歧本身就是价值**：单模型只会给你一个答案，而且不会告诉你这个答案有争议。缺陷已修，并补了 signal-aware 测试堵住盲区。

第二轮审的是**代码与文档一致性**，四条发现，逐条验证全部属实、全部已修。

---

## 科普：什么是 MoA

MoA 出自 2024 年 Together AI 的论文 *[Mixture-of-Agents Enhances Large Language Model Capabilities](https://arxiv.org/abs/2406.04692)*。核心观察：大模型具有协作性——当一个模型能看到其他模型的答案时，它给出的答案更好，即使那些答案更差。

```
        你的问题
           │
    ┌──────┴──────┐            第 1 层：Proposers
    ▼             ▼            各自独立作答，互相看不见
 模型 A         模型 B
    │             │
    └──────┬──────┘
           ▼                    第 2 层：Aggregator
      聚合器模型                 读完所有提议，综合出最终结论
           │
           ▼
       最终答案
```

之所以有效，是因为不同模型的错误大概率不相关。A 幻觉出一个不存在的 API，B 大概率不会幻觉出同一个；聚合器面对两份互相打架的说法，就会去找哪一份有真实行号支撑。**分歧就是信号。**

PiMoa 在此之上加了：**fail-closed**（任一 proposer 失败即整轮失败，不给看似合理的半吊子答案）、**验真模式**（proposer 在沙箱内取真证据，而不是猜）。

## 使用

**环境**：Node ≥ 22 · macOS（verify 沙箱依赖 `sandbox-exec`；其它平台 fail-closed 拒绝执行，绝不裸跑）· 3 个模型端点（OpenAI 或 Anthropic 兼容）。

```bash
git clone https://github.com/jerryxugit-2026/Ai-learning.git
cd Ai-learning/PiMoa && npm install
```

把 `config/models.json` 和 `config/moa.yaml` 指向你自己的模型（**只写环境变量名，绝不写明文 key**），然后挂载：

```jsonc
{
  "mcpServers": {
    "pi-moa": {
      "command": "/abs/path/to/PiMoa/node_modules/.bin/tsx",
      "args": ["/abs/path/to/PiMoa/bin/pi-moa-mcp.mts"],
      "tool_timeout_sec": 1410
    }
  }
}
```

⚠️ 调用方超时必须 **≥ 1350 秒**（`moaTotalBackstopMs`）。

**三个工具**：`moa_run`（聚合——proposer **无任何工具**，只就你给的内容作答）· `moa_verify`（沙箱内只读取证）· `moa_deliver`（前两者 + 由**系统代码**完成的原子写，经 SHA-256 与 DONE marker 双重校验，不是模型写的）。

**关键入参**：`prompt`（必填）· **`files`**（强烈推荐——精确文件清单）· **`recon_query`**（不确定给哪些文件时，服务端用 `rg` 预检索）· `cwd` · `context` · `preset` · `models`/`aggregator` 临时覆盖。

## 安全模型

1. **fail-closed** —— 任一 proposer 失败/空正文/超时即整轮失败。`tolerate-one` 需显式开启、仅 synthesize 可用、要求成功数 ≥2，且**必定在 receipt 里标注**。
2. **子 agent 不能生成孙 agent** —— 工具白名单硬断言 + 隔离 loader；MoA 自己的 MCP 绝不挂给子会话。
3. **OS 沙箱是主防线** —— `sandbox-exec` 默认拒绝、无网络、读限被审目录、`deny file-read* $HOME`、写限 scratch、子进程 env 剥密钥。命令白名单与 flag 黑名单是纵深防御第二道。
4. **确定性交付** —— 路径 jail → 独占 tmp → `fsync` → 原子 `rename` → 回读核对 SHA-256 与末行 marker。

三轮对抗审修掉 15 项（含 4 条实证 RCE）；针对新检索工具的第四轮又找出 2 条（`ast-grep` 的 `-c` 短别名绕过、`sgconfig.yml` 动态库自动加载），均已修复。细节见 [`reviews/`](./reviews) 与架构文档。

## 站在谁的肩膀上

| 来源 | 借鉴了什么 |
|---|---|
| [Mixture-of-Agents](https://arxiv.org/abs/2406.04692)（Together AI, 2024） | proposer/aggregator 两层结构本身 |
| [Rethinking MoA](https://arxiv.org/abs/2502.00674)（ICLR 2025） | 质量权重远大于多样性（200+ 实验，α ≫ β）——据此**保持 proposer 少而强**，不盲目追求模型多样性 |
| [When Agents Disagree: 选择瓶颈](https://arxiv.org/abs/2603.20324)（2026） | 聚合器的**位置/篇幅/多数**三类偏差——据此随机打乱提议顺序并加入显式反偏差准则 |
| [RMoA](https://arxiv.org/abs/2505.24442)（ACL 2025 Findings） | 多样性选择与残差补偿——**评估后刻意未采用**：它面向多层 MoA、在 5+ proposer 才有收益，2 个时不划算 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `createAgentSession` SDK、多 provider 抽象、逐会话工具白名单——**运行时依赖** |
| [Baseline-Systems/pi-mcp](https://github.com/Baseline-Systems/pi-mcp) | 把 Pi 会话包成 MCP 工具的形态、工作区 jail、成本统计——架构蓝本（未 fork：写死 OpenRouter、不吐流、有进程泄漏） |
| [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) | tree-sitter 命令权限解析——更严格只读版本的安全参考 |
| [Hermes MoA](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents)（NousResearch） | 它的 `partial tolerance` 促成了 `tolerate-one`；它对 prompt 缓存的保护促成了本轮缓存审计。也是全部安全不变量的来源（fail-closed、全票 quorum、收据、确定性写+回读） |
| [ripgrep](https://github.com/BurntSushi/ripgrep) · [ast-grep](https://github.com/ast-grep/ast-grep) · [rtk](https://github.com/rtk-ai/rtk) | 取代 grep/find 的检索三件套 |

## 诚实的边界

- **非 macOS**：verify 的命令执行直接拒绝，Linux 沙箱在 backlog。`sandbox-exec` 已被 Apple 标记 deprecated（目前功能完整）。
- **MoA 又贵又慢** —— N+1 次模型调用，留给真正值得多模型交叉的难题。
- **verify 只看得到你给的 `cwd`** —— 这是沙箱的代价，也正是它的意义。
- **行号现在可信了，但仍建议抽查** —— 这是习惯，不是不信任。
- **开发侧工具** —— 给自己和同事用，没考虑暴露在公网上。

---

## Version history

| Release | State | What it was |
|---|---|---|
| **[v2](https://github.com/jerryxugit-2026/Ai-learning/releases/tag/pimoa-v2)** | current | Made it finish on real work — recon前置, budgets, line numbers, de-biased aggregator. See the top of this README. |
| [v1](https://github.com/jerryxugit-2026/Ai-learning/releases/tag/pimoa-v1) | superseded | First public cut: three MCP tools, fail-closed, macOS sandbox, 3 adversarial review rounds (4 RCEs fixed). Security was sound; **real workloads were not** — that's what v2 fixes. <br>📖 [v1 README](https://github.com/jerryxugit-2026/Ai-learning/blob/pimoa-v1/PiMoa/README.md) · 📁 [v1 source](https://github.com/jerryxugit-2026/Ai-learning/tree/pimoa-v1/PiMoa) |

每个 release 都带完整源码快照（Source code zip/tar.gz），可直接下载当时的整个项目。
Every release ships a full source snapshot, so any earlier version stays reachable and runnable.

---

## License / 许可

Part of [Ai-learning](https://github.com/jerryxugit-2026/Ai-learning). See the repository [LICENSE](../LICENSE).
Third-party projects listed above remain under their own licenses.
