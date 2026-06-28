# Sheet Shadow - Safe Excel Editing for AI Agents

**A public, open-source MCP tool for making AI agents safer around real Excel files.**
**一个面向 AI Agent 的开源 MCP 工具：让 Agent 修改真实 Excel 文件时更安全、更可控。**

> **English:** Sheet Shadow lets an AI agent work on a "shadow" model of an Excel workbook first, preview the impact, and then patch only the exact parts that should change.
> **中文：** Sheet Shadow 先让 AI Agent 在 Excel 的“影子模型”上思考和修改，确认影响范围后，只把真正需要改变的部分写回原始工作簿副本。

![Sheet Shadow principle](./docs/sheet-shadow-principle.svg)

---

## English

### The Story: Why I Built This

When I started building with AI agents, I hit a surprisingly painful wall:

**AI is getting very good at writing code, but it is still dangerously clumsy with real Excel workbooks.**

Excel is not just a grid of cells. A serious workbook may contain formulas, styles, merged cells, charts, images, conditional formatting, comments, hidden sheets, pivot tables, sparklines, embedded objects, and many invisible XML relationships. To a human, the file looks simple. To software, it is a carefully packed ZIP archive full of connected parts.

The first obvious approach is:

> "Let the agent open the file, edit the XML, and save it."

That sounds powerful, but it is risky. One wrong relationship path, one missing XML namespace, one careless rewrite of a worksheet, and the workbook may still open while charts, formulas, formatting, or hidden business logic quietly break.

That is the pain point Sheet Shadow was born from:

> **If AI agents are going to work with real office files, they need a safety layer between natural-language intent and fragile file structure.**

Sheet Shadow is that safety layer for Excel.

### What Sheet Shadow Does

Sheet Shadow reads an existing `.xlsx` file and builds a controlled in-memory shadow model. Agents can then ask safe, meaningful questions and perform semantic operations:

- read sheets, cells, formulas, metadata, and object inventories;
- query workbook data through a SQLite-like surface;
- preview changes before applying them;
- update values, formulas, formats, merges, sheet names, visibility, row/column structure, comments, validation, filters, conditional formatting, images, charts, shapes, sparklines, pivot metadata, and existing OLE package bytes;
- receive structured `completed`, `not_completed`, `warnings`, `diagnostics`, and `diff` information;
- save to a new workbook copy by patching only the touched OOXML/package parts.

It also exposes a local **MCP stdio server**, so AI agents can use it as a tool.

### Why This Matters

This project matters because Excel is everywhere.

Schools use it. Labs use it. Small businesses use it. Finance teams use it. Research teams use it. Admissions offices, logistics teams, student clubs, and families all use spreadsheets to make real decisions.

If AI agents cannot safely work with Excel, then AI is locked out of a huge part of the world's real workflow.

Sheet Shadow helps close that gap.

It makes Excel work less like "dangerous file hacking" and more like a careful conversation:

1. What does the workbook contain?
2. What exactly does the agent want to change?
3. What cells, formulas, objects, or package parts will be affected?
4. What is unsupported or risky?
5. Can we save a safe copy without damaging the rest?

That is a big deal. It is not just a developer convenience. It is a step toward AI tools that can responsibly assist with real documents, real data, and real human work.

### The Benefits

Using Sheet Shadow gives an agent:

- **Safety:** edits are semantic, not random raw XML mutations.
- **Preview:** see impact before writing.
- **Auditability:** know what changed and what did not.
- **Fidelity:** preserve untouched workbook parts as much as possible.
- **Honesty:** unsupported areas are reported instead of silently guessed.
- **MCP readiness:** usable by local AI agents through a standard tool protocol.
- **Real-world direction:** designed for existing workbooks, not toy CSV demos.

The most important benefit is confidence:

> You can let an AI agent help with a serious spreadsheet without giving it a chainsaw.

### How It Works

```text
Existing .xlsx
   -> ingest workbook package
   -> build WorkbookShadow
   -> agent queries / previews / applies semantic operations
   -> diagnostics + diff report
   -> save a new .xlsx copy by targeted patching
```

Sheet Shadow does **not** treat SQLite or MCP as the workbook truth. The truth remains the original Excel package plus the active shadow model. Saving copies the original workbook and patches only what Sheet Shadow intentionally changed.

### Quick Start

Requirements:

- macOS or Linux
- Python 3.10+
- Rust toolchain
- `maturin`

Build the Python extension:

```bash
cd sheet_shadow/sheet_shadow_core
python -m pip install maturin
maturin develop
```

Run the MCP server:

```bash
cd sheet_shadow
python sheet_shadow_mcp/server.py
```

Use the helper scripts:

```bash
python scripts/find_high_risk_workbook_candidates.py --summary-only --pretty path/to/workbooks
python scripts/audit_high_risk_workbooks.py --summary-only --pretty path/to/file.xlsx
python scripts/smoke_high_risk_candidate.py --output-dir /tmp/sheet-shadow-smoke path/to/file.xlsx
```

### Current Scope

Sheet Shadow focuses on **editing existing workbooks safely**. It is not a blank-workbook generator and it does not expose arbitrary raw XML editing as an agent-facing API.

Supported high-level areas include:

- cell value and formula updates;
- cell formatting;
- merge/unmerge;
- sheet rename and visibility;
- row/column insert, delete, and move;
- formula/table/defined-name follow behavior;
- comments, data validation, autofilter, and conditional formatting;
- drawing inventory and selected image/chart/shape edits;
- high-risk object inventory for pivot tables, sparklines, and OLE/package embeddings;
- narrow safe writes for sparkline source, pivot metadata, and existing OLE package bytes.

Boundaries are explicit. When Sheet Shadow is not confident, it should say so.

---

## 中文

### 这个项目的故事：为什么要做 Sheet Shadow

我在做 Agent 编程时，遇到了一个非常真实、也非常危险的痛点：

**AI 已经很会写代码了，但它处理真实 Excel 文件时，仍然很容易“手太重”。**

Excel 不是一个简单的格子表。一个真正有用的工作簿，里面可能有公式、样式、合并单元格、图表、图片、条件格式、批注、隐藏 sheet、数据透视表、迷你图、嵌入对象，以及大量看不见的 XML 关系。人眼看起来只是一个表格，底层其实是一个复杂的 Office 文件包。

最直接的做法是：

> “让 Agent 打开文件，改 XML，然后保存。”

这听起来很强，但非常危险。一个关系路径写错、一个 namespace 搞丢、一次粗暴重写 worksheet，都可能让文件表面还能打开，但图表、公式、格式或隐藏业务逻辑已经悄悄坏掉。

Sheet Shadow 就是从这个痛点里长出来的：

> **如果 AI Agent 要进入真实 Office 文件世界，它需要一个安全层，把自然语言意图和脆弱文件结构隔开。**

Sheet Shadow 就是 Excel 的这个安全层。

### Sheet Shadow 做什么

Sheet Shadow 会读取已有 `.xlsx` 文件，建立一个受控的内存影子模型。Agent 不直接乱改 Excel 文件，而是在这个模型上做语义操作：

- 读取 sheet、cell、formula、metadata 和对象清单；
- 通过类似 SQLite 的接口查询 workbook 数据；
- 正式修改前先 preview；
- 更新值、公式、格式、合并、sheet 名称/可见性、行列结构、批注、数据验证、筛选、条件格式、图片、图表、shape、迷你图、pivot metadata 和已有 OLE package bytes；
- 返回结构化的 `completed`、`not_completed`、`warnings`、`diagnostics` 和 `diff`；
- 保存时生成新的 workbook 副本，只 patch 真正被修改过的 OOXML/package 部件。

它还提供本地 **MCP stdio server**，所以 AI Agent 可以把它当工具调用。

### 为什么意义很大

因为 Excel 无处不在。

学校在用，实验室在用，小公司在用，财务团队在用，研究团队在用。招生、物流、项目管理、社团、家庭预算，都可能依赖 spreadsheet 做真实决策。

如果 AI Agent 不能安全处理 Excel，那 AI 就会被挡在大量真实工作流之外。

Sheet Shadow 想补上这块缺口。

它让 Excel 操作不再像“危险的文件黑客行为”，而更像一次有安全边界的对话：

1. 这个 workbook 里到底有什么？
2. Agent 想改的到底是哪一部分？
3. 哪些 cell、formula、object、package part 会受影响？
4. 哪些地方不支持或有风险？
5. 能不能保存一个安全副本，而不是破坏原文件？

这件事的意义非常大。它不只是让开发者方便一点，而是让 AI 有机会认真、可靠地进入真实文档、真实数据和真实工作。

### 使用它有什么好处

Sheet Shadow 给 Agent 带来的好处很直接：

- **更安全：** 不让 Agent 直接乱改 raw XML。
- **可预览：** 写入前先知道影响范围。
- **可审计：** 知道改了什么、没改什么。
- **更保真：** 尽量保留未触碰的 workbook 部件。
- **更诚实：** 不支持的地方明确报告，而不是假装成功。
- **MCP 友好：** 可作为本地 AI Agent 工具使用。
- **面向真实世界：** 目标是已有复杂 workbook，不是玩具 CSV demo。

最核心的收益是一句话：

> 你可以让 AI Agent 帮你处理严肃 Excel，但不必把一把电锯直接塞给它。

### 原理

```text
已有 .xlsx
   -> 读取 workbook package
   -> 建立 WorkbookShadow
   -> Agent 查询 / preview / 执行语义操作
   -> 返回 diagnostics + diff report
   -> 通过 targeted patch 保存新的 .xlsx 副本
```

Sheet Shadow 不把 SQLite 或 MCP 当作 workbook 真源。真正的来源仍然是原始 Excel package 加 active shadow model。保存时复制原始文件，只改 Sheet Shadow 明确修改过的部分。

### 快速开始

需要：

- macOS 或 Linux
- Python 3.10+
- Rust toolchain
- `maturin`

构建 Python 扩展：

```bash
cd sheet_shadow/sheet_shadow_core
python -m pip install maturin
maturin develop
```

启动 MCP server：

```bash
cd sheet_shadow
python sheet_shadow_mcp/server.py
```

使用辅助脚本：

```bash
python scripts/find_high_risk_workbook_candidates.py --summary-only --pretty path/to/workbooks
python scripts/audit_high_risk_workbooks.py --summary-only --pretty path/to/file.xlsx
python scripts/smoke_high_risk_candidate.py --output-dir /tmp/sheet-shadow-smoke path/to/file.xlsx
```

### 当前边界

Sheet Shadow 专注于**安全修改已有 workbook**。它不是从零创建 Excel 报表的工具，也不把任意 raw XML 编辑暴露给 Agent。

当前覆盖的主要方向包括：

- cell value 和 formula 更新；
- cell formatting；
- merge/unmerge；
- sheet rename 和 visibility；
- row/column insert、delete、move；
- formula/table/defined-name 跟随；
- comments、data validation、autofilter、conditional formatting；
- drawing inventory，以及部分 image/chart/shape 编辑；
- pivot table、sparkline、OLE/package embedding 的 high-risk inventory；
- sparkline source、pivot metadata、已有 OLE package bytes 的窄安全写入。

边界必须明确。Sheet Shadow 不确定时，就应该诚实地说出来。

---

## Public Note

This repository is a public learning/research release. Please test on copies of workbooks first. Do not use it as the only backup of important Excel files.

本仓库是公开学习/研究版本。请先在 workbook 副本上测试，不要把它当成重要 Excel 文件的唯一备份方案。
