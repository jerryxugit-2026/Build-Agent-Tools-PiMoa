import assert from "node:assert/strict";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { batteryEvidenceGaps, checkFinding, renderCheckTable, type JevClientLike } from "../src/moa/jevcheck.js";
import { buildAggregatorPrompt } from "../src/moa/orchestrate.js";
import type { FindingCheck, FindingRecord, GapRecord, MaterialMap } from "../src/moa/types.js";

const f: FindingRecord = { id: "F1", pid: "P1/F1", proposerIndex: 0, proposerModel: "test/model",
  kind: "finding", level: "MAJOR", category: "fake-green", path: "main.go", lines: "1", anchor: "main",
  facts: [], claim: "接线可能缺失", fix_expect: "核查接线", strength: "推理" };
const materials: MaterialMap = new Map();
const gap: GapRecord = { id: "P1/F1:battery:fg-mock:locate-fail", pid: f.pid, path: "main.go:1",
  factIdx: null, kind: "locate-fail", need: ["依赖装配段"] };
const fc: FindingCheck = { pid: f.pid, ref: "OK", facts: [], entail: { p1: .9 },
  status: "前提完备且全部相符", conditionFlag: false, calls: [],
  battery: [{ key: "fg-skip", p: .93 }, { key: "fg-vacuous", p: .5 }, { key: "fg-readback", p: .95 }],
  batteryGaps: [gap], batterySkipped: 2 };
const report = { perFinding: { [f.pid]: fc }, duplicates: [], conflicts: [], oneSided: [] };
const full = renderCheckTable(report, [f], materials, 20000, [gap], true).text;
assert.match(full, /电池判定：\nfg-skip｜P 0\.93｜支持指控/);
assert.match(full, /fg-vacuous｜P 0\.50｜待核/);
assert.match(full, /fg-readback｜P 0\.95｜削弱指控/);
assert.match(full, /fg-mock｜—｜缺证据未发问/);
assert.match(full, /预算｜—｜跳过 2 问（题键未记录）/);
const compact = renderCheckTable(report, [f], materials, full.length - 1, [gap], true);
assert(compact.truncated);
assert.match(compact.text, /类别：fake-green｜fg-skip 0\.93 支持指控/);
assert.match(compact.text, /（共 5 项）/);
assert.match(compact.text, /缺口清单：1 条/);
const off = renderCheckTable(report, [f], materials, 20000, undefined, false).text;
assert(!off.includes("类别：") && !off.includes("电池判定") && !off.includes("fg-skip"));
assert.equal(off, renderCheckTable({ ...report, perFinding: { [f.pid]: { ...fc, battery: undefined, batteryGaps: undefined,
  batterySkipped: undefined } } }, [{ ...f, category: undefined }], materials, 20000).text);
const promptOff = buildAggregatorPrompt({ prompt: "审查" }, [], [], "verify", 3, "test table", [], false);
const promptOn = buildAggregatorPrompt({ prompt: "审查" }, [], [], "verify", 3, "test table", [], true);
assert(!promptOff.includes("类别电池行是证据材料"));
assert(promptOn.includes("类别电池行是证据材料，答值含校准置信"));

const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.category = { enabled: true }; cfg.premiseRound.enabled = false;
const sent: string[][] = [];
const client: JevClientLike = {
  async ask(_state, questions) { sent.push(Object.keys(questions)); return { results: Object.fromEntries(
    Object.keys(questions).map(k => [k, { p: .9, samples: [.9, .9] }])), calls: [] }; },
  async noul() { return { p: .9, calls: [] }; },
};
const wiring: FindingRecord = { ...f, category: "wiring" };
const prefix = "## 材料-1（注册点段）\nfunc External(r *Registry) { r.Register(\"gate\", Gate{}) }\n\n" +
  "## 材料-2（消费点段）\nfunc Consumer(r *Registry) { _ = r.Get(\"gate\") }\n\n";
const path = "## 材料-3（入口→注册路径段）\n```go\n" +
  "// main.go\nfunc main(\n) {\n  bootstrap.\n    Run(\n    )\n}\n" +
  "// bootstrap.go\nfunc Run(\n  input string,\n) {\n  installer.InstallThing(\n    input,\n  )\n}\n" +
  "// install.go\nfunc InstallThing(\n input string,\n) {\n r.Register(\n   input, Gate{},\n )\n}\n```\n";
const present = prefix + path;
assert.equal(batteryEvidenceGaps("wiring", present, wiring)["wr-path"], undefined);
const yes = await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: present });
assert.deepEqual(yes.battery?.filter(x => x.key.startsWith("wr-hop-")).map(x => x.key), ["wr-hop-1", "wr-hop-2"]);
assert(yes.battery?.some(x => x.key === "wr-path"));
assert(sent.some(keys => keys.includes("wr-hop-1")) && sent.some(keys => keys.includes("wr-hop-2")));
sent.length = 0;
const comment = prefix + path.replace(" r.Register(\n   input, Gate{},\n )", " // r.Register(\n // input, Gate{},\n // )");
const noComment = await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: comment });
assert(noComment.batteryGaps?.some(x => x.id.includes("wr-path")));
assert(!sent.some(keys => keys.includes("wr-hop-1")));
const outside = prefix + path.replace(" r.Register(\n   input, Gate{},\n )", " _ = input");
const noThird = await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: outside });
assert(noThird.batteryGaps?.some(x => x.id.includes("wr-path")));
// A complete Register in an unrelated source segment cannot stand in for the third function's body.
assert(!noThird.battery?.some(x => x.key.startsWith("wr-hop-")));
const forgedBlock = prefix + path.replace(" r.Register(\n   input, Gate{},\n )", " /* r.Register(\n   input, Gate{},\n ) */");
assert((await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: forgedBlock }))
  .batteryGaps?.some(x => x.id.includes("wr-path")));
const forgedRaw = prefix + path.replace(" r.Register(\n   input, Gate{},\n )", " s := `r.Register(\n   input, Gate{},\n )`");
assert((await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: forgedRaw }))
  .batteryGaps?.some(x => x.id.includes("wr-path")));
const brokenMiddle = prefix + path.replace("installer.InstallThing(", "installer.Other(");
assert((await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: brokenMiddle }))
  .batteryGaps?.some(x => x.id.includes("wr-path")));
const sourceState = "## 来源：main.go（range 第 1-7 行）\n1| func main(\n2| ) {\n3| bootstrap.Run(\n4| )\n5| }\n" +
  "## 来源：bootstrap.go（range 第 1-7 行）\n1| func Run(\n2| ) {\n3| installer.InstallThing(\n4| )\n5| }\n" +
  "## 来源：install.go（range 第 1-7 行）\n1| func InstallThing(\n2| ) {\n3| r.Register(\n4| \"gate\", Gate{},\n5| )\n6| }\n" +
  "## 来源：reader.go（range 第 1-3 行）\n1| func Consume(r *Registry) {\n2| _ = r.Get(\"gate\")\n3| }\n";
assert.equal(batteryEvidenceGaps("wiring", sourceState, wiring)["wr-path"], undefined);
assert((await checkFinding({ f: wiring, cfg, materials, docs: [], client, evidenceState: sourceState }))
  .battery?.some(x => x.key === "wr-path"));
console.log("PASS jevbatch6b full/compact/off, category rules, multiline wiring positive/comment/outside/source/block/raw/middle");
