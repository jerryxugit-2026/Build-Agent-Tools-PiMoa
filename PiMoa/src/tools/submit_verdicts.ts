/**
 * `submit_verdicts` —— verify 模式 aggregator 的结构化提交工具
 * （Jev 辅助代码审查详细设计 v4 §2 / §3.6，2026-09-20，第三波 a）。
 *
 * ## 做什么
 * aggregator 综合全部 proposer 正文与核对表后，调用 `submit_verdicts` 一次性提交结构化裁决
 * （枚举优先、缺省不写、无异常不表态——设计 v4 §0 优化 1-4；不判「值不值得修」——优化 5）。
 * 服务端**机械核验**（不合格 REJECT，最多 `limits.maxAttempts` 次，同 submit_findings 的节奏）：
 *   · `finding_ids` 的每个 id 必须 ⊆ `knownIds`（本轮已接受的结构化 finding pid），**或**形如
 *     `P{i}/U{n}`（`i` ∈ `unstructured`：软档下没交合格清单的 proposer，aggregator 从其自由正文
 *     自行编号引用）——未结构化一方的发现不因缺 id 而在裁决里消失；
 *   · 每个 `knownId` 恰好被一条 verdict 覆盖（漏 / 重复各自列出）；
 *   · `report` 里每对「结论相反」（含 counter 配对）必须被**同一条** verdict 覆盖（该条 `finding_ids`
 *     同时含 a 与 b）且该条 `adopted` 非空；
 *   · 核对表状态为「含不符前提」**或**引用状态非 `OK` 的 finding（`ref ∈ {原文不符,行号越界,文件未附}`），
 *     其覆盖它的 verdict 必须有 `table_handling`；状态正常时写了不报错（渲染时忽略）；
 *   · `conditionFlag=true` 的 finding，其覆盖它的 verdict 必须给 `conditions` 且条数等于该 finding
 *     facts 里 `kind==="condition"` 的条数（「运行时条件数」）；
 *   · `evidence`（`路径:行号` 或 `路径:起-止`）的路径必须能在 materials 里解析到。
 * 合格 → 写进 `VerdictsState.accepted`（服务端补缺省 `escalate=false`），供 runSession 折成
 * `SessionRunResult.structured`；人读三段由 `render_verdicts.ts` 从这份结构化提交渲染（设计 §3.8，
 * 「只写一遍」，徐总 09-20 定），不再要求模型在正文里重复写逐条裁决与冲突表。
 *
 * ## 与设计原文签名的偏差（据实施任务书「按设计选一种并说明」，已选定并在此登记）
 * 设计 v4 §3.6 给出的工厂签名是 `createSubmitVerdictsTool(state, knownIds, unstructured, report,
 * limits)`，**不含 materials**；但校验规则最后一条明文要求「`evidence` 的路径必须能在 materials 里
 * 解析到」——`JevCheckReport` 本身不携带完整的材料路径清单（`FactCheck.slice` 只是逐条事实的定位切片，
 * 不是「本轮全部附入路径」的索引），无法仅凭 `report` 做路径解析。故本实现在 `report` 之后追加
 * `materials: MaterialMap, cwd: string, readRoots: readonly string[]` 三个参数，复用 `submit_findings.ts`
 * 已导出的 `resolveMaterial`（与 proposer 侧路径解析同一套算法，行为一致）。orchestrate.ts（第三波 b）
 * 组装该工具时，`materials` 直接传 `req.materials`——与 proposer 阶段 `createSubmitFindingsTool` 拿到的
 * 是同一份对象，aggregator 能核对的路径集合与 proposer 完全一致，语义无损。
 *
 * ## 为什么不破坏「子 agent 不生成孙 agent」不变量
 * 只写**会话内存状态**（闭包持有的 `VerdictsState`）：不读盘、不出网、不 spawn、不设 `addedToolNames`。
 * 路径解析复用的 `resolveMaterial` 是纯函数（只查 `materials` 这个内存 Map），不新增任何读面。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { identifierTokens, RAW_JSON_ARGS_NOTE, resolveMaterial, resolveMaterialDetailed } from "./submit_findings.js";
import { SubmitVerdictsParams, type FindingCheck, type JevCheckReport, type MaterialMap, type Verdict, type VerdictsState } from "../moa/types.js";

/** 工具定义类型（pi customTools 的元素类型）。 */
export type ToolDef = ToolDefinition;

export type SubmitVerdictsInput = Static<typeof SubmitVerdictsParams>;

// ---- 规则常量 ----

/** 提交次数上限（缺省 3 次，与 submit_findings 同档；实际值由 limits.maxAttempts 传入）。 */
const DEFAULT_MAX_ATTEMPTS = 3;
/** 一次 REJECT 最多回贴的条数。 */
const MAX_REJECT_ITEMS = 15;
/** 退役后的 table_handling 唯一闭集；处理器兜底拒绝绕过工具 schema 的旧值。 */
const PLAIN_TABLE_HANDLING = new Set(["采信不符事实", "驳回不符事实", "已读真实位置", "材料不足"]);

// ---- 纯函数（可单测）----

/** `路径:行号` 或 `路径:起-止`（schema 已校验格式）拆成 { path, a, b }。贪婪匹配最后一个 `:数字`，
 * 与 recon.ts `parseRgHits` 贪婪路径切分同一原则（POSIX 路径可含冒号）。 */
export function parseEvidence(evidence: string): { path: string; a: number; b: number } | null {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(evidence);
  if (!m) return null;
  const a = Number(m[2]);
  const b = m[3] === undefined ? a : Number(m[3]);
  return { path: m[1] as string, a, b };
}

/** 该 finding 核对表状态是否「有异常」（设计 v4 §3.6：含不符前提 或 引用状态非 OK）。
 * report 为 null（jevcheck 关闭）或该 id 不在 perFinding 里（如未结构化引用）→ 视为无异常。 */
export function isAnomalous(check: FindingCheck | undefined): boolean {
  if (!check) return false;
  return check.status === "含不符前提" || check.ref !== "OK";
}

/**
 * 该 finding「运行时条件」的条数（=「该 finding 的运行时条件数」，供 conditions 条数比对）。
 *
 * ★PIMOA-DEF-05（2026-09-20）：本函数必须与 `conditionFlag` 的判定集合**完全同源**。
 *   `conditionFlag` 由 `src/moa/jevcheck.ts` 的 `computeConditionFlag([...fc.facts, ...fc.amended.added])`
 *   在补前提阶段之后重算（jevcheck.ts:1639），补前提新增的 condition 类事实会把它翻成 true；
 *   而此前本函数只数 `check.facts`（`fc.facts` 只在构造 `FindingCheck` 时一次性赋值
 *   ——jevcheck.ts:961 的 `facts: factsCheck` / :984 的 `facts,`——补前提阶段**不回写**它，
 *   结果只落在 `fc.amended.added`）
 *   ⇒ flag=true 但计数恒为 0，模型被要求给 conditions 且**条数须等于 0**，而核对表的「成立条件：」
 *   行（jevcheck.ts fullBlock）同样只取 facts、一条也不列——这是从可见信息无法推出的要求，换任何
 *   模型都会被拒 3 次（2026-09-20 实测轮 moa#e1c484fa 报错逐字：
 *   「第 5 条裁决：P2/F3 为条件红旗，须给 conditions（该 finding 运行时条件数 0）」）。
 *   修法：三处（conditionFlag / 本计数 / 表格渲染）统一到 `facts + amended.added` 同一集合。
 */
export function conditionFactCount(check: FindingCheck | undefined): number {
  if (!check) return 0;
  return [...(check.facts ?? []), ...(check.amended?.added ?? [])].filter((f) => f.kind === "condition").length;
}

/** evidence 行号核验的 ±2 容差（与 proposer 侧 checkFactRef / anchorHit 同口径，§12.2 D）。 */
const EVIDENCE_LINE_TOLERANCE = 2;

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-09）：evidence 尾部兜底多候选时的消歧依据。
 * 病理——verdict 自身不带 finding.path，orchestrate.ts 又不在本次写集，无法新增入参；
 * 修法——`report` 本就由 orchestrate 传入，其 perFinding[id] 的 facts / amended.added 上 jevcheck 已写好
 *   `slice.abs`（事实实际落定的文件 abs）⇒ 取本条裁决覆盖的 finding 的全部 slice.abs 作 preferredPath；
 * 边界——report 为 null（jevcheck 关闭）或无 slice ⇒ 空数组 ⇒ 多候选照旧判 ambiguous（拒并列候选），不猜。
 */
export function preferredPathsFor(ids: readonly string[], report: JevCheckReport | null): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const check = report?.perFinding[id];
    if (!check) continue;
    for (const f of [...(check.facts ?? []), ...(check.amended?.added ?? [])]) {
      if (f.slice?.abs) out.add(f.slice.abs);
    }
  }
  return [...out];
}

/** DEF-09 修 3：拒因句末「（可用：…）」最多列几条（超出写「等」）。 */
const EVIDENCE_PATH_HINT_MAX = 6;

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-09 修 3）：路径解析不到时，把可用路径形态回贴给模型。
 * 病理——拒因只说「解析不到」，模型不知道能写什么，只能自造更短的形态逐次试错（REPRO-20PCT 3-5 连拒）；
 * 修法——前半句原样不动，只在句末追加「（可用：…）」：ambiguous 列候选、miss 列全部材料，每个文件给 rel 的
 *   空白 percent 编码形态（evidence schema 禁空白，types.ts:124 不放宽；该形态经 resolveMaterial 的解码变体可解回）；
 * 边界——最多 EVIDENCE_PATH_HINT_MAX 条，超出写「等」；材料表为空时返回空串（不追加括号）。
 */
function evidencePathHint(files: readonly (readonly { rel: string }[])[]): string {
  const forms: string[] = [];
  for (const segs of files) {
    const rel = segs[0]?.rel;
    if (rel === undefined) continue;
    const form = rel.replace(/\s/g, (c) => encodeURIComponent(c));
    if (!forms.includes(form)) forms.push(form);
  }
  if (forms.length === 0) return "";
  const shown = forms.slice(0, EVIDENCE_PATH_HINT_MAX).join("、");
  return `（可用：${shown}${forms.length > EVIDENCE_PATH_HINT_MAX ? "等" : ""}）`;
}

/**
 * aggregator 同一套机械核验（设计 v4 §12.2 D / §12.6 第 2 点，波四 2026-09-20）：`reason` 里的标识符
 * token 对 `evidence` 行 ±2 核验——相符（token 在 evidence 行±2 原样出现）/ 未命中（有 token 但都不在）/
 * 无标识符（reason 抽不出可核 token，或 evidence 本身解析不到）。**登记不 REJECT**。
 */
export function computeEvidenceRef(
  reason: string,
  evidence: string,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  preferredPath?: string | readonly string[],
): "相符" | "未命中" | "无标识符" {
  const tokens = identifierTokens(reason);
  if (tokens.length === 0) return "无标识符";
  const ev = parseEvidence(evidence);
  if (!ev) return "无标识符";
  // ★DEF-09：preferredPath 透传（与 validateVerdicts 同一消歧口径，否则 ACCEPT 的 evidence 在这里算成「未命中」）。
  const segs = resolveMaterial(ev.path, materials, cwd, readRoots, preferredPath);
  if (!segs) return "未命中";
  const lo = ev.a - EVIDENCE_LINE_TOLERANCE;
  const hi = ev.b + EVIDENCE_LINE_TOLERANCE;
  for (const seg of segs) {
    const from = Math.max(seg.start, lo);
    const to = Math.min(seg.end, hi);
    for (let line = from; line <= to; line++) {
      const raw = seg.lines[line - seg.start];
      if (raw !== undefined && tokens.some((t) => raw.includes(t))) return "相符";
    }
  }
  return "未命中";
}

/**
 * 全部校验（设计 v4 §3.6 表；REJECT 不合格，返回全部原因，空数组=合格）。
 * `knownIds` = 本轮已接受的结构化 finding pid 全集；`unstructured` = 软档下未交合格清单的 proposer 下标
 * （P{i}/U{n} 里的 i 的合法域）；`report` 为 null 表示 jevcheck 未跑（跳过核对表相关三条规则）。
 */
export function validateVerdicts(
  params: SubmitVerdictsInput,
  knownIds: readonly string[],
  unstructured: readonly number[],
  report: JevCheckReport | null,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
): string[] {
  const errs: string[] = [];
  const knownSet = new Set(knownIds);
  const unstructuredSet = new Set(unstructured);
  /** knownId → 覆盖它的 verdict 序号列表（1 起，供漏/重复判定）。 */
  const coverage = new Map<string, number[]>();

  /** 未知 id 报错的尾部指引：本轮没有未结构化提议（unstructured 为空）时，P{i}/U{n} 是非法形态，
   * 不再宣传它（2026-09-23 事故 moa#8f9ee5df 根因①：文案在 unstructured 为空时仍宣传非法 U 形态、
   * 且不给正确 id 格式，模型被误导改用 P1/U1 又被拒），改给正确 id 格式（斜杠必写）。 */
  const unknownIdHint =
    unstructuredSet.size === 0
      ? "本轮 finding_ids 只能取本轮已接受 finding（形如 P1/F1，斜杠必写）"
      : "须 ⊆ 本轮已接受 finding，或形如 P{提议序号}/U{编号}";

  // ---- 同类错误分组回贴（2026-09-23 反馈质量修复）----
  /** 「引用了未知 finding_id」：{ n=裁决序号, id }。 */
  const unknownIdHits: Array<{ n: number; id: string }> = [];
  /** 「finding_id 引用的提议 N 并非未结构化」：{ n, id, proposerIndex }。 */
  const nonUnstructuredHits: Array<{ n: number; id: string; proposerIndex: number }> = [];
  /** table_handling 不在普通四值内：{ n, value }。 */
  const plainMisuseHits: Array<{ n: number; value: string }> = [];

  params.verdicts.forEach((vd, i) => {
    const n = i + 1;
    const uniqueIds = [...new Set(vd.finding_ids)];

    for (const id of uniqueIds) {
      if (knownSet.has(id)) {
        const list = coverage.get(id) ?? [];
        list.push(n);
        coverage.set(id, list);
        continue;
      }
      const m = /^P(\d+)\/U(\d+)$/.exec(id);
      if (m) {
        const proposerIndex = Number(m[1]);
        if (!unstructuredSet.has(proposerIndex)) {
          nonUnstructuredHits.push({ n, id, proposerIndex });
        }
        continue; // 未结构化引用不进 knownId 覆盖统计
      }
      unknownIdHits.push({ n, id });
    }

    // table_handling：本条覆盖的 knownId 里只要有一个「有异常」，本条就必须给 table_handling。
    const anomalousIds = uniqueIds.filter((id) => knownSet.has(id) && isAnomalous(report?.perFinding[id]));
    if (anomalousIds.length > 0 && vd.table_handling === undefined) {
      errs.push(`第 ${n} 条裁决覆盖 ${anomalousIds.join("、")}：核对表标了异常（含不符前提 / 引用非 OK），须填 table_handling`);
    }
    if (vd.table_handling !== undefined && !PLAIN_TABLE_HANDLING.has(vd.table_handling)) {
      plainMisuseHits.push({ n, value: vd.table_handling });
    }

    // conditions：本条覆盖的每个 conditionFlag=true 的 knownId，条数须等于其运行时条件数。
    for (const id of uniqueIds) {
      if (!knownSet.has(id)) continue;
      const check = report?.perFinding[id];
      if (!check?.conditionFlag) continue;
      const need = conditionFactCount(check);
      if (vd.conditions === undefined) {
        errs.push(`第 ${n} 条裁决：${id} 为条件红旗，须给 conditions（该 finding 运行时条件数 ${need}）`);
      } else if (vd.conditions.length !== need) {
        errs.push(`第 ${n} 条裁决：${id} 为条件红旗，conditions 条数须等于运行时条件数 ${need}，实给 ${vd.conditions.length}`);
      }
    }

    // evidence：路径须能在 materials 里解析到，且行号须落在该文件某一附入段内（§12.2 D，波四；
    // 此前只校路径、不校行号——proposer 侧同类越界已 REJECT，aggregator 一路补齐同口径）。
    const ev = parseEvidence(vd.evidence);
    if (!ev) {
      errs.push(`第 ${n} 条裁决：evidence「${vd.evidence}」的路径解析不到本轮附入材料`);
    } else {
      // ★DEF-09：尾部兜底多候选时按本条覆盖 finding 的 report slice 消歧；解析不到时句末追加可用形态。
      const r = resolveMaterialDetailed(ev.path, materials, cwd, readRoots, preferredPathsFor(uniqueIds, report));
      const segs = r.kind === "hit" ? r.segs : null;
      if (!segs) {
        const hint = evidencePathHint(r.kind === "ambiguous" ? r.candidates : [...materials.values()]);
        errs.push(`第 ${n} 条裁决：evidence「${vd.evidence}」的路径解析不到本轮附入材料${hint}`);
      } else if (!segs.some((s) => s.start <= ev.a && ev.b <= s.end)) {
        const ranges = segs.map((s) => `${s.start}-${s.end}`).join("、");
        errs.push(`第 ${n} 条裁决：evidence「${vd.evidence}」的行号不在附入区间内（可用：${ranges}）`);
      }
    }
  });

  // 每个 knownId 恰好被一条 verdict 覆盖。
  const missing = knownIds.filter((id) => !coverage.has(id));
  if (missing.length > 0) errs.push(`以下 finding 未被任何裁决覆盖：${missing.join("、")}`);
  const dup = [...coverage.entries()].filter(([, ns]) => ns.length > 1);
  if (dup.length > 0) {
    errs.push(`以下 finding 被多条裁决重复覆盖：${dup.map(([id, ns]) => `${id}（第 ${ns.join("、")} 条）`).join("；")}`);
  }

  // report 里每对「结论相反」（含 counter 配对）须被同一条 verdict 覆盖，且该条 adopted 非空。
  for (const c of report?.conflicts ?? []) {
    const vd = params.verdicts.find((v) => v.finding_ids.includes(c.a) && v.finding_ids.includes(c.b));
    if (!vd) {
      errs.push(`冲突对 ${c.a}/${c.b}（结论相反）未被同一条裁决覆盖`);
    } else if (vd.adopted === undefined) {
      errs.push(`冲突对 ${c.a}/${c.b} 所在裁决缺 adopted（须写采信方）`);
    }
  }

  // ---- 三类同源错误统一展开（收集见函数开头数组；签名仍为 string[]）----
  // 单条给出裁决序号；多条折叠并附计数，避免大量同类拒因冲掉其它错误。
  // 未知 finding_id（1a 配套：unstructured 为空时不宣传非法 U 形态、给正确 id 格式）。
  if (unknownIdHits.length === 1) {
    const h = unknownIdHits[0]!;
    errs.push(`第 ${h.n} 条裁决：引用了未知 finding_id「${h.id}」；${unknownIdHint}`);
  } else if (unknownIdHits.length > 1) {
    const ids = unknownIdHits.map((h) => `「${h.id}」`).join("");
    const ns = [...new Set(unknownIdHits.map((h) => h.n))].sort((a, b) => a - b).join("、");
    errs.push(`引用了未知 finding_id${ids}（共 ${unknownIdHits.length} 处，涉裁决 ${ns}）；${unknownIdHint}`);
  }
  // 引用的提议 N 并非未结构化。
  if (nonUnstructuredHits.length === 1) {
    const h = nonUnstructuredHits[0]!;
    errs.push(`第 ${h.n} 条裁决：finding_id「${h.id}」引用的提议 ${h.proposerIndex} 并非未结构化（软档下未交合格清单的提议）`);
  } else if (nonUnstructuredHits.length > 1) {
    const ids = nonUnstructuredHits.map((h) => `「${h.id}」`).join("");
    const ps = [...new Set(nonUnstructuredHits.map((h) => h.proposerIndex))].sort((a, b) => a - b).join("、");
    const ns = [...new Set(nonUnstructuredHits.map((h) => h.n))].sort((a, b) => a - b).join("、");
    errs.push(`finding_id${ids}引用的提议 ${ps} 并非未结构化（软档下未交合格清单的提议）（共 ${nonUnstructuredHits.length} 处，涉裁决 ${ns}）`);
  }
  if (plainMisuseHits.length === 1) {
    const h = plainMisuseHits[0]!;
    errs.push(`第 ${h.n} 条裁决：table_handling「${h.value}」已退役或非法，只许 采信不符事实/驳回不符事实/已读真实位置/材料不足`);
  } else if (plainMisuseHits.length > 1) {
    const items = plainMisuseHits.map((h) => `第 ${h.n} 条「${h.value}」`).join("、");
    const ns = [...new Set(plainMisuseHits.map((h) => h.n))].sort((a, b) => a - b).join("、");
    errs.push(`table_handling 只许 采信不符事实/驳回不符事实/已读真实位置/材料不足（共 ${plainMisuseHits.length} 处，涉裁决 ${ns}；实给：${items}）`);
  }

  return errs;
}

// ---- 工具工厂 ----

function textResult(text: string, details: Record<string, unknown>, isError: boolean) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

/**
 * `createSubmitVerdictsTool` 工厂：每次 `callAggregator`（主备各一份，设计 v4 §3.4 第 4 点）新建一份
 * `VerdictsState`（闭包持有）。`limits.maxAttempts` = 提交次数上限；`limits.required` = 硬门
 * （达到上限时文案「按聚合失败处理」，触发备胎；缺省软档「按自由文本处理」，`aggregated` 退回模型自由文本，
 * 见 render_verdicts.ts 头注）。
 */
export function createSubmitVerdictsTool(
  state: VerdictsState,
  knownIds: readonly string[],
  unstructured: readonly number[],
  report: JevCheckReport | null,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  limits: { maxAttempts: number; required?: boolean; enforceChain?: boolean },
): ToolDef {
  const max = Math.max(1, Math.floor(limits.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  // 1a（2026-09-23 事故 moa#8f9ee5df 根因①）：U 形态提示条件化——本轮 unstructured 为空时
  // P{i}/U{n} 是非法形态，description 不再宣传它（否则模型照抄 P1/U1 必被拒）；非空保留原句。
  const uHint = unstructured.length === 0 ? "" : "，或未结构化提议的 P{提议序号}/U{编号}";
  return defineTool({
    name: "submit_verdicts",
    label: "Submit verdicts (structured)",
    description:
      "提交本次综合裁决的结构化清单（verify 模式必须调用，只调用一次；人读三段由系统从提交内容机械渲染，" +
      `不要在正文里重复写逐条裁决与冲突表）。每条 verdict：finding_ids（同题合并写多个，最多 8 个${uHint}）、` +
      "level、can_happen（能/不能/材料不足）、consequence（后果类别）、" +
      "trigger（触发档）、strength（亲验/推理）、reason（10–150 字）、evidence（路径:行号，路径不含空白字符、≤200 字）；只在需要时写 " +
      "escalate、adopted（覆盖核对表一对「结论相反」时必填，取值 P1/P2/P3/折中/均不采信）、table_handling（覆盖的 finding 合成状态含" +
      "「不符前提」或出现「引用：」行时必填；只许 采信不符事实/驳回不符事实/已读真实位置/材料不足）、conditions（该 finding 块印「须填：conditions ×N」时必填，" +
      "条数须等于该 finding 的运行时条件数；每项是 {c, verdict, line?} 对象，verdict 取 可发生/被排除/材料不足，行号写在 line）。" +
      "final：一段最终裁决（20–1500 字）。" +
      `不合格会被拒绝并逐条告知原因，按原因修改后再提交，最多 ${max} 次。` +
      RAW_JSON_ARGS_NOTE,
    promptSnippet:
      "submit_verdicts: 提交结构化裁决（finding 覆盖/冲突对 adopted/异常 table_handling/条件红旗 conditions 机械核验；最多重提 " +
      max +
      " 次）",
    parameters: SubmitVerdictsParams,
    execute: async (_toolCallId: string, params: SubmitVerdictsInput) => {
      state.attempts += 1;
      const n = state.attempts;
      if (n > max) {
        const text = `REJECT（第 ${n}/${max} 次）：\n- 已超过提交次数上限 ${max}，本次不再受理`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts: n, overLimit: true }, true);
      }

      const errs = validateVerdicts(params, knownIds, unstructured, report, materials, cwd, readRoots);
      if (errs.length > 0) {
        const shown = errs.slice(0, MAX_REJECT_ITEMS);
        let text = `REJECT（第 ${n}/${max} 次）：\n- ${shown.join("\n- ")}`;
        if (errs.length > shown.length) text += `\n（另有 ${errs.length - shown.length} 条未列出）`;
        if (n >= max) text += `\n已达上限，本次裁决将按${limits.required ? "聚合失败" : "自由文本"}处理`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts: n, errors: errs.length }, true);
      }

      // 服务端补缺省：escalate 缺省 false（设计 v4 §3.6 末行）；evidenceRef 登记不 REJECT（§12.2 D）。
      const corrected: Verdict[] = params.verdicts.map((v) => ({
        ...v,
        escalate: v.escalate ?? false,
        evidenceRef: computeEvidenceRef(v.reason, v.evidence, materials, cwd, readRoots, preferredPathsFor(v.finding_ids, report)),
      }));
      state.accepted = { verdicts: corrected, final: params.final };

      const summary = corrected.map((v) => `${v.finding_ids.join("+")} ${v.level}`).join("；");
      const text = corrected.length === 0 ? "已接受 0 条裁决" : `已接受 ${corrected.length} 条裁决：${summary}`;
      return textResult(text, { accepted: true, attempts: n, count: corrected.length }, false);
      // ★绝不设 addedToolNames（防孙 agent 不变量）。
    },
  });
}
