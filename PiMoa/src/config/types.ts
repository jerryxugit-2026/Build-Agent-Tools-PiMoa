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

/**
 * 放行门槛（2026-07-25 引入分模式语义）：
 *  · `"all"`：全部 proposer 成功才聚合，否则 fail-closed。**verify 唯一合法值**。
 *  · `"tolerate-one"`：允许**最多 1 个** proposer 失败，且**成功数必须 ≥2**（少于 2 份就不再是
 *    "多模型交叉"、退化成单模型答案，故不放行）。**仅 synthesize 可用**，降级时 receipt 明确标注。
 *
 * 为什么 verify 不许降级：验真的全部价值在**独立交叉核验**——少一个独立验证者，
 * "两人分别核对过"的前提就不成立，此时给结论等于假装安全。
 * 为什么 synthesize 可以：少一份提议只是综合质量下降，结论本身仍然有效，全灭反而浪费。
 */
export type Quorum = "all" | "tolerate-one";

export interface Preset {
	mode: Mode;
	/** 见 Quorum：verify 强制 "all"；synthesize 可选 "tolerate-one"。缺省 "all"。 */
	quorum: Quorum;
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
