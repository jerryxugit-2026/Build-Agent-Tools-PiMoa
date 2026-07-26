# agent-tools

Two MCP servers, built because I needed them: one keeps an AI agent from
wrecking your spreadsheet, the other makes several models argue before
anything ships.

Working tools · docs in English and Chinese · formerly published under `Ai-learning`

---

## sheet_shadow — let the agent edit Excel without trusting it

An AI agent that edits a workbook directly will, sooner or later,
overwrite something it didn't understand. Sheet Shadow is an MCP bridge
that sits between the agent and the real `.xlsx`: the agent works against
a shadow of the workbook, changes are explicit and inspectable, and the
real file's integrity is the default, not a hope.

The design position: **agent access to real files should be earned per
change, not granted per session.**

```
sheet_shadow/   server, docs, examples
```

## PiMoa — mixture of agents, with a referee and a sandbox

PiMoa runs a Mixture-of-Agents pattern as an MCP server: several models
draft proposals in parallel, one model synthesizes, and the result is
**verified by execution in a sandboxed OS environment** before it counts.
Opinion is cheap; the sandbox decides.

v2 came from a lesson: an external MoA loop bolted onto a coding agent
underperforms the agent's own integrated sub-agents. Rebuilding around
that observation took a real audit task from **53 s and a wrong answer to
22.7 s and a correct one** — faster *because* the architecture got more
honest about where verification belongs.

```
PiMoa/   server, docs (EN/中文), v2 notes
```

## Why these live next to a paper about unemployment

The same profile that ships these tools also hosts
[ai-and-employment](https://github.com/jerryxugit-2026/ai-and-employment),
a working paper on what automating entry-level information work does to
the people who used to do it. That's deliberate. Building the tools and
counting their cost are the same job done honestly.

---

*One of four directions on [my profile](https://github.com/jerryxugit-2026) —
physics, art history, AI tooling, and public systems.*
