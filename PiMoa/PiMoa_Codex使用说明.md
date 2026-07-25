# PiMoa 使用说明（给 Codex / 任意 MCP 编码 agent）

**PiMoa** 是经 MCP 暴露的 **Mixture-of-Agents** 工具：多个 proposer 模型并行给提议 → 一个 aggregator 综合定稿，封成 3 个 MCP 工具。用它拿**多模型综合意见**、**独立验真**、或**确定性落盘的报告**。

**当前模型**：proposer = `MiniMax-M3`（直连）+ `gemini-3.6-flash-high`（本地 CLIProxy）；aggregator = **`deepseek-v4-pro`（直连 api.deepseek.com）**。三者均 1M 上下文。改模型只改 `config/moa.yaml`，代码零改动。

---

## ⚡ 一分钟上手：最重要的一条

**调用时优先传 `files`（精确文件清单），这是用好 PiMoa 的关键。**

```js
moa_verify({
  prompt: "核验 X 断言是否成立，给函数名+行号证据",
  files: ["internal/assembly/assembly.go", "internal/assembly/injection.go"],  // ★ 你先定位好
  cwd: "/abs/path/to/repo"
})
```

**为什么**：不给 `files` 时，proposer 只能自己扫库找文件；每次工具调用都会**把完整对话历史重发一遍**给模型，实测一个 14k token 的任务因反复调工具膨胀到 **251k token（17.8 倍）**，直接撑爆上下文 → 正文为空 → 整轮失败。给了 `files`，服务端**预先把文件读好塞进上下文**（还自动打上真实行号），proposer 拿到的是边界已画好的任务。

不确定该给哪些文件？用 **`recon_query`**：服务端会先用 `rg` 机械检索（**不花模型 token**），把命中文件与行号摘要附进上下文。

---

## 一、挂载

已通过启动器挂好（自动从 `~/.hermes/config.yaml` 读 key，配置里零明文）。等价配置：

```jsonc
{
  "mcpServers": {
    "pi-moa": {
      "command": "<PIMOA_ROOT>/node_modules/.bin/tsx",
      "args": ["<PIMOA_ROOT>/bin/pi-moa-mcp.mts"],
      "startup_timeout_sec": 60,
      "tool_timeout_sec": 1410
    }
  }
}
```

⚠️ **调用方工具超时必须 ≥ 1350 秒**（`moaTotalBackstopMs`；本机 Codex 已设 1410）。
⚠️ 本地 **CLIProxy 需在 `http://127.0.0.1:8317/v1` 运行**（gemini proposer 走它）。

---

## 二、三个工具

| 工具 | 用途 | 子 agent 能力 |
|---|---|---|
| **`moa_run`** | 聚合：多模型提议 → 综合结论 | **无任何工具**——只就你给的 `prompt`/`context`/`files` 作答 |
| **`moa_verify`** | 验真：只读取证 + 独立核验 | 沙箱内 `read`/`ls`/`bash_readonly`（见 §四） |
| **`moa_deliver`** | 聚合/验真 **+ 确定性落盘** | 同 verify；落盘由**系统代码**原子写（非 LLM） |

**成本**：每次 = N+1 次模型调用，耗时几十秒到几分钟。**难题才调。**

---

## 三、入参

| 参数 | 说明 |
|---|---|
| `prompt` | **必填**。要问的问题 / 要核验的断言 |
| **`files`** | ★**强烈推荐**。精确文件清单（相对 `cwd` 或绝对路径，须在 `cwd` 内）。服务端读入并**自动打上真实行号**后附进上下文 |
| **`recon_query`** | 机械检索词。服务端先用 `rg` 检索（不经模型），把命中附进上下文。不确定给哪些 `files` 时用 |
| `context` | 补充上下文（贴代码片段/背景） |
| `cwd` | 工作目录。**verify 沙箱、deliver 落盘、files/recon 的根**——审哪个仓库就传其绝对路径 |
| `preset` | `default`（聚合）/ `moa_verify`（验真），缺省按工具走 |
| `models` / `aggregator` | 临时覆盖模型（`[{provider,model}]`；profile 服务端钉死） |

**`moa_deliver` 额外**：`path`（必，须在 `cwd` 内、非 PiMoa 安装目录）· `done_marker`（必，`DONE_[A-Z0-9_]+`，须是聚合正文最后一非空行）· `cwd`（必）

---

## 四、行号可以信任（重要变化）

`files` 附入的代码**每行左侧带真实行号**（`688| func renderProjectBrief(...)`），模型是**照抄**而不是自己数行。

**实证**（PaperGo `assembly.go` 1004 行真实审计）：打行号前模型报 `553–571`（真实 688，偏 130 行）；打行号后报 `688–705`，与文件逐条比对**全部命中**。

所以：**结论、论证链、行号都可直接采用**。仍建议对关键位置 `rg -n` 复核一次——这是习惯，不是因为不可信。

---

## 五、verify/deliver 的取证能力与硬限制

子 agent 只有 `read`/`ls` + 沙箱取证工具 `bash_readonly`。**检索三件套，各司其职**：

- 找文本/正则/找文件 → **`rg`**（`rg -n 模式 路径`、`rg --files -g '*.ts'`）
- 找代码结构 → **`ast-grep run -p '模式' -l ts 路径`**（模式用单引号）
- 紧凑读文件/列目录 → **`rtk read 文件`** / `rtk ls .`
- 另可 `git diff/log/show`、`stat`、`sha256sum` 等只读取证
- **`grep` 与 `find` 已下线**（分别用 rg / ast-grep）

**三道硬限制**（防撑爆，超出即拒并要求模型立即出结论）：

| 限制 | 值 | 含义 |
|---|---|---|
| 取证轮数 | **5 次/会话** | `read` 与 `bash_readonly` 共用。每轮都重发完整历史，故轮数本身要限 |
| 取证输出量 | **20 万 token/会话** | 两个工具共用一本账 |
| 侦查预读 | 18 万字符 | `files`/`recon_query` 的总量上限 |

子 agent **不能写文件、不能执行任意命令、不能生成子 agent**。要落盘用 `moa_deliver`。

---

## 六、返回结构（三工具统一）

```jsonc
{
  "status": "ok | failed | aborted",
  "aggregated": "最终结论（status!=ok 时为空串）",
  "proposals": [ { "model","ok","empty","text","usage","costUsd","durationMs","sessionId" } ],
  "receipt": { "mode","preset","quorum","proposerMarks","aggregator","bodySha256","totalCostUsd","delivery" },
  "error": null | { "stage":"config|proposer|quorum|aggregator|delivery|abort|timeout", "reason","detail" }
}
```

**怎么读**：`status==="ok"` → 用 `aggregated`。否则看 `error.stage`。运行中有分阶段进度通知，不用轮询。

**fail-closed**：任一 proposer 失败/空正文/超时 → 整体 `failed`、不产出、不降级。瞬时断流会**自动重试**。
**失败也不白跑**：失败摘要里会**附上已产出的单个 proposer 正文**（标注"未过 fail-closed 把关，仅供参考"）。

---

## 七、示例

```js
// 聚合：多模型权衡设计取舍（无工具，材料靠 context/files 给）
moa_run({
  prompt: "对比方案 A 与 B 做 proposer 隔离，从透明性/资源/复杂度权衡给综合建议",
  context: "<贴约束>", files: ["src/moa/session.ts"], cwd: "/abs/repo"
})

// 验真：核验代码断言（推荐姿势——先自己定位文件再调）
moa_verify({
  prompt: "核验 renderProjectBrief 是否未过 clampInjected 就写入最高优先分区，给函数名+行号",
  files: ["internal/assembly/assembly.go", "internal/assembly/injection.go"],
  cwd: "/abs/repo"
})

// 不确定给哪些文件时：让服务端先机械检索
moa_verify({
  prompt: "核验 fail-closed 是否真的成立",
  recon_query: "isProposalOk", cwd: "/abs/repo"
})

// 交付：产出报告并确定性落盘
moa_deliver({
  prompt: "综合评审本次改动，产出 review 报告，正文最后一行写 DONE_REVIEW",
  files: ["src/a.go","src/b.go"], cwd: "/abs/ws",
  path: "/abs/ws/review_report.md", done_marker: "DONE_REVIEW"
})
```

---

## 八、边界与最佳实践

**该做的**：
- **先自己定位文件，用 `files` 传进来**——这是避免失败的头号手段
- 一次问**一个聚焦的问题**，别给开放式的"评审整个模块"
- 大任务拆成几次调用，每次给不同的 `files`

**要知道的**：
- **verify 只看得到你给的 `cwd`**——不能联网、拿不到 key、写不出沙箱
- **贵且慢**，难题才调；简单事自己干
- 失败看 `error.stage`：`config`=配置/入参；`proposer`/`quorum`=某模型没成；`aggregator`=聚合失败；`timeout`=超预算；`delivery`=落盘校验没过

**一句话**：把文件清单给准，PiMoa 就能给你一份经 fail-closed 把关、带可信行号证据的结论；给不准，它就得自己去翻，翻着翻着就撑爆了。
