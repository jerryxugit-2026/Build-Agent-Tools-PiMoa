/**
 * golden-regression.test.ts —— 波3 硬验收：208 例金标准回归（回放式，不发任何真实 JEV 请求）。
 *
 * 运行：npx tsx test/golden-regression.test.ts
 *
 * 数据（只读；不在写集）：
 *   <workspace>/artifacts/jev-finding-truth-20260922/cases.json        （214 例：material/claim/
 *     facts/chain 步文本与 kind/gt 真值/桶标签）
 *   <workspace>/artifacts/jev-finding-truth-20260922/judge-results.jsonl（逐步 P 双采样数组 +
 *     mech note + 记录在案的 verdict/rule/broken；同例多行按 score.mjs 口径取 run_ts 最新）
 *
 * 口径（金标准期望值**不得按实现回抄**——来自 judge-results.jsonl 记录与 REPORT-B.md §1/§3 数字）：
 *   每例用**本仓实现**（mechCorroborate + verdictOf）重算 verdict/rule/brokenStep，与记录 verdict
 *   逐例断言一致；不一致的例逐个打印 diff 明细并在汇总里单列（不得静默跳过、不得按结果改期望）。
 *
 * 预期差异形状（封闭集合，超出即测试红）：
 *   (1) mech-rules/v1 词边界增强（FB-12）：存在性形态且 probe 为更长标识符前缀 ⇒ 记录「命中=证伪佐证」
 *       在边界感知匹配下变「未命中=不佐证」——只允许该形状的 mech 漂移；
 *   (2) 具名增量 L-C164（规则来源：设计 v0.1 §B4 修正案 + 主代理 2026-09-22 裁决「读法 A」——严格证伪
 *       候选步的 mech 三分之 locate-miss 档）：严格证伪 f3（双样 0.08/0.07 ≤ REFUTE=0.1）但材料只有一行
 *       说明文字、无 1076 行（mech reason=locate-miss）⇒ 记录「因果存疑（DOWNGRADE-noMech）」迁
 *       「依据不足（INSUFFICIENT-locateMiss）」。除此 1 例，逐例零容忍。
 *
 * 期望分布（REPORT-B §1 的 48/64/0/102 经具名增量 L-C164 迁移 1 例）：
 *   KILL 48 / 因果存疑 63 / 依据不足 1 / 未拆倒 102。
 * 四项统计断言（REPORT-B §1/§3；有效集 208 = 214 − 6 语料坏件 L-A3/A6/A8/A60/A61/A62）：
 *   有效 KILL 42/42 说对（gt=假）；陷阱 T01–T14 14/14 KILL；真例 0 误杀（150 有效真例）。
 */
import { readFileSync } from "node:fs";
import { verdictOf, type TruthStep, type TruthStepKind } from "../src/moa/jevcheck.js";
import { mechCorroborate, type MechResult } from "../src/moa/mech.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}
function log(...a: unknown[]): void {
  console.log("[golden]", ...a);
}

// ---------- 数据装载（只读）----------
const DATA_DIR = WS + "/artifacts/jev-finding-truth-20260922";
const CASES_PATH = `${DATA_DIR}/cases.json`;
const RESULTS_PATH = `${DATA_DIR}/judge-results.jsonl`;

interface CaseStep {
  id: string;
  kind?: string;
  text: string;
}
interface GoldCase {
  id: string;
  source: string;
  bucket: string[];
  material: string;
  claim: string;
  facts: CaseStep[];
  chain: CaseStep[];
  gt: { bug: boolean | null; finding_truth: string; broken: string | null; ground_truth_src: string; how_known: string };
}
interface RecMech {
  checkable: boolean;
  refuted: boolean;
  note: string;
}
interface RecStep {
  id: string;
  kind?: string;
  samples: number[];
  mean: number | null;
  mech: RecMech;
}
interface RecRow {
  case: string;
  bucket: string[];
  gt: GoldCase["gt"];
  run_ts?: number;
  parse_gap: number;
  steps: RecStep[];
  verdict: string;
  rule: string;
  broken: string | null;
}

const cases: GoldCase[] = (JSON.parse(readFileSync(CASES_PATH, "utf8")) as { cases: GoldCase[] }).cases;
const rows: RecRow[] = readFileSync(RESULTS_PATH, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as RecRow);
// 同 case 多行：取 run_ts 最新（score.mjs R2-F4 口径：`>=` 比较，后行覆盖）。
const recByCase = new Map<string, RecRow>();
for (const r of rows) {
  const prev = recByCase.get(r.case);
  if (!prev || (r.run_ts ?? 0) >= (prev.run_ts ?? 0)) recByCase.set(r.case, r);
}

log(`数据装载：cases=${cases.length} 行数=${rows.length} 去重后=${recByCase.size}（cases.json/judge-results.jsonl，只读）`);
assert(cases.length === 214, `cases.json 214 例（实际 ${cases.length}）`);
assert(recByCase.size === 214, `judge-results.jsonl 去重 214 例（实际 ${recByCase.size}）`);

// ---------- 步归一：kind 缺省 = 证据步（judge 语义 `s.kind !== "link"` 才进 KILL 候选）----------
const NON_LINK_KINDS: TruthStepKind[] = ["fact", "general", "code", "absence", "runtime", "condition"];
function normKind(k: string | undefined): TruthStep["kind"] {
  if (k === "link") return "link";
  return (NON_LINK_KINDS as string[]).includes(k ?? "") ? (k as TruthStepKind) : "fact";
}

// ---------- 词边界形状识别（mech-rules/v1 FB-12）：probe 为更长标识符前缀 ----------
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const EXISTS_NOTE = /存在性核对: 作用域内含「([^」]+)」=(true|false)/;

/** 该步的 mech 漂移是否属「probe 为更长标识符前缀」形状（记录=命中/佐证证伪，本仓=未命中/不佐证）。 */
function wordBoundaryDrift(rec: RecMech, ours: MechResult, probe: string, material: string): boolean {
  const rm = EXISTS_NOTE.exec(rec.note);
  const om = EXISTS_NOTE.exec(ours.note);
  if (!rm || !om) return false;
  if (rm[1] !== om[1] || rm[2] !== "true" || om[2] !== "false") return false;
  if (probe !== rm[1]) return false;
  // probe 为更长标识符前缀的机械证据：material 中 probe 后紧跟标识符字符（includes 命中、边界感知不命中）。
  return new RegExp(`${escapeRe(probe)}[A-Za-z0-9_]`).test(material);
}

// ---------- 回放主循环 ----------
interface DiffCase {
  id: string;
  cls: "named" | "word-boundary" | "unexpected";
  rec: { verdict: string; rule: string; broken: string | null };
  ours: { verdict: string; rule: string; brokenStep?: string };
  detail: string[];
}

const BAD_FIXTURES = new Set(["L-A3", "L-A6", "L-A8", "L-A60", "L-A61", "L-A62"]); // 语料坏件（REPORT-B §2）
const distOurs: Record<string, number> = {};
const distRec: Record<string, number> = {};
const diffs: DiffCase[] = [];
const verdictById = new Map<string, string>();
let mechDriftSteps = 0; // 重算 mech 与记录 (checkable,refuted) 不同步的步数（形状另计）
let verdictMatch = 0;

for (const c of cases) {
  const rec = recByCase.get(c.id);
  if (!rec) {
    assert(false, `${c.id}：judge-results.jsonl 缺记录（不得静默跳过）`);
    continue;
  }
  const caseSteps: CaseStep[] = [...(c.facts ?? []), ...(c.chain ?? [])];
  const inputs: TruthStep[] = caseSteps.map((s) => {
    const rs = rec.steps.find((x) => x.id === s.id);
    const mech = mechCorroborate({ text: s.text }, c.material);
    return { id: s.id, kind: normKind(s.kind ?? rs?.kind), text: s.text, samples: rs?.samples ?? [], mech } as TruthStep;
  });
  const ours = verdictOf(inputs);
  verdictById.set(c.id, ours.verdict);

  distOurs[ours.verdict] = (distOurs[ours.verdict] ?? 0) + 1;
  distRec[rec.verdict] = (distRec[rec.verdict] ?? 0) + 1;

  // mech 漂移登记（形状审计）。
  const driftSteps: Array<{ id: string; rec: RecMech; ours: MechResult; wb: boolean }> = [];
  for (const st of inputs) {
    const rs = rec.steps.find((x) => x.id === st.id);
    if (!rs) continue;
    if (rs.mech.checkable !== st.mech.checkable || rs.mech.refuted !== st.mech.refuted) {
      mechDriftSteps++;
      const probeM = EXISTS_NOTE.exec(rs.mech.note);
      driftSteps.push({ id: st.id, rec: rs.mech, ours: st.mech, wb: probeM ? wordBoundaryDrift(rs.mech, st.mech, probeM[1]!, c.material) : false });
    }
  }

  const sameVerdict = ours.verdict === rec.verdict;
  const sameRule = ours.rule === rec.rule;
  const sameBroken = (ours.brokenStep ?? null) === rec.broken;
  if (sameVerdict && sameRule && sameBroken) {
    verdictMatch++;
    continue;
  }

  // ---- 不一致（或 rule/brokenStep 漂移）：逐例查明 + 明细 ----
  const detail: string[] = [
    `记录：verdict=${rec.verdict} rule=${rec.rule} broken=${rec.broken ?? "—"}`,
    `重算：verdict=${ours.verdict} rule=${ours.rule} brokenStep=${ours.brokenStep ?? "—"}`,
  ];
  for (const st of inputs) {
    const rs = rec.steps.find((x) => x.id === st.id);
    detail.push(
      `  步 ${st.id}(${st.kind}) samples=[${(rs?.samples ?? []).join(",")}] ` +
        `记录mech{checkable=${rs?.mech.checkable},refuted=${rs?.mech.refuted},note=${rs?.mech.note}} ` +
        `重算mech{checkable=${st.mech.checkable},refuted=${st.mech.refuted},reason=${st.mech.reason ?? "—"},note=${st.mech.note}}`,
    );
  }

  let cls: DiffCase["cls"] = "unexpected";
  if (c.id === "L-C164" && ours.verdict === "依据不足" && ours.rule === "INSUFFICIENT-locateMiss" && rec.verdict === "因果存疑") {
    cls = "named";
  } else if (driftSteps.length > 0 && driftSteps.every((d) => d.wb)) {
    cls = "word-boundary";
  }
  diffs.push({ id: c.id, cls, rec: { verdict: rec.verdict, rule: rec.rule, broken: rec.broken }, ours: { verdict: ours.verdict, rule: ours.rule, ...(ours.brokenStep !== undefined ? { brokenStep: ours.brokenStep } : {}) }, detail });

  // 逐例断言一致（词边界 / 具名增量两类为**预期差异形状**，逐例打印并单列，不算断言失败）。
  assert(
    sameVerdict || cls !== "unexpected",
    `${c.id}：verdict 逐例一致（记录 ${rec.verdict} vs 重算 ${ours.verdict}）${cls !== "unexpected" ? `——预期差异形状：${cls}` : ""}`,
  );
}

// ---------- 汇总与统计断言 ----------
const named = diffs.filter((d) => d.cls === "named");
const wb = diffs.filter((d) => d.cls === "word-boundary");
const unexpected = diffs.filter((d) => d.cls === "unexpected");

log("=== diff 明细（逐例，不得静默跳过）===");
for (const d of diffs) {
  log(`--- ${d.id} [${d.cls}]`);
  for (const line of d.detail) log(line);
}
if (named.length > 0) {
  log("【diff 说明段·具名增量 L-C164（规则来源：设计 v0.1 §B4 修正案 + 主代理 2026-09-22 裁决读法 A）】");
  log("严格证伪候选步的 mech 三分之 locate-miss 档：L-C164 的 f3 双样 0.08/0.07 一致证伪（≤REFUTE=0.1），");
  log("但其材料只有一行说明文字（【历史态·DESIGN.md.bak-…】…），无 1076 行 ⇒ mech reason=locate-miss（步定位失败）⇒");
  log("证伪依据不足 ⇒ 记录「因果存疑（DOWNGRADE-noMech）」迁「依据不足（INSUFFICIENT-locateMiss）」。仅此 1 例。");
}
if (wb.length > 0) {
  log("【diff 说明段·词边界增量（mech-rules/v1 / FB-12）】");
  for (const d of wb) log(`${d.id}：存在性形态 probe 为更长标识符前缀（记录 includes 命中=佐证证伪；本仓边界感知不命中=不佐证）`);
}

log("=== 汇总 ===");
log(`重算分布: 假(KILL)=${distOurs["假"] ?? 0} 因果存疑(DOWNGRADE*)=${distOurs["因果存疑"] ?? 0} 依据不足(INSUFFICIENT*)=${distOurs["依据不足"] ?? 0} 未拆倒(UNREFUTED)=${distOurs["未拆倒"] ?? 0}`);
log(`记录分布: 假(KILL)=${distRec["假"] ?? 0} 因果存疑=${distRec["因果存疑"] ?? 0} 依据不足=${distRec["依据不足"] ?? 0} 未拆倒=${distRec["未拆倒"] ?? 0}`);
log(`diff 计数: 合计 ${diffs.length} = 具名增量(L-C164) ${named.length} + 词边界(mech-rules/v1) ${wb.length} + 意外 ${unexpected.length}；verdict/rule/broken 全同 ${verdictMatch}/${cases.length}；mech 漂移步 ${mechDriftSteps}`);

// 期望分布（REPORT-B §1 数字 + 具名增量 L-C164 迁移 1 例；不得按实现回抄）。
assert(distOurs["假"] === 48, `期望分布 KILL 48（实际 ${distOurs["假"] ?? 0}）`);
assert(distOurs["因果存疑"] === 63, `期望分布 因果存疑 63（实际 ${distOurs["因果存疑"] ?? 0}；= 记录 64 − 具名增量 L-C164 迁出 1）`);
assert(distOurs["依据不足"] === 1, `期望分布 依据不足 1（实际 ${distOurs["依据不足"] ?? 0}；= 具名增量 L-C164）`);
assert(distOurs["未拆倒"] === 102, `期望分布 未拆倒 102（实际 ${distOurs["未拆倒"] ?? 0}）`);
assert(distRec["假"] === 48 && distRec["因果存疑"] === 64 && distRec["未拆倒"] === 102, `记录分布 = REPORT-B §1（48/64/0/102）：${JSON.stringify(distRec)}`);

// diff 形状封闭集合：意外 diff 必须为 0（超出预期形状即测试红）；具名增量恰为 L-C164 一例。
assert(unexpected.length === 0, `意外 diff = 0（超出预期形状的 diff 计数 ${unexpected.length}：${unexpected.map((d) => d.id).join(",")}）`);
assert(named.length === 1 && named[0]!.id === "L-C164", `具名增量恰为 L-C164 一例（实际 ${named.map((d) => d.id).join(",") || "无"}）`);

// 四项统计断言（有效集 208 = 214 − 6 坏件；verdict 取主循环回放结果）。
const validIds = cases.map((c) => c.id).filter((id) => !BAD_FIXTURES.has(id));
assert(validIds.length === 208, `有效集 208 = 214 − 6 坏件（实际 ${validIds.length}）`);
const gtOf = (id: string): string => cases.find((c) => c.id === id)!.gt.finding_truth;
const validKills = validIds.filter((id) => verdictById.get(id) === "假");
const killsRight = validKills.filter((id) => gtOf(id) === "假");
assert(validKills.length === 42 && killsRight.length === 42, `有效 KILL 42/42 说对（实际 KILL ${validKills.length}，其中 gt=假 ${killsRight.length}）`);
const traps = cases.filter((c) => (c.bucket ?? []).includes("link-trap")).map((c) => c.id);
const trapsKilled = traps.filter((id) => verdictById.get(id) === "假");
assert(traps.length === 14 && trapsKilled.length === 14, `陷阱 T01–T14 14/14 KILL（实际 ${trapsKilled.length}/${traps.length}）`);
const validTrue = validIds.filter((id) => gtOf(id) === "真");
const trueKilled = validTrue.filter((id) => verdictById.get(id) === "假");
assert(validTrue.length === 150 && trueKilled.length === 0, `真例 0 误杀（150 有效真例；实际 ${validTrue.length} 例中被杀 ${trueKilled.length}）`);
log(
  `统计断言: 有效208=214−6坏件 | KILL ${killsRight.length}/${validKills.length} 说对 | 陷阱 ${trapsKilled.length}/${traps.length} KILL | 真例 ${trueKilled.length}/${validTrue.length} 误杀`,
);

console.log(`\n[golden] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
