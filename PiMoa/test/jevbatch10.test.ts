import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { checkFinding, locateFact, type JevClientLike } from "../src/moa/jevcheck.js";
import type { FindingRecord, MaterialFile, MaterialMap } from "../src/moa/types.js";
import { checkFactRef } from "../src/tools/submit_findings.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

const seg = (rel: string, start: number, lines: string[]): MaterialFile => ({
  abs: `/batch10/${rel}`, rel, kind: "range", start, end: start + lines.length - 1, lines,
});
const pool = (...xs: MaterialFile[]): MaterialMap => new Map(xs.map(x => [x.abs, [x]]));
const tables = seg("devkb/internal/codekg/tables_n6_rs_executor.go", 100,
  Array.from({ length: 171 }, (_, n) => n === 28 ? "return guard(err)" : `line ${n}`));
const unrelated = seg("internal/orchestrator/executor.go", 799, ["func executor() {}"]);
const materials = pool(tables, unrelated);
// Spool 20261023T042346 / 042425: four references formerly hit both executor.go and
// tables_n6_rs_executor.go, leaving locPath=null. Exact filename boundary disambiguates.
for (const n of [109, 128, 157, 227]) {
  const got = locateFact(`tables_n6_rs_executor.go 第 ${n} 行 guard`,
    { path: "other_test.go", lines: "1" }, materials, []);
  assert.equal(got?.abs, tables.abs);
}
assert.equal(locateFact("executor.go 第 799 行", { path: "other_test.go", lines: "1" }, materials, [])?.abs,
  unrelated.abs, "a genuine short filename stays usable");
// Real multiple files, including multi-file prose, must never select one arbitrarily.
const duplicate = pool(seg("left/executor.go", 1, ["foo", "bar", "baz"]),
  seg("right/executor.go", 1, ["foo", "bar", "baz"]));
assert.equal(locateFact("executor.go 第 2 行", { path: "other.go", lines: "1" }, duplicate, []), null);
assert.equal(locateFact("gapi.mjs 第 48 行、graph.mjs 第 46 行", { path: "other.mjs", lines: "1" },
  pool(seg("gapi.mjs", 48, ["body"]), seg("graph.mjs", 46, ["body"])), []), null);
// PiMoa first reviews' confirmed MAJOR: a rel substring is not a full filename token.
assert.equal(locateFact("xfoo/executor.go 第 10 行", { path: "absent.go", lines: "1" },
  pool(seg("foo/executor.go", 10, ["wrong file"])), []), null);
assert.equal(locateFact("src/a.ts.bak 第 10 行", { path: "absent.ts", lines: "1" },
  pool(seg("src/a.ts", 10, ["wrong file"])), []), null);
// Existing upstream R1 is already in checkFactRef: only a unique exact symbol line is corrected.
const drift = seg("x.ts", 1, ["const irrelevant = 0;", "// whitespace  remains", ...Array(7).fill(""),
  "  const uniqueSymbol   = 1; "]);
const lineFact = "x.ts 第 1 行 uniqueSymbol 被声明";
const corrected = checkFactRef(lineFact, "x.ts", pool(drift), "/batch10", ["/batch10"]);
assert.equal(corrected.status, "已校正");
assert.equal(corrected.a, 10);
assert.match(corrected.rewritten ?? "", /第 10 行/);
const ambiguous = checkFactRef(lineFact, "x.ts", pool({ ...drift, lines: [...drift.lines, "uniqueSymbol"] , end: 11 }),
  "/batch10", ["/batch10"]);
assert.equal(ambiguous.status, "待核", "multiple symbol lines remain gaps");
// R3 was not adopted: folded whitespace never licenses an unrelated textual correction.
assert.equal(checkFactRef("x.ts 第 1 行  missingSymbol", "x.ts", pool(drift), "/batch10", ["/batch10"]).status,
  "未命中");
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true;
cfg.premiseRound.enabled = false;
const client: JevClientLike = {
  async ask(_state, questions) {
    return { results: Object.fromEntries(Object.keys(questions).map(k => [k, { p: 0.9, samples: [0.9] }])), calls: [] };
  },
  async noul() { return { p: 0.9, calls: [] }; },
};
const base: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "test",
  kind: "finding", level: "MINOR", path: "x.ts", lines: "1", anchor: "irrelevant",
  facts: [lineFact], factRefs: [corrected], claim: "symbol", fix_expect: "check", strength: "推理" };
const positive = await checkFinding({ f: base, materials: pool(drift), docs: [], cfg, client });
assert.equal(positive.facts[0]?.status, "相符", "corrected fact is rechecked; no extra red");
assert.equal(positive.facts[0]?.correctedLine, 10);
const negative = await checkFinding({ f: { ...base, factRefs: [{ ...corrected, status: "未命中" }] },
  materials: pool(drift), docs: [], cfg, client });
assert.equal(negative.facts[0]?.status, "不符", "existing unmatched-token hard error remains unchanged");
const written = seg("internal/taskgraph/write_gate.go", 26,
  Array.from({ length: 17 }, (_, i) => i === 9 ? "return store.NewWriteGate(cli).ExecWrite(ctx, tx)" : "line"));
const wrong = seg("internal/store/gate.go", 5940, ["func otherGate() {}"]);
const pathFact = "write_gate.go 第 35 行 execTaskgraphWrite 只调用 store.NewWriteGate(cli).ExecWrite";
const wrongRef = { text: pathFact, file: wrong.rel, a: 35, b: 35, status: "行号越界" as const };
const routed = await checkFinding({ f: { ...base, facts: [pathFact], factRefs: [wrongRef],
  path: wrong.rel, lines: "5940", anchor: "otherGate" }, materials: pool(written, wrong), docs: [], cfg, client });
assert.equal(routed.facts[0]?.ref, "待核");
assert.equal(routed.facts[0]?.status, "相符");
assert.equal(routed.facts[0]?.slice?.abs, written.abs);
const duplicatePath = await checkFinding({ f: { ...base, facts: [pathFact],
  factRefs: [{ ...wrongRef, status: "行号越界", file: wrong.rel }], path: wrong.rel },
  materials: pool(wrong, written, seg("another/write_gate.go", 26, [...written.lines])), docs: [], cfg, client });
assert.equal(duplicatePath.facts[0]?.status, "待核", "two same-name tails become gap, never select a file");
assert.equal(duplicatePath.facts[0]?.slice, undefined);
// Frozen batch-9 source snapshot is read-only; counts distinguish fact positioning from battery supply.
const ledger = JSON.parse(readFileSync("/private/tmp/jevbatch9-real-ledger-20261024-v3.json", "utf8"));
const targets = ledger.records.filter((r: { kind: string }) => ["locate-fail", "ref-hard-error"].includes(r.kind));
assert.equal(targets.length, 187);
assert.equal(targets.filter((r: { kind: string }) => r.kind === "ref-hard-error").length, 28);
assert.equal(targets.filter((r: { kind: string; factIdx: number | null }) =>
  r.kind === "locate-fail" && r.factIdx !== null).length, 8);
assert.equal(targets.filter((r: { kind: string; factIdx: number | null }) =>
  r.kind === "locate-fail" && r.factIdx === null).length, 151);
// Real spool replay (no Jev call): rehydrate the original two material files from the
// recorded recon ranges and their still-present frozen worktree, then re-run locateFact.
const replayRoot = WS + "/artifacts/papergo-system-maintenance-pm-20261005/next-session-N6-20261021/LANE-KOWNER/wt-rs-h8-executor/";
const realSource = new Map<string, string[]>();
const receiptCache = new Map<string, any>();
let repaired = 0;
for (const gap of targets as Array<{ kind: string; factIdx: number | null; id: string; spoolFile: string }>) {
  if (gap.kind !== "locate-fail" || gap.factIdx === null) continue;
  let receipt = receiptCache.get(gap.spoolFile);
  if (!receipt) {
    const spool = readFileSync(gap.spoolFile, "utf8");
    const block = /^## receipt\s*\n+```json\s*\n([\s\S]*?)\n```/m.exec(spool);
    assert(block, "receipt JSON must exist");
    receipt = JSON.parse(block[1]);
    receiptCache.set(gap.spoolFile, receipt);
  }
  const finding = receipt.findings.find((f: FindingRecord) => f.pid === gap.id.split(":")[0]);
  const fact = finding.facts[gap.factIdx];
  if (!fact.startsWith("tables_n6_rs_executor.go 第")) continue;
  const grouped: MaterialMap = new Map();
  for (const label of receipt.recon.segments as string[]) {
    const match = /^(.*(?:tables_n6_rs_executor|orchestrator\/executor)\.go):(\d+)-(\d+) (?:range|deps)$/.exec(label);
    if (!match) continue;
    const [, rel, start, end] = match;
    const abs = replayRoot + rel;
    let source = realSource.get(abs);
    if (!source) { source = readFileSync(abs, "utf8").split("\n"); realSource.set(abs, source); }
    const a = Number(start); const b = Number(end);
    const material: MaterialFile = { abs, rel, kind: "range", start: a, end: b, lines: source.slice(a - 1, b) };
    grouped.set(abs, [...(grouped.get(abs) ?? []), material]);
  }
  assert.equal(receipt.jevcheck.perFinding[finding.pid].facts[gap.factIdx].locPath, "null");
  const loc = locateFact(fact, finding, grouped, []);
  const expectedLine = Number(/第\s*(\d+)\s*行/.exec(fact)?.[1]);
  assert.equal(loc?.abs, replayRoot + "devkb/internal/codekg/tables_n6_rs_executor.go");
  assert(loc && loc.a <= expectedLine && expectedLine <= loc.b, "replay must include the cited line");
  assert(grouped.get(loc.abs)?.some(s => s.start <= expectedLine && expectedLine <= s.end));
  assert.equal(receipt.jevcheck.perFinding[finding.pid].facts[gap.factIdx].status, "待核");
  repaired++;
}
assert.equal(repaired, 4, "four actual frozen fact gaps become locatable, without guessing multi-file facts");
// Mechanical replay cannot claim any new Jev verdict. Red-line distribution requires
// separate real Jev calls; 28 original hard errors are counted above, not re-judged.
console.log("jevbatch10 real spool mechanical replay: 4/4 locatable with cited lines; Jev verdict not sampled: PASS");
