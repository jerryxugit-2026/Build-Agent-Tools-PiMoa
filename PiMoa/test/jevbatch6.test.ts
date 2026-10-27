import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { QUESTIONS, checkFinding, collectTerminalGaps, odTypedEvidenceGaps, odTypedRoute, runJevCheck, type JevClientLike } from "../src/moa/jevcheck.js";
import { moaToolOutput, toSlimPayload } from "../src/mcp/tools.js";
import { runMoa } from "../src/moa/orchestrate.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";

const abs = "/fixture/a.go";
const materials: MaterialMap = new Map([[abs, [{ abs, rel: "a.go", kind: "range", start: 20, end: 22,
  lines: ["func main() {", "  check(input)", "}"] }]]]);
const base: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "mock/mock",
  kind: "finding", level: "MAJOR", path: "a.go", lines: "20", anchor: "main",
  facts: ["a.go 第 20 行 main 有检查"], claim: "重复校验", fix_expect: "删除重复项", strength: "推理" };
const cfg = structuredClone(JEVCHECK_DEFAULTS); cfg.enabled = true; cfg.premiseRound.enabled = false;
const asked: Array<{ keys: string[]; qs: Record<string, { q: string; instructions: string; criteria: Record<string, string> }> }> = [];
let factCount = 0;
const client: JevClientLike = {
  async ask(_state, questions) {
    const qs = questions as typeof asked[number]["qs"];
    asked.push({ keys: Object.keys(qs), qs });
    const p = qs.f0 ? (factCount++ === 0 ? .5 : .9) : .9;
    return { results: Object.fromEntries(Object.keys(qs).map(k => [k, { p, samples: [p, p] }])), calls: [] };
  },
  async noul() { return { p: .9, calls: [] }; },
};
assert.deepEqual(QUESTIONS["fact-behave"], { instructions: "切片（所给材料）所示内容与该断言的核心行为/规范一致。",
  criteria: { true: "一致：材料所示单步行为/规范与断言核心相符",
    false: "不一致：材料所示内容与断言核心行为/规范相悖，或断言所指内容不在材料所示范围内" } });
cfg.factThicken = { enabled: true }; cfg.grayEnrich = { enabled: true };
const enriched = await checkFinding({ f: base, materials, docs: [], cfg, client });
assert.equal(asked[0]?.qs.f0?.q, "fact");
assert.equal(asked[1]?.qs.f0?.q, "fact-behave");
assert.equal(asked[1]?.qs.f0?.instructions, `${QUESTIONS["fact-behave"].instructions}\n\n## 待核对的事实\n${base.facts[0]}`);
assert.equal(enriched.facts[0]?.grayEnriched, true);
assert.equal(enriched.facts[0]?.pThick, .9);
const noGray = structuredClone(cfg); noGray.grayEnrich = { enabled: false };
asked.length = 0; factCount = 0;
await checkFinding({ f: base, materials, docs: [], cfg: noGray, client });
assert(!asked.some(a => Object.values(a.qs).some(q => q.q === "fact-behave")));

const checkAnchor = async (status: "相符" | "已校正", a: number, b: number, enabled = true) => {
  const c = structuredClone(noGray); c.factRefDirect = { enabled };
  return checkFinding({ f: { ...base, factRefs: [{ text: base.facts[0]!, status, file: "a.go", a, b }] },
    materials, docs: [], cfg: c, client });
};
for (const status of ["相符", "已校正"] as const) {
  const good = await checkAnchor(status, 20, 22);
  assert.equal(good.facts[0]?.lineAnchorDrift, undefined);
  const bad = await checkAnchor(status, 20, 23);
  assert.equal(bad.facts[0]?.lineAnchorDrift, true);
  assert.equal(collectTerminalGaps([base], { [base.pid]: bad }).find(g => g.kind === "line-anchor-drift")?.factIdx, 0);
  const disabled = await checkAnchor(status, 20, 23, false);
  assert.equal(disabled.facts[0]?.lineAnchorDrift, undefined);
}
const split: MaterialMap = new Map([[abs, [{ ...materials.get(abs)![0]!, start: 20, end: 20, lines: ["func main() {"] },
  { ...materials.get(abs)![0]!, start: 22, end: 22, lines: ["}"] }]]]);
const splitCheck = await checkFinding({ f: { ...base, factRefs: [{ text: base.facts[0]!, status: "相符", file: "a.go", a: 20, b: 22 }] },
  materials: split, docs: [], cfg: { ...noGray, factRefDirect: { enabled: true } }, client });
assert.equal(splitCheck.facts[0]?.lineAnchorDrift, undefined); // endpoints, not continuity (batch 5 checks continuity)

const contractDiff = `## 材料-1（任务合同节选）\n## §scope\n- 修复现有接口。\n- 不添加冗余逻辑。\n\n## 材料-2（修复 diff 段）\n+func check(input string) bool {\n+  return input != ""\n+}\n`;
const sections: Record<"dup" | "fut" | "cfg" | "low", string> = {
  dup: "## 材料-3（上游调用方代码段）\nfunc caller(input string) {\n if input == \"\" { return }\n check(input)\n}\n",
  fut: "## 材料-3（池内调用方普查段）\n$ rg -n 'check' internal/\na.go:2: func check(input string) bool {\na.go:18: caller := check(input)\n# 共 2 处：定义 + 唯一调用点\n",
  cfg: "## 材料-3（池内读取点普查段）\n$ rg -n 'export.hardcap' internal/\na.go:18: cfg.GetInt(\"export.hardcap\")\n# 共 1 处读取点\n",
  low: "## 材料-3（输入组合逐跳路径段）\nfunc entry() { caller(input) }\nfunc caller(input string) { check(input) }\nfunc check(input string) { if input == \"\" { return } }\n",
};
const claims = { dup: "上游已有重复校验", fut: "为未来扩展预留泛化签名", cfg: "配置化过度且只有单一配置键读取", low: "低概率输入组合的防御" };
const keys = { dup: "od-dup", fut: "od-second-caller", cfg: "od-second-reader", low: "od-reach-combo" } as const;
for (const route of ["dup", "fut", "cfg", "low"] as const) {
  const f = { ...base, category: "overdesign" as const, claim: claims[route], facts: [] };
  assert.equal(odTypedRoute(f.claim), route);
  const absent = odTypedEvidenceGaps(contractDiff, f, route);
  assert(absent[keys[route]]?.length, `${route} absent evidence must gate`);
  const present = `${contractDiff}${route === "cfg" ? "+hardcap: 50000\n" : ""}\n${sections[route]}`;
  assert.deepEqual(odTypedEvidenceGaps(present, f, route), {}, `${route} evidence shape passes`);
  const c = structuredClone(noGray); c.category = { enabled: true }; c.odTyped = { enabled: true };
  asked.length = 0;
  const yes = await checkFinding({ f, materials, docs: [], cfg: c, client, evidenceState: present });
  assert.deepEqual(yes.battery?.map(x => x.key), [keys[route]]);
  assert(asked.some(a => a.qs[keys[route]]?.instructions === QUESTIONS[keys[route]].instructions));
  assert(!asked.some(a => a.keys.some(k => ["od-path", "od-repro", "od-conflict"].includes(k))));
  asked.length = 0;
  const gated = await checkFinding({ f, materials, docs: [], cfg: c, client, evidenceState: contractDiff });
  assert.equal(gated.battery, undefined);
  assert(gated.batteryGaps?.some(g => g.id.includes(keys[route])));
  assert(!asked.some(a => a.keys.includes(keys[route])));
}
const futOnlyDefinition = `${contractDiff}\n## 材料-3（池内调用方普查段）\n$ rg -n 'check' internal/\na.go:2: func check(input string) bool {\n# 共 1 处：定义，无调用点\n`;
assert(odTypedEvidenceGaps(futOnlyDefinition, { ...base, claim: claims.fut }, "fut")["od-second-caller"]);
for (const falseCaller of ["// check(input)", "other(input) // mentions check", "# check(input)",
  'fmt.Println("check(input)")', 'other(input) // check(input)']) {
  const census = futOnlyDefinition.replace("# 共 1 处：定义，无调用点", `a.go:18: ${falseCaller}\n# 共 2 处：定义与注释`);
  assert(odTypedEvidenceGaps(census, { ...base, claim: claims.fut }, "fut")["od-second-caller"], falseCaller);
}
const lowIsolatedCall = `${contractDiff}\n## 材料-3（输入组合逐跳路径段）\ncheck(input)\n`;
assert(odTypedEvidenceGaps(lowIsolatedCall, { ...base, claim: claims.low }, "low")["od-reach-combo"]);
const unmatched = { ...base, category: "overdesign" as const, claim: "并发锁可能显得复杂", facts: [] };
assert.equal(odTypedRoute(unmatched.claim), null);
const typedCfg = structuredClone(noGray); typedCfg.category = { enabled: true }; typedCfg.odTyped = { enabled: true };
const noRoute = await checkFinding({ f: unmatched, materials, docs: [], cfg: typedCfg, client, evidenceState: contractDiff });
assert.equal(noRoute.battery, undefined);
assert(noRoute.batteryGaps?.some(g => g.id.includes("od-typed")));
const oldCfg = structuredClone(typedCfg); oldCfg.odTyped = { enabled: false };
const legacy = await checkFinding({ f: { ...base, category: "overdesign", facts: [] }, materials, docs: [], cfg: oldCfg, client,
  evidenceState: contractDiff });
assert.deepEqual(legacy.battery?.map(x => x.key), ["od-path", "od-repro"]);
const absentCfg = structuredClone(oldCfg); delete absentCfg.odTyped;
assert.equal(JSON.stringify(legacy), JSON.stringify(await checkFinding({ f: { ...base, category: "overdesign", facts: [] },
  materials, docs: [], cfg: absentCfg, client, evidenceState: contractDiff })));
const report = await runJevCheck({ findings: [{ ...base, factRefs: [{ text: base.facts[0]!, status: "相符", file: "a.go", a: 20, b: 23 }] }],
  materials, cfg: { ...noGray, factRefDirect: { enabled: true } }, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never,
  cwd: "/fixture", readRoots: ["/fixture"], deadlineMs: 30000 });
assert(report.gaps?.records.some(g => g.kind === "line-anchor-drift"));

for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const yamlPath = fileURLToPath(new URL("../config/moa.yaml", import.meta.url));
const modelsJson = fileURLToPath(new URL("../config/models.json", import.meta.url));
// All-off local fixture keeps the dependency test valid under any production flag combination.
const yaml = readFileSync(yamlPath, "utf8")
  .replace(/quote: \{ enabled: (?:true|false), required: false \}/, "quote: { enabled: false, required: false }")
  .replace(/(grayEnrich|category|chainEvidenceGate|categoryAutoRoute|entailBridge): \{ enabled: (?:true|false) \}/g,
    "$1: { enabled: false }")
  .replace(/odTyped: \{ enabled: (?:true|false) \}/, "odTyped: { enabled: false }");
const fixturePath = join(tmpdir(), `jevbatch6-fixture-${process.pid}.yaml`);
writeFileSync(fixturePath, yaml);
assert.deepEqual(JEVCHECK_DEFAULTS.odTyped, { enabled: false });
assert.equal(loadConfig({ moaYaml: fixturePath, modelsJson }).jevcheck.odTyped?.enabled, false);
for (const [replacement, expected] of [["odTyped: { enabled: 1 }", /jevcheck.odTyped.enabled/],
  ["odTyped: { enabled: true }", /jevcheck.odTyped.enabled=true.*category.enabled=true/]] as const) {
  const path = join(tmpdir(), `jevbatch6-${process.pid}-${replacement.includes("1") ? "type" : "dep"}.yaml`);
  writeFileSync(path, yaml.replace("odTyped: { enabled: false }", replacement));
  assert.throws(() => loadConfig({ moaYaml: path, modelsJson }), expected);
}
const validPath = join(tmpdir(), `jevbatch6-valid-${process.pid}.yaml`);
writeFileSync(validPath, yaml.replace("category: { enabled: false }", "category: { enabled: true }")
  .replace("odTyped: { enabled: false }", "odTyped: { enabled: true }"));
const valid = loadConfig({ moaYaml: validPath, modelsJson });
assert.equal(valid.jevcheck.category?.enabled, true);
assert.equal(valid.jevcheck.odTyped?.enabled, true);
const output = z.object(moaToolOutput).strict();
const payload = { contractVersion: 2, status: "ok", aggregated: "done", verdictPrepended: false,
  aggregatedMeta: { chars: 4, sha256: "abc" }, proposals: [], receipt: {}, error: null,
  findings_summary: [], verdicts_summary: [], gaps: { records: [{ id: "x", kind: "line-anchor-drift", need: ["a"] }], writeCount: 1 } };
assert.equal(output.safeParse(payload).success, true);
assert.equal(output.safeParse({ ...payload, gaps: "bad" }).success, false);
const actual = toSlimPayload({ status: "ok", aggregated: "done", proposals: [], error: null,
  receipt: { bodySha256: "abc", gaps: payload.gaps } } as never);
assert.equal(output.safeParse(actual).success, true);
assert.deepEqual(actual.receipt.gaps, payload.gaps); // runtime gap remains in receipt; schema declaration adds no projection change
assert.equal("gaps" in actual, false);
// Request-level off bytes: producer prompt and tool schemas contain no odTyped-specific changes.
const fixture = loadConfig({ moaYaml: fixturePath, modelsJson });
const capture = async (omit: boolean, base = fixture): Promise<string[]> => {
  const config = structuredClone(base);
  config.jevcheck.odTyped = { enabled: false };
  if (omit) delete config.jevcheck.odTyped;
  const requests: string[] = [];
  await runMoa(config, { prompt: "batch6 off snapshot", preset: "moa_verify", materials }, {
    modelRuntime: null,
    runSessionImpl: (async (_runtime: unknown, _worker: unknown, prompt: string, opts: {
      extraTools?: Array<{ description: string; promptSnippet?: string; parameters: unknown }>;
    }) => {
      requests.push(JSON.stringify({ prompt, tools: opts.extraTools?.map(t => ({ description: t.description,
        snippet: t.promptSnippet, schema: t.parameters })) }));
      return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false,
        sawAgentEnd: true, structured: { accepted: false, count: 0, attempts: 0 } };
    }) as never,
  });
  assert(requests.length > 0);
  return requests;
};
const tx5 = structuredClone(fixture);
for (const flag of ["grayEnrich", "category", "chainEvidenceGate", "categoryAutoRoute", "entailBridge"] as const)
  tx5.jevcheck[flag] = { enabled: true };
tx5.jevcheck.quote = { enabled: true, required: false };
for (const base of [fixture, tx5]) assert.deepEqual(await capture(false, base), await capture(true, base));
console.log("PASS jevbatch6 behavior question, anchor endpoints, typed battery, off switch, outputSchema gaps, Tx5 in-memory");
