# PiMoa 使用说明（给 Codex / 任意 MCP 编码 agent）

你现在可以调用 **PiMoa**——一个经 MCP 暴露的 **Mixture-of-Agents（多模型协作）** 工具。它把「2 个 proposer 模型并行给提议 → 1 个 aggregator 模型综合」封成 3 个 MCP 工具。用它来**拿多模型的综合意见**、**独立验真核查**、或**产出经确定性落盘的报告**。

当前模型组合：proposer = MiniMax-M3 + mimo-v2.5-pro（直连），aggregator = GPT-5.5（本地 CLIProxy）。

---

## 一、挂载（MCP server 配置）

把下面加进你的 MCP 配置（`command`/`args`/`cwd`/`env` 按此填）：

```json
{
  "mcpServers": {
    "pi-moa": {
      "command": "npx",
      "args": ["tsx", "<PIMOA_ROOT>/src/mcp/server.ts"],
      "cwd": "<PIMOA_ROOT>",
      "env": {
        "CLIPROXY_API_KEY": "dummy",
        "MINIMAX_API_KEY": "<从 ~/.hermes/config.yaml 的 minimax provider 取真值>",
        "XIAOMI_API_KEY": "<从 ~/.hermes/config.yaml 的 xiaomi provider 取真值>"
      }
    }
  }
}
```

⚠️ **你（调用方）的 MCP 超时必须 ≥ 900 秒**（`moaTotalBackstopMs`），否则会在 MoA 跑完前先掐断整个调用。（proposer 单模型上限 360s、聚合器 480s，两个慢 reasoning 模型 + 沙箱取证需要这个预算。）
⚠️ 本地 CLIProxy 需在 `http://127.0.0.1:8317/v1` 运行（聚合器 GPT-5.5 走它）。

挂好后你会看到 3 个工具：`moa_run`、`moa_verify`、`moa_deliver`。

---

## 二、三个工具：什么时候用哪个

| 工具 | 用途 | 什么时候用 |
|---|---|---|
| **`moa_run`** | **聚合模式**：多模型提议 → 综合结论 | 要「多个模型的综合意见」：难设计取舍、方案对比、复杂问题的多视角综合。子 agent 只读（read/grep/find/ls），**不执行代码、不写文件**。 |
| **`moa_verify`** | **验真模式**：只读取证 + 独立核验 | 要「独立、可信地核查某个断言/某段代码对不对」：审代码、核对事实、验证声明。子 agent 在 **macOS 沙箱内**可跑取证命令（`git diff`/`go vet`/`stat` 等）验证可利用性，但**无网络、写不出沙箱、读不到你的密钥**。 |
| **`moa_deliver`** | **聚合/验真 + 确定性落盘** | 要「产出一份报告并可靠写到磁盘」：系统代码原子写 + SHA-256 回读 + DONE marker 校验（不是 LLM 自己写）。 |

**成本提示**：每次调用 = N+1 次模型调用（默认 2 proposer + 1 aggregator）。**难题才调 MoA**，简单问题直接用你自己的模型，别浪费。

---

## 三、入参

**三个工具的共同入参**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 你要问的问题 / 要核验的断言 |
| `context` | | 附加上下文（贴代码片段、文件内容等） |
| `preset` | | `default`（聚合）或 `moa_verify`（验真）；缺省按工具走。moa_run 只接受 synthesize 类 preset |
| `models` | | 临时覆盖 proposer 模型集，形如 `[{provider,model},...]`（只能改 provider/model，profile 服务端钉死） |
| `aggregator` | | 临时覆盖聚合器 `{provider,model}` |
| `cwd` | | 工作目录。**verify 沙箱和 deliver 落盘都以它为根**——审哪个仓库就传哪个仓库的绝对路径 |

**`moa_deliver` 额外**：

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | ✅ | 报告落盘绝对路径（**必须在 `cwd` 工作区内**，不能是 PiMoa 安装目录） |
| `done_marker` | ✅ | 形如 `DONE_XXX`（`DONE_[A-Z0-9_]+`），且必须是聚合正文的**最后一非空行** |
| `cwd` | ✅（deliver 时） | 交付要求显式传工作区根（否则拒绝写入） |

---

## 四、返回结构（三工具统一）

```jsonc
{
  "status": "ok" | "failed" | "aborted",
  "aggregated": "聚合后的最终结论（status!=ok 时为空串）",
  "proposals": [                       // 每个 proposer 的原始产出
    { "model": "minimax/MiniMax-M3", "ok": true, "text": "...", "usage": {...}, "costUsd": 0, "durationMs": 4200, "sessionId": "..." },
    { "model": "xiaomi/mimo-v2.5-pro", "ok": true, "text": "...", ... }
  ],
  "receipt": {                         // 审计凭证
    "mode": "synthesize", "preset": "default", "quorum": "2/2",
    "proposerMarks": { "0:minimax/MiniMax-M3": "completed", "1:xiaomi/mimo-v2.5-pro": "completed" },
    "aggregator": { "model": "cliproxy/gpt-5.5", "usage": {...}, "costUsd": 0 },
    "bodySha256": "...", "totalCostUsd": 0,
    "delivery": null | { "written": true, "path": "...", "sha256": "..." }
  },
  "error": null | { "stage": "config|proposer|quorum|aggregator|delivery|abort|timeout", "reason": "...", "detail": "..." }
}
```

**怎么读**：`status==="ok"` → 用 `aggregated` 作为最终答案。`status!=="ok"` → 看 `error.stage`/`error.reason`，`aggregated` 为空、别用。运行中你会收到分阶段进度通知（proposer started/done、quorum、aggregator）——不用探针轮询。

**fail-closed 语义**：任一 proposer 失败/空正文/超时 → 整体 `failed`、不产出、不降级。要么全成，要么明确失败，**不会给你一个"看似成功"的半吊子结果**。

---

## 五、用法示例

**聚合——多模型综合一个设计取舍**：
```
moa_run({
  prompt: "对比方案 A（同步 SDK 内联）与方案 B（分进程 spawn）做 MoA proposer 隔离，从透明性/资源/复杂度权衡，给综合建议",
  context: "<贴相关约束/代码>"
})
```

**验真——独立核查一段代码的断言（沙箱内可跑取证）**：
```
moa_verify({
  prompt: "只读核验 <cwd> 下的 orchestrate.ts 是否真的 fail-closed：任一 proposer 空正文即整体失败不跑聚合。给代码证据。",
  cwd: "/absolute/path/to/repo-under-review"
})
```

**交付——产出报告并确定性落盘**：
```
moa_deliver({
  prompt: "综合评审 <cwd> 的改动，产出一份 review 报告，正文最后一行写 DONE_REVIEW",
  cwd: "/absolute/path/to/workspace",
  path: "/absolute/path/to/workspace/review_report.md",
  done_marker: "DONE_REVIEW"
})
```

---

## 六、边界与注意

- **verify 是沙箱的**：它读不到 `cwd` 以外的东西、不能联网、拿不到任何 API key、写不出沙箱。审不可信仓库是安全的，但也意味着它**只能看你给它 `cwd` 里的东西**——要它审什么就把那个目录传给 `cwd`。
- **子 agent 能力最小**：proposer/aggregator 只有 read/grep/find/ls（verify 多一个沙箱化取证命令）。它们**不能写文件、不能执行任意代码、不能再生成子 agent**。要落盘用 `moa_deliver`（系统写，不是 LLM 写）。
- **别拿它当万能**：MoA 贵（N+1 次模型调用）且慢（几秒到几十秒）。**值得多模型综合/独立验真的难题才调**；简单事情你自己干。
- **失败要看 `error.stage`**：`config`=配置/入参问题；`proposer`/`quorum`=某个提议模型失败；`aggregator`=聚合失败；`timeout`=超总预算；`delivery`=落盘校验失败。

---

## 七、一句话

**要多模型的综合判断,或独立可信的验真,就调 PiMoa;它保证要么给你一个经 fail-closed 把关的综合结论,要么明确告诉你哪一步失败——不会糊弄你。**
