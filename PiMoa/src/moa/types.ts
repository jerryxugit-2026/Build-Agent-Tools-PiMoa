// Pi-MoA 共享契约 · 编排 I/O 类型（由主 agent 钉死，Coder B 实现 runMoa）
// 对应 DESIGN §4/§4.6。改动此文件须经主 agent。

import { Type, type Static } from "typebox";
import type { Mode, MoaConfig, WorkerRef } from "../config/types.js";
import type { BudgetExhaustedBy } from "../tools/budget.js";
// 仅类型引用（typebox Static 派生），与 submit_findings.ts 的反向 type import 互不产生运行时环。
import type { Finding, FactRef, FactRefStatus } from "../tools/submit_findings.js";

// ---- 材料（Jev 辅助代码审查详细设计 v4 §2 / §3.1，2026-09-20）----
// recon 每附入一段材料就登记一条 MaterialFile（裸行，不带行号前缀），供 submit_findings 机械核验
// 引用/quote/行号、供 jevcheck 按事实自引位置切片。context 文本本身一字不改，这是并行的结构化副本。

export type MaterialKind = "file" | "range" | "deps" | "refs" | "rg";

export interface MaterialFile {
	/** 绝对路径（唯一 key）。 */
	abs: string;
	/** 相对 cwd 的显示名；跨仓（不在 cwd 之下）时等于 abs。 */
	rel: string;
	kind: MaterialKind;
	/** 裸行（不带行号前缀），下标 0 = 第 start 行。 */
	lines: string[];
	/** 1 起。 */
	start: number;
	/** 含。 */
	end: number;
}

/** abs → 已附入的若干区间（同 abs 多段按 start 升序）。 */
export type MaterialMap = Map<string, MaterialFile[]>;

/** 写进 SessionRunResult.structured / ProposalResult.structured 的结构化提交摘要。 */
export interface StructuredSummary {
	accepted: boolean;
	count: number;
	attempts: number;
	lastReject?: string;
	/**
	 * 波三 b 修复单第 1 条：本轮是否要求该提交被接受（verify + `cfg.jevcheck.submit.required`
	 * 硬门）。orchestrate.ts 在每个 proposer 的会话结果落地时（`Promise.all` 里逐个 `.then`，
	 * 早于任何 `isProposalOk` 调用）按**本轮局部** `requireStructured` 常量写入，取代此前的
	 * 模块级可变状态 `REQUIRE_STRUCTURED`——同进程并发多路 `runMoa` 不再互相踩踏判定。
	 */
	required?: boolean;
	/** 结构化提交工具在 typebox schema 层被拒的次数（不进处理器、不计 attempts）；灰度可观测。 */
	schemaRejects?: number;
	/** schema 层拒绝文案样本（最多 3 条，各截 200 字）。 */
	schemaRejectSamples?: string[];
}

/**
 * proposer 提交经编排层归属后的记录（设计 v4 §2 Receipt.findings 同形）：已接受 Finding 本体 +
 * pid（"P{proposerIndex+1}/{finding.id}"）+ 来源 proposer 下标/模型名。
 * 单一真源（第三波 b 收拢，任务书第 4 点）：`jevcheck.ts` 与 `render_verdicts.ts` 此前各自定义了
 * 同形的 `FindingRecord`，现挪到此处，两文件改为从本文件 re-export，避免同形类型重复定义。
 */
export type FindingRecord = Finding & {
	pid: string;
	proposerIndex: number;
	proposerModel: string;
	/** Only present on a batch-5 automatically routed test-file finding. */
	categoryAutoRouted?: "primary" | "secondary";
	/**
	 * 事实级机械校验结果（§12.2 A / §12.6，波四，2026-09-20）：本 finding 里每条 **code 类**事实的
	 * `checkFactRef` 结果（按 `FactRef.text` 与 `Finding.facts` 原文匹配，非索引对齐——facts 数组
	 * 可能混有 general/condition 类事实，factRefs 只覆盖 code 类）。orchestrate.ts 从
	 * `FindingsState.factRefs`（submit_findings.ts）透传；jevcheck.ts 据此决定是否问 Jev（§12.2 C）。
	 */
	factRefs?: FactRef[];
	/**
	 * 三路互验结果（lines / anchor / facts；徐总 09-20 追加裁定，覆盖任务书原「lines/anchor 可选」条，
	 * 见 §12.6 第 2 点改写版）：orchestrate.ts 从 `FindingsState.refs.get(id).refConsistency` 透传。
	 */
	refConsistency?: "一致" | "不一致" | "仅两路";
};

// ---- aggregator 提交（精简版，徐总 09-20 定：枚举优先、缺省不写、无异常不表态；设计 v4 §2 / 优化 1-4；
// 徐总 09-20 追加裁定「优化 5」：aggregator 不判「值不值得修」，删 worth_fixing/worth_reason，
// 改判 consequence（后果类别）+ trigger（触发档），修不修由主代理与徐总定）----
// schema 在此声明；处理器 submit_verdicts.ts 与渲染 render_verdicts.ts 属第三波。
// 没有独立的 conflicts / one_sided 块：冲突采信写在覆盖该对的 verdict 的 adopted 字段；单边项的表态由服务端从
// can_happen 推出（能 → 另一方漏报；不能 → 该项不成立；材料不足 → 材料不足）。

/**
 * ★PIMOA-DEF-05 复审（2026-09-20）：conditions 的条数上限**必须 ≥ 并集最大可能条数**，
 * 否则「模型照核对表填写」在 need ∈ [上限+1, 12] 时不可满足（typebox 在进处理器前先拒，
 * 等长校验永远看不到）。并集 = proposer facts 的 condition 条数 + 补前提新增的 condition 条数：
 *   · proposer facts 有效上限 8 —— src/tools/submit_findings.ts 的 FINDING_LIMITS.factsMax
 *     （schema 层写 20，但校验器 submit_findings.ts:623-624 强制 ≤8，故有效值 8）；
 *   · 补前提单次新增上限 4 —— src/tools/submit_findings.ts:69 的 AmendFactsParams maxItems；
 *   · fc.amended 对每个 finding 只赋值一次（jevcheck.ts:1641），故不累加。
 * 8 + 4 = 12。改上面任一处上限时**必须同步本常量**——test/submit_verdicts.test.ts 有机械断言锁死这个关系。
 */
export const CONDITIONS_MAX_ITEMS = 12;

export const VerdictSchema = Type.Object({
	/** 同题合并时多个。 */
	finding_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
	level: Type.Union([Type.Literal("BLOCKER"), Type.Literal("MAJOR"), Type.Literal("MINOR"), Type.Literal("驳回")]),
	can_happen: Type.Union([Type.Literal("能"), Type.Literal("不能"), Type.Literal("材料不足")]),
	/** 后果类别（优化 5）。 */
	consequence: Type.Union([
		Type.Literal("数据错误"),
		Type.Literal("静默失败"),
		Type.Literal("误杀或误报"),
		Type.Literal("资源泄漏"),
		Type.Literal("安全"),
		Type.Literal("可观测性"),
		Type.Literal("可用性"),
		Type.Literal("无实际后果"),
	]),
	/** 触发档（优化 5）。 */
	trigger: Type.Union([
		Type.Literal("常态触发"),
		Type.Literal("特定输入或环境"),
		Type.Literal("需人为误操作"),
		Type.Literal("仅理论"),
	]),
	/** 交人工；缺省 false（服务端补）。 */
	escalate: Type.Optional(Type.Boolean()),
	strength: Type.Union([Type.Literal("亲验"), Type.Literal("推理")]),
	/** 唯一的自由文字。 */
	reason: Type.String({ minLength: 10, maxLength: 150 }),
	/** 可核对位置：`路径:行` 或 `路径:起-止`。 */
	evidence: Type.String({ pattern: "^[^\\s]+:[0-9]+(-[0-9]+)?$", maxLength: 200 }),
	/**
	 * strength="亲验" 但本会话取证次数为 0 时，服务端把 strength 机械改写为 "推理"（§12.2 D / §12.6 1，
	 * 波四）；此字段保留模型原始自报值（"亲验"），供回执/渲染显示「自报亲验，取证 0 次」。未改写时不出现。
	 * schema 不声明为模型可写字段（服务端事后补写，见 orchestrate.ts），故不放进 VerdictSchema 校验；
	 * 这里只声明 TS 类型供 orchestrate.ts / render_verdicts.ts 使用同一个 Verdict 类型。
	 */
	strengthReported: Type.Optional(Type.Literal("亲验")),
	/**
	 * `reason` 里的标识符 token 对 `evidence` 行 ±2 的核验结果（§12.2 D / §12.6 2，波四）：相符（token
	 * 在 evidence 行±2 原样出现）/ 未命中（有 token 但都不在）/ 无标识符（reason 里抽不出可核 token）。
	 * 登记不 REJECT，仅供回执/渲染附注。服务端计算写入，不进模型可写 schema 校验路径（与 strengthReported
	 * 同理，声明为 Optional 只为获得同一个 Verdict TS 类型）。
	 */
	evidenceRef: Type.Optional(Type.Union([Type.Literal("相符"), Type.Literal("未命中"), Type.Literal("无标识符")])),
	/** 仅当本条覆盖核对表里的一对「结论相反」时必填。 */
	adopted: Type.Optional(
		Type.Union([Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3"), Type.Literal("折中"), Type.Literal("均不采信")]),
	),
	/** 仅核对表有异常时必填（优化 2）；给出时须为以下普通四值之一。 */
	table_handling: Type.Optional(
		Type.Union([
			Type.Literal("采信不符事实"),
			Type.Literal("驳回不符事实"),
			Type.Literal("已读真实位置"),
			Type.Literal("材料不足"),
		]),
	),
	/** 仅配合 table_handling。 */
	note: Type.Optional(Type.String({ maxLength: 80 })),
	/** 仅「条件红旗」的 finding 必填。 */
	conditions: Type.Optional(
		Type.Array(
			Type.Object({
				c: Type.String(),
				verdict: Type.Union([Type.Literal("可发生"), Type.Literal("被排除"), Type.Literal("材料不足")]),
				line: Type.Optional(Type.String({ maxLength: 40 })),
			}),
			{ maxItems: CONDITIONS_MAX_ITEMS },
		),
	),
});

export const SubmitVerdictsParams = Type.Object({
	verdicts: Type.Array(VerdictSchema, { maxItems: 200 }),
	final: Type.String({ minLength: 20, maxLength: 1500 }),
});

export type Verdict = Static<typeof VerdictSchema>;
export type SubmitVerdicts = Static<typeof SubmitVerdictsParams>;

export interface VerdictsState {
	accepted: SubmitVerdicts | null;
	attempts: number;
	rejects: string[];
}

// ---- jevcheck（类型本波声明；实现 src/moa/jevcheck.ts 属第二波）----

export interface JevCall {
	/** B2（设计稿 §B2）：问题种类闭集增 `"link"`（chain 因果推断步的 noul 问法，与 fact 同模板）；
	 *  `"recheck"` = §4.8 独立复核闸的 choice 三值问法（波4）。 */
	q: "fact" | "fact-behave" | "link" | "entail" | "same" | "opposite" | "fixed" | "recheck"
		| "fg-skip" | "fg-vacuous" | "fg-mock" | "fg-readback"
		| "wr-path" | "wr-hop-1" | "wr-hop-2" | "wr-key" | "wr-static"
		| "hd-policy" | "hd-gate-exist" | "hd-gate-fit" | "hd-exempt"
		| "od-path" | "od-conflict" | "od-repro" | "od-dup" | "od-second-caller" | "od-second-reader" | "od-reach-combo";
	p: number;
	stateSha256: string;
	inputTokens: number;
	ms: number;
	/** Measured at state assembly; present only with gapList diagnostics enabled. */
	stateChars?: number;
	stateCapped?: boolean;
	/** The later identical (stateSha256, sorted question-key set) request in this run. */
	cacheSuspect?: boolean;
}

export type FactLocPath = "doc-section" | "line-ref" | "same-file-else" | "cross-file" | "function-fallback" | "ref-corrected" | "null";

export interface FactCheck {
	text: string;
	kind: "code" | "general" | "condition";
	p: number | null;
	status: "相符" | "待核" | "不符" | "条件";
	slice?: { abs: string; a: number; b: number };
	locPath?: FactLocPath;
	/** Batch 4 quote mechanical location tier. Absent when quote is disabled or not supplied. */
	quoteStatus?: "精确" | "同文件校正" | "跨文件校正" | "本轮材料池未找到 quote" | "歧义" | "校正待核";
	/** Exact line originally supplied, retained for audit without asserting semantic truth. */
	quoteAudit?: string;
	askFault?: boolean;
	/** Thick-state recheck probability; the thin probability remains in p unless thick confirms. */
	pThick?: number | null;
	grayEnriched?: boolean;
	thickRefuted?: boolean;
	grayEnrichSkipped?: boolean;
	/** Fact-ref endpoint is outside every attached segment for its source file (diagnostic, not a verdict). */
	lineAnchorDrift?: true;
	/**
	 * 事实级机械校验结果透传（§12.2 A/C，波四）：来自 `FindingRecord.factRefs` 里同文本 `FactRef.status`
	 * 的七态（相符/已校正/待核/未命中/无标识符/文件未附/行号越界）。只有 code 类事实才有值。
	 */
	ref?: FactRefStatus;
	/** `ref="已校正"` 时：校正后的真实行号（= 对应 FactRef.a）。 */
	correctedLine?: number;
	/**
	 * 渲染就绪的引用标注（如「（引用已校正 881→884）」「（引用：标识符 X 不在第 884 行）」），
	 * renderCheckTable 直接拼接使用。设计 §12.3 表只明文列出 ref/correctedLine 两个新字段；本字段是
	 * 满足 §12.2 C 里给出的具体渲染示例（含原行号/标识符文本）所需的必要补充，据实施惯例登记于此。
	 */
	refDetail?: string;
}

/**
 * B7 逐步留痕（设计 §4 B7，波4）：每步 samples[] + mechNotes[] 进 spool receipt（校准数据持续积累）。
 * steps 数组序 = 事实步（f1…，非条件类）在前、chain 步（c1…）在后。
 */
export interface TruthStepTrace {
	id: string;
	kind: string;
	samples: number[];
	mechNotes: string[];
}

/**
 * B4 真伪三态（设计稿 §4 B4，波3）：`FindingCheck.truth` 的判定产物（server-derived，不问聚合器）。
 * verdict 四态：假（KILL 处决）/ 因果存疑（DOWNGRADE 不处决、进真跑队列语义）/ 依据不足（INSUFFICIENT）/
 * 未拆倒（UNREFUTED，≠证实）。rule 取 verdictOf 规则名（KILL / DOWNGRADE / DOWNGRADE-noMech /
 * INSUFFICIENT-locateMiss / INSUFFICIENT / DOWNGRADE-weak / UNREFUTED / B5-link）；brokenStep = 破绽步 id；
 * mechNotes = 机械佐证 note（「步id｜note」，只在证伪方向使用、永不背书）。
 * 生产采样侧填充点由 B7（波4）接线：checkFinding 对每 finding 跑 evalTruth（复用已采样 P），
 * 灰度 chain.enabled=false 时字段缺省不出现（与旧版逐字节等价）。
 * B7 留痕两字段（波4）：`steps` = 每步 samples[]+mechNotes[]（进 spool receipt）；
 * `run_id` = 结果行防重跑覆盖（R2-F4 口径：同 finding 多行按 run_id 辨识归属、取最新）。
 */
export interface FindingTruth {
	verdict: "假" | "因果存疑" | "依据不足" | "未拆倒";
	rule: string;
	/** Original rule before the B5 shunt (only when gapList diagnostics enabled). */
	b5From?: string;
	brokenStep?: string;
	mechNotes: string[];
	/** B7：逐步 samples[]+mechNotes[] 留痕（进 spool receipt，校准数据持续积累）。 */
	steps?: TruthStepTrace[];
	/** B7：结果行 run_id（防重跑覆盖，R2-F4）。 */
	run_id?: string;
}

export interface FindingCheck {
	/** "P1/F3" */
	pid: string;
	/** B4 真伪三态判定产物（设计稿 §4 B4，波3；见 `FindingTruth` 头注）。 */
	truth?: FindingTruth;
	/**
	 * anchor 四态透传（设计 v4 §3.5/优化 6，波二修复单 14）+「行号越界」「文件未附」两个机械前置判定；
	 * `anchorHit` 的「行号已校正」在 computeRef 侧归一为 `"OK"` 再写入此字段（submit_findings 阶段
	 * 已校正过 accepted finding 的 lines，且 `submit_verdicts.ts` 的 `isAnomalous` 用 `ref !== "OK"`
	 * 判异常，不归一会把本不异常的 finding 错判为异常）。
	 */
	ref: "OK" | "行号已校正" | "锚点不唯一" | "锚点未命中" | "行号越界" | "文件未附";
	facts: FactCheck[];
	amended?: { added: FactCheck[]; reason?: string; ms: number; entailBefore?: number; entailAfter?: number; statusBefore?: FindingCheck["status"] };
	/** 只进回执。 */
	entail: { p1: number; p2?: number };
	/** 只进回执。 */
	fixPresent?: number;
	/** Classification questions answered only when the category evidence gate passes. */
	battery?: Array<{ key: string; p: number }>;
	/** Missing required source sections; these questions were never sent to JEV. */
	batteryGaps?: GapRecord[];
	/** Opt-in battery requests dropped by the remaining-call budget guard. */
	batterySkipped?: number;
	/** Evidence-step reference presence; never interpreted as causal truth. */
	chainEvidence?: Array<{ id: string; status: "引用在场（机械）" | "引用缺失（机械）"; tokens: string[]; lines: number[] }>;
	chainEvidenceGaps?: GapRecord[];
	/** 「含待核前提」= 非条件类事实里有「待核」（定位失败或 Jev 未答）时不得合成「前提完备…」（波二修复单 2）。
	 * 优先级：含不符前提 ＞ 前提不足 ＞ 含待核前提 ＞ 条件性成立 ＞ 前提完备且全部相符。 */
	status: "前提完备且全部相符" | "条件性成立" | "前提不足" | "含待核前提" | "含不符前提" | "未核";
	/** 运行时条件 ≥2 或 ≥50%。 */
	conditionFlag: boolean;
	calls: JevCall[];
	/** P1 material segments excluded by the 20k character assembly budget. */
	closureDropped?: number;
	/**
	 * 三路互验结果透传（lines / anchor / facts；徐总 09-20 追加裁定，波四）：来自
	 * `FindingRecord.refConsistency`，供 renderCheckTable 渲染「引用不一致」提示。
	 * `refConsistency==="不一致"` 时 `ref` 汇总归到「锚点不唯一」档（见 jevcheck.ts computeRef）。
	 */
	refConsistency?: "一致" | "不一致" | "仅两路";
	/** `refConsistency==="不一致"` 时：渲染就绪的「lines a-b / anchor L / 事实 m-n」详情片段。 */
	refConsistencyDetail?: string;
}

export interface GapRecord {
	id: string;
	pid: string;
	path: string;
	factIdx: number | null;
	kind: "locate-fail" | "ask-fault" | "ref-hard-error" | "entail-low" | "quote-ambiguous" | "gray-refute-suspect" | "chain-evidence-missing" | "line-anchor-drift";
	need: string[];
}

export interface JevCheckReport {
	/** Four-tier quote distribution, including ambiguous and uncorrectable diagnostics; absent with quote off. */
	quoteTierCounts?: Partial<Record<NonNullable<FactCheck["quoteStatus"]>, number>>;
	/** Terminal gap list; absent when gapList is off. */
	gaps?: { records: GapRecord[]; writeCount: number };
	/** Deterministic 1% diagnostic sample of located fact slices. */
	locAudit?: Array<{ id: string; slice: { abs: string; a: number; b: number }; expectedAnchor: string; fact: string }>;
	closureDropped?: number;
	grayEnrichSkipped?: number;
	batterySkipped?: number;
	/** Flag-scoped counters; omitted entirely while each feature is disabled. */
	chainEvidenceTelemetry?: { triggered: number; present: number; missing: number };
	categoryAutoRouteTelemetry?: { primary: number; secondary: number; routed: number };
	entailBridgeTelemetry?: { triggered: number; named: number; missingEntities: number };
	enabled: boolean;
	skipped?: string;
	perFinding: Record<string, FindingCheck>;
	duplicates: Array<{ a: string; b: string; p: number; status: "同一问题" | "疑似重复" }>;
	conflicts: Array<{ a: string; b: string; pSame: number; pOpposite: number; viaCounter: boolean }>;
	oneSided: Array<{ id: string; proposerIndex: number }>;
	proposerQuality: Record<
		string,
		{ findings: number; refMismatch: number; factsLow: number; rejects: number; conditionRate: number }
	>;
	totals: { calls: number; inputTokens: number; ms: number; tableChars: number; truncated: boolean; throttled: number };
	/** 渲染后的核对表（spool 用）。 */
	tableText: string;
}

export interface MoaRequest {
	prompt: string;
	context?: string;
	/** 用命名 preset（缺省取 config.defaults.preset） */
	preset?: string;
	/** 以下为临时覆盖，优先于 preset */
	mode?: Mode;
	models?: WorkerRef[]; // 覆盖 proposers
	aggregator?: WorkerRef;
	cwd?: string;
	/**
	 * 本次调用的取证轮数上限覆盖(v4 §10-D,徐总 2026-08-25 批准的契约变更)。
	 * 缺省走全局 SESSION_MAX_TOOL_CALLS(5);编排层按 MAX_TOOL_CALLS_HARD_CAP(10)钳制。
	 */
	maxToolCalls?: number;
	/**
	 * 聚合器会话的取证调用次数上限(提速方案 §4.3 分档,2026-09-04)。
	 * 与 maxToolCalls **互不继承**:缺省 SESSION_MAX_TOOL_CALLS(5);**只降不升**——
	 * 合法域 1..SESSION_MAX_TOOL_CALLS,超过 5 在编排层按 stage=config 拒绝(不接受放大)。
	 * 用途:review 派单把 proposer 压到 2-3 时,聚合器复核不受牵连。
	 */
	aggregatorMaxToolCalls?: number;
	/**
	 * 本轮附入材料的结构化副本（设计 v4 §3.1）：abs → 若干区间（裸行）。由 applyRecon 装配；
	 * 与 `context` 文本并行、不替代它。只在 recon 真附入了材料时存在。
	 */
	materials?: MaterialMap;
	/**
	 * 侦查前置的可观测摘要（2026-09-20 灰度第 3 轮：要能回答「deps 到底附了哪些 helper」）：
	 * 附入段数、每段 `rel:start-end kind`、以及 recon notes（被拒/截断/deps 跳过原因）。进 receipt.recon 落 spool。
	 */
	reconSummary?: { filesIncluded: number; segments: string[]; notes: string[] };
}

export interface Usage {
	input: number;
	output: number;
	reasoning?: number;
	/**
	 * 命中 prompt 缓存的输入 token（`input` 的子集）。多轮工具调用每轮重发完整历史，
	 * 但前缀相同 ⇒ 绝大部分应命中缓存（DeepSeek 直连实测：第 2/3 轮命中 83%/86%）。
	 * **命中率低 = 前缀被破坏**（注入了时间戳/随机内容/顺序抖动），是明确的可优化信号。
	 */
	cacheRead?: number;
	/** 写入 prompt 缓存的 token（首轮建缓存的开销）。 */
	cacheWrite?: number;
	totalTokens: number;
}

/**
 * 单会话取证账(提速方案 §4.1,2026-09-04):runSession 结束时从预算账本快照 + pi 重试事件计数得到,
 * 纯可观测、不参与任何判决。**缺省口径**:exhaustedBy 未耗尽=`null`(非 undefined,保证 JSON 落盘时字段
 * 恒在,统计脚本按键取值不必判缺失);retries 拿不到计数(会话未建起来:模型未找到 / createAgentSession 抛)
 * =`null`,拿得到即 ≥0 的整数(pi `auto_retry_start` 事件数)。
 */
/** 一次成功取证读取的目标（波四复审 2026-09-20）：read 工具记解析后的绝对路径与实际返回行区间；
 * bash_readonly 记命令原文（按文件名子串匹配）。供 aggregator「亲验」按 evidence 所在文件逐条归因。 */
export interface ReadRecord {
	abs?: string;
	a?: number;
	b?: number;
	cmd?: string;
	/** read / bash_readonly 成功结束但事件里没有可解析的 details（pi 事件形状变化的兜底）：下游退回会话级口径，
	 * 而不是把整批自报「亲验」误降级（PiMoa 复审 P1/F4）。 */
	unknown?: true;
}

export interface SessionTrace {
	/** 已放行的取证调用次数(reserve 计入;release 退回)。 */
	calls: number;
	/**
	 * 本会话每次**成功**的取证读取（read / bash_readonly），按发生顺序；真 runSession 恒带（可为空数组），
	 * DI mock 结果可能缺省——缺省时下游退回会话级 calls 口径。§12.2 D 的「取证 0 次自报亲验改写」此前只看
	 * 会话级 calls，§12.6 第 5 点又要求 aggregator 至少 read 一次，于是一次 read 就让同批所有自报「亲验」免改写
	 * （PiMoa 复审 P1/F1）；现按 verdict.evidence 所在文件是否真被读过逐条判。
	 */
	reads?: ReadRecord[];
	/** 已结算的取证字符数。 */
	usedChars: number;
	/** 会话结束时仍在途的预扣字符(正常应为 0;>0 说明有工具未 settle,是缺陷信号)。 */
	reservedChars: number;
	/** 本会话生效的调用次数上限(§4.3 分档后 proposer/aggregator 可不同,落盘才可验)。 */
	maxCalls: number;
	/** 本会话生效的字符上限。 */
	maxChars: number;
	/**
	 * **结算后仍耗尽**的类别(2026-09-06 起,budget.ts settledExhaustedBy 现算);未耗尽=null。
	 * 此前记"首次被拒类别"且粘滞——并行 tool call 互挤的瞬时拒绝会把实际只用了几百字符的会话标成耗尽。
	 */
	exhaustedBy: BudgetExhaustedBy | null;
	/** 被拒的取证调用次数(含并行互挤的瞬时拒绝);>0 且 exhaustedBy=null 即"被挤过但余量够"。 */
	rejections: number;
	/** 最近一次被拒的类别;从未被拒=null。 */
	lastRejectedBy: BudgetExhaustedBy | null;
	/** pi 自动重试次数(auto_retry_start 事件计数);会话未建起来无从计数=null。 */
	retries: number | null;
}

/** proposer 的取证账 = 会话账 + 耗时/usage 摘要(spool `[trace]` 行与回包 proposals[].trace 的数据源)。 */
export interface ProposalTrace extends SessionTrace {
	durationMs: number;
	/** usage 缺失(会话未产出 usage)时为 null。 */
	input: number | null;
	output: number | null;
	cacheRead: number | null;
}

/** 聚合器的取证账(durationMs/usage 已在 AggregatorResult 顶层,不重复)。 */
export type AggregatorTrace = SessionTrace;

/** proposer success 硬定义（DESIGN §4 不变量1）：ok = agent_end 且 text 非空 且 error 空 */
export interface ProposalResult {
	model: string;
	ok: boolean;
	empty: boolean; // 正文是否为空（空 → 不算成功）
	text: string;
	usage: Usage | null;
	costUsd: number;
	durationMs: number;
	timeout: boolean;
	sessionId?: string; // 供 pi-web attach（DESIGN §4.6 P1-3）
	error?: string;
	/** 最后一条 assistant 的 stopReason（length=撞输出上限被截断）；spool [trace] 行与回包 proposals[] 带上。 */
	stopReason?: string;
	/** 取证账(§4.1)。编排层恒填;可选仅为兼容手写字面量(测试 fixture / 旧调用方)。 */
	trace?: ProposalTrace;
	/** verify 模式下经 submit_findings 接受的结构化清单（设计 v4 §2；第三波编排层填）。 */
	findings?: Finding[];
	/** 结构化提交摘要（runSession 填入 SessionRunResult.structured，编排层透传）。 */
	structured?: StructuredSummary;
}

export interface AggregatorResult {
	/** 实际产出正文（或最后一次尝试）的聚合器 `provider/model`。 */
	model: string;
	usage: Usage | null;
	/** 本次成功（或最后一次）聚合调用的成本；被丢弃的降级前尝试计入 receipt.totalCostUsd。 */
	costUsd: number;
	durationMs: number;
	sessionId?: string;
	/** 发生降级时=被替换掉的**主**聚合器 `provider/model`；未降级则该字段不出现。 */
	fallbackFrom?: string;
	/** 发生降级时=主聚合器的失败原因（供取证归因）。 */
	fallbackReason?: string;
	/** 取证账(§4.1):属于**实际产出正文的那一跳**(降级时=备胎)。proposer 阶段失败的空壳 receipt 不填。 */
	trace?: AggregatorTrace;
}

export interface Receipt {
	mode: Mode;
	preset: string;
	models: string[];
	quorum: string; // "N/N"
	profile: string;
	/** 每 proposer 阶段硬信号（DESIGN §4.6 P1-5，对齐 Hermes MOA_REFERENCE_*） */
	proposerMarks: Record<string, "completed" | "timeout" | "failed">;
	aggregator: AggregatorResult;
	/**
	 * 各 proposer 的账目（与上一条 `aggregator` 对称；2026-09-21 徐总批准）：复用既有 `ProposalResult`
	 * 本体，按 `Receipt.jevcheck` 的既有先例用 `Omit` 投影裁掉臃肿字段——`text` 是 proposer 全文正文
	 * （receipt 随回包 `structuredContent` 返回，带上会让回包与 spool 双重膨胀）；`findings` 与下方
	 * `Receipt.findings`（已带 pid/proposerIndex/proposerModel 归属）同源重复。
	 * 耗时/取证账在 `ProposalResult.durationMs` 与 `ProposalResult.trace`（= `ProposalTrace`：calls /
	 * maxCalls / usedChars / maxChars / exhaustedBy / rejections / retries）。
	 * 数组下标即 proposer slot（与 `proposerMarks` 的 key 前缀 `"${i}:…"`、`models` 同序）；硬信号
	 * `mark` 可由 `ok` + `timeout` 按 `proposerMark()` 口径复原（ok→completed / timeout→timeout / 其余→failed）。
	 * 可选：config 阶段失败等未跑模型的路径不填（沿用 `audit` 的既有口径，免改全部手工 Receipt 字面量）；
	 * `makeEmptyReceipt()` 恒给 `[]`，失败路径不产出 undefined。
	 */
	proposals?: Array<Omit<ProposalResult, "text" | "findings">>;
	bodySha256: string;
	totalCostUsd: number;
	delivery?: { written: boolean; path: string; sha256: string } | null;
	/**
	 * spool 审计落盘取证（v4 §10-A,徐总 2026-08-25 批准的契约变更)。
	 * 存在 = 本次调用的 aggregated/proposer 全文已落盘到该文件;可选字段,
	 * config 阶段失败等未跑模型的路径不填(免改全部手工 Receipt 字面量)。
	 * retainUntil = 按 spool 保留策略(缺省 14 天)计算的最早可清理时刻(ISO)。
	 */
	audit?: { path: string; bytes: number; sha256: string; retainUntil: string };
	/** 各 proposer 已接受的 findings 汇总（含 pid / proposer 下标 / 模型；设计 v4 §2，第三波填）。 */
	findings?: Array<Finding & { pid: string; proposerIndex: number; proposerModel: string }>;
	/** jevcheck 报告去 calls 与 tableText 后的回执版（逐调用记录只进 spool，裁决 C11）。 */
	/** Complete terminal gaps; explicit top-level consumer entry in addition to jevcheck.gaps. */
	gaps?: NonNullable<JevCheckReport["gaps"]>;
	jevcheck?: Omit<JevCheckReport, "tableText" | "perFinding"> & {
		perFinding: Record<string, Omit<FindingCheck, "calls">>;
	};
	/** aggregator 经 submit_verdicts 接受的结构化裁决（精简版 verdicts + final，含尝试次数）。 */
	verdicts?: SubmitVerdicts & { attempts: number };
	/**
	 * 结构化提交/裁决的软档态标注（波三 b 修复单第 7 条，从 orchestrate.ts 的局部扩展类型
	 * `ReceiptEx` 收拢进单一真源）：key 与 `proposerMarks` 同形（`"${i}:${provider}/${model}"`），
	 * "aggregator" 键为聚合器裁决态。仅 jevOn 时才写。
	 */
	structuredMarks?: Record<string, "accepted" | "rejected" | "none">;
	/** 侦查前置摘要（MoaRequest.reconSummary 透传）：附入段清单（含 deps 附入的 helper）与 notes。 */
	recon?: { filesIncluded: number; segments: string[]; notes: string[] };
}

export interface MoaError {
	// "abort" = 主动取消（外部 signal / 兄弟 induced-abort）；"timeout" = 总 backstop 超时兜底，
	// 二者语义不同（取消 vs 超时），故分列，避免 backstop 借用 "abort" 与主动取消混淆。
	stage: "config" | "proposer" | "quorum" | "aggregator" | "delivery" | "abort" | "timeout";
	reason: string;
	detail?: string;
}

export interface MoaResult {
	status: "ok" | "failed" | "aborted";
	aggregated: string; // 成功时=聚合正文；失败时=""
	proposals: ProposalResult[];
	receipt: Receipt;
	error: MoaError | null;
	/** 完整 jevcheck 报告（含 calls 与 tableText），只给 spool；回包不带（裁决 C11）。 */
	jevcheckFull?: JevCheckReport;
	/**
	 * structured rejects 原文（**两路**），只给 spool（`## structured rejects` 节逐 key 渲染）：灰度期看
	 * 模型为什么交不出合格清单 / 裁决。
	 *   · 各 proposer 的 submit_findings REJECT 原文，key 与 proposerMarks 同形（`0:provider/model`）；
	 *   · 聚合器的 submit_verdicts REJECT 原文（★待办 8，2026-09-20），key 为
	 *     `aggregator:provider/model`——与 proposer 的数字前缀区分开、字典序排在数字之后，全文不截断，
	 *     成功轮与失败轮同样落盘。
	 * 两路末尾各自附本路 schema 层（typebox）拒绝样本（≤3 条）。类型恒为 `Record<string, string[]>`。
	 */
	structuredRejectsFull?: Record<string, string[]>;
}

/**
 * MoA 编排入口（Coder B 实现）。
 * deps.modelRuntime = pi 的 ModelRuntime 实例（用 modelRuntime.getModel(provider,id) 解析模型）。
 * 不变量（DESIGN §4）：proposer 任一失败/空正文 → 整体 fail-closed（status:"failed"）、不产出、不降级。
 */
export type RunMoa = (
	config: MoaConfig,
	req: MoaRequest,
	deps: { modelRuntime: unknown; signal?: AbortSignal },
) => Promise<MoaResult>;
