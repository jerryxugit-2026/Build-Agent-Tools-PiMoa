/**
 * verdict.test.ts —— B4 verdictOf 真伪三态规则引擎 + B5 premiseRound 分流 + F-W1 baseChain 接线（波3）。
 *
 * 运行：npx tsx test/verdict.test.ts
 *
 * 覆盖：
 *   · 四态顺序（KILL ＞ 严格证伪三分档 ＞ 依据不足 ＞ 弱证伪降级 ＞ 未拆倒）与各档正例；
 *   · 严格证伪 + mech 三分：佐证=KILL / unform=降级 / **locate-miss=依据不足**（主代理 2026-09-22 裁决读法 A：
 *     严格证伪候选步的 mech 三分——证伪了但引文行在材料里定位不到 ⇒ 证伪依据不足）；
 *   · 负例：link 永不 KILL（类型层写死）；mech 拒核不背书；**非证伪步 locate-miss 不改判**（读法 A 裁决同款）；
 *     双样不一致不算证伪；单样本不算严格证伪；
 *   · 缺采样 ⇒ 依据不足；evalTruth 端到端（mechCorroborate + verdictOf 复用链）；
 *   · B5 分流：link 证伪/中带 ⇒ 不再问 Jev、不再补事实、直标 truth=因果存疑（+ 负例：非 link 破绽步照旧补）；
 *   · F-W1（FB-11③ 生产接线）：premiseRound 调用点把 f.chain 传成 baseChain ⇒ amend 补链超 6 步 REJECT
 *     （覆盖层级=调用点集成面；工具本体校验在 test/mech.test.ts FB-11③ 单测）。
 * 脱网、脱 key、不读盘。
 */
import type { FactCheck, FindingCheck, FindingRecord, MaterialFile, MaterialMap } from "../src/moa/types.js";
import {
  evalTruth,
  linkBlockedForPremise,
  premiseRound,
  verdictOf,
  type RunSessionFn,
  type TruthStep,
  type TruthStepInput,
} from "../src/moa/jevcheck.js";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import type { JevcheckCfg } from "../src/config/types.js";
import type { ChainStep } from "../src/tools/submit_findings.js";

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
  console.log("[verdict-test]", ...a);
}

// ---------- 步 fixture（mech 用 mech-rules/v1 的闭集结果形状直接写字面量，不读盘）----------
/** 可核行文核对：相符（不证伪）。 */
const MECH_LINE_OK = { checkable: true, refuted: false, note: "行文核对: 第30行含「total := a + b」=true（token=行内引号，绑定抽取）" } as const;
/** 可核行文核对：不符（佐证证伪）。 */
const MECH_LINE_REFUTE = { checkable: true, refuted: true, note: "行文核对: 第30行含「total := a + b」=false（token=行内引号，绑定抽取）" } as const;
/** 可核存在性核对：作用域内含 token（佐证证伪）。 */
const MECH_EXISTS_REFUTE = { checkable: true, refuted: true, note: "存在性核对: 作用域内含「origin.Kind」=true（token=identifier 最长片段）" } as const;
/** 拒核 unform（形态闭集外）。 */
const MECH_UNFORM = { checkable: false, refuted: false, reason: "unform", note: "不可机械核（非行文/存在性形态）" } as const;
/** 拒核 locate-miss（行缺失——步定位失败）。 */
const MECH_LOCATE_MISS = { checkable: false, refuted: false, reason: "locate-miss", note: "行缺失：第 1076 行不在 material（token=行号断言）" } as const;

function step(id: string, kind: TruthStep["kind"], samples: readonly number[], mech: TruthStep["mech"]): TruthStep {
  return { id, kind, samples, mech, text: `${id} 步文本` } as TruthStep;
}

// ============================================================================
// 一、verdictOf 四态与顺序（KILL ＞ 严格证伪三分档 ＞ 依据不足 ＞ 弱降级 ＞ 未拆倒）
// ============================================================================
{
  log("=== 1. KILL「假」：non-link 双样一致证伪 ∧ mech 佐证 ⇒ 处决 + brokenStep + mechNotes ===");
  const v = verdictOf([step("f1", "fact", [0.02, 0.03], MECH_LINE_REFUTE)]);
  assert(v.verdict === "假" && v.rule === "KILL" && v.brokenStep === "f1", `KILL 判决：${JSON.stringify(v)}`);
  assert(v.mechNotes.length === 1 && v.mechNotes[0]!.startsWith("f1｜行文核对"), `mechNotes 带步 id 归因：${JSON.stringify(v.mechNotes)}`);
}

{
  log("=== 2. 顺序：KILL 优先于严格降级与弱降级（多触发并存取最高档）===");
  const v = verdictOf([
    step("c2", "link", [0.05, 0.06], MECH_EXISTS_REFUTE), // link 严格证伪：只会降级
    step("f2", "absence", [0.15, 0.2], MECH_LINE_OK), // 弱证伪（mean 0.175 ≤ 0.2）
    step("f1", "fact", [0.01, 0.02], MECH_LINE_REFUTE), // KILL 触发
  ]);
  assert(v.verdict === "假" && v.rule === "KILL" && v.brokenStep === "f1", `KILL 压过降级/弱档：${JSON.stringify(v)}`);
}

{
  log("=== 3. link 证伪不杀（负例：link 永不进 KILL 候选，类型层写死）===");
  const only = verdictOf([step("c1", "link", [0.02, 0.03], MECH_LINE_REFUTE)]);
  assert(only.verdict !== "假" && only.verdict === "因果存疑" && only.rule === "DOWNGRADE" && only.brokenStep === "c1", `单独 link 严格证伪+佐证 ⇒ 只降级：${JSON.stringify(only)}`);
  const mixed = verdictOf([
    step("c1", "link", [0.01, 0.01], MECH_LINE_REFUTE),
    step("f1", "fact", [0.5, 0.5], MECH_LINE_OK),
  ]);
  assert(mixed.verdict !== "假" && mixed.brokenStep === "c1", `link 证伪 + non-link 无破绽 ⇒ 仍不杀：${JSON.stringify(mixed)}`);
  // 双严格证伪并存（link 佐证 + non-link unform）：一律不杀；定档步 = **首个**严格证伪步
  // （语义真源 judge-finding.mjs:87 `steps.find(s => strict(s))`，与步序有关——两种步序各断一次）。
  const linkFirst = verdictOf([
    step("c1", "link", [0.01, 0.01], MECH_EXISTS_REFUTE), // link 严格证伪 + mech 佐证：永不 KILL
    step("f1", "fact", [0.02, 0.02], MECH_UNFORM), // non-link 严格证伪但 mech 拒核（unform）
  ]);
  assert(linkFirst.verdict !== "假" && linkFirst.verdict === "因果存疑" && linkFirst.rule === "DOWNGRADE" && linkFirst.brokenStep === "c1", `link 先行 ⇒ link 步定档降级、不处决：${JSON.stringify(linkFirst)}`);
  const factFirst = verdictOf([
    step("f1", "fact", [0.02, 0.02], MECH_UNFORM),
    step("c1", "link", [0.01, 0.01], MECH_EXISTS_REFUTE),
  ]);
  assert(factFirst.verdict !== "假" && factFirst.verdict === "因果存疑" && factFirst.rule === "DOWNGRADE-noMech" && factFirst.brokenStep === "f1", `non-link 先行 ⇒ unform 拒核降级、不处决：${JSON.stringify(factFirst)}`);
}

{
  log("=== 4. 严格证伪 + 无佐证（mech reason=unform）⇒ 因果存疑（DOWNGRADE-noMech）===");
  const v = verdictOf([step("f1", "fact", [0.02, 0.03], MECH_UNFORM)]);
  assert(v.verdict === "因果存疑" && v.rule === "DOWNGRADE-noMech" && v.brokenStep === "f1", `证伪但 unform 拒核 ⇒ 降级：${JSON.stringify(v)}`);
}

{
  log("=== 5. 严格证伪 + locate-miss ⇒ 依据不足（读法 A 三分之三；金标准具名增量 L-C164 同形）===");
  const v = verdictOf([step("f3", "fact", [0.08, 0.07], MECH_LOCATE_MISS)]);
  assert(v.verdict === "依据不足" && v.rule === "INSUFFICIENT-locateMiss" && v.brokenStep === "f3", `严格证伪但步定位失败 ⇒ 依据不足：${JSON.stringify(v)}`);
  const ordered = verdictOf([
    step("f3", "fact", [0.08, 0.07], MECH_LOCATE_MISS), // 依据不足（严格证伪档内）
    step("f9", "general", [0.15, 0.2], MECH_LINE_OK), // 弱证伪
  ]);
  assert(ordered.verdict === "依据不足", `locate-miss 档排在弱证伪之前：${JSON.stringify(ordered)}`);
}

{
  log("=== 6. 负例：非证伪步的 locate-miss 不改判（2026-09-22 裁决：可核性失败 ≠ 证伪成立）===");
  const unrefuted = verdictOf([
    step("f1", "fact", [0.5, 0.5], MECH_LOCATE_MISS),
    step("c1", "link", [0.9, 0.9], MECH_UNFORM),
  ]);
  assert(unrefuted.verdict === "未拆倒" && unrefuted.rule === "UNREFUTED", `非证伪 locate-miss + 全高置信 ⇒ 未拆倒（不误升依据不足）：${JSON.stringify(unrefuted)}`);
  const weakHijack = verdictOf([
    step("f1", "fact", [0.5, 0.5], MECH_LOCATE_MISS), // 非证伪步 locate-miss：不改判
    step("f2", "code", [0.15, 0.2], MECH_LINE_OK), // 弱证伪定档
  ]);
  assert(weakHijack.verdict === "因果存疑" && weakHijack.rule === "DOWNGRADE-weak" && weakHijack.brokenStep === "f2", `locate-miss 不截胡弱降级：${JSON.stringify(weakHijack)}`);
}

{
  log("=== 7. 弱证伪/中带（mean ≤ 0.2 未达严格证伪）⇒ 因果存疑（DOWNGRADE-weak）；严格档压过弱档 ===");
  const weak = verdictOf([step("f1", "fact", [0.15, 0.25], MECH_LINE_OK)]);
  assert(weak.verdict === "因果存疑" && weak.rule === "DOWNGRADE-weak" && weak.brokenStep === "f1", `弱证伪降级：${JSON.stringify(weak)}`);
  const both = verdictOf([
    step("f2", "fact", [0.1, 0.2], MECH_LINE_OK), // 弱
    step("f1", "fact", [0.05, 0.05], MECH_UNFORM), // 严格（首严格步）
  ]);
  assert(both.rule === "DOWNGRADE-noMech" && both.brokenStep === "f1", `严格证伪档排在弱证伪之前：${JSON.stringify(both)}`);
}

{
  log("=== 8. 负例：双样不一致不算证伪；单样本不算严格证伪 ===");
  const split = verdictOf([step("f1", "fact", [0.05, 0.5], MECH_LINE_REFUTE)]);
  assert(split.verdict !== "假" && split.rule === "UNREFUTED", `[0.05,0.5] 样本不一致 ⇒ 不证伪不处决（mean 0.275）：${JSON.stringify(split)}`);
  const single = verdictOf([step("f1", "fact", [0.05], MECH_LINE_REFUTE)]);
  assert(single.verdict !== "假" && single.rule === "DOWNGRADE-weak", `单样本 [0.05] 不算严格证伪 ⇒ 只弱降级：${JSON.stringify(single)}`);
  const exactBoundary = verdictOf([step("f1", "fact", [0.1, 0.1], MECH_LINE_REFUTE)]);
  assert(exactBoundary.verdict === "假" && exactBoundary.rule === "KILL", `REFUTE=0.1 边界含本值：双样 [0.1,0.1] ⇒ KILL：${JSON.stringify(exactBoundary)}`);
}

{
  log("=== 9. 缺采样 ⇒ 依据不足（judge v2 原样）；排在弱证伪之前 ===");
  const none = verdictOf([step("f1", "fact", [], MECH_LINE_OK)]);
  assert(none.verdict === "依据不足" && none.rule === "INSUFFICIENT" && none.brokenStep === undefined, `缺采样：${JSON.stringify(none)}`);
  const beforeWeak = verdictOf([step("f1", "fact", [], MECH_LINE_OK), step("f2", "fact", [0.1, 0.2], MECH_LINE_OK)]);
  assert(beforeWeak.verdict === "依据不足" && beforeWeak.rule === "INSUFFICIENT", `缺采样档排在弱证伪之前：${JSON.stringify(beforeWeak)}`);
}

{
  log("=== 10. 负例：mech 拒核不背书（永不用于证实方向）；mech 佐证单独出现（无严格证伪）不处决 ===");
  const highUnform = verdictOf([step("f1", "fact", [0.9, 0.9], MECH_UNFORM)]);
  assert(highUnform.verdict === "未拆倒" && highUnform.rule === "UNREFUTED", `高置信 + 拒核 ⇒ 未拆倒（≠证实、无背书产出）：${JSON.stringify(highUnform)}`);
  const mechOnly = verdictOf([step("f1", "absence", [0.5, 0.5], MECH_EXISTS_REFUTE)]);
  assert(mechOnly.verdict === "未拆倒" && mechOnly.rule === "UNREFUTED", `mech 佐证证伪但样本不证伪 ⇒ 不处决（双门缺一不可）：${JSON.stringify(mechOnly)}`);
}

{
  log("=== 11. evalTruth 端到端：mechCorroborate（./mech.js 波2）+ verdictOf 复用链 ===");
  const inputs: TruthStepInput[] = [
    { id: "f1", kind: "fact", text: "第 30 行是「total := a + b」的赋值语句", samples: [0.02, 0.03] },
  ];
  const refute = evalTruth(inputs, "30: total := a");
  assert(refute.verdict === "假" && refute.rule === "KILL" && refute.brokenStep === "f1", `行文不符 + 双样一致证伪 ⇒ KILL：${JSON.stringify(refute)}`);
  assert(refute.mechNotes[0]!.includes("行文核对"), `mechNotes 来自 mechCorroborate 现算：${JSON.stringify(refute.mechNotes)}`);
  const locateMiss = evalTruth([{ id: "f3", kind: "fact", text: "第 1076 行是「var profileTableRegistry = []ProfileTableSpec{」", samples: [0.08, 0.07] }], "1: 无编号材料行");
  assert(locateMiss.verdict === "依据不足" && locateMiss.rule === "INSUFFICIENT-locateMiss", `行缺失（locate-miss）+ 严格证伪 ⇒ 依据不足：${JSON.stringify(locateMiss)}`);
}

// ============================================================================
// 二、B5 premiseRound 分流（link 证伪或中带 ⇒ 不再问 Jev、不再补事实、直标 truth=因果存疑）
// ============================================================================
function seg(abs: string, rel: string, start: number, lines: string[]): MaterialFile {
  return { abs, rel, kind: "range", lines, start, end: start + lines.length - 1 };
}
const ABS_GO = "/repo/internal/x/ratchet.go";
const materials: MaterialMap = new Map([[ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", 1, ["func Check() {", "\treturn nil", "}"])]]]);
const docs: MaterialFile[] = [];

function mkFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "F1",
    kind: "finding",
    level: "MAJOR",
    path: "internal/x/ratchet.go",
    lines: "1-3",
    anchor: "Check",
    facts: ["ratchet.go 第 2 行 return nil 直接放行"],
    claim: "Check 为空实现，缺少来源校验的调用会被当作合法",
    fix_expect: "Check 应校验来源",
    strength: "亲验",
    pid: "P1/F1",
    proposerIndex: 0,
    proposerModel: "deepseek/deepseek-v4-flash",
    ...over,
  } as FindingRecord;
}

function mkFc(over: Partial<FindingCheck> = {}): FindingCheck {
  const facts: FactCheck[] = [{ text: "ratchet.go 第 2 行 return nil 直接放行", kind: "code", p: 0.1, status: "不符" }];
  return { pid: "P1/F1", ref: "OK", facts, entail: { p1: 0.1 }, status: "前提不足", conditionFlag: false, calls: [], ...over };
}

const cfg: JevcheckCfg = { ...JEVCHECK_DEFAULTS, enabled: true, premiseRound: { enabled: true, maxFindings: 10, concurrency: 2, perCallMs: 30_000 } };
const workers = [{ provider: "x", model: "y", profile: "verify-worker" }];

/** 记录式 mock client：任何 ask/noul 都计数（B5 分流要「不再问 Jev」= 计数保持 0）。 */
function trackingClient(): { calls: number; client: { ask: () => Promise<{ results: Record<string, { p: number | null }>; calls: [] }>; noul: () => Promise<{ p: number | null; calls: [] }> } } {
  const t = {
    calls: 0,
    client: {
      ask: async () => {
        t.calls++;
        return { results: {}, calls: [] as [] };
      },
      noul: async () => {
        t.calls++;
        return { p: null, calls: [] as [] };
      },
    },
  };
  return t;
}

const chainWithLink: ChainStep[] = [
  { id: "c1", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" },
  { id: "c2", kind: "link", text: "Kind 为空因此绕过来源校验进入系统", from: "c1", to: "c3" },
  { id: "c3", kind: "runtime", text: "运行时条件：origin.Command 取自无关进程的命令行" },
];

{
  log("=== 12. linkBlockedForPremise 判据（truth 破绽步 = chain link 步 ⇒ 分流）===");
  const f = mkFinding({ chain: chainWithLink });
  const blocked = mkFc({ truth: { verdict: "因果存疑", rule: "DOWNGRADE-weak", brokenStep: "c2", mechNotes: ["c2｜弱证伪"] } });
  assert(linkBlockedForPremise(f, blocked) === true, "因果存疑 + 破绽步=link ⇒ 分流");
  const factBroken = mkFc({ truth: { verdict: "因果存疑", rule: "DOWNGRADE-weak", brokenStep: "c1", mechNotes: [] } });
  assert(linkBlockedForPremise(f, factBroken) === false, "破绽步=absence 步 ⇒ 不分流（只拦 link 证伪/中带）");
  const killed = mkFc({ truth: { verdict: "假", rule: "KILL", brokenStep: "c2", mechNotes: [] } });
  assert(linkBlockedForPremise(f, killed) === false, "verdict=假 不属本分流（KILL 另走 B6 协议）");
  assert(linkBlockedForPremise(f, mkFc()) === false, "truth 缺省（未接线/存量路径）⇒ 不分流，现行为不动");
  assert(linkBlockedForPremise(f, undefined) === false, "FindingCheck 缺失 ⇒ 不分流");
}

{
  log("=== 13. B5 集成：link 中带 ⇒ 不起 amend 短会话、不问 Jev、直标 truth=因果存疑 ===");
  const f = mkFinding({ chain: chainWithLink });
  const fc = mkFc({ truth: { verdict: "因果存疑", rule: "DOWNGRADE-weak", brokenStep: "c2", mechNotes: ["c2｜存在性核对: …"] } });
  let sessions = 0;
  const runSessionFn: RunSessionFn = async () => {
    sessions++;
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const t = trackingClient();
  const results = await premiseRound({
    findings: [f],
    perFinding: { [f.pid]: fc },
    materials,
    docs,
    cfg,
    workers,
    runSessionFn,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: t.client as never,
  });
  const r = results.get(f.pid);
  assert(sessions === 0, `amend 短会话未起（不补事实）：sessions=${sessions}`);
  assert(t.calls === 0, `Jev 零调用（不再问 Jev）：calls=${t.calls}`);
  assert(r !== undefined && r.added.length === 0 && (r.reason ?? "").includes("B5 分流"), `结果记 B5 分流原因：${JSON.stringify(r)}`);
  assert(fc.truth?.verdict === "因果存疑" && fc.truth.rule === "B5-link" && fc.truth.brokenStep === "c2", `直标 truth=因果存疑（B5-link 留痕、破绽步保留）：${JSON.stringify(fc.truth)}`);
}

{
  log("=== 14. B5 负例：truth 缺省 ⇒ 现行为不动（照旧起短会话补事实）===");
  const f = mkFinding({ chain: chainWithLink });
  const fc = mkFc(); // 无 truth：存量/未接线路径
  let sessions = 0;
  const runSessionFn: RunSessionFn = async (_mr, _w, _p, opts) => {
    sessions++;
    const tool = opts.extraTools?.[0];
    if (tool) {
      await (tool as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", { id: "F1", facts: ["通用事实：空值必须显式拒绝"] });
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true, structured: { accepted: true, count: 1, attempts: 1 } };
  };
  const t = trackingClient();
  const results = await premiseRound({
    findings: [f],
    perFinding: { [f.pid]: fc },
    materials,
    docs,
    cfg,
    workers,
    runSessionFn,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: t.client as never,
  });
  assert(sessions === 1, `现行为不动：短会话照起：sessions=${sessions}`);
  const r = results.get(f.pid);
  assert(r !== undefined && r.added.length === 1, `补充事实照常核对：${JSON.stringify(r?.added)}`);
}

// ============================================================================
// 三、F-W1（FB-11③ 生产接线）：premiseRound 调用点传 baseChain ⇒ amend 补链累计超 6 REJECT
// ============================================================================
{
  log("=== 15. F-W1 调用点集成：baseChain 透传（5 步既有链 + 2 步增补 = 7 > 6 ⇒ REJECT）===");
  const baseChain: ChainStep[] = Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    kind: "runtime" as const,
    text: `运行时条件：第 ${i + 1} 条环境前提描述`,
  }));
  const f = mkFinding({ chain: baseChain });
  const fc = mkFc();
  let amendText = "";
  const runSessionFn: RunSessionFn = async (_mr, _w, _p, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      const res = (await (tool as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", {
        id: "F1",
        facts: [],
        cannot_amend_reason: "探针",
        chain: [
          { id: "c9", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
          { id: "c10", kind: "runtime", text: "运行时条件：环境变量可被攻击者替换" },
        ],
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      amendText = res.content.map((c) => c.text).join("\n");
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const t = trackingClient();
  const results = await premiseRound({
    findings: [f],
    perFinding: { [f.pid]: fc },
    materials,
    docs,
    cfg,
    workers,
    runSessionFn,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: t.client as never,
  });
  assert(amendText.includes("补链后全链累计 7 步") && amendText.includes("超过全链上限 6 步"), `baseChain 透传 ⇒ 超限 REJECT（若 F-W1 未接线此处会接受）：${amendText}`);
  const r = results.get(f.pid);
  assert(r !== undefined && r.added.length === 0, `REJECT 后按未补充处理：${JSON.stringify(r?.added)}`);

  // 对照腿：无 chain 的存量路径不核累计（同一增补形状应当被接受）。
  const f2 = mkFinding({ id: "F2", pid: "P1/F2" });
  const fc2 = mkFc({ pid: "P1/F2" });
  let amendText2 = "";
  const runSessionFn2: RunSessionFn = async (_mr, _w, _p, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      const res = (await (tool as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", {
        id: "F2",
        facts: ["通用事实：空值必须显式拒绝"],
        chain: [{ id: "c9", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" }],
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      amendText2 = res.content.map((c) => c.text).join("\n");
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const results2 = await premiseRound({
    findings: [f2],
    perFinding: { [f2.pid]: fc2 },
    materials,
    docs,
    cfg,
    workers,
    runSessionFn: runSessionFn2,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: t.client as never,
  });
  assert(amendText2.startsWith("已为 F2 补充 1 条前提"), `对照腿：无 baseChain 不核累计、照旧接受：${amendText2}`);
  const r2 = results2.get(f2.pid);
  assert(r2 !== undefined && r2.added.length === 1, `对照腿补充事实照常核对：${JSON.stringify(r2?.added)}`);
}

console.log(`\n[verdict-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
