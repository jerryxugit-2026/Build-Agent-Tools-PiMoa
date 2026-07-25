// Pi-MoA 共享契约 · 编排 I/O 类型（由主 agent 钉死，Coder B 实现 runMoa）
// 对应 DESIGN §4/§4.6。改动此文件须经主 agent。

import type { Mode, MoaConfig, WorkerRef } from "../config/types.js";

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
}

export interface AggregatorResult {
	model: string;
	usage: Usage | null;
	costUsd: number;
	durationMs: number;
	sessionId?: string;
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
	bodySha256: string;
	totalCostUsd: number;
	delivery?: { written: boolean; path: string; sha256: string } | null;
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
