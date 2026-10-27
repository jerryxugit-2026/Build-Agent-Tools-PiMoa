import assert from "node:assert/strict";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { batteryEvidenceGaps, checkFinding, odTypedEvidenceGaps, odTypedRoute, renderCheckTable,
  type JevClientLike } from "../src/moa/jevcheck.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";

const f: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "test/model",
  kind: "finding", level: "MAJOR", category: "fake-green", path: "service_test.ts", lines: "1",
  anchor: "test", facts: [], claim: "测试断言没有回读", fix_expect: "验证实测输出", strength: "推理" };
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.category = { enabled: true }; cfg.premiseRound.enabled = false;
const asked: string[][] = [];
const states: string[] = [];
const client: JevClientLike = {
  async ask(state, qs) { states.push(state); asked.push(Object.keys(qs));
    return { results: Object.fromEntries(Object.keys(qs).map(k => [k, { p: .9, samples: [.9, .9] }])), calls: [] }; },
  async noul() { return { p: .9, calls: [] }; },
};
const testPart = '## 来源：service_test.ts（range 第 1-3 行）\n1| test("validates", () => {\n2| expect(service()).toEqual(1)\n3| })\n';
const subject = '## 来源：service.ts（range 第 1-3 行）\n1| export async function service() {\n2| return 1\n3| }\n';
const command = '## 材料-3（验收命令与运行结果）\ngo test ./...\n--- SKIP: TestService\nPASS\n';
const tsState = testPart + subject;
assert.deepEqual(Object.keys(batteryEvidenceGaps("fake-green", tsState, f)), ["fg-skip"]);
const fg = await checkFinding({ f, materials: new Map(), docs: [], cfg, client, evidenceState: tsState });
assert.deepEqual(fg.battery?.map(x => x.key), ["fg-vacuous", "fg-mock", "fg-readback"]);
assert.deepEqual(fg.batteryGaps?.map(g => g.id), ["P1/F1:battery:fg-skip:locate-fail"]);
assert(asked.some(keys => keys.join() === "fg-vacuous,fg-mock,fg-readback"));
for (const key of ["fg-skip", "fg-vacuous", "fg-mock", "fg-readback"]) {
  const noTest = batteryEvidenceGaps("fake-green", subject + command, f);
  assert(noTest[key]?.includes("测试函数全文（代码段）"), key);
  const noSubject = batteryEvidenceGaps("fake-green", testPart + command, f);
  assert(noSubject[key]?.includes("被测函数体（代码段）"), key);
}
for (const spelling of ['test("a", () => {', "it('a', () => {", "describe('suite', () => {"]) {
  const s = tsState.replace('test("validates", () => {', spelling);
  assert.equal(batteryEvidenceGaps("fake-green", s, f)["fg-vacuous"], undefined, spelling);
}
assert.equal(batteryEvidenceGaps("fake-green", '## 来源：legacy_test.go（range 第 1-1 行）\n1| func TestService(t *testing.T) {}\n' + subject, f)["fg-readback"], undefined);
for (const bogus of ['const example = "test(\\"fake\\")"', '// test("fake", () => {})', 'const x = "function testFake() {}"']) {
  assert(batteryEvidenceGaps("fake-green", tsState.replace('test("validates", () => {', bogus), f)["fg-vacuous"]?.includes("测试函数全文（代码段）"), bogus);
}
assert(batteryEvidenceGaps("fake-green", testPart + '## 来源：service.ts（range 第 1-1 行）\n1| const x = "function service() {}"\n', f)["fg-readback"]);
assert(batteryEvidenceGaps("fake-green", testPart + '## 来源：service.spec.ts（range 第 1-1 行）\n1| function helper() {}\n', f)["fg-readback"]);

// 044422 shape: the material pool contains both proofs after an oversized earlier segment.
const filler = { abs: "/case/filler.go", rel: "filler.go", kind: "range" as const, start: 1, end: 260,
  lines: Array.from({ length: 260 }, (_, i) => `// unrelated material ${i}: ${"x".repeat(90)}`) };
const constant = { abs: "/case/limit.go", rel: "limit.go", kind: "range" as const,
  start: 1, end: 1, lines: ["const TenantLimit = 24"] };
const mechanism = { abs: "/case/gate.go", rel: "gate.go", kind: "range" as const,
  start: 1, end: 1, lines: ["type TenantGate struct{}"] };
const materials: MaterialMap = new Map([[filler.abs, [filler]], [constant.abs, [constant]], [mechanism.abs, [mechanism]]]);
const hc = await checkFinding({ f: { ...f, category: "hardcode", path: "limit.go", lines: "1", anchor: "TenantLimit" },
  materials, docs: [], cfg, client });
assert(hc.battery?.some(x => x.key === "hd-policy"));
assert(hc.battery?.some(x => x.key === "hd-gate-exist"));
assert(!hc.batteryGaps?.some(g => /hd-policy|hd-gate-exist/.test(g.id)));
assert(states.at(-1)!.length <= 20_000 && states.at(-1)!.includes("TenantLimit")
  && states.at(-1)!.includes("TenantGate")); // both full-pool witnesses survive selective delivery
const giantCode = { ...constant, lines: [`const TenantLimit = ${"9".repeat(21_000)}`] };
const tooLarge: MaterialMap = new Map([[giantCode.abs, [giantCode]], [mechanism.abs, [mechanism]]]);
const undeliverable = await checkFinding({ f: { ...f, category: "hardcode", path: "limit.go", lines: "1", anchor: "TenantLimit" },
  materials: tooLarge, docs: [], cfg, client });
assert(undeliverable.batteryGaps?.some(g => g.id.includes("hd-policy") && g.need.some(n => n.includes("20k Jev state"))));
assert(!undeliverable.battery?.some(x => x.key === "hd-policy"));

const wr: FindingRecord = { ...f, category: "wiring" };
const fixtureReg = '## 来源：fixture_test.go（range 第 1-2 行）\n1| func TestFixture() {\n2| s := "r.Register(\\"gate\\", Gate{})"\n';
const consumer = '## 来源：consumer.go（range 第 1-1 行）\n1| func Use() { _ = r.Get("gate") }\n';
assert(batteryEvidenceGaps("wiring", fixtureReg + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const realRegister = '## 来源：registry.go（range 第 1-1 行）\n1| func Install() { r.Register("gate", Gate{}) }\n';
assert(batteryEvidenceGaps("wiring", realRegister + consumer, wr)["wr-key"] === undefined);
const fakeRead = '## 来源：fixture_test.go（range 第 1-1 行）\n1| s := "r.Get(\\"gate\\")"\n';
assert(batteryEvidenceGaps("wiring", realRegister + fakeRead, wr)["wr-key"]?.includes("消费点段（运行时读取的真实代码行）"));
assert.equal(batteryEvidenceGaps("wiring", realRegister + fakeRead, wr)["wr-static"], undefined);
const continuedFixture = ['## 来源：fixture_test.ts（range 第 1-3 行）', '1| const fixture = "prefix\\',
  '2| r.Register("gate")', '3| suffix"'].join("\n") + "\n";
assert(batteryEvidenceGaps("wiring", continuedFixture + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const escapedTemplate = '## 来源：fixture_test.ts（range 第 1-1 行）\n1| const fixture = `prefix\\`r.Register("gate")`\n';
assert(batteryEvidenceGaps("wiring", escapedTemplate + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const regexFixture = '## 来源：fixture_test.ts（range 第 1-1 行）\n1| const re = /r.Register(fake)/\n';
assert(batteryEvidenceGaps("wiring", regexFixture + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const goRawFixture = '## 来源：fixture_test.go（range 第 1-1 行）\n1| func F() { x := `C:\\`; s := `r.Register("gate")`; _ = x+s }\n';
assert(batteryEvidenceGaps("wiring", goRawFixture + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const conditionalRegex = '## 来源：fixture_test.ts（range 第 1-1 行）\n1| if (ok) /r.Register(fake)/.test(value)\n';
assert(batteryEvidenceGaps("wiring", conditionalRegex + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));
const unlabelledGo = '## 材料-1（注册点段）\nfunc F() { x := `C:\\`; s := `r.Register("gate")`; _ = x+s }\n';
assert(batteryEvidenceGaps("wiring", unlabelledGo + consumer, wr)["wr-key"]?.includes("注册点段（真实代码行）"));

for (const wording of ["冗余的重复防御", "过度防御", "画蛇添足", "防御性过当"]) assert.equal(odTypedRoute(wording), "dup");
assert.equal(odTypedRoute("过度防御与配置键"), null); // ambiguous subtypes still fail closed
const od: FindingRecord = { ...f, category: "overdesign", claim: "防御性过当" };
const odCfg = structuredClone(cfg); odCfg.odTyped = { enabled: true };
const odResult = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: odCfg, client,
  evidenceState: '## 材料-1（修复 diff 段）\n+if checked { return nil }\n' });
assert(odResult.batteryGaps?.some(x => x.id.includes("od-dup")));
const unknown = await checkFinding({ f: { ...od, claim: "无法定型的问题" }, materials: new Map(), docs: [],
  cfg: odCfg, client, evidenceState: tsState });
assert(unknown.batteryGaps?.some(x => x.id.includes("od-typed")));
const table = renderCheckTable({ perFinding: { [od.pid]: unknown }, duplicates: [], conflicts: [], oneSided: [] },
  [{ ...od, claim: "无法定型的问题" }], new Map(), 20_000, unknown.batteryGaps, true).text;
assert.match(table, /电池判定：\nod-typed｜—｜缺证据未发问/);
assert(odTypedEvidenceGaps('## 材料-1（修复 diff 段）\n+if checked { return nil }\n', od, "dup")["od-dup"]);

// Every category uses the evidence relevant to each question, without category-level missing contagion.
const hardOnly = batteryEvidenceGaps("hardcode", realRegister, { ...f, category: "hardcode" });
assert(hardOnly["hd-policy"]?.includes("常量定义段（代码行）"));
assert(!hardOnly["hd-gate-exist"]);
assert(hardOnly["hd-gate-fit"]?.length && hardOnly["hd-exempt"]?.length);
const odOnlyDiff = batteryEvidenceGaps("overdesign", '## 材料-1（修复 diff 段）\n+if checked { return nil }\n', od);
assert(odOnlyDiff["od-path"]?.includes("可识别来源的任务合同节选"));
assert(!odOnlyDiff["od-repro"]);
console.log("PASS jevbatch7 full-pool gate, TS shapes, od vocabulary/render, wiring literals and per-key evidence");
