import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { autoRouteCategory, chainEvidenceReferences, checkChainEvidence, checkFinding,
  collectTerminalGaps, entailBridgeEntities, missingEntailBridgeEntities, runJevCheck, type JevClientLike } from "../src/moa/jevcheck.js";
import { runMoa } from "../src/moa/orchestrate.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";

const abs = "/case/a_test.go";
const material: MaterialMap = new Map([[abs, [{ abs, rel: "a_test.go", kind: "range", start: 20, end: 22,
  lines: ["func h1WriteTablesMatchDeclared() {", "  pkg.CheckReady()", "  SELECT := true; _ = SELECT"] }]]]);
const finding = (path = "a_test.go"): FindingRecord => ({ id: "F1", pid: "P1/F1", proposerIndex: 0,
  proposerModel: "mock/mock", kind: "finding", level: "MAJOR", path, lines: "20", anchor: "h1WriteTablesMatchDeclared",
  facts: ["SELECT is read in fixture"], claim: "renderAggregated 与 SELECT 的结果不一致", fix_expect: "补前提并复核输出", strength: "推理",
  chain: [{ id: "c1", kind: "runtime", text: "第 20 行的 h1WriteTablesMatchDeclared 在 a_test.go 中运行" },
    { id: "c2", kind: "link", text: "第 99 行的 missingHelper() 引出风险" },
    { id: "c3", kind: "absence", text: "missingHelper() 不存在于材料" }],
});
const cfg = structuredClone(JEVCHECK_DEFAULTS); cfg.enabled = true;
cfg.chainEvidenceGate = { enabled: true }; cfg.entailBridge = { enabled: true }; cfg.premiseRound.enabled = false;
cfg.chain = { enabled: true, minSteps: 2, maxSteps: 6 };
const refs = chainEvidenceReferences("第20行 h1WriteTablesMatchDeclared、pkg.CheckReady() 与 SOME_CONST");
assert(refs.tokens.includes("h1WriteTablesMatchDeclared")); assert(refs.tokens.includes("pkg.CheckReady"));
assert(refs.tokens.includes("SOME_CONST")); assert.deepEqual(refs.lines, [20]);
assert.deepEqual(chainEvidenceReferences("纯行为步没有可辨别的标识符"), { tokens: [], lines: [] });
assert.deepEqual(chainEvidenceReferences("when (cfg 关闭)，e.g 仍可能失败"), { tokens: [], lines: [] });
const unrelated: MaterialMap = new Map([["/case/foo.ts", [{ abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 1, end: 2, lines: ["const foo = 1", "const bar = 2"] }]],
  ["/case/bar.ts", [{ abs: "/case/bar.ts", rel: "bar.ts", kind: "range", start: 100, end: 100, lines: ["const foreign = 3"] }]]]);
assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text: "foo.ts 的第 100 行检查 foo" }] }, unrelated).checks[0]?.status,
  "引用缺失（机械）"); // a numbered line in bar.ts cannot satisfy foo.ts
assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text: "foo.ts、bar.ts 的第 100 行检查" }] }, unrelated).checks[0]?.status,
  "引用缺失（机械）"); // every named file must contain its claimed line
const hole: MaterialMap = new Map([["/case/foo.ts", [{ abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 20, end: 20, lines: ["const atStart = 1"] },
  { abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 22, end: 22, lines: ["const atEnd = 1"] }]]]);
assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text: "foo.ts 第 20-22 行有证据" }] }, hole).checks[0]?.status,
  "引用缺失（机械）"); // range endpoints cannot hide an unattached middle line
assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text: "foo.ts line 20-22 contains code" }] }, hole).checks[0]?.status,
  "引用缺失（机械）"); // same guarantee for English range slots
assert.deepEqual(chainEvidenceReferences("foo.ts 第 20、99 行引用" ).lines, [20, 99]);
assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text: "foo.ts 第 20、99 行引用" }] }, hole).checks[0]?.status,
  "引用缺失（机械）"); // enumerated lines cannot silently lose a slot
const mixedHole: MaterialMap = new Map([["/case/foo.ts", [
  { abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 20, end: 20, lines: ["const start = 1"] },
  { abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 22, end: 22, lines: ["const edge = 1"] },
  { abs: "/case/foo.ts", rel: "foo.ts", kind: "range", start: 30, end: 30, lines: ["const end = 1"] }]]]);
for (const text of ["foo.ts 第 20、22-30 行", "foo.ts line 20, 22-30", "foo.ts 第 20–30 行"]) {
  assert.equal(checkChainEvidence({ ...finding(), chain: [{ id: "c1", kind: "runtime", text }] }, mixedHole).checks[0]?.status,
    "引用缺失（机械）", text);
}
const evidence = checkChainEvidence(finding(), material);
assert.deepEqual(evidence.checks.map(c => [c.id, c.status]), [["c1", "引用在场（机械）"], ["c2", "引用缺失（机械）"]]);
assert.equal(evidence.gaps[0]?.kind, "chain-evidence-missing");
assert.match(evidence.gaps[0]!.need[0]!, /missingHelper.*第 99 行/);
assert.equal(evidence.checks.some(c => c.id === "c3"), false);
assert.deepEqual(entailBridgeEntities("renderAggregated 与 SELECT 和 真库结果比较 有缺陷，closure 为另一个"),
  ["renderAggregated", "SELECT", "真库结果比较"]);
const clientCalls: string[] = [];
const client: JevClientLike = {
  async ask(_state, qs) { clientCalls.push(...Object.keys(qs)); return { results: Object.fromEntries(Object.keys(qs).map(k => [k, { p: .9, samples: [.9, .9] }])), calls: [] }; },
  async noul(kind) { clientCalls.push(kind); return { p: kind === "entail" ? .1 : .9, calls: [] }; },
};
const f = finding();
let fc = await checkFinding({ f, materials: material, docs: [], cfg, client });
assert.deepEqual(fc.chainEvidence?.map(c => c.status), ["引用在场（机械）", "引用缺失（机械）"]);
assert(clientCalls.includes("c1") && clientCalls.includes("c2")); // existing link sampling untouched
assert(!clientCalls.some(q => /steploc|chain-evidence/.test(q)));
assert.equal(fc.status, "前提不足");
assert.deepEqual(missingEntailBridgeEntities(f, fc), ["renderAggregated"]);
assert.deepEqual(missingEntailBridgeEntities({ ...f, claim: "readRoots 与 HTTPS 均缺证", facts: ["readRoots 和 HTTPS 已覆盖"] }, fc), []);
assert.deepEqual(missingEntailBridgeEntities({ ...f, claim: "HTTPS 缺证", facts: ["HTTP 已覆盖"] }, fc), ["HTTPS"]);
assert.deepEqual(collectTerminalGaps([f], { [f.pid]: fc }, true).find(g => g.kind === "entail-low")?.need,
  ["缺关于 renderAggregated 的前提"]);
const report = await runJevCheck({ findings: [f], materials: material, cfg, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected premise round"); }) as never, modelRuntime: null as never,
  cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.deepEqual(report.chainEvidenceTelemetry, { triggered: 2, present: 1, missing: 1 });
assert.deepEqual(report.entailBridgeTelemetry, { triggered: 1, named: 1, missingEntities: 1 });
assert.match(report.tableText, /c1 引用在场（机械）/);
assert(report.gaps?.records.some(g => g.kind === "chain-evidence-missing"));
assert(report.gaps?.records.some(g => g.need.includes("缺关于 renderAggregated 的前提")));

cfg.category = { enabled: true }; cfg.categoryAutoRoute = { enabled: true };
for (const [path, route] of [["internal/foo_test.go", "primary"], ["src/test/util.ts", "secondary"],
  ["checks/bar_test.ts", "secondary"], ["src/test/synthetic-protocol.mjs", undefined], ["pkg/foo.go", undefined]] as const) {
  assert.equal(autoRouteCategory(finding(path), cfg).categoryAutoRouted, route);
}
for (const category of ["behavior", "wiring", "fake-green"] as const) {
  assert.equal(autoRouteCategory({ ...finding(), category }, cfg).category, category); // explicit label wins
}
const routed = await runJevCheck({ findings: [finding()], materials: material, cfg, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.deepEqual(routed.categoryAutoRouteTelemetry, { primary: 1, secondary: 0, routed: 1 });
assert.match(routed.tableText, /类别：fake-green/);
assert(routed.perFinding["P1/F1"]?.batteryGaps?.length); // expected acceptance-command material gap
assert(routed.gaps?.records.some(g => g.need.some(n => /验收命令/.test(n))));

for (const key of ["chainEvidenceGate", "categoryAutoRoute", "entailBridge"] as const) {
  const off = structuredClone(cfg); off[key] = { enabled: false }; off.categoryAutoRoute = { enabled: false };
  const absent = structuredClone(off); delete absent[key];
  const checkedOff = await checkFinding({ f: finding(), materials: material, docs: [], cfg: off, client });
  const checkedAbsent = await checkFinding({ f: finding(), materials: material, docs: [], cfg: absent, client });
  assert.equal(JSON.stringify(checkedOff), JSON.stringify(checkedAbsent), `${key} off checkFinding bytes`);
  if (key === "chainEvidenceGate") assert.equal(checkedOff.chainEvidence, undefined);
}
const allOff = structuredClone(cfg); allOff.chainEvidenceGate = { enabled: false };
allOff.categoryAutoRoute = { enabled: false }; allOff.entailBridge = { enabled: false };
fc = await checkFinding({ f: finding(), materials: material, docs: [], cfg: allOff, client });
assert.equal(fc.chainEvidence, undefined);
assert.equal(fc.chainEvidenceGaps, undefined);
const reportOff = await runJevCheck({ findings: [finding()], materials: material, cfg: allOff, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.equal(reportOff.chainEvidenceTelemetry, undefined);
assert.equal(reportOff.categoryAutoRouteTelemetry, undefined);
assert.equal(reportOff.entailBridgeTelemetry, undefined);

for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const configPath = fileURLToPath(new URL("../config/moa.yaml", import.meta.url));
const config = loadConfig({ moaYaml: configPath });
for (const key of ["chainEvidenceGate", "categoryAutoRoute", "entailBridge"] as const) assert.deepEqual(JEVCHECK_DEFAULTS[key], { enabled: false });
// The real production configuration still has to load; its flags may later be enabled independently.
const yaml = readFileSync(configPath, "utf8");
for (const key of ["chainEvidenceGate", "entailBridge"] as const) {
  const invalid = join(tmpdir(), `jevbatch5-${key}-${process.pid}.yaml`);
  writeFileSync(invalid, yaml.replace(new RegExp(`${key}: \\{ enabled: (?:true|false) \\}`), `${key}: { enabled: 1 }`));
  assert.throws(() => loadConfig({ moaYaml: invalid }), new RegExp(`jevcheck\\.${key}\\.enabled`));
}
const invalid = join(tmpdir(), `jevbatch5-dependency-${process.pid}.yaml`);
writeFileSync(invalid, yaml
  .replace(/category: \{ enabled: (?:true|false) \}/, "category: { enabled: false }")
  .replace(/categoryAutoRoute: \{ enabled: (?:true|false) \}/, "categoryAutoRoute: { enabled: true }"));
assert.throws(() => loadConfig({ moaYaml: invalid }), /jevcheck.categoryAutoRoute.enabled=true.*category.enabled=true/);

// Request-level off snapshot: real runMoa builds proposer prompt, tool description and schema.
// A failing injected proposer stops before Jev/network; the captured request is byte-compared.
const capture = async (remove: boolean) => {
  const source = structuredClone(config);
  source.jevcheck.chainEvidenceGate = { enabled: false };
  source.jevcheck.categoryAutoRoute = { enabled: false };
  source.jevcheck.entailBridge = { enabled: false };
  if (remove) { delete source.jevcheck.chainEvidenceGate; delete source.jevcheck.categoryAutoRoute; delete source.jevcheck.entailBridge; }
  const requests: string[] = [];
  await runMoa(source, { prompt: "batch5 off snapshot", preset: "moa_verify", materials: material }, {
    modelRuntime: null,
    runSessionImpl: (async (_runtime: unknown, _worker: unknown, prompt: string, options: {
      extraTools?: Array<{ description: string; promptSnippet?: string; parameters: unknown }>;
    }) => {
      requests.push(JSON.stringify({ prompt, tools: options.extraTools?.map(t => ({ description: t.description,
        snippet: t.promptSnippet, schema: t.parameters })) }));
      return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false,
        sawAgentEnd: true, structured: { accepted: false, count: 0, attempts: 0 } };
    }) as never,
  });
  assert(requests.length > 0, "verify must issue at least one captured proposer request");
  return requests;
};
assert.deepEqual(await capture(false), await capture(true));
console.log("PASS jevbatch5 chain evidence v3, auto-route, entail bridge, telemetry, dependency and off request snapshot");
