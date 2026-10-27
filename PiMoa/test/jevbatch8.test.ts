import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { batteryEvidenceGaps, checkFinding, renderCheckTable, type JevClientLike } from "../src/moa/jevcheck.js";
import type { FindingRecord, MaterialMap } from "../src/moa/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const finding: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "local/test",
  kind: "finding", level: "MAJOR", category: "fake-green", path: "service.test.ts", lines: "39-103",
  anchor: "assert", facts: [], claim: "没有回读", fix_expect: "断言回读结果", strength: "推理" };
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.category = { enabled: true }; cfg.premiseRound.enabled = false;
const requests: Array<{ state: string; keys: string[] }> = [];
const client: JevClientLike = {
  async ask(state, questions) { requests.push({ state, keys: Object.keys(questions) });
    return { results: Object.fromEntries(Object.keys(questions).map(key => [key, { p: .9, samples: [.9, .9] }])), calls: [] }; },
  async noul() { return { p: .9, calls: [] }; },
};
const segment = (name: string, lines: string[]) => ({ abs: `/case/${name}`, rel: name, kind: "range" as const,
  start: 1, end: lines.length, lines });
const map = (...segs: ReturnType<typeof segment>[]): MaterialMap => new Map(segs.map(s => [s.abs, [s]]));
const testLines = ["assert.equal(service(), 1)", "assert.deepEqual(service(), 1)", "assert(service() === 1)"];
const subject = segment("service.ts", ["export function service() { return 1; }"]);
const test = segment("service.test.ts", testLines);
const evidenced = `## 来源：service.test.ts（range 第 1-3 行）\n${testLines.map((line, i) => `${i + 1}| ${line}`).join("\n")}\n\n## 来源：service.ts（range 第 1-1 行）\n1| export function service() { return 1; }\n`;
for (const key of ["fg-vacuous", "fg-mock", "fg-readback"])
  assert.equal(batteryEvidenceGaps("fake-green", evidenced, finding)[key], undefined, key);
const script = await checkFinding({ f: finding, materials: map(test, subject), docs: [], cfg, client });
assert.deepEqual(script.battery?.map(x => x.key), ["fg-vacuous", "fg-mock", "fg-readback"]);
assert(script.batteryGaps?.some(g => g.id.includes("fg-skip"))); // acceptance output remains independently gated
// 144253: real bare-assert script from the frozen finding's test file, not a test()/it() suite.
const realScript = readFileSync(join(root, "test/jevbatch1-ab.test.ts"), "utf8").split("\n").slice(38, 103);
const realState = `## 来源：jevbatch1-ab.test.ts（range 第 39-103 行）\n${realScript.map((line, i) => `${i + 39}| ${line}`).join("\n")}\n\n## 来源：service.ts（range 第 1-1 行）\n1| export function service() { return 1; }\n`;
for (const key of ["fg-vacuous", "fg-mock", "fg-readback"])
  assert.equal(batteryEvidenceGaps("fake-green", realState, finding)[key], undefined, `144253 ${key}`);
const realCheck = await checkFinding({ f: { ...finding, path: "jevbatch1-ab.test.ts" }, materials: new Map(),
  docs: [], cfg, client, evidenceState: realState });
assert.deepEqual(realCheck.battery?.map(x => x.key), ["fg-vacuous", "fg-mock", "fg-readback"]);
const strictScript = realState.replace(realScript.map((line, i) => `${i + 39}| ${line}`).join("\n"),
  ["assert.strict.equal(service(), 1)", "assert.strict.deepEqual(service(), 1)", "assert.strict.ok(service())"].map((line, i) => `${i + 39}| ${line}`).join("\n"));
assert.equal(batteryEvidenceGaps("fake-green", strictScript, finding)["fg-mock"], undefined);
for (const lines of [["assert(1)", "assert(2)"],
  ["// assert(1)", "const s = 'assert(2)'", "assert(3)"],
  ["function helper() {", " assert(1)", " assert(2)", " assert(3)", "}"],
  ["const a = () =>", " assert(1)", "const b = () =>", " assert(2)", "const c = () =>", " assert(3)"]]) {
  const state = `## 来源：service.test.ts（range 第 1-${lines.length} 行）\n${lines.map((line, i) => `${i + 1}| ${line}`).join("\n")}\n` + evidenced.slice(evidenced.indexOf("## 来源：service.ts"));
  assert(batteryEvidenceGaps("fake-green", state, finding)["fg-vacuous"]?.includes("测试函数全文（代码段）"));
}
const filler = (i: number) => segment(`unrelated-${i}.ts`, Array.from({ length: 100 }, (_, n) =>
  `export const unrelated${i}_${n} = ${"7".repeat(115)};`));
// 6 frozen delivery-gap FG shapes, 35k-144k pool: noncomment code formerly consumed the 20k cap.
for (const id of ["153921", "195615-a", "195615-b", "015331", "054640", "044207"]) {
  const many = id === "044207" ? 9 : 3;
  const noise = Array.from({ length: many }, (_, i) => filler(i));
  const input = id === "044207" || id === "054640" ? map(subject, ...noise, test)
    : id === "195615-b" ? map(test, ...noise, subject) : map(...noise, test, subject);
  requests.length = 0;
  const check = await checkFinding({ f: { ...finding, pid: `P1/${id}` }, materials: input, docs: [], cfg, client });
  assert.deepEqual(check.battery?.map(x => x.key), ["fg-vacuous", "fg-mock", "fg-readback"], id);
  assert(!check.batteryGaps?.some(g => g.need.some(n => n.includes("20k Jev state"))), id);
  const delivered = requests.at(-1)!.state;
  assert(delivered.length <= 20_000 && delivered.includes("assert.equal(service()") && delivered.includes("function service()"), id);
}
// 044422: two independent gates require constant AND Gate definition delivered together.
requests.length = 0;
const hc = await checkFinding({ f: { ...finding, category: "hardcode", pid: "P1/044422", path: "limit.go", claim: "硬编码" },
  materials: map(filler(0), filler(1), filler(2), segment("limit.go", ["const TenantLimit = 24"]),
    segment("gate.go", ["type TenantGate struct{}"])), docs: [], cfg, client });
assert(hc.battery?.some(x => x.key === "hd-policy") && hc.battery?.some(x => x.key === "hd-gate-exist"));
assert(!hc.batteryGaps?.some(g => /hd-policy|hd-gate-exist/.test(g.id)));
assert(requests.at(-1)!.state.includes("TenantLimit") && requests.at(-1)!.state.includes("TenantGate"));
// A single over-cap witness cannot fit: preserve explicit delivery gap and never ask its key.
const huge = segment("limit.go", [`const TenantLimit = ${"9".repeat(21_000)}`]);
const impossible = await checkFinding({ f: { ...finding, category: "hardcode", path: "limit.go" },
  materials: map(huge, segment("gate.go", ["type TenantGate struct{}"])), docs: [], cfg, client });
assert(impossible.batteryGaps?.some(g => g.id.includes("hd-policy") && g.need.some(n => n.includes("20k Jev state"))));
assert(!impossible.battery?.some(x => x.key === "hd-policy"));
// A split wr-path witness has no benefit until two source sections are selected together.
const splitPath = map(segment("unrelated-big.ts", [`export const unrelated = ${"7".repeat(19_800)};`]),
  segment("bootstrap.go", ["func Bootstrap() { Install(); app.Run() }"]),
  segment("register.go", ["func Install() { r.Register(\"gate\", Gate{}) }"]));
const pathCheck = await checkFinding({ f: { ...finding, category: "wiring", path: "bootstrap.go" },
  materials: splitPath, docs: [], cfg, client });
assert(!pathCheck.batteryGaps?.some(g => g.id.includes("wr-path") && g.need.some(n => n.includes("20k Jev state"))));
assert(pathCheck.battery?.some(x => x.key === "wr-static"));

const od: FindingRecord = { ...finding, category: "overdesign", claim: "上游已有重复校验", facts: [] };
const complete = "## 材料-1（任务合同节选）\n## §scope\n- 只修复已有调用点\n\n## 材料-2（修复 diff 段）\n+if checked { return nil }\n\n## 材料-3（上游调用方代码段）\nfunc caller(input string) { if input == \"\" { return }; check(input) }\n";
const off = structuredClone(cfg); off.odTyped = { enabled: false, gatesOnly: false };
requests.length = 0;
const legacy = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: off, client, evidenceState: complete });
assert.deepEqual(legacy.battery?.map(x => x.key), ["od-path", "od-repro"]);
const door = structuredClone(cfg); door.odTyped = { enabled: true, gatesOnly: true };
requests.length = 0;
const missing = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: door, client, evidenceState: "## 材料-3（上游调用方代码段）\nfunc caller() { check(input) }\n" });
assert.equal(missing.battery, undefined);
assert.equal(requests.length, 0);
const gap = missing.batteryGaps?.find(g => g.id.includes("od-dup"));
assert(gap?.need.some(n => n.includes("任务合同节选")) && gap.need.some(n => n.includes("修复 diff")));
const table = renderCheckTable({ perFinding: { [od.pid]: missing }, duplicates: [], conflicts: [], oneSided: [] },
  [od], new Map(), 20_000, missing.batteryGaps, true).text;
assert.match(table, /od-dup｜—｜缺证据未发问/);
requests.length = 0;
const readyDoor = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: door, client, evidenceState: complete });
assert.equal(readyDoor.battery, undefined);
assert.equal(readyDoor.batteryGaps, undefined);
assert.equal(requests.length, 0);
const open = structuredClone(cfg); open.odTyped = { enabled: true, gatesOnly: false };
requests.length = 0;
const readyOpen = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: open, client, evidenceState: complete });
assert.deepEqual(readyOpen.battery?.map(x => x.key), ["od-dup"]);
assert.deepEqual(requests.at(-1)?.keys, ["od-dup"]);
for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const yaml = readFileSync(join(root, "config/moa.yaml"), "utf8");
const modelsJson = join(root, "config/models.json");
const config = (text: string) => { const path = join(tmpdir(), `jevbatch8-${process.pid}-${Math.random()}.yaml`);
  writeFileSync(path, text); return loadConfig({ moaYaml: path, modelsJson }); };
assert.equal(config(yaml).jevcheck.odTyped?.enabled, false);
assert.equal(config(yaml).jevcheck.odTyped?.gatesOnly, false);
for (const mode of [[false, false], [true, true], [true, false]] as const) {
  const loaded = config(yaml.replace("odTyped: { enabled: false }", `odTyped: { enabled: ${mode[0]}, gatesOnly: ${mode[1]} }`));
  assert.deepEqual(loaded.jevcheck.odTyped, { enabled: mode[0], gatesOnly: mode[1] });
  requests.length = 0;
  const wired = await checkFinding({ f: od, materials: new Map(), docs: [], cfg: loaded.jevcheck,
    client, evidenceState: complete });
  assert.deepEqual(wired.battery?.map(x => x.key), !mode[0] ? ["od-path", "od-repro"]
    : mode[1] ? undefined : ["od-dup"]);
  assert.equal(requests.length === 0, mode[0] && mode[1]);
}
assert.throws(() => config(yaml.replace("odTyped: { enabled: false }", "odTyped: { enabled: false, gatesOnly: true }")), /jevcheck.odTyped.gatesOnly=true/);
for (const value of ["1", "null", "'true'"])
  assert.throws(() => config(yaml.replace("odTyped: { enabled: false }", `odTyped: { enabled: false, gatesOnly: ${value} }`)), /jevcheck.odTyped.gatesOnly 必须是布尔值/);
console.log("PASS jevbatch8 priority delivery, 144253 assert scripts, od gatesOnly tri-state and config");
