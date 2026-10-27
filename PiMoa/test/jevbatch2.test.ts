import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { checkFinding, collectTerminalGaps, findingClosureState, findingRegionState, runJevCheck, type JevClientLike } from "../src/moa/jevcheck.js";
import type { FactCheck, FindingRecord, MaterialMap } from "../src/moa/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = "/fixture/main.go", other = "/fixture/helper.go", docAbs = "/fixture/spec.md";
const mainLines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
mainLines[9] = "func first() {"; mainLines[49] = "}";
mainLines[69] = "func second() {"; mainLines[89] = "}";
const helperLines = Array.from({ length: 120 }, (_, i) => `helper${i + 1}`);
helperLines[29] = "func helper() {"; helperLines[59] = "}";
const seg = (path: string, rel: string, lines: string[]) => ({ abs: path, rel, kind: "range" as const, start: 1, end: lines.length, lines });
const materials: MaterialMap = new Map([
  [abs, [seg(abs, "main.go", mainLines)]], [other, [seg(other, "helper.go", helperLines)]],
  [docAbs, [seg(docAbs, "spec.md", ["# Intro", "## 2. 规则", "two", "three", "## 3. next"])]],
]);
const fact = "helper.go 第 40 行执行检查";
const f = { pid: "P1/F1", id: "F1", kind: "finding", level: "MAJOR", path: "main.go", lines: "20", anchor: "line20",
  facts: [fact], claim: "发生问题", fix_expect: "修复问题", strength: "推理", proposerModel: "mock/mock", proposerIndex: 0,
} as FindingRecord;
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.chain = { enabled: false, minSteps: 2, maxSteps: 6 };
cfg.premiseRound.enabled = false; cfg.sampling.fact = 2; cfg.sampling.entail = 2;
const slice = { abs: other, a: 25, b: 55 };
const located: FactCheck[] = [{ text: fact, kind: "code", p: .5, status: "待核", slice },
  { text: "duplicate", kind: "code", p: .5, status: "待核", slice: { abs: other, a: 40, b: 65 } },
  { text: "doc", kind: "code", p: .5, status: "待核", slice: { abs: docAbs, a: 2, b: 4 } }];
const withRefs = { ...f, factRefs: [{ text: "unrelated", status: "相符", file: "helper.go", a: 60, b: 62 },
  { text: "corrected", status: "已校正", file: "main.go", a: 80, b: 80 }] } as FindingRecord;
const closure = findingClosureState(withRefs, located, materials);
assert(closure.state.startsWith("## 代码（main.go，第 10-50 行）"));
assert(closure.state.includes("main.go，第 80-80 行"));
assert(closure.state.indexOf("helper.go") < closure.state.indexOf("main.go，第 80-80 行"));
assert(closure.state.includes("## 材料（spec.md，第 2-4 行）"));
assert.equal((closure.state.match(/  40\| helper40/g) ?? []).length, 1);
assert.equal((closure.state.match(/  80\| line80/g) ?? []).length, 1);
assert.equal(closure.dropped, 0);
const chainFinding = { ...f, chain: [{ id: "c1", kind: "link", text: "跨文件事实导致问题", from: "f1", to: "f2" }] } as FindingRecord;
const chainCfg = structuredClone(cfg);
chainCfg.chain = { enabled: true, minSteps: 2, maxSteps: 6 };
const chainStates: string[] = [];
const chainClient: JevClientLike = {
  async ask(state, questions) {
    if ("c1" in questions) chainStates.push(state);
    return { results: Object.fromEntries(Object.keys(questions).map(k => [k, { p: .9, samples: [.9, .9] }])), calls: [] };
  },
  async noul() { return { p: .9, calls: [] }; },
};
await checkFinding({ f: chainFinding, materials, docs: [], client: chainClient, cfg: chainCfg });
assert.equal(chainStates[0], findingRegionState(chainFinding, materials));
chainCfg.stateExpansion = { enabled: true };
const closedCheck = await checkFinding({ f: chainFinding, materials, docs: [], client: chainClient, cfg: chainCfg });
assert(chainStates[1]!.startsWith(findingRegionState(chainFinding, materials)));
assert(chainStates[1]!.includes("helper.go"));
assert.equal(closedCheck.closureDropped, 0);
const fat = materials.get(other)![0]!;
const bigMaterials: MaterialMap = new Map(materials);
bigMaterials.set(other, [{ ...fat, lines: fat.lines.map((line, i) => `${line}${i > 68 ? "Z".repeat(12000) : "X".repeat(500)}`) }]);
const capped = findingClosureState(withRefs, located, bigMaterials);
assert(capped.dropped > 0);
assert(capped.state.length <= 20_000);
assert.match(capped.state, /（预算截断，余 \d+ 段未附）$/);
assert(capped.state.startsWith("## 代码（main.go，第 10-50 行）"));
assert(!capped.state.includes("切片过长已截断"));
const firstTooBig: MaterialMap = new Map(materials);
firstTooBig.set(abs, [{ ...materials.get(abs)![0]!, lines: mainLines.map(line => `${line}${"Y".repeat(800)}`) }]);
const noPartial = findingClosureState(withRefs, located, firstTooBig);
assert.equal(noPartial.state, `\n（预算截断，余 ${noPartial.dropped} 段未附）`);
assert(noPartial.dropped >= 1);

const seen: Array<{ state: string; n: number }> = [];
const client = (thickP: number): JevClientLike => ({
  async ask(state, questions, n) {
    seen.push({ state, n });
    const p = seen.length === 1 ? .5 : thickP;
    return { results: Object.fromEntries(Object.keys(questions).map(k => [k, { p, samples: [p, p] }])),
      calls: Array.from({ length: n }, () => ({ q: "fact" as const, p, stateSha256: "mock", inputTokens: 1, ms: 1 })) };
  },
  async noul(kind, _state, n) { return { p: .9, calls: Array.from({ length: n }, () => ({ q: kind, p: .9, stateSha256: "mock", inputTokens: 1, ms: 1 })) }; },
});
cfg.factThicken = { enabled: true };
seen.length = 0;
const thick = await checkFinding({ f, materials, docs: [], client: client(.5), cfg });
assert.equal(seen.length, 1);
assert.match(seen[0]!.state, /helper.go，第 25-60 行/);
assert.equal(thick.facts[0]?.pThick, undefined);
const noFunction = { ...f, facts: ["main.go 第 95 行可继续"] } as FindingRecord;
seen.length = 0;
await checkFinding({ f: noFunction, materials, docs: [], client: client(.5), cfg });
assert.match(seen[0]!.state, /main.go，第 80-100 行/); // no enclosing body at 95 → original ±15
const crossLines = [...helperLines];
crossLines[59] = "helper60"; crossLines[89] = "}";
const crossMaterials: MaterialMap = new Map(materials);
crossMaterials.set(other, [seg(other, "helper.go", crossLines)]);
seen.length = 0;
const crossFinding = { ...f, facts: ["helper.go 第 60-80 行跨函数引用"] } as FindingRecord;
await checkFinding({ f: crossFinding, materials: crossMaterials, docs: [], client: client(.5), cfg });
assert.match(seen[0]!.state, /helper.go，第 30-95 行/); // body 30-90 ∪ citation 45-95 retains line 95
assert.match(seen[0]!.state, /  95\| helper95/);
cfg.grayEnrich = { enabled: true };
for (const [thickP, expected] of [[.91, "adopt"], [.1, "suspect"], [.5, "gray"]] as const) {
  seen.length = 0;
  const r = await checkFinding({ f, materials, docs: [], client: client(thickP), cfg });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.n, cfg.sampling.fact);
  assert.equal(seen[1]!.state, seen[0]!.state);
  assert.equal(r.facts[0]?.pThick, thickP);
  assert.equal(r.calls.filter(c => c.q === "fact").length, 4);
  if (expected === "adopt") {
    assert.equal(r.facts[0]?.p, thickP); assert.equal(r.facts[0]?.status, "相符"); assert.equal(r.facts[0]?.grayEnriched, true);
  } else {
    assert.equal(r.facts[0]?.p, .5); assert.equal(r.facts[0]?.status, "待核");
    assert.equal(r.facts[0]?.thickRefuted, expected === "suspect" ? true : undefined);
    if (expected === "suspect") {
      const gaps = collectTerminalGaps([f], { [f.pid]: r });
      assert.equal(gaps[0]?.kind, "gray-refute-suspect"); assert.match(gaps[0]!.need.join(""), /人工或机械复核/);
    }
  }
}
seen.length = 0;
cfg.budget.maxCalls = 4;
const skipped = await runJevCheck({ findings: [f], materials, cfg, workers: [], runSessionFn: (async () => { throw Error("unexpected"); }) as never,
  modelRuntime: null as never, cwd: root, readRoots: [root], deadlineMs: 30000, client: client(.1) });
assert.equal(seen.length, 1); // no thick call; entail still gets both samples
assert.equal(skipped.grayEnrichSkipped, 1);
assert.equal(skipped.perFinding[f.pid]?.facts[0]?.grayEnrichSkipped, true);
assert.equal(skipped.totals.calls, 4);
cfg.budget.maxCalls = 20;
seen.length = 0;
const suspect = await runJevCheck({ findings: [f], materials, cfg, workers: [], runSessionFn: (async () => { throw Error("unexpected"); }) as never,
  modelRuntime: null as never, cwd: root, readRoots: [root], deadlineMs: 30000, client: client(.1) });
assert.equal(suspect.gaps?.records[0]?.kind, "gray-refute-suspect"); // gap even with gapList off
assert.equal(suspect.gaps?.writeCount, 1);
for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const loaded = loadConfig({ moaYaml: resolve(root, "config/moa.yaml") });
for (const name of ["stateExpansion", "factThicken", "grayEnrich"] as const) assert.equal(JEVCHECK_DEFAULTS[name]?.enabled, false);
// Local all-off fixture for mutation/dependency tests, independent of production flag activations.
const yaml = readFileSync(resolve(root, "config/moa.yaml"), "utf8")
  .replace(/(stateExpansion|factThicken|grayEnrich): \{ enabled: (?:true|false) \}/g, "$1: { enabled: false }");
for (const name of ["stateExpansion", "factThicken", "grayEnrich"] as const) {
  const bad = resolve(tmpdir(), `jevbatch2-${name}-${randomUUID()}.yaml`);
  writeFileSync(bad, yaml.replace(`${name}: { enabled: false }`, `${name}: { enabled: bad }`));
  assert.throws(() => loadConfig({ moaYaml: bad, modelsJson: resolve(root, "config/models.json") }), new RegExp(`jevcheck\\.${name}\\.enabled`));
}
const dependency = resolve(tmpdir(), `jevbatch2-dependency-${randomUUID()}.yaml`);
writeFileSync(dependency, yaml.replace("grayEnrich: { enabled: false }", "grayEnrich: { enabled: true }"));
assert.throws(() => loadConfig({ moaYaml: dependency, modelsJson: resolve(root, "config/models.json") }), /jevcheck\.grayEnrich\.enabled/);
const together = resolve(tmpdir(), `jevbatch2-together-${randomUUID()}.yaml`);
writeFileSync(together, yaml.replace("grayEnrich: { enabled: false }", "grayEnrich: { enabled: true }")
  .replace("factThicken: { enabled: false }", "factThicken: { enabled: true }"));
const both = loadConfig({ moaYaml: together, modelsJson: resolve(root, "config/models.json") });
assert.equal(both.jevcheck.grayEnrich?.enabled, true);
assert.equal(both.jevcheck.factThicken?.enabled, true);
const allOff = structuredClone(cfg);
allOff.grayEnrich = { enabled: false }; allOff.factThicken = { enabled: false };
allOff.stateExpansion = { enabled: false }; allOff.gapList = { enabled: false };
const offReport = await runJevCheck({ findings: [f], materials, cfg: allOff, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: root, readRoots: [root], deadlineMs: 30000, client: client(.5) });
for (const key of ["closureDropped", "grayEnrichSkipped", "pThick", "grayEnriched", "thickRefuted"]) {
  assert.equal(JSON.stringify(offReport).includes(key), false);
}
const allOn = structuredClone(cfg);
allOn.budget.maxCalls = 20;
allOn.stateExpansion = { enabled: true };
allOn.factThicken = { enabled: true };
allOn.grayEnrich = { enabled: true };
allOn.gapList = { enabled: true };
allOn.chain = { enabled: true, minSteps: 2, maxSteps: 6 };
const requests: Array<{ state: string; keys: string[] }> = [];
const injected: JevClientLike = {
  async ask(state, questions, n) {
    const keys = Object.keys(questions);
    requests.push({ state, keys });
    const p = keys.includes("c1") ? .9 : requests.filter(r => r.keys.includes("f0")).length === 1 ? .5 : .1;
    return { results: Object.fromEntries(keys.map(key => [key, { p, samples: [p, p] }])),
      calls: Array.from({ length: n }, () => ({ q: keys.includes("c1") ? "link" as const : "fact" as const,
        p, stateSha256: "injected", inputTokens: 1, ms: 1 })) };
  },
  async noul(kind, _state, n) { return { p: .9, calls: Array.from({ length: n }, () => ({ q: kind, p: .9,
    stateSha256: "injected", inputTokens: 1, ms: 1 })) }; },
};
const allReport = await runJevCheck({ findings: [chainFinding], materials, cfg: allOn, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: root, readRoots: [root], deadlineMs: 30000, client: injected });
assert.equal(allReport.enabled, true);
assert.equal(allReport.perFinding[f.pid]?.facts[0]?.thickRefuted, true);
assert.equal(allReport.gaps?.records[0]?.kind, "gray-refute-suspect");
assert.equal(allReport.closureDropped, 0);
assert(requests.some(r => r.keys.includes("c1") && r.state.includes("helper.go")));
console.log("[jevbatch2] PASS closure/order/dedup/budget, thick/fallback, gray three branches, budget guard, config");
