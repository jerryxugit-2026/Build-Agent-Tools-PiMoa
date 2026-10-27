/**
 * MoA MCP 工具核心（transport 无关，便于单测直调）。
 *
 * 职责：zod inputSchema + 工具 description（DESIGN §4 P1-2 模式语义）
 *   + 入参 → MoaRequest 构造 + runMoa 调用 + MoaResult → MCP 工具返回（§4.6 B 自描述结果）。
 * server.ts 只负责起 McpServer/stdio 与把 sendNotification 接到 onStageEvent。
 */
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { Mode, MoaConfig, ProfileName, WorkerRef } from "../config/types.js";
import type { MaterialMap, MoaRequest, MoaResult } from "../moa/types.js";
import { runMoa, type RunSessionImpl } from "../moa/orchestrate.js";
import { runRecon } from "../moa/recon.js";
import { atomicWriteWithVerify, DONE_MARKER_RE, sha256Text } from "../deliver/write.js";
import { writeSpool } from "./spool.js";
import type { StageEvent } from "./events.js";

/**
 * 临时覆盖用的 worker zod —— **只收 {provider, model}，不收 profile**（DESIGN §8.2 #5 提权修复）。
 * capability profile 一律由服务端按 preset/工具钉死（见 orchestrate.runMoa 的 profile 授权），
 * 绝不接受调用方指定，否则 moa_run 可把 proposer 提成 verify-worker 拿到 bash_readonly 命令面。
 */
const workerOverrideSchema = z
  .object({
    provider: z.string().min(1).describe("providers 里的 key（如 minimax / xiaomi / cliproxy）"),
    model: z.string().min(1).describe("模型 id（如 MiniMax-M3）"),
  })
  .describe(
    "worker 覆盖：仅 {provider, model}。profile 不接受调用方指定，由服务端按 preset/工具钉死（防提权）。",
  );

/** 两个工具共享的 inputSchema（ZodRawShape，直接喂 registerTool）。 */
export const moaToolInput = {
  prompt: z.string().min(1).describe("要交给 MoA 的问题或任务（必填）"),
  context: z
    .string()
    .optional()
    .describe("可选补充上下文（贴代码/文件片段/背景），与 prompt 拼接后下发"),
  files: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "★强烈推荐：要 MoA 审阅的**精确文件清单**（相对 cwd 或绝对路径，须在 cwd 内）。" +
        "服务端会直接读入并附进上下文，proposer 因此**不必自己扫库找文件**——这是避免" +
        "「开放式任务→模型扫全库→上下文撑爆→整轮失败」的最有效手段。先自己定位好文件再调用。",
    ),
  files_ranges: z
    .array(
      z
        .object({
          path: z.string().min(1).describe("文件路径（相对 cwd 或绝对路径，须在 cwd/读根内）"),
          start: z.number().int().min(1).describe("起始行（1 基，含）"),
          end: z.number().int().min(1).describe("结束行（含，须 ≥ start）"),
        })
        .refine((r) => r.end >= r.start, { message: "end 须 ≥ start" }),
    )
    .optional()
    .describe(
      "可选：结构化行范围 [{path,start,end}]。只附该文件第 start–end 行并打**真实行号**——大文件只改几行时用它" +
        "代替整份 files（材料每次调用送三遍，少附即提速）。同一文件可给多段。越界/被 jail 拒绝降级为说明不报错。",
    ),
  recon_query: z
    .string()
    .optional()
    .describe(
      "可选：机械检索词。服务端会先用 rg 在 cwd 内检索（**不经模型**），把命中文件与行号摘要" +
        "附进上下文，等于替 proposer 做完「先侦查再干活」这一步。不确定该给哪些 files 时用它。",
    ),
  deps: z
    .literal("auto")
    .optional()
    .describe(
      "可选 \"auto\"：对 files/files_ranges 里的 .go 附件，服务端自动在其仓根 rg 定位被调用的未限定函数并" +
        "把函数**整体**附入（带真实行号），省掉 proposer 为看 helper 再取证一轮。缺省关。" +
        "总量硬顶 40k 字符（写死，不可放大），超出只附签名；泛型/方法表达式/接口方法可能漏检。",
    ),
  refs: z
    .literal("auto")
    .optional()
    .describe(
      "可选 \"auto\"：对 files/files_ranges 里的 .md/.txt 文档，服务端扫正文里的路径引用（绝对路径与 docs/ internal/ cmd/ " +
        "tools/ .claude/ 前缀相对路径，支持 path:N-M / #LN 行号后缀）并机械附入：引用的文档整份附入；带行号的代码引用只附" +
        "±20 行范围；无行号代码引用不附只进说明（代码事实断言请走 moa_verify）；不存在的引用路径进说明（文档质量信号）；" +
        "不递归。文档 review 因此可走闭卷 moa_run 只传被审文档路径。硬顶 100k 字符 / 20 个文件（写死，不可放大），计入 recon 总账。",
    ),
  preset: z
    .string()
    .optional()
    .describe(
      "命名 preset（moa_run 默认 default；moa_verify 默认 moa_verify）。preset 决定 mode/proposers/aggregator/quorum。",
    ),
  models: z
    .array(workerOverrideSchema)
    .optional()
    .describe("临时覆盖 proposers 的 provider/model（不改配置做 A/B）；profile 仍由服务端钉死"),
  aggregator: workerOverrideSchema
    .optional()
    .describe("临时覆盖聚合器的 provider/model；profile 仍由服务端钉死"),
  cwd: z
    .string()
    .optional()
    .describe("工作目录（worktree 根，会话发现根）；缺省为 server 进程 cwd"),
  max_tool_calls: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "本次调用每个 **proposer** 会话的取证调用次数上限（缺省 5,硬顶 10；一条消息里并行发的多个工具调用逐个计数；" +
        "只降不升——review 派单建议：代码类 4、文档类 3（2026-09-06 由 3/2 放宽：会调工具的模型三次即触顶,耗尽轮被下游判废）。每次工具调用都会把完整对话历史重发一遍,放大传输量——" +
        "只有大任务确需多次补证时才显式放大。不影响聚合器（见 aggregator_max_tool_calls）。",
    ),
  aggregator_max_tool_calls: z
    .number()
    .int()
    .min(1)
    .max(SESSION_MAX_TOOL_CALLS)
    .optional()
    .describe(
      `聚合器会话的取证调用次数上限（缺省 ${SESSION_MAX_TOOL_CALLS}；只能 ≤${SESSION_MAX_TOOL_CALLS},超过直接拒绝,不接受放大）。` +
        "与 max_tool_calls **互不继承**：用途是让 review 派单把 proposer 压到 3-4 时,聚合器的复核取证不受牵连。" +
        "一般不用给；只在明确想让聚合器少取证时才往下压。",
    ),
};

/** worker 覆盖入参（只有 provider/model；profile 由服务端补齐/钉死）。 */
export interface WorkerOverride {
  provider: string;
  model: string;
}

/** 工具入参类型（与 moaToolInput 的 zod 形状一致；models/aggregator 不含 profile）。 */
export interface MoaToolInput {
  prompt: string;
  context?: string;
  /** 精确文件清单：服务端读入后附进 context（层次二：把任务边界画好，proposer 不必自己找）。 */
  files?: string[];
  /** 结构化行范围：只附 path 的第 start–end 行，打真实行号（提速方案 §4.5 改动 A）。 */
  files_ranges?: Array<{ path: string; start: number; end: number }>;
  /** 机械检索词：服务端用 rg 预检索后附进 context（层次三：把"先侦查"内置化）。 */
  recon_query?: string;
  /** "auto"：.go 附件的依赖函数整体自动附入（提速方案 §4.5 改动 B；缺省关，DEPS_MAX_CHARS 硬顶）。 */
  deps?: "auto";
  /** "auto"：.md/.txt 附件里引用的路径自动附入（提速方案 §4.11；缺省关，REFS_MAX_CHARS/REFS_MAX_FILES 硬顶）。 */
  refs?: "auto";
  preset?: string;
  models?: WorkerOverride[];
  aggregator?: WorkerOverride;
  cwd?: string;
  /** proposer 取证调用次数上限覆盖(1-10;缺省 5)。见 moaToolInput.max_tool_calls。 */
  max_tool_calls?: number;
  /** 聚合器取证调用次数上限(1-5;缺省 5,只降不升,不继承 max_tool_calls)。见 moaToolInput.aggregator_max_tool_calls。 */
  aggregator_max_tool_calls?: number;
}

/**
 * 覆盖入参 → WorkerRef。profile 填最保守占位（delivery-readonly-worker）——
 * orchestrate.runMoa 会按 preset/forceProfile 重新钉死并忽略此值；此处占位仅为满足契约类型，
 * 万一某路径误读也只读，双保险。
 */
const OVERRIDE_PLACEHOLDER_PROFILE: ProfileName = "delivery-readonly-worker";
function toWorkerRef(o: WorkerOverride): WorkerRef {
  return { provider: o.provider, model: o.model, profile: OVERRIDE_PLACEHOLDER_PROFILE };
}

export const MOA_RUN_DESCRIPTION =
  "多模型综合（synthesize）：并行询问 N 个独立提议模型，再由聚合器综合成一份最终结论并返回。" +
  "适用：要一个经过多视角交叉、去错去冗后的高质量答案（方案设计、代码生成、疑难分析、写作）。" +
  "行为：fail-closed —— 任一提议者失败/超时/空正文则整体失败、不产出、不降级（status:failed）。" +
  "能力边界（2026-09-07 更正为真实工具面）：提议者与聚合器**不能读盘**（无 read/ls/bash_readonly），" +
  "只带三个补漏工具：semble_search（语义定位代码片段）/ devkb_search（Paper System 专用检索）/ web_fetch（取已知 URL 正文）。" +
  "要让它们看到文件，必须由调用方经 files / files_ranges / recon_query（/ deps:\"auto\"）喂入，或直接写进 context；" +
  "不要在任务里写「用 read 精读」之类它做不到的指令。" +
  "**不执行代码、不跑测试、不写文件**（要执行/写盘的工作请在隔离区自行跑完，把产物/日志作为 context 传入）。" +
  "只支持 synthesize preset：传入 verify 模式的 preset 会被直接拒绝（status:failed, stage:config）——" +
  "需只读验真（含沙箱 bash_readonly）请改用 moa_verify 工具，本工具「只读不执行」恒真。" +
  "返回自描述结果：status / aggregated（最终答案）/ proposals（每提议者硬状态）/ receipt（模式·配额·成本·body_sha256）/ error。";

export const MOA_VERIFY_DESCRIPTION =
  "多模型验真取证（verify，只读）：并行让 N 个模型独立核验一个论断/交付物，再由只读聚合器汇总裁决。" +
  "适用：交付前把关、审代码是否真的通过、事实核查、找漏洞与反例。" +
  "硬约束：全程只读 —— 不能执行代码、不能写文件、不能改状态（聚合器也被限为只读 profile）。" +
  "因此不要用它跑测试或复现：要执行请改用 moa_run，或先在隔离区跑完、把产物/日志作为 context 再交给本工具审。" +
  "同样 fail-closed（任一验真者失败即整体失败）。返回结构同 moa_run（status/aggregated/proposals/receipt/error）。";

/**
 * MCP 工具返回体（content 文本摘要 + structuredContent 完整 MoaResult）。
 * 用 type 别名而非 interface：需可赋值给 SDK 带索引签名的 CallToolResult。
 */
export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** 入参 → MoaRequest。不设 req.mode：由 preset.mode 驱动（避免强设 mode 击穿 verify 只读不变量）。 */
export function buildRequest(input: MoaToolInput, defaultPreset: string): MoaRequest {
  return {
    prompt: input.prompt,
    ...(input.context !== undefined ? { context: input.context } : {}),
    preset: input.preset ?? defaultPreset,
    ...(input.models !== undefined ? { models: input.models.map(toWorkerRef) } : {}),
    ...(input.aggregator !== undefined ? { aggregator: toWorkerRef(input.aggregator) } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.max_tool_calls !== undefined ? { maxToolCalls: input.max_tool_calls } : {}),
    ...(input.aggregator_max_tool_calls !== undefined
      ? { aggregatorMaxToolCalls: input.aggregator_max_tool_calls }
      : {}),
  };
}

/**
 * ★侦查前置（层次二 files + 层次三 recon_query，见 src/moa/recon.ts）。
 * 在**进模型之前**由服务端机械读取/检索，把结果并入 req.context —— 任务边界画好，
 * proposer 不必自己扫库（这正是内部子代理不撑爆、外部 MoA 撑爆的根本差异）。
 * 绝不抛：侦查失败降级为不附加内容，不影响主流程。
 */
export async function applyRecon(
  req: MoaRequest,
  input: MoaToolInput,
  readRoots: readonly string[] = [],
): Promise<MoaRequest> {
  const hasFiles = Array.isArray(input.files) && input.files.length > 0;
  const hasRanges = Array.isArray(input.files_ranges) && input.files_ranges.length > 0;
  const hasQuery = typeof input.recon_query === "string" && input.recon_query.trim() !== "";
  if (!hasFiles && !hasRanges && !hasQuery) return req;
  try {
    const r = await runRecon({
      ...(input.files ? { files: input.files } : {}),
      ...(input.files_ranges ? { filesRanges: input.files_ranges } : {}),
      ...(input.recon_query ? { reconQuery: input.recon_query } : {}),
      ...(input.deps === "auto" ? { deps: "auto" as const } : {}),
      ...(input.refs === "auto" ? { refs: "auto" as const } : {}),
      cwd: req.cwd ?? process.cwd(),
      // 跨仓：files 里可给其它只读根的绝对路径（读根来自配置真源，不是调用方入参）。
      readRoots,
    });
    if (!r.text && r.notes.length === 0) return req;
    const noteBlock = r.notes.length > 0 ? `\n[侦查说明] ${r.notes.join("；")}` : "";
    const merged = [req.context, r.text + noteBlock].filter((s) => s && s.trim() !== "").join("\n\n");
    // ★材料通路（Jev 辅助代码审查设计 v4 §3.1）：把 recon 登记的材料装进 Map<abs, MaterialFile[]>，
    //   同一 abs 多段按 start 升序；写 req.materials。context 文本不因此有任何改变。
    const materials: MaterialMap = new Map();
    for (const f of r.files) {
      const arr = materials.get(f.abs) ?? [];
      arr.push(f);
      materials.set(f.abs, arr);
    }
    for (const arr of materials.values()) arr.sort((a, b) => a.start - b.start || a.end - b.end);
    const reconSummary = {
      filesIncluded: r.filesIncluded,
      segments: r.files.map((f) => `${f.rel}:${f.start}-${f.end} ${f.kind}`),
      notes: [...r.notes],
    };
    return { ...req, context: merged, ...(materials.size > 0 ? { materials } : {}), reconSummary };
  } catch (err) {
    // fail-open：侦查不该毙掉整轮 MoA——但必须留痕(静态审查 F7:静默吞错会让
    // 「files 已读入」的假象把任务推回 proposer 自己扫库的主故障路径)。
    console.error(
      "[moa recon] 侦查前置失败(fail-open,本轮不附材料):",
      err instanceof Error ? err.message : err,
    );
    return req;
  }
}

// ============================================================================
// 回包契约 v2（方案 v4 §6）：双通道各留判决、proposer 全文走 spool、预算闸显式标注。
// 预算常量已迁入 src/config/limits.ts 单一真源（P2）；此处 re-export 保测试/消费方兼容。
// ============================================================================
import {
  RESPONSE_CONTENT_BUDGET_CHARS,
  RESPONSE_STRUCT_AGG_BUDGET_CHARS,
  PROPOSAL_EXCERPT_CHARS,
  SALVAGE_EXCERPT_CHARS,
  SALVAGE_INLINE_FALLBACK_MAX_CHARS,
  DELIVER_HEAD_EXCERPT_CHARS,
  materialBudgetChars,
  effectiveCharCount,
  codePointLength,
  SESSION_MAX_TOOL_CALLS,
  type BudgetMode,
} from "../config/limits.js";
export {
  RESPONSE_CONTENT_BUDGET_CHARS,
  RESPONSE_STRUCT_AGG_BUDGET_CHARS,
  PROPOSAL_EXCERPT_CHARS,
  SALVAGE_EXCERPT_CHARS,
  SALVAGE_INLINE_FALLBACK_MAX_CHARS,
  DELIVER_HEAD_EXCERPT_CHARS,
};
/** 回包契约版本（v4 §6.1；1=整份 MoaResult 时代，2=SlimMoaPayload）。 */
export const CONTRACT_VERSION = 2;

/**
 * 材料合并闸（v4 §4.2/审查 A2 主修复）：prompt + context(含 recon 并入的产出)按**码点**合并计量,
 * 超预算 fail-loud 拒绝——绝不静默截断,也绝不留给 pi compaction 静默压缩(静默降质)。
 * 高熵守则:稀有码点/emoji 占比 >20% 时按 2 token/码点折算(effectiveCharCount)。
 */
export function enforceMaterialBudget(
  req: MoaRequest,
  mode: BudgetMode,
  presetName: string,
): MoaResult | null {
  const m = effectiveCharCount(`${req.prompt}\n${req.context ?? ""}`);
  const budget = materialBudgetChars(mode);
  if (m.effective <= budget) return null;
  const entropyNote =
    m.effective !== m.codePoints
      ? `（含高熵折算：${m.codePoints} 码点中 ${m.exotic} 个稀有码点按 ×2 计,有效 ${m.effective}）`
      : "";
  return configFailed(
    mode,
    presetName,
    `材料预算超限(fail-loud,v4 §4)：prompt+context+recon 合并 ${m.effective} 字符${entropyNote} > ` +
      `预算 ${budget}(mode=${mode})。请减料、分段调用、或改用 files 传路径由服务端按上限读入;` +
      "本工具不做静默截断/压缩(那是静默降质)。临时放宽:env PIMOA_MATERIAL_BUDGET_CHARS(见方案 §4.2 的 600k 显式档)。",
  );
}

/** 按行边界截取前 max 字符（单行超长时硬切，避免只剩极短片段）。 */
export function truncateAtLine(text: string, max: number): { kept: string; truncated: boolean } {
  if (text.length <= max) return { kept: text, truncated: false };
  const slice = text.slice(0, max);
  const nl = slice.lastIndexOf("\n");
  let kept = nl > max * 0.5 ? slice.slice(0, nl) : slice;
  // P1 审查 backlog F11:硬切落点若在代理对中间,掐掉孤立 high surrogate(免 U+FFFD 乱码)。
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return { kept, truncated: true };
}

/** 尾部按行边界取最后 max 字符（静态审查 F5:无条件掐掉被硬切开的残行头,与 truncateAtLine 对称）。 */
function tailAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(-max);
  const nl = slice.indexOf("\n");
  return nl >= 0 ? slice.slice(nl + 1) : slice;
}

/** 全文去向说明（spool 指针 / 失败标注），拼进各种截断标注里。 */
function auditNote(r: MoaResult, spoolErr?: string): string {
  const a = r.receipt.audit;
  if (a) {
    return (
      `全文见 ${a.path}（sha256=${a.sha256.slice(0, 12)}…，${a.bytes} 字节，` +
      `保留至 ${a.retainUntil.slice(0, 10)}），可用 Read 分段读取`
    );
  }
  return spoolErr ? `spool 写入失败：${spoolErr}` : "spool 未落盘";
}

/** 证据行判据：行号引用/文件:行/引号块/代码围栏——salvage 摘录优先保留这些（v4 §6.3）。 */
const EVIDENCE_LINE_RE =
  /(^\s*\d+[|:：])|(\bL\d+\b)|(#L\d+)|([\w$./\\-]+:\d+)|(^\s*[>`"“])|(行\s*\d+)/;

/**
 * salvage 证据感知摘录：头 800 + 中段证据行 ≤2,500 + 尾 400（合计 ≤4,000 字符）。
 * 机械头尾摘录会恰好切掉中段的行号/引用证据（审查 B3），故按证据密度取中段。
 */
export function salvageExcerpt(text: string): { kept: string; truncated: boolean } {
  const t = text.trim();
  if (t.length <= SALVAGE_EXCERPT_CHARS) return { kept: t, truncated: false };
  const head = truncateAtLine(t, 800).kept;
  const tail = tailAtLine(t, 400);
  const middle = t.slice(head.length, t.length - tail.length);
  const evid: string[] = [];
  let used = 0;
  for (const line of middle.split("\n")) {
    if (!EVIDENCE_LINE_RE.test(line)) continue;
    const remain = 2_500 - used;
    if (remain <= 20) break;
    // 静态审查 F6:单行证据超长时截取而非整行丢弃——否则首条超长证据会让证据段退化为空。
    const overflow = line.length + 1 > remain;
    const take = overflow ? `${line.slice(0, remain - 20)}…[单行证据超长截取]` : line;
    evid.push(take);
    used += take.length + 1;
    if (overflow) break;
  }
  const evidBlock =
    evid.length > 0
      ? `\n…[中段非证据部分略，以下为证据密度段摘录]…\n${evid.join("\n")}`
      : "\n…[中段略]…";
  return { kept: `${head}${evidBlock}\n…[尾部]…\n${tail}`, truncated: true };
}

// ============================================================================
// §8.1 【最终裁决】前置(2026-09-04):verify 收尾模板把裁决放在正文末尾,而回包 inline 按头部 8k/10k 截断,
// 近两周 46% 的 verify 聚合正文 >8k ⇒ 调用方在 inline 看不到裁决。修法在**代码层**:裁剪前把裁决段抽出来
// 前置到 inline content 与 structured aggregated 的头部,再做原有头截。**不改 prompt、不改正文顺序**;
// spool 全文 / bodySha256 / aggregatedMeta.sha256 对账的都是原始正文,一律不变。
// ============================================================================

/** 裁决标题行:「三、【最终裁决】」或行首「【最终裁决】」(允许 markdown # 前缀与前导空白)。 */
const VERDICT_HEADING_RE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:三、[ \t]*)?【最终裁决】.*$/m;
/** 裁决段终止:下一处「一、/二、」编号标题(旧格式或模型把段落写乱时兜底);没有则到正文末尾。 */
const NEXT_SECTION_RE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:一|二)、/m;
/** 前置段的说明头(固定字串,调用方/统计脚本可锚定;不带 nonce,它不是信任边界,只是位置说明)。 */
export const VERDICT_PREPEND_HEADER = "【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】";

/** 从聚合正文抽出【最终裁决】段(标题行起,到下一「一、/二、」标题或正文末尾)。无标题 → null。 */
export function extractFinalVerdict(aggregated: string): string | null {
  const m = VERDICT_HEADING_RE.exec(aggregated);
  if (!m || m.index === undefined) return null;
  const rest = aggregated.slice(m.index);
  const afterHeading = rest.slice(m[0].length);
  const next = NEXT_SECTION_RE.exec(afterHeading);
  const seg = next ? rest.slice(0, m[0].length + next.index) : rest;
  const trimmed = seg.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 需要时把裁决段前置到正文头部。**只在正文会被截断时才前置**(长度 > 两通道里更小的预算
 * RESPONSE_STRUCT_AGG_BUDGET_CHARS):短正文两通道都能整份返回,前置只是重复一遍裁决、白占 token,
 * 且"不含标题或不会截断时行为不变"让改动面最小。返回 { text, prepended }——两通道共用同一判定,
 * 保证 verdictPrepended 布尔与 inline 实际形态一致。
 */
export function prependVerdictIfNeeded(aggregated: string): { text: string; prepended: boolean } {
  if (aggregated.length <= RESPONSE_STRUCT_AGG_BUDGET_CHARS) return { text: aggregated, prepended: false };
  const verdict = extractFinalVerdict(aggregated);
  if (verdict === null) return { text: aggregated, prepended: false };
  return { text: `${VERDICT_PREPEND_HEADER}\n${verdict}\n\n${aggregated}`, prepended: true };
}

/** 成功 meta 行（含降级诚实标注 + audit 指针短标）。 */
function okMetaLine(r: MoaResult, spoolErr?: string): string {
  const rc = r.receipt;
  return (
    `[moa ok] mode=${rc.mode} preset=${rc.preset} quorum=${rc.quorum} ` +
    `models=${rc.models.join(",")} aggregator=${rc.aggregator.model}` +
    // ★诚实标注：降级出的正文绝不能看起来像"一次就成"——调用方有权知道换过聚合器。
    (rc.aggregator.fallbackFrom
      ? `（已降级：${rc.aggregator.fallbackFrom} → ${rc.aggregator.model}，` +
        `主聚合器失败于「${rc.aggregator.fallbackReason ?? "未记录"}」）`
      : "") +
    ` cost=$${rc.totalCostUsd.toFixed(4)} body_sha256=${rc.bodySha256.slice(0, 12)}…` +
    // 静态审查 F9:成功路径与失败路径同等诚实——spool 失败给出原因,不只给字面量。
    (rc.audit ? ` audit=${rc.audit.path}` : spoolErr ? ` spool_failed:${spoolErr}` : "")
  );
}

/**
 * MoaResult → 人读文本摘要（LLM 主要读 content[].text）。
 * v4 §6：成功=判决(≤预算,超则截头+显式标注+spool 指针)；deliver 成功=回执化；
 * 失败=错误明细 + salvage 证据感知摘录（spool 失败时有界回退整份内联）。
 */
export function formatSummary(r: MoaResult, spoolErr?: string): string {
  const rc = r.receipt;
  const lines: string[] = [];
  if (r.status === "ok" && rc.delivery?.written) {
    // deliver 回执化（v4 §6.2）：正文已服务端原子落盘并回读核验，回包是回执。
    const head = truncateAtLine(r.aggregated.trim(), DELIVER_HEAD_EXCERPT_CHARS);
    lines.push(head.kept);
    if (head.truncated) {
      lines.push(
        `…[交付回执：全文 ${r.aggregated.length} 字符已确定性落盘，此处仅头部摘录]`,
      );
    }
    lines.push("");
    lines.push(
      `[moa deliver ok] written=${rc.delivery.path} sha256=${rc.delivery.sha256.slice(0, 12)}…`,
    );
    lines.push(okMetaLine(r, spoolErr));
  } else if (r.status === "ok") {
    // 成功：判决作正文，超预算按行截头 + 显式标注（绝不无声截断）。
    // §8.1:裁剪**前**先把【最终裁决】段前置(仅长正文且含标题),再做原有头截——裁决不再被截掉。
    const pv = prependVerdictIfNeeded(r.aggregated.trim());
    const gate = truncateAtLine(pv.text, RESPONSE_CONTENT_BUDGET_CHARS);
    lines.push(gate.kept);
    if (gate.truncated) {
      lines.push("");
      lines.push(
        `⚠️ [正文 ${r.aggregated.length} 字符超回包预算 ${RESPONSE_CONTENT_BUDGET_CHARS}，` +
          `已按行截取前 ${gate.kept.length} 字符${pv.prepended ? "（头部已前置【最终裁决】段）" : ""}；${auditNote(r, spoolErr)}]`,
      );
    }
    lines.push("");
    lines.push(okMetaLine(r, spoolErr));
  } else {
    const e = r.error;
    lines.push(
      `[moa ${r.status}] ${e ? `stage=${e.stage} reason=${e.reason}` : "无 error 明细"}`,
    );
    if (e?.detail) lines.push(`detail: ${e.detail}`);
    // ★取证行（2026-08-18 补）：失败摘要必须含聚合器身份（空串=失败在聚合器解析之前）。
    lines.push(
      `mode=${rc.mode} preset=${rc.preset} quorum=${rc.quorum} ` +
        `models=${rc.models.join(",")} aggregator=${rc.aggregator.model || "(未解析)"}` +
        (rc.aggregator.fallbackFrom
          ? `（已降级自 ${rc.aggregator.fallbackFrom}，主聚合器失败于「${rc.aggregator.fallbackReason ?? "未记录"}」）`
          : ""),
    );
    const marks = Object.entries(rc.proposerMarks)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (marks) lines.push(`proposerMarks: ${marks}`);
    // 失败时留住好答案（徐总 2026-07-25 铁律；v4 §6.3 改证据感知摘录+spool 全文）：
    //   fail-closed 只保证「不把未过关的结论当权威答案」，proposer 已产出的正文不白扔。
    const salvaged = r.proposals.filter((p) => p.text.trim().length > 0);
    if (salvaged.length > 0) {
      const totalChars = salvaged.reduce((s, p) => s + p.text.length, 0);
      const hasAudit = !!rc.audit;
      // spool 失败时的有界回退：合计 ≤60k 整份内联（Claude 侧逃生舱会存档，不算丢）；
      // 超限则仍走摘录——无界整份内联会成为"写满盘即绕过瘦身"的杠杆（审查 B3）。
      const inlineFull = !hasAudit && totalChars <= SALVAGE_INLINE_FALLBACK_MAX_CHARS;
      lines.push("");
      lines.push(
        `[以下为 ${salvaged.length} 份已产出的单个 proposer 正文` +
          (inlineFull ? "" : "（证据感知摘录）") +
          ` —— 未经聚合、未过 fail-closed 把关，仅供参考/自行取用，勿当作本工具的权威结论]`,
      );
      for (const p of salvaged) {
        const mark = p.ok
          ? "completed"
          : p.timeout
            ? "timeout"
            : p.error
              ? "error"
              : "aborted/partial";
        const body = inlineFull ? p.text.trim() : salvageExcerpt(p.text).kept;
        lines.push(`\n----- proposer ${p.model} (${mark}${inlineFull ? "" : "·摘录"}) -----`);
        lines.push(body);
      }
      lines.push("");
      if (hasAudit) {
        lines.push(`[proposer 全文：${auditNote(r)}]`);
      } else if (inlineFull) {
        lines.push(`[${auditNote(r, spoolErr)}；合计 ${totalChars} 字符已整份内联]`);
      } else {
        lines.push(
          `[${auditNote(r, spoolErr)}；且合计 ${totalChars} 字符超内联上限 ` +
            `${SALVAGE_INLINE_FALLBACK_MAX_CHARS}，已按证据密度摘录——完整正文本次无法保全]`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** structuredContent 的瘦身投影（机读契约 v2；MoaResult 本体不改，仅此投影层）。 */
export interface SlimMoaPayload {
  contractVersion: number;
  status: MoaResult["status"];
  /** 判决正文（机读主通道；≤预算，超则截头+标注，全文经 receipt.audit 指针取）。 */
  aggregated: string;
  /** §8.1:aggregated(与 content)头部是否由服务端前置了【最终裁决】段。aggregatedMeta 仍对账**原始**正文。 */
  verdictPrepended: boolean;
  aggregatedMeta: { chars: number; sha256: string };
  proposals: Array<{
    model: string;
    ok: boolean;
    empty: boolean;
    timeout: boolean;
    usage: unknown;
    costUsd: number;
    durationMs: number;
    sessionId?: string;
    error?: string;
    textChars: number;
    textSha256: string;
    textExcerpt: string;
    /** 静态审查 F2:spool 写失败且无 audit 指针时置 true——机读消费者据此转 content 通道的 salvage 段。 */
    spoolFailed?: boolean;
    /** §4.1 取证账紧凑子集(全量在 spool `[trace]` 行);缺省口径 exhaustedBy=null(结算后现算,2026-09-06 起不粘滞)。 */
    trace?: { calls: number; usedChars: number; exhaustedBy: string | null; rejections: number; durationMs: number };
  }>;
  receipt: MoaResult["receipt"];
  error: MoaResult["error"];
  spoolError?: string;
  /**
   * Jev 辅助代码审查（设计 v4 §3.7，2026-09-20，第三波 b）：每条 `pid level rel:lines 引用状态 合成状态`；
   * 未启用 jevcheck（`receipt.findings` 缺省）时为空数组。
   */
  findings_summary: string[];
  /** 每条 `ids level can_happen consequence trigger adopted?`；未启用/未接受结构化裁决时为空数组。 */
  verdicts_summary: string[];
}

/** `findings_summary` / `verdicts_summary` 单行 + 保留优先级（budget 裁剪用）。 */
interface JevSummaryLine {
  text: string;
  /** BLOCKER / 引用异常 / 含不符前提：超预算时优先保留。 */
  priority: boolean;
}

/** 超预算裁剪时追加的标注行（波三 b 修复单第 8 条：其字符开销须预扣进预算，不能另加在预算之外）。 */
const JEV_SUMMARY_TRUNC_MARKER = "…全文见 spool";

/**
 * Jev 辅助代码审查（设计 v4 §3.7）：`findings_summary`/`verdicts_summary` 两份摘要，合计受
 * `RESPONSE_STRUCT_AGG_BUDGET_CHARS`（复用既有常量的 8,000 字符值；这是一份独立核算的新预算，
 * 不与 `aggregated` 字段共享同一份额度）。超出按「BLOCKER / 引用异常 / 含不符前提 优先」保留
 * （先塞满两个数组各自的高优先级行，再给两个数组各分一半剩余额度补齐低优先级行——波三 b 修复单
 * 第 8 条：此前第二轮共享同一份预算池、findings 排在前面，会把 verdicts 的低优先级行整批挤空；
 * 现两个数组的第二轮互不挤占），有裁剪时在发生裁剪的那个数组末尾加一行「全文见 spool」，且该行
 * 的字符开销已预扣进预算（合计严格 ≤ `RESPONSE_STRUCT_AGG_BUDGET_CHARS`，不是裁完数据后另外加）。
 * `receipt.jevcheck` 已去 calls（裁决 C11），摘要里的引用/合成状态取自 receipt.jevcheck.perFinding
 * （无 calls 字段可用，本就不需要）。
 */
function buildJevSummaries(r: MoaResult): { findings_summary: string[]; verdicts_summary: string[] } {
  const findings = r.receipt.findings ?? [];
  const jevPerFinding = r.receipt.jevcheck?.perFinding;
  const findingLines: JevSummaryLine[] = findings.map((f) => {
    const check = jevPerFinding?.[f.pid];
    const ref = check?.ref ?? "未核";
    const status = check?.status ?? "未核";
    const priority = f.level === "BLOCKER" || ref !== "OK" || status === "含不符前提";
    return { text: `${f.pid} ${f.level} ${f.path}:${f.lines} ${ref} ${status}`, priority };
  });
  const verdicts = r.receipt.verdicts?.verdicts ?? [];
  const verdictLines: JevSummaryLine[] = verdicts.map((v) => {
    const priority = v.level === "BLOCKER" || v.table_handling !== undefined;
    // §12.2 D / §12.6 第 1、2 点（波四）：strength 带**改写后**的值（receipt.verdicts 已是服务端机械
    // 改写后的版本，见 orchestrate.ts）；strengthReported 非空时额外标一下自报原值，便于灰度对比。
    const strengthPart = v.strengthReported ? `${v.strength}(原报${v.strengthReported})` : v.strength;
    return {
      text: `${v.finding_ids.join("+")} ${v.level} ${v.can_happen} ${v.consequence} ${v.trigger} ${strengthPart}${v.adopted ? ` ${v.adopted}` : ""}`,
      priority,
    };
  });

  const budget = RESPONSE_STRUCT_AGG_BUDGET_CHARS;
  const totalChars = [...findingLines, ...verdictLines].reduce((s, l) => s + l.text.length + 1, 0);
  if (totalChars <= budget) {
    return { findings_summary: findingLines.map((l) => l.text), verdicts_summary: verdictLines.map((l) => l.text) };
  }

  // 预扣两份「全文见 spool」标注行的开销（findings/verdicts 各最多裁一次）：不管最终哪个/哪两个
  // 数组真被裁剪，数据 + 标注行合计仍严格 ≤ budget，而不是先按满预算塞数据、标注行另加在外面。
  const markerCost = JEV_SUMMARY_TRUNC_MARKER.length + 1;
  const contentBudget = Math.max(0, budget - 2 * markerCost);

  const keptFindings: string[] = [];
  const keptVerdicts: string[] = [];
  let droppedFindings = false;
  let droppedVerdicts = false;

  // 第一轮：两个数组各自的高优先级行（BLOCKER / 引用异常 / 含不符前提）先保留，共享同一份预算池
  // （先到先得：findings 优先行先取，再轮到 verdicts 优先行——与此前行为一致，只是预算改成
  // contentBudget；高优先级行本就应当尽量都保住，不在这里做对半分）。
  let used = 0;
  const takeShared = (lines: JevSummaryLine[], out: string[], onDrop: () => void): void => {
    for (const l of lines) {
      const cost = l.text.length + 1;
      if (used + cost > contentBudget) {
        onDrop();
        continue;
      }
      out.push(l.text);
      used += cost;
    }
  };
  takeShared(findingLines.filter((l) => l.priority), keptFindings, () => (droppedFindings = true));
  takeShared(verdictLines.filter((l) => l.priority), keptVerdicts, () => (droppedVerdicts = true));

  // 第二轮（波三 b 修复单第 8 条）：剩余预算两个数组各分一半，互不挤占——findings 低优先级行
  // 用不完自己那一半时，多出的份额**不**转给 verdicts（反之亦然），按修复单字面「各分一半」实现，
  // 不做更复杂的余量再分配（不 overdesign）。
  const remaining = Math.max(0, contentBudget - used);
  const findingsHalf = Math.floor(remaining / 2);
  const verdictsHalf = remaining - findingsHalf;
  const takeCapped = (lines: JevSummaryLine[], out: string[], cap: number, onDrop: () => void): void => {
    let localUsed = 0;
    for (const l of lines) {
      const cost = l.text.length + 1;
      if (localUsed + cost > cap) {
        onDrop();
        continue;
      }
      out.push(l.text);
      localUsed += cost;
    }
  };
  takeCapped(findingLines.filter((l) => !l.priority), keptFindings, findingsHalf, () => (droppedFindings = true));
  takeCapped(verdictLines.filter((l) => !l.priority), keptVerdicts, verdictsHalf, () => (droppedVerdicts = true));

  if (droppedFindings) keptFindings.push(JEV_SUMMARY_TRUNC_MARKER);
  if (droppedVerdicts) keptVerdicts.push(JEV_SUMMARY_TRUNC_MARKER);
  return { findings_summary: keptFindings, verdicts_summary: keptVerdicts };
}

/** MoaResult → SlimMoaPayload（v4 §6.1）。 */
export function toSlimPayload(r: MoaResult, spoolErr?: string): SlimMoaPayload {
  // §8.1:先前置裁决段(仅长正文且含标题),再做原有头截;aggregatedMeta 仍按**原始**正文计量/对账。
  const pv = prependVerdictIfNeeded(r.aggregated);
  const gate = truncateAtLine(pv.text, RESPONSE_STRUCT_AGG_BUDGET_CHARS);
  const spoolFailed = !r.receipt.audit && !!spoolErr;
  return {
    contractVersion: CONTRACT_VERSION,
    status: r.status,
    aggregated: gate.truncated
      ? `${gate.kept}\n…[超 structuredContent 预算 ${RESPONSE_STRUCT_AGG_BUDGET_CHARS} 截断${pv.prepended ? "（头部已前置【最终裁决】段）" : ""}；${auditNote(r, spoolErr)}]`
      : pv.text,
    verdictPrepended: pv.prepended,
    // P2 静态审查 F3:机读契约字段统一码点计量(String.length 是 UTF-16 码元,emoji 场景会漂)。
    aggregatedMeta: { chars: codePointLength(r.aggregated), sha256: r.receipt.bodySha256 },
    proposals: r.proposals.map((p) => ({
      model: p.model,
      ok: p.ok,
      empty: p.empty,
      timeout: p.timeout,
      usage: p.usage,
      costUsd: p.costUsd,
      durationMs: p.durationMs,
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      ...(p.error ? { error: p.error } : {}),
      textChars: codePointLength(p.text),
      textSha256: sha256Text(p.text),
      textExcerpt:
        p.text.length > PROPOSAL_EXCERPT_CHARS
          ? `${p.text.slice(0, PROPOSAL_EXCERPT_CHARS)}…`
          : p.text,
      ...(spoolFailed && p.text.length > 0 ? { spoolFailed: true } : {}),
      ...(p.trace
        ? {
            trace: {
              calls: p.trace.calls,
              usedChars: p.trace.usedChars,
              exhaustedBy: p.trace.exhaustedBy,
              rejections: p.trace.rejections,
              durationMs: p.trace.durationMs,
            },
          }
        : {}),
    })),
    receipt: r.receipt,
    error: r.error,
    ...(spoolErr ? { spoolError: spoolErr } : {}),
    ...buildJevSummaries(r),
  };
}

/** 回包 outputSchema（三工具共用；registerTool 用，SDK 据此校验 structuredContent 形状）。 */
export const moaToolOutput = {
  contractVersion: z.number().describe("回包契约版本；2=SlimMoaPayload（proposer 全文经 spool）"),
  status: z.enum(["ok", "failed", "aborted"]),
  aggregated: z.string().describe("判决正文（超预算截头并附 spool 指针）"),
  verdictPrepended: z
    .boolean()
    .describe("aggregated/content 头部是否由服务端前置了【最终裁决】段（§8.1）；aggregatedMeta 仍对账原始正文"),
  aggregatedMeta: z.object({ chars: z.number(), sha256: z.string() }),
  proposals: z.array(z.record(z.string(), z.unknown())),
  receipt: z.record(z.string(), z.unknown()),
  gaps: z.object({ records: z.array(z.record(z.string(), z.unknown())), writeCount: z.number() }).optional(),
  error: z.union([z.record(z.string(), z.unknown()), z.null()]),
  spoolError: z.string().optional(),
  // ★2026-09-20：toSlimPayload 自 Jev 辅助（buildJevSummaries）起多回这两个字段，但 outputSchema 漏列——
  //   Claude Code 不校验 structuredContent 所以没露馅，DSH 客户端严格校验直接拒收
  //   （"Structured content does not match the tool's output schema: data must NOT have additional properties"）。
  //   未启用 jevcheck 时恒为空数组，故声明为必填数组。
  findings_summary: z.array(z.string()).describe("Jev 辅助（verify 模式）每条 finding 一行摘要：pid level rel:lines 引用状态 合成状态；未启用时为空数组"),
  verdicts_summary: z.array(z.string()).describe("聚合器结构化裁决每条一行摘要：ids level can_happen consequence trigger strength adopted?；未启用时为空数组"),
};

/** MoaResult → MCP 工具返回。failed 置 isError（让调用 LLM 注意）；aborted 不算协议错误。 */
export function toToolResponse(r: MoaResult, spoolErr?: string): ToolResponse {
  return {
    content: [{ type: "text", text: formatSummary(r, spoolErr) }],
    structuredContent: toSlimPayload(r, spoolErr) as unknown as Record<string, unknown>,
    ...(r.status === "failed" ? { isError: true } : {}),
  };
}

/**
 * 统一收尾（v4 §10-A/B 顺序约束）：先 spool 落盘 → receipt.audit 写入 → 再格式化回包 → 字节数日志。
 * deliver 成功时 aggregated 已在交付 path，spool 只落 proposer 部分。
 */
export function finishToolResponse(
  toolLabel: string,
  r: MoaResult,
  deps: Pick<MoaToolDeps, "runId">,
): ToolResponse {
  const includeAggregated = !(r.status === "ok" && r.receipt.delivery?.written);
  const sp = writeSpool({ tool: toolLabel, result: r, includeAggregated });
  // 静态审查 F3:不原位 mutate 入参——audit 经浅拷贝挂载,MoaResult 原对象保持纯净。
  const rr: MoaResult = sp.audit ? { ...r, receipt: { ...r.receipt, audit: sp.audit } } : r;
  const resp = toToolResponse(rr, sp.error);
  // 回包字节数日志（v4 §9 观测；补掉"日志不记回包体积"的盲区）。只打 stderr。
  try {
    const contentChars = resp.content.reduce((s, c) => s + c.text.length, 0);
    const sj = JSON.stringify(resp.structuredContent);
    const totalBytes =
      Buffer.byteLength(sj, "utf8") +
      resp.content.reduce((s, c) => s + Buffer.byteLength(c.text, "utf8"), 0);
    console.error(
      `[moa#${deps.runId ?? "-"}] ${toolLabel} 响应：content ${contentChars} 字符｜structured ${sj.length} 字符｜共 ${totalBytes} 字节`,
    );
  } catch {
    /* 观测不影响主流程 */
  }
  return resp;
}

/** 工具核心运行依赖（server 与单测共用；runSessionImpl 仅测试注入）。 */
export interface MoaToolDeps {
  config: MoaConfig;
  modelRuntime: unknown;
  signal?: AbortSignal;
  onStageEvent?: (e: StageEvent) => void;
  runSessionImpl?: RunSessionImpl;
  /** 本次调用的短 run-id（server 入口生成），穿透编排日志与回包字节数日志（v4 §9）。 */
  runId?: string;
  /**
   * moa_deliver 专用：确定性写盘的路径 jail 白名单根。**必填、无缺省**（DESIGN §8.3 修复：
   * 此前 fallback 到 req.cwd/process.cwd，而 cwd 来自用户入参 → jail 根被调用方决定）。
   * 由 server 用受信任工作区（req.cwd）显式传入；空/缺省 → 拒绝一切写入。
   */
  allowedRoots?: string[];
  /**
   * moa_deliver 专用：拒写根（安装目录 projectRoot 及其子路径一律拒，DESIGN §8.3）。
   * 防覆写自身源码/配置（config/、src/）。
   */
  denyRoots?: string[];
}

/** 目标父目录是否落在某个根下（root 本身或其子路径）。 */
function isUnderRoot(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * 交付路径预闸（写盘前）：
 *   - allowedRoots 必填（DESIGN §8.3 修复：不回退 cwd）；空则拒。
 *   - 目标父目录若落在任一 denyRoot（安装目录）内则拒（防覆写自身源码/配置）。
 * 通过返回 null；违反返回人读拒绝理由。realpath 解析父目录，抗 symlink 逃逸。
 */
function deliverPathGuard(
  path: string,
  allowedRoots: string[],
  denyRoots: string[],
): string | null {
  if (allowedRoots.length === 0) {
    return "确定性交付缺少 allowedRoots：受信任工作区根未提供（deliver 需显式传入 cwd/工作区），拒绝一切写入";
  }
  if (denyRoots.length === 0) return null;
  const absParent = dirname(resolve(path));
  let realParent: string;
  try {
    realParent = realpathSync(absParent);
  } catch {
    realParent = absParent; // 父目录不存在时也按 resolve 后路径判定（后续 atomicWrite 仍会拒）
  }
  for (const d of denyRoots) {
    let realDeny: string;
    try {
      realDeny = realpathSync(d);
    } catch {
      realDeny = resolve(d);
    }
    if (isUnderRoot(realParent, realDeny)) {
      return `确定性交付拒绝：目标父目录 ${realParent} 落在安装目录（denyRoot ${realDeny}）内，禁止覆写自身源码/配置`;
    }
  }
  return null;
}

/** 解析 preset.mode（hasOwnProperty 门禁防原型链）；未知 preset → undefined（交给 runMoa 报 config 错）。 */
function resolvePresetMode(config: MoaConfig, presetName: string): Mode | undefined {
  if (!Object.prototype.hasOwnProperty.call(config.presets, presetName)) return undefined;
  return config.presets[presetName]?.mode;
}

/** 构造 config 阶段的 failed 结果（越界拒绝用）。 */
function configFailed(mode: Mode, presetName: string, reason: string): MoaResult {
  return {
    status: "failed",
    aggregated: "",
    proposals: [],
    receipt: {
      mode,
      preset: presetName,
      models: [],
      quorum: "0/0",
      profile: "",
      proposerMarks: {},
      // 「失败也给结构」：config 阶段就没跑 proposer，给合法空值（与 makeEmptyReceipt 同口径）。
      proposals: [],
      aggregator: { model: "", usage: null, costUsd: 0, durationMs: 0 },
      bodySha256: "",
      totalCostUsd: 0,
      delivery: null,
    },
    error: { stage: "config", reason },
  };
}

/**
 * 边界校验（fix #4 提权修复）：解析后的 preset.mode 必须与本工具默认 preset 的 mode 一致。
 * moa_run 默认 preset 是 synthesize → 调用方用 `preset` 覆盖成 verify 会被拒（否则拿到沙箱
 * bash_readonly，与 moa_run「只读不执行」描述不符，能力越界）。moa_verify 默认 preset 是 verify →
 * 同理锁死 verify。deliver 不走此路（forceProfile 已把 worker 一律降为只读，无越界风险）。
 * 一致或无法判定（未知 preset，交给 runMoa 报 config 错）→ 返回 null。
 */
export function enforcePresetModeMatchesTool(
  config: MoaConfig,
  req: MoaRequest,
  defaultPreset: string,
  // ★静态审查 F1(2026-08-25):工具的模式锁必须硬编码,不得从 defaults.preset 继承——
  //   否则运维把 defaults.preset 配成 verify 时,moa_run 会放行 verify preset,
  //   verify-worker 的 bash_readonly 命令面以「只读不执行」的 moa_run 之名被拿到(提权面)。
  expectedOverride?: Mode,
): MoaResult | null {
  const expected = expectedOverride ?? resolvePresetMode(config, defaultPreset);
  const requested = req.preset ?? defaultPreset;
  const actual = req.mode ?? resolvePresetMode(config, requested);
  if (expected === undefined || actual === undefined) return null; // 未知 preset → 交给 runMoa
  if (actual === expected) return null;
  return configFailed(
    actual,
    requested,
    `工具边界违反：本工具锁定 ${expected} 模式，但请求的 preset="${requested}" 是 ${actual} 模式，越界被拒。` +
      (expected === "synthesize"
        ? "moa_run 只读不执行代码，不接受 verify preset（含沙箱 bash_readonly）；如需只读验真请改用 moa_verify 工具。"
        : "moa_verify 强制只读验真，不接受 synthesize preset；如需综合请改用 moa_run 工具。"),
  );
}

/**
 * ★2026-09-20 PIMOA-DEF-01：verify 硬门要求每条 finding 的 path 必须解析进本轮材料
 * （src/tools/submit_findings.ts 的 resolveMaterial），材料为空时该轮在**数学上不可能成功**——
 * 但服务端仍会完整启动 N 个 proposer 会话、每个跑满 3 次结构化提交尝试（实测约 2 分钟）才失败，
 * 且失败原因呈现为「proposer 未交合格清单」，把调用方的用法错误伪装成模型不合格。
 * 本闸在**进模型之前**把必然失败显式化（下游对 applyRecon fail-open 后果的显式化，不改 fail-open）。
 *
 * 只拦 verify：synthesize / deliver 没有该硬门，无材料是合法的。
 * 硬门没开（jevcheck 关，或 submit.required=false）时不拦——此时无材料同样合法。
 * `?.` 与 orchestrate.runMoaInner 的 `config.jevcheck?.enabled` 同惯例：内存直构 config
 * （测试 fixture）可无 jevcheck 段 ⇒ 视同 enabled=false，绝不因此抛异常。
 */
export function enforceVerifyMaterialsPresent(
  config: MoaConfig,
  req: MoaRequest,
  mode: Mode,
  presetName: string,
): MoaResult | null {
  if (mode !== "verify") return null; // 只有 verify 有硬门
  // ★2026-09-20 徐总批准：未知 preset 时本闸必须让路——否则调用方同时给错 preset 和空材料，
  //   会被指去补材料，补完才被告知 preset 写错了（两次往返，且同属「归因错位」）。
  //   resolvePresetMode 返回 undefined 即未知 preset，交 runMoa 报「preset 未找到」。
  //   （无需另加异常保护：同一 (config, presetName) 在上方 enforcePresetModeMatchesTool 里已被
  //   同一函数用同一 config 解析过一次，config.presets 缺失会先在那里抛，不因本行新增抛出点。）
  if (resolvePresetMode(config, presetName) === undefined) return null;
  if (!config.jevcheck?.enabled || !config.jevcheck.submit.required) return null; // 硬门没开就不拦
  if ((req.materials?.size ?? 0) > 0) return null; // 有材料，放行
  return configFailed(
    "verify",
    presetName,
    "verify 轮材料为空：本轮没有成功附入任何文件（files / files_ranges / recon_query 三者都没给，" +
      "或给了但 recon 判空 / 侦查失败 fail-open），而 jevcheck.submit.required=true 要求每条 finding 的 " +
      "path 必须解析进本轮材料 ⇒ 结构化清单必然全拒，整轮必然 failed。请在 files / files_ranges / " +
      "recon_query 里至少给一份可读材料；若确实无需材料，请改用 moa_run（synthesize，不要求结构化清单）。",
  );
}

/**
 * 工具核心：构造 MoaRequest → runMoa → MCP 返回。transport 无关，单测可直调。
 * 绝不抛：runMoa 自身 fail-closed 折成 MoaResult；这里只做形状转换。
 */
export async function runMoaTool(
  input: MoaToolInput,
  defaultPreset: string,
  deps: MoaToolDeps,
): Promise<ToolResponse> {
  const req = await applyRecon(
    buildRequest(input, defaultPreset),
    input,
    deps.config.access?.readRoots ?? [],
  );
  // 越界拒绝：preset.mode 必须与本工具**硬编码**的模式一致（fix #4 + 静态审查 F1）。
  const toolLabel = defaultPreset === "moa_verify" ? "moa_verify" : "moa_run";
  const expectedMode: Mode = toolLabel === "moa_verify" ? "verify" : "synthesize";
  const boundaryErr = enforcePresetModeMatchesTool(deps.config, req, defaultPreset, expectedMode);
  if (boundaryErr) return finishToolResponse(toolLabel, boundaryErr, deps);
  // 材料合并闸(v4 §4.2):recon 已并入 req.context,此处对 prompt+context 总量 fail-loud 把关。
  const materialErr = enforceMaterialBudget(req, expectedMode, req.preset ?? defaultPreset);
  if (materialErr) return finishToolResponse(toolLabel, materialErr, deps);
  // ★2026-09-20 PIMOA-DEF-01：verify 硬门要求每条 finding 的 path 必须解析进本轮材料，
  //   材料为空时该轮在数学上不可能成功——必须在进模型前 fail-fast，而不是让每个 proposer
  //   跑满 3 次结构化提交尝试后才报「proposer 未交合格清单」（把用法错误伪装成模型不合格）。
  const emptyMaterialErr = enforceVerifyMaterialsPresent(deps.config, req, expectedMode, req.preset ?? defaultPreset);
  if (emptyMaterialErr) return finishToolResponse(toolLabel, emptyMaterialErr, deps);
  const r = await runMoa(deps.config, req, {
    modelRuntime: deps.modelRuntime,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onStageEvent ? { onStageEvent: deps.onStageEvent } : {}),
    ...(deps.runSessionImpl ? { runSessionImpl: deps.runSessionImpl } : {}),
    ...(deps.runId ? { runId: deps.runId } : {}),
  });
  return finishToolResponse(toolLabel, r, deps);
}

// ============================================================================
// moa_deliver —— synthesize/verify + 确定性落盘交付（DESIGN §6）。
// ============================================================================

/** moa_deliver 入参 = 通用 moa 入参 + path（必）+ done_marker（必）。 */
export const moaDeliverToolInput = {
  ...moaToolInput,
  path: z
    .string()
    .min(1)
    .describe(
      "交付目标文件路径。父目录必须在受信任工作区根（cwd）之下、且不得落在安装目录内；" +
        "拒绝 symlink 逃逸与目录穿越。正文由本工具的代码原子写入，非 LLM 写。",
    ),
  done_marker: z
    .string()
    .regex(DONE_MARKER_RE)
    .describe(
      "完成标记，格式 DONE_[A-Z0-9_]+（如 DONE_REPORT）。" +
        "聚合正文的最后一非空行必须等于它；写盘后回读时二次核对。",
    ),
};

/** moa_deliver 入参类型（形状对齐 moaDeliverToolInput）。 */
export interface MoaDeliverToolInput extends MoaToolInput {
  path: string;
  done_marker: string;
}

export const MOA_DELIVER_DESCRIPTION =
  "多模型综合 + 确定性落盘交付（deliver）：先跑 MoA（proposers→aggregator）产出最终正文，" +
  "再由**系统代码**（非 LLM）把该正文原子写入指定文件并回读校验，最后在 receipt.delivery 记录取证。" +
  "适用：要一份「多模型交叉 + 可审计落盘」的交付物（报告 / 结论 / 评审意见）。" +
  "确定性交付：临时文件→fsync→rename 原子替换，回读核对 sha256 与末行 done_marker，全过才算 written。" +
  "交付阶段所有 worker 一律降为只读 profile（delivery-readonly-worker）：正文由代码写，模型不碰文件系统写。" +
  "硬约束：path 的父目录必须在允许根之下（拒 symlink 逃逸 / 目录穿越）；" +
  "done_marker 须匹配 DONE_[A-Z0-9_]+，且必须是正文最后一非空行（请让 prompt 要求模型以该标记结尾）。" +
  "fail-closed：MoA 失败则不写盘、透传 failed；写盘 / 回读任一不符则 status=failed（error.stage=delivery）。" +
  "返回结构同 moa_run（status/aggregated/proposals/receipt/error），成功时 receipt.delivery={written:true,path,sha256}。";

/**
 * moa_deliver 工具核心：跑 MoA（强制只读 profile）→ 确定性写盘 → 组装 receipt.delivery。
 * 绝不抛：runMoa 自身 fail-closed；写盘失败折成 status=failed(error.stage=delivery)。
 *
 * 交付阶段只读性由 orchestrate 的 forceProfile 在安全边界内钉死（覆盖 preset 与入参），
 * 防 verify preset 把 bash_readonly 泄进交付阶段——比在此处 coerce req.models 更牢固
 * （coerce 会被 orchestrate 的 profile 授权重新覆盖）。
 */
export async function runMoaDeliverTool(
  input: MoaDeliverToolInput,
  defaultPreset: string,
  deps: MoaToolDeps,
): Promise<ToolResponse> {
  // 1) 跑 MoA。forceProfile 把全部 worker 钉死为 delivery-readonly-worker（无论 preset）。
  //    覆盖入参 models/aggregator 只贡献 provider/model，profile 由 orchestrate 强制。
  //    ★注意：readRoots 只放大**侦查/会话的读**面，与下方第 3 步的写盘 allowedRoots 完全无关——
  //      写根仍旧只有 server 传的受信任工作区（cwd），跨仓只读根绝不给写。
  const req = await applyRecon(
    buildRequest(input, defaultPreset),
    input,
    deps.config.access?.readRoots ?? [],
  );
  // P2 静态审查 F1:deliver 与 run 对称锁定 synthesize——verify preset 会把模型族/提示词模板/
  // 工具面静默切档(forceProfile 只保写盘只读,不保模式语义)。守卫过后 mode 必为 synthesize,
  // 下方材料闸的 "synthesize" 档因此成立。
  const deliverBoundaryErr = enforcePresetModeMatchesTool(
    deps.config,
    req,
    defaultPreset,
    "synthesize",
  );
  if (deliverBoundaryErr) return finishToolResponse("moa_deliver", deliverBoundaryErr, deps);
  // 材料合并闸(v4 §4.2;deliver 走 synthesize 档预算)。
  const materialErr = enforceMaterialBudget(req, "synthesize", req.preset ?? defaultPreset);
  if (materialErr) return finishToolResponse("moa_deliver", materialErr, deps);
  const r = await runMoa(deps.config, req, {
    modelRuntime: deps.modelRuntime,
    forceProfile: "delivery-readonly-worker",
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onStageEvent ? { onStageEvent: deps.onStageEvent } : {}),
    ...(deps.runSessionImpl ? { runSessionImpl: deps.runSessionImpl } : {}),
    ...(deps.runId ? { runId: deps.runId } : {}),
  });

  // 2) MoA 失败（fail-closed）→ 不写盘，透传 failed / aborted。
  if (r.status !== "ok") {
    return finishToolResponse("moa_deliver", r, deps);
  }

  // 3) 写盘前路径预闸：allowedRoots 必填（不回退 cwd）+ 排除安装目录（DESIGN §8.3）。
  const allowedRoots = deps.allowedRoots ?? [];
  const denyRoots = deps.denyRoots ?? [];
  const guardErr = deliverPathGuard(input.path, allowedRoots, denyRoots);
  if (guardErr) {
    const failed: MoaResult = {
      ...r,
      status: "failed",
      error: { stage: "delivery", reason: guardErr },
      receipt: { ...r.receipt, delivery: { written: false, path: input.path, sha256: "" } },
    };
    return finishToolResponse("moa_deliver", failed, deps);
  }

  // 4) 确定性写盘 + 回读校验。
  try {
    const w = atomicWriteWithVerify({
      path: input.path,
      body: r.aggregated,
      doneMarker: input.done_marker,
      allowedRoots,
    });
    // 写盘成功：在 receipt.delivery 记录取证（DESIGN §4.6 B）。
    // 注：delivery 阶段的 MCP 进度通知需扩 events.ts 的 StageEvent 联合（本轮不越界改 events.ts），
    //     故交付取证仅经 receipt.delivery 随返回体透出，暂不发独立 notification。
    r.receipt.delivery = { written: true, path: w.path, sha256: w.sha256 };
    return finishToolResponse("moa_deliver", r, deps);
  } catch (err) {
    // 4) 写盘 / 回读失败 → status 反映交付失败（error.stage=delivery），不改动已生成正文。
    const detail = err instanceof Error ? err.message : String(err);
    const failed: MoaResult = {
      ...r,
      status: "failed",
      error: { stage: "delivery", reason: "确定性交付写盘失败", detail },
      receipt: { ...r.receipt, delivery: { written: false, path: input.path, sha256: "" } },
    };
    return finishToolResponse("moa_deliver", failed, deps);
  }
}
