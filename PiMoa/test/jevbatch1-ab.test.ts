import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { checkFinding, collectTerminalGaps, JevClient, locateFact, premiseRound, QUESTIONS, renderCheckTable, runJevCheck, type JevClientLike } from "../src/moa/jevcheck.js";
import { runMoa } from "../src/moa/orchestrate.js";
import type { SessionRunResult } from "../src/moa/session.js";
import type { FactLocPath, FindingCheck, FindingRecord, MaterialMap } from "../src/moa/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = "/fixture/a.ts", other = "/fixture/b.ts";
const materials: MaterialMap = new Map([
  [abs, [{ abs, rel: "a.ts", kind: "range", start: 1, end: 100, lines: Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`) }]],
  [other, [{ abs: other, rel: "b.ts", kind: "range", start: 1, end: 100, lines: Array.from({ length: 100 }, (_, i) => `const elsewhere${i + 1} = ${i + 1};`) }]],
]);
const fact = "a.ts 第 88 行存在 line88";
const f = {
  pid: "P1/F1", id: "F1", kind: "finding", level: "MAJOR", path: "a.ts", lines: "3", anchor: "line3",
  facts: [fact], factRefs: [{ text: fact, status: "相符", file: "b.ts", a: 72, b: 72 }],
  claim: "line88 不工作", fix_expect: "修复 line88", strength: "推理", proposerModel: "mock/mock", proposerIndex: 0,
} as FindingRecord;
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true;
cfg.sampling.fact = 1;
cfg.sampling.entail = 1;
cfg.premiseRound.enabled = false;
const seen: string[] = [];
const client: JevClientLike = {
  async ask(state, questions) {
    seen.push(state);
    return { results: Object.fromEntries(Object.keys(questions).map(k => [k, { p: 0.9, samples: [0.9] }])), calls: [] };
  },
  async noul() { return { p: 0.9, calls: [] }; },
};
const off = await checkFinding({ f, materials, docs: [], client, cfg });
assert.equal(off.facts[0]?.slice?.abs, abs);
assert.equal(off.facts[0]?.locPath, undefined);
assert(seen[0]?.includes("line88"));
// Baseline request snapshot transcribed from jevcheck.ts.bak-jevbatch1-20261022 before the opt-in change.
// Compare full request bytes and emitted call records, not just path or substring.
const offRequests: unknown[] = [];
const digest = (state: string) => createHash("sha256").update(state).digest("hex");
const offProbe: JevClientLike = {
  async ask(state, questions, n) {
    offRequests.push(["ask", state, questions, n]);
    return { results: { f0: { p: 0.9, samples: [0.9] } },
      calls: [{ q: "fact", p: 0.9, stateSha256: digest(state), inputTokens: 12, ms: 7 }] };
  },
  async noul(kind, state, n) {
    offRequests.push(["noul", kind, state, n]);
    return { p: 0.9, calls: [{ q: kind, p: 0.9, stateSha256: digest(state), inputTokens: 8, ms: 5 }] };
  },
};
cfg.stateExpansion = { enabled: false };
cfg.factThicken = { enabled: false };
cfg.grayEnrich = { enabled: false };
const offSnapshot = await checkFinding({ f, materials, docs: [], client: offProbe, cfg });
const stateSnapshot = `## 代码（a.ts，第 73-100 行）\n\`\`\`\n${Array.from({ length: 28 }, (_, i) => `${String(i + 73).padStart(4)}| const line${i + 73} = ${i + 73};`).join("\n")}\n\`\`\``;
const entailSnapshot = `## 已知前提（全部为真）\n1. ${fact}\n\n## 待判断的结论\n${f.claim}`;
const requestSnapshot: unknown[] = [
  ["ask", stateSnapshot, { f0: { q: "fact", instructions: `${QUESTIONS.fact.instructions}\n\n## 待核对的事实\n${fact}`, criteria: QUESTIONS.fact.criteria } }, 1],
  ["noul", "entail", entailSnapshot, 1],
];
assert.equal(JSON.stringify(offRequests), JSON.stringify(requestSnapshot));
assert.deepEqual(offSnapshot.calls, [
  { q: "fact", p: 0.9, stateSha256: digest(stateSnapshot), inputTokens: 12, ms: 7 },
  { q: "entail", p: 0.9, stateSha256: digest(entailSnapshot), inputTokens: 8, ms: 5 },
]);
assert.equal(JSON.stringify(offSnapshot).includes("stateChars"), false);
assert.equal(JSON.stringify(offSnapshot).includes("locPath"), false);
for (const field of ["closureDropped", "grayEnrichSkipped", "pThick", "grayEnriched", "thickRefuted"]) {
  assert.equal(JSON.stringify(offSnapshot).includes(field), false);
}
cfg.factRefDirect = { enabled: true };
cfg.gapList = { enabled: true };
seen.length = 0;
const on = await checkFinding({ f, materials, docs: [], client, cfg });
assert.equal(on.facts[0]?.slice?.abs, other);
assert.equal(on.facts[0]?.locPath, "ref-corrected");
assert(seen[0]?.includes("elsewhere72"));
assert(!seen[0]?.includes("line88"));
const emptyAnswer: JevClientLike = { ...client, async ask() { return { results: {}, calls: [] }; } };
const unanswered = await checkFinding({ f, materials, docs: [], client: emptyAnswer, cfg });
assert.equal(unanswered.facts[0]?.askFault, true);
assert.equal(collectTerminalGaps([f], { [f.pid]: unanswered })[0]?.kind, "ask-fault");
let path: FactLocPath | undefined;
locateFact("b.ts 第 70 行", f, materials, [], p => { path = p; });
assert.equal(path, "cross-file");
locateFact("a.ts 第 70 行", f, materials, [], p => { path = p; });
assert.equal(path, "line-ref");
locateFact("没有明确引用", f, materials, [], p => { path = p; });
assert(["same-file-else", "function-fallback"].includes(path!));
locateFact("b.ts 第 1000 行", f, materials, [], p => { path = p; });
assert.equal(path, "null");
const doc = { abs: "/fixture/spec.md", rel: "spec.md", kind: "file" as const,
  start: 1, end: 4, lines: ["# 文件", "## 2. 设计", "设计正文", "## 3. 其他"] };
locateFact("设计第 2 节", f, materials, [doc], p => { path = p; });
assert.equal(path, "doc-section");
locateFact("设计文档第 3 行", f, materials, [doc], p => { path = p; });
assert.equal(path, "line-ref");
const base: FindingCheck = {
  ...on, status: "前提不足", entail: { p1: 0.1 },
  facts: [
    { text: "missing", kind: "code", p: null, status: "待核", locPath: "null" },
    { text: "fault", kind: "code", p: null, status: "待核", askFault: true, slice: { abs, a: 1, b: 2 } },
    { text: "hard", kind: "code", p: null, status: "不符", ref: "未命中" },
  ],
};
const gaps = collectTerminalGaps([f, f], { [f.pid]: base });
assert.deepEqual(gaps.map(g => g.kind), ["locate-fail", "ask-fault", "ref-hard-error", "entail-low"]);
assert.equal(new Set(gaps.map(g => g.id)).size, 4);
assert(gaps.every(g => g.pid === f.pid && g.path === "a.ts:3" && g.need.length > 0));
const report = { perFinding: { [f.pid]: base }, duplicates: [], conflicts: [], oneSided: [] };
const summary = renderCheckTable(report, [f], materials, 160, gaps);
assert.equal(summary.truncated, true);
assert.match(summary.text, /缺口清单：4 条/);
assert(summary.text.length <= 160);
assert.equal(renderCheckTable(report, [f], materials, 3, gaps).text, "#4");
const offTable = renderCheckTable(report, [f], materials, 160);
assert.doesNotMatch(offTable.text, /缺口清单/);
// B5 retains the sampled original step only when the diagnostics flag is enabled.
const b5Finding = { ...f, chain: [{ id: "c1", kind: "link", text: "该链步导致失败", from: "f1", to: "f2" }] } as FindingRecord;
const b5Check: FindingCheck = {
  ...base, truth: { verdict: "因果存疑", rule: "DOWNGRADE-weak", brokenStep: "c1", mechNotes: ["c1｜原始证据"],
    steps: [{ id: "c1", kind: "link", samples: [0.3, 0.4], mechNotes: ["原始证据"] }] },
};
const premise = async (diagnostics: boolean): Promise<FindingCheck> => {
  cfg.gapList = { enabled: diagnostics };
  const check = structuredClone(b5Check);
  await premiseRound({ findings: [b5Finding], perFinding: { [f.pid]: check }, materials, docs: [], cfg,
    workers: [], runSessionFn: (async () => { throw new Error("B5 must not call model"); }) as never,
    modelRuntime: null as never, cwd: root, readRoots: [root], client });
  return check;
};
const oldB5 = await premise(false);
assert.equal(oldB5.truth?.steps, undefined);
const newB5 = await premise(true);
assert.equal(newB5.truth?.rule, "B5-link");
assert.equal(newB5.truth?.b5From, "DOWNGRADE-weak");
assert.deepEqual(newB5.truth?.steps?.[0]?.samples, [0.3, 0.4]);
assert.deepEqual(newB5.truth?.steps?.[0]?.mechNotes, ["原始证据"]);
assert.deepEqual(newB5.truth?.mechNotes, ["c1｜原始证据"]);
const b5Table = renderCheckTable({ ...report, perFinding: { [f.pid]: newB5 } }, [f], materials, 40000);
assert.doesNotMatch(b5Table.text, /缺采样/);
// Run terminal report through the same orchestrator-facing object; receipt projection is covered by existing runMoa contract.
const run = await runJevCheck({ findings: [f], materials, cfg, workers: [], runSessionFn: (async () => { throw Error("unexpected"); }) as never,
  modelRuntime: null as never, cwd: root, readRoots: [root], deadlineMs: 30000,
  precomputed: new Map([[f.pid, base]]), client });
assert.equal(run.gaps?.writeCount, 4);
assert.match(run.tableText, /缺口清单：4 条/);
assert.equal(run.gaps?.records.length, 4);
// Config's real loader must accept default-off flags; invalid values fail loudly without touching models.json.
for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const loaded = loadConfig({ moaYaml: resolve(root, "config/moa.yaml") });
assert.equal(JEVCHECK_DEFAULTS.factRefDirect?.enabled, false);
assert.equal(JEVCHECK_DEFAULTS.gapList?.enabled, false);
// Full verify orchestration → actual runJevCheck → receipt projection, with deterministic injected Jev transport.
loaded.jevcheck.gapList = { enabled: true };
loaded.jevcheck.factRefDirect = { enabled: true };
loaded.jevcheck.chain = { enabled: false, minSteps: 2, maxSteps: 6 };
loaded.jevcheck.premiseRound.enabled = false;
const missingFact = "b.ts 第 1000 行缺少范围";
const fakeJev: JevClientLike = {
  async ask(state, questions) {
    return { results: Object.fromEntries(Object.keys(questions).map(key => [key, { p: 0.9, samples: [0.9, 0.9] }])),
      calls: Object.entries(questions).map(([, q]) => ({ q: q.q, p: 0.9, stateSha256: digest(state), inputTokens: 10, ms: 6 })) };
  },
  async noul(kind, state) {
    return { p: 0.1, calls: [{ q: kind, p: 0.1, stateSha256: digest(state), inputTokens: 10, ms: 6 }] };
  },
};
const savedShared = JevClient.shared;
const sharedSlot = JevClient as unknown as { shared: (opts: unknown) => JevClientLike };
sharedSlot.shared = () => fakeJev;
let integrated;
try {
  let turn = 0;
  const session = async (_runtime: unknown, _worker: unknown, _prompt: string, opts: {
    structuredState?: { accepted: unknown; attempts: number };
  }): Promise<SessionRunResult> => {
    const idx = turn++;
    if (opts.structuredState) {
      opts.structuredState.attempts = 1;
      opts.structuredState.accepted = idx < 2
        ? [{ id: "F1", kind: "finding", level: "MAJOR", path: "a.ts", lines: "3", anchor: "line3",
            facts: [fact, missingFact], claim: f.claim, fix_expect: f.fix_expect, strength: "推理" }]
        : { verdicts: [{ finding_ids: ["P1/F1", "P2/F1"], level: "MAJOR", can_happen: "能", consequence: "错误结果",
              trigger: "指定输入", strength: "推理", reason: "材料显示该输入可能产生错误结果", evidence: "a.ts:3" }],
            final: "该事实需继续人工复核。" };
    }
    return { text: "模型模拟正文", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false,
      sawAgentEnd: true, structured: { accepted: true, count: 1, attempts: 1 } };
  };
  integrated = await runMoa(loaded, { prompt: "审查", preset: "moa_verify", materials },
    { modelRuntime: null, runSessionImpl: session as never });
} finally {
  sharedSlot.shared = savedShared;
}
assert.equal(integrated.status, "ok", JSON.stringify(integrated.error));
assert.equal(integrated.receipt.gaps?.writeCount, 4);
assert.deepEqual(integrated.receipt.gaps, integrated.receipt.jevcheck?.gaps);
assert.equal(new Set(integrated.receipt.gaps?.records.map(g => g.id)).size, 4);
assert(integrated.receipt.gaps?.records.every(g => g.need.length > 0 && g.path === "a.ts:3"));
assert.deepEqual(new Set(integrated.receipt.gaps?.records.map(g => g.kind)), new Set(["locate-fail", "entail-low"]));
assert.match(integrated.jevcheckFull?.tableText ?? "", /缺口清单：4 条/);
const trace = integrated.jevcheckFull?.perFinding["P1/F1"];
assert.equal(trace?.facts[0]?.locPath, "line-ref");
assert.equal(trace?.facts[1]?.locPath, "null");
assert.equal(integrated.receipt.jevcheck?.perFinding["P1/F1"]?.facts[0]?.locPath, "line-ref");
assert(trace?.calls.some(c => c.q === "fact" && (c.stateChars ?? 0) > 0 && c.stateCapped === false));
assert.equal(integrated.jevcheckFull?.locAudit?.length >= 0, true);
const longMaterials: MaterialMap = new Map([[other, [{ ...materials.get(other)![0]!,
  lines: Array.from({ length: 100 }, (_, i) => `elsewhere${i + 1} ${"X".repeat(800)}`) }]]]);
const capped = await checkFinding({ f, materials: longMaterials, docs: [], client: offProbe, cfg });
assert(capped.calls.some(c => c.q === "fact" && c.stateCapped === true && (c.stateChars ?? 0) > 20_000));
const auditId = Array.from({ length: 1000 }, (_, i) => `P1/F${i}`).find(id =>
  Number.parseInt(digest(`${id}:0`).slice(0, 8), 16) % 100 === 0);
assert(auditId);
const auditFinding = { ...f, pid: auditId! };
const auditCheck = { ...on, pid: auditId! };
const auditReport = await runJevCheck({ findings: [auditFinding], materials, cfg, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: root, readRoots: [root], deadlineMs: 30000, precomputed: new Map([[auditId!, auditCheck]]), client });
assert.deepEqual(auditReport.locAudit?.[0]?.slice, on.facts[0]?.slice);
assert.equal(auditReport.locAudit?.[0]?.expectedAnchor, f.anchor);
const amendedGaps = collectTerminalGaps([f], { [f.pid]: { ...base,
  amended: { added: [{ text: "added", kind: "code", p: null, status: "待核", locPath: "null" }], ms: 1 } } });
assert(amendedGaps.some(g => g.factIdx === 3 && g.kind === "locate-fail"));
// Build a local off-flag fixture; production config has already been loaded above and may have either flag on.
const yaml = readFileSync(resolve(root, "config/moa.yaml"), "utf8")
  .replace(/(factRefDirect|gapList): \{ enabled: (?:true|false) \}/g, "$1: { enabled: false }");
for (const name of ["factRefDirect", "gapList"] as const) {
  const bad = resolve(tmpdir(), `jevbatch1-invalid-${name}-${randomUUID()}.yaml`);
  const changed = yaml.replace(`${name}: { enabled: false }`, `${name}: { enabled: bad }`);
  assert.notEqual(changed, yaml);
  writeFileSync(bad, changed);
  assert.throws(() => loadConfig({ moaYaml: bad, modelsJson: resolve(root, "config/models.json") }),
    new RegExp(`jevcheck\\.${name}\\.enabled`));
}
console.log("[jevbatch1-ab] PASS direct/off, paths, terminal gaps, summary, B5, config loader");
