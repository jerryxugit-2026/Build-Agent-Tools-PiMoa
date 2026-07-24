// Pi-MoA · 配置加载 + 加载期不变量强校验（fail-loud）。
// 对应 DESIGN.md §4.5 加载期不变量。实现方：Coder A。
// 只读 config/types.ts 契约（import，不改）。违反不变量即 throw，启动即报错、绝不带病启动。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
	Mode,
	MoaConfig,
	Preset,
	ProfileName,
	ProviderCfg,
	ProviderKind,
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
	// 不变量③：quorum 锁死 = "all"，拒绝更小值 fail-loud。
	if (o.quorum !== "all") {
		throw new ConfigError(
			`presets.${key}.quorum 必须锁死为 "all"（全部 proposer 成功才放行），实际为 ${JSON.stringify(
				o.quorum,
			)}；配置化误配（如 1）会破坏 fail-closed（P0-5）`,
		);
	}
	if (!Array.isArray(o.proposers) || o.proposers.length === 0) {
		throw new ConfigError(`presets.${key}.proposers 必须是非空数组`);
	}
	const proposers = o.proposers.map((p, i) =>
		parseWorkerRef(p, `presets.${key}.proposers[${i}]`),
	);
	const aggregator = parseWorkerRef(o.aggregator, `presets.${key}.aggregator`);
	return { mode: mode as Mode, quorum: "all", proposers, aggregator };
}

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
	// ⑤-b：backstop ≥ max(reference) + aggregator（proposers 并行取 max，再串 aggregator）。
	const serialChain = referencePerCallMs + aggregatorPerCallMs;
	if (moaTotalBackstopMs < serialChain) {
		throw new ConfigError(
			`不变量⑤-b 违反：moaTotalBackstopMs(${moaTotalBackstopMs}) < referencePerCallMs+aggregatorPerCallMs(${serialChain})；总预算覆盖不了 proposer→aggregator 串行链`,
		);
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

	return { providers, presets, timeouts, defaults };
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

	// 收集 moa.yaml presets 引用的 provider（proposers + aggregator）。
	const referenced = new Set<string>();
	for (const preset of Object.values(cfg.presets)) {
		for (const p of preset.proposers) referenced.add(p.provider);
		referenced.add(preset.aggregator.provider);
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
	// moa.yaml↔models.json 交叉校验（缺省读 moa.yaml 同目录的 models.json，即运行期真源）。
	const modelsPath = paths.modelsJson ?? join(dirname(paths.moaYaml), "models.json");
	crossValidateModels(cfg, modelsPath);
	return cfg;
}
