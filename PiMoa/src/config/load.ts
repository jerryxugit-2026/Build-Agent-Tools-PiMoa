// Pi-MoA · 配置加载 + 加载期不变量强校验（fail-loud）。
// 对应 DESIGN.md §4.5 加载期不变量。实现方：Coder A。
// 只读 config/types.ts 契约（import，不改）。违反不变量即 throw，启动即报错、绝不带病启动。
import {
	AGGREGATOR_OVERHEAD_CHARS,
	EFFECTIVE_WINDOW_RATIO,
	GATE_QUEUE_TIMEOUT_MS,
	materialBudgetChars,
	PROPOSER_OVERHEAD_CHARS,
	retrievalCharBudget,
} from "./limits.js";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalizeReadRoots, ReadRootError } from "../tools/access.js";
import type {
	AccessCfg,
	HttpCfg,
	JevcheckCfg,
	Mode,
	MoaConfig,
	Preset,
	ProfileName,
	ProviderCfg,
	ProviderKind,
	Quorum,
	Timeouts,
	WorkerRef,
} from "./types.js";

/** 配置加载/不变量违规统一错误类型。message 已含足够定位信息。 */
export class ConfigError extends Error {
	constructor(message: string) {
		super(`[config] ${message}`);
		this.name = "ConfigError";
	}
}

const PROVIDER_KINDS: readonly ProviderKind[] = ["openai", "anthropic"];
const PROFILE_NAMES: readonly ProfileName[] = [
	"synthesize-worker",
	"verify-worker",
	"delivery-readonly-worker",
];
const MODES: readonly Mode[] = ["synthesize", "verify"];
/** 不变量②：verify preset 的 aggregator 只允许这些只读 profile。 */
const VERIFY_AGGREGATOR_PROFILES: readonly ProfileName[] = [
	"verify-worker",
	"delivery-readonly-worker",
];

/** MoA per-call 与 backstop 的绝对上限（pi-mcp 侧 30min，见 §4.5 不变量①）。 */
const PI_MCP_ABS_MAX_MS = 30 * 60 * 1000; // 1_800_000

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireObject(v: unknown, where: string): Json {
	if (!isObject(v)) {
		throw new ConfigError(`${where} 必须是对象，实际为 ${describe(v)}`);
	}
	return v;
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

function requireString(v: unknown, where: string): string {
	if (typeof v !== "string" || v.length === 0) {
		throw new ConfigError(`${where} 必须是非空字符串，实际为 ${describe(v)}`);
	}
	return v;
}

function requireFiniteNumber(v: unknown, where: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		throw new ConfigError(`${where} 必须是正有限数，实际为 ${JSON.stringify(v)}`);
	}
	return v;
}

/** 必填正整数（`timeouts.requestIdleMs` 用：毫秒阈值不接受小数，0/负数会让看门狗立即误杀）。 */
function requirePosInt(v: unknown, where: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new ConfigError(`${where} 必须是正整数，实际为 ${JSON.stringify(v)}`);
	}
	return v;
}

// ---- 结构解析（把 unknown 收敛成契约类型；结构错也 fail-loud）----

function parseProvider(raw: unknown, key: string): ProviderCfg {
	const o = requireObject(raw, `providers.${key}`);
	const kind = requireString(o.kind, `providers.${key}.kind`);
	if (!PROVIDER_KINDS.includes(kind as ProviderKind)) {
		throw new ConfigError(
			`providers.${key}.kind 非法："${kind}"，仅允许 ${PROVIDER_KINDS.join(" | ")}`,
		);
	}
	const baseUrl = requireString(o.baseUrl, `providers.${key}.baseUrl`);
	const cfg: ProviderCfg = { kind: kind as ProviderKind, baseUrl };
	if (o.apiKeyEnv !== undefined) {
		cfg.apiKeyEnv = requireString(o.apiKeyEnv, `providers.${key}.apiKeyEnv`);
	}
	return cfg;
}

function parseWorkerRef(raw: unknown, where: string): WorkerRef {
	const o = requireObject(raw, where);
	const provider = requireString(o.provider, `${where}.provider`);
	const model = requireString(o.model, `${where}.model`);
	// 不变量①的一部分：proposer 与 aggregator 都必须带 profile。
	if (o.profile === undefined) {
		throw new ConfigError(`${where} 缺少 profile（proposer 与 aggregator 都必须带 profile，P0-1）`);
	}
	const profile = requireString(o.profile, `${where}.profile`);
	if (!PROFILE_NAMES.includes(profile as ProfileName)) {
		throw new ConfigError(
			`${where}.profile 非法："${profile}"，仅允许 ${PROFILE_NAMES.join(" | ")}`,
		);
	}
	return { provider, model, profile: profile as ProfileName };
}

function parsePreset(raw: unknown, key: string): Preset {
	const o = requireObject(raw, `presets.${key}`);
	const mode = requireString(o.mode, `presets.${key}.mode`);
	if (!MODES.includes(mode as Mode)) {
		throw new ConfigError(
			`presets.${key}.mode 非法："${mode}"，仅允许 ${MODES.join(" | ")}`,
		);
	}
	// 不变量③（2026-07-25 分模式）：quorum ∈ {"all","tolerate-one"}，缺省 "all"（安全默认+向后兼容）；
	//   **verify 强制 "all"**。其它值（如数字 1）一律 fail-loud 拒绝（防误配破坏 fail-closed，P0-5）。
	const quorumRaw = o.quorum === undefined ? "all" : o.quorum;
	if (quorumRaw !== "all" && quorumRaw !== "tolerate-one") {
		throw new ConfigError(
			`presets.${key}.quorum 必须是 "all" 或 "tolerate-one"，实际为 ${JSON.stringify(o.quorum)}；` +
				"配置化误配（如数字 1）会破坏 fail-closed（P0-5）",
		);
	}
	if (mode === "verify" && quorumRaw !== "all") {
		throw new ConfigError(
			`presets.${key}.quorum 在 verify 模式下必须为 "all"，实际为 ${JSON.stringify(quorumRaw)}；` +
				"验真的价值在独立交叉核验——少一个验证者则「多方分别核对过」的前提不成立，降级等于假装安全",
		);
	}
	if (!Array.isArray(o.proposers) || o.proposers.length === 0) {
		throw new ConfigError(`presets.${key}.proposers 必须是非空数组`);
	}
	const proposers = o.proposers.map((p, i) =>
		parseWorkerRef(p, `presets.${key}.proposers[${i}]`),
	);
	const aggregator = parseWorkerRef(o.aggregator, `presets.${key}.aggregator`);
	const preset: Preset = {
		mode: mode as Mode,
		quorum: quorumRaw as Quorum,
		proposers,
		aggregator,
	};
	// 聚合器降级备胎（可选）：不设 ⇒ 无降级路径，行为与改造前一致。
	// 校验口径与 aggregator 完全相同（provider 存在性、profile 合法性、verify 只读），见 validateConfig。
	if (o.aggregatorFallback !== undefined) {
		preset.aggregatorFallback = parseWorkerRef(
			o.aggregatorFallback,
			`presets.${key}.aggregatorFallback`,
		);
	}
	return preset;
}

/**
 * Node undici 的**默认空闲 body 超时**（ms）。2026-09-22 主代理实测确认的因果链上游那一环：
 * 本地卡死流在 **301.2s** 抛 `UND_ERR_BODY_TIMEOUT`（message 含 `terminated`，而 `terminated` 恰好命中
 * pi 的可重试正则）⇒ 若 `requestIdleMs` 配到 ≥ 该值，undici 永远先掐断、本看门狗永远不先到点，
 * 等于把修复**静默退回改造前的隐式 300s 行为**，且加载期看不出来。
 * 故 ⑤-d 用它作显式上限：本单的全部价值就是"把放弃时机从隐式 300s 提前到显式可配值"。
 */
export const UNDICI_DEFAULT_BODY_TIMEOUT_MS = 300_000;

/**
 * `timeouts` 段解析。四个键**全部必填**（2026-09-22 新增 `requestIdleMs` 沿用同一口径）：
 * 静默缺省会让人以为看门狗在守、实际没开，而超时配置恰恰是出事时唯一能解释「为什么卡这么久」的
 * 东西——故缺失即 fail-loud，不接受隐式缺省。取 180000 的依据见 config/moa.yaml 的 timeouts 注释
 * （高于实测健康 p100 的 107.6s TTFT 留足余量，又远低于 referencePerCallMs(540000)）。
 */
function parseTimeouts(raw: unknown): Timeouts {
	const o = requireObject(raw, "timeouts");
	return {
		referencePerCallMs: requireFiniteNumber(
			o.referencePerCallMs,
			"timeouts.referencePerCallMs",
		),
		aggregatorPerCallMs: requireFiniteNumber(
			o.aggregatorPerCallMs,
			"timeouts.aggregatorPerCallMs",
		),
		moaTotalBackstopMs: requireFiniteNumber(
			o.moaTotalBackstopMs,
			"timeouts.moaTotalBackstopMs",
		),
		// 新增键（2026-09-22）：必须正整数（毫秒），跨字段条件 requestIdleMs < referencePerCallMs
		// 在 validateConfig ⑤-d 里校（那里同时兜住内存直构 config 的路径）。
		requestIdleMs: requirePosInt(o.requestIdleMs, "timeouts.requestIdleMs"),
	};
}

/**
 * 解析 `access` 段（缺省 = 空读根，即改造前的单根行为，向后兼容）。
 *
 * 读根的合法性（绝对路径 / 存在 / 是目录 / 不覆盖 $HOME 或 "/"）由 access.ts 的
 * canonicalizeReadRoots 在**加载期**强校验并归一到 realpath —— 打错一个字就启动失败，
 * 绝不静默退化成"这个根不存在"（那会表现为运行期莫名其妙的越界拒绝，极难排查）。
 */
function parseAccess(raw: unknown): AccessCfg {
	if (raw === undefined || raw === null) return { readRoots: [] };
	const o = requireObject(raw, "access");
	if (o.readRoots === undefined) return { readRoots: [] };
	if (!Array.isArray(o.readRoots)) {
		throw new ConfigError(
			`access.readRoots 必须是数组，实际为 ${describe(o.readRoots)}`,
		);
	}
	try {
		return { readRoots: canonicalizeReadRoots(o.readRoots as string[]) };
	} catch (err) {
		if (err instanceof ReadRootError) {
			throw new ConfigError(`access.readRoots 非法：${err.message}`);
		}
		throw err;
	}
}

/** HTTP 入口形态取值（O3，DEC-72 ④ / DEC-75）。缺省 hybrid = O2 现网形态。 */
const HTTP_MODES: readonly HttpCfg["mode"][] = ["hybrid", "modern"];

/**
 * 解析 `http` 段（O3）。整段缺省 / mode 缺省 ⇒ hybrid（与 O2 现网逐字节同行为）。
 * 只认 `mode` 一个键：拼错的键（如 `mdoe: modern`）不能静默留在 hybrid 让人以为已切换，故未知键一律 fail-loud。
 */
function parseHttp(raw: unknown): HttpCfg {
	if (raw === undefined || raw === null) return { mode: "hybrid" };
	const o = requireObject(raw, "http");
	for (const k of Object.keys(o)) {
		if (k !== "mode") throw new ConfigError(`http.${k} 是未知键，http 段只认 mode（hybrid | modern）`);
	}
	const mode = o.mode === undefined ? "hybrid" : o.mode;
	if (!HTTP_MODES.includes(mode as HttpCfg["mode"])) {
		throw new ConfigError(`http.mode 非法：${JSON.stringify(mode)}，仅允许 hybrid | modern`);
	}
	return { mode: mode as HttpCfg["mode"] };
}

/** 缺省值（Jev 辅助代码审查设计 v4 §6 原文 + finding 真伪判定设计 §5/§4.8，C1 波4）。enabled=false ⇒ 与旧版逐字节一致。 */
export const JEVCHECK_DEFAULTS: JevcheckCfg = {
	enabled: false,
	url: "http://127.0.0.1:8760/mcp",
	concurrency: 8,
	perCallTimeoutMs: 15_000,
	clientMode: "auto",
	budget: { maxCalls: 2_500, maxMs: 90_000, tableMaxChars: 40_000 },
	thresholds: {
		fact: { high: 0.8, low: 0.2 },
		same: { merge: 0.8, flag: 0.4 },
		conflict: { sameMin: 0.6, oppositeMin: 0.6 },
		entail: { low: 0.5 },
		// B4 真伪阈值（设计 §5：refute=0.1 只喂 KILL；weak=0.2 弱证伪/中带）。
		refute: 0.1,
		weak: 0.2,
	},
	// 一波并行：perCallMs × ceil(maxFindings / concurrency) = 30,000 × ceil(10/10) = 30,000 ≤ budget.maxMs 90,000。
	premiseRound: { enabled: false, maxFindings: 10, concurrency: 10, perCallMs: 30_000 },
	fixPresent: { enabled: false },
	factRefDirect: { enabled: false },
	gapList: { enabled: false },
	gapCarryForward: { enabled: false },
	quote: { enabled: false, required: false },
	stateExpansion: { enabled: false },
	factThicken: { enabled: false },
	grayEnrich: { enabled: false },
	category: { enabled: false },
	chainEvidenceGate: { enabled: false },
	categoryAutoRoute: { enabled: false },
	odTyped: { enabled: false },
	entailBridge: { enabled: false },
	// link=2（设计 §5：与 entail 同档，双采样一致才称证伪）。fact 缺省沿 v4 §6 原文 1；生产真源
	// moa.yaml 已按 2026-09-22 裁决（设计附录 A「fact/link 2 次」）配 fact: 2。
	sampling: { fact: 1, entail: 2, same: 1, opposite: 1, fixed: 2, link: 2 },
	submit: { required: false, maxAttempts: 3 },
	verdicts: { required: false, maxAttempts: 3, reasonMaxChars: 150 },
	// chain 灰度缺省关（与 jevcheck.enabled 同一先例：缺省与旧版逐字节等价；生产真源 moa.yaml 显式开）。
	chain: { enabled: false, minSteps: 2, maxSteps: 6 },
	mech: { enabled: true, scopePad: 20, minTokenLen: 3 },
};

/** Jev 客户端并发硬顶（裁决 C8：进程级单例信号量 8）。 */
const JEVCHECK_MAX_CONCURRENCY = 8;

/** 缺省即取；给了就必须是 boolean。 */
function optBool(o: Json, key: string, fallback: boolean, where: string): boolean {
	const v = o[key];
	if (v === undefined) return fallback;
	if (typeof v !== "boolean") throw new ConfigError(`${where}.${key} 必须是布尔值，实际为 ${JSON.stringify(v)}`);
	return v;
}

/** 缺省即取；给了就必须是正整数，且 ≤ max（如给）。 */
function optPosInt(o: Json, key: string, fallback: number, where: string, max?: number): number {
	const v = o[key];
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new ConfigError(`${where}.${key} 必须是正整数，实际为 ${JSON.stringify(v)}`);
	}
	if (max !== undefined && v > max) throw new ConfigError(`${where}.${key}(${v}) 超过上限 ${max}`);
	return v;
}

/** 缺省即取；给了就必须是 [0,1] 内的有限数（概率阈值）。 */
function optProb(o: Json, key: string, fallback: number, where: string): number {
	const v = o[key];
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
		throw new ConfigError(`${where}.${key} 必须是 0..1 的数，实际为 ${JSON.stringify(v)}`);
	}
	return v;
}

/** 缺省即取；给了就必须是对象。 */
function optObject(o: Json, key: string, where: string): Json {
	const v = o[key];
	if (v === undefined) return {};
	return requireObject(v, `${where}.${key}`);
}

/**
 * 解析 `jevcheck` 段（Jev 辅助代码审查设计 v4 §6）。整段缺省 ⇒ 全部缺省值（enabled=false）。
 * 每个子项都可单独省略（取缺省）；给了就校类型与范围：并发 ≤ 8、阈值 0..1、次数/毫秒正整数。
 * 子项之间的不变量（阈值大小关系、补前提回合的时间账）在 validateConfig 里校，便于内存直构 config 也走同一道闸。
 */
function parseJevcheck(raw: unknown): JevcheckCfg {
	if (raw === undefined || raw === null) return structuredClone(JEVCHECK_DEFAULTS);
	const o = requireObject(raw, "jevcheck");
	const D = JEVCHECK_DEFAULTS;
	const url = o.url === undefined ? D.url : requireString(o.url, "jevcheck.url");
	if (!/^https?:\/\//.test(url)) throw new ConfigError(`jevcheck.url 必须是 http(s) 地址，实际为 ${JSON.stringify(url)}`);
	const clientMode = o.clientMode === undefined ? D.clientMode : o.clientMode;
	if (clientMode !== "auto" && clientMode !== "modern" && clientMode !== "legacy") {
		throw new ConfigError(`jevcheck.clientMode 非法：${JSON.stringify(clientMode)}，仅允许 auto | modern | legacy`);
	}
	const budget = optObject(o, "budget", "jevcheck");
	const th = optObject(o, "thresholds", "jevcheck");
	const thFact = optObject(th, "fact", "jevcheck.thresholds");
	const thSame = optObject(th, "same", "jevcheck.thresholds");
	const thConflict = optObject(th, "conflict", "jevcheck.thresholds");
	const thEntail = optObject(th, "entail", "jevcheck.thresholds");
	const pr = optObject(o, "premiseRound", "jevcheck");
	const fixPresent = optObject(o, "fixPresent", "jevcheck");
	const factRefDirect = optObject(o, "factRefDirect", "jevcheck");
	const gapList = optObject(o, "gapList", "jevcheck");
	const gapCarryForward = optObject(o, "gapCarryForward", "jevcheck");
	const quote = optObject(o, "quote", "jevcheck");
	const stateExpansion = optObject(o, "stateExpansion", "jevcheck");
	const factThicken = optObject(o, "factThicken", "jevcheck");
	const grayEnrich = optObject(o, "grayEnrich", "jevcheck");
	const category = optObject(o, "category", "jevcheck");
	const chainEvidenceGate = optObject(o, "chainEvidenceGate", "jevcheck");
	const categoryAutoRoute = optObject(o, "categoryAutoRoute", "jevcheck");
	const odTyped = optObject(o, "odTyped", "jevcheck");
	const entailBridge = optObject(o, "entailBridge", "jevcheck");
	const sampling = optObject(o, "sampling", "jevcheck");
	const submit = optObject(o, "submit", "jevcheck");
	const verdicts = optObject(o, "verdicts", "jevcheck");
	// C1（finding 真伪判定设计 §5，波4）：chain / mech 两节 + thresholds.refute/weak + sampling.link。
	const chain = optObject(o, "chain", "jevcheck");
	const mech = optObject(o, "mech", "jevcheck");
	const chainMinSteps = optPosInt(chain, "minSteps", D.chain?.minSteps ?? 2, "jevcheck.chain", 6);
	const chainMaxSteps = optPosInt(chain, "maxSteps", D.chain?.maxSteps ?? 6, "jevcheck.chain", 6);
	if (chainMinSteps > chainMaxSteps) {
		throw new ConfigError(`jevcheck.chain.minSteps(${chainMinSteps}) 必须 ≤ maxSteps(${chainMaxSteps})`);
	}
	const thRefute = optProb(th, "refute", D.thresholds.refute ?? 0.1, "jevcheck.thresholds");
	const thWeak = optProb(th, "weak", D.thresholds.weak ?? 0.2, "jevcheck.thresholds");
	if (thRefute > thWeak) {
		throw new ConfigError(`jevcheck.thresholds.refute(${thRefute}) 必须 ≤ weak(${thWeak})（分档语义倒置）`);
	}
	const thickEnabled = optBool(factThicken, "enabled", false, "jevcheck.factThicken");
	const grayEnabled = optBool(grayEnrich, "enabled", false, "jevcheck.grayEnrich");
	if (grayEnabled && !thickEnabled) throw new ConfigError("jevcheck.grayEnrich.enabled=true 要求 jevcheck.factThicken.enabled=true");
	const quoteEnabled = optBool(quote, "enabled", false, "jevcheck.quote");
	const quoteRequired = optBool(quote, "required", false, "jevcheck.quote");
	if (quoteRequired && !quoteEnabled) throw new ConfigError("jevcheck.quote.required=true 要求 jevcheck.quote.enabled=true");
	const categoryEnabled = optBool(category, "enabled", false, "jevcheck.category");
	const autoRouteEnabled = optBool(categoryAutoRoute, "enabled", false, "jevcheck.categoryAutoRoute");
	if (autoRouteEnabled && !categoryEnabled) throw new ConfigError("jevcheck.categoryAutoRoute.enabled=true 要求 jevcheck.category.enabled=true");
	const odTypedEnabled = optBool(odTyped, "enabled", false, "jevcheck.odTyped");
	const odTypedGatesOnly = optBool(odTyped, "gatesOnly", false, "jevcheck.odTyped");
	if (odTypedEnabled && !categoryEnabled) throw new ConfigError("jevcheck.odTyped.enabled=true 要求 jevcheck.category.enabled=true");
	if (odTypedGatesOnly && !odTypedEnabled) throw new ConfigError("jevcheck.odTyped.gatesOnly=true 要求 jevcheck.odTyped.enabled=true");
	return {
		enabled: optBool(o, "enabled", D.enabled, "jevcheck"),
		url,
		concurrency: optPosInt(o, "concurrency", D.concurrency, "jevcheck", JEVCHECK_MAX_CONCURRENCY),
		perCallTimeoutMs: optPosInt(o, "perCallTimeoutMs", D.perCallTimeoutMs, "jevcheck"),
		clientMode,
		budget: {
			maxCalls: optPosInt(budget, "maxCalls", D.budget.maxCalls, "jevcheck.budget"),
			maxMs: optPosInt(budget, "maxMs", D.budget.maxMs, "jevcheck.budget"),
			tableMaxChars: optPosInt(budget, "tableMaxChars", D.budget.tableMaxChars, "jevcheck.budget"),
		},
		thresholds: {
			fact: {
				high: optProb(thFact, "high", D.thresholds.fact.high, "jevcheck.thresholds.fact"),
				low: optProb(thFact, "low", D.thresholds.fact.low, "jevcheck.thresholds.fact"),
			},
			same: {
				merge: optProb(thSame, "merge", D.thresholds.same.merge, "jevcheck.thresholds.same"),
				flag: optProb(thSame, "flag", D.thresholds.same.flag, "jevcheck.thresholds.same"),
			},
			conflict: {
				sameMin: optProb(thConflict, "sameMin", D.thresholds.conflict.sameMin, "jevcheck.thresholds.conflict"),
				oppositeMin: optProb(thConflict, "oppositeMin", D.thresholds.conflict.oppositeMin, "jevcheck.thresholds.conflict"),
			},
			entail: { low: optProb(thEntail, "low", D.thresholds.entail.low, "jevcheck.thresholds.entail") },
			refute: thRefute,
			weak: thWeak,
		},
		premiseRound: {
			enabled: optBool(pr, "enabled", D.premiseRound.enabled, "jevcheck.premiseRound"),
			maxFindings: optPosInt(pr, "maxFindings", D.premiseRound.maxFindings, "jevcheck.premiseRound"),
			concurrency: optPosInt(pr, "concurrency", D.premiseRound.concurrency, "jevcheck.premiseRound"),
			perCallMs: optPosInt(pr, "perCallMs", D.premiseRound.perCallMs, "jevcheck.premiseRound"),
		},
		fixPresent: {
			enabled: optBool(fixPresent, "enabled", D.fixPresent.enabled, "jevcheck.fixPresent"),
		},
		factRefDirect: { enabled: optBool(factRefDirect, "enabled", false, "jevcheck.factRefDirect") },
		gapList: { enabled: optBool(gapList, "enabled", false, "jevcheck.gapList") },
		gapCarryForward: { enabled: optBool(gapCarryForward, "enabled", false, "jevcheck.gapCarryForward") },
		quote: { enabled: quoteEnabled, required: quoteRequired },
		stateExpansion: { enabled: optBool(stateExpansion, "enabled", false, "jevcheck.stateExpansion") },
		factThicken: { enabled: thickEnabled },
		grayEnrich: { enabled: grayEnabled },
		category: { enabled: categoryEnabled },
		chainEvidenceGate: { enabled: optBool(chainEvidenceGate, "enabled", false, "jevcheck.chainEvidenceGate") },
		categoryAutoRoute: { enabled: autoRouteEnabled },
		odTyped: { enabled: odTypedEnabled, gatesOnly: odTypedGatesOnly },
		entailBridge: { enabled: optBool(entailBridge, "enabled", false, "jevcheck.entailBridge") },
		sampling: {
			fact: optPosInt(sampling, "fact", D.sampling.fact, "jevcheck.sampling", 5),
			entail: optPosInt(sampling, "entail", D.sampling.entail, "jevcheck.sampling", 5),
			same: optPosInt(sampling, "same", D.sampling.same, "jevcheck.sampling", 5),
			opposite: optPosInt(sampling, "opposite", D.sampling.opposite, "jevcheck.sampling", 5),
			fixed: optPosInt(sampling, "fixed", D.sampling.fixed, "jevcheck.sampling", 5),
			link: optPosInt(sampling, "link", D.sampling.link ?? 2, "jevcheck.sampling", 5),
		},
		submit: {
			required: optBool(submit, "required", D.submit.required, "jevcheck.submit"),
			maxAttempts: optPosInt(submit, "maxAttempts", D.submit.maxAttempts, "jevcheck.submit"),
		},
		verdicts: {
			required: optBool(verdicts, "required", D.verdicts.required, "jevcheck.verdicts"),
			maxAttempts: optPosInt(verdicts, "maxAttempts", D.verdicts.maxAttempts, "jevcheck.verdicts"),
			reasonMaxChars: optPosInt(verdicts, "reasonMaxChars", D.verdicts.reasonMaxChars, "jevcheck.verdicts"),
		},
		// ---- C1（finding 真伪判定设计 §5/§4.8，波4）----
		chain: {
			enabled: optBool(chain, "enabled", D.chain?.enabled ?? false, "jevcheck.chain"),
			minSteps: chainMinSteps,
			maxSteps: chainMaxSteps,
		},
		mech: {
			enabled: optBool(mech, "enabled", D.mech?.enabled ?? true, "jevcheck.mech"),
			scopePad: optPosInt(mech, "scopePad", D.mech?.scopePad ?? 20, "jevcheck.mech"),
			minTokenLen: optPosInt(mech, "minTokenLen", D.mech?.minTokenLen ?? 3, "jevcheck.mech"),
		},
	};
}

// ---- 不变量校验（DESIGN §4.5）----

/**
 * 跑全部加载期不变量。违反即 throw ConfigError。
 * 供 loadConfig 内部调用；也导出以便测试/临时覆盖场景直接校验内存 config。
 */
export function validateConfig(cfg: MoaConfig): void {
	const providerKeys = new Set(Object.keys(cfg.providers));
	if (providerKeys.size === 0) {
		throw new ConfigError("providers 为空：至少要有一个 provider");
	}
	const presetKeys = Object.keys(cfg.presets);
	if (presetKeys.length === 0) {
		throw new ConfigError("presets 为空：至少要有一个 preset");
	}

	for (const [name, preset] of Object.entries(cfg.presets)) {
		// 不变量①：proposer + aggregator 的 provider 必须在 providers 里。
		//         （profile 存在性/合法性已在 parseWorkerRef 里 fail-loud。）
		const refs: Array<{ ref: WorkerRef; label: string }> = [
			...preset.proposers.map((ref, i) => ({
				ref,
				label: `presets.${name}.proposers[${i}]`,
			})),
			{ ref: preset.aggregator, label: `presets.${name}.aggregator` },
			// 降级备胎同样受不变量① 约束：否则备胎指向未注册 provider，要等真降级时才 fail。
			...(preset.aggregatorFallback
				? [
						{
							ref: preset.aggregatorFallback,
							label: `presets.${name}.aggregatorFallback`,
						},
					]
				: []),
		];
		for (const { ref, label } of refs) {
			if (!providerKeys.has(ref.provider)) {
				throw new ConfigError(
					`不变量① 违反：${label}.provider="${ref.provider}" 不在 providers 中（已注册：${[
						...providerKeys,
					].join(", ")}）`,
				);
			}
		}

		// 不变量②：verify preset 的 aggregator.profile ∈ {verify-worker, delivery-readonly-worker}。
		if (
			preset.mode === "verify" &&
			!VERIFY_AGGREGATOR_PROFILES.includes(preset.aggregator.profile)
		) {
			throw new ConfigError(
				`不变量② 违反：presets.${name} 为 verify 模式，aggregator.profile 必须 ∈ {${VERIFY_AGGREGATOR_PROFILES.join(
					", ",
				)}}，实际为 "${preset.aggregator.profile}"（否则聚合器可写、只读被击穿，闭合审核🔴#1）`,
			);
		}

		// 不变量②（降级备胎）：备胎若可写，verify 的只读边界就多一个后门——降级一发生就被击穿。
		if (
			preset.mode === "verify" &&
			preset.aggregatorFallback &&
			!VERIFY_AGGREGATOR_PROFILES.includes(preset.aggregatorFallback.profile)
		) {
			throw new ConfigError(
				`不变量② 违反：presets.${name} 为 verify 模式，aggregatorFallback.profile 必须 ∈ {${VERIFY_AGGREGATOR_PROFILES.join(
					", ",
				)}}，实际为 "${preset.aggregatorFallback.profile}"（降级路径不得成为 verify 只读的后门）`,
			);
		}
	}

	// 不变量④：apiKeyEnv 指向的环境变量必须存在，否则运行时才 401。
	for (const [key, provider] of Object.entries(cfg.providers)) {
		if (provider.apiKeyEnv !== undefined) {
			const val = process.env[provider.apiKeyEnv];
			if (val === undefined || val === "") {
				throw new ConfigError(
					`不变量④ 违反：providers.${key}.apiKeyEnv="${provider.apiKeyEnv}" 指向的环境变量未设置（否则运行时才 401，加载期即挡）`,
				);
			}
		}
	}

	// 不变量⑤：超时三嵌套。
	const { referencePerCallMs, aggregatorPerCallMs, moaTotalBackstopMs } =
		cfg.timeouts;
	// ⑤-a：backstop ≥ 各阶段 per_call。
	if (moaTotalBackstopMs < aggregatorPerCallMs) {
		throw new ConfigError(
			`不变量⑤-a 违反：moaTotalBackstopMs(${moaTotalBackstopMs}) < aggregatorPerCallMs(${aggregatorPerCallMs})；外层会先掐断，aggregator per_call 形同虚设`,
		);
	}
	if (moaTotalBackstopMs < referencePerCallMs) {
		throw new ConfigError(
			`不变量⑤-a 违反：moaTotalBackstopMs(${moaTotalBackstopMs}) < referencePerCallMs(${referencePerCallMs})`,
		);
	}
	// ⑤-d：请求级 idle 看门狗阈值的**三条**上界 + 正整数（2026-09-22）。
	//   ① 必须 < referencePerCallMs：看门狗同时装在 **proposer** 腿上（那条腿的会话预算就是
	//      referencePerCallMs）。若阈值 ≥ 它，会话级 abort 永远先到 ⇒ 该腿看门狗形同虚设。
	//   ② 必须 < aggregatorPerCallMs：看门狗**也**装在 **aggregator** 腿上（orchestrate.ts 里两条
	//      runSession 调用都传 idleMs），那条腿的会话预算是 aggregatorPerCallMs。只比 reference 会
	//      留一个缺口：`aggregatorPerCallMs < requestIdleMs < referencePerCallMs` 时加载期放行，
	//      但聚合器腿的看门狗被会话级 abort 静默架空（主代理 R3 F1 已用真 loadConfig 复现）。
	//      ⇒ 上界取 min(referencePerCallMs, aggregatorPerCallMs)。
	//   ③ 必须 < 300000（undici 默认空闲 body 超时）：主代理实测卡死流由 **undici 的 `bodyTimeout`
	//      默认 300_000ms** 先掐断（301.2s 抛 UND_ERR_BODY_TIMEOUT／message 含 `terminated`，该词恰好
	//      命中 pi 可重试正则）。配到 ≥ 300000 时 undici 永远先到点、我们的看门狗**永远不会触发**
	//      ⇒ 等于把修复静默退回改造前的隐式 300s，加载期还看不出来。
	//   为什么正整数：阈值语义是毫秒计数，0/负数会让 setTimeout 立即触发、把每次请求都误杀。
	//   parseTimeouts 已在 yaml 路径上校过一次（requirePosInt，且该键必填）；这里再校一遍是为了
	//   **内存直构 config**（测试、临时覆盖）也走同一道闸；内存直构若省略该键（undefined），
	//   runSession 视同不启用看门狗（= 改造前行为），绝不静默编一个缺省值出来。
	const requestIdleMs = cfg.timeouts.requestIdleMs;
	if (requestIdleMs !== undefined) {
		if (!Number.isInteger(requestIdleMs) || requestIdleMs <= 0) {
			throw new ConfigError(
				`不变量⑤-d 违反：timeouts.requestIdleMs(${requestIdleMs}) 必须是正整数（毫秒）；0/负数会让看门狗立即触发并误杀正常请求`,
			);
		}
		if (requestIdleMs >= UNDICI_DEFAULT_BODY_TIMEOUT_MS) {
			throw new ConfigError(
				`不变量⑤-d 违反：timeouts.requestIdleMs(${requestIdleMs}) 必须 < ${UNDICI_DEFAULT_BODY_TIMEOUT_MS}（Node undici 默认空闲 body 超时）；` +
					`配到该值及以上时 undici 会先以 UND_ERR_BODY_TIMEOUT／"terminated" 掐断，本看门狗永远不会先到点 ⇒ 等于隐式退回改造前的 300s 行为，修复被静默关掉`,
			);
		}
		if (requestIdleMs >= referencePerCallMs) {
			throw new ConfigError(
				`不变量⑤-d 违反：timeouts.requestIdleMs(${requestIdleMs}) 必须 < referencePerCallMs(${referencePerCallMs})（proposer 腿的 per_call）；` +
					`否则该腿会话级 abort 永远先于请求级看门狗到点，看门狗形同虚设（真卡顿仍会吃满整个 per_call）`,
			);
		}
		if (requestIdleMs >= aggregatorPerCallMs) {
			throw new ConfigError(
				`不变量⑤-d 违反：timeouts.requestIdleMs(${requestIdleMs}) 必须 < aggregatorPerCallMs(${aggregatorPerCallMs})（聚合器腿的 per_call）；` +
					`看门狗同样装在 aggregator 腿上，否则该腿会话级 abort 会先于看门狗到点、聚合器腿的看门狗形同虚设`,
			);
		}
	}
	// ⑤-b：backstop ≥ max(reference) + jevcheck（仅 enabled 时计入）+ aggregator
	//   （proposers 并行取 max → jevcheck 串行一段 → 再串 aggregator；Jev 辅助代码审查设计 v4 §6 / 裁决 C5：
	//   540,000 + 90,000 + 720,000 = 1,350,000，现值恰好成立，backstop 不抬）。
	//   内存直构 config（测试 fixture）可无 jevcheck 段 ⇒ 视同 enabled=false，不计入。
	const jev = cfg.jevcheck;
	const jevMs = jev?.enabled ? jev.budget.maxMs : 0;
	const serialChain = referencePerCallMs + jevMs + aggregatorPerCallMs;
	if (moaTotalBackstopMs < serialChain) {
		throw new ConfigError(
			`不变量⑤-b 违反：moaTotalBackstopMs(${moaTotalBackstopMs}) < referencePerCallMs+jevcheck.budget.maxMs(enabled 时)+aggregatorPerCallMs` +
				`(${referencePerCallMs}+${jevMs}+${aggregatorPerCallMs}=${serialChain})；总预算覆盖不了 proposer→jevcheck→aggregator 串行链`,
		);
	}
	// jevcheck 补前提回合的时间账（设计 v4 §6，2026-09-20 起**无条件**校验）：
	//   perCallMs × ceil(maxFindings / concurrency) ≤ budget.maxMs。
	//   只要 cfg.jevcheck 存在（经 parseJevcheck 解析，含全部缺省值）就校，与 enabled / premiseRound.enabled
	//   开关无关——缺省值 30,000 × ceil(10/10)=1 → 30,000 ≤ 90,000 满足，不会挡住缺省配置加载。
	//   内存直构 config（测试 fixture）若整段省略 jevcheck 才不计入（此时 jev 为 undefined）。
	if (jev) {
		const waves = Math.ceil(jev.premiseRound.maxFindings / jev.premiseRound.concurrency);
		const need = jev.premiseRound.perCallMs * waves;
		if (need > jev.budget.maxMs) {
			throw new ConfigError(
				`jevcheck.premiseRound 时间账不闭合：perCallMs(${jev.premiseRound.perCallMs}) × ceil(maxFindings ${jev.premiseRound.maxFindings} / concurrency ${jev.premiseRound.concurrency})=${waves}` +
					` = ${need}ms > jevcheck.budget.maxMs(${jev.budget.maxMs})；调小 perCallMs/maxFindings 或调大 concurrency/budget.maxMs（后者受不变量⑤-b 约束）`,
			);
		}
	}
	// jevcheck 阈值大小关系：fact.low < fact.high、same.flag < same.merge（否则分档语义倒置）。
	if (jev) {
		if (jev.thresholds.fact.low >= jev.thresholds.fact.high) {
			throw new ConfigError(
				`jevcheck.thresholds.fact.low(${jev.thresholds.fact.low}) 必须 < fact.high(${jev.thresholds.fact.high})`,
			);
		}
		if (jev.thresholds.same.flag >= jev.thresholds.same.merge) {
			throw new ConfigError(
				`jevcheck.thresholds.same.flag(${jev.thresholds.same.flag}) 必须 < same.merge(${jev.thresholds.same.merge})`,
			);
		}
	}
	// ⑤-c：per_call 与 backstop 不得超过 pi-mcp 绝对上限（30min）。
	for (const [field, v] of [
		["referencePerCallMs", referencePerCallMs],
		["aggregatorPerCallMs", aggregatorPerCallMs],
		["moaTotalBackstopMs", moaTotalBackstopMs],
	] as const) {
		if (v > PI_MCP_ABS_MAX_MS) {
			throw new ConfigError(
				`不变量⑤-c 违反：timeouts.${field}(${v}) 超过 pi-mcp 绝对上限 ${PI_MCP_ABS_MAX_MS}ms(30min)，外层会先掐断`,
			);
		}
	}

	// 不变量⑦：access.readRoots 必须绝对/存在/是目录/不覆盖 $HOME 或 "/"（2026-08-04 跨仓只读根）。
	//   parseAccess 已在 yaml 路径上校验过；这里再校一遍是为了**内存直构 config** 的路径
	//   （测试、临时覆盖）也走同一道闸——canonicalizeReadRoots 对已归一的输入幂等，重复校验无副作用。
	try {
		canonicalizeReadRoots(cfg.access?.readRoots ?? []);
	} catch (err) {
		if (err instanceof ReadRootError) {
			throw new ConfigError(`不变量⑦ 违反：${err.message}`);
		}
		throw err;
	}

	// 不变量⑥：defaults.preset 必须存在于 presets。
	if (!Object.prototype.hasOwnProperty.call(cfg.presets, cfg.defaults.preset)) {
		throw new ConfigError(
			`不变量⑥ 违反：defaults.preset="${cfg.defaults.preset}" 不在 presets 中（已定义：${presetKeys.join(
				", ",
			)}）`,
		);
	}
}

/** 把 yaml 解析结果收敛成 MoaConfig（结构层 fail-loud），不含跨字段不变量。 */
function parseMoaConfig(raw: unknown): MoaConfig {
	const root = requireObject(raw, "配置根");

	const providersRaw = requireObject(root.providers, "providers");
	const providers: Record<string, ProviderCfg> = {};
	for (const [key, v] of Object.entries(providersRaw)) {
		providers[key] = parseProvider(v, key);
	}

	const presetsRaw = requireObject(root.presets, "presets");
	const presets: Record<string, Preset> = {};
	for (const [key, v] of Object.entries(presetsRaw)) {
		presets[key] = parsePreset(v, key);
	}

	const timeouts = parseTimeouts(root.timeouts);

	const defaultsRaw = requireObject(root.defaults, "defaults");
	const defaults = { preset: requireString(defaultsRaw.preset, "defaults.preset") };

	const access = parseAccess(root.access);

	const jevcheck = parseJevcheck(root.jevcheck);

	const http = parseHttp(root.http);

	return { providers, presets, timeouts, defaults, access, jevcheck, http };
}

/**
 * moa.yaml ↔ models.json 加载期交叉校验（fail-loud）。
 *
 * 背景：moa.yaml 的 providers 块（baseUrl/apiKeyEnv）**运行期完全不生效**——真正生效的是
 * config/models.json（pi ModelRuntime 读它）。因此不变量④若只校 moa.yaml.apiKeyEnv，校的是个
 * 无用变量；改 moa.yaml 的 endpoint 也不会生效，易误判。这里额外读 models.json 交叉校验：
 *   ① moa.yaml presets 引用的每个 provider 必须在 models.json 里存在；
 *   ② moa.yaml provider 的 apiKeyEnv 必须与 models.json 该 provider 的 apiKey（"$XXX"）引用的
 *      env 变量名一致；
 *   ③ 不一致 → fail-loud（明确报哪个 provider 的 env 名对不上）。
 * 这样不变量④ 校的就是真正生效的 env，且 moa.yaml↔models.json 漂移会被启动期挡住。
 */
function crossValidateModels(cfg: MoaConfig, modelsPath: string): void {
	let text: string;
	try {
		text = readFileSync(modelsPath, "utf8");
	} catch (err) {
		throw new ConfigError(
			`读取 models.json 失败：${modelsPath}：${(err as Error).message}` +
				`（moa.yaml 的 providers 运行期不生效，真源是 models.json；缺失则无法交叉校验，拒绝带病启动）`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new ConfigError(
			`models.json JSON 解析失败：${modelsPath}：${(err as Error).message}`,
		);
	}
	const root = requireObject(raw, `models.json 根（${modelsPath}）`);
	const provRaw = requireObject(root.providers, `models.json.providers（${modelsPath}）`);

	// 收集 moa.yaml presets 引用的 provider（proposers + aggregator + aggregatorFallback）。
	// v4 §4.5(审查 C10):此前 fallback 不进 referenced,其 provider/model id 全不校验——
	// fallback 打错名字启动全绿、真降级时才炸,恰与本函数"启动期挡漂移"的宗旨相反。
	const referenced = new Set<string>();
	for (const preset of Object.values(cfg.presets)) {
		for (const p of preset.proposers) referenced.add(p.provider);
		referenced.add(preset.aggregator.provider);
		if (preset.aggregatorFallback) referenced.add(preset.aggregatorFallback.provider);
	}

	for (const name of referenced) {
		const mp = provRaw[name];
		// ① 引用的 provider 必须在 models.json（运行期真源）。
		if (!Object.prototype.hasOwnProperty.call(provRaw, name) || !isObject(mp)) {
			throw new ConfigError(
				`moa.yaml↔models.json 漂移：preset 引用的 provider "${name}" 在 models.json 中不存在` +
					`（运行期真源是 models.json；已注册：${Object.keys(provRaw).join(", ") || "（空）"}）`,
			);
		}
		// ② apiKeyEnv 必须与 models.json 该 provider 的 apiKey（"$XXX"）引用的 env 名一致。
		//   （referenced ⊆ cfg.providers，已由不变量① 保证，故 cfg.providers[name] 必存在。）
		const moaProv = cfg.providers[name];
		if (moaProv?.apiKeyEnv !== undefined) {
			const apiKey = mp.apiKey;
			if (typeof apiKey !== "string" || !apiKey.startsWith("$")) {
				throw new ConfigError(
					`moa.yaml↔models.json 漂移：models.json providers.${name}.apiKey 缺失或非 "$ENV" 形式` +
						`（moa.yaml.apiKeyEnv="${moaProv.apiKeyEnv}" 无从核对；实际 apiKey=${JSON.stringify(apiKey)}）`,
				);
			}
			const modelsEnv = apiKey.slice(1);
			if (modelsEnv !== moaProv.apiKeyEnv) {
				throw new ConfigError(
					`moa.yaml↔models.json 漂移：provider "${name}" 的 env 名对不上——` +
						`moa.yaml.apiKeyEnv="${moaProv.apiKeyEnv}"，但运行期真源 models.json apiKey="$${modelsEnv}"。` +
						`不变量④ 只有对上真源才校到真正生效的 env。`,
				);
			}
		}
	}

	// ③ 每个 preset 引用的 model id 必须在 models.json 该 provider 的 models[].id 里（2026-08-03 补）。
	//   背景：此前只校 provider 存在（①）与 env 名（②），**从不校 model id**。后果——moa.yaml 把某
	//   proposer/aggregator 的 model 写成 models.json 里没有的名字（换模型只改 yaml 没同步 json、
	//   打错字），启动期不变量①~⑥ 全绿，直到**运行期首次调用** session.ts 的
	//   `modelRuntime.getModel(provider, model)` 返回 null → "模型未找到" → proposer 失败 →
	//   **首轮 fail-closed**。即"一个不受支持的模型名"能骗过整个启动校验、只在第一次真跑时炸。
	//   与 provider 漂移被启动挡住形成不对称缺口，此处补齐成启动期 fail-loud（同类校验一次补全）。
	const modelIdsByProvider = new Map<string, Set<string>>();
	for (const name of referenced) {
		// name ∈ referenced ⇒ 上方① 已保证 provRaw[name] 是对象。
		const mp = provRaw[name] as Json;
		const ids = new Set<string>();
		if (Array.isArray(mp.models)) {
			for (const m of mp.models) {
				if (isObject(m) && typeof m.id === "string" && m.id.length > 0) ids.add(m.id);
			}
		}
		modelIdsByProvider.set(name, ids);
	}
	for (const [presetName, preset] of Object.entries(cfg.presets)) {
		const refs: Array<{ ref: WorkerRef; label: string }> = [
			...preset.proposers.map((ref, i) => ({
				ref,
				label: `presets.${presetName}.proposers[${i}]`,
			})),
			{ ref: preset.aggregator, label: `presets.${presetName}.aggregator` },
			...(preset.aggregatorFallback
				? [
						{
							ref: preset.aggregatorFallback,
							label: `presets.${presetName}.aggregatorFallback`,
						},
					]
				: []),
		];
		for (const { ref, label } of refs) {
			const ids = modelIdsByProvider.get(ref.provider);
			// ids 必存在：ref.provider ∈ referenced（收集自同一份 presets）。防御性判空以饱和类型。
			if (!ids || !ids.has(ref.model)) {
				const known = ids && ids.size > 0 ? [...ids].join(", ") : "（该 provider 无任何 model）";
				throw new ConfigError(
					`moa.yaml↔models.json 漂移：${label} 引用的 model "${ref.provider}/${ref.model}" ` +
						`在 models.json providers.${ref.provider}.models 中不存在（运行期真源是 models.json；` +
						`该 provider 已注册 model：${known}）。` +
						`不挡则启动期放行、运行期首次调用才报"模型未找到"→ 首轮 fail-closed。`,
				);
			}
		}
	}

	// ⑦ 窗口预算验算（v4 §4.5,2026-08-25）：逐 preset(含 aggregatorFallback)按
	//   「有效窗口 = contextWindow×0.8,材料+取证+输出+包装 ≤ 有效窗口」验算,不闭合拒绝启动。
	//   数据来源:models.json 各 model 的 contextWindow(可选 contextWindowMeasured 优先,实测值)
	//   与 maxTokens。**诚实声明**:本校验只证明配置自洽,不证明 contextWindow 官方值真实
	//   (虚标史:claude-opus-4-8 曾虚标 1,048,576,见 src/moa/recon.ts 订正注释);换模型仍须实测探窗。
	//   条目缺 contextWindow/maxTokens 数字时跳过该跳(测试/内存直构 fixture 常无窗口字段,
	//   不因此误伤;真源 models.json 现役条目字段齐全,必被验算)。
	const modelNumsByProvider = new Map<string, Map<string, { cw: number; maxTok: number }>>();
	for (const name of referenced) {
		const mp = provRaw[name] as Json;
		const nums = new Map<string, { cw: number; maxTok: number }>();
		if (Array.isArray(mp.models)) {
			for (const m of mp.models) {
				if (!isObject(m) || typeof m.id !== "string") continue;
				const measured = Number((m as Record<string, unknown>).contextWindowMeasured);
				const cw = Number.isFinite(measured) && measured > 0 ? measured : Number(m.contextWindow);
				const maxTok = Number(m.maxTokens);
				if (Number.isFinite(cw) && cw > 0 && Number.isFinite(maxTok) && maxTok > 0) {
					nums.set(m.id, { cw, maxTok });
				}
			}
		}
		modelNumsByProvider.set(name, nums);
	}
	const numsOf = (ref: WorkerRef): { cw: number; maxTok: number } | undefined =>
		modelNumsByProvider.get(ref.provider)?.get(ref.model);
	// P2 静态审查 F7:缺数字的跳过不再全静默——收集后统一警告(生产真源应字段齐全;
	// 测试/内存直构 fixture 常无窗口字段,允许跳过但留痕,分级于"不闭合拒启动")。
	const skippedHops: string[] = [];
	for (const [presetName, preset] of Object.entries(cfg.presets)) {
		const mode = preset.mode === "verify" ? "verify" : "synthesize";
		const material = materialBudgetChars(mode);
		const retrieval = retrievalCharBudget(mode);
		for (const [i, w] of preset.proposers.entries()) {
			const n = numsOf(w);
			if (!n) {
				skippedHops.push(`presets.${presetName}.proposers[${i}](${w.provider}/${w.model})`);
				continue;
			}
			const effective = Math.floor(n.cw * EFFECTIVE_WINDOW_RATIO);
			const need = material + retrieval + n.maxTok + PROPOSER_OVERHEAD_CHARS;
			if (need > effective) {
				throw new ConfigError(
					`窗口预算不闭合(不变量⑦,v4 §4.2)：presets.${presetName}.proposers[${i}] ` +
						`${w.provider}/${w.model} 需 材料${material}+取证${retrieval}+输出${n.maxTok}+包装${PROPOSER_OVERHEAD_CHARS}` +
						`=${need} > 有效窗口 ${effective}(contextWindow ${n.cw}×${EFFECTIVE_WINDOW_RATIO})。` +
						`调整 env PIMOA_MATERIAL_BUDGET_CHARS / PIMOA_RETRIEVAL_CHAR_BUDGET 或换更大窗口模型。`,
				);
			}
		}
		const propOut = preset.proposers.reduce((s, w) => s + (numsOf(w)?.maxTok ?? 0), 0);
		const aggHops: Array<{ ref: WorkerRef; label: string }> = [
			{ ref: preset.aggregator, label: `presets.${presetName}.aggregator` },
			...(preset.aggregatorFallback
				? [{ ref: preset.aggregatorFallback, label: `presets.${presetName}.aggregatorFallback` }]
				: []),
		];
		for (const { ref, label } of aggHops) {
			const n = numsOf(ref);
			if (!n) {
				skippedHops.push(`${label}(${ref.provider}/${ref.model})`);
				continue;
			}
			const effective = Math.floor(n.cw * EFFECTIVE_WINDOW_RATIO);
			const need = AGGREGATOR_OVERHEAD_CHARS + material + propOut + n.maxTok;
			if (need > effective) {
				throw new ConfigError(
					`窗口预算不闭合(不变量⑦,v4 §4.2)：${label} ${ref.provider}/${ref.model} 需 ` +
						`包装${AGGREGATOR_OVERHEAD_CHARS}+材料${material}+Σproposer输出${propOut}+自身输出${n.maxTok}` +
						`=${need} > 有效窗口 ${effective}(contextWindow ${n.cw}×${EFFECTIVE_WINDOW_RATIO})。`,
				);
			}
		}
	}
	if (skippedHops.length > 0) {
		console.error(
			`[config] ⚠️ 不变量⑦ 跳过 ${skippedHops.length} 跳(models.json 条目缺 contextWindow/maxTokens 数字,无法验算窗口预算): ` +
				`${skippedHops.join(", ")} —— 生产真源应补齐字段;仅测试/内存 fixture 可忽略本警告。`,
		);
	}
}

export interface LoadConfigPaths {
	/** moa.yaml 的路径（绝对或相对 cwd）。 */
	moaYaml: string;
	/** models.json 路径（缺省 = moa.yaml 同目录的 models.json）。运行期真源，用于加载期交叉校验。 */
	modelsJson?: string;
}

/**
 * 读取 moa.yaml → 解析成 MoaConfig → 跑加载期不变量强校验。
 * 任一环节违规即 throw ConfigError（fail-loud，绝不带病返回）。
 */
export function loadConfig(paths: LoadConfigPaths): MoaConfig {
	let text: string;
	try {
		text = readFileSync(paths.moaYaml, "utf8");
	} catch (err) {
		throw new ConfigError(
			`读取配置文件失败：${paths.moaYaml}：${(err as Error).message}`,
		);
	}

	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (err) {
		throw new ConfigError(
			`YAML 解析失败：${paths.moaYaml}：${(err as Error).message}`,
		);
	}

	const cfg = parseMoaConfig(raw);
	validateConfig(cfg);
	// 不变量⑧(P3 复审 F5):排队超时 + 总 backstop 必须 < 客户端 tool_timeout 下限 1,410s
	// (PiMoa_Codex使用说明 §一的两端契约)。排队不占 backstop,二者相加才是客户端观测的最坏墙钟;
	// 将来谁把 backstop 调大而忘了这笔账,启动即拦,而不是等排队后的调用被客户端掐掉白烧算力。
	const CLIENT_TOOL_TIMEOUT_FLOOR_MS = 1_410_000;
	if (GATE_QUEUE_TIMEOUT_MS + cfg.timeouts.moaTotalBackstopMs >= CLIENT_TOOL_TIMEOUT_FLOOR_MS) {
		throw new ConfigError(
			`不变量⑧ 违反：并发闸排队超时(${GATE_QUEUE_TIMEOUT_MS}ms) + moaTotalBackstopMs` +
				`(${cfg.timeouts.moaTotalBackstopMs}ms) = ${GATE_QUEUE_TIMEOUT_MS + cfg.timeouts.moaTotalBackstopMs}ms` +
				` ≥ 客户端 tool_timeout 下限 ${CLIENT_TOOL_TIMEOUT_FLOOR_MS}ms——排队后的调用会被客户端超时掐掉白烧算力。` +
				"调小 backstop 或 PIMOA_QUEUE_TIMEOUT_MS。",
		);
	}
	// moa.yaml↔models.json 交叉校验（缺省读 moa.yaml 同目录的 models.json，即运行期真源）。
	const modelsPath = paths.modelsJson ?? join(dirname(paths.moaYaml), "models.json");
	crossValidateModels(cfg, modelsPath);
	return cfg;
}
