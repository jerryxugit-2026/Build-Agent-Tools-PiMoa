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
	/**
	 * 聚合器降级备胎（2026-08-18 徐总定）。可选；缺省 = 无降级，行为与改造前逐字节一致。
	 *
	 * 起因：2026-08-18 上游 Anthropic 容量事件，聚合器连吃两次 `Overloaded`，
	 * 而两个 proposer 两轮都已跑完 —— quorum=all + 单聚合器的结构让整轮作废、算力全废。
	 *
	 * 触发条件**严格受限**，只在主聚合器 `报错 / 正文为空 / 无 agent_end` 时换备胎重跑一次：
	 *  · **超时不触发** —— backstop 预算装不下第二次满额聚合
	 *    （max(referencePerCallMs) + 2×aggregatorPerCallMs 会超过 moaTotalBackstopMs），
	 *    且超时通常意味着上游整体不可用，重试只是把整轮拖到 backstop 才失败。
	 *  · **取消（abort）不触发** —— 那是调用方意图，不是故障。
	 *
	 * 不放宽任何不变量：profile 仍由 orchestrate 按 preset/forceProfile 强制下发；verify 模式下
	 * 本字段同样受不变量② 约束（只读 profile），否则降级路径会变成 verify 只读的后门。
	 * 降级成功时 receipt.aggregator.fallbackFrom / fallbackReason 如实记录被替换掉的主聚合器
	 * 与替换原因，绝不谎报成"一次就成"。
	 */
	aggregatorFallback?: WorkerRef;
}

export interface Timeouts {
	referencePerCallMs: number; // 每个 proposer 的 per_call
	aggregatorPerCallMs: number; // 聚合器 per_call（更宽）
	moaTotalBackstopMs: number; // MoA 总硬 backstop，必须 ≥ max(reference)+aggregator
	/**
	 * ★请求级 idle 看门狗阈值（ms，2026-09-22 新增）。
	 *
	 * `timeoutMs` 是整会话预算，一个 proposer 会话含最多 6 次工具调用往返；任一次流式请求卡住
	 * （HTTP 已发出、长时间不出任何 token）就会把整个 per_call 预算吃光并终结会话（2026-09-22
	 * 生产实测：当天 53 轮 7 轮 proposer 超时，全部是 `xiaomi/mimo-v2.5-pro`、全部精确卡在
	 * 540.0s = referencePerCallMs）。本键给**单次流式请求**定一个静默上限：超时即以可重试错误
	 * 收尾，交 pi 在同一会话预算内自动重试该请求。
	 *
	 * yaml 里**必填**（与 timeouts 其余三键同口径：缺失即 fail-loud，见 parseTimeouts）；给出的值须
	 * 为正整数且在加载期满足不变量 ⑤-d（严格小于 referencePerCallMs）。
	 *
	 * 类型上标可选只是为了让**内存直构 MoaConfig**（测试 fixture、临时覆盖）不必带这个键：此时
	 * `runSession` 视同未启用看门狗（= 改造前行为），绝不静默编一个值出来。
	 */
	requestIdleMs?: number;
}

/**
 * 读访问策略（2026-08-04 跨仓核查，徐总定）。
 *
 * 只管**读**，与 moa_deliver 的**写**根彻底分离：写根仍是调用方传的 cwd（mcp/server.ts 的
 * allowedRoots），本节配置绝不流向 deliver。之所以要分开，是因为把 cwd 抬到公共祖先虽然能顺带
 * 放开读，却会把**写**权限一起放大——那是安全倒退。
 *
 * 读根只能在**配置**里改：不接受工具入参、更不给 agent 自调的"加目录"工具（那等于让被审对象
 * 自己发通行证）。加载期强校验见 src/tools/access.ts 的 canonicalizeReadRoots。
 */
export interface AccessCfg {
	/**
	 * 额外只读根（绝对路径，加载期校验存在性并归一到 realpath）。
	 * 会话 cwd 恒为根之一，无需在此重复列出；本项为空 ⇒ 行为与改造前的单根完全一致。
	 */
	readRoots: string[];
}

/**
 * Jev 辅助代码审查（详细设计 v4 §6，2026-09-20）。仅作用于 verify 模式。
 *
 * `enabled=false`（灰度前缺省）= 不跑核对、不贴核对表、不注入任何新工具与新段，与旧版逐字节一致。
 * 全部缺省值见 src/config/load.ts parseJevcheck；越界值加载期 fail-loud 拒绝。
 */
export interface JevcheckCfg {
	enabled: boolean;
	/** Jev MCP 端点（JSON-RPC over HTTP）。 */
	url: string;
	/** 进程级单例信号量（跨轮共享），≤ 8（裁决 C8）。 */
	concurrency: number;
	perCallTimeoutMs: number;
	/**
	 * Jev 客户端协议代选择（官方 @modelcontextprotocol/client 2.0）：auto=先探 modern 再回落 legacy；
	 * modern=钉死 2026-07-28、不回落（协商到 legacy 即连接失败）；legacy=只走 initialize 握手。缺省 auto。
	 */
	clientMode: "auto" | "modern" | "legacy";
	/** maxMs 只在 enabled 时计入不变量⑤-b（ref + jevcheck + agg ≤ backstop）。 */
	budget: { maxCalls: number; maxMs: number; tableMaxChars: number };
	thresholds: {
		fact: { high: number; low: number };
		same: { merge: number; flag: number };
		conflict: { sameMin: number; oppositeMin: number };
		entail: { low: number };
		/**
		 * B4 真伪三态阈值（finding 真伪判定设计 §5 `thresholds.refute/weak`，C1 波4 接线）：
		 * refute=双采样一致证伪线（只喂 KILL/DOWNGRADE 档）；weak=弱证伪/中带线（DOWNGRADE-weak）。
		 * 可选（内存直构 config 可省）⇒ 缺省回落 src/config/limits.ts 的 JEVCHECK_REFUTE_P/WEAK_P（0.1/0.2）。
		 */
		refute?: number;
		weak?: number;
	};
	/** 补前提独立短会话（并行、无状态、不进 aggregator）。 */
	premiseRound: { enabled: boolean; maxFindings: number; concurrency: number; perCallMs: number };
	/** 修复是否已在（只进回执；证据未验，先省调用，缺省关）。 */
	fixPresent: { enabled: boolean };
	/** Batch 1a: opt-in direct location of 相符 factRef. */
	factRefDirect?: { enabled: boolean };
	/** Batch 1b: opt-in terminal gaps and diagnostic traces. */
	gapList?: { enabled: boolean };
	/** Batch 12: historical material-gap hints in proposer prompts; off by default. */
	gapCarryForward?: { enabled: boolean };
	/** Batch 4: opt-in verbatim material line anchors; required remains off pending canary. */
	quote?: { enabled: boolean; required: boolean };
	/** Batch 2: P0 function body + located P1 material closure. */
	stateExpansion?: { enabled: boolean };
	/** Batch 2: use the containing function body for fact state, with ±15 fallback. */
	factThicken?: { enabled: boolean };
	/** Batch 2: one asymmetric thick-state recheck for gray facts; requires factThicken. */
	grayEnrich?: { enabled: boolean };
	/** Batch 3 opt-in classification batteries; disabled means no schema/tool/prompt injection. */
	category?: { enabled: boolean };
	/** Batch 5: evidence-step reference presence only; never changes link sampling. */
	chainEvidenceGate?: { enabled: boolean };
	/** Batch 5: route unmarked test-file findings into the existing category battery. Requires category. */
	categoryAutoRoute?: { enabled: boolean };
	/** Typed overdesign battery; gatesOnly requests evidence gaps without emitting typed questions. */
	odTyped?: { enabled: boolean; gatesOnly?: boolean };
	/** Batch 5: mechanical missing-premise entity names in terminal entail gaps. */
	entailBridge?: { enabled: boolean };
	/** 各问法采样次数（设计 v4 §4「时间优化」；每项 1..5 的正整数）。fixed 对应 "fixed" 问法（波二修复单 18：
	 * 此前取 jevcheck.ts 内局部常量 `JEV_FIXED_SAMPLES`，未受 cfg.sampling 统一管辖，缺省 2）。 */
	sampling: {
		fact: number;
		entail: number;
		same: number;
		opposite: number;
		fixed: number;
		/**
		 * chain 因果链步的采样次数（finding 真伪判定设计 §5 `sampling.link`，B2 的 "link" 问法；C1 波4）。
		 * 可选 ⇒ 缺省 2（与 entail 同档：双采样一致才称证伪）。1..5。
		 */
		link?: number;
	};
	/** proposer 结构化提交：required=硬门（无合格提交即失败）；缺省软档。 */
	submit: { required: boolean; maxAttempts: number };
	/** aggregator 结构化裁决：同上。 */
	verdicts: { required: boolean; maxAttempts: number; reasonMaxChars: number };
	/**
	 * B1 chain 载体灰度开关（finding 真伪判定设计 §5 `chain`，C1 波4 接线）。
	 * enabled=false（缺省）⇒ 与现行为**逐字节等价**（不采链步、不算 truth、prompt 不加 chain 项）；
	 * enabled=true ⇒ chain 必填执法（→ submit_findings 的 enforceChain）+ 链步采样 + truth 填充。
	 * minSteps/maxSteps 与 src/tools/submit_findings.ts CHAIN_LIMITS（2–6）同值（该文件不在写集，
	 * 暂未参数化，登记）。
	 */
	chain?: { enabled: boolean; minSteps: number; maxSteps: number };
	/**
	 * B3 机械佐证层（finding 真伪判定设计 §5 `mech`，C1 波4）。enabled=false ⇒ truth 步 mech 一律拒核降级
	 * （永不背书）。scopePad/minTokenLen 与 src/moa/mech.ts 常量（±20 / ≥3 字）同值（mech.ts 不在写集、
	 * MECH_FORMS_V1 门禁在其内，暂未参数化，登记）。
	 */
	mech?: { enabled: boolean; scopePad: number; minTokenLen: number };
}

/**
 * HTTP 入口形态（O3，统一升级台账 r92 DEC-72 ④ / r97 DEC-75，2026-10-01）。只作用于 PIMOA_MCP_TRANSPORT=http。
 *   hybrid（缺省）= O2 现网形态：modern（2026-07-28）请求走 SDK v2，legacy（2025 系列）请求走 SDK 1.29 有状态会话；
 *   modern        = 只认 2026-07-28：legacy 腿整体不挂，2025 系列请求一律由 v2 handler（legacy:"reject"）以 -32022 拒绝。
 * 上线 = 改 moa.yaml `http.mode` + 重启；回滚 = 改回 hybrid + 重启（与 jevcheck.clientMode 同一套配置纪律，不设 env 开关）。
 */
export interface HttpCfg {
	mode: "hybrid" | "modern";
}

export interface MoaConfig {
	providers: Record<string, ProviderCfg>;
	presets: Record<string, Preset>;
	timeouts: Timeouts;
	defaults: { preset: string };
	/** 读访问策略（缺省 = 空读根，即单根旧行为）。 */
	access: AccessCfg;
	/** Jev 辅助代码审查（缺省 enabled=false，与旧版逐字节一致）。 */
	jevcheck: JevcheckCfg;
	/**
	 * HTTP 入口形态（O3）。可选：loadConfig 恒填（整段缺省 ⇒ { mode: "hybrid" }）；
	 * 只为内存直构 config（测试 fixture）不必补字段，读取方一律按缺省 hybrid 处理。
	 */
	http?: HttpCfg;
}
