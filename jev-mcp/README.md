# jev-mcp — a judge that knows how sure it is

PiMoa makes several models argue. But a panel of models can be wrong *together*.
`jev-mcp` is the second layer: an MCP server that asks a calibrated judgment model a
**closed-set** question and returns not just an answer, but a probability you can act on.

**English** · [中文](#中文)

## Why a probability, and why "calibrated"

A model that says "I'm 99% sure" is only useful if, across many such claims, it is right about
99% of the time. I measured it: **212 real judgments** from code review, bucketed by stated confidence.

| Stated confidence | Actually correct |
|---|---|
| ≥ 0.99 | **96.1 %** |
| 0.5 – 0.7 | 33.3 % |

The relationship is monotonic, so the number means something. The working rule follows from it:
**below 0.7, a human looks.**

## What it refuses to do (written down before anything else)

- **Images.** Given an image, it does not error — it confidently returns a plausible, wrong answer.
  So the server rejects them instead of trusting them.
- **Dates, counting, multi-step reasoning.** Known weak spots. Those go to mechanical checks, not to the judge.
- **Open questions.** It only chooses among options you give it. The option set must be closed and
  mutually exclusive — it will never answer "none of the above".

## Tools

| Tool | Purpose |
|---|---|
| `jev_judge` | Material (`state`, ≤ ~24k tokens — more material makes it *less* accurate) + a dictionary of closed questions (`choice` / `noul` / `score`). Returns the choice, its probability, and the full distribution, plus a machine-readable `## structured` block. Missing data is **omitted, never zero-filled**. |
| `jev_judge_with_template` | Same, but the questions come from a fixed template file. If the wording of a question changes, its probabilities stop being comparable across runs — so repeated judgments are pinned to templates. |
| `jev_health` | Memory, request counts, pinned model version, template list. |

The model version is pinned (`jev-1.13.0`); the floating `latest` alias is refused.

## Engineering notes

- **Go**, single binary, official `modelcontextprotocol/go-sdk` v1.8, speaks MCP `2026-07-28` only.
- **A schema bug found in the wild.** One model provider's streaming parser broke on JSON-Schema
  union types (`"type": ["string","object"]`): it sent the first key and leaked the rest as text.
  On that route **35 of 35** calls lost their arguments; every other route was 84/84. Rewriting the
  schema as `anyOf` fixed it without changing what the server accepts — a test pins the accept-set.
- Retries only on `429` and `529`; everything else is not worth burning quota on.

## Build & run

```bash
go build -o jev-mcp ./cmd/jev-mcp
cp secrets.env.example secrets.env            # contains a MOCK key — put your own in
JEV_MCP_TRANSPORT=http ./jev-mcp                  # shared instance on :8760, or stdio by default
go test ./...
```

Environment: `JEV_MCP_SECRETS_ENV` (default `secrets.env`), `JEV_MCP_TEMPLATE_DIR` (default `templates`).

## Honest status

`go test ./...` passes for the shared `mcpshell` package. In `cmd/jev-mcp`, one test
(`TestTemplateSourceAnchorsAndDescriptionTail`) currently fails — on my machine as well as here.
Each template records the exact source line range of its question wording, and the source file
has grown since; the anchors need re-pinning. The question wording itself is unchanged.
I left it red rather than weaken the test.

Built by Ziyang Xu (Jerry). MIT License.

---

<a id="中文"></a>

# 中文

PiMoa 让多个模型互相争论，可一群模型也会一起错。`jev-mcp` 是第二层：向一个**校准过的**判定模型问一个**闭集**问题，返回答案以及一个能拿来做决策的概率。212 条真实判定实测：它说 ≥0.99 时正确率 96.1%，说 0.5–0.7 时只有 33.3%，单调对应——所以规则是：**低于 0.7，交给人看**。

它的盲区写在第一页：给它图片会自信地编答案（所以服务端直接拒收图片）；日期、计数、多步推理是弱项；只在给定选项里选，永远不会说"以上都不对"。

当前状态如实写明：`mcpshell` 测试全绿；`cmd/jev-mcp` 里有一个模板行号锚点测试是红的（在我自己机器上也是红的）——问法原文没变，只是源文件变长了、锚点需要重钉。我选择让它红着，而不是削弱这个测试。作者：徐子阳（Jerry）。MIT 许可证。
