/**
 * render_verdicts 人读三段渲染单测（Jev 辅助代码审查详细设计 v4 §3.8，第三波 a 验收）。
 *
 * 运行：npx tsx test/render_verdicts.test.ts
 * 覆盖：三段快照（固定输入固定输出）、三种 can_happen 的单边表态各一例、驳回级出现在第二段、
 *       补充说明截断（>300 字截断、空自由文本不附该行）、无冲突无单边写「无分歧」、sha256 稳定（同输入两次哈希一致）。
 * 脱网、脱 key、不读盘。
 */
import { createHash } from "node:crypto";
import type { JevCheckReport, SubmitVerdicts, Verdict } from "../src/moa/types.js";
import { oneSidedVerdictText, renderAggregated, type FindingRecord } from "../src/moa/render_verdicts.js";

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
  console.log("[render-verdicts-test]", ...a);
}

function verdict(over: Partial<Verdict> & Pick<Verdict, "finding_ids" | "level" | "evidence">): Verdict {
  return {
    can_happen: "能",
    consequence: "数据错误",
    trigger: "常态触发",
    strength: "亲验",
    reason: "占位理由",
    ...over,
  };
}

function finding(over: Partial<FindingRecord> & Pick<FindingRecord, "pid" | "proposerIndex">): FindingRecord {
  return {
    id: over.pid!.split("/")[1] ?? "F1",
    kind: "finding",
    level: "MAJOR",
    path: "internal/x/ratchet.go",
    lines: "5",
    anchor: "占位锚点",
    facts: ["占位事实 第 5 行", "通用事实：占位", "运行时条件：占位"],
    claim: "占位缺陷描述",
    fix_expect: "占位修复期望",
    strength: "亲验",
    proposerModel: "deepseek/deepseek-v4-flash",
    ...over,
  };
}

const emptyReport: JevCheckReport = {
  enabled: true,
  perFinding: {},
  duplicates: [],
  conflicts: [],
  oneSided: [],
  proposerQuality: {},
  totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
  tableText: "",
};

// ---------- 用例 1：oneSidedVerdictText 三种 can_happen ----------
{
  log("=== 用例 1：can_happen → 单边项表态（设计 v4 §0 优化 3 权威口径）===");
  assert(oneSidedVerdictText("能") === "另一方漏报", '能 → "另一方漏报"');
  assert(oneSidedVerdictText("不能") === "该项不成立", '不能 → "该项不成立"');
  assert(oneSidedVerdictText("材料不足") === "材料不足", '材料不足 → "材料不足"');
}

// ---------- 用例 2：无冲突无单边 → 「无分歧」----------
{
  log("=== 用例 2：无冲突无单边 ===");
  const v: SubmitVerdicts = {
    verdicts: [
      verdict({ finding_ids: ["P1/F1"], level: "MINOR", evidence: "a.go:1" }),
    ],
    final: "一段最终裁决，长度需≥20字符，凑够字数用于满足 schema 约束。",
  };
  const out = renderAggregated(v, [], emptyReport, "");
  assert(out.includes("一、【冲突点与采信】\n无分歧"), `无冲突无单边写「无分歧」：\n${out}`);
}

// ---------- 用例 3：三段固定输入快照 ----------
const FIXED_V: SubmitVerdicts = {
  verdicts: [
    verdict({
      finding_ids: ["P1/F1", "P2/G1"],
      level: "MAJOR",
      evidence: "internal/x/ratchet.go:5",
      can_happen: "能",
      consequence: "数据错误",
      trigger: "常态触发",
      strength: "亲验",
      reason: "采信 P1 的行号引用",
      adopted: "P1",
      escalate: true,
    }),
    verdict({
      finding_ids: ["P1/F2"],
      level: "驳回",
      evidence: "internal/x/ratchet.go:8",
      can_happen: "不能",
      consequence: "无实际后果",
      trigger: "仅理论",
      strength: "推理",
      reason: "核对表原文不符，材料不足以支持该断言",
      table_handling: "驳回不符事实",
      note: "已读真实第 8 行，语义与 claim 不符",
    }),
    verdict({
      finding_ids: ["P2/G2"],
      level: "MINOR",
      evidence: "internal/x/ratchet.go:12",
      can_happen: "材料不足",
      consequence: "静默失败",
      trigger: "特定输入或环境",
      strength: "推理",
      reason: "两条运行时条件均已回应",
      conditions: [
        { c: "C1", verdict: "可发生" },
        { c: "C2", verdict: "被排除", line: "L64" },
      ],
    }),
  ],
  final: "综合三条：一处冲突采信 P1 且须交人工、一处驳回、一处条件性成立标记待跟进。",
};
const FIXED_FINDINGS: FindingRecord[] = [
  finding({ pid: "P1/F1", proposerIndex: 1, level: "MAJOR", claim: "Kind 为空时直接放行，缺少来源校验的 origin 会被当作合法输入继续处理" }),
  finding({ pid: "P2/G1", proposerIndex: 2, level: "COUNTER", kind: "counter", claim: "该处不存在此问题，Kind 为空属正常设计意图" }),
  finding({ pid: "P1/F2", proposerIndex: 1, level: "MINOR", claim: "占位次要缺陷描述" }),
];
const FIXED_REPORT: JevCheckReport = {
  ...emptyReport,
  conflicts: [{ a: "P1/F1", b: "P2/G1", pSame: 0.1, pOpposite: 0.88, viaCounter: true }],
  oneSided: [{ id: "P1/F2", proposerIndex: 1 }],
};
const EXPECTED = [
  "一、【冲突点与采信】",
  "分歧点：Kind 为空时直接放行，缺少来源校验的 origin 会被当作合法输入继续处理 ｜ 该处不存在此问题，Kind 为空属正常设计意图 ／ 各方主张：P1/F1 MAJOR vs P2/G1 COUNTER ／ 采信方：P1 ／ 理由：采信 P1 的行号引用",
  "仅提议 1 提出（P1/F2）：该项不成立",
  "",
  "二、【逐条裁决】",
  "MAJOR | internal/x/ratchet.go:5 | 能否发生：能 | 数据错误 / 常态触发｜交人工 | 亲验（自报） | 采信 P1 的行号引用 | P1/F1+P2/G1 | 无",
  "驳回 | internal/x/ratchet.go:8 | 能否发生：不能 | 无实际后果 / 仅理论 | 推理（自报） | 核对表原文不符，材料不足以支持该断言 | P1/F2 | 驳回不符事实（已读真实第 8 行，语义与 claim 不符）",
  "MINOR | internal/x/ratchet.go:12 | 能否发生：材料不足 | 静默失败 / 特定输入或环境 | 推理（自报） | 两条运行时条件均已回应 | P2/G2 | 条件：C1 可发生；C2 被排除@L64",
  "",
  "三、【最终裁决】",
  "综合三条：一处冲突采信 P1 且须交人工、一处驳回、一处条件性成立标记待跟进。",
].join("\n");
{
  log("=== 用例 3：三段固定输入快照 ===");
  const out = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "");
  assert(out === EXPECTED, `快照逐字节一致：\n--- 实际 ---\n${out}\n--- 期望 ---\n${EXPECTED}`);
}

// ---------- 用例 4：「驳回」级出现在第二段 ----------
{
  log("=== 用例 4：驳回级也渲染 ===");
  const out = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "");
  const section2 = out.split("二、【逐条裁决】")[1] ?? "";
  assert(section2.includes("驳回 | internal/x/ratchet.go:8"), `驳回级出现在第二段：\n${section2}`);
}

// ---------- 用例 5：补充说明（截断 / 空文本不附加）----------
{
  log("=== 用例 5：补充说明截断与空文本 ===");
  const v: SubmitVerdicts = { verdicts: [], final: "最终裁决占位文本，凑够二十字符长度。" };
  const noFree = renderAggregated(v, [], emptyReport, "");
  assert(!noFree.includes("补充说明"), `空自由文本不附「补充说明」：\n${noFree}`);
  assert(noFree.includes("（无裁决）"), "verdicts 为空数组时第二段写「（无裁决）」");

  const long = "补".repeat(310);
  const withFree = renderAggregated(v, [], emptyReport, `  ${long}  `);
  assert(withFree.includes("补充说明："), "非空自由文本附「补充说明：」");
  const m = /补充说明：(.+)$/s.exec(withFree);
  const shown = m?.[1] ?? "";
  assert(shown.length === 301 && shown.endsWith("…"), `补充说明截断到 300 字 + 省略号（实际长度 ${shown.length}）：${shown.slice(0, 20)}…`);
}

// ---------- 用例 6：sha256 稳定 ----------
{
  log("=== 用例 6：sha256 稳定（对渲染文本计算，同输入两次一致）===");
  const out1 = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "自由说明 A");
  const out2 = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "自由说明 A");
  const h1 = createHash("sha256").update(out1, "utf8").digest("hex");
  const h2 = createHash("sha256").update(out2, "utf8").digest("hex");
  assert(out1 === out2 && h1 === h2, `同输入两次渲染 + 哈希完全一致：${h1} vs ${h2}`);
  const out3 = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "自由说明 B");
  const h3 = createHash("sha256").update(out3, "utf8").digest("hex");
  assert(h3 !== h1, "不同自由文本 → 不同渲染文本 → 不同哈希");
}

// ---------- 用例 7：PiMoa 波三 a 审查补的渲染分支（adopted 折中/均不采信、table_handling 无 note、单边项 能/材料不足）----------
{
  log("=== 用例 7：adopted 枚举 / table_handling 无 note / 单边项三态整段渲染 ===");
  for (const adopted of ["折中", "均不采信"] as const) {
    const v: SubmitVerdicts = { ...FIXED_V, verdicts: [{ ...FIXED_V.verdicts[0]!, adopted }, ...FIXED_V.verdicts.slice(1)] };
    const out = renderAggregated(v, FIXED_FINDINGS, FIXED_REPORT, "");
    assert(out.includes(`／ 采信方：${adopted} ／`), `冲突表采信方渲染「${adopted}」`);
  }
  const noNote: SubmitVerdicts = { ...FIXED_V, verdicts: FIXED_V.verdicts.map((x, i) => (i === 1 ? { ...x, note: undefined } : x)) };
  const outNoNote = renderAggregated(noNote, FIXED_FINDINGS, FIXED_REPORT, "");
  assert(outNoNote.includes(" | P1/F2 | 驳回不符事实\n"), `table_handling 有值而 note 缺省 → 第八列纯状态词：\n${outNoNote}`);
  const threeSided: JevCheckReport = {
    ...emptyReport,
    oneSided: [
      { id: "P1/F1", proposerIndex: 1 },
      { id: "P1/F2", proposerIndex: 1 },
      { id: "P2/G2", proposerIndex: 2 },
    ],
  };
  const out3 = renderAggregated(FIXED_V, FIXED_FINDINGS, threeSided, "");
  assert(out3.includes("仅提议 1 提出（P1/F1）：另一方漏报"), "整段渲染：能 → 另一方漏报");
  assert(out3.includes("仅提议 1 提出（P1/F2）：该项不成立"), "整段渲染：不能 → 该项不成立");
  assert(out3.includes("仅提议 2 提出（P2/G2）：材料不足"), "整段渲染：材料不足 → 材料不足");
}

// ---------- 用例 8：波三 b 修复单第 3 条——带 sessionCalls 的快照 ----------
{
  log("=== 用例 8：renderAggregated 第五参数 opts.sessionCalls——只影响第二段第五列 ===");
  const withCalls = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "", { sessionCalls: 7 });
  const noCalls = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "");
  assert(withCalls.includes("亲验（自报）｜会话取证 7 次"), `sessionCalls=7 时第五列拼接「｜会话取证 7 次」：\n${withCalls}`);
  assert(withCalls.includes("推理（自报）｜会话取证 7 次"), "每一行（亲验/推理）都拼接同一个 sessionCalls 值");
  assert(!noCalls.includes("会话取证"), "不传 opts 时第五列维持原样，不出现「会话取证」字样");
  // 除第五列外，其余内容与不带 sessionCalls 的渲染一致（sessionCalls 只影响这一列）。
  const stripCalls = (s: string): string => s.replace(/｜会话取证 7 次/g, "");
  assert(stripCalls(withCalls) === noCalls, "剥掉「｜会话取证 7 次」后与不带 sessionCalls 的渲染逐字节一致");
  const withZero = renderAggregated(FIXED_V, FIXED_FINDINGS, FIXED_REPORT, "", { sessionCalls: 0 });
  assert(withZero.includes("会话取证 0 次"), "sessionCalls=0（合法边界值）仍拼接「会话取证 0 次」，不因 falsy 被当成缺省跳过");
}

// ---------- 用例 9：波三 b 修复单第 3 条——reason 含『推理（自报）』不被误改写 ----------
{
  log("=== 用例 9：reason 自由文字里恰好出现「推理（自报）」字样，不被 sessionCalls 拼接污染 ===");
  const DECOY_REASON = "本条理由文本里刻意包含「推理（自报）」这几个字，用于验证不会被误拼接";
  const v: SubmitVerdicts = {
    verdicts: [
      verdict({
        finding_ids: ["P1/F1"],
        level: "MAJOR",
        evidence: "a.go:1",
        strength: "推理",
        reason: DECOY_REASON,
      }),
    ],
    final: "一段最终裁决，长度需≥20字符，凑够字数用于满足 schema 约束。",
  };
  const out = renderAggregated(v, [], emptyReport, "", { sessionCalls: 3 });
  assert(out.includes(DECOY_REASON), `reason 原文完整出现、未被改写：\n${out}`);
  assert((out.match(/会话取证/g) ?? []).length === 1, `全文只有一处「会话取证」（第五列），reason 里的诱饵未被误拼上第二处：\n${out}`);
  assert(out.includes(`推理（自报）｜会话取证 3 次 | ${DECOY_REASON}`), "第五列拼接在 strength 后、reason 列原样紧随其后未被改写");
}

// ---------- 用例 10：strengthReported 改写文案 + evidenceRef 附注（设计 v4 §12.2 D / §12.6 第 1、2 点，
// 波四 2026-09-20；改写本身发生在 orchestrate.ts，这里只测渲染消费 strengthReported/evidenceRef 两个新字段）----------
{
  log("=== 用例 10：第五列「推理（自报亲验，取证 0 次）」改写文案 / 第二列 evidenceRef 附注 ===");

  // 被服务端改写过的 verdict：strength 已是 "推理"，strengthReported 保留原自报值 "亲验"。
  const rewritten = verdict({
    finding_ids: ["P1/F1"],
    level: "MAJOR",
    evidence: "internal/x/ratchet.go:5",
    strength: "推理",
    strengthReported: "亲验",
  });
  const outRewritten = renderAggregated({ verdicts: [rewritten], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "", {
    sessionCalls: 0,
  });
  assert(outRewritten.includes("推理（自报亲验，取证 0 次）"), `第五列改写为「推理（自报亲验，取证 0 次）」：\n${outRewritten}`);
  assert(!outRewritten.includes("亲验（自报）"), "改写后不再出现原始「亲验（自报）」措辞");

  // 未改写的 verdict：strengthReported 缺省，第五列维持原样式不变（回归用例 8 已验证过一次，这里再确认
  // 与 strengthReported 分支互不干扰）。
  const notRewritten = verdict({ finding_ids: ["P1/F1"], level: "MAJOR", evidence: "internal/x/ratchet.go:5", strength: "亲验" });
  const outNormal = renderAggregated({ verdicts: [notRewritten], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "", {
    sessionCalls: 5,
  });
  assert(outNormal.includes("亲验（自报）｜会话取证 5 次") && !outNormal.includes("自报亲验"), `未改写维持原格式：\n${outNormal}`);

  // evidenceRef 附注：第二列（evidence）非「相符」时附「（引用：…）」；「相符」或缺省不附，避免噪音。
  const evMismatch = verdict({ finding_ids: ["P1/F1"], level: "MAJOR", evidence: "internal/x/ratchet.go:5", evidenceRef: "未命中" });
  const outMismatch = renderAggregated({ verdicts: [evMismatch], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "");
  assert(outMismatch.includes("internal/x/ratchet.go:5（引用：未命中）"), `evidenceRef≠相符 → 第二列附注：\n${outMismatch}`);

  const evNoIdent = verdict({ finding_ids: ["P1/F1"], level: "MAJOR", evidence: "internal/x/ratchet.go:5", evidenceRef: "无标识符" });
  const outNoIdent = renderAggregated({ verdicts: [evNoIdent], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "");
  assert(outNoIdent.includes("internal/x/ratchet.go:5（引用：无标识符）"), `evidenceRef=无标识符 → 附注：\n${outNoIdent}`);

  const evOk = verdict({ finding_ids: ["P1/F1"], level: "MAJOR", evidence: "internal/x/ratchet.go:5", evidenceRef: "相符" });
  const outOk = renderAggregated({ verdicts: [evOk], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "");
  assert(outOk.includes(" | internal/x/ratchet.go:5 | ") && !outOk.includes("（引用："), `evidenceRef=相符 → 不附注（无噪音）：\n${outOk}`);

  const evAbsent = verdict({ finding_ids: ["P1/F1"], level: "MAJOR", evidence: "internal/x/ratchet.go:5" });
  const outAbsent = renderAggregated({ verdicts: [evAbsent], final: "一段最终裁决，长度需≥20字符，凑够字数。" }, [], emptyReport, "");
  assert(outAbsent.includes(" | internal/x/ratchet.go:5 | ") && !outAbsent.includes("（引用："), "evidenceRef 缺省（未 jevOn 场景）→ 不附注");
}

console.log(`\n[render-verdicts-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
