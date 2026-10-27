import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { checkFinding, checkQuote, collectTerminalGaps, renderCheckTable, runJevCheck, type JevClientLike } from "../src/moa/jevcheck.js";
import { runMoa } from "../src/moa/orchestrate.js";
import { createFindingsState, createSubmitFindingsTool, submitFindingsParams, SubmitFindingsParams, type Finding } from "../src/tools/submit_findings.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";

const a = "/case/a.ts", b = "/case/b.ts";
const segA = { abs: a, rel: "a.ts", kind: "range" as const, start: 1, end: 3, lines: ["function alpha() {", " const quoteAnchor = 1; ", "}"] };
const segAOther = { abs: a, rel: "a.ts", kind: "range" as const, start: 8, end: 9, lines: [" const sameElse = 2;", "const noMatch = 1;"] };
const segB = { abs: b, rel: "b.ts", kind: "range" as const, start: 3, end: 4, lines: [" const across = 3;", "const other = 4;"] };
const materials: MaterialMap = new Map([[a, [segA, segAOther]], [b, [segB]]]);
const text = "a.ts 第 2 行存在 quoteAnchor";
const makeF = (quote: string, status = "相符", refText = text): FindingRecord => ({
  pid: "P1/F1", id: "F1", kind: "finding", level: "MAJOR", path: "a.ts", lines: "2", anchor: "quoteAnchor",
  facts: [refText], factQuotes: [quote], factRefs: [{ text: refText, status: status as "相符", file: "a.ts", a: 2, b: 2 }],
  claim: "该代码行为存在真实缺陷，需要复核", fix_expect: "完成必要修改并复核相关行为", strength: "推理", proposerModel: "mock/mock", proposerIndex: 0,
});
const cfg = structuredClone(JEVCHECK_DEFAULTS); cfg.enabled = true; cfg.quote = { enabled: true, required: false };
cfg.premiseRound.enabled = false; cfg.chain = { enabled: false, minSteps: 2, maxSteps: 6 };
const sent: Array<{ state: string; questions: Record<string, { instructions: string }> }> = [];
const client: JevClientLike = {
  async ask(state, questions) { sent.push({ state, questions }); return { results: Object.fromEntries(Object.keys(questions).map(k => [k, { p: 0.9, samples: [0.9] }])), calls: [] }; },
  async noul() { return { p: 0.9, calls: [] }; },
};
const check = (f: FindingRecord, pool = materials) => checkFinding({ f, cfg, materials: pool, docs: [], client });
const exact = makeF("  const quoteAnchor = 1;  ");
assert.equal(checkQuote(exact.factQuotes![0]!, text, exact, exact.factRefs![0], materials, { abs: a, a: 2, b: 2 }).status, "精确");
let result = await check(exact);
assert.equal(result.facts[0]?.quoteStatus, "精确");
assert.equal(result.facts[0]?.slice?.abs, a);
assert.equal(result.facts[0]?.ref, "相符");
assert(sent[0]?.state.includes("2|  const quoteAnchor = 1; "));
assert.equal(sent[0]?.questions.f0?.instructions.includes(text), true);
const withoutRef = makeF("const quoteAnchor = 1;"); delete withoutRef.factRefs;
result = await check(withoutRef);
assert.equal(result.facts[0]?.quoteStatus, "精确");
assert.equal(result.facts[0]?.slice?.abs, a);
const withoutRefCross = makeF("const across = 3;"); delete withoutRefCross.factRefs;
result = await check(withoutRefCross);
assert.equal(result.facts[0]?.quoteStatus, "跨文件校正");
assert.equal(result.facts[0]?.slice?.abs, b);
assert(sent.at(-1)?.questions.f0?.instructions.includes("b.ts 第 3 行"));
const doubled: MaterialMap = new Map(materials); doubled.set(b, [{ ...segB, lines: [" const across = 3;", " const quoteAnchor = 1; "] }]);
assert.equal(checkQuote("const quoteAnchor = 1;", text, exact, exact.factRefs![0], doubled, { abs: a, a: 2, b: 2 }).status, "歧义");

sent.length = 0;
const same = makeF("const sameElse = 2;");
result = await check(same);
assert.equal(result.facts[0]?.quoteStatus, "同文件校正");
assert.equal(result.facts[0]?.correctedLine, 8);
assert.equal(result.facts[0]?.slice?.a, 8);
assert.deepEqual([same.factRefs![0]!.file, same.factRefs![0]!.a, same.factRefs![0]!.rewritten], ["a.ts", 8, "a.ts 第 8 行存在 quoteAnchor"]);
assert.match(result.facts[0]!.quoteAudit!, /file\/a\/rewritten 原子校正/);
assert(sent[0]?.questions.f0?.instructions.includes("a.ts 第 8 行"));
// A unique hit in the original file's other section may resolve an Appendix C 待核 reference.
result = await check(makeF("const sameElse = 2;", "待核"));
assert.equal(result.facts[0]?.quoteStatus, "同文件校正");
assert.equal(result.facts[0]?.ref, "已校正");
result = await check(makeF("const quoteAnchor = 1;", "待核"));
assert.equal(result.facts[0]?.quoteStatus, "精确");
assert.equal(result.facts[0]?.ref, "相符");
// Refusing an unrewritable code fact must leave every original reference field untouched.
const broken = makeF("const sameElse = 2;", "待核", "无行号但原句引用 quoteAnchor");
const before = structuredClone(broken.factRefs![0]);
result = await check(broken);
assert.equal(result.facts[0]?.quoteStatus, "校正待核");
assert.deepEqual(broken.factRefs![0], before);
assert.equal(result.facts[0]?.slice, undefined);
const pendingGaps = collectTerminalGaps([broken], { [broken.pid]: result });
assert.deepEqual(pendingGaps.filter(g => g.factIdx === 0).map(g => [g.kind, g.need[0]]),
  [["quote-ambiguous", "校正候选已定位但事实文本无法原子改写：修正事实中的文件/行号引用后重交，或人工核对候选位置"]]);
const firstNormalSecondAlarm = { ...result, facts: [
  { text: "normal", kind: "code" as const, p: 0.9, status: "相符" as const },
  { ...result.facts[0]!, quoteStatus: "歧义" as const },
] };
const alarmReport = { perFinding: { [broken.pid]: firstNormalSecondAlarm }, duplicates: [], conflicts: [], oneSided: [] };
const fullAlarm = renderCheckTable(alarmReport, [broken], materials, 40000).text;
const compactAlarm = renderCheckTable(alarmReport, [broken], materials, fullAlarm.length - 1);
assert.equal(compactAlarm.truncated, true);
assert.match(compactAlarm.text, /🔴quote F2：歧义/);
assert.doesNotMatch(compactAlarm.text, /🔴quote F1：歧义/);
const pendingAlarm = { ...firstNormalSecondAlarm, facts: [firstNormalSecondAlarm.facts[0]!,
  { ...result.facts[0]!, quoteStatus: "校正待核" as const }] };
const pendingReport = { ...alarmReport, perFinding: { [broken.pid]: pendingAlarm } };
const pendingFull = renderCheckTable(pendingReport, [broken], materials, 40000).text;
assert.match(renderCheckTable(pendingReport, [broken], materials, pendingFull.length - 1).text, /🔴quote F2：校正待核/);

sent.length = 0;
const cross = makeF("const across = 3;");
result = await check(cross);
assert.equal(result.facts[0]?.quoteStatus, "跨文件校正");
assert.deepEqual([cross.factRefs![0]!.file, cross.factRefs![0]!.a, cross.factRefs![0]!.rewritten], ["b.ts", 3, "b.ts 第 3 行存在 quoteAnchor"]);
assert.match(result.facts[0]!.quoteAudit!, /跨文件引用/);
assert(sent[0]?.questions.f0?.instructions.includes("b.ts 第 3 行"));
assert.match(renderCheckTable({ perFinding: { [cross.pid]: result }, duplicates: [], conflicts: [], oneSided: [] }, [cross], materials, 40000).text, /跨文件引用/);
const noCrossRewrite = makeF("const across = 3;", "待核", "a.ts 没有行号信息");
result = await check(noCrossRewrite);
assert.equal(result.facts[0]?.quoteStatus, "校正待核");
assert.equal(noCrossRewrite.factRefs![0]!.file, "a.ts");

sent.length = 0;
const absent = makeF("const neverAttached = 999;");
result = await check(absent);
assert.equal(result.facts[0]?.quoteStatus, "本轮材料池未找到 quote");
assert.equal(result.facts[0]?.status, "相符"); // no semantic gate: existing locate/JEV still runs
const red = renderCheckTable({ perFinding: { [absent.pid]: result }, duplicates: [], conflicts: [], oneSided: [] }, [absent], materials, 40000).text;
assert.match(red, /🔴quote：本轮材料池未找到 quote/);
assert.doesNotMatch(red, /编造事实/);
assert.equal(checkQuote("unused", text, absent, absent.factRefs![0], materials, null).status, "本轮材料池未找到 quote");
const ambiguous = makeF("const across = 3;");
const duplicatePool: MaterialMap = new Map(materials); duplicatePool.set(a, [segA, { ...segAOther, lines: ["const across = 3;", "const noMatch = 1;"] }]);
sent.length = 0;
result = await check(ambiguous, duplicatePool);
assert.equal(result.facts[0]?.status, "待核");
assert.equal(result.facts[0]?.quoteStatus, "歧义");
assert.equal(result.facts[0]?.slice, undefined);
assert(!sent.some(s => Object.keys(s.questions).includes("f0")));
assert.deepEqual(collectTerminalGaps([ambiguous], { [ambiguous.pid]: result }).filter(x => x.factIdx === 0).map(x => x.kind), ["quote-ambiguous"]);
const hard = makeF("const quoteAnchor = 1;", "未命中");
sent.length = 0; result = await check(hard);
assert.equal(result.facts[0]?.status, "不符"); assert.equal(result.facts[0]?.quoteStatus, undefined);
assert.equal(hard.factRefs![0]!.status, "未命中"); assert(!sent.some(s => Object.keys(s.questions).includes("f0")));
for (const status of ["行号越界", "文件未附"] as const) {
  result = await check(makeF("const quoteAnchor = 1;", status));
  assert.equal(result.facts[0]?.status, "不符"); assert.equal(result.facts[0]?.quoteStatus, undefined);
}
// Identical path/line repeated by overlapping segments is one physical match.
const overlaps: MaterialMap = new Map([[a, [segA, structuredClone(segA)]]]);
assert.equal(checkQuote("const quoteAnchor = 1;", text, exact, exact.factRefs![0], overlaps, { abs: a, a: 2, b: 2 }).status, "精确");
const report = await runJevCheck({ findings: [ambiguous], materials: duplicatePool, cfg, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never, cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.equal(report.quoteTierCounts?.["歧义"], 1);
assert.deepEqual(report.gaps?.records.filter(g => g.kind === "quote-ambiguous").map(g => g.id), ["P1/F1:fact0:quote-ambiguous"]);
assert.match(report.tableText, /quote-ambiguous/);
const four = ["const quoteAnchor = 1;", "const sameElse = 2;", "const across = 3;", "const neverAttached = 999;"].map((quote, i) => ({ ...makeF(quote), id: `F${i + 1}`, pid: `P1/F${i + 1}` }));
const precalculated = new Map();
for (const item of four) precalculated.set(item.pid, await check(item));
const tiers = await runJevCheck({ findings: four, materials, cfg, client, workers: [], precomputed: precalculated,
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never, cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.deepEqual(tiers.quoteTierCounts, { "精确": 1, "同文件校正": 1, "跨文件校正": 1, "本轮材料池未找到 quote": 1 });
const offCfg = { ...cfg, quote: { enabled: false, required: false } };
const offF = makeF("const across = 3;");
const offWith = await checkFinding({ f: offF, cfg: offCfg, materials, docs: [], client });
const offWithout = await checkFinding({ f: { ...offF, factQuotes: undefined }, cfg: offCfg, materials, docs: [], client });
assert.deepEqual(offWith, offWithout);
assert.equal(offWith.facts[0]?.quoteStatus, undefined);
assert.equal(offWith.facts[0]?.quoteAudit, undefined);
const offReport = await runJevCheck({ findings: [offF], materials, cfg: offCfg, client, workers: [],
  runSessionFn: (async () => { throw Error("unexpected"); }) as never, modelRuntime: null as never, cwd: "/case", readRoots: ["/case"], deadlineMs: 30000 });
assert.equal(offReport.quoteTierCounts, undefined); assert.equal(offReport.gaps, undefined);

const submitted: Finding = { ...exact, facts: ["通用事实：提交测试第一项", "通用事实：提交测试第二项", "通用事实：提交测试第三项"] };
const stateOff = createFindingsState();
const toolOff = createSubmitFindingsTool(stateOff, materials, "/case", [], { maxAttempts: 3 });
assert.strictEqual(toolOff.parameters, SubmitFindingsParams);
assert.strictEqual(submitFindingsParams(false, false), SubmitFindingsParams);
assert(!JSON.stringify(toolOff.parameters).includes("factQuotes"));
assert(!toolOff.description.includes("factQuotes")); assert(!toolOff.promptSnippet?.includes("factQuotes"));
const stateOn = createFindingsState();
const toolOn = createSubmitFindingsTool(stateOn, materials, "/case", [], { maxAttempts: 3, quoteEnabled: true, quoteRequired: true });
assert(JSON.stringify(toolOn.parameters).includes("factQuotes"));
assert(toolOn.description.includes("factQuotes 必填")); assert(toolOn.promptSnippet?.includes("factQuotes 必填"));
const submitParam = { findings: [{ ...submitted, factQuotes: undefined }] };
assert.equal(Value.Check(toolOn.parameters, submitParam), true); // missing required reaches execute and consumes an attempt
for (const [i, badQuotes] of [undefined, "scalar", [" "], [12], ["one", "two", "three", "four"]].entries()) {
  const payload = { findings: [{ ...submitted, factQuotes: badQuotes }] };
  assert.equal(Value.Check(toolOn.parameters, payload), true, `bad shape ${i} reaches handler`);
  const state = createFindingsState();
  const probe = createSubmitFindingsTool(state, materials, "/case", [], { maxAttempts: 3, quoteEnabled: true, quoteRequired: true });
  const rejected = await probe.execute("bad", payload as never);
  assert.equal(state.attempts, 1); assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /factQuotes/);
}
const stateOptional = createFindingsState();
const optional = createSubmitFindingsTool(stateOptional, materials, "/case", [], { maxAttempts: 3, quoteEnabled: true });
assert(!JSON.stringify((await optional.execute("optional", submitParam as never)).content).includes("factQuotes"));
assert.equal(stateOptional.accepted?.[0]?.factQuotes, undefined);
const stateOffSubmit = createFindingsState();
const offSubmit = createSubmitFindingsTool(stateOffSubmit, materials, "/case", [], { maxAttempts: 3 });
await offSubmit.execute("off", { findings: [{ ...submitted, factQuotes: ["x"] }] } as never);
assert.equal(stateOffSubmit.accepted?.[0]?.factQuotes, undefined);

for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const yamlPath = fileURLToPath(new URL("../config/moa.yaml", import.meta.url));
const modelsJson = fileURLToPath(new URL("../config/models.json", import.meta.url));
// Pin the local fixture, not the production flags: categoryAutoRoute requires category.
const yaml = readFileSync(yamlPath, "utf8")
  .replace(/quote: \{ enabled: (?:true|false), required: false \}/, "quote: { enabled: false, required: false }")
  .replace(/(grayEnrich|category|chainEvidenceGate|categoryAutoRoute|entailBridge): \{ enabled: (?:true|false) \}/g,
    "$1: { enabled: false }")
  .replace(/odTyped: \{ enabled: (?:true|false) \}/, "odTyped: { enabled: false }");
const fixturePath = join(tmpdir(), `jevbatch4-fixture-${process.pid}.yaml`);
writeFileSync(fixturePath, yaml);
const config = loadConfig({ moaYaml: fixturePath, modelsJson });
assert.deepEqual(config.jevcheck.quote, { enabled: false, required: false });
const invalidYaml = join(tmpdir(), `jevbatch4-invalid-${process.pid}.yaml`);
writeFileSync(invalidYaml, yaml.replace("quote: { enabled: false, required: false }", "quote: { enabled: false, required: true }"));
assert.throws(() => loadConfig({ moaYaml: invalidYaml, modelsJson }), /quote.required=true.*quote.enabled=true/);
// Real orchestrator integration: verify proposer receives the same opt-in flag in prompt and tool.
// The stub deliberately returns an unsuccessful proposer so no live model/Jev is invoked.
const capture = async (enabled: boolean, base = config) => {
  const source = structuredClone(base);
  source.jevcheck.quote = { enabled, required: false };
  const inputs: Array<{ prompt: string; description: string; snippet: string; schema: string }> = [];
  await runMoa(source, { prompt: "quote wiring test", preset: "moa_verify", materials }, {
    modelRuntime: null,
    runSessionImpl: (async (_runtime: unknown, _worker: unknown, prompt: string, options: {
      extraTools?: Array<{ description: string; promptSnippet?: string; parameters: unknown }>;
    }) => {
      const tool = options.extraTools?.[0];
      inputs.push({ prompt, description: tool?.description ?? "", snippet: tool?.promptSnippet ?? "", schema: JSON.stringify(tool?.parameters ?? {}) });
      return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false,
        sawAgentEnd: true, structured: { accepted: false, count: 0, attempts: 0 } };
    }) as never,
  });
  assert(inputs.length > 0);
  return inputs[0]!;
};
const tx5 = structuredClone(config);
for (const flag of ["grayEnrich", "category", "chainEvidenceGate", "categoryAutoRoute", "entailBridge"] as const)
  tx5.jevcheck[flag] = { enabled: true };
tx5.jevcheck.quote = { enabled: true, required: false };
for (const base of [config, tx5]) {
  const offWiring = await capture(false, base), onWiring = await capture(true, base);
  for (const key of ["prompt", "description", "snippet", "schema"] as const) {
    assert.doesNotMatch(offWiring[key], /factQuotes|quote wiring test.*factQuotes/s, `off ${key}`);
    assert.match(onWiring[key], /factQuotes/, `on ${key}`);
  }
}
console.log("PASS jevbatch4 quote tiers, ambiguities, atomic correction, hard errors, counted REJECT, off, telemetry, Tx5 in-memory");
