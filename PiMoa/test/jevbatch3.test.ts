import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { readFileSync } from "node:fs";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { batteryEvidenceGaps, checkFinding, QUESTIONS, renderCheckTable, type JevClientLike } from "../src/moa/jevcheck.js";
import { CategorizedSubmitFindingsParams, SubmitFindingsParams, createFindingsState, createSubmitFindingsTool, validateFinding, type Finding } from "../src/tools/submit_findings.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

const gold = JSON.parse(readFileSync(WS + "/artifacts/jev-material-supply-20261022/goldcases-v1.json", "utf8")) as {
  cases: Array<{ id: string; category: FindingRecord["category"]; state: string; finding: string }>;
  battery_questions: Record<string, { instructions: string }>;
};
for (const [key, spec] of Object.entries(gold.battery_questions)) {
  assert.equal(QUESTIONS[key as keyof typeof QUESTIONS].instructions,
    key === "od-conflict" ? "该 finding 所指的问题（改动项为之防御的那个风险）与本任务合同条款直接冲突——即合同要求的行为/范围与该风险的存在互斥。" : spec.instructions,
    `question anchor ${key}`);
}
const target = gold.cases.find(c => c.id === "fg-pos-1")!;
const missing = gold.cases.find(c => c.id === "fg-miss-1")!;
const wiring = gold.cases.find(c => c.id === "wr-pos-2")!;
const single = { abs: "/case/test.go", rel: "test.go", kind: "range" as const, start: 1, end: 3,
  lines: ["func TestThing(t *testing.T) {", " assert.Equal(t, got, want)", "}"] };
const materials: MaterialMap = new Map([[single.abs, [single]]]);
const f: FindingRecord = { id: "F1", pid: "P1/F1", category: "fake-green", kind: "finding", level: "MAJOR",
  path: single.rel, lines: "1", anchor: "func TestThing", facts: [], claim: target.finding,
  fix_expect: "修复当前断言并执行回读检验。", strength: "推理", proposerIndex: 0, proposerModel: "test/mock" };
assert.deepEqual(Object.keys(batteryEvidenceGaps("fake-green", target.state, f)), []); // batch 7: mock only needs test + tested body
assert(Object.keys(batteryEvidenceGaps("fake-green", missing.state, f)).includes("fg-skip"));
assert(batteryEvidenceGaps("wiring", wiring.state, { ...f, category: "wiring" })["wr-path"]?.some(x => x.includes("注释式路径")));
assert.equal(batteryEvidenceGaps("overdesign", gold.cases.find(c => c.id === "od-pos-1")!.state, { ...f, category: "overdesign" })["od-path"], undefined);
assert(batteryEvidenceGaps("overdesign", gold.cases.find(c => c.id === "od-miss-1")!.state, { ...f, category: "overdesign" })["od-path"]?.some(x => x.includes("合同节选")));

const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.category = { enabled: true }; cfg.chain = { enabled: false, minSteps: 2, maxSteps: 6 }; cfg.premiseRound.enabled = false;
const sent: string[][] = [];
const client: JevClientLike = {
  async ask(_state, questions, n) {
    sent.push(Object.keys(questions));
    return { results: Object.fromEntries(Object.keys(questions).map(key => [key, { p: 0.85, samples: [0.8, 0.9] }])),
      calls: Object.keys(questions).flatMap(key => Array.from({ length: n }, () => ({ q: questions[key]!.q, p: 0.85,
        stateSha256: "dummy", inputTokens: 1, ms: 1 }))) };
  },
  async noul() { return { p: 0.85, calls: [] }; },
};
const result = await checkFinding({ f, cfg, materials, docs: [], client, evidenceState: target.state });
assert.deepEqual(result.battery?.map(x => x.key), ["fg-skip", "fg-vacuous", "fg-mock", "fg-readback"]);
assert.equal(result.batteryGaps?.length, undefined);
assert(sent.some(keys => keys.includes("fg-mock")));
const table = renderCheckTable({ perFinding: { [f.pid]: result }, duplicates: [], conflicts: [], oneSided: [] }, [f], materials, 3000).text;
assert(table.includes("类别：fake-green"));
sent.length = 0;
const lowBudget = await checkFinding({ f, cfg, materials, docs: [], client, evidenceState: target.state, remainingCalls: () => 1 });
assert.equal(lowBudget.batterySkipped, 4);
assert(!sent.some(keys => keys.some(k => k.startsWith("fg-"))));
const off = await checkFinding({ f, cfg: { ...cfg, category: { enabled: false } }, materials, docs: [], client, evidenceState: target.state });
assert.equal(off.battery, undefined); assert.equal(off.batterySkipped, undefined); assert.equal(off.batteryGaps, undefined);
// The production renderer numbers lines (N|). A source-path heading without the word
// "注册" must still count REAL executable Register/Get calls, not comment-only paths.
const production = `## 来源：main.go（range 第 1-1 行）\n1| func main() { bootstrap.Run() }\n` +
  `## 来源：bootstrap.go（range 第 1-1 行）\n1| func Run() { gov.Install(r) }\n` +
  `## 来源：impl.go（range 第 1-1 行）\n1| func Install(r *Registry) { r.Register("gate", Gate{}) }\n` +
  `## 来源：reader.go（range 第 1-1 行）\n1| func Read(r *Registry) { _ = r.Get("gate") }\n`;
assert.equal(batteryEvidenceGaps("wiring", production, { ...f, category: "wiring" })["wr-path"], undefined);
const onlyComments = production.replace(/1\| func Read\([^\n]+/, "1| // func Read(r *Registry) { _ = r.Get(\"gate\") }");
assert(batteryEvidenceGaps("wiring", onlyComments, { ...f, category: "wiring" })["wr-key"]?.some(x => x.includes("消费点")));
const wrongChain = production.replace("bootstrap.Run()", "bootstrap.DoesNotCallRun()");
const wrong = await checkFinding({ f: { ...f, category: "wiring" }, cfg, materials, docs: [], client,
  evidenceState: wrongChain });
assert(wrong.batteryGaps?.some(g => g.id.includes("wr-path")));

const accepted: Finding = { ...f, facts: ["通用事实：该例用于分类测试", "通用事实：第二段事实用于维持提交有效", "通用事实：第三段事实用于维持提交有效"] };
const state = createFindingsState();
const toolOff = createSubmitFindingsTool(state, materials, "/case", [], { maxAttempts: 3 });
assert.strictEqual(toolOff.parameters, SubmitFindingsParams);
assert(!JSON.stringify(toolOff.parameters).includes("category"));
assert(!toolOff.description.includes("category"));
const stateOn = createFindingsState();
const toolOn = createSubmitFindingsTool(stateOn, materials, "/case", [], { maxAttempts: 3, categoryEnabled: true });
assert.strictEqual(toolOn.parameters, CategorizedSubmitFindingsParams);
assert(JSON.stringify(toolOn.parameters).includes("category"));
assert(toolOn.description.includes("category"));
assert(validateFinding({ ...accepted, category: "bad" as Finding["category"] }, materials, "/case", [], { categoryEnabled: true }).some(s => s.includes("category 值无效")));
const invalidPayload = { findings: [{ ...accepted, category: "bad" as Finding["category"] }] };
assert.equal(Value.Check(CategorizedSubmitFindingsParams, invalidPayload), true); // handler, not TypeBox, owns unknown enum strings
assert.equal(Value.Check(CategorizedSubmitFindingsParams, { findings: [{ ...accepted, category: 42 }] }), false); // malformed type rejected before handler
assert.equal(Value.Check(SubmitFindingsParams, invalidPayload), true); // old schema tolerates extra field but handler drops it
const bad = await toolOn.execute("bad", invalidPayload);
assert.equal(stateOn.attempts, 1);
assert.equal(bad.isError, true);
assert(JSON.stringify(bad.content).includes("category 值无效"));
console.log("PASS jevbatch3 category schema/handler/off/assembly/budget/table/question anchors");
