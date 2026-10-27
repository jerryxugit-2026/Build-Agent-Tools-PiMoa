/**
 * `renderAggregated` —— 从 `submit_verdicts` 已接受的结构化裁决渲染人读三段
 * （Jev 辅助代码审查详细设计 v4 §3.8「只写一遍」，2026-09-20，第三波 a；徐总 09-20 定：aggregator 只提交
 * 一次结构化，人读三段由服务端机械渲染，不再让模型在正文里把同一份内容再写一遍）。
 *
 * 输出与旧版（`orchestrate.ts` `buildAggregatorPrompt` 里定型过的 verify 收尾三段：
 * 「一、【冲突点与采信】表 / 二、【逐条裁决】/ 三、【最终裁决】」）同形，供 `aggregated` 字段、
 * spool `## aggregated`、`bodySha256`（对渲染后的文本计算，见设计 §3.8 末行）与所有现有消费方直接使用。
 *
 * ## 与设计原文的一处已知不一致（据实施任务书要求登记，未自作主张变通）
 * §3.8 第一段"单边项"一句原文是「表态由服务端推出（能且值得修 → 另一方漏报；不能 → 该项不成立；
 * 材料不足 → 材料不足）」，其中「且值得修」引用的是已被徐总 09-20「优化 5」删除的 worth_fixing 字段
 * （§0 优化 5：「aggregator 不判值不值得修」）；`VerdictSchema`（types.ts）也确实没有该字段。
 * §0 优化 3 行给出的权威映射是「能 → 另一方漏报；不能 → 该项不成立；材料不足 → 材料不足」（无
 * 「且值得修」限定），本实现按 §0 权威口径取「能」而非「能且值得修」。
 *
 * ## 波三 b 修复单第 3 条：会话取证次数改为渲染入参
 * 第二段八列「证据强度（自报）+ 会话取证次数」此前只渲染 `strength`（自报），取证次数由
 * orchestrate.ts 对渲染结果做一次全局正则替换 `/(亲验|推理)（自报）/g` 拼接——该正则不区分
 * 「第五列的 strength」与「第六列 reason 自由文字里恰好出现同款字样」，会把 reason 里的
 * 「…推理（自报）…」误拼上「｜会话取证 N 次」。改为显式入参：`renderAggregated` 新增
 * `opts?: { sessionCalls?: number }`，只在渲染第五列时拼接，reason 等其它列不受影响。
 */
import type { FindingRecord, JevCheckReport, SubmitVerdicts, Verdict } from "./types.js";
// 单一真源（第三波 b，任务书第 4 点）：FindingRecord 已挪到 types.ts，此处 re-export 保外部导入兼容
// （test/render_verdicts.test.ts 仍从 "../src/moa/render_verdicts.js" 导入 FindingRecord）。
export type { FindingRecord };

/** 分歧点 claim 的截断长度（设计 v4 §3.8：「各 finding 的 claim 截 60 字」）。 */
const MAX_CLAIM_CHARS = 60;
/** 提交成功后模型可再补的自由说明上限（设计 v4 §3.8 / §5.3：「≤300 字」）。 */
const MAX_FREE_TEXT_CHARS = 300;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function findingByPid(findings: readonly FindingRecord[], pid: string): FindingRecord | undefined {
  return findings.find((f) => f.pid === pid);
}

/** can_happen → 单边项表态（设计 v4 §0 优化 3 权威口径；见本文件头注「已知不一致 1」）。 */
export function oneSidedVerdictText(canHappen: Verdict["can_happen"]): string {
  if (canHappen === "能") return "另一方漏报";
  if (canHappen === "不能") return "该项不成立";
  return "材料不足";
}

/** 一、【冲突点与采信】：冲突对逐行 + 单边项逐行；都没有则「无分歧」。 */
function renderConflictsAndOneSided(v: SubmitVerdicts, findings: readonly FindingRecord[], report: JevCheckReport | null): string {
  const lines: string[] = [];
  for (const c of report?.conflicts ?? []) {
    const vd = v.verdicts.find((x) => x.finding_ids.includes(c.a) && x.finding_ids.includes(c.b));
    const fa = findingByPid(findings, c.a);
    const fb = findingByPid(findings, c.b);
    const claimA = fa ? truncate(fa.claim ?? "", MAX_CLAIM_CHARS) : "（未结构化）";
    const claimB = fb ? truncate(fb.claim ?? "", MAX_CLAIM_CHARS) : "（未结构化）";
    const sideA = `${c.a} ${fa?.level ?? "?"}`;
    const sideB = `${c.b} ${fb?.level ?? "?"}`;
    const adopted = vd?.adopted ?? "（未裁决覆盖）";
    const reason = vd?.reason ?? "";
    lines.push(`分歧点：${claimA} ｜ ${claimB} ／ 各方主张：${sideA} vs ${sideB} ／ 采信方：${adopted} ／ 理由：${reason}`);
  }
  for (const os of report?.oneSided ?? []) {
    const vd = v.verdicts.find((x) => x.finding_ids.includes(os.id));
    const text = vd ? oneSidedVerdictText(vd.can_happen) : "（未裁决覆盖）";
    lines.push(`仅提议 ${os.proposerIndex} 提出（${os.id}）：${text}`);
  }
  return lines.length > 0 ? lines.join("\n") : "无分歧";
}

/**
 * 二、【逐条裁决】单条八列（「驳回」级也照常渲染，不特殊过滤）。
 * `sessionCalls`（波三 b 修复单第 3 条）：给定时第五列在 `${strength}（自报）` 后拼接
 * `｜会话取证 N 次`；缺省（undefined）时维持原第五列内文不变——只影响这一列，`reason`
 * 等其它列原样透传，不做任何字符串改写。
 */
/** evidence 列附注（第二列；§12.2 D / §12.6 第 2 点，波四）：evidenceRef 非「相符」时才附，
 * 「相符」不加噪音。 */
function evidenceCol(vd: Verdict): string {
  if (!vd.evidenceRef || vd.evidenceRef === "相符") return vd.evidence;
  return `${vd.evidence}（引用：${vd.evidenceRef}）`;
}

function renderVerdictRow(vd: Verdict, sessionCalls?: number): string {
  const consequenceAndTrigger = `${vd.consequence} / ${vd.trigger}${vd.escalate ? "｜交人工" : ""}`;
  let anomaly = "无";
  if (vd.table_handling) {
    anomaly = vd.note ? `${vd.table_handling}（${vd.note}）` : vd.table_handling;
  }
  if (vd.conditions && vd.conditions.length > 0) {
    const condText = vd.conditions.map((c) => `${c.c} ${c.verdict}${c.line ? `@${c.line}` : ""}`).join("；");
    anomaly = anomaly === "无" ? `条件：${condText}` : `${anomaly}；条件：${condText}`;
  }
  // §12.2 D / §12.6 第 1、2 点：strength 被服务端机械改写（orchestrate.ts，取证 0 次时「亲验」→「推理」）
  // 时第五列改写为「推理（自报亲验，取证 N 次）」，压过模型自报；未改写时维持原「strength（自报）｜
  // 会话取证 N 次」格式不变。
  const strengthCol = vd.strengthReported
    ? `推理（自报${vd.strengthReported}，取证 ${sessionCalls ?? 0} 次${(sessionCalls ?? 0) > 0 ? "、未读 evidence 所在文件" : ""}）`
    : `${vd.strength}（自报）${sessionCalls !== undefined ? `｜会话取证 ${sessionCalls} 次` : ""}`;
  return [
    vd.level,
    evidenceCol(vd),
    `能否发生：${vd.can_happen}`,
    consequenceAndTrigger,
    strengthCol,
    vd.reason,
    vd.finding_ids.join("+"),
    anomaly,
  ].join(" | ");
}

/** 三、【最终裁决】：final 原文 + 可选「补充说明」（≤300 字，截断）。 */
function renderFinal(v: SubmitVerdicts, freeText: string): string {
  const trimmed = (freeText ?? "").trim();
  return trimmed.length > 0 ? `${v.final}\n补充说明：${truncate(trimmed, MAX_FREE_TEXT_CHARS)}` : v.final;
}

/**
 * 从已接受的结构化裁决渲染三段人读文本（设计 v4 §3.8）。纯函数，供 orchestrate.ts（第三波 b）在
 * `submit_verdicts` 被接受后调用一次，产出 `aggregated` 字段；也供本文件的单测直接跑固定输入验证。
 * `opts.sessionCalls`（波三 b 修复单第 3 条）：给定时透传给每一行【逐条裁决】的第五列（会话取证
 * 次数是**聚合器会话级**账，对本轮全部 verdict 行成立，故只需一个数）；缺省则第五列不带该后缀。
 */
export function renderAggregated(
  v: SubmitVerdicts,
  findings: readonly FindingRecord[],
  report: JevCheckReport | null,
  freeText: string,
  opts?: { sessionCalls?: number },
): string {
  const parts: string[] = [];
  parts.push("一、【冲突点与采信】");
  parts.push(renderConflictsAndOneSided(v, findings, report));
  parts.push("");
  parts.push("二、【逐条裁决】");
  parts.push(v.verdicts.length > 0 ? v.verdicts.map((vd) => renderVerdictRow(vd, opts?.sessionCalls)).join("\n") : "（无裁决）");
  parts.push("");
  parts.push("三、【最终裁决】");
  parts.push(renderFinal(v, freeText));
  return parts.join("\n");
}
