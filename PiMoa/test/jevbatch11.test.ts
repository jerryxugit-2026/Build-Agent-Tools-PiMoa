import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { premiseRound, type JevClientLike, type RunSessionFn } from "../src/moa/jevcheck.js";
import type { FindingCheck, FindingRecord } from "../src/moa/types.js";

const script = fileURLToPath(new URL("../tools/gap-ledger.py", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "jevbatch11-"));
try {
  const spool = join(tmp, "spool"), consumer = join(tmp, "consumer");
  mkdirSync(spool); mkdirSync(consumer);
  const ids = ["P1/F1:fact0:locate-fail", "P1/F2:fact0:locate-fail",
    "P1/F3:fact0:locate-fail", "P1/F4:fact0:locate-fail"];
  const receipt = (stamp: string, records: Array<{ id: string; kind: string; path: string; need: string[] }>) =>
    writeFileSync(join(spool, `${stamp}-moa_verify-fixture.md`),
      `## receipt\n\n\`\`\`json\n${JSON.stringify({ gaps: { records } })}\n\`\`\`\n`);
  const gap = (id: string) => ({ id, kind: "locate-fail", path: "src/x.ts:1", need: [`补 ${id}`] });
  receipt("20261020T000000", [gap("P9/F1:fact0:locate-fail")]);
  receipt("20261021T000000", [gap(ids[0]), gap(ids[1])]);
  receipt("20261022T000000", [gap(ids[2])]);
  receipt("20261023T000000", [gap(ids[3])]);
  writeFileSync(join(consumer, "PM-evidence.md"), `${ids[0]} 已解决\n\n\n\n\n${ids[1]} 已引用、待核验\n\n\n\n\n${ids[2]} 仍缺材料\n`);
  const args = [script, "--spool-dir", spool, "--consumption-glob", join(consumer, "PM-*.md"), "--pending"];
  const query = (...flags: string[]) => JSON.parse(execFileSync("python3", [...args, ...flags], { encoding: "utf8" }));
  const initial = query();
  assert.equal(initial.lastRounds, 5);
  assert.equal(initial.spoolFilesScanned, 4);
  assert.deepEqual(initial.errors, []);
  assert.deepEqual(initial.pending.map((r: { id: string }) => r.id),
    [ids[3], ids[1], "P9/F1:fact0:locate-fail"]);
  assert.deepEqual(initial.pending.map((r: { pendingStatus: string }) => r.pendingStatus),
    ["unread", "undisposed", "unread"]);
  assert.deepEqual(initial.pending[1].need, [`补 ${ids[1]}`]);
  assert.equal(initial.pending[1].read, true);
  assert.equal(initial.pending[0].read, false);
  const latest = query("--last-rounds", "2");
  assert.equal(latest.spoolFilesScanned, 2);
  assert.deepEqual(latest.pending.map((r: { id: string }) => r.id), [ids[3]]);
  assert.deepEqual(query("--since-days", "0").pending, []);
  assert.deepEqual(readdirSync(tmp).sort(), ["consumer", "spool"], "pending must write no output files");
  for (const tail of [["--last-rounds", "0"], ["--out", join(tmp, "out.json")]]) {
    const bad = spawnSync("python3", [...args, ...tail], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.deepEqual(readdirSync(tmp).sort(), ["consumer", "spool"]);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.premiseRound.enabled = true;
const f: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "test",
  kind: "finding", level: "MINOR", path: "x.ts", lines: "1", anchor: "x",
  facts: ["通用事实：已核实"], claim: "fooBar 与 HTTPS 均存在", fix_expect: "补齐", strength: "推理" };
const fc: FindingCheck = { pid: f.pid, ref: "OK", facts: [], entail: { p1: 0.1 },
  status: "前提不足", conditionFlag: false, calls: [] };
const client: JevClientLike = {
  async ask() { throw Error("no ask in prompt-only test"); },
  async noul() { throw Error("no noul in prompt-only test"); },
};
const promptFor = async (finding: FindingRecord, check: FindingCheck, enabled: boolean): Promise<string> => {
  let prompt = "";
  const runSessionFn: RunSessionFn = async (_runtime, _worker, text) => {
    prompt = text;
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  cfg.entailBridge.enabled = enabled;
  await premiseRound({ findings: [finding], perFinding: { [finding.pid]: check }, materials: new Map(), docs: [], cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }], runSessionFn,
    modelRuntime: null as never, cwd: "/batch11", readRoots: [], client });
  assert(prompt, "prompt must reach short session");
  return prompt;
};
const oldPrompt = `系统核对：你之前提交的 P1/F1 的事实前提被判为不足以推出其 claim。\n` +
  `## 材料（x.ts 第 1-1 行）\n\n\n` +
  `## 已列出的前提\n1. 通用事实：已核实\n\n` +
  `## claim\nfooBar 与 HTTPS 均存在\n` +
  `请调用工具 amend_facts(id="F1", facts=[…]) 补充缺失的前提，最多 4 条：代码事实带行号；` +
  `通用事实以「通用事实：」开头；环境条件以「运行时条件：」开头且如实写成条件。` +
  `补不出来就 amend_facts(id="F1", facts=[], cannot_amend_reason="…")。只处理这一条。`;
assert.equal(await promptFor(f, fc, false), oldPrompt, "off state must be byte-identical to old prompt");
const hint = "已有缺口提示：缺关于 fooBar、HTTPS 的前提，请针对性补充相关断言。\n";
assert.equal(await promptFor(f, fc, true), oldPrompt.replace("请调用工具", hint + "请调用工具"));
assert.equal((await promptFor({ ...f, claim: "一般文字" }, fc, true)).includes("已有缺口提示"), false,
  "empty missingEntities leaves prompt unchanged");
assert.equal((await promptFor(f, { ...fc, amended: { added: [
  { text: "fooBar 已核实", kind: "general", p: 0.9, status: "相符" },
  { text: "HTTPS 已核实", kind: "general", p: 0.9, status: "相符" },
], ms: 1 } }, true)).includes("已有缺口提示"), false, "in-memory amended facts can close both gaps");
console.log("jevbatch11 pending fixture and prompt flag snapshots: PASS");
