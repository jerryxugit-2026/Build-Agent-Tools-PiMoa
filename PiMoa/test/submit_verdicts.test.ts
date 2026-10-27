/**
 * submit_verdicts 结构化提交工具单测（Jev 辅助代码审查详细设计 v4 §3.6，第三波 a 验收）。
 *
 * 运行：npx tsx test/submit_verdicts.test.ts
 * 覆盖：§3.6 表每条规则各一用例——合格（知 id 齐全覆盖 / 冲突对含 adopted / 异常给 table_handling /
 *       条件红旗给 conditions / evidence 路径可解析）、漏 id、重复 id、未知 id、P{i}/U{n} 合法与非法、
 *       冲突对未被同一条裁决覆盖、冲突对缺 adopted、有异常缺 table_handling、无异常省略 table_handling 通过、
 *       条件红旗缺 conditions、conditions 条数不符、evidence 路径解析不到、3 次上限、缺省补齐（escalate）。
 *       ★PIMOA-DEF-05 复审（2026-09-20）三条：conditions 上限与 facts/补前提上限的机械锁定（用例 14）、
 *       need=12 时可被 schema 与校验同时满足（用例 15）、entailP2 缺失时 conditionFlag 仍与计数同源重算（用例 16）。
 * 脱网、脱 key、不读盘（用例 16 用 mock Jev 客户端 + mock runSessionFn 驱动真实 runJevCheck，不出网）。
 */
import { Value } from "typebox/value";
import {
  CONDITIONS_MAX_ITEMS,
  SubmitVerdictsParams,
  type FactCheck,
  type FindingCheck,
  type JevCheckReport,
  type MaterialFile,
  type MaterialMap,
  type VerdictsState,
} from "../src/moa/types.js";
import { AmendFactsParams, FINDING_LIMITS } from "../src/tools/submit_findings.js";
import {
  runJevCheck,
  type FindingRecord,
  type JevClientLike,
  type RunSessionFn,
} from "../src/moa/jevcheck.js";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import type { JevcheckCfg } from "../src/config/types.js";
import {
  computeEvidenceRef,
  conditionFactCount,
  createSubmitVerdictsTool,
  isAnomalous,
  parseEvidence,
  validateVerdicts,
  type SubmitVerdictsInput,
} from "../src/tools/submit_verdicts.js";
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
  console.log("[submit-verdicts-test]", ...a);
}

// ---------- 材料 fixture（不读盘）----------
const CWD = "/repo";
const ABS_GO = "/repo/internal/x/ratchet.go";
function seg(abs: string, rel: string, start: number, lines: string[]): MaterialFile {
  return { abs, rel, kind: "range", lines, start, end: start + lines.length - 1 };
}
const GO_LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
function makeMaterials(): MaterialMap {
  const m: MaterialMap = new Map();
  m.set(ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", 1, GO_LINES)]);
  return m;
}
const materials = makeMaterials();
const readRoots: string[] = [];

// ---------- 核对表 fixture ----------
function fc(over: Partial<FindingCheck> & { pid: string }): FindingCheck {
  return {
    ref: "OK",
    facts: [],
    entail: { p1: 0.9 },
    status: "前提完备且全部相符",
    conditionFlag: false,
    calls: [],
    ...over,
  };
}

/** 基线核对表：
 * P1/F1（正常）与 P2/G1（正常）结论相反配对；P1/F2（含不符前提 + 锚点未命中，异常，单边）；
 * P2/G2（条件性成立，conditionFlag=true，2 条运行时条件）。 */
function makeReport(): JevCheckReport {
  return {
    enabled: true,
    perFinding: {
      "P1/F1": fc({ pid: "P1/F1" }),
      "P2/G1": fc({ pid: "P2/G1" }),
      "P1/F2": fc({ pid: "P1/F2", ref: "锚点未命中", status: "含不符前提" }),
      "P2/G2": fc({
        pid: "P2/G2",
        status: "条件性成立",
        conditionFlag: true,
        facts: [
          { text: "运行时条件：C1", kind: "condition", p: null, status: "条件" },
          { text: "运行时条件：C2", kind: "condition", p: null, status: "条件" },
        ],
      }),
    },
    duplicates: [],
    conflicts: [{ a: "P1/F1", b: "P2/G1", pSame: 0.1, pOpposite: 0.85, viaCounter: false }],
    oneSided: [{ id: "P1/F2", proposerIndex: 1 }],
    proposerQuality: {},
    totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
    tableText: "",
  };
}

const knownIds = ["P1/F1", "P1/F2", "P2/G1", "P2/G2"];
const unstructured = [3];

/** 一份全合格的裁决提交（基线）。 */
function baseParams(over: Partial<SubmitVerdictsInput> = {}): SubmitVerdictsInput {
  return {
    verdicts: [
      {
        finding_ids: ["P1/F1", "P2/G1"],
        level: "MAJOR",
        can_happen: "能",
        consequence: "数据错误",
        trigger: "常态触发",
        strength: "亲验",
        reason: "两方对同一处结论相反，采信 P1 的行号引用与事实核对结果",
        evidence: "internal/x/ratchet.go:5",
        adopted: "P1",
      },
      {
        finding_ids: ["P1/F2"],
        level: "MINOR",
        can_happen: "材料不足",
        consequence: "无实际后果",
        trigger: "仅理论",
        strength: "推理",
        reason: "核对表标原文不符，材料不足以核实该行为",
        evidence: "internal/x/ratchet.go:8",
        table_handling: "材料不足",
      },
      {
        finding_ids: ["P2/G2"],
        level: "MAJOR",
        can_happen: "能",
        consequence: "静默失败",
        trigger: "特定输入或环境",
        strength: "亲验",
        reason: "两条运行时条件均已回应，条件成立时确会静默吞错",
        evidence: "internal/x/ratchet.go:12",
        conditions: [
          { c: "C1", verdict: "可发生" },
          { c: "C2", verdict: "被排除", line: "L64" },
        ],
      },
      {
        finding_ids: ["P3/U1"],
        level: "MINOR",
        can_happen: "能",
        consequence: "可观测性",
        trigger: "仅理论",
        strength: "推理",
        reason: "未结构化提议 3 在正文里提到的一处观测缺口，予以采纳",
        evidence: "internal/x/ratchet.go:15",
      },
    ],
    final: "综合四条裁决：一处冲突采信 P1、一处异常按材料不足处理、一处条件性成立须修、一处采纳未结构化发现。",
    ...over,
  };
}

function validate(params: SubmitVerdictsInput, report: JevCheckReport | null = makeReport()): string[] {
  return validateVerdicts(params, knownIds, unstructured, report, materials, CWD, readRoots);
}

// ---------- 用例 1：parseEvidence / isAnomalous / conditionFactCount ----------
{
  log("=== 用例 1：纯函数 parseEvidence / isAnomalous / conditionFactCount ===");
  const e1 = parseEvidence("internal/x/ratchet.go:12");
  assert(e1?.path === "internal/x/ratchet.go" && e1.a === 12 && e1.b === 12, `单行 evidence：${JSON.stringify(e1)}`);
  const e2 = parseEvidence("internal/x/ratchet.go:12-20");
  assert(e2?.a === 12 && e2.b === 20, `区间 evidence：${JSON.stringify(e2)}`);
  const e3 = parseEvidence("不含冒号数字");
  assert(e3 === null, "格式不符返回 null");

  assert(isAnomalous(undefined) === false, "report 缺失该 id → 视为无异常");
  assert(isAnomalous(fc({ pid: "x" })) === false, "ref=OK 且 status=前提完备且全部相符 → 无异常");
  assert(isAnomalous(fc({ pid: "x", status: "含不符前提" })) === true, "status=含不符前提 → 有异常");
  assert(isAnomalous(fc({ pid: "x", ref: "行号越界" })) === true, "ref≠OK → 有异常");

  const check = fc({
    pid: "x",
    facts: [
      { text: "a", kind: "code", p: 1, status: "相符" },
      { text: "运行时条件：b", kind: "condition", p: null, status: "条件" },
      { text: "运行时条件：c", kind: "condition", p: null, status: "条件" },
    ],
  });
  assert(conditionFactCount(check) === 2, `运行时条件计数 = kind===condition 的条数：${conditionFactCount(check)}`);
  assert(conditionFactCount(undefined) === 0, "check 缺失 → 0");
}

// ---------- 用例 2：validateVerdicts 合格基线 ----------
{
  log("=== 用例 2：合格基线（含无异常省略 table_handling 通过）===");
  const errs = validate(baseParams());
  assert(errs.length === 0, `基线全部合格，零错误：${JSON.stringify(errs)}`);
  // 基线第一条 verdict 覆盖 P1/F1（正常）与 P2/G1（正常），未写 table_handling —— 验证「无异常省略通过」。
}

// ---------- 用例 3：§3.6 每条规则单独触发 ----------
{
  log("=== 用例 3：§3.6 规则逐条 ===");

  // 漏 id：删掉覆盖 P2/G2 的那条 verdict。
  const missing = validate(baseParams({ verdicts: baseParams().verdicts.filter((v) => !v.finding_ids.includes("P2/G2")) }));
  assert(missing.some((e) => e.includes("未被任何裁决覆盖：P2/G2")), `漏 id：${JSON.stringify(missing)}`);

  // 重复 id：额外加一条也覆盖 P1/F1 的 verdict。
  const dupParams = baseParams();
  dupParams.verdicts.push({ ...dupParams.verdicts[0]!, finding_ids: ["P1/F1"] });
  const dup = validate(dupParams);
  assert(dup.some((e) => e.includes("重复覆盖") && e.includes("P1/F1")), `重复 id：${JSON.stringify(dup)}`);

  // 未知 id：既不在 knownIds，也不匹配 P{i}/U{n}。
  const unknownParams = baseParams();
  unknownParams.verdicts[3]!.finding_ids = ["P9/F9"];
  const unknown = validate(unknownParams);
  assert(unknown.some((e) => e.includes("引用了未知 finding_id「P9/F9」")), `未知 id：${JSON.stringify(unknown)}`);

  // P{i}/U{n} 合法：基线第四条本身就是 P3/U1（unstructured=[3]），已在用例 2 验证合格。
  assert(baseParams().verdicts[3]!.finding_ids[0] === "P3/U1", "基线含合法 P{i}/U{n} 引用");

  // P{i}/U{n} 非法：i 不在 unstructured 里。
  const illegalU = baseParams();
  illegalU.verdicts[3]!.finding_ids = ["P4/U1"];
  const illegal = validate(illegalU);
  assert(illegal.some((e) => e.includes("引用的提议 4 并非未结构化")), `P{i}/U{n} 非法：${JSON.stringify(illegal)}`);

  // 冲突对未被同一条裁决覆盖：拆成两条各覆盖一方。
  const splitConflict = baseParams();
  splitConflict.verdicts[0] = { ...splitConflict.verdicts[0]!, finding_ids: ["P1/F1"] };
  splitConflict.verdicts.push({
    finding_ids: ["P2/G1"],
    level: "MAJOR",
    can_happen: "不能",
    consequence: "无实际后果",
    trigger: "仅理论",
    strength: "推理",
    reason: "另一方的说法核不出来",
    evidence: "internal/x/ratchet.go:6",
  });
  const notCovered = validate(splitConflict);
  assert(notCovered.some((e) => e.includes("冲突对 P1/F1/P2/G1（结论相反）未被同一条裁决覆盖")), `冲突对未覆盖：${JSON.stringify(notCovered)}`);

  // 冲突对同条覆盖但缺 adopted。
  const noAdopted = baseParams();
  delete noAdopted.verdicts[0]!.adopted;
  const missingAdopted = validate(noAdopted);
  assert(missingAdopted.some((e) => e.includes("冲突对 P1/F1/P2/G1 所在裁决缺 adopted")), `冲突对缺 adopted：${JSON.stringify(missingAdopted)}`);

  // 有异常缺 table_handling。
  const noHandling = baseParams();
  delete noHandling.verdicts[1]!.table_handling;
  const missingHandling = validate(noHandling);
  assert(missingHandling.some((e) => e.includes("须填 table_handling") && e.includes("P1/F2")), `有异常缺 table_handling：${JSON.stringify(missingHandling)}`);

  // 条件红旗缺 conditions。
  const noConditions = baseParams();
  delete noConditions.verdicts[2]!.conditions;
  const missingConditions = validate(noConditions);
  assert(missingConditions.some((e) => e.includes("P2/G2 为条件红旗，须给 conditions")), `条件红旗缺 conditions：${JSON.stringify(missingConditions)}`);

  // conditions 条数不符（该 finding 运行时条件数为 2，只给 1 条）。
  const wrongCount = baseParams();
  wrongCount.verdicts[2]!.conditions = [{ c: "C1", verdict: "可发生" }];
  const countMismatch = validate(wrongCount);
  assert(
    countMismatch.some((e) => e.includes("条数须等于运行时条件数 2，实给 1")),
    `conditions 条数不符：${JSON.stringify(countMismatch)}`,
  );

  // evidence 路径解析不到本轮材料。
  const badEvidence = baseParams();
  badEvidence.verdicts[3]!.evidence = "not/in/materials.go:1";
  const evErrs = validate(badEvidence);
  assert(evErrs.some((e) => e.includes("evidence「not/in/materials.go:1」的路径解析不到")), `evidence 路径不可解析：${JSON.stringify(evErrs)}`);

  // report=null（jevcheck 未跑）：跳过核对表相关三条规则，仅剩覆盖 / 未知 id / evidence 路径规则。
  const noReport = validate(baseParams(), null);
  assert(noReport.length === 0, `report=null 时基线仍合格（无核对表相关要求）：${JSON.stringify(noReport)}`);
}

// ---------- 用例 4：submit_verdicts 工具处理器（接受 / REJECT / 3 次上限 / 缺省补齐）----------
async function run(tool: ReturnType<typeof createSubmitVerdictsTool>, params: unknown): Promise<{ text: string; isError: boolean }> {
  const r = (await tool.execute("call-1", params as never, undefined, undefined, { cwd: CWD } as never)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: r.content[0]?.text ?? "", isError: r.isError === true };
}
function freshState(): VerdictsState {
  return { accepted: null, attempts: 0, rejects: [] };
}
{
  log("=== 用例 4：submit_verdicts 处理器 ===");
  const report = makeReport();
  const state = freshState();
  const tool = createSubmitVerdictsTool(state, knownIds, unstructured, report, materials, CWD, readRoots, { maxAttempts: 3 });
  assert(tool.name === "submit_verdicts", "工具名 submit_verdicts");

  // 不合格 → REJECT 第 1/3 次。
  const bad = baseParams();
  delete bad.verdicts[1]!.table_handling;
  const r1 = await run(tool, bad);
  assert(r1.isError && r1.text.startsWith("REJECT（第 1/3 次）"), `第 1 次不合格 → REJECT：${r1.text.split("\n")[0]}`);
  assert(state.attempts === 1 && state.accepted === null, "attempts=1、未接受");

  // 合格 → 接受，escalate 缺省补 false。
  const good = baseParams();
  const r2 = await run(tool, good);
  assert(!r2.isError && r2.text.startsWith("已接受 4 条裁决："), `第 2 次合格 → 接受：${r2.text}`);
  assert(state.attempts === 2 && state.accepted !== null, "attempts=2、已接受");
  assert(
    state.accepted!.verdicts.every((v) => v.escalate === false),
    "escalate 缺省补齐为 false（原始入参未写该字段）",
  );

  // 硬门文案。
  const hardState = freshState();
  const hardTool = createSubmitVerdictsTool(hardState, knownIds, unstructured, report, materials, CWD, readRoots, {
    maxAttempts: 1,
    required: true,
  });
  const badHard = baseParams();
  delete badHard.verdicts[1]!.table_handling;
  const rh = await run(hardTool, badHard);
  assert(rh.text.endsWith("已达上限，本次裁决将按聚合失败处理"), `硬门达上限文案：${rh.text.split("\n").pop()}`);

  // 软门文案。
  const softState = freshState();
  const softTool = createSubmitVerdictsTool(softState, knownIds, unstructured, report, materials, CWD, readRoots, { maxAttempts: 1 });
  const rs = await run(softTool, badHard);
  assert(rs.text.endsWith("已达上限，本次裁决将按自由文本处理"), `软门达上限文案：${rs.text.split("\n").pop()}`);

  // 3 次上限：连续 3 次不合格后第 4 次直接拒。
  const limState = freshState();
  const limTool = createSubmitVerdictsTool(limState, knownIds, unstructured, report, materials, CWD, readRoots, { maxAttempts: 3 });
  for (let i = 0; i < 3; i++) {
    const p = baseParams();
    delete p.verdicts[1]!.table_handling;
    await run(limTool, p);
  }
  assert(limState.attempts === 3 && limState.rejects.length === 3, "连续 3 次不合格：attempts=3、rejects=3");
  const over = await run(limTool, baseParams());
  assert(over.isError && over.text.includes("第 4/3 次") && over.text.includes("已超过提交次数上限"), `第 4 次直接拒：${over.text.split("\n")[0]}`);
  assert(limState.attempts === 4, "attempts=4（含超限那次）");
}

// ---------- 用例 5：PiMoa 波三 a 审查补的边界（混合 id、perFinding 缺键、REJECT 截断、超限不覆盖已接受）----------
{
  log("=== 用例 5：混合 finding_ids / perFinding 缺键 / REJECT 截断 / 超限不覆盖 ===");
  // 一条 verdict 同时含 knownId 与 P{i}/U{n}：未结构化引用不进 knownId 覆盖统计，仍零错误
  const mixed = baseParams();
  mixed.verdicts[0]!.finding_ids = ["P1/F1", "P2/G1", "P3/U1"];
  mixed.verdicts.splice(3, 1);
  assert(validate(mixed).length === 0, `混合 knownId 与 P3/U1 的 verdict 零错误：${validate(mixed).join(" ｜ ")}`);

  // knownId 存在但 report.perFinding 无该键：不要求 table_handling
  const rep = makeReport();
  delete rep.perFinding["P1/F2"];
  const noKey = baseParams();
  delete noKey.verdicts[1]!.table_handling;
  assert(validate(noKey, rep).length === 0, `perFinding 缺键时不要求 table_handling：${validate(noKey, rep).join(" ｜ ")}`);

  // REJECT 最多列 15 条并注明其余条数
  const many = baseParams();
  for (let i = 0; i < 20; i++) {
    many.verdicts.push({
      finding_ids: [`P3/U${i + 2}`],
      level: "MINOR",
      can_happen: "能",
      consequence: "可观测性",
      trigger: "仅理论",
      strength: "推理",
      reason: "占位",
      evidence: `nope/none${i}.go:1`,
    });
  }
  const manyState = freshState();
  const manyTool = createSubmitVerdictsTool(manyState, knownIds, unstructured, makeReport(), materials, CWD, readRoots, { maxAttempts: 3 });
  const rMany = await run(manyTool, many);
  assert(rMany.isError && rMany.text.split("\n- ").length - 1 === 15 && rMany.text.includes("另有 5 条未列出"), `REJECT 最多回 15 条并注明其余 5 条：${rMany.text.split("\n").slice(-2).join(" / ")}`);

  // 超限提交不得覆盖此前已接受的结果
  const keepState = freshState();
  const keepTool = createSubmitVerdictsTool(keepState, knownIds, unstructured, makeReport(), materials, CWD, readRoots, { maxAttempts: 1 });
  await run(keepTool, baseParams());
  const kept = keepState.accepted;
  assert(kept !== null, "第 1 次合格已接受");
  const rOver = await run(keepTool, baseParams({ final: "另一份最终裁决，长度需≥20字符，凑够字数用于满足 schema 约束。" }));
  assert(rOver.isError && keepState.accepted === kept, "超限那次直接拒且 accepted 保持原对象不被改写");
}

// ---------- 用例 6：aggregator 同一套机械核验（设计 v4 §12.2 D / §12.6 第 2 点，波四 2026-09-20）----------
{
  log("=== 用例 6：evidence 行号越界 REJECT / evidenceRef 三态（相符 / 未命中 / 无标识符）===");

  // evidence 行号越界：路径可解析，但行号不在任一附入段内（材料只附 1-20 行）。
  const outOfBound = baseParams();
  outOfBound.verdicts[3]!.evidence = "internal/x/ratchet.go:999";
  const errs = validate(outOfBound);
  assert(
    errs.some((e) => e.includes("evidence「internal/x/ratchet.go:999」的行号不在附入区间内") && e.includes("可用：1-20")),
    `evidence 行越界 REJECT 且文案含可用区间：${JSON.stringify(errs)}`,
  );

  // evidenceRef 三态：用一段带真实标识符的独立材料（共享 materials 的 GO_LINES 只是 "line N" 占位，
  // 抽不出可核 token）。
  const identMaterials: MaterialMap = new Map();
  identMaterials.set("/repo/ident.go", [seg("/repo/ident.go", "ident.go", 1, ['func svcIdentityMatches(cmd string) bool {', "\treturn true", "}"])]);

  const refOk = computeEvidenceRef("svcIdentityMatches 在此处返回 true，未做来源校验", "ident.go:1", identMaterials, CWD, readRoots);
  assert(refOk === "相符", `reason 标识符在 evidence 行±2 内原样出现 → 相符（实际 ${refOk}）`);

  const refMiss = computeEvidenceRef("checkOriginProvenance 本应在此处被调用但没有", "ident.go:1", identMaterials, CWD, readRoots);
  assert(refMiss === "未命中", `reason 有标识符但都不在 evidence 行±2 → 未命中（实际 ${refMiss}）`);

  const refNoIdent = computeEvidenceRef("这里的处理不够严谨，应当补充校验", "ident.go:1", identMaterials, CWD, readRoots);
  assert(refNoIdent === "无标识符", `reason 抽不出可核 token → 无标识符（实际 ${refNoIdent}）`);

  // evidenceRef 登记不 REJECT：整单仍合格，且写入 state.accepted。
  const s6 = freshState();
  const t6 = createSubmitVerdictsTool(s6, knownIds, unstructured, makeReport(), materials, CWD, readRoots, { maxAttempts: 3 });
  const r6 = await run(t6, baseParams());
  assert(!r6.isError, `evidenceRef 只登记不影响接受：${r6.text}`);
  assert(
    s6.accepted!.verdicts.every((v) => v.evidenceRef === "无标识符" || v.evidenceRef === "未命中" || v.evidenceRef === "相符"),
    `每条 verdict 都补上了 evidenceRef：${JSON.stringify(s6.accepted!.verdicts.map((v) => v.evidenceRef))}`,
  );
}

// ---------- 用例 13：★PIMOA-DEF-05 —— 条件计数必须与 conditionFlag / 表格渲染同一集合（facts + amended.added） ----------
{
  log("=== 用例 13（DEF-05）：补前提新增的运行时条件必须计入 conditionFactCount（否则模型被要求条数=0） ===");
  // 现场（2026-09-20 moa#e1c484fa）：premiseRound 把新增 fact 写进 fc.amended.added，并用
  // [...fc.facts, ...amended.added] 重算 conditionFlag（jevcheck.ts:1639）⇒ flag=true；
  // 但 conditionFactCount 只数 fc.facts（零写入点）⇒ need=0，核对表「成立条件：」行也一条不列，
  // 模型按「须给 conditions」的自然理解给 1 条 ⇒ 1 !== 0 ⇒ REJECT 3 次。
  const COND = { text: "运行时条件：上游未加锁时才会发生", kind: "condition" as const, p: null, status: "条件" as const };

  // 单元面：facts 无条件、amended 有 1 条 condition ⇒ 计数必须是 1（修前是 0）。
  const checkAmendedOnly = fc({ pid: "P9/A1", facts: [], amended: { added: [COND], ms: 1 }, conditionFlag: true, status: "条件性成立" });
  assert(conditionFactCount(checkAmendedOnly) === 1, `仅补前提带条件 ⇒ 计数 1（实际 ${conditionFactCount(checkAmendedOnly)}）`);
  // facts 1 条 + amended 1 条 ⇒ 2（两边都数，不重不漏）。
  const checkBoth = fc({
    pid: "P9/A2",
    facts: [{ text: "运行时条件：facts 侧条件", kind: "condition", p: null, status: "条件" }],
    amended: { added: [COND], ms: 1 },
    conditionFlag: true,
  });
  assert(conditionFactCount(checkBoth) === 2, `facts + amended 两侧条件都计入 ⇒ 2（实际 ${conditionFactCount(checkBoth)}）`);
  // 非 condition 的补前提事实不计入。
  const checkNonCond = fc({
    pid: "P9/A3",
    facts: [],
    amended: { added: [{ text: "补前提：某代码事实", kind: "code", p: 0.9, status: "相符" }], ms: 1 },
    conditionFlag: false,
  });
  assert(conditionFactCount(checkNonCond) === 0, `补前提只加 code 类事实 ⇒ 0（实际 ${conditionFactCount(checkNonCond)}）`);

  // 校验面：report 里该 finding 的 flag=true 且条件全在 amended.added ⇒ 给 1 条 conditions 必须**合格**。
  const report = makeReport();
  report.perFinding["P2/G2"] = fc({
    pid: "P2/G2",
    status: "条件性成立",
    conditionFlag: true, // 由 computeConditionFlag([...facts, ...amended.added]) 算出
    facts: [],
    amended: { added: [COND], ms: 1 },
  });
  const paramsOk = baseParams();
  paramsOk.verdicts[2]!.conditions = [{ c: "C1", verdict: "可发生" }];
  const errsOk = validate(paramsOk, report);
  assert(errsOk.length === 0, `★补前提条件数 1 + conditions 给 1 条 ⇒ 合格（修前此处 REJECT：${JSON.stringify(errsOk)}）`);

  // 反向边界：给 0 条（即旧口径的「need=0」）必须被拒，且报错里的条数写 1 —— 证明计数确实改了口径。
  const paramsZero = baseParams();
  delete paramsZero.verdicts[2]!.conditions;
  const errsZero = validate(paramsZero, report);
  assert(
    errsZero.some((e) => e.includes("运行时条件数 1")),
    `★不给 conditions ⇒ REJECT 且写明「运行时条件数 1」（旧口径会写 0，那正是缺陷）：${JSON.stringify(errsZero)}`,
  );
  const paramsTwo = baseParams();
  paramsTwo.verdicts[2]!.conditions = [
    { c: "C1", verdict: "可发生" },
    { c: "C2", verdict: "被排除" },
  ];
  const errsTwo = validate(paramsTwo, report);
  assert(
    errsTwo.some((e) => e.includes("条数须等于运行时条件数 1，实给 2")),
    `给 2 条（按旧口径刚好对）现在应被拒：${JSON.stringify(errsTwo)}`,
  );
}

// ---------- 用例 14：★PIMOA-DEF-05 复审 —— conditions 上限必须 ≥ 并集最大可能条数 ----------
{
  log("=== 用例 14（DEF-05 复审）：CONDITIONS_MAX_ITEMS ≥ facts 上限 + 补前提单次上限 ===");
  // ★这条断言就是用来在未来有人改任一处上限时把本缺陷重新暴露出来的：
  //   conditions 的 schema 上限若 < 「facts 里的 condition 条数 + 补前提单次新增的 condition 条数」，
  //   typebox 在**进处理器之前**就拒掉整份提交，validateVerdicts 的等长校验永远看不到
  //   ⇒ need ∈ [上限+1, 12] 时模型照核对表填写也必然被拒（DEF-05 修复把洞挪了位置）。
  const factsMax = FINDING_LIMITS.factsMax;
  const amendFactsArray = AmendFactsParams.properties.facts;
  // 补前提单次上限现算，不写死第二个魔数；万一该字段不再可机械读取，才退化为字面量 4 并在断言文案里注明。
  const amendMaxReadable = typeof amendFactsArray.maxItems === "number";
  const amendMax = amendMaxReadable ? amendFactsArray.maxItems : 4;
  assert(
    CONDITIONS_MAX_ITEMS >= factsMax + amendMax,
    `★上限关系锁死：CONDITIONS_MAX_ITEMS(${CONDITIONS_MAX_ITEMS}) ≥ FINDING_LIMITS.factsMax(${factsMax}) + ` +
      `AmendFactsParams.facts.maxItems(${amendMax}${amendMaxReadable ? "，现算" : "，字面量回退"})——` +
      `这条断言就是用来在未来有人改任一处上限时把本缺陷重新暴露出来的`,
  );
  assert(amendMaxReadable, `AmendFactsParams.facts.maxItems 可机械读取：${amendFactsArray.maxItems}`);
  assert(
    CONDITIONS_MAX_ITEMS === 12,
    `并集最大条数 = 8 + 4 = 12（jevcheck.ts:1641 每个 finding 的 amended 只赋值一次，不累加）：${CONDITIONS_MAX_ITEMS}`,
  );
}

// ---------- 用例 15：★DEF-05 复审 —— need=12（facts 8 条条件 + 补前提 4 条条件）可被 schema 与校验同时满足 ----------
{
  log("=== 用例 15（DEF-05 复审）：need=12 时照核对表填写必须能通过 ===");
  const mkConds = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ text: `运行时条件：${tag}条件 ${i + 1}`, kind: "condition" as const, p: null, status: "条件" as const }));
  const check12 = fc({
    pid: "P9/B1",
    facts: mkConds(FINDING_LIMITS.factsMax, "facts 侧"),
    amended: { added: mkConds(4, "补前提"), ms: 1 },
    conditionFlag: true,
    status: "条件性成立",
  });
  assert(
    conditionFactCount(check12) === 12,
    `conditionFactCount = 8 条 facts 条件 + 4 条补前提条件 = 12（实际 ${conditionFactCount(check12)}）`,
  );

  const report12: JevCheckReport = {
    enabled: true,
    perFinding: { "P9/B1": check12 },
    duplicates: [],
    conflicts: [],
    oneSided: [],
    proposerQuality: {},
    totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
    tableText: "",
  };
  const payload12: SubmitVerdictsInput = {
    verdicts: [
      {
        finding_ids: ["P9/B1"],
        level: "MAJOR",
        can_happen: "能",
        consequence: "静默失败",
        trigger: "特定输入或环境",
        strength: "亲验",
        reason: "12 条运行时条件已逐条回应，条件成立时确会静默吞错",
        evidence: "internal/x/ratchet.go:3",
        conditions: mkConds(12, "payload").map((_, i) => ({ c: `C${i + 1}`, verdict: "可发生" as const })),
      },
    ],
    final: "单条裁决：12 条运行时条件已逐条回应，条件成立时确会静默吞错。",
  };
  assert(
    Value.Check(SubmitVerdictsParams, payload12),
    `conditions 长度 12 的 payload 通过 typebox schema（maxItems=${CONDITIONS_MAX_ITEMS}；修前为 8 时在此被拒）`,
  );
  const errs12 = validateVerdicts(payload12, ["P9/B1"], [], report12, materials, CWD, readRoots);
  assert(errs12.length === 0, `★conditions 给满 12 条 ⇒ validateVerdicts 空错误数组（修前不可满足）：${JSON.stringify(errs12)}`);
}

// ---------- 用例 16：★DEF-05 复审（洞里 2）—— entailP2 缺失时 conditionFlag 仍须重算 ----------
{
  log("=== 用例 16（DEF-05 复审）：added 含 condition 而 entailP2 缺失 ⇒ flag 与计数同源重算 ===");
  // 现场：premiseRound 的 added 已经写入 fc.amended（jevcheck.ts:1641 无条件），而 entailP2 在
  //   · r2.p === null（jevcheck.ts:1167）或
  //   · noul 抛非 JevUnavailable 异常被 catch 吞掉（jevcheck.ts:1168）
  // 两条路径下都保持 undefined。修前 conditionFlag 的重算嵌在 `if (r.entailP2 !== undefined)` 里，
  // 于是核对表列出了补前提带出的条件，flag 却仍是旧值 ⇒ 条件红旗门跳过 ⇒ 显示与校验门不同源。
  const finding: FindingRecord = {
    id: "F1",
    kind: "finding",
    level: "MAJOR",
    path: "internal/x/ratchet.go",
    lines: "1-2",
    anchor: "line 1",
    facts: ["ratchet.go 第 1 行是占位内容，用于构造前提不足的 finding"],
    claim: "占位 claim，长度满足 schema 约束，用于驱动补前提阶段",
    fix_expect: "占位 fix_expect，长度满足 schema 约束，用于驱动补前提阶段",
    strength: "推理",
    pid: "P1/F1",
    proposerIndex: 0,
    proposerModel: "test/model",
  };
  const pre: FindingCheck = {
    pid: "P1/F1",
    ref: "OK",
    facts: [{ text: "ratchet.go 第 1 行是占位内容", kind: "code", p: 0.9, status: "相符" }],
    entail: { p1: 0.1 },
    status: "前提不足",
    conditionFlag: false,
    calls: [],
  };
  // budget.maxCalls=1：precomputed 不计调用 ⇒ 补前提照跑（calls=0 < 1），跑完 calls=1 ⇒ dedupe 跳过，
  // 客户端只需回答 entail，不需要材料定位（condition 类补充事实不问 Jev，jevcheck.ts:1110-1112）。
  const cfg: JevcheckCfg = {
    ...JEVCHECK_DEFAULTS,
    enabled: true,
    budget: { ...JEVCHECK_DEFAULTS.budget, maxCalls: 1 },
    premiseRound: { ...JEVCHECK_DEFAULTS.premiseRound, enabled: true, maxFindings: 10, concurrency: 4, perCallMs: 30_000 },
  };
  const p2MissingClient: JevClientLike = {
    async ask() {
      return { results: {}, calls: [] };
    },
    async noul() {
      return { p: null, calls: [] }; // ★ entail 答不出 p ⇒ premiseRound 不设 entailP2
    },
  };
  const amendConditionSession: RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute(
        "call-1",
        { id: "F1", facts: ["运行时条件：上游未加锁时才会发生"] } as never,
        undefined as never,
        undefined as never,
        { cwd: CWD } as never,
      );
    }
    return {
      text: "",
      usage: null,
      costUsd: 0,
      durationMs: 1,
      timedOut: false,
      aborted: false,
      sawAgentEnd: true,
      structured: { accepted: true, count: 1, attempts: 1 },
    };
  };
  const report16 = await runJevCheck({
    findings: [finding],
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: amendConditionSession,
    modelRuntime: null as never,
    cwd: CWD,
    readRoots,
    deadlineMs: 90_000,
    client: p2MissingClient,
    precomputed: new Map([[finding.pid, pre]]),
  });
  const got = report16.perFinding[finding.pid]!;
  assert(got.entail.p2 === undefined, `场景成立：entailP2 缺失（noul 返回 p=null 路径）`);
  assert(
    got.amended?.added.length === 1 && got.amended.added[0]!.kind === "condition",
    `场景成立：amended.added 含 1 条 condition（${JSON.stringify(got.amended?.added ?? [])}）`,
  );
  assert(
    got.conditionFlag === true,
    `★p2 缺失时 conditionFlag 仍按 facts + amended.added 重算为 true（修前嵌在 p2 分支里，保持 false）`,
  );
  assert(conditionFactCount(got) === 1, `★flag 与计数同源：conditionFactCount = 1（实际 ${conditionFactCount(got)}）`);
  assert(
    report16.tableText.includes("成立条件：") && report16.tableText.includes("（补前提）"),
    `核对表列出了这条补前提条件（显示与校验门同源）：成立条件 行 = ${report16.tableText.split("\n").find((l) => l.startsWith("成立条件：")) ?? "（未渲染）"}`,
  );
  assert(
    got.status === "前提不足",
    // ★2026-09-21 订正（文档对抗审 问题 10）：本消息原写「status 仍留在 p2 分支内…本批明确不改 status，只登记」，
    //   那是 DEF-05 批次时的旧结论。DEF-07 甲（徐总 2026-09-20 选甲）之后，jevcheck.ts 已把 status 的重算
    //   移出 p2 分支、按并集无条件重算（p2 缺失时沿用 fc.entail.p1）。本场景 status 仍落「前提不足」，
    //   原因已变为：p1 = 0.1 < cfg.thresholds.entail.low ⇒ 命中 synthesizeStatus 的②档（依 p 阈值），
    //   与「是否重算」无关。断言值不变，仅订正归因，避免注释与实现漂移。
    `DEF-07 甲后 status 已按并集无条件重算；本场景 p1=0.1 < entail.low ⇒ 落②档「前提不足」（依 p 阈值，与是否重算无关）（实际 ${got.status}）`,
  );
}

// ---------- 用例 17：★BACKLOG §7.1 乙 特征化 —— 条件红旗并条时 conditions 等长门数学无解 ----------
{
  log("=== 用例 17（特征化·已知缺陷）：两个条件红旗 finding 并进同一条裁决 ⇒ conditions 等长门无解 ===");
  // 构造取自主代理探针 probe-conditions-deadlock.mts（BACKLOG-首次提交打回.md §七）：
  //   P1/F1 运行时条件 2 条、P1/F3 运行时条件 3 条，两者 conditionFlag=true，并进**同一条**裁决。
  //   validateVerdicts 对**每个**被覆盖的 conditionFlag=true 的 id 各自要求 `conditions.length === need`
  //   ⇒ 单一数组长度必须同时等于 2 与 3 ⇒ 给任何长度都必撞一端；完全不给则两条各报一次。
  // ★本用例是**特征化（characterization）断言**，钉的是一条已知缺陷：
  //   【约束内不可修、登记见 BACKLOG-首次提交打回.md §7.1 乙】——并条违背 conditions 等长门，分开两条
  //   又违背冲突对强制合并门（report.conflicts 含该对时，见下方场景 3），任何提示词都救不了；本批只在
  //   聚合器提示词里加「条件红旗 finding 不得并条」的禁令（§7.1 甲半，管可选合并那一半）。
  //   若日后有人从判据层面修复（出界变更），本用例会变红——那是**预期**提醒：须同步更新 BACKLOG §7.1 乙
  //   与本注释，而不是把期望值改绿。
  const condOf = (n: number, tag: string): FactCheck[] =>
    Array.from({ length: n }, (_, i) => ({ text: `运行时条件：${tag}${i + 1}`, kind: "condition" as const, p: null, status: "条件" as const }));
  const mkCondReport = (conflict: boolean): JevCheckReport => ({
    enabled: true,
    perFinding: {
      "P1/F1": fc({ pid: "P1/F1", status: "条件性成立", conditionFlag: true, facts: condOf(2, "A") }),
      "P1/F3": fc({ pid: "P1/F3", status: "条件性成立", conditionFlag: true, facts: condOf(3, "B") }),
    },
    duplicates: [],
    conflicts: conflict ? [{ a: "P1/F1", b: "P1/F3", pSame: 1, pOpposite: 0.8, viaCounter: true }] : [],
    oneSided: [],
    proposerQuality: {},
    totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
    tableText: "",
  });
  const bothIds = ["P1/F1", "P1/F3"];
  const mkSubmit = (ids: string[], n?: number, adopted?: string): SubmitVerdictsInput => ({
    verdicts: [
      {
        finding_ids: ids,
        level: "MINOR",
        can_happen: "能",
        consequence: "可观测性",
        trigger: "特定输入或环境",
        strength: "推理",
        reason: "并条场景的特征化裁决理由文本",
        evidence: "internal/x/ratchet.go:5",
        ...(n === undefined ? {} : { conditions: Array.from({ length: n }, (_, i) => ({ c: `C${i + 1}`, verdict: "可发生" as const })) }),
        ...(adopted === undefined ? {} : { adopted }),
      },
    ],
    final: "特征化用例：条件红旗并条时 conditions 等长门无解（已知缺陷，登记见 BACKLOG §7.1 乙）。",
  });
  const runConds = (p: SubmitVerdictsInput, report: JevCheckReport) =>
    validateVerdicts(p, bothIds, [], report, materials, CWD, readRoots);
  const condErrs = (errs: string[]): string[] => errs.filter((e) => e.includes("conditions"));
  const reportNoConflict = mkCondReport(false);

  const e2 = runConds(mkSubmit(bothIds, 2), reportNoConflict);
  const e3 = runConds(mkSubmit(bothIds, 3), reportNoConflict);
  const e0 = runConds(mkSubmit(bothIds), reportNoConflict);
  log(`给 2 条 → ${JSON.stringify(condErrs(e2))}`);
  log(`给 3 条 → ${JSON.stringify(condErrs(e3))}`);
  log(`不给   → ${JSON.stringify(condErrs(e0))}`);

  assert(
    condErrs(e2).length === 1 && condErrs(e2)[0]!.includes("P1/F3") && condErrs(e2)[0]!.includes("实给 2"),
    `① 并条 + 给 2 条：F1（need=2）满足但 F3（need=3）仍被拒：${JSON.stringify(condErrs(e2))}`,
  );
  assert(
    condErrs(e3).length === 1 && condErrs(e3)[0]!.includes("P1/F1") && condErrs(e3)[0]!.includes("实给 3"),
    `① 并条 + 给 3 条：F3 满足但 F1 仍被拒：${JSON.stringify(condErrs(e3))}`,
  );
  assert(
    condErrs(e0).length === 2,
    `① 并条 + 完全不给 conditions：两条各报一次「须给 conditions」⇒ 也必被拒：${JSON.stringify(condErrs(e0))}`,
  );
  assert(
    e2.length > 0 && e3.length > 0 && e0.length > 0,
    `② ★数学无解：不存在任何 conditions 长度能同时满足 need=2 与 need=3（两端互斥，且不给亦被拒）`,
  );

  // 场景 2：分开两条各自成裁决 ⇒ conditions 门零错（证明死锁只由「并条」造成，不是 fixture 自身有错）。
  const splitCondErrs = [
    ...condErrs(runConds(mkSubmit(["P1/F1"], 2), reportNoConflict)),
    ...condErrs(runConds(mkSubmit(["P1/F3"], 3), reportNoConflict)),
  ];
  assert(splitCondErrs.length === 0, `场景 2：分开两条各自成裁决 → conditions 门零错（死锁只由并条造成）：${JSON.stringify(splitCondErrs)}`);

  // 场景 3：★不可修的另一半——冲突对强制并条（validateVerdicts 对 report.conflicts 强制「同一条覆盖 +
  //   给 adopted」），若该对两条同时是条件红旗且 need 不等，并条满足冲突对门却必撞 conditions 门，
  //   分开满足 conditions 门却必撞冲突对门 ⇒ 两边堵死，提示词无解。
  const reportConflict = mkCondReport(true);
  const s3both = runConds(mkSubmit(bothIds, 2, "折中"), reportConflict);
  const s3split = runConds(mkSubmit(["P1/F1"], 2, "折中"), reportConflict);
  assert(
    s3both.filter((e) => e.includes("冲突对")).length === 0 && condErrs(s3both).length > 0,
    `场景 3：并条 + 给 adopted ⇒ 冲突对门满足、conditions 门必撞：${JSON.stringify(s3both)}`,
  );
  assert(
    s3split.some((e) => e.includes("未被同一条裁决覆盖")),
    `场景 3：只覆盖一条 ⇒ 冲突对门报「未被同一条裁决覆盖」：${JSON.stringify(s3split.filter((e) => e.includes("冲突对")))}`,
  );
}

// ---------- 用例 18（2026-09-21 改 5）：submit_verdicts 工具描述与核对表同源措辞 ----------
{
  log("=== 用例 18（改 5 同源）：工具描述的 table_handling 触发词改用核对表自己的词汇 ===");
  const desc = createSubmitVerdictsTool(freshState(), knownIds, unstructured, makeReport(), materials, CWD, readRoots, {
    maxAttempts: 3,
  }).description;
  assert(
    desc.includes("合成状态含「不符前提」") && desc.includes("出现「引用：」行"),
    `table_handling 触发词与核对表同源（合成状态含『不符前提』/ 出现『引用：』行）：${desc}`,
  );
  assert(!desc.includes("核对表标异常时必填"), `不再用笼统的「核对表标异常时必填」（改前措辞，与门控不同源）：${desc}`);
  assert(desc.includes("须填：conditions ×N"), `conditions 触发词指向核对表印的派生标记：${desc}`);
  // 2026-09-21 收口修订：工具描述与聚合器 prompt / types.ts 真源逐项对齐（B7/B8/B9/B11/B12）。
  assert(desc.includes("最多 8 个"), "finding_ids 上限 8 写进描述（types.ts:97 maxItems:8）");
  assert(desc.includes("reason（10–150 字）"), "reason 写成 10–150 字（types.ts:122 minLength:10 / maxLength:150）");
  assert(desc.includes("路径不含空白字符、≤200 字"), "evidence 写出「路径不含空白字符、≤200 字」（types.ts:124）");
  assert(desc.includes("取值 P1/P2/P3/折中/均不采信"), "adopted 取值含 P3（types.ts:141，与聚合器 prompt 一致）");
  assert(
    desc.includes("{c, verdict, line?}") && desc.includes("verdict 取 可发生/被排除/材料不足，行号写在 line"),
    "conditions 元素形状与聚合器 prompt 一致（行号写 line，不塞进 verdict）（types.ts:155-164）",
  );
  assert(desc.includes("final：一段最终裁决（20–1500 字）"), "final 写成 20–1500 字（types.ts:169 minLength:20）");
}

// ---------- 用例 17：truth 判假不再触发 KILL 特例，普通核对表规则保留 ----------
{
  log("=== 用例 17：truth=假不触发 KILL 特例；异常仍须普通 table_handling ===");
  const report: JevCheckReport = {
    enabled: true,
    perFinding: { "P1/K1": fc({ pid: "P1/K1", ref: "锚点未命中", truth: { verdict: "假", rule: "KILL", brokenStep: "c2", mechNotes: [] } }) },
    duplicates: [], conflicts: [], oneSided: [], proposerQuality: {},
    totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 }, tableText: "",
  };
  const params = baseParams();
  params.verdicts = [{ ...params.verdicts[0]!, finding_ids: ["P1/K1"], adopted: undefined, table_handling: "材料不足" }];
  const run = (): string[] => validateVerdicts(params, ["P1/K1"], [], report, materials, CWD, readRoots);
  assert(run().length === 0, "truth=假可使用普通四值中的材料不足");
  params.verdicts[0]!.table_handling = undefined;
  assert(run().some((e) => e.includes("核对表标了异常") && e.includes("须填 table_handling")), "引用异常的通用必填规则仍生效");
}

// ---------- 用例 19（2026-09-23 反馈质量·1a）：U 形态提示条件化 ----------
{
  log("=== 用例 19（反馈质量·1a）：unstructured 为空 ⇒ 未知 id 报错不提 U 形态、给 P1/F1 提示；description 同步省略 ===");
  // 事故复刻（moa#8f9ee5df 第 2 次提交 34 条错）：文案在 unstructured 为空时仍宣传本轮非法的
  // P{i}/U{n}，模型照抄 P1/U1 全被拒。修后：unstructured 空 ⇒ 提示正确 id 格式（斜杠必写）。
  const p = baseParams();
  p.verdicts[3]!.finding_ids = ["P1F1"]; // 复刻：少斜杠的未知 id（合法是 P1/F1），原 P3/U1 一并移除
  const errsNoU = validateVerdicts(p, knownIds, [], makeReport(), materials, CWD, readRoots);
  const unknownErrs = errsNoU.filter((e) => e.includes("引用了未知 finding_id"));
  assert(unknownErrs.length === 1, `未知 id 合并为 1 条回贴：${JSON.stringify(unknownErrs)}`);
  assert(
    unknownErrs[0]!.includes("引用了未知 finding_id「P1F1」") &&
      unknownErrs[0]!.includes("形如 P1/F1，斜杠必写") &&
      !unknownErrs[0]!.includes("U{编号}") &&
      !unknownErrs[0]!.includes("P{提议序号}"),
    `★unstructured 空 ⇒ 报错不含 U 形态、含 P1/F1 提示：${unknownErrs[0] ?? ""}`,
  );
  // 对照：unstructured 非空 ⇒ 保留原 U 形态文案（现有 232 行断言同场景，这里补一条反向锁）。
  const pWithU = baseParams();
  pWithU.verdicts[0]!.finding_ids = ["P1/F1", "P2/G1", "P1F1"];
  const errsWithU = validate(pWithU);
  assert(
    errsWithU.some((e) => e.includes("引用了未知 finding_id「P1F1」") && e.includes("或形如 P{提议序号}/U{编号}")),
    `unstructured 非空 ⇒ 保留原 U 形态文案：${JSON.stringify(errsWithU.filter((e) => e.includes("未知 finding_id")))}`,
  );
  // description 条件化（1a 第二半）：unstructured 空 ⇒ 省略「或未结构化提议的 P{提议序号}/U{编号}」。
  const descNoU = createSubmitVerdictsTool(freshState(), knownIds, [], makeReport(), materials, CWD, readRoots, { maxAttempts: 5 }).description;
  assert(
    !descNoU.includes("或未结构化提议的") && !descNoU.includes("P{提议序号}/U{编号}") && descNoU.includes("最多 8 个"),
    `★description 在 unstructured 空时省略 U 形态句、保留「最多 8 个」：${descNoU.slice(0, 200)}`,
  );
  const descWithU = createSubmitVerdictsTool(freshState(), knownIds, [3], makeReport(), materials, CWD, readRoots, { maxAttempts: 5 }).description;
  assert(
    descWithU.includes("最多 8 个，或未结构化提议的 P{提议序号}/U{编号}"),
    `description 在 unstructured 非空时保留原句逐字：…${(descWithU.match(/finding_ids（[^）]*）/) ?? [""][0])}`,
  );
}

// ---------- 用例 20（2026-09-23 反馈质量·1b）：多未知 finding_id 折叠为单条 ----------
{
  log("=== 用例 20（反馈质量·1b）：多未知 finding_id 合并为 1 条回贴（计数 + 涉裁决序号）===");
  // 事故复刻（moa#8f9ee5df 第 1 次提交）：31 条少斜杠未知 id 逐条回贴、15 条 cap 截断后打地鼠收敛不完。
  const p = baseParams();
  p.verdicts[0]!.finding_ids = ["P1/F1", "P2/G1", "P1F1"]; // 裁决 1：未知 id ×1
  p.verdicts[1]!.finding_ids = ["P1/F2", "P1F2"]; // 裁决 2：未知 id ×1
  const errs = validate(p);
  const unknownErrs = errs.filter((e) => e.includes("引用了未知 finding_id"));
  assert(unknownErrs.length === 1, `★2 处未知 id 折叠为 1 条（修前逐条 2 条）：${JSON.stringify(unknownErrs)}`);
  assert(
    unknownErrs[0]!.includes("「P1F1」") &&
      unknownErrs[0]!.includes("「P1F2」") &&
      unknownErrs[0]!.includes("共 2 处") &&
      unknownErrs[0]!.includes("涉裁决 1、2"),
    `合并条列全 id + 尾注计数与涉裁决序号：${unknownErrs[0] ?? ""}`,
  );
}

// ---------- 用例 23:★2026-09-27 C 提示词预防——submit_verdicts 描述以原句收尾（不占 DEF 号） ----------
{
  log("=== 用例 23（C 提示词预防）：submit_verdicts 描述追加 raw JSON 原句，schema 不动 ===");
  const NOTE = "参数必须是纯 JSON 对象(raw JSON):禁止 ``` 围栏、注释、任何非 JSON 内容。";
  const tool = createSubmitVerdictsTool(freshState(), knownIds, unstructured, makeReport(), materials, CWD, readRoots, { maxAttempts: 3 });
  assert(tool.description.endsWith(NOTE), "submit_verdicts 描述以原句收尾（一字不差）");
  assert(!JSON.stringify(tool.parameters).includes("raw JSON"), "只改描述，不落 schema（反向自证：参数 schema 里没有该句）");
}

// ---------- 用例 24：★PIMOA-DEF-09（2026-09-27）——evidence 路径形态兜底 + report slice 消歧 + 拒因回贴可用形态 ----------
{
  log("=== 用例 24：DEF-09 evidence 四形态 ACCEPT / 多候选 slice 消歧 / 拒因句末（可用：…）===");
  const R_CWD = WS + "/workspace";
  const R_REL = "Claude dev paper system/PiMoa/config/models.json";
  const R_ABS = `${R_CWD}/${R_REL}`;
  const rLines = Array.from({ length: 48 }, (_, i) => (i === 1 ? '  "providerRegistry": {' : `  "k${i + 40}": ${i + 40},`));
  const rMaterials: MaterialMap = new Map([[R_ABS, [seg(R_ABS, R_REL, 40, rLines)]]]);
  const one = (evidence: string, ids: string[] = ["P1/F1"]): SubmitVerdictsInput => ({
    verdicts: [
      {
        finding_ids: ids,
        level: "MINOR",
        can_happen: "能",
        consequence: "无实际后果",
        trigger: "仅理论",
        strength: "亲验",
        reason: "providerRegistry 键在该行定义，模型组合由此处读入",
        evidence,
      },
    ],
    final: "单条裁决：providerRegistry 键的定义位置经核对与引用一致，定为 MINOR。",
  });
  // ① REPRO 四形态 + 修前被拒的两种短形态：全部 ACCEPT（evidence schema 禁空白，这些都能过 schema）。
  for (const form of [
    WS + "/workspace/Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "PiMoa/config/models.json",
    "config/models.json",
    "models.json",
  ]) {
    const p = one(`${form}:41`);
    const schemaOk = Value.Check(SubmitVerdictsParams, p);
    const errs = validateVerdicts(p, ["P1/F1"], [], null, rMaterials, R_CWD, []);
    assert(schemaOk && errs.length === 0, `evidence「${form}:41」→ 过 schema 且 ACCEPT：${JSON.stringify(errs)}`);
    assert(
      computeEvidenceRef("providerRegistry 键在此定义", `${form}:41`, rMaterials, R_CWD, []) === "相符",
      `computeEvidenceRef 同口径：「${form}:41」→ 相符`,
    );
  }

  // ② 拒因句式：前半句一字不改，句末追加「（可用：…）」；可用形态为 rel 的空白 %20 编码。
  const missErrs = validateVerdicts(one("nope/other.json:41"), ["P1/F1"], [], null, rMaterials, R_CWD, []);
  const R_HINT = "Claude%20dev%20paper%20system/PiMoa/config/models.json";
  assert(
    missErrs.length === 1 && missErrs[0] === `第 1 条裁决：evidence「nope/other.json:41」的路径解析不到本轮附入材料（可用：${R_HINT}）`,
    `miss 拒因逐字：${JSON.stringify(missErrs)}`,
  );
  assert(missErrs[0]!.includes("evidence「nope/other.json:41」的路径解析不到本轮附入材料"), "前半句旧句式仍被 includes 命中（既有断言不破）");
  // 回贴的可用形态能再次被 resolveMaterial 解析（模型照抄即过）。
  const reErrs = validateVerdicts(one(`${R_HINT}:41`), ["P1/F1"], [], null, rMaterials, R_CWD, []);
  assert(reErrs.length === 0 && Value.Check(SubmitVerdictsParams, one(`${R_HINT}:41`)), `照抄回贴形态 → 过 schema 且 ACCEPT：${JSON.stringify(reErrs)}`);
  // 解析得到但行号越界：原「行号不在附入区间内」分支不受影响。
  const lineErrs = validateVerdicts(one("config/models.json:200"), ["P1/F1"], [], null, rMaterials, R_CWD, []);
  assert(lineErrs.length === 1 && lineErrs[0]!.includes("的行号不在附入区间内（可用：40-87）"), `尾部命中后照旧校行号：${JSON.stringify(lineErrs)}`);

  // ③ 超过 6 个材料文件：只列 6 条 + 「等」。
  const many: MaterialMap = new Map();
  for (let i = 1; i <= 8; i++) {
    const abs = `/repo/pkg${i}/f.go`;
    many.set(abs, [seg(abs, `pkg${i}/f.go`, 1, ["x"])]);
  }
  const manyErrs = validateVerdicts(one("zzz.go:1"), ["P1/F1"], [], null, many, CWD, []);
  assert(
    manyErrs.length === 1 && manyErrs[0]!.endsWith("（可用：pkg1/f.go、pkg2/f.go、pkg3/f.go、pkg4/f.go、pkg5/f.go、pkg6/f.go等）"),
    `超 6 条截断并写「等」：${JSON.stringify(manyErrs)}`,
  );
  // 恰好 6 条不写「等」。
  const six: MaterialMap = new Map([...many.entries()].slice(0, 6));
  const sixErrs = validateVerdicts(one("zzz.go:1"), ["P1/F1"], [], null, six, CWD, []);
  assert(sixErrs[0]!.endsWith("pkg6/f.go）"), `恰好 6 条不写「等」：${JSON.stringify(sixErrs)}`);
  // 材料表为空：不追加括号（前半句原样）。
  const emptyErrs = validateVerdicts(one("zzz.go:1"), ["P1/F1"], [], null, new Map(), CWD, []);
  assert(emptyErrs[0] === "第 1 条裁决：evidence「zzz.go:1」的路径解析不到本轮附入材料", `材料为空不追加后缀：${JSON.stringify(emptyErrs)}`);

  // ④ 多候选：两份 x/main.go。无 report → REJECT 并只列两个候选；report slice 指向 b 份 → ACCEPT。
  const A1 = "/repo/a/x/main.go";
  const B1 = "/repo/b/x/main.go";
  const twoMain: MaterialMap = new Map([
    [A1, [seg(A1, "a/x/main.go", 1, ["func AlphaEntry() {}"])]],
    [B1, [seg(B1, "b/x/main.go", 1, ["func BetaEntry() {}"])]],
    [ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", 1, GO_LINES)]],
  ]);
  const ambErrs = validateVerdicts(one("x/main.go:1"), ["P1/F1"], [], null, twoMain, CWD, []);
  assert(
    ambErrs.length === 1 && ambErrs[0] === "第 1 条裁决：evidence「x/main.go:1」的路径解析不到本轮附入材料（可用：a/x/main.go、b/x/main.go）",
    `多候选消不了歧 → REJECT 且只列候选（不静默取第一个）：${JSON.stringify(ambErrs)}`,
  );
  const sliceReport: JevCheckReport = {
    ...makeReport(),
    perFinding: {
      "P1/F1": fc({ pid: "P1/F1", facts: [{ text: "b/x/main.go:1 定义 BetaEntry", kind: "code", p: 1, status: "相符", slice: { abs: B1, a: 1, b: 1 } }] }),
    },
    conflicts: [],
    oneSided: [],
  };
  const slicedErrs = validateVerdicts(one("x/main.go:1"), ["P1/F1"], [], sliceReport, twoMain, CWD, []);
  assert(slicedErrs.length === 0, `report slice.abs 消歧 → ACCEPT：${JSON.stringify(slicedErrs)}`);
  // amended.added 里的 slice 同样参与消歧。
  const amendReport: JevCheckReport = {
    ...sliceReport,
    perFinding: {
      "P1/F1": fc({
        pid: "P1/F1",
        amended: { added: [{ text: "a/x/main.go:1 定义 AlphaEntry", kind: "code", p: 1, status: "相符", slice: { abs: A1, a: 1, b: 1 } }], ms: 1 },
      }),
    },
  };
  assert(validateVerdicts(one("x/main.go:1"), ["P1/F1"], [], amendReport, twoMain, CWD, []).length === 0, "amended.added 的 slice.abs 同样参与消歧 → ACCEPT");
  // computeEvidenceRef 与 validate 同口径：带 preferred 取 b 份相符，不带则解析不到 → 未命中。
  assert(computeEvidenceRef("BetaEntry 定义", "x/main.go:1", twoMain, CWD, [], [B1]) === "相符", "computeEvidenceRef 透传 preferredPath → b 份相符");
  assert(computeEvidenceRef("BetaEntry 定义", "x/main.go:1", twoMain, CWD, []) === "未命中", "computeEvidenceRef 无 preferred、多候选 → 未命中（不取第一个）");
  // 工具处理器端到端：ACCEPT 后 evidenceRef 也按 slice 消歧算成「相符」。
  const vstate = freshState();
  const tool = createSubmitVerdictsTool(vstate, ["P1/F1"], [], sliceReport, twoMain, CWD, [], { maxAttempts: 3 });
  const p = one("x/main.go:1");
  p.verdicts[0]!.reason = "BetaEntry 在该行定义";
  const res = (await tool.execute("t-def09", p as never, undefined, undefined, { cwd: CWD } as never)) as { isError?: boolean };
  const acceptedRef = vstate.accepted?.verdicts[0]?.evidenceRef;
  assert(!res.isError && acceptedRef === "相符", `处理器 ACCEPT 且 evidenceRef=相符（与 validate 同口径）：${JSON.stringify(acceptedRef)}`);
}

// ---------- 用例 25：★PIMOA-DEF-09 F1 fix（2026-09-27）——唯一尾部候选不匹配 report slice 的 prefs → REJECT（不 fail-open） ----------
{
  log("=== 用例 25：DEF-09 F1 verdict 侧唯一候选受 prefs 约束 ===");
  const AG = "/repo/a.go";
  const BM = "/repo/b/x/main.go";
  const f1: MaterialMap = new Map([
    [AG, [seg(AG, "a.go", 1, ["package a"])]],
    [BM, [seg(BM, "b/x/main.go", 1, ["func BetaEntry() {}"])]],
  ]);
  const one = (evidence: string): SubmitVerdictsInput => ({
    verdicts: [
      {
        finding_ids: ["P1/F1"],
        level: "MINOR",
        can_happen: "能",
        consequence: "无实际后果",
        trigger: "仅理论",
        strength: "亲验",
        reason: "BetaEntry 在该行定义，调用方由此进入",
        evidence,
      },
    ],
    final: "单条裁决：BetaEntry 定义位置经核对与引用一致，定为 MINOR。",
  });
  const sliceA: JevCheckReport = {
    ...makeReport(),
    perFinding: {
      "P1/F1": fc({ pid: "P1/F1", facts: [{ text: "a.go:1 package a", kind: "code", p: 1, status: "相符", slice: { abs: AG, a: 1, b: 1 } }] }),
    },
    conflicts: [],
    oneSided: [],
  };
  // 25.1 report slice 指向 a.go、evidence 裸写 main.go（唯一尾部候选 b/x/main.go）→ REJECT，拒因列全部材料。
  const errs = validateVerdicts(one("main.go:1"), ["P1/F1"], [], sliceA, f1, CWD, []);
  assert(
    errs.length === 1 && errs[0] === "第 1 条裁决：evidence「main.go:1」的路径解析不到本轮附入材料（可用：a.go、b/x/main.go）",
    `25.1 唯一候选不匹配 slice prefs → REJECT 并列可用形态：${JSON.stringify(errs)}`,
  );
  assert(computeEvidenceRef("BetaEntry 定义", "main.go:1", f1, CWD, [], [AG]) === "未命中", "25.1b computeEvidenceRef 同口径 → 未命中");
  // 25.2 无 report（prefs 空）→ 唯一候选直 hit，ACCEPT（现行为不变）。
  const noRep = validateVerdicts(one("main.go:1"), ["P1/F1"], [], null, f1, CWD, []);
  assert(noRep.length === 0, `25.2 无 prefs → 唯一候选 ACCEPT：${JSON.stringify(noRep)}`);
  // 25.3 写全 rel → 精确层命中，不受 prefs 收紧。
  const exact = validateVerdicts(one("b/x/main.go:1"), ["P1/F1"], [], sliceA, f1, CWD, []);
  assert(exact.length === 0, `25.3 全 rel 精确层 → ACCEPT：${JSON.stringify(exact)}`);
}

// ---------- 用例 26：退役值三层反向锁（schema / validator / 真实工具处理器） ----------
{
  log("=== 用例 26：普通 finding 的退役表态值全部拒绝；工具描述不再教授旧协议 ===");
  const normalReport: JevCheckReport = {
    ...makeReport(),
    perFinding: { "P1/F1": fc({ pid: "P1/F1" }) },
    conflicts: [], oneSided: [],
  };
  for (const [handling, rebuttal] of [
    ["翻案", undefined],
    ["翻案", "第 7 行反证"],
    ["采纳服务端驳回", undefined],
  ] as const) {
    const p = baseParams();
    p.verdicts = [{
      ...p.verdicts[0]!, finding_ids: ["P1/F1"], adopted: undefined,
      table_handling: handling, ...(rebuttal ? { rebuttal } : {}),
    }] as unknown as SubmitVerdictsInput["verdicts"];
    assert(!Value.Check(SubmitVerdictsParams, p), `schema 拒绝 ${handling}（反证字段=${rebuttal ?? "无"}）`);
    const errors = validateVerdicts(p, ["P1/F1"], [], normalReport, materials, CWD, readRoots);
    assert(errors.length === 1 && errors[0]!.includes("只许 采信不符事实/驳回不符事实/已读真实位置/材料不足"), `处理器闭集拒绝 ${handling}：${JSON.stringify(errors)}`);
    const state = freshState();
    const tool = createSubmitVerdictsTool(state, ["P1/F1"], [], normalReport, materials, CWD, readRoots, { maxAttempts: 3, enforceChain: true });
    const result = await tool.execute("retired-value", p as never, undefined, undefined, { cwd: CWD } as never);
    assert(result.isError === true && String(result.content[0]?.text).includes("REJECT") && state.accepted === null, `真实 execute 拒绝 ${handling}，accepted 仍为空`);
  }
  const folded = baseParams();
  folded.verdicts[0]!.table_handling = "翻案" as never;
  folded.verdicts[2]!.table_handling = "采纳服务端驳回" as never;
  const errors = validateVerdicts(folded, knownIds, unstructured, makeReport(), materials, CWD, readRoots);
  assert(errors.length === 1 && errors[0]!.includes("共 2 处") && errors[0]!.includes("涉裁决 1、3"), `多条退役值合并一条回贴：${JSON.stringify(errors)}`);
  for (const enforceChain of [false, true]) {
    const desc = createSubmitVerdictsTool(freshState(), ["P1/F1"], [], normalReport, materials, CWD, readRoots, { maxAttempts: 3, enforceChain }).description;
    assert(!/server-KILL|采纳服务端驳回|翻案|rebuttal/.test(desc) && desc.includes("只许 采信不符事实/驳回不符事实/已读真实位置/材料不足"), `chain=${enforceChain} 描述仅教四值`);
  }
}

console.log(`\n[submit-verdicts-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
