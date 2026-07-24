// Pi-MoA 共享契约 · 配置类型（由主 agent 钉死，Coder A 实现 loadConfig、Coder B 只读）
// 对应 DESIGN §4.5。改动此文件须经主 agent。

export type ProviderKind = "openai" | "anthropic";

export interface ProviderCfg {
	kind: ProviderKind;
	baseUrl: string;
	/** 环境变量名，运行时从 env 读取 api_key；绝不落明文 */
	apiKeyEnv?: string;
}

export type ProfileName =
	| "synthesize-worker"
	| "verify-worker"
	| "delivery-readonly-worker";

export interface WorkerRef {
	provider: string; // 必须是 providers 里的 key
	model: string;
	profile: ProfileName;
}

export type Mode = "synthesize" | "verify";

export interface Preset {
	mode: Mode;
	/** 加载期锁死 = "all"（全部 proposer 成功才放行）；拒绝更小值 fail-loud */
	quorum: "all";
	proposers: WorkerRef[];
	aggregator: WorkerRef;
}

export interface Timeouts {
	referencePerCallMs: number; // 每个 proposer 的 per_call
	aggregatorPerCallMs: number; // 聚合器 per_call（更宽）
	moaTotalBackstopMs: number; // MoA 总硬 backstop，必须 ≥ max(reference)+aggregator
}

export interface MoaConfig {
	providers: Record<string, ProviderCfg>;
	presets: Record<string, Preset>;
	timeouts: Timeouts;
	defaults: { preset: string };
}
