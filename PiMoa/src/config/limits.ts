/**
 * 上下文/回包限额单一真源(方案 v4 §2.3/§4,P2 落地)。
 *
 * 原则(v4 §4.1):
 *   - 有效窗口 = models.json 官方 contextWindow × 0.8(硬性 20% 余量);
 *   - 全链单一货币:字符,最坏 1 字符 = 1 token,按 Unicode 码点计数
 *     (禁止"这本账 3:1、那本账 1:1"的混算——v3 审查 A1 的致命伤);
 *   - 高熵守则(审查 A4):稀有码点/emoji/组合记号占比 >20% 时按 2 token/码点折算。
 *
 * 收敛口径(审查 C5):**字符/行数类**限额全收本文件;超时/缓冲类(RG_TIMEOUT_MS、
 * EXEC_TIMEOUT_MS、HTTP_MAX_RESPONSE_BYTES、semble CLI_TIMEOUT 等)留守各自文件——
 * 它们不是上下文预算。spool 的目录/配额 env 解析在 src/mcp/spool.ts(按调用时读取,便于测试)。
 *
 * 默认值口径:P2 装机制、保当前有效档(材料 360k);P3 按采样验收切 480k(synthesize)。
 * 取证预算从「200k token(=600k 字符@3:1)」改为字符本位 240k——旧值与材料预算混币后
 * 最坏口径超窗 35%(审查 A1),240k 是联合上限 600k 字符扣除材料 360k 的闭合值。
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 有效窗口折减比(官方窗口 × 此值 = 可用预算基数)。 */
export const EFFECTIVE_WINDOW_RATIO = 0.8;

export type BudgetMode = "synthesize" | "verify";

/**
 * 材料预算(prompt + context + recon 产出合并后的**有效码点数**上限;超限 fail-loud 拒绝)。
 * ★P3 切档(2026-08-25,采样验收 480k 档 29/30=96.7% 过 19/20 线后生效;数据见方案 §12 P3 记录):
 *   synthesize 480k(材料重),verify 360k(给取证让位)——两档与各自取证预算联合恒为 600k,
 *   逐跳窗口账见 v4 §4.2(proposer 670.5k ≤ 800k;fallback 聚合器 691.5k ≤ 737.6k)。
 * env:PIMOA_MATERIAL_BUDGET_CHARS 覆盖**两个模式**(600k 显式档经此开启,见 v4 §4.2)。
 */
export function materialBudgetChars(mode: BudgetMode): number {
  return envInt("PIMOA_MATERIAL_BUDGET_CHARS", mode === "verify" ? 360_000 : 480_000);
}

/** 会话取证预算(字符本位;bash_readonly/read/devkb/web_fetch/semble 共用一本账)。与材料联合 600k。 */
export function retrievalCharBudget(mode: BudgetMode): number {
  return envInt("PIMOA_RETRIEVAL_CHAR_BUDGET", mode === "verify" ? 240_000 : 120_000);
}

/** 单次取证工具输出统一上限(v4 §4.3:废除 50KB/60k/30k/40k 四套私值)。 */
export const TOOL_SLICE_CHARS = envInt("PIMOA_TOOL_SLICE_CHARS", 120_000);
/** read 工具单次最大行数(随 TOOL_SLICE 同步放大:2,000→4,000)。 */
export const READ_MAX_LINES = 4_000;

/**
 * recon 侦查总量。P2 静态审查 F4:用**独立 env 键**,与材料预算解耦——否则开 600k 材料显式档时
 * recon 整段读入上限被同一个键"绑架"着一起涨,是欲求还是意外无从分辨。
 */
export const RECON_MAX_CHARS = envInt("PIMOA_RECON_MAX_CHARS", 360_000);
/**
 * recon 单文件上限。缺省 360k(2026-09-04 收口:生产 8758 长期靠 env PIMOA_PER_FILE_MAX_CHARS=360000 覆盖 120k 缺省,
 * 代码与运行值两张皮;现把缺省对齐到实际生效值,单一真源;env 仍可覆盖)。与 RECON_MAX_CHARS 同额:单文件最多吃满 recon 总量。
 * 注意这是 recon 附件的**读入**上限,不是取证工具单次输出上限(那是 TOOL_SLICE_CHARS 120k,不动)。
 */
export const PER_FILE_MAX_CHARS = envInt("PIMOA_PER_FILE_MAX_CHARS", 360_000);
/** recon rg 检索结果上限。 */
export const RG_MAX_CHARS = 20_000;

/**
 * recon `deps:"auto"` 依赖函数自动附入(提速方案 20260904 §4.5/§4.10,src/moa/godeps.ts)。
 * 两个都是**写死的硬顶**:不读 env、不接受任何入参放大(§4.10 表「deps 自动附入」行)——
 * 材料每次调用送三遍(两 proposer + 聚合器),喂足依赖省下的轮次不能被更大的 payload 吃回去。
 */
/** 单个依赖函数整体附入的字符上限;超出只附签名行并写 note「函数过长仅附签名」。 */
export const DEPS_FUNC_MAX_CHARS = 20_000;
/** deps 块总量硬顶(≤ 4 万字符);超出后剩余候选只附签名不附体。deps 块同时计入 RECON_MAX_CHARS 总账。 */
export const DEPS_MAX_CHARS = 40_000;

/**
 * recon `refs:"auto"` 文档引用自动附入(提速方案 20260904 §4.11/§4.10,src/moa/docrefs.ts)。
 * 三个都是**写死的硬顶**:不读 env、不接受任何入参放大——与 deps 同理,材料每次调用送三遍,
 * 闭卷 run 省下的取证轮次不能被更大的 payload 吃回去。有效上限 = min(REFS_MAX_CHARS, recon 剩余额度)。
 */
/** refs 块总量硬顶;超出后剩余引用只在 note 里列路径。refs 块同时计入 RECON_MAX_CHARS 总账。 */
export const REFS_MAX_CHARS = 100_000;
/** 带行号的代码引用只附 [N-20, M+20] 行范围(前后各这么多行)。 */
export const REFS_CODE_CONTEXT_LINES = 20;
/** refs 附入的文件数上限(整份文档 + 代码行范围文件各计 1);超出只列路径。 */
export const REFS_MAX_FILES = 20;

/** 会话取证轮数缺省(每轮重发全历史的放大约束,U2 实测定标)。 */
export const SESSION_MAX_TOOL_CALLS = 5;
/** max_tool_calls 入参的硬顶(v4 §4.3;放大与材料档联动,盲目放开必复现断流)。 */
export const MAX_TOOL_CALLS_HARD_CAP = envInt("PIMOA_MAX_TOOL_CALLS", 10);

/** HTTP 请求体上限(仅传输兜底,**不是材料闸**;材料闸见 materialBudgetChars)。 */
export const HTTP_MAX_BODY_BYTES = envInt("PIMOA_HTTP_MAX_BODY_BYTES", 8 * 1024 * 1024);

// ---- 并发闸(v4 §9,P3):进程级全局;10 路并行 = 6 在跑 + 4 有序排队,零静默丢弃 ----
/** 全局同时在跑的 MoA 调用上限。 */
export const GATE_MAX_INFLIGHT = envInt("PIMOA_MAX_INFLIGHT", 6);
/** 有界 FIFO 排队上限(超出 fail-loud 拒绝)。 */
export const GATE_QUEUE_MAX = envInt("PIMOA_QUEUE_MAX", 10);
/**
 * 排队超时。45s 保客户端超时不变量:45s 排队 + 1350s backstop = 1395s < 客户端 tool_timeout 1410s
 * (审查 C8:v3 拟的 120s 会顶到 1470s 破约)。
 */
export const GATE_QUEUE_TIMEOUT_MS = envInt("PIMOA_QUEUE_TIMEOUT_MS", 45_000);
/** 每客户端会话(Mcp-Session-Id)公平配额:防单客户端连发饿死其他三家(审查 C8)。 */
export const GATE_SESSION_MAX_INFLIGHT = envInt("PIMOA_SESSION_MAX_INFLIGHT", 3);
export const GATE_SESSION_MAX_QUEUED = envInt("PIMOA_SESSION_MAX_QUEUED", 4);

/** 窗口验算的固定包装预留(proposer:提示词包装;aggregator:前言+任务+nonce 边界)。 */
export const PROPOSER_OVERHEAD_CHARS = 5_000;
export const AGGREGATOR_OVERHEAD_CHARS = 15_000;

// ---- Jev 辅助代码审查(详细设计 v4 §6,2026-09-20;src/moa/jevcheck.ts 第二波用)----
// 六个都是**写死的硬顶**(不读 env):切片行数、配对上限与核对表字符上限决定材料区体积,
// 材料每次调用送三遍,不接受入参放大。
/** 事实核对切片:事实自引位置 ±此行数。 */
export const JEVCHECK_FACT_PAD = 15;
/** 无引用事实退回 finding 行区间 ±此行数(函数体定位失败时)。 */
export const JEVCHECK_FALLBACK_PAD = 25;
/** 核对表里回贴「最相似行」时取 ±此行数上下文。 */
export const JEVCHECK_NEAREST_PAD = 5;
/** 跨 proposer 同题(same)比对的配对数上限。 */
export const JEVCHECK_SAME_MAX_PAIRS = 1500;
/** 核对表渲染字符上限(与 config jevcheck.budget.tableMaxChars 缺省同值;取两者较小)。 */
export const JEVCHECK_TABLE_MAX_CHARS = 40_000;
/** 运行时条件条数 ≥ 此值(或占比 ≥50%)即标条件红旗。 */
export const JEVCHECK_CONDITION_FLAG_MIN = 2;

// ---- B4 真伪三态阈值(设计稿 §5 thresholds.refute/weak,波3;语义真源 = 实测判定器
// <workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs:12 `REFUTE = 0.1, WEAK = 0.2`)----
// 波3 只落常量;波4(C1)起接 moa.yaml:真源 config/moa.yaml jevcheck.thresholds.refute/weak,缺省回落本常量。
// fact.low 0.2 不动,refute 只喂 KILL 判定。
/** 证伪线:双采样一致 ≤ 此值 = 严格证伪(KILL/DOWNGRADE 档的触发线)。 */
export const JEVCHECK_REFUTE_P = 0.1;
/** 弱证伪/中带线:均值 ≤ 此值(且未达严格证伪)= DOWNGRADE-weak 降级区。 */
export const JEVCHECK_WEAK_P = 0.2;

// ---- C1 配置接线(设计 §5,波4;徐总 2026-09-22 Q1=甲/Q3=甲 裁决)----
// 从 config(moa.yaml jevcheck 节,经 src/config/load.ts parseJevcheck)读入并接线到 verdictOf 阈值 /
// enforceChain / 链步采样 / 机械佐证开关。内存直构 config 可省各新键 ⇒ 一律回落
// 下列缺省值(=设计 §5 写死数字),行为与旧版逐字节等价。

export interface TruthThresholds {
	refute: number;
	weak: number;
}

/** B4 真伪阈值(接线到 verdictOf):config `thresholds.refute/weak` ⇒ 缺省 JEVCHECK_REFUTE_P/WEAK_P。 */
export function jevTruthThresholds(jev: { thresholds?: { refute?: number; weak?: number } } | undefined): TruthThresholds {
	return {
		refute: jev?.thresholds?.refute ?? JEVCHECK_REFUTE_P,
		weak: jev?.thresholds?.weak ?? JEVCHECK_WEAK_P,
	};
}

/** B1 chain 灰度开关(接线到 createSubmitFindingsTool 的 enforceChain):`chain.enabled`,缺省 false(旧版等价)。 */
export function jevEnforceChain(jev: { chain?: { enabled?: boolean } } | undefined): boolean {
	return jev?.chain?.enabled === true;
}

/** 链步采样次数(设计 §5 `sampling.link`,B2 "link" 问法):缺省 2(与 entail 同档,双采样一致才称证伪)。 */
export function jevLinkSamples(jev: { sampling?: { link?: number } } | undefined): number {
	return jev?.sampling?.link ?? 2;
}

/** B3 机械佐证层开关(设计 §5 `mech.enabled`):false ⇒ truth 步 mech 一律拒核降级,永不背书。缺省 true。 */
export function jevMechEnabled(jev: { mech?: { enabled?: boolean } } | undefined): boolean {
	return jev?.mech?.enabled !== false;
}

// ---- 回包侧预算(P1 定义于 tools.ts,P2 迁入真源;tools.ts re-export 保兼容)----
export const RESPONSE_CONTENT_BUDGET_CHARS = 10_000;
export const RESPONSE_STRUCT_AGG_BUDGET_CHARS = 8_000;
export const PROPOSAL_EXCERPT_CHARS = 1_000;
export const SALVAGE_EXCERPT_CHARS = 4_000;
export const SALVAGE_INLINE_FALLBACK_MAX_CHARS = 60_000;
export const DELIVER_HEAD_EXCERPT_CHARS = 1_000;

// ---- 码点计数与高熵折算(v4 §4.1;JS .length 是 UTF-16 码元,稀有码点/emoji 会低估)----

/** Unicode 码点数(非 UTF-16 码元数)。 */
export function codePointLength(s: string): number {
  let n = 0;
  // for..of 按码点迭代
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

/**
 * 「非异常」码点白名单。其余计为 exotic(高熵折算对象:emoji/组合记号/CJK 辅助面扩展区等)。
 * P2 静态审查 F8 补齐常用区段:箭头/数学符(代码 review 材料常见 →⇒≥≤)、盒线/几何(终端表格框线)、
 * 康熙部首/注音、CJK 扩展 A(正式中文用字)——否则这些正常材料占比 >20% 即被 ×2 折算误伤。
 */
function isExotic(cp: number): boolean {
  if (cp <= 0x2ff) return false; // ASCII + Latin-1/扩展
  if (cp >= 0x2000 && cp <= 0x206f) return false; // 常用标点
  if (cp >= 0x2190 && cp <= 0x22ff) return false; // 箭头 + 数学运算符(F8)
  if (cp >= 0x2500 && cp <= 0x25ff) return false; // 盒线/块/几何形状(F8)
  if (cp >= 0x2f00 && cp <= 0x2fdf) return false; // 康熙部首(F8)
  if (cp >= 0x3000 && cp <= 0x303f) return false; // CJK 标点
  if (cp >= 0x3040 && cp <= 0x30ff) return false; // 日文假名(常见)
  if (cp >= 0x3100 && cp <= 0x312f) return false; // 注音符号(F8)
  if (cp >= 0x3400 && cp <= 0x4dbf) return false; // CJK 扩展 A(正式中文用字,F8)
  if (cp >= 0x4e00 && cp <= 0x9fff) return false; // CJK 基本区
  if (cp >= 0xff00 && cp <= 0xffef) return false; // 全角/半角形式
  return true; // emoji/组合记号/CJK 扩展 B+ 等(扩展 B+ 保留 exotic:仅影响预算折算,不影响正确性)
}

export interface CharCount {
  codePoints: number;
  exotic: number;
  /** 计入高熵折算后的有效字符数(exotic 占比 >20% 时 exotic 按 ×2 计)。 */
  effective: number;
}

/** 材料计量(v4 §4.1 高熵守则)。 */
export function effectiveCharCount(s: string): CharCount {
  let codePoints = 0;
  let exotic = 0;
  for (const ch of s) {
    codePoints++;
    const cp = ch.codePointAt(0) ?? 0;
    if (isExotic(cp)) exotic++;
  }
  const highEntropy = codePoints > 0 && exotic / codePoints > 0.2;
  return { codePoints, exotic, effective: highEntropy ? codePoints + exotic : codePoints };
}
