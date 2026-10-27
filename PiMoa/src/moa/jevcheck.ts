/**
 * jevcheck —— Jev 辅助代码审查详细设计 v4 §3.5（第二波，2026-09-20）。
 *
 * 做什么：quorum 汇齐后（或按 finding 流水化），对每条已接受 finding 做机械 + Jev 双重核验——
 *   ① 引用（anchor）是否落在真实材料上；② 每条事实是否与材料/通用规范相符（按事实自引位置切片）；
 *   ③ 前提能否推出 claim（entail）；④ 前提不足时起独立短会话补前提再核；⑤ 跨 proposer 同题/冲突；
 *   ⑥ 单边项。产出核对表（只用状态词，不带概率数字）供 aggregator 参考，不是判决。
 *
 * fail-open：Jev 连接失败/HTTP 5xx/解析失败连续 3 次 → 抛 `JevUnavailable`，`runJevCheck` 捕获后
 * 回 `enabled:false` 且写明 `skipped`；调用方（orchestrate）据此把核对表替换成「本轮未做 Jev 核对」，
 * 绝不让 Jev 不可用拖垮 verify 主流程。
 *
 * 为什么这里能看到 workers / runSessionFn：补前提（premiseRound）要用**同一个 proposer 模型**起一个
 * 独立短会话（§3.2 裁决 C2/C3/C12：删除 proposer 会话内 followUp，改为 jevcheck 阶段的并行短会话），
 * 故需要 `WorkerRef[]`（按 proposerIndex 找回模型）与 `runSession` 同签名的注入点（供测试用 mock）。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, ProtocolError, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { RunSessionOptions, SessionRunResult } from "./session.js";
import type { WorkerRef } from "../config/types.js";
import type { JevcheckCfg } from "../config/types.js";
import type { StageEvent } from "../mcp/events.js";
import type { FactCheck, FactLocPath, FindingCheck, FindingRecord, FindingTruth, GapRecord, JevCall, JevCheckReport, MaterialFile, MaterialMap } from "./types.js";
import {
  anchorHit,
  createAmendFactsTool,
  createAmendState,
  factKind,
  percentDecodedVariant,
  parseFactLineRef,
  rewriteFactLine,
  type AmendState,
  type FactRef,
} from "../tools/submit_findings.js";
// ★2026-09-21「改 3：从哪里抄」的两项必修前置 (i)(ii)：核对表里印的派生标记（须填：…）必须与
// `validateVerdicts` 的门控**同源**，故判据一律 import 自服务端本体，禁止在本文件复制一份：
//   (i) `isAnomalous` = status==="含不符前提" || ref!=="OK"。**绝不能**改用本文件 renderCheckTable 里
//       那个语义宽得多的同名布局函数（它把所有非「前提完备且全部相符」都算异常，还含同题/冲突两档）——
//       那会在并不触发门控的条目上印「须填：table_handling」，正是本方案要消灭的那类不一致。
//   (ii) `conditionFactCount` = [...facts, ...amended.added] 里 condition 类条数，与 §6.3 校验同一个数；
//        门是 `fc.conditionFlag`（`conditionFactCount > 0` 而 flag=false 很常见，按「有条件就印」会误标）。
// import 方向无环：submit_verdicts.ts 只 import submit_findings.js 与 moa/types.js。
import { conditionFactCount, isAnomalous } from "../tools/submit_verdicts.js";
// 单一真源（第三波 b，任务书第 4 点）：FindingRecord 已挪到 types.ts，此处 re-export 保外部导入兼容
// （test/jevcheck.test.ts 等仍从 "../src/moa/jevcheck.js" 导入 FindingRecord）。
export type { FindingRecord };
import {
  JEVCHECK_CONDITION_FLAG_MIN,
  JEVCHECK_FACT_PAD,
  JEVCHECK_FALLBACK_PAD,
  JEVCHECK_REFUTE_P,
  JEVCHECK_SAME_MAX_PAIRS,
  JEVCHECK_TABLE_MAX_CHARS,
  JEVCHECK_WEAK_P,
  jevEnforceChain,
  jevLinkSamples,
  jevMechEnabled,
  jevTruthThresholds,
  type TruthThresholds,
} from "../config/limits.js";
// B4（波3）：机械佐证层复用（波2 落地 `mech-rules/v1`）——verdictOf 直接读 `MechResult.reason`
// （unform/locate-miss，波3 裁决 2026-09-22 补齐到设计形状），**不做 note 前缀解析**。
import { mechCorroborate, type MechResult } from "./mech.js";

/** `runSession` 同签名的注入点（只取类型，不拉运行时依赖，避免与 orchestrate.ts 产生环）。 */
export type RunSessionFn = (
  modelRuntime: ModelRuntime,
  worker: WorkerRef,
  prompt: string,
  opts: RunSessionOptions,
) => Promise<SessionRunResult>;

// `FindingRecord`（已接受 finding 的编排层视图，runJevCheck 的输入单位）现定义在 types.ts 并在上方 re-export。
const gapDiagnostics = (cfg: JevcheckCfg): boolean => cfg.gapList?.enabled === true;

/** Batch 12: read-only cross-round hints. The caller gates this before touching the spool. */
export function historicalMaterialGapHints(spoolDir = join(homedir(), ".pimoa", "spool")): string {
  try {
    // TTL counts spool rounds, including rounds without gaps. File time (mtime) is newest first.
    const recent = readdirSync(spoolDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => ({ name: entry.name, mtime: statSync(join(spoolDir, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
      .slice(0, 5);
    const seen = new Set<string>();
    const needs: string[] = [];
    for (const file of recent) {
      try {
        const body = readFileSync(join(spoolDir, file.name), "utf8");
        const receipt = body.match(/^## receipt[ \t]*\r?\n[ \t\r\n]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/m);
        if (!receipt) continue;
        const parsed: unknown = JSON.parse(receipt[1]);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const gaps = (parsed as { gaps?: { records?: unknown } }).gaps?.records;
        if (!Array.isArray(gaps)) continue;
        for (const record of gaps) {
          if (!record || typeof record !== "object") continue;
          const { kind, need } = record as { kind?: unknown; need?: unknown };
          if (kind !== "locate-fail" && kind !== "chain-evidence-missing") continue;
          if (!Array.isArray(need) || !need.length || !need.every((part) => typeof part === "string")) continue;
          // Spool is untrusted text. Keep each hint on one bounded line, solely as a request for evidence.
          const rawNeed = need.join("；");
          const text = rawNeed.replace(/\s+/g, " ").trim().slice(0, 320);
          if (!text) continue;
          const hash = createHash("sha256").update(rawNeed).digest("hex");
          if (seen.has(hash)) continue;
          seen.add(hash);
          needs.push(text);
          if (needs.length === 10) break;
        }
      } catch { /* Invalid/unreadable receipt: skip this round without interrupting verify. */ }
      if (needs.length === 10) break;
    }
    return needs.length
      ? "===== 历史材料缺口提示（仅供取证，不是事实断言）=====\n" +
        "以下是此前回执记录的材料请求；仅在与本轮任务相关时尝试补充证据。勿当成已证实事实，也勿据此直接下结论：\n" +
        needs.map((need) => `- 请核查并按需补充材料：${need}`).join("\n") + "\n"
      : "";
  } catch { return ""; } // Missing/inaccessible spool or metadata never blocks the main flow.
}
const markState = (calls: JevCall[], state: string, rawChars: number): void => {
  for (const c of calls) { c.stateChars = rawChars; c.stateCapped = rawChars > state.length; }
};

// ---------------------------------------------------------------------------
// 五条问法原文（常量，设计 v4 §4：与 v3 §4 相同）；采样次数一律由 cfg.sampling 决定
// （波二修复单 18：含 "fixed"，此前取本文件内局部常量，未受 cfg.sampling 统一管辖）。
// ---------------------------------------------------------------------------

interface QuestionSpec {
  instructions: string;
  /** noul 问法 = { true, false }；choice 问法（recheck）= 选项键 → 选项含义（闭集三值）。 */
  criteria: Record<string, string>;
}

/** fact / link 共用同一份 noul 问法（设计稿 §B2「link 与 fact 同 noul 模板」；附录 A 把 fact/link 冻结为
 * 同一问法模板，逐字文案的落地面在波1 A3 的 jev 侧模板，本表保持判定面 v4 问法稳定——test/jevcheck.test.ts
 * 用例 23 锁定 fact 问法原文，link 与之逐字一致即「同模板」）。 */
const FACT_LINK_SPEC: QuestionSpec = {
  // 波二修复单 13：改回设计 v4 §4 原文（此前误把「材料」写成「代码」）。
  instructions: "这条事实与所给材料（或所述通用规范）相符。",
  criteria: { true: "相符", false: "不相符：引用位置/内容与代码不一致，或所述通用行为不成立" },
};

export const QUESTIONS: Record<JevCall["q"], QuestionSpec> = {
  fact: FACT_LINK_SPEC,
  "fact-behave": {
    instructions: "切片（所给材料）所示内容与该断言的核心行为/规范一致。",
    criteria: { true: "一致：材料所示单步行为/规范与断言核心相符", false: "不一致：材料所示内容与断言核心行为/规范相悖，或断言所指内容不在材料所示范围内" },
  },
  // B2（设计稿 §B2，波2）：link = chain 因果推断步的 noul 问法，与 fact 同模板。
  link: FACT_LINK_SPEC,
  fixed: {
    instructions: "所给代码已经包含「待核对的处理」所述的那种处理。",
    criteria: { true: "已包含：代码中已有等价的处理", false: "未包含：代码中没有这种处理，或处理不等价" },
  },
  entail: {
    instructions:
      "仅凭上述前提即可推出「待判断的结论」（前提足以推出结论，没有缺失的必要条件，也没有与前提相反）。",
    criteria: { true: "可以推出", false: "不能推出：缺少必要条件、结论与前提相反、或结论超出前提所述" },
  },
  same: {
    instructions: "下面两条代码审查发现（finding A 与 finding B）指向的是同一个问题。",
    criteria: {
      true: "两条指向同一个问题：描述的是代码中同一处缺陷，只是措辞不同，应当合并去重",
      false: "两条指向不同问题：描述的是代码中两处互相独立的缺陷，不应合并",
    },
  },
  opposite: {
    instructions: "两条发现针对同一处代码得出了相反或明显不一致的结论（一方认为有缺陷/更严重，另一方认为不成立/更轻）。",
    criteria: { true: "相反或不一致", false: "一致或只是措辞不同" },
  },
  // §4.8 独立复核闸（设计 §4.8，波4）：choice 三值闭集（真源=设计 §4.8「独立复核闸」条原文）。
  // 触发 = aggregator 判假且锚点 mechCorroborate 为 unform 拒核；「驳回成立」+置信 ≥0.7 ⇒ 双闸一致可结案，
  // 「驳回不成立」= 双闸分歧；「材料不足」或置信 <0.7 ⇒ ③ 档留主代理。
  recheck: {
    instructions: "下面是一条被驳回的代码审查发现与驳回理由（含反证锚点）。闭集复核：该驳回是否成立。",
    criteria: {
      "驳回成立": "锚点与反证相合",
      "驳回不成立": "锚点不成立或反证不足",
      "材料不足": "材料不足以判断",
    },
  },
  // DESIGN §7.3 + Appendix G (the latter overrides ambiguous od-conflict wording).
  "fg-skip": { instructions: "按所附验收命令运行时，该测试会以 SKIP 结束且该口径把 SKIP 计为通过。", criteria: { true: "按所附验收命令运行，该测试以 SKIP 结束，且该验收口径把 SKIP 计为通过", false: "该测试不以 SKIP 结束，或该验收口径不把 SKIP 计为通过" } },
  "fg-vacuous": { instructions: "该测试的断言未对被测契约的可观察输出做任何断言（只查无错不算）。", criteria: { true: "该测试的断言未触及被测契约的可观察输出（仅查无错不算断言）", false: "该测试对被测契约的可观察输出做了断言" } },
  "fg-mock": { instructions: "材料显示，该测试在声称验证的路径上以替身替换了真实依赖（需依赖装配段佐证）。", criteria: { true: "依赖装配段显示：声称验证的路径上以替身替换了真实依赖", false: "声称验证的路径上未使用替身，或装配段不支持该结论" } },
  "fg-readback": { instructions: "该测试对写库/外部效果做了回读断言。", criteria: { true: "该测试对写库/外部效果做了回读断言（削弱「无回读」子指控）", false: "该测试未对写库/外部效果做回读断言" } },
  "wr-path": { instructions: "所附材料展示了可逐段核对的「入口 → 注册调用」链（每一跳都在材料内）。", criteria: { true: "材料内「入口 → 注册调用」每一跳都在场，链可逐段核对", false: "路径缺口：链存在不在材料内的跳，需补中间文件（不等于「未接线」）" } },
  "wr-hop-1": { instructions: "材料第 1 跳的调用方与被调方逐字衔接。", criteria: { true: "第 1 跳调用表达式指向所附被调方代码", false: "第 1 跳调用方和被调方代码不衔接" } },
  "wr-hop-2": { instructions: "材料第 2 跳的调用方与被调方逐字衔接。", criteria: { true: "第 2 跳调用表达式指向所附被调方代码", false: "第 2 跳调用方和被调方代码不衔接" } },
  "wr-key": { instructions: "注册方与消费方双端在场时，写入键与读取键（含别名/转换展开后）是同一键。", criteria: { true: "展开后写入键与读取键是同一键", false: "展开后写入键与读取键不是同一键" } },
  "wr-static": { instructions: "材料内池内范围未见该能力的运行时读取点。", criteria: { true: "本轮材料池内未见该能力的运行时读取点（池内风险信号，限于本轮材料，不外推全仓）", false: "材料内可见该能力的运行时读取点" } },
  "hd-policy": { instructions: "该常量承载来源政策/路径/资格规则语义（对照反例：缓冲大小、数学常数等技术常量）。", criteria: { true: "该常量承载来源政策/路径/资格规则语义", false: "该常量属缓冲大小、数学常数等技术常量类" } },
  "hd-gate-exist": { instructions: "材料内存在 Gate/Registry/配置机制。", criteria: { true: "材料内可见 Gate/Registry/配置机制", false: "材料内未见任何 Gate/Registry/配置机制" } },
  "hd-gate-fit": { instructions: "该机制的语义与调用域覆盖该常量的用途。", criteria: { true: "机制语义与调用域覆盖该常量用途（应走机制，支持绕过指控）", false: "机制在而不适用，或材料内无该机制可覆盖该用途" } },
  "hd-exempt": { instructions: "按所附豁免裁决节选，该常量属已裁决豁免类。", criteria: { true: "按所附豁免裁决节选，该常量属已裁决豁免类（削弱指控）", false: "按所附豁免裁决节选，该常量不属已裁决豁免类" } },
  "od-path": { instructions: "材料给出了可逐段核对的调用路径显示该改动项防范的风险可达。", criteria: { true: "材料给出了可逐段核对的调用路径且显示该风险可达", false: "材料未给出这样的路径（未知/需探针，不直接支持指控）" } },
  "od-conflict": { instructions: "该 finding 所指的问题（改动项为之防御的那个风险）与本任务合同条款直接冲突——即合同要求的行为/范围与该风险的存在互斥。", criteria: { true: "该 finding 所指的问题（改动项为之防御的风险）与合同条款直接冲突，修复为合同所要求", false: "该 finding 所指的问题（改动项为之防御的风险）与合同条款不直接冲突" } },
  "od-repro": { instructions: "材料给出了具体输入或现有真实路径的复现描述。", criteria: { true: "材料给出了具体输入或现有真实路径的复现描述", false: "材料未给出复现描述" } },
  "od-dup": { instructions: "材料内，该改动项所在调用路径的上游已存在与该改动项语义相同的校验/防御（同一受验输入、同一失败语义；验不同输入或不同失败语义者不算相同）。", criteria: { true: "材料内上游路径已存在与该改动项相同的校验/防御（同输入、同失败语义）", false: "材料内上游路径不存在相同校验/防御（无上游校验，或上游校验的受验输入/失败语义不同——不算相同）" } },
  "od-second-caller": { instructions: "材料内存在第二个使用该泛化签名/抽象的调用方（除首个调用点外，材料内可见另一调用点以该泛化形态调用）。", criteria: { true: "材料内可见第二个调用点使用该泛化签名/抽象（两个不同调用点）", false: "材料内该泛化签名/抽象仅有一个调用点（定义不算调用点）" } },
  "od-second-reader": { instructions: "材料内存在该配置键的第二个读取点（除首个读取点外，材料内可见另一代码位置读取同一配置键）。", criteria: { true: "材料内可见第二个读取点读取同一配置键（两个不同读取位置）", false: "材料内该配置键仅有一个读取点" } },
  "od-reach-combo": { instructions: "材料内，被该改动项防范的输入组合存在可达的调用路径（从入口到该输入组合触发改动项守卫的链路每一跳都在材料内、可逐段核对）。", criteria: { true: "材料内入口→触发改动项守卫的链路可逐段核对，被防输入组合可达", false: "材料内该输入组合不可达，或链路存在材料外的跳段、不可逐段核对" } },
};

/** fixPresent 无函数体可定位时的兜底 pad（v3 §4「函数体或 ±40 行」）。 */
const JEV_FIXED_PAD = 40;

/**
 * state 体积上限（波二修复单 17）：Jev 官方规格 state + 问题 ≤32k token，这里按字符数粗略把关；
 * `src/config/limits.ts` 不允许改（修复单已限定），故放在本文件顶部。
 */
const JEVCHECK_STATE_MAX_CHARS = 20_000;

/** 切片文本超过 `JEVCHECK_STATE_MAX_CHARS` 时截断并标注，供拼进 state 前调用（修复单 17）。 */
function capStateText(text: string): string {
  if (text.length <= JEVCHECK_STATE_MAX_CHARS) return text;
  const marker = "\n…（切片过长已截断）";
  const cut = Math.max(0, JEVCHECK_STATE_MAX_CHARS - marker.length);
  return (text.slice(0, cut) + marker).slice(0, JEVCHECK_STATE_MAX_CHARS);
}

/** state 切片标题：.md/.txt 文档写「## 材料（…）」，其余写「## 代码（…）」（波二修复单 13）。 */
function sliceHeading(rel: string): string {
  return /\.(md|txt)$/i.test(rel) ? "材料" : "代码";
}

// ---------------------------------------------------------------------------
// JevClient：进程级单例 + 信号量 + 限流退避 + 连续失败判不可用
// ---------------------------------------------------------------------------

export class JevUnavailable extends Error {}
/** 限流重试耗尽（k>5 仍被拒）：视为该次采样失败，不计入「不可用」连续计数。 */
export class JevThrottled extends Error {}
/**
 * Jev 回了 JSON-RPC 协议层 `error`（与 tool 结果 `result.isError` 是两回事，不能混）：官方客户端以
 * `ProtocolError` 抛出，callJudge 转成本类，由 requestOnce 按「连接失败/5xx/解析失败」同一口径记一次
 * 连续失败——单样本失败，不在此处判不可用。message 只含 code 与截断后的 error.message，不带 error.data/请求载荷。
 */
export class JevRpcError extends Error {
  constructor(
    readonly code: number | null,
    rpcMessage: string,
    options?: ErrorOptions,
  ) {
    super(`jev_judge JSON-RPC 错误 code=${code ?? "?"}：${rpcMessage}`, options);
  }
}

/** 错误信息里引用外部文本时统一压成单行并截断，防止把大段响应体带进日志/回包。 */
function oneLineSnippet(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 响应结构非法的统一报错：消息只含字段路径，不带响应载荷（原始 SDK 错误挂在 cause 上）。 */
class JevShapeError extends Error {}

function isZodError(err: unknown): boolean {
  return err instanceof Error && (err.name === "ZodError" || err.constructor?.name === "ZodError");
}

/**
 * 官方客户端对「收到但无法对上号」的消息不会让对应请求失败，只报 `client.onerror` 并丢弃该消息，请求随后挂到超时：
 *  · JSON-RPC 消息未通过 schema 校验（error 为 `{}`、既无 result 也无 error、result 为 null/数组/字符串等）→ ZodError；
 *  · 响应 id 对不上任何在飞请求 → "Received a response for an unknown message ID: {…载荷…}"。
 * 这两类即判连接不可信，返回一个**不带载荷**的稳定错误；其余 onerror（如 SSE 里一行坏数据之后仍有合法回复、
 * 进度通知 token 不认识等）不影响请求结果，返回 undefined 忽略。
 */
function connFaultOf(err: unknown, hadAbort: boolean): Error | undefined {
  if (isZodError(err)) {
    return new JevShapeError("jev_judge 响应结构非法：收到未通过 JSON-RPC schema 校验的消息", { cause: err });
  }
  // 本连接上已有请求被取消/超时：legacy 取消不掐 HTTP 流，对端迟到的回复同样是「未知 id」，不能据此判坏。
  if (!hadAbort && err instanceof Error && err.message.startsWith("Received a response for an unknown message ID")) {
    return new Error("jev_judge 响应 id 不匹配：收到对不上任何在飞请求的回复");
  }
  return undefined;
}
function badShape(what: string): Error {
  return new JevShapeError(`jev_judge 响应结构非法：${what}`);
}

/**
 * tools/call 结果的严格校验（官方客户端已做过 JSON-RPC id 匹配、SSE 解析与 CallToolResult schema 校验，
 * 这里只把 PiMoa 自己的契约再钉一遍）：result 非对象/数组、content 非数组、content 项非对象、type 非字符串、
 * text 项的 text 非字符串、isError 非布尔一律抛。Jev 判定契约是文本：非 isError 结果至少要有一个 text 项，
 * 否则同样抛（不落成「空文本成功」）。`isError=true` 仍是合法工具结果：content 须是数组（可为空）。
 */
function toolResultOf(result: unknown): { text: string; isError: boolean } {
  if (result === undefined || result === null) {
    throw new JevShapeError("jev_judge 响应缺 result：tools/call 既无 result 也无 error");
  }
  if (typeof result !== "object" || Array.isArray(result)) throw badShape("result 不是 JSON 对象");
  const r = result as Record<string, unknown>;
  if (r.isError !== undefined && typeof r.isError !== "boolean") throw badShape("result.isError 不是布尔值");
  const isError = r.isError === true;
  if (!Array.isArray(r.content)) throw badShape("result.content 不是数组");
  const texts: string[] = [];
  for (let i = 0; i < r.content.length; i++) {
    const c: unknown = r.content[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) throw badShape(`result.content[${i}] 不是对象`);
    const item = c as Record<string, unknown>;
    if (typeof item.type !== "string") throw badShape(`result.content[${i}].type 不是字符串`);
    if (item.type !== "text") continue;
    if (typeof item.text !== "string") throw badShape(`result.content[${i}].text 不是字符串`);
    texts.push(item.text);
  }
  if (!isError && texts.length === 0) throw badShape("非 isError 结果不含任何 text 内容");
  return { text: texts.join(""), isError };
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * 等 `p`，但外部 signal abort 时立刻以 AbortError 返回（`p` 本身不取消——它是共享连接的握手，
 * 不能因某一次调用被取消就连带掐断别的等待者）。监听在 finally 里撤掉，不留残余。
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** 官方客户端的 modern 协议代版本号（`clientMode: modern` 钉死这一版，不回落）。 */
const JEV_MODERN_PROTOCOL_VERSION = "2026-07-28";

/** 一条共享 MCP 连接（官方 Client + StreamableHTTPClientTransport）及其在飞计数。 */
interface JevConn {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** 当前挂在这条连接上的 tools/call 数。 */
  inflight: number;
  /** 已退役：不再接新请求，在飞归零即关闭。 */
  retiring: boolean;
  /** 连接已关闭（onclose 已触发或已主动 close）。 */
  closed: boolean;
  /** 本连接上曾有请求被取消/超时（此后「未知 id」回复可能是迟到回复，不再据此判坏）。 */
  hadAbort: boolean;
  /** 连接故障（见 connFaultOf）：触发即中止本连接上的握手与全部在飞调用，它们一律以 fault 失败。 */
  broken: AbortController;
  fault: Error | undefined;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (this.active < this.max) {
          this.active++;
          resolve(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(attempt);
        }
      };
      attempt();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 【key】P(成立)=0.87 —— 有标记就按标记切段（单键场景也可能带 【key】，波二修复单 8：此前只有
 * `multiKey=true` 才找标记，单键场景完全不找）；多键场景没找到该键的标记 → 判未答，返回 null
 * （不能拿别的键的答案顶替）。切出的段（或无标记时的整段文本）里取**最后一个** `P(成立)=` 匹配——
 * Jev 有时会把 state 原文回显在回答前面，state 里恰好含类似文本时，最后一个才是真正的判定结果。
 */
function parseP(text: string, key: string, multiKey: boolean): number | null {
  const marker = `【${key}】`;
  const idx = text.indexOf(marker);
  let segment: string;
  if (idx >= 0) {
    const rest = text.slice(idx + marker.length);
    const next = rest.indexOf("【");
    segment = next >= 0 ? rest.slice(0, next) : rest;
  } else if (multiKey) {
    return null; // 多键请求但找不到该键的标记：无法定位到它的答案。
  } else {
    segment = text;
  }
  const matches = [...segment.matchAll(/P\(成立\)=([0-9.]+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const v = Number(last[1]);
  return Number.isFinite(v) ? v : null;
}

function parseTokens(text: string): number {
  const m = /输入\s*(\d+)\s*token/.exec(text);
  return m ? Number(m[1]) : 0;
}

/**
 * choice 问法（§4.8 recheck）的回包文法（jev-mcp `renderAnswer` case "choice" 冻结文法）：
 * `【key】选项 → 驳回成立  置信度 0.831` + 次行 `  分布：驳回成立=0.831  驳回不成立=0.120 …`。
 * 返回选项名 + 置信度；无置信度时回退取该选项在分布里的概率；都解析不出 ⇒ p=null（不拿零值当判定）。
 */
function parseChoice(text: string, key: string): { p: number | null; choice: string | null } {
  const marker = `【${key}】`;
  const idx = text.indexOf(marker);
  if (idx < 0) return { p: null, choice: null };
  const rest = text.slice(idx + marker.length);
  const next = rest.indexOf("【");
  const segment = next >= 0 ? rest.slice(0, next) : rest;
  const cm = /选项\s*→\s*(\S+)/.exec(segment);
  const choice = cm ? (cm[1] as string) : null;
  const conf = /置信度\s*([0-9.]+)/.exec(segment);
  if (conf) {
    const v = Number(conf[1]);
    return { p: Number.isFinite(v) ? v : null, choice };
  }
  if (choice) {
    const escaped = choice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dm = new RegExp(`${escaped}=([0-9.]+)`).exec(segment);
    if (dm) {
      const v = Number(dm[1]);
      return { p: Number.isFinite(v) ? v : null, choice };
    }
  }
  return { p: null, choice };
}

export interface JevAskResult {
  /** 每个键的均值（该轮全部样本解析失败时为 null）。B7（波4）：`samples` 外露逐样本 P（每轮一个），
   * 供 truth 步留痕（FindingCheck.truth.steps[]）——纯数据面，判定仍只用均值/双样一致（verdictOf）。 */
  results: Record<string, { p: number | null; samples?: number[]; choice?: string }>;
  calls: JevCall[];
}

/** jevcheck.ts 内部各函数只依赖此最小接口，真实 `JevClient` 与测试 mock 都实现它。 */
export interface JevClientLike {
  ask(
    state: string,
    questions: Record<string, { q: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    n: number,
    signal?: AbortSignal,
    cacheSeen?: Set<string>,
  ): Promise<JevAskResult>;
  noul(kind: JevCall["q"], state: string, n: number, signal?: AbortSignal, cacheSeen?: Set<string>): Promise<{ p: number | null; calls: JevCall[] }>;
}

export interface JevClientOpts {
  url: string;
  concurrency: number;
  perCallTimeoutMs: number;
  /** 协议代选择（见 JevcheckCfg.clientMode）；缺省 auto。 */
  clientMode?: JevcheckCfg["clientMode"];
}

/**
 * 真实 Jev MCP 客户端（官方 `@modelcontextprotocol/client` 2.0：`Client` + `StreamableHTTPClientTransport`，
 * 设计 v4 §4/§8）。进程级单例（`shared`），信号量 = `min(8, cfg.concurrency)`；限流（isError 含「在飞请求
 * 已达上限」）按 200ms×2^k（k≤5）退避重试，计 `throttledCount`，不计入「不可用」连续失败；连接失败/HTTP
 * 非 2xx/协议或响应解析失败共用同一个连续失败计数器，连续 3 次即抛 `JevUnavailable`（裁决 C8）。JSON-RPC
 * `error`（→ JevRpcError）、SDK 的结果 schema 失败、本地严格校验失败都归入「响应解析失败」，每次请求只记一次。
 * 单次调用超时（SDK `timeout`=perCallTimeoutMs）与外部 abort 一律归一成 AbortError 抛出、不计连续失败。
 * 429/4xx 与 5xx 同样计一次连续失败——是否区分属本次范围外，行为不变。
 *
 * 官方客户端对畸形回复（JSON-RPC schema 不合、id 对不上）只报 onerror 并丢弃、请求挂到超时：这类 onerror 即判
 * 连接故障（connFaultOf），立即中止本连接的握手与在飞调用，它们以同一个稳定错误失败、只记一次连续失败。「SSE 流
 * 结束却没有回复」官方客户端既不报错也不报 onerror，只能等单次超时（归 AbortError、不计连续失败）。
 *
 * 连接：每个实例一条懒建的共享连接；并发首调共用同一个握手 promise（只握手一次）；握手失败不留残连接；
 * 连接被对端关闭（onclose）即摘除，下一次请求重连。传输层失败（非 JSON-RPC error、非结构校验失败）、以及
 * legacy 协议代下的超时/取消（legacy 取消只发 notifications/cancelled、不掐 HTTP 流）会让该连接「退役」：
 * 不再接新请求，在飞请求归零时关闭（中止残留 HTTP 流），不连带掐断同连接上别的在飞请求。
 */
export class JevClient implements JevClientLike {
  private static instance: JevClient | undefined;
  private readonly sem: Semaphore;
  private consecutiveFailures = 0;
  private readonly countedErrors = new WeakSet<Error>();
  private conn: JevConn | undefined;
  private connecting: Promise<JevConn> | undefined;
  /** close() 之后：仍可服务迟到的调用（旧轮次持有旧实例），但新建连接一律用完即关。 */
  private closing = false;
  /** 可观测：限流重试次数（runJevCheck 汇入 totals.throttled）。 */
  throttledCount = 0;

  private constructor(private readonly opts: JevClientOpts) {
    this.sem = new Semaphore(Math.max(1, Math.min(8, Math.floor(opts.concurrency) || 1)));
  }

  private get clientMode(): JevcheckCfg["clientMode"] {
    return this.opts.clientMode ?? "auto";
  }

  /**
   * 波二修复单 11：url/concurrency/perCallTimeoutMs/clientMode 与现有实例不同时重建实例——此前只要有实例
   * 就无条件复用，配置热改（比如 url 换端口）会悄悄对着旧端点继续跑，且新实例的信号量并发数
   * 也不会跟着变。重建时旧实例 close()：空闲连接立即关，在飞请求跑完再关。
   */
  static shared(opts: JevClientOpts): JevClient {
    const cur = JevClient.instance;
    const mode = opts.clientMode ?? "auto";
    const stale =
      !cur ||
      cur.opts.url !== opts.url ||
      cur.opts.concurrency !== opts.concurrency ||
      cur.opts.perCallTimeoutMs !== opts.perCallTimeoutMs ||
      cur.clientMode !== mode;
    if (stale) {
      if (cur) void cur.close();
      JevClient.instance = new JevClient(opts);
    }
    return JevClient.instance!;
  }

  /** 仅测试用：重置进程级单例（旧实例的连接一并关闭）。真实运行时从不调用。 */
  static resetForTest(): void {
    const cur = JevClient.instance;
    JevClient.instance = undefined;
    if (cur) void cur.close();
  }

  /** 供 `runJevCheck` 在每轮开始时调用：清零跨轮累积的连续失败计数（波二修复单 11）——单例
   * 跨轮共享，不清零会让本轮第一次失败就在上一轮遗留的计数基础上更快触发 `JevUnavailable`。 */
  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * 释放连接：当前连接退役（空闲立即关、在飞跑完再关）；握手中的连接落地后同样退役。
   * 之后若仍有迟到调用，会按需新建连接，并在其在飞归零时关闭，不留常驻会话。
   */
  async close(): Promise<void> {
    this.closing = true;
    if (this.conn) this.retire(this.conn);
    const pending = this.connecting;
    if (pending) {
      const c = await pending.catch(() => undefined);
      if (c) this.retire(c);
    }
  }

  /** 懒建共享连接；并发首调共用同一个握手 promise。握手失败清空 connecting，下次重试。 */
  private acquireConn(): Promise<JevConn> {
    const cur = this.conn;
    if (cur && !cur.retiring && !cur.closed) return Promise.resolve(cur);
    if (this.connecting) return this.connecting;
    const p = this.openConn().then(
      (c) => {
        if (this.connecting === p) this.connecting = undefined;
        if (this.closing) c.retiring = true;
        else this.conn = c;
        return c;
      },
      (err: unknown) => {
        if (this.connecting === p) this.connecting = undefined;
        throw err;
      },
    );
    this.connecting = p;
    return p;
  }

  private async openConn(): Promise<JevConn> {
    const mode = this.clientMode;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url));
    const client = new Client(
      { name: "pi-moa-jevcheck", version: "1" },
      { versionNegotiation: { mode: mode === "modern" ? { pin: JEV_MODERN_PROTOCOL_VERSION } : mode } },
    );
    const c: JevConn = {
      client,
      transport,
      inflight: 0,
      retiring: false,
      closed: false,
      hadAbort: false,
      broken: new AbortController(),
      fault: undefined,
    };
    client.onclose = () => {
      c.closed = true;
      if (this.conn === c) this.conn = undefined;
    };
    client.onerror = (err: unknown) => {
      if (c.fault) return;
      const fault = connFaultOf(err, c.hadAbort);
      if (!fault) return;
      c.fault = fault;
      c.broken.abort();
      this.retire(c);
    };
    try {
      // 握手只受 perCallTimeoutMs 与连接故障约束，不挂任何单次调用的 signal：它是共享的，某一次调用被取消不该
      // 掐断它（调用方等待时由 raceAbort 响应自己的 abort）。不传 timeout 时 SDK 缺省 60s。
      await client.connect(transport, { timeout: this.opts.perCallTimeoutMs, signal: c.broken.signal });
      const version = client.getNegotiatedProtocolVersion();
      const era = client.getProtocolEra();
      if (mode === "modern" && (version !== JEV_MODERN_PROTOCOL_VERSION || era !== "modern")) {
        throw new Error(`jev 协议代不符：clientMode=modern 要求 ${JEV_MODERN_PROTOCOL_VERSION}/modern，实际 ${version ?? "?"}/${era ?? "?"}`);
      }
      if (mode === "legacy" && era !== "legacy") {
        throw new Error(`jev 协议代不符：clientMode=legacy 要求 legacy，实际 ${version ?? "?"}/${era ?? "?"}`);
      }
      if (era !== "modern" && era !== "legacy") {
        throw new Error(`jev 协议代不明：握手后协商版本 ${version ?? "?"}/${era ?? "?"}`);
      }
    } catch (err) {
      c.closed = true;
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      const e = c.fault ?? err;
      // 握手阶段（server/discover、initialize）的结果 schema 失败单独标注，别被 normalizeError 归成 tools/call 结果非法。
      if (e instanceof SdkError && e.code === SdkErrorCode.InvalidResult) {
        throw new JevShapeError("jev_judge 握手响应结构非法：server/discover 或 initialize 结果未通过官方 schema 校验", {
          cause: e,
        });
      }
      throw e;
    }
    return c;
  }

  /** 连接退役：摘出共享位、不接新请求；在飞归零即关闭。 */
  private retire(c: JevConn): void {
    c.retiring = true;
    if (this.conn === c) this.conn = undefined;
    this.closeIfIdle(c);
  }

  private closeIfIdle(c: JevConn): void {
    if (!c.retiring || c.closed || c.inflight > 0) return;
    c.closed = true;
    void c.client.close().catch(() => undefined);
  }

  /**
   * 一次 tools/call（jev_judge）。错误归一：
   *  · 外部 abort / SDK RequestTimeout（超时与取消在 SDK 里同为此码）→ AbortError（不计连续失败）；
   *  · 连接故障（onerror 报的 schema 失败 / 未知 id，见 connFaultOf）→ 该故障的稳定错误（本连接在飞调用同被判失败）；
   *  · ProtocolError（JSON-RPC error）→ JevRpcError（只带 code 与截断 message，不带 data；原错误挂 cause）；
   *  · SDK 结果 schema 失败 / 本地结构校验失败 → JevShapeError；
   *  · 其余（HTTP 非 2xx、连接断开、JSON 解析失败等）→ message 截断后抛，并让该连接退役。
   */
  private async callJudge(
    state: string,
    questions: Record<string, { q?: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; isError: boolean }> {
    let c: JevConn;
    try {
      c = await raceAbort(this.acquireConn(), signal);
    } catch (err) {
      throw this.normalizeError(err, signal);
    }
    if (signal?.aborted) throw abortError();
    c.inflight++;
    let retire = false;
    try {
      const result: unknown = await c.client.callTool(
        {
          name: "jev_judge",
          arguments: {
            state,
            questions: Object.fromEntries(
              Object.entries(questions).map(([k, v]) => [
                k,
                // §4.8 recheck = choice 三值（closed-set 选择题）；其余问法维持 noul（判定面文法不动）。
                { type: v.q === "recheck" ? "choice" : "noul", instructions: v.instructions, criteria: v.criteria },
              ]),
            ),
          },
        },
        // onprogress 必须挂上（哪怕空函数）：SDK 只在有进度回调时才带 progressToken、才会按进度重置超时。
        // signal 合并连接故障：官方客户端丢弃畸形回复后请求会挂到超时，由 broken 立即中止。
        {
          signal: signal ? AbortSignal.any([signal, c.broken.signal]) : c.broken.signal,
          timeout: this.opts.perCallTimeoutMs,
          resetTimeoutOnProgress: true,
          onprogress: () => undefined,
        },
      );
      return toolResultOf(result);
    } catch (err) {
      // 本次调用是被连接故障中止的（而不是先拿到了自己的结果/错误）：抛故障本身。连接已由 onerror 退役。
      if (c.fault && !signal?.aborted && (isAbortError(err) || (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout))) {
        throw c.fault;
      }
      const norm = this.normalizeError(err, signal);
      if (isAbortError(norm)) {
        c.hadAbort = true;
        // legacy 取消只发 notifications/cancelled、HTTP 流仍挂着；退役连接，在飞归零后关闭以中止残留流。
        if (c.client.getProtocolEra() !== "modern") retire = true;
      } else if (!(norm instanceof JevRpcError) && !(norm instanceof JevShapeError)) {
        // 结果层错误（JSON-RPC error / 结构非法）说明连接本身健康，不退役；其余视为传输层失败。
        retire = true;
      }
      throw norm;
    } finally {
      c.inflight--;
      if (retire) this.retire(c);
      else this.closeIfIdle(c);
    }
  }

  private normalizeError(err: unknown, signal: AbortSignal | undefined): Error {
    if (isAbortError(err)) return err as DOMException;
    if (signal?.aborted) return abortError();
    if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return abortError();
    if (err instanceof ProtocolError) {
      return new JevRpcError(err.code, oneLineSnippet(err.message) || "（无 message）", { cause: err });
    }
    if (err instanceof JevShapeError) return err;
    // 以下三类的原消息会带 zod 明细或响应片段：换成稳定消息，原错误挂 cause（类型与 data 不丢）。
    if (err instanceof SdkError && err.code === SdkErrorCode.InvalidResult) {
      return new JevShapeError("jev_judge 响应结构非法：tools/call 结果未通过官方 CallToolResult schema 校验", {
        cause: err,
      });
    }
    if (isZodError(err)) {
      return new JevShapeError("jev_judge 响应结构非法：收到未通过 JSON-RPC schema 校验的消息", { cause: err });
    }
    if (err instanceof SyntaxError) {
      return new Error("jev_judge 响应解析失败：响应体不是合法 JSON", { cause: err });
    }
    if (err instanceof Error) {
      const msg = oneLineSnippet(err.message);
      if (msg === err.message) return err;
      const e = new Error(msg, { cause: err }) as Error & { code?: unknown };
      e.name = err.name;
      const code = (err as { code?: unknown }).code;
      if (code !== undefined) e.code = code;
      return e;
    }
    return new Error(oneLineSnippet(String(err)));
  }

  private async requestOnce(
    state: string,
    questions: Record<string, { q?: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; ms: number }> {
    for (let k = 0; ; k++) {
      if (signal?.aborted) {
        // 波二修复单 9：signal 若在发起前已 abort，必须在这里主动短路（不进信号量、不发请求）；且 abort 不是 Jev 的
        // 不可用证据，不计入 consecutiveFailures。
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const release = await this.sem.acquire();
      const t0 = Date.now();
      let result: { text: string; isError: boolean };
      try {
        result = await this.callJudge(state, questions, signal);
      } catch (err) {
        release();
        if (isAbortError(err)) throw err; // abort（超时/外部取消，含读体阶段）：不计入不可用
        // 同一连接故障会让该连接上全部在飞调用抛同一个错误对象：只记一次连续失败，避免一次故障放大成「不可用」。
        if (err instanceof Error) {
          if (this.countedErrors.has(err)) throw err;
          this.countedErrors.add(err);
        }
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) {
          throw new JevUnavailable(
            `Jev 连接失败连续 ${this.consecutiveFailures} 次：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
      release();
      const ms = Date.now() - t0;
      if (result.isError && result.text.includes("在飞请求已达上限")) {
        this.throttledCount++;
        // 波二修复单 7：200ms×2^k，k≤5 都要退避重试（k=5 即 6400ms 那一次），k>5 才判耗尽。
        if (k > 5) throw new JevThrottled("Jev 限流重试耗尽（k>5 仍被拒）");
        await sleep(200 * 2 ** k);
        continue;
      }
      if (result.isError) {
        // 波二修复单 6：设计 §3.5 第 259 行「不可用」只认连接失败/5xx/解析失败三类；非限流的
        // isError 不计入 consecutiveFailures，按单样本失败处理（ask() 里 catch 后 continue）。
        throw new Error(`jev_judge isError（非限流）：${result.text.slice(0, 200)}`);
      }
      // DEBT-09：传输成功不等于成功——解析失败与连接失败/5xx 共用同一个「连续」计数，这里不清零；
      // 只有「传输成功且解析出至少一个键」的完整成功才清零，由 ask() 在该轮解析成功时负责。
      return { text: result.text, ms };
    }
  }

  async ask(
    state: string,
    questions: Record<string, { q: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    n: number,
    signal?: AbortSignal,
    cacheSeen?: Set<string>,
  ): Promise<JevAskResult> {
    const keys = Object.keys(questions);
    const perKey: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, [] as number[]]));
    /** §4.8 recheck 的选项名（choice）；noul 问法不写。 */
    const perChoice: Record<string, string> = {};
    const calls: JevCall[] = [];
    let parsedAny = false;
    // ★只统计「拿到了响应文本但一个键都解析不出来」这类真正的解析失败；网络/isError 失败已经
    //   在 requestOnce 内部各记一次（且未到 3 次阈值就已 throw 出来），此处不能重复累加，
    //   否则单次 500 就会被算两次，2 次外部调用即误判「连续 3 次」。
    let anyRequestSucceeded = false;
    const stateSha256 = sha256(state);
    for (let i = 0; i < n; i++) {
      let round: { text: string; ms: number };
      try {
        round = await this.requestOnce(state, questions, signal);
      } catch (err) {
        if (err instanceof JevUnavailable) throw err;
        // 波二修复单 9：外部/超时 signal 已 abort → 不再继续采样，直接结束（而不是当作单样本失败
        // 跳过后还去跑下一轮——下一轮一进 requestOnce 就会因同一 signal 立刻再抛一次）。
        if (signal?.aborted) break;
        continue; // 单样本失败（网络瞬时错 / isError / 限流耗尽）：跳过该轮，不中断整体采样。
      }
      anyRequestSucceeded = true;
      const signature = `${stateSha256}:${[...keys].sort().join("\u0000")}`;
      const cacheSuspect = cacheSeen?.has(signature) === true;
      cacheSeen?.add(signature);
      const tokens = parseTokens(round.text);
      // 波二修复单 12：多键合并请求的一次网络往返只有一份 inputTokens/ms；只记在该轮第一个
      // 解析成功的键上，其余键记 0，totals.inputTokens/ms 才不会按键数虚高。
      let firstInRound = true;
      for (const key of keys) {
        // §4.8 recheck（choice）走 parseChoice；其余问法走 parseP（文法与判定面不动）。
        const parsed =
          questions[key]!.q === "recheck"
            ? parseChoice(round.text, key)
            : { p: parseP(round.text, key, keys.length > 1), choice: null };
        const p = parsed.p;
        if (p === null) continue;
        parsedAny = true;
        perKey[key]!.push(p);
        if (parsed.choice !== null) perChoice[key] = parsed.choice;
        calls.push({
          q: questions[key]!.q,
          p,
          stateSha256,
          inputTokens: firstInRound ? tokens : 0,
          ms: firstInRound ? round.ms : 0,
          ...(cacheSuspect ? { cacheSuspect: true } : {}),
        });
        firstInRound = false;
      }
      // DEBT-09：该轮传输成功且解析出至少一个键 = 完整成功，当场清零连续失败计数（requestOnce 不再在传输成功时清零）；
      // 否则同一 ask 里「先完整成功、后连接失败」会带着旧计数误判不可用。
      if (!firstInRound) this.consecutiveFailures = 0;
    }
    if (n > 0 && anyRequestSucceeded) {
      if (!parsedAny) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3) {
          throw new JevUnavailable(`Jev 响应解析失败连续 ${this.consecutiveFailures} 次`);
        }
      } else {
        this.consecutiveFailures = 0;
      }
    }
    const results: JevAskResult["results"] = {};
    for (const key of keys) {
      const arr = perKey[key]!;
      // B7（波4）：逐样本 P 随结果外露（`samples`），供 truth 步留痕；均值语义一字不动。
      results[key] = {
        p: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null,
        samples: [...arr],
        ...(perChoice[key] !== undefined ? { choice: perChoice[key] } : {}),
      };
    }
    return { results, calls };
  }

  async noul(kind: JevCall["q"], state: string, n: number, signal?: AbortSignal, cacheSeen?: Set<string>): Promise<{ p: number | null; calls: JevCall[] }> {
    const r = await this.ask(state, { [kind]: { q: kind, ...QUESTIONS[kind] } }, n, signal, cacheSeen);
    return { p: r.results[kind]?.p ?? null, calls: r.calls };
  }
}

// ---------------------------------------------------------------------------
// 材料定位小工具（不依赖 cwd/readRoots：locateFact 的导出签名不带这两项，
// 故按 rel/abs 直接匹配，退化于 submit_findings.ts 的 resolveMaterial——见文件末说明）。
// ---------------------------------------------------------------------------

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-09 修 2）：病理——submit_findings.resolveMaterial 早在 09-20 就追加了百分号解码变体，
 * 本函数没跟上 ⇒ f.path 写成「Claude%20dev%20paper%20system/…」时 proposer 侧 ACCEPT、jevcheck 侧取不到材料（对称缺口）；
 * 修法——原路径逻辑原样先跑，未命中且 `percentDecodedVariant` 给出变体时，用解码结果再跑同一逻辑（复用同一 export 函数，不复制）；
 * 边界——只追加、原路径优先；%2520 / + 号不解码（percentDecodedVariant 口径）。
 */
function findSegsForPath(path: string, materials: MaterialMap): MaterialFile[] | null {
  const hit = findSegsForPathOnce(path, materials);
  if (hit) return hit;
  const dp = percentDecodedVariant(path);
  return dp === null ? null : findSegsForPathOnce(dp, materials);
}

function findSegsForPathOnce(path: string, materials: MaterialMap): MaterialFile[] | null {
  const direct = materials.get(path);
  if (direct && direct.length > 0) return direct;
  const stripped = path.replace(/^\.\//, "");
  for (const segs of materials.values()) {
    if (segs.length === 0) continue;
    if (segs.some((s) => s.rel === stripped || s.rel === path || s.abs === path || s.abs.endsWith(`/${stripped}`))) {
      return segs;
    }
  }
  return null;
}

function segFor(materials: MaterialMap, abs: string, line: number): MaterialFile | undefined {
  return materials.get(abs)?.find((s) => s.start <= line && line <= s.end);
}

function parseLinesLoose(lines: string): { a: number; b: number } | null {
  const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(lines.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { a, b };
}

function numberedSlice(seg: MaterialFile, a: number, b: number): string {
  const lo = Math.max(seg.start, a);
  const hi = Math.min(seg.end, b);
  const out: string[] = [];
  for (let line = lo; line <= hi; line++) {
    out.push(`${String(line).padStart(4)}| ${seg.lines[line - seg.start] ?? ""}`);
  }
  return out.join("\n");
}

function collectDocs(materials: MaterialMap): MaterialFile[] {
  const out: MaterialFile[] = [];
  for (const segs of materials.values()) {
    for (const s of segs) {
      if (s.rel.toLowerCase().endsWith(".md")) out.push(s);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// locateFact / functionBodyAround（设计 v4 §3.5 四条定位路径 + E4 裁决）
// ---------------------------------------------------------------------------

const FILE_LINE_REF = /第\s*(\d+)(?:\s*[-–~]\s*(\d+))?\s*行/;
const SECTION_REF = /第\s*(\d+(?:\.\d+)*)\s*节|§\s*(\d+(?:\.\d+)*)/;
const DOC_LINE_REF = /(设计|文档|方案)[^\n]{0,40}?第\s*(\d+)\s*行/;
const HEADING_RE = /^(#{1,6})\s+(\d+(?:\.\d+)*)[.\s]/;
const ANY_HEADING_RE = /^(#{1,6})\s/;

/**
 * 批 10 分型：真实 spool 的 tables_n6_rs_executor.go 引文同时误撞 executor.go，导致
 * 4 条 fact locate-fail。只认完整 rel 或有词边界的完整文件名；下划线/连字符属于文件名，
 * 多个真正同名文件仍交给 locateFact 的歧义门，不任选。
 */
function matchesFileRef(rel: string, fact: string): boolean {
  const exactToken = (name: string, bare = false): boolean => {
    let at = fact.indexOf(name);
    while (at !== -1) {
      const before = fact[at - 1];
      const after = fact[at + name.length];
      if ((!before || (!bare || before !== "/") && !/[\w.-]/.test(before)) &&
        (!after || !/[\w.-]/.test(after))) return true;
      at = fact.indexOf(name, at + 1);
    }
    return false;
  };
  if (exactToken(rel)) return true;
  const base = rel.split("/").pop() ?? rel;
  return base.includes(".") && exactToken(base, true);
}

/** 找「第 X(.Y) 节」标题行到下一同级或更高级标题前（≤80 行）。 */
function findSection(doc: MaterialFile, num: string): { a: number; b: number } | null {
  for (let i = 0; i < doc.lines.length; i++) {
    const m = HEADING_RE.exec(doc.lines[i] ?? "");
    if (!m || m[2] !== num) continue;
    const level = m[1]!.length;
    let end = doc.end;
    for (let j = i + 1; j < doc.lines.length; j++) {
      const hm = ANY_HEADING_RE.exec(doc.lines[j] ?? "");
      if (hm && hm[1]!.length <= level) {
        end = doc.start + j - 1;
        break;
      }
    }
    const a = doc.start + i;
    return { a, b: Math.min(end, a + 79) };
  }
  return null;
}

/**
 * 向上找函数/闭包起始行，向下配平大括号（设计 v4 §3.5）。line 必须落在 seg 范围内；
 * 找不到起始行或到段末仍未配平 → null（失败，调用方退回 ±25 行）。
 */
export function functionBodyAround(seg: MaterialFile, line: number): { a: number; b: number } | null {
  if (line < seg.start || line > seg.end) return null;
  const FUNC_START_RE =
    /^(func\s|function\s|export\s+(async\s+)?function\s|[a-zA-Z_][\w-]*\(\)\s*\{|(const|let)\s+\w+\s*=\s*(async\s+)?\()/;
  let startIdx = -1;
  for (let i = line - seg.start; i >= 0; i--) {
    if (FUNC_START_RE.test((seg.lines[i] ?? "").trim())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < seg.lines.length; i++) {
    const text = seg.lines[i] ?? "";
    for (const ch of text) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return { a: seg.start + startIdx, b: seg.start + i };
  }
  return null;
}

/**
 * 事实自引位置切片（设计 v4 E4 裁决，四条路径按序尝试）：
 *   ① 「文件名 第 N(-M) 行」→ 该文件该行 ±15；
 *   ② 「第 X(.Y) 节」/「§X.Y」且有 .md → 该节；
 *   ③ 「(设计|文档|方案)…第 N 行」→ 主文档（materials 里第一个 .md）该行 ±15；
 *   ④ 无引用 → finding 所在函数体 → 退回 finding lines ±25。
 *
 * 波二修复单 1/3：路径①命中某文件名/rel 路径后，若该文件的已附入段都不含 lo/hi 这行 ——
 * 或候选文件不止一个且无法唯一确定 —— 直接返回 null（事实记「待核」），**不**退回路径④拿
 * finding 自己的行去核别人的事实（此前的兜底 `segs[0]!` 会在两种情况下都悄悄核错文件/核出
 * 反向区间：一是命中文件但行号在其它段，二是「文件名」子串实际来自另一份材料）。
 */
export function locateFact(
  fact: string,
  f: Pick<FindingRecord, "path" | "lines">,
  materials: MaterialMap,
  docs: readonly MaterialFile[],
  onPath?: (path: FactLocPath) => void,
): { abs: string; a: number; b: number } | null {
  const located = (loc: { abs: string; a: number; b: number } | null, path: FactLocPath) => { onPath?.(path); return loc; };
  // ① 文件名 + 第 N(-M) 行
  const m1 = FILE_LINE_REF.exec(fact);
  if (m1) {
    const n = Number(m1[1]);
    const nn = m1[2] !== undefined ? Number(m1[2]) : n;
    const lo = Math.min(n, nn);
    const hi = Math.max(n, nn);

    const candidates: MaterialFile[][] = [];
    for (const segs of materials.values()) {
      const rel = segs[0]?.rel;
      if (!rel) continue;
      if (matchesFileRef(rel, fact)) candidates.push(segs);
    }

    if (candidates.length > 0) {
      let chosen: MaterialFile[] | undefined;
      if (candidates.length === 1) {
        chosen = candidates[0];
      } else {
        // 候选多于一个：优先事实所在 finding 自己的 path 所指文件。
        const fPath = f.path.replace(/^\.\//, ""); // 与 findSegsForPath 同一归一（剥 ./ 前缀）
        chosen = candidates.find((segs) => segs.some((s) => s.rel === fPath || s.abs === f.path || s.abs.endsWith(`/${fPath}`)));
        if (!chosen) {
          // 其次取 rel 路径在事实文本里出现最长者；命中并列（含都未整段出现）→ 仍不唯一。
          let bestLen = -1;
          let unique = false;
          for (const segs of candidates) {
            const rel = segs[0]!.rel;
            if (!fact.includes(rel)) continue;
            if (rel.length > bestLen) {
              bestLen = rel.length;
              chosen = segs;
              unique = true;
            } else if (rel.length === bestLen) {
              unique = false;
            }
          }
          if (!unique) chosen = undefined;
        }
      }
      if (!chosen) return located(null, "null"); // 候选多于一个且无法唯一确定 → 待核
      const seg = chosen.find((s) => s.start <= lo && lo <= s.end) ?? chosen.find((s) => s.start <= hi && hi <= s.end);
      if (!seg) return located(null, "null"); // 命中文件但该文件的已附入段都不含这行 → 待核，不退回路径④
      const same = chosen.some((s) => s.rel === f.path.replace(/^\.\//, "") || s.abs === f.path);
      return located({ abs: seg.abs, a: Math.max(seg.start, lo - JEVCHECK_FACT_PAD), b: Math.min(seg.end, hi + JEVCHECK_FACT_PAD) }, same ? "line-ref" : "cross-file");
    }
    // candidates.length === 0：事实里没有任何已附入文件名/rel 路径的踪迹，说明这不是真正的
    // 「文件名 第 N 行」引用（可能只是巧合含「第 N 行」字样），继续尝试路径②③④。
  }
  // ② 第 X(.Y) 节 / §X.Y
  const sm = SECTION_REF.exec(fact);
  if (sm && docs.length > 0) {
    const num = sm[1] ?? sm[2]!;
    for (const doc of docs) {
      const hit = findSection(doc, num);
      if (hit) return located({ abs: doc.abs, a: hit.a, b: hit.b }, "doc-section");
    }
  }
  // ③ (设计|文档|方案)…第 N 行 → 主文档
  const dm = DOC_LINE_REF.exec(fact);
  if (dm && docs.length > 0) {
    const n = Number(dm[2]);
    const doc = docs[0]!;
    return located({ abs: doc.abs, a: Math.max(doc.start, n - JEVCHECK_FACT_PAD), b: Math.min(doc.end, n + JEVCHECK_FACT_PAD) }, "line-ref");
  }
  // ④ 无引用 → finding 所在函数体 → 退回 ±25
  const segs = findSegsForPath(f.path, materials);
  if (!segs) return located(null, "null");
  const ab = parseLinesLoose(f.lines);
  if (!ab) return located(null, "null");
  const seg = segs.find((s) => s.start <= ab.a && ab.b <= s.end) ?? segs[0]!;
  const body = functionBodyAround(seg, ab.a);
  if (body) return located({ abs: seg.abs, a: body.a, b: body.b }, "same-file-else");
  return located({ abs: seg.abs, a: Math.max(seg.start, ab.a - JEVCHECK_FALLBACK_PAD), b: Math.min(seg.end, ab.b + JEVCHECK_FALLBACK_PAD) }, "function-fallback");
}

// ---------------------------------------------------------------------------
// checkFinding
// ---------------------------------------------------------------------------

/**
 * B7（波4）：truth / 机械佐证的 material 面——该 finding 所引文件的全部附入段，`N: text` 行形
 * （mechCorroborate 的行号-引号绑定按 `^\\s*${ln}: ?` 匹配，与金标准 c.material 同形）。
 * 多文件段行号撞车时 mech 判「行号歧义拒核」（R1-2 的保守方向），不跨文件蒙猜。
 */
export function findingTruthMaterial(f: Pick<FindingRecord, "path">, materials: MaterialMap): string {
  const segs = findSegsForPath(f.path, materials) ?? [];
  const out: string[] = [];
  for (const seg of segs) {
    for (let line = seg.start; line <= seg.end; line++) {
      out.push(`${line}: ${seg.lines[line - seg.start] ?? ""}`);
    }
  }
  return out.join("\n");
}

/**
 * B7/§4.8：该 finding 的材料区 state（所在函数体，配平失败退回 lines ±25）——链步采样（q:"link"）与
 * §4.8 独立复核闸（recheck）共用同一取材口径（2026-09-22 Q3 裁决：「state=该 finding 材料区」）。
 */
export function findingRegionState(f: Pick<FindingRecord, "path" | "lines">, materials: MaterialMap): string {
  const segs = findSegsForPath(f.path, materials);
  const ab = parseLinesLoose(f.lines);
  if (!segs || !ab) return "";
  const seg = segs.find((s) => s.start <= ab.a && ab.b <= s.end) ?? segs[0]!;
  const body = functionBodyAround(seg, ab.a) ?? {
    a: Math.max(seg.start, ab.a - JEVCHECK_FALLBACK_PAD),
    b: Math.min(seg.end, ab.b + JEVCHECK_FALLBACK_PAD),
  };
  return capStateText(`## ${sliceHeading(seg.rel)}（${seg.rel}，第 ${body.a}-${body.b} 行）\n\`\`\`\n${numberedSlice(seg, body.a, body.b)}\n\`\`\``);
}

/** P0 first, then each newly located P1 range; duplicate (abs,line) positions are not repeated. */
export function findingClosureState(
  f: Pick<FindingRecord, "path" | "lines" | "factRefs">,
  facts: readonly FactCheck[],
  materials: MaterialMap,
): { state: string; dropped: number } {
  const segs = findSegsForPath(f.path, materials);
  const ab = parseLinesLoose(f.lines);
  if (!segs || !ab) return { state: "", dropped: 0 };
  const home = segs.find((s) => s.start <= ab.a && ab.b <= s.end) ?? segs[0]!;
  const body = functionBodyAround(home, ab.a) ?? {
    a: Math.max(home.start, ab.a - JEVCHECK_FALLBACK_PAD),
    b: Math.min(home.end, ab.b + JEVCHECK_FALLBACK_PAD),
  };
  const seen = new Set<string>();
  const parts: string[] = [];
  const addRange = (seg: MaterialFile, a: number, b: number): void => {
    let start: number | null = null;
    const flush = (end: number): void => {
      if (start === null) return;
      parts.push(`## ${sliceHeading(seg.rel)}（${seg.rel}，第 ${start}-${end} 行）\n\`\`\`\n${numberedSlice(seg, start, end)}\n\`\`\``);
      start = null;
    };
    for (let line = Math.max(a, seg.start); line <= Math.min(b, seg.end); line++) {
      const key = `${seg.abs}\0${line}`;
      if (seen.has(key)) { flush(line - 1); continue; }
      seen.add(key);
      if (start === null) start = line;
    }
    flush(Math.min(b, seg.end));
  };
  addRange(home, body.a, body.b);
  for (const ref of f.factRefs ?? []) {
    if (ref.status !== "相符" && ref.status !== "已校正") continue;
    for (const seg of findSegsForPath(ref.file, materials) ?? []) {
      if (seg.end >= ref.a && seg.start <= ref.b) addRange(seg, ref.a, ref.b);
    }
  }
  for (const fact of facts) {
    if (!fact.slice) continue;
    // A hard-error ref never supplies a usable P1 location; accepted/corrected refs and successful locateFact do.
    if (fact.ref === "未命中" || fact.ref === "行号越界" || fact.ref === "文件未附") continue;
    const loc = fact.slice;
    for (const seg of materials.get(loc.abs) ?? []) {
      if (seg.end >= loc.a && seg.start <= loc.b) addRange(seg, loc.a, loc.b);
    }
  }
  let count = 0;
  let size = 0;
  while (count < parts.length) {
    const next = parts[count]!;
    const rest = parts.length - count - 1;
    const marker = rest ? `\n（预算截断，余 ${rest} 段未附）` : "";
    if (size + (count ? 2 : 0) + next.length + marker.length > JEVCHECK_STATE_MAX_CHARS) break;
    size += (count ? 2 : 0) + next.length;
    count++;
  }
  // Reserve marker space even when the first failed candidate made an earlier accepted segment too large.
  while (count > 0 && size + `\n（预算截断，余 ${parts.length - count} 段未附）`.length > JEVCHECK_STATE_MAX_CHARS) {
    count--;
    size -= parts[count]!.length + (count ? 2 : 0);
  }
  const dropped = parts.length - count;
  const marker = dropped ? `\n（预算截断，余 ${dropped} 段未附）` : "";
  return { state: parts.slice(0, count).join("\n\n") + marker, dropped };
}

/** fact 的 p 值按 thresholds.fact 分档（导出供「statusFact 分档边界」单测）。 */
export function factStatusFromP(p: number | null, th: { high: number; low: number }): FactCheck["status"] {
  if (p === null) return "待核";
  if (p >= th.high) return "相符";
  if (p <= th.low) return "不符";
  return "待核";
}

function buildEntailState(facts: readonly string[], claim: string): string {
  return `## 已知前提（全部为真）\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\n## 待判断的结论\n${claim}`;
}

/**
 * 五态合成（波二修复单 2，设计 v4 §3.5）：含不符前提 ＞ 前提不足 ＞ 含待核前提 ＞ 条件性成立 ＞
 * 前提完备且全部相符。非条件类事实里只要还有「待核」（locateFact 定位失败，或 Jev 未答）——
 * 就不得合成「前提完备且全部相符」，哪怕 entail 本身算出来的 p1 够高：那是拿「没核过」的前提
 * 去支撑「全部相符」的结论，是假绿。
 */
export function synthesizeStatus(
  facts: readonly FactCheck[],
  p1: number,
  hasCondition: boolean,
  cfg: Pick<JevcheckCfg, "thresholds">,
): FindingCheck["status"] {
  if (facts.some((c) => c.kind !== "condition" && c.status === "不符")) return "含不符前提";
  if (p1 < cfg.thresholds.entail.low) return "前提不足";
  if (facts.some((c) => c.kind !== "condition" && c.status === "待核")) return "含待核前提";
  if (hasCondition) return "条件性成立";
  return "前提完备且全部相符";
}

function computeConditionFlag(facts: readonly FactCheck[]): boolean {
  const condCount = facts.filter((c) => c.kind === "condition").length;
  if (condCount === 0) return false;
  return condCount >= JEVCHECK_CONDITION_FLAG_MIN || condCount / facts.length >= 0.5;
}

// ---------------------------------------------------------------------------
// B4 真伪三态规则引擎 verdictOf（设计稿 §4 B4 + §4.8 封闭形态原则，波3）
//
// 语义真源 = 实测判定器 `<workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs`
// 的 `verdictOf` v2（judge-results.jsonl 全部记录 verdict 的产地；本引擎逐分支移植）+ 主代理 2026-09-22
// 裁决的「读法 A」增量：
//   · 双采样一致证伪（两样本均 ≤ JEVCHECK_REFUTE_P）的 non-link 步，mech 结果**三分**：
//     `refuted=true` ⇒ KILL「假」（处决 + brokenStep + mechNotes）；
//     拒核且 `reason=unform` ⇒ DOWNGRADE「因果存疑」（不处决，进真跑队列语义）；
//     拒核且 `reason=locate-miss` ⇒ INSUFFICIENT「依据不足」（步定位失败——证伪了但引文行在材料里
//     定位不到，证伪依据不足）——规则名 `INSUFFICIENT-locateMiss`，金标准具名增量 L-C164 即此档；
//   · 缺采样（samples 为空，无均值）⇒ INSUFFICIENT「依据不足」（judge v2 原样）；
//   · **非证伪步的 locate-miss 不改变判决**（照常流 UNREFUTED/DOWNGRADE 上层规则——2026-09-22 裁决：
//     mech 只在证伪决策点被咨询，可核性失败 ≠ 证伪成立，读法 B 会把 76 例无过案件误升「依据不足」）。
// 五态合成（synthesizeStatus）保留为前提卫生附注，不删不改其输出。
//
// 不对称写死在类型层：link 类步骤**永不进 KILL 候选集**（`TruthLinkStep` 与 `TruthEvidenceStep`
// 分型 + `killCandidates` 类型谓词收窄；R3T 误杀教训 + link 证成 1/9 vs 证伪 6/7 的实测不对称）。
// mech 只在证伪方向使用，**永不用于背书**（无 certify 线）。
// ---------------------------------------------------------------------------

/** B4 步 kind：link = chain 因果推断步（永不进 KILL 候选）；其余均为证据步（non-link）。 */
export type TruthStepKind = "fact" | "general" | "code" | "absence" | "runtime" | "condition";

interface TruthStepBase {
  id: string;
  /** 步文本（mechCorroborate 的断言语句本体；verdictOf 不读，evalTruth/复盘用）。 */
  text?: string;
  /** 逐步采样 P（judge 协议每步 2 次；KILL 需**双样一致** ≤ REFUTE——仅均值不足以判「一致」）。 */
  samples: readonly number[];
  /** mechCorroborate 输出（./mech.js 波2）：checkable/refuted/reason/note。 */
  mech: MechResult;
}

/** chain 因果推断步：类型层写死「永不进 KILL 候选」（只能降级，不能处决）。 */
export interface TruthLinkStep extends TruthStepBase {
  kind: "link";
}

/** 证据步（fact/absence/…）：KILL 候选集的唯一成员类型。 */
export interface TruthEvidenceStep extends TruthStepBase {
  kind: TruthStepKind;
}

export type TruthStep = TruthLinkStep | TruthEvidenceStep;

/** verdictOf 的产出（落 `FindingCheck.truth`）。 */
export type TruthVerdictResult = import("./types.js").FindingTruth;

/** 类型谓词：KILL 候选 = 证据步（`s.kind !== "link"` 在联合类型上收窄为 TruthEvidenceStep）。 */
function killCandidates(steps: readonly TruthStep[]): TruthEvidenceStep[] {
  return steps.filter((s): s is TruthEvidenceStep => s.kind !== "link");
}

/** 双采样一致证伪：恰好 2 个样本且**每一个**都 ≤ refute（judge v2 `strict` 逐字；均值不算「一致」）。
 *  阈值来源（C1 波4 接线）：config `thresholds.refute` ⇒ 缺省 JEVCHECK_REFUTE_P（0.1），语义一字不动。 */
function strictlyRefuted(s: TruthStep, refute: number): boolean {
  return s.samples.length === 2 && s.samples.every((p) => p <= refute);
}

/** 步均值（judge v2 `mean` 逐字：无样本 = null = 缺采样）。 */
function stepMean(s: TruthStep): number | null {
  return s.samples.length > 0 ? s.samples.reduce((a, b) => a + b, 0) / s.samples.length : null;
}

/** mechNotes 条目格式：「步id｜note」（B6 渲染/B7 留痕按步归因）。 */
function mechNoteOf(s: TruthStep): string {
  return `${s.id}｜${s.mech.note}`;
}

/**
 * B4 规则引擎主入口（顺序 = KILL ＞ 严格证伪三分档 ＞ 依据不足 ＞ 弱证伪降级 ＞ 未拆倒；
 * judge v2 的「严格证伪＞依据不足＞弱降级」顺序（R2-F1/R1-4 实测修复）保持不变）。
 * 产出「候选意见」不是终审：KILL 进聚合器仍需 table_handling 表态（波4 B6），真跑队列才是终审。
 * `th`（C1 波4）：refute/weak 阈值来源接 config（缺省 = 常量 0.1/0.2，判定语义零改动——
 * 金标准回归 test/golden-regression.test.ts 不传 th、逐字复现波3 结果）。
 */
export function verdictOf(steps: readonly TruthStep[], th: TruthThresholds = { refute: JEVCHECK_REFUTE_P, weak: JEVCHECK_WEAK_P }): TruthVerdictResult {
  // ① KILL「假」：∃ non-link 步 双样一致证伪 ∧ mech 佐证证伪 ⇒ 处决 + 破绽定位。
  const killStep = killCandidates(steps).find((s) => strictlyRefuted(s, th.refute) && s.mech.checkable && s.mech.refuted);
  if (killStep) return { verdict: "假", rule: "KILL", brokenStep: killStep.id, mechNotes: [mechNoteOf(killStep)] };

  // ② 严格证伪档（judge v2 首个严格证伪步定档）+ 读法 A 的 mech 三分。
  const strictStep = steps.find((s) => strictlyRefuted(s, th.refute));
  if (strictStep) {
    if (strictStep.kind !== "link" && strictStep.mech.reason === "locate-miss") {
      // 读法 A 唯一增量（主代理 2026-09-22 裁决；金标准具名增量 L-C164）：严格证伪但步定位失败。
      return { verdict: "依据不足", rule: "INSUFFICIENT-locateMiss", brokenStep: strictStep.id, mechNotes: [mechNoteOf(strictStep)] };
    }
    const corroborated = strictStep.mech.checkable && strictStep.mech.refuted;
    return {
      verdict: "因果存疑",
      rule: corroborated ? "DOWNGRADE" : "DOWNGRADE-noMech",
      brokenStep: strictStep.id,
      mechNotes: [mechNoteOf(strictStep)],
    };
  }

  // ③ 依据不足：缺采样（judge v2 `mean === null` 原样）；非证伪步的 locate-miss **不**改判（见头注）。
  if (steps.some((s) => stepMean(s) === null)) return { verdict: "依据不足", rule: "INSUFFICIENT", mechNotes: [] };

  // ④ 弱证伪/中带降级：均值 ≤ weak 但未达严格证伪 ⇒ 不处决（进真跑队列语义）。
  const weakStep = steps.find((s) => {
    const m = stepMean(s);
    return m !== null && m <= th.weak;
  });
  if (weakStep) return { verdict: "因果存疑", rule: "DOWNGRADE-weak", brokenStep: weakStep.id, mechNotes: [mechNoteOf(weakStep)] };

  // ⑤ 未拆倒：其余（**≠证实**——本引擎只拆假、不判真；真 bug 确认归真跑）。
  return { verdict: "未拆倒", rule: "UNREFUTED", mechNotes: [] };
}

/** evalTruth 的步输入：带步文本，mech 由 mechCorroborate 现算（材料 = 本轮附入 material 全文）。 */
export interface TruthStepInput {
  id: string;
  kind: TruthStep["kind"];
  text: string;
  samples: readonly number[];
}

/** evalTruth/truthStepsOf 的可选参数（C1 波4）：阈值接 config、mech 开关接 config；缺省 = 波3 行为。 */
export interface TruthEvalOpts {
  th?: TruthThresholds;
  mechEnabled?: boolean;
}

/**
 * 步装配（verdictOf 的输入面）：每步跑 `mechCorroborate`（./mech.js，波2 语义）。
 * `mechEnabled=false`（config `mech.enabled`）⇒ 一律拒核降级（unform），永不背书、也不佐证处决。
 * B7（波4）留痕复用它：checkFinding 用它拿逐步 mechNotes，与 evalTruth 同源同序。
 */
export function truthStepsOf(inputs: readonly TruthStepInput[], material: string, opts?: TruthEvalOpts): TruthStep[] {
  const mechOn = opts?.mechEnabled !== false;
  return inputs.map((s) => ({
    id: s.id,
    kind: s.kind,
    text: s.text,
    samples: s.samples,
    mech: mechOn
      ? mechCorroborate({ text: s.text }, material)
      : { checkable: false, refuted: false, reason: "unform" as const, note: "机械佐证层未启用（mech.enabled=false），拒核降级（永不背书）" },
  }));
}

/**
 * 便捷入口：对每步跑 `mechCorroborate`（./mech.js，波2 语义）再进 `verdictOf`。
 * 金标准回放（test/golden-regression.test.ts）与生产接线（波4 B7：checkFinding 的 truth 填充点）共用这一条路；
 * 本体**纯函数、零 Jev 调用**（2026-09-22 Q3 勘误：「不新增 Jev 调用」限定于 evalTruth 本体）。
 */
export function evalTruth(inputs: readonly TruthStepInput[], material: string, opts?: TruthEvalOpts): TruthVerdictResult {
  return verdictOf(truthStepsOf(inputs, material, opts), opts?.th);
}

/**
 * finding 自身引用（anchor）的独立复核（波二修复单 14）：`anchorHit` 的四态直接透传到
 * `FindingCheck.ref`，「行号已校正」在这里归一为 `"OK"`——submit_findings 阶段已经把接受的
 * finding 的 `lines` 校正过一次，此处若仍判「行号已校正」多半是同一枚举值的边界重现；
 * `isAnomalous`（`src/tools/submit_verdicts.ts`，本波不许改）用 `ref !== "OK"` 判异常，
 * 不归一会把本不异常的 finding 错判为异常。
 */
function computeRef(
  f: Pick<FindingRecord, "path" | "lines" | "anchor" | "refConsistency">,
  materials: MaterialMap,
): FindingCheck["ref"] {
  const segs = findSegsForPath(f.path, materials);
  if (!segs) return "文件未附";
  const ab = parseLinesLoose(f.lines);
  if (!ab) return "行号越界";
  const seg = segs.find((s) => s.start <= ab.a && ab.b <= s.end);
  if (!seg) return "行号越界";
  // 三路互验「不一致」（徐总 09-20 追加裁定，覆盖任务书原「lines/anchor 可选」条，见 §12.6 第 2 点
  // 改写版）：facts 与 anchor/lines 意见相左时，不论 submit_findings 阶段的 anchorHit 状态本身是什么
  // （哪怕它判了 "OK"），汇总一律归到「锚点不唯一」档——isAnomalous 为真、aggregator 须 table_handling。
  if (f.refConsistency === "不一致") return "锚点不唯一";
  const hit = anchorHit(f.anchor, segs, ab.a, ab.b);
  if (hit.status === "行号已校正") return "OK";
  return hit.status;
}

/** 相符/已校正事实引用行的 [min,max]（与 submit_findings.ts computeFactsRange 同算法；供
 * `refConsistencyDetail` 渲染，避免反向导入 submit_findings.ts 的内部纯函数产生额外耦合面）。 */
function factsRangeFromRefs(factRefs: readonly FactRef[] | undefined): [number, number] | undefined {
  if (!factRefs) return undefined;
  const q = factRefs.filter((fr) => fr.status === "相符" || fr.status === "已校正");
  if (q.length === 0) return undefined;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const fr of q) {
    lo = Math.min(lo, fr.a);
    hi = Math.max(hi, fr.b);
  }
  return [lo, hi];
}

/** `refConsistency==="不一致"` 时的渲染详情「lines a-b / anchor L / 事实 m-n」（核对表首行用）。 */
function computeRefConsistencyDetail(
  f: Pick<FindingRecord, "path" | "lines" | "anchor" | "factRefs" | "refConsistency">,
  materials: MaterialMap,
): string | undefined {
  if (f.refConsistency !== "不一致") return undefined;
  const segs = findSegsForPath(f.path, materials);
  const ab = parseLinesLoose(f.lines);
  const hit = segs && ab ? anchorHit(f.anchor, segs, ab.a, ab.b) : null;
  const fr = factsRangeFromRefs(f.factRefs);
  return `lines ${f.lines} / anchor ${hit?.line ?? "未命中"} / 事实 ${fr ? `${fr[0]}-${fr[1]}` : "—"}`;
}

/** 事实引用标注（渲染就绪，直接拼进核对表事实行；如「（引用已校正 881→884）」「（引用：标识符 X 不在第 884 行）」）。 */
function factRefAnnotation(fr: FactRef): string {
  switch (fr.status) {
    case "已校正":
      return `（引用已校正 ${fr.originalLine}→${fr.a}）`;
    case "待核":
      return "（引用待核）";
    case "未命中":
      return `（引用：标识符${fr.token ? ` ${fr.token} ` : " "}不在第 ${fr.a === fr.b ? fr.a : `${fr.a}-${fr.b}`} 行）`;
    case "行号越界":
      return "（引用：行号越界）";
    case "文件未附":
      return "（引用：文件未附）";
    default:
      return "";
  }
}

type QuoteLocation = { abs: string; a: number; b: number };
type QuoteDecision = { status: NonNullable<FactCheck["quoteStatus"]>; loc?: QuoteLocation; rewritten?: string; audit?: string;
  correction?: { file: string; a: number; b: number; rewritten: string; originalLine: string } };

/** Literal whole-line comparison against raw attached lines, never numberedSlice output.
 * Deduplicate overlapping material segments by (abs,line); multiple distinct matches remain ambiguous. */
export function checkQuote(quote: string, fact: string, f: Pick<FindingRecord, "path" | "lines">,
  factRef: FactRef | undefined, materials: MaterialMap, anchor: QuoteLocation | null): QuoteDecision {
  const needle = quote.trim();
  const hits = new Map<string, { seg: MaterialFile; line: number }>();
  if (!needle) return { status: "校正待核", audit: "quote 空白，不能定位" };
  for (const segments of materials.values()) for (const seg of segments) {
    for (let line = seg.start; line <= seg.end; line++) {
      if (seg.lines[line - seg.start]?.trim() === needle) hits.set(`${seg.abs}:${line}`, { seg, line });
    }
  }
  if (hits.size === 0) return { status: "本轮材料池未找到 quote", audit: "本轮材料池未找到 quote（不表示编造）" };
  if (hits.size > 1) return { status: "歧义", audit: `quote 在材料池命中 ${hits.size} 处；不任选` };
  const { seg, line } = [...hits.values()][0]!;
  const loc = { abs: seg.abs, a: Math.max(seg.start, line - JEVCHECK_FACT_PAD), b: Math.min(seg.end, line + JEVCHECK_FACT_PAD) };
  const anchored = anchor?.abs === seg.abs && anchor.a <= line && line <= anchor.b;
  // A usable factRef's a/b, not the padded Jev slice, determines the exact tier.
  const exact = factRef ? anchored && factRef.a <= line && line <= factRef.b : anchored;
  if (exact) return { status: "精确", loc, audit: `quote 原始行精确命中 ${seg.rel}:${line}` };
  const sourceSegs = findSegsForPath(factRef?.file ?? f.path, materials);
  const sameFile = sourceSegs?.some(s => s.abs === seg.abs) ?? false;
  const status = sameFile ? "同文件校正" : "跨文件校正";
  const reference = parseFactLineRef(fact);
  // Without a textual line reference a code fact cannot be atomically rewritten; do not
  // send an old file/line to Jev alongside a newly located quote.
  if (factRef && !reference) return { status: "校正待核", audit: `${status}候选 ${seg.rel}:${line}，事实缺行号，file/a/rewritten 无法同批校正` };
  let rewritten = reference ? rewriteFactLine(fact, line) : fact;
  if (factRef && rewritten === fact && line !== factRef.a) return { status: "校正待核", audit: `${status}候选 ${seg.rel}:${line}，行号未能改写` };
  if (!sameFile) {
    const oldFile = reference?.filePath ?? factRef?.file ?? f.path;
    if (oldFile && rewritten.includes(oldFile)) {
      rewritten = rewritten.replace(oldFile, seg.rel);
      if (oldFile !== seg.rel && rewritten.includes(oldFile)) {
        return { status: "校正待核", audit: `跨文件引用候选 ${seg.rel}:${line}，文件名未能原子改写` };
      }
    } else if (reference?.filePath) {
      return { status: "校正待核", audit: `跨文件引用候选 ${seg.rel}:${line}，事实文件引用未能原子改写` };
    }
  }
  const originalLine = factRef?.originalLine ?? (reference ? `${reference.a}${reference.b === reference.a ? "" : `-${reference.b}`}` : "");
  const correction = { file: seg.rel, a: line, b: line, rewritten, originalLine };
  return { status, loc, rewritten, correction,
    audit: `${status === "跨文件校正" ? "跨文件引用；" : ""}quote 原始行 ${seg.rel}:${line}；file/a/rewritten 原子校正（原引用 ${factRef?.file ?? f.path}:${originalLine || "无"}）` };
}

function thickFactRange(seg: MaterialFile, loc: { a: number; b: number }): { a: number; b: number } {
  const anchor = Math.min(loc.b, loc.a + JEVCHECK_FACT_PAD);
  const body = functionBodyAround(seg, anchor);
  const original = { a: Math.max(seg.start, loc.a), b: Math.min(seg.end, loc.b) };
  // Even a long body may close before the other end of a multi-line citation: keep both cited endpoints.
  return body && body.a <= anchor && body.b >= anchor && body.b - body.a >= original.b - original.a
    ? { a: Math.min(body.a, original.a), b: Math.max(body.b, original.b) } : original;
}

const BATTERY_KEYS = {
  "fake-green": ["fg-skip", "fg-vacuous", "fg-mock", "fg-readback"],
  wiring: ["wr-key", "wr-static"],
  hardcode: ["hd-policy", "hd-gate-exist", "hd-gate-fit", "hd-exempt"],
  // od-conflict intentionally retired from dispatch: JEV cannot reliably resolve this
  // contract/risk relation; aggregator and live probe own that subdecision pending signoff.
  overdesign: ["od-path", "od-repro"],
} as const;
type BatteryCategory = keyof typeof BATTERY_KEYS;

/** Batch 6 typed od vocabulary; explicit overdesign category is mandatory (no od auto-route).
 * A mixed or unmatched assertion does not guess a subtype. */
export function odTypedRoute(claim: string): "dup" | "fut" | "cfg" | "low" | null {
  const matches = ([
    // Synonyms from real od findings: redundancy/excessive defense/gilding the lily all describe duplicate guards.
    ["dup", /重复校验|重复防御|重复验证|冗余|过度防御|防御性过当|画蛇添足|上游已(?:有|做|存在).*校验|duplicate\s+(?:check|validation)/i],
    ["fut", /未来(?:扩展|多租户|调用方)|预留(?:扩展|调用方)|泛化签名|第二(?:个)?调用方|future\s+(?:caller|extension)/i],
    ["cfg", /配置化过度|配置键|第二(?:个)?读取点|配置化|config(?:uration)?\s+(?:key|reader)/i],
    ["low", /低概率|罕见(?:输入|组合|碰撞)|输入组合|low.probability/i],
  ] as const).filter(([, re]) => re.test(claim));
  return matches.length === 1 ? matches[0]![0] : null;
}

/** Evidence gate checks section provenance and executable content, never finding prose or comment-only paths. */
export function batteryEvidenceGaps(category: BatteryCategory, state: string, f: FindingRecord): Record<string, string[]> {
  const chunks = [...state.matchAll(/^##\s+(?:材料[^\n]*|[^\n]*（[^\n]*段[^\n]*）)\n([\s\S]*?)(?=^##\s+(?:材料|来源：)|$(?![\s\S]))/gm)]
    .map((m) => ({ title: m[0]!.split("\n", 1)[0]!, body: m[1] ?? "" }));
  // Real material segments have paths, not goldcase labels. Each is still a distinct source segment.
  const sections = chunks.length ? chunks : [...state.matchAll(/^## 来源：([^\n]+)\n([\s\S]*?)(?=^## 来源：|$(?![\s\S]))/gm)]
    .map((m) => ({ title: `来源：${m[1]!}`, body: m[2] ?? "" }));
  // Remove comments and string literals before checking code tokens; numberedSlice's N| is metadata.
  const executable = (body: string, title: string): string[] => {
    const lexical: { block: boolean; raw: boolean; quote?: string; regex?: boolean; language: "go" | "js" } =
      { block: false, raw: false, language: /\.go\b|```go/i.test(title) || /```go\b|^\s*(?:\d+\|\s*)?func\s+|\w+\s*:=/m.test(body) ? "go" : "js" };
    return body.split("\n").map(line => {
      const text = line.replace(/^\s*\d+\|\s*/, "").trim();
      return /^```/.test(text) ? "" : wiringCodeLine(text, lexical).trim();
    }).filter(line => line !== "" && !/^(?:#|\*|\$\s|\(本轮材料未附)/.test(line));
  };
  const has = (label: RegExp, proof: RegExp): boolean => sections.some((s) => label.test(s.title)
    && executable(s.body, s.title).some((line) => proof.test(line)));
  const cleanBody = (body: string): string => body.replace(/^\s*\d+\|\s*/gm, "");
  const source = sections.some((s) => s.title.startsWith("来源："));
  const needsByKey: Record<string, string[]> = {};
  const add = (keys: readonly string[], need: string): void => {
    for (const key of keys) (needsByKey[key] ??= []).push(need);
  };
  if (category === "fake-green") {
    const keys = BATTERY_KEYS[category];
    // Script-style test files can have top-level assertions without test()/it() wrappers.
    // Count only executable assert calls at brace depth zero in one labelled test section.
    const bareAssertScript = sections.some(s => {
      if (!/(?:_test\.|\.test\.|\.spec\.|测试函数|测试段)/i.test(s.title)) return false;
      const lines = executable(s.body, s.title);
      if (lines.some(line => /^(?:func\s+Test\w+\s*\(|(?:export\s+)?(?:async\s+)?function\s+test\w*\s*\(|(?:test|it|describe)\s*\()/i.test(line))) return false;
      let depth = 0;
      let count = 0;
      let pendingArrow = false;
      for (const line of lines) {
        if (depth === 0 && !pendingArrow && /^assert(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(line)) count++;
        const unbracedArrow = /=>\s*$/.test(line);
        for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth = Math.max(0, depth - 1); }
        pendingArrow = unbracedArrow;
      }
      return count >= 3;
    });
    if (!bareAssertScript && !has(/测试函数|_test\.|\.test\.|spec\./i,
      /^(?:func\s+Test\w+\s*\(|(?:export\s+)?(?:async\s+)?function\s+test\w*\s*\(|(?:test|it|describe)\s*\()/i))
      add(keys, "测试函数全文（代码段）");
    const tested = /^(?:func\s+|(?:export\s+)?(?:async\s+)?function\s+)/;
    if (!has(/被测函数|被测段|被测函数体|（被测|实现段|真实依赖入口|remote\.go/i, tested)
      && !(source && sections.some((s) => !/_test\.|\.test\.|\.spec\./i.test(s.title) && executable(s.body, s.title).some(line => tested.test(line)))))
      add(keys, "被测函数体（代码段）");
    if (!sections.some((s) => /验收命令|验收.*运行结果|\.ci\//.test(s.title)
      && /(?:go test|npm test|pnpm test|pytest|vitest)/.test(s.body)
      && /(?:^|\n)(?:--- SKIP|ok\s|PASS|FAIL|not ok|SKIP)/.test(s.body)))
      add(["fg-skip"], "真实验收命令与运行结果");
    // The test and implementation are the natural attached evidence for the other three questions.
    // A separate fixture/assembly segment is not a prerequisite for asking whether a mock is used.
  } else if (category === "wiring") {
    if (!has(/注册点段|注册端|注册方|registry|register/i, /(?:\.Register\s*\(|\bRegister\s*\()/)
      && !(source && has(/来源：/, /\.Register\s*\(/))) add(["wr-key", "wr-static"], "注册点段（真实代码行）");
    if (!has(/消费点段|消费端|消费方|读取点|consumer|runner|dispatch/i, /(?:\.Get\s*\(|\.WithPrefix\s*\(|\.Read\s*\(|\.Consume\s*\()/)
      && !(source && has(/来源：/, /(?:\.Get|\.WithPrefix|\.Read|\.Consume)\s*\(/)))
      add(["wr-key"], "消费点段（运行时读取的真实代码行）");
  } else if (category === "hardcode") {
    if (!has(/常量定义段|常量段|limit\.go|config.*常量/i, /^(?:const|var|let)\s+\w+\s*=?/)
      && !(source && has(/来源：/, /^(?:const|var|let)\s+\w+\s*=?/)))
      add(["hd-policy", "hd-gate-fit", "hd-exempt"], "常量定义段（代码行）");
    if (!has(/机制定义段|Gate|Registry|配置机制|config\./i, /^(?:type|class|func|function|const|var)\s+\w*\s*(?:Config|Gate|Registry|Policy|Flags|Matches|Register|On|Load)\w*|\.Register\s*\(/)
      && !(source && has(/来源：/, /^(?:type|class|func|function)\s+\w*(?:Config|Gate|Registry|Policy)\w*|\.Register\s*\(/)))
      add(["hd-gate-exist", "hd-gate-fit"], "Gate/Registry/配置机制定义段（代码行）");
  } else {
    if (!sections.some((s) => /合同节选|任务合同|TASK-[\w-]+\.md|task.*合同/i.test(s.title)
      && /(?:§scope|##\s*scope|任务范围)/i.test(cleanBody(s.body))
      && /^\s*[-+]\s*\S/m.test(cleanBody(s.body))
      && !/本轮材料未附|合同节选不在 state/.test(s.body)))
      add(["od-path"], "可识别来源的任务合同节选");
    if (!sections.some((s) => /修复 diff|改动 diff|diff 段|\.diff\b|\.patch\b/i.test(s.title)
      && executable(s.body, s.title).some((line) => /^(?:\+|\-)(?:\s*)(?:func|const|var|let|type|class|if|return|case|throw|\d+\)|\*\)|\w+\s*[:=]|\w+\.\w+\s*\()/.test(line))))
      add(["od-path", "od-repro"], "来源明确的修复 diff 段与被指改动段");
  }
  const gaps: Record<string, string[]> = {};
  for (const key of category === "wiring" ? ["wr-path", ...BATTERY_KEYS.wiring] : BATTERY_KEYS[category]) {
    const needs = [...(needsByKey[key] ?? [])];
    if (key === "wr-path") {
      const paths = sections.filter((s) => /路径段|入口.*注册|调用路径|main\.go|bootstrap/i.test(s.title));
      const pathRows = source ? sections.filter((s) => /来源：.*(?:main|bootstrap|register|registry|install)/i.test(s.title)
        || executable(s.body, s.title).some((line) => /\.Register\s*\(/.test(line))).flatMap((s) => executable(s.body, s.title)) : [];
      if (![...paths.map((s) => executable(s.body, s.title)), pathRows].some((lines) => {
        const funcs = parseWiringFunctions(lines, "来源未标注",
          sections.some(s => /\.(?:ts|tsx|js|jsx)\b|```(?:ts|js)\b/i.test(s.title + s.body)) ? "js" : "go");
        return funcs.length >= 2 && funcs.some(fn => /\.Run\s*\(|\.Install\w*\s*\(/.test(fn.body))
          && funcs.some(fn => /\.Register\s*\(/.test(fn.body));
      })) needs.push("入口→注册路径每一跳的真实函数体代码行（注释式路径不算）");
    }
    if (key === "hd-gate-fit" && !sections.some((s) => /先例|sibling|调用域/.test(s.title)
      && executable(s.body, s.title).some((line) => /(?:\.Register\s*\(|\.Matches\s*\(|\.On\s*\(|\.AllowedOrigins\b|\.Get\s*\(|Contains\s*\()/.test(line)))) needs.push("机制调用域/同类值先例的真实代码段");
    if (key === "hd-exempt" && !sections.some((s) => /豁免.*节选|裁决.*节选|exemption/i.test(s.title)
      && /(?:^\s*[-+]\s*\S|豁免类\s*E\d)/m.test(s.body) && !/本轮材料未附|豁免裁决节选不在 state/.test(s.body))) needs.push("现行豁免裁决节选（可识别来源）");
    if (needs.length) gaps[key] = needs;
  }
  return gaps;
}

export function odTypedEvidenceGaps(state: string, f: FindingRecord, route: ReturnType<typeof odTypedRoute>): Record<string, string[]> {
  // Typed questions inspect the changed code plus their own subtype evidence, not the retired contract question.
  const base = batteryEvidenceGaps("overdesign", state, f)["od-repro"] ?? [];
  const sections = [...state.matchAll(/^## (?:材料[^\n]*|来源：[^\n]*)\n([\s\S]*?)(?=^## (?:材料|来源：)|$(?![\s\S]))/gm)]
    .map(m => ({ title: m[0]!.split("\n", 1)[0]!, body: m[1]!.replace(/^\s*\d+\|\s*/gm, "") }));
  const code = (label: RegExp, proof: RegExp): boolean => sections.some(s => label.test(s.title)
    && s.body.split("\n").some(line => !/^\s*(?:\/\/|#|\*|```)/.test(line) && proof.test(line)));
  const missing: Record<string, string[]> = {};
  if (!route) {
    missing["od-typed"] = [...base, "断言未匹配唯一 od 形态（dup/fut/cfg/low）；由聚合器及人工探针复核"];
    return missing;
  }
  const key = ({ dup: "od-dup", fut: "od-second-caller", cfg: "od-second-reader", low: "od-reach-combo" } as const)[route];
  const need = [...base];
  if (route === "dup" && !code(/上游.*(?:代码|调用方)|upstream/i, /(?:func\s+|function\s+|if\s*\(|if\s+|\.test\s*\(|\.Match\s*\()/))
    need.push("上游调用方的真实代码段（同受验输入及失败语义）");
  const census = (label: RegExp): boolean => sections.some(s => {
    if (!label.test(s.title) || !/\brg\s+-n\b/.test(s.body)
      || !/(?:共\s*\d+\s*处|count\s*[:=]\s*\d+)/i.test(s.body)) return false;
    const hits = s.body.split("\n").map(line => /^(?:[^\n]+):\d+:\s*(.*)$/.exec(line)?.[1]?.trim()).filter((x): x is string => !!x);
    const definitions = hits.map(line => /^(?:func|function)\s+(\w+)/.exec(line)?.[1]).filter((x): x is string => !!x);
    return definitions.some(name => hits.some(line => {
      if (/^(?:func|function)\s+\w+/.test(line) || /^(?:\/\/|#|\*|\/\*)/.test(line)) return false;
      // A census hit inside a quoted string or trailing comment is not a real call.
      const codeLine = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""').split("//", 1)[0]!;
      return new RegExp(`(?:\\b|\\.)${name}\\s*\\(`).test(codeLine);
    }));
  });
  if (route === "fut" && !census(/调用(?:方)?普查段|caller.*survey/i))
    need.push("rg 调用方普查段（定义行、全部命中行及计数注释）");
  if (route === "cfg" && !(sections.some(s => /修复 diff|改动 diff/.test(s.title) && /^\s*\+\s*\w+\s*:/m.test(s.body))
    && sections.some(s => /读取点普查段|reader.*survey/i.test(s.title) && /\brg\s+-n\b/.test(s.body)
      && /(?:共\s*\d+\s*处|count\s*[:=]\s*\d+)/i.test(s.body)
      && /(?:^|\n)[^\n]*:\d+:\s*[^\n]*(?:\[["'`]|\.Get\w*\s*\(|\.\w+\b)/.test(s.body))))
    need.push("rg 读取点普查段（配置定义、全部命中行及计数注释）");
  if (route === "low" && !sections.some(s => {
    if (!/逐跳.*路径段|输入组合.*路径段|调用路径.*代码段/i.test(s.title)) return false;
    const lines = s.body.split("\n").map(line => line.trim()).filter(line => !/^(?:\/\/|#|```)/.test(line));
    const funcs = lines.map((line, i) => ({ i, name: /^(?:func|function)\s+(\w+)\s*\(/.exec(line)?.[1] }))
      .filter((f): f is { i: number; name: string } => !!f.name);
    if (funcs.length < 2) return false;
    // Adjacent declarations alone are not a path: every upstream body must call the next.
    const linked = funcs.slice(0, -1).every((fn, index) => {
      const body = lines.slice(fn.i, funcs[index + 1]!.i).join("\n");
      return new RegExp(`\\b${funcs[index + 1]!.name}\\s*\\(`).test(body.split("{").slice(1).join("{"));
    });
    return linked && /\bif\b/.test(lines.slice(funcs.at(-1)!.i).join("\n"));
  })) need.push("输入组合从入口到守卫的逐跳真实代码路径段");
  if (need.length) missing[key] = need;
  return missing;
}

/** Door-only OD still requests the L4 contract and changed-code diff even when the
 * typed question would have needed only the diff. It never dispatches a question. */
function odGateOnlyEvidenceGaps(state: string, f: FindingRecord, route: ReturnType<typeof odTypedRoute>): Record<string, string[]> {
  const typed = odTypedEvidenceGaps(state, f, route);
  const legacy = batteryEvidenceGaps("overdesign", state, f);
  const key = Object.keys(typed)[0] ?? (route ? ({ dup: "od-dup", fut: "od-second-caller",
    cfg: "od-second-reader", low: "od-reach-combo" } as const)[route] : "od-typed");
  const need = [...new Set([...(typed[key] ?? []), ...(legacy["od-path"] ?? [])])];
  return need.length ? { [key]: need } : {};
}

type WiringFunction = { rel: string; name: string; body: string; snippet: string };

/** Keep block-comment/raw-string state across rows so prose cannot forge call tokens. */
function wiringCodeLine(line: string, state: { block: boolean; raw: boolean; quote?: string; regex?: boolean;
  language?: "go" | "js" }): string {
  let code = "";
  let escaped = false;
  let charClass = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (state.block) { if (ch === "*" && next === "/") { state.block = false; i++; } continue; }
    if (state.raw || state.quote || state.regex) {
      if (escaped) { escaped = false; continue; }
      // Go raw strings do not treat backslashes as escapes; JS template strings do.
      if (ch === "\\" && !(state.raw && state.language === "go")) { escaped = true; continue; }
      if (state.raw && ch === "`") state.raw = false;
      else if (state.quote && ch === state.quote) state.quote = undefined;
      else if (state.regex) {
        if (ch === "[") charClass = true;
        else if (ch === "]") charClass = false;
        else if (ch === "/" && !charClass) state.regex = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") { state.block = true; i++; continue; }
    if (ch === "/" && state.language === "js" && /(?:[=(,:;!\[?]|\breturn|\bif\s*\([^)]*\))\s*$/.test(code)) {
      state.regex = true; continue;
    }
    if (ch === "`") { state.raw = true; continue; }
    if (ch === '"' || ch === "'") { state.quote = ch; continue; }
    code += ch;
  }
  // A quoted JS/TS string can use a trailing backslash to continue on the next line.
  // Raw template strings continue regardless of a trailing backslash.
  if (state.quote && !escaped) state.quote = undefined;
  return code;
}

/** Parse bounded, balanced function bodies, including gofmt multi-line signatures.
 * A source marker is a boundary; comments and string literals cannot manufacture call edges. */
function parseWiringFunctions(lines: string[], initialRel: string, language: "go" | "js" = "go"): WiringFunction[] {
  const out: WiringFunction[] = [];
  let rel = initialRel;
  let pending: { name: string; header: string[] } | undefined;
  let active: { name: string; snippet: string[]; body: string[]; depth: number } | undefined;
  const lexical: { block: boolean; raw: boolean; quote?: string; regex?: boolean; language: "go" | "js" } =
    { block: false, raw: false, language };
  for (const raw of lines) {
    const line = raw.replace(/^\s*\d+\|\s*/, "").trim();
    const marker = !lexical.block && !lexical.raw && !lexical.quote && !lexical.regex
      && /^\/\/\s*([^\s]+\.(?:go|ts|js))/.exec(line);
    if (marker) { rel = marker[1]!; lexical.language = /\.go$/i.test(rel) ? "go" : "js";
      pending = undefined; active = undefined; continue; }
    const code = wiringCodeLine(line, lexical);
    if (!code.trim() || /^(?:#|```)/.test(line)) continue;
    if (!active && !pending) {
      const decl = /^(?:func|function)\s+(\w+)\s*\(/.exec(code);
      if (!decl) continue;
      pending = { name: decl[1]!, header: [] };
    }
    if (pending) {
      pending.header.push(line);
      if (!code.includes("{")) {
        if (pending.header.length >= 12) pending = undefined;
        continue;
      }
      // The opening brace is the end of the signature, not a call in the body.
      const after = code.slice(code.indexOf("{") + 1);
      active = { name: pending.name, snippet: [...pending.header], body: [after], depth: 1 };
      pending = undefined;
      for (const ch of after) { if (ch === "{") active.depth++; else if (ch === "}") active.depth--; }
    } else if (active) {
      active.snippet.push(line);
      active.body.push(code);
      for (const ch of code) { if (ch === "{") active.depth++; else if (ch === "}") active.depth--; }
    }
    if (active && active.depth <= 0) {
      out.push({ rel, name: active.name, body: active.body.join("\n"), snippet: active.snippet.join("\n") });
      active = undefined;
    } else if (active && active.snippet.length >= 80) active = undefined;
  }
  return out;
}

function wiringHopStates(state: string): [string, string] | null {
  const pathMatch = /## 材料-\d+[^\n]*(?:路径段|入口→注册)[^\n]*\n```(go|ts|js)\n([\s\S]*?)```/.exec(state);
  const path = pathMatch?.[2];
  const sourceLines = [...state.matchAll(/^## 来源：([^\n]+)\n([\s\S]*?)(?=^## 来源：|$(?![\s\S]))/gm)]
    .filter((m) => /main|bootstrap|register|registry|install/i.test(m[1]!) || /^(?:\s*\d+\|\s*)?[^/\n]*\.Register\s*\(/m.test(m[2]!))
    .flatMap((m) => [`// ${m[1]!.split("（")[0]!}`, ...m[2]!.split("\n")]);
  if (!path && !sourceLines.length) return null;
  const funcs = parseWiringFunctions(path ? path.split("\n") : sourceLines, "来源未标注",
    pathMatch?.[1] === "go" ? "go" : "js");
  if (funcs.length < 3 || !/\.Register\s*\(/.test(funcs[2]!.body)) return null;
  // Each edge must appear in its caller's own balanced body, including calls split across lines.
  for (const i of [0, 1]) {
    if (!new RegExp(`(?:\\.|\\b)${funcs[i + 1]!.name}\\s*\\(`).test(funcs[i]!.body)) return null;
  }
  const pair = (i: number): string => `## 第 ${i + 1} 跳（仅核这一跳）\n调用方来源：${funcs[i]!.rel}\n\`\`\`go\n${funcs[i]!.snippet}\n\`\`\`\n被调方来源：${funcs[i + 1]!.rel}\n\`\`\`go\n${funcs[i + 1]!.snippet}\n\`\`\``;
  return [pair(0), pair(1)];
}

function batteryState(f: FindingRecord, materials: MaterialMap): string {
  const sections: string[] = [];
  for (const segs of materials.values()) for (const seg of segs) {
    sections.push(`## 来源：${seg.rel}（${seg.kind} 第 ${seg.start}-${seg.end} 行）\n${numberedSlice(seg, seg.start, seg.end)}`);
  }
  return `## 被审 finding（category=${f.category}）\n${f.claim}\n\n${sections.join("\n\n")}`;
}

/** When the pool exceeds Jev's cap, omit comment-only source segments and keep complete,
 * provenance-labelled evidence sections. If a witness still cannot fit, the keyed delivery
 * gap below prevents a question from being judged on a payload that lacks its evidence. */
function batteryDeliveryState(full: string): string {
  if (full.length <= JEVCHECK_STATE_MAX_CHARS) return full;
  const parts = full.split(/(?=^## (?:来源：|材料))/m);
  const heading = parts.shift() ?? "";
  const picked: string[] = [];
  for (const part of parts) {
    const [title = "", ...rows] = part.split("\n");
    const lexical: { block: boolean; raw: boolean; quote?: string; regex?: boolean; language: "go" | "js" } =
      { block: false, raw: false, language: /\.go\b|```go/i.test(title) || /```go\b/.test(part) ? "go" : "js" };
    const hasCode = rows.some(row => {
      const text = row.replace(/^\s*\d+\|\s*/, "").trim();
      return !/^```/.test(text) && !!wiringCodeLine(text, lexical).trim()
        && !/^(?:#|\*|\$\s)/.test(text);
    });
    if (!hasCode && !/验收|合同|diff|普查|路径段/i.test(title)) continue;
    const next = `${part.trimEnd()}\n\n`;
    if (heading.length + picked.join("").length + next.length > JEVCHECK_STATE_MAX_CHARS) continue;
    picked.push(next);
  }
  return capStateText(`${heading}${picked.join("")}`);
}

/** One bounded fallback when a full-pool witness is absent from the first delivery.
 * Pick sections that actually discharge currently missing gate requirements before any
 * unrelated sections; fill remaining space only after all fitting witnesses are chosen. */
function retryBatteryDelivery(full: string, first: string, fullGaps: Record<string, string[]>,
  gate: (state: string) => Record<string, string[]>): string {
  if (full === first) return first;
  const firstGaps = gate(first);
  const keys = Object.keys(firstGaps).filter(key => !fullGaps[key]);
  if (!keys.length) return first;
  const parts = full.split(/(?=^## (?:来源：|材料))/m);
  const heading = parts.shift() ?? "";
  const candidates = parts.map(p => `${p.trimEnd()}\n\n`);
  const selected: number[] = [];
  let state = heading;
  const deficit = (gaps: Record<string, string[]>): number => keys.reduce((n, key) => n + (gaps[key]?.length ?? 0), 0);
  let remaining = deficit(gate(state));
  while (remaining > 0) {
    let best = -1;
    let bestRemaining = remaining;
    let bestRatio = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (selected.includes(i) || state.length + candidates[i]!.length > JEVCHECK_STATE_MAX_CHARS) continue;
      const next = deficit(gate(state + candidates[i]!));
      const ratio = (remaining - next) / candidates[i]!.length;
      if (ratio > bestRatio) { best = i; bestRatio = ratio; bestRemaining = next; }
    }
    if (best < 0) {
      // Some gates need a conjunction of two sections (e.g. a split wiring path):
      // neither section alone reduces a deficit, but together they can.
      let pair: [number, number] | undefined;
      for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
        if (selected.includes(i) || selected.includes(j)) continue;
        if (state.length + candidates[i]!.length + candidates[j]!.length > JEVCHECK_STATE_MAX_CHARS) continue;
        const next = deficit(gate(state + candidates[i]! + candidates[j]!));
        const ratio = (remaining - next) / (candidates[i]!.length + candidates[j]!.length);
        if (ratio > bestRatio) { pair = [i, j]; bestRatio = ratio; bestRemaining = next; }
      }
      if (!pair) break;
      for (const index of pair) { selected.push(index); state += candidates[index]!; }
    } else { selected.push(best); state += candidates[best]!; }
    remaining = bestRemaining;
  }
  for (let i = 0; i < candidates.length; i++) {
    if (!selected.includes(i) && state.length + candidates[i]!.length <= JEVCHECK_STATE_MAX_CHARS)
      state += candidates[i]!;
  }
  return deficit(gate(state)) < deficit(firstGaps) ? state : first;
}

// Batch 5 / arm E: primary is the Go test-file suffix. Secondary accepts test directories
// only for source/test extensions (the sampled synthetic-protocol.mjs false positive is excluded).
export function autoRouteCategory(f: FindingRecord, cfg: JevcheckCfg): FindingRecord {
  if (!cfg.category?.enabled || !cfg.categoryAutoRoute?.enabled || f.category !== undefined) return f;
  const path = f.path.replaceAll("\\", "/");
  const primary = /_test\.go$/i.test(path);
  const secondary = !primary && (/_test\.(?:ts|tsx|js|jsx|py|go)$/i.test(path)
    || /(?:^|\/)test\//i.test(path) && /\.(?:go|ts|tsx|js|jsx|py)$/i.test(path));
  return primary || secondary ? { ...f, category: "fake-green", categoryAutoRouted: primary ? "primary" : "secondary" } : f;
}

const CHAIN_LINE_SLOT_RE = /第\s*[\d、,，\s~至到–—−-]+\s*行|\blines?\s+\d+(?:\s*[-~–—−,]\s*\d+)*/gi;
/** Arm B v3 vocabulary: file refs, numbered line slots, backticks, calls, camel/digit,
 * snake_case, dotted symbols, and ALLCAPS>=4; ordinary lowercase prose is excluded. */
export function chainEvidenceReferences(text: string): { tokens: string[]; lines: number[] } {
  const tokens = new Set<string>();
  const lines = new Set<number>();
  for (const m of text.matchAll(CHAIN_LINE_SLOT_RE)) {
    for (const slot of m[0].matchAll(/\d{1,6}/g)) if (Number(slot[0]) > 0) lines.add(Number(slot[0]));
  }
  const prose = new Set(["when", "where", "while", "then", "and", "the", "that", "with", "from", "e.g", "i.e", "if", "for", "else"]);
  const add = (value: string): void => { if (value.length >= 3 && !prose.has(value.toLowerCase())) tokens.add(value); };
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (/^(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+$|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(m[1]!)) add(m[1]!);
  }
  for (const m of text.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|tsx|js|jsx|py|md)\b|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[a-z][\w$]*[A-Z][\w$]*\b|\b[A-Za-z_$][\w$]*_[A-Za-z_$][\w$]*\b|\b[A-Z][A-Z0-9_]{3,}\b|\b[A-Za-z_$][\w$]*(?=\s*\()/g)) add(m[0]);
  return { tokens: [...tokens], lines: [...lines] };
}

export function checkChainEvidence(f: FindingRecord, materials: MaterialMap): {
  checks: NonNullable<FindingCheck["chainEvidence"]>; gaps: GapRecord[];
} {
  const checks: NonNullable<FindingCheck["chainEvidence"]> = [];
  const gaps: GapRecord[] = [];
  const segments = [...materials.values()].flat();
  for (const step of f.chain ?? []) {
    if (step.kind === "absence") continue;
    const refs = chainEvidenceReferences(step.text);
    if (!refs.tokens.length && !refs.lines.length) continue;
    const fileRef = (token: string): boolean => /\.(?:go|ts|tsx|js|jsx|py|md)$/.test(token);
    const fileMatches = (s: MaterialFile, token: string): boolean =>
      s.rel === token || s.rel.endsWith(`/${token}`) || s.abs.endsWith(`/${token}`);
    const symbolMatches = (s: MaterialFile, token: string): boolean => {
      const pattern = new RegExp(`(^|[^\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
      return s.lines.some(line => pattern.test(line));
    };
    const files = refs.tokens.filter(fileRef);
    const symbols = refs.tokens.filter(token => !fileRef(token));
    const missingTokens = refs.tokens.filter(token => !segments.some(s => fileRef(token) ? fileMatches(s, token) : symbolMatches(s, token)));
    // A file reference and a line slot must occur in the SAME attached file. Without a
    // file reference, tie numbered lines to at least one cited symbol instead of a stray file.
    const lineScope = files.length ? segments.filter(s => files.some(file => fileMatches(s, file)))
      : symbols.length ? segments.filter(s => symbols.some(symbol => symbolMatches(s, symbol))) : segments;
    const linePresent = (line: number): boolean => files.length
      ? files.every(file => lineScope.some(s => fileMatches(s, file) && s.start <= line && line <= s.end))
      : lineScope.some(s => s.start <= line && line <= s.end);
    const missingLines = refs.lines.filter(line => !linePresent(line));
    // A range asserts the entire interval, not just its two endpoints. A single
    // attached interval per named file proves continuity without an O(span) scan.
    for (const slot of step.text.matchAll(CHAIN_LINE_SLOT_RE)) for (const range of slot[0].matchAll(/(\d{1,6})\s*[-~–—−至到]\s*(\d{1,6})/g)) {
      const a = Number(range[1]), b = Number(range[2]);
      if (a > b || !(files.length ? files.every(file => lineScope.some(s => fileMatches(s, file) && s.start <= a && b <= s.end))
        : lineScope.some(s => s.start <= a && b <= s.end))) {
        if (!missingLines.includes(a)) missingLines.push(a);
      }
    }
    const present = !missingTokens.length && !missingLines.length;
    checks.push({ id: step.id, status: present ? "引用在场（机械）" : "引用缺失（机械）", ...refs });
    if (!present) gaps.push({ id: `${f.pid}:chain:${step.id}:chain-evidence-missing`, pid: f.pid,
      path: `${f.path}:${f.lines}`, factIdx: null, kind: "chain-evidence-missing",
      need: [`补入链步 ${step.id} 引用的池内代码材料：${[...missingTokens, ...missingLines.map(n => `第 ${n} 行`)].join("、")}`] });
  }
  return { checks, gaps };
}

/** Arm D: at most three high-signal identifiers or behavioral nouns, in claim order.
 * Exact case-insensitive identifier/word-stem matching is only a coverage hint. */
export function entailBridgeEntities(claim: string): string[] {
  const candidates = claim.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[a-z][\w$]*[A-Z][\w$]*\b|\b[A-Za-z_$][\w$]*_[A-Za-z_$][\w$]*\b|\b[A-Z][A-Z0-9_]{2,}\b|[\u4e00-\u9fff]{2,8}(?:检查|比较|回读|校验|写入|读取|验证)/g) ?? [];
  return [...new Set(candidates.filter(s => s.length >= 3))].slice(0, 3);
}

export function missingEntailBridgeEntities(f: FindingRecord, fc: FindingCheck): string[] {
  const facts = [...f.facts, ...(fc.amended?.added.map(x => x.text) ?? [])].join("\n").toLowerCase();
  return entailBridgeEntities(f.claim).filter(entity => {
    const exact = entity.toLowerCase();
    // Acronyms/qualifiers (HTTPS vs HTTP, SELECT vs SELEC) must never be stemmed.
    const stem = /^[A-Z][A-Z0-9_]+$/.test(entity) ? exact : exact.replace(/(?:ing|ed|es|s)$/, "");
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^\\w$])(?:${escape(exact)}|${escape(stem)}(?:s|es|ed|ing)?)(?![\\w$])`, "i");
    return !pattern.test(facts);
  });
}

export interface CheckFindingInput {
  f: FindingRecord;
  materials: MaterialMap;
  docs: readonly MaterialFile[];
  client: JevClientLike;
  cfg: JevcheckCfg;
  signal?: AbortSignal;
  /** B7（波4）：结果行 run_id（防重跑覆盖，R2-F4）；orchestrate 透传 deps.runId。 */
  runId?: string;
  /** Remaining call allowance from the enclosing report, excluding calls already made here. */
  remainingCalls?: () => number;
  /** Reserve existing chain/entail/fixed and later finding calls before opt-in rechecks. */
  reservedCalls?: number;
  /** Frozen exam state; production builds its own state from attached MaterialMap segments. */
  evidenceState?: string;
  /** Shared only within one run; avoids carrying suspected cache entries across requests. */
  cacheSeen?: Set<string>;
}

export async function checkFinding(input: CheckFindingInput): Promise<FindingCheck> {
  const { materials, docs, client, cfg, signal, runId } = input;
  const f = autoRouteCategory(input.f, cfg);
  const chainEvidence = cfg.chainEvidenceGate?.enabled ? checkChainEvidence(f, materials) : undefined;
  const ref = computeRef(f, materials);

  const factsCheck: FactCheck[] = f.facts.map((fact) => {
    const kind = factKind(fact);
    return kind === "condition"
      ? ({ text: fact, kind, p: null, status: "条件" } satisfies FactCheck)
      : ({ text: fact, kind, p: null, status: "待核" } satisfies FactCheck);
  });

  const calls: JevCall[] = [];
  /** B7（波4）：事实步逐样本 P 留痕（下标 = facts 下标）；只记**已被问过**的事实（truth 只吃已采样 P）。 */
  const factSamples = new Map<number, number[]>();

  // Jev 分流（设计 v4 §12.2 C，波四 2026-09-20）：事实级机械校验（submit_findings.checkFactRef，
  // 经 FindingRecord.factRefs 透传）已判定「未命中 / 行号越界 / 文件未附」的 code 事实通常直接记「不符」
  // 且**不问 Jev**；批10 唯一完整文件名纠偏是行号越界的受限例外，回到待核再问 Jev；「已校正」用校正后的
  // 行切片（不必回退 locateFact 的文本正则解析，checkFactRef 已给出真实位置）；其余（相符/待核/
  // 无标识符，以及 general 类或没有 factRef 命中的事实）走原有 locateFact 四条路径不变。
  // ask：真正送给 Jev 的事实文本——「已校正」用行号改写版（FactRef.rewritten），否则 Jev 拿「第 900 行…」配
  //   第 884 行的切片会因行号对不上判不符（波四复审 2026-09-20）；FactCheck.text 仍存原文。
  const located: Array<{ idx: number; fact: string; ask: string; kind: "code" | "general"; loc: { abs: string; a: number; b: number } | null }> = [];
  f.facts.forEach((fact, idx) => {
    const kind = factKind(fact);
    if (kind === "condition") return;
    const factRef = f.factRefs?.find((fr) => fr.text === fact);
    if (factRef) {
      factsCheck[idx]!.ref = factRef.status;
      if (factRef.status === "已校正") factsCheck[idx]!.correctedLine = factRef.a;
      const detail = factRefAnnotation(factRef);
      if (detail) factsCheck[idx]!.refDetail = detail;
      // 批10真实回执：write_gate.go 第35行在池，但短名 gate.go 误撞 finding.path，
      // 上游记录行号越界。只对唯一的完整尾部文件名、且引用窗口在该段内作路径纠偏；
      // 其余硬错误保留，两个同名候选绝不任选。
      if (factRef.status === "行号越界") {
        const mentions = [...fact.matchAll(/((?:[\w.-]+\/)*[\w.-]+\.(?:go|ts|mts|js|mjs|md|py))\s*第\s*\d+\s*行/g)];
        const lineRef = parseFactLineRef(fact);
        if (mentions.length === 1 && lineRef?.windows.length === 1) {
          const mentioned = mentions[0]![1]!;
          const candidates = [...materials.values()].filter(segs => {
            const rel = segs[0]?.rel;
            return rel === mentioned || rel?.endsWith(`/${mentioned}`);
          });
          if (candidates.length > 1) {
            factRef.status = "待核";
            factsCheck[idx]!.ref = "待核";
            factsCheck[idx]!.refDetail = "（同名文件多候选，未作路径纠偏）";
            factsCheck[idx]!.locPath = "null";
            return;
          }
          if (candidates.length === 1 && candidates[0]![0]!.rel !== factRef.file) {
            const seg = candidates[0]!.find(s => s.start <= lineRef.a && lineRef.b <= s.end);
            if (seg) {
              factRef.file = seg.rel;
              factRef.a = lineRef.a;
              factRef.b = lineRef.b;
              factRef.status = "待核";
              factsCheck[idx]!.ref = "待核";
              factsCheck[idx]!.refDetail = "（引用文件名唯一纠偏；原行号越界来自短名误撞，交 Jev 核）";
            }
          }
        }
      }
      if (factRef.status === "未命中" || factRef.status === "行号越界" || factRef.status === "文件未附") {
        factsCheck[idx]!.status = "不符"; // 不问 Jev：机械校验已给出确定答案（§12.2 C）。
        return;
      }
    }
    let loc: { abs: string; a: number; b: number } | null;
    let quoteDecision: QuoteDecision | undefined;
    const tracePath = gapDiagnostics(cfg) ? (path: FactLocPath) => { factsCheck[idx]!.locPath = path; } : undefined;
    const quote = cfg.quote?.enabled ? f.factQuotes?.[idx] : undefined;
    if (quote !== undefined && typeof quote === "string" && quote.trim()) {
      const refSegs = findSegsForPath(factRef?.file ?? f.path, materials);
      const lines = parseLinesLoose(f.lines);
      const a = factRef?.a ?? lines?.a;
      const b = factRef?.b ?? lines?.b;
      const anchorSeg = a !== undefined && b !== undefined ? refSegs?.find(s => s.start <= a && b <= s.end) : undefined;
      const anchor = anchorSeg && a !== undefined && b !== undefined ? { abs: anchorSeg.abs, a, b } : null;
      quoteDecision = checkQuote(quote, fact, f, factRef, materials, anchor);
      factsCheck[idx]!.quoteStatus = quoteDecision.status;
      if (quoteDecision.audit) factsCheck[idx]!.quoteAudit = quoteDecision.audit;
      if (quoteDecision.status === "歧义" || quoteDecision.status === "校正待核") {
        // A quote with multiple possible anchors or incomplete atomic correction cannot be sent as a selected location.
        factsCheck[idx]!.locPath = "null";
        return;
      }
      if (quoteDecision.correction && factRef) {
        // Commit all three fields together only after the quote line and text rewrite have passed validation.
        Object.assign(factRef, quoteDecision.correction, { status: "已校正" });
        factsCheck[idx]!.ref = "已校正";
        factsCheck[idx]!.correctedLine = quoteDecision.correction.a;
        factsCheck[idx]!.refDetail = `（引用已校正 ${quoteDecision.correction.originalLine || "无"}→${quoteDecision.correction.a}；quote ${quoteDecision.audit}）`;
      } else if (quoteDecision.status === "精确" && factRef?.status === "待核") {
        // Appendix C: a unique literal hit dissolves the old token-level ambiguity.
        factRef.status = "相符";
        factsCheck[idx]!.ref = "相符";
        factsCheck[idx]!.refDetail = `（引用歧义由 quote 唯一命中消解 ${quoteDecision.audit}）`;
      }
    }
    // Fact-level anchor telemetry: independently check both endpoints in attached segments;
    // a missing endpoint is a gap, never a semantic refutation or an extra JEV call.
    if (cfg.factRefDirect?.enabled && factRef && (factRef.status === "相符" || factRef.status === "已校正")) {
      const segs = findSegsForPath(factRef.file, materials) ?? [];
      if (![factRef.a, factRef.b].every(n => segs.some(s => s.start <= n && n <= s.end))) {
        factsCheck[idx]!.lineAnchorDrift = true;
      }
    }
    if (quoteDecision?.loc) {
      loc = quoteDecision.loc;
      tracePath?.(quoteDecision.status === "精确" ? "ref-corrected" : quoteDecision.status === "跨文件校正" ? "cross-file" : "same-file-else");
    } else if (factRef?.status === "已校正" || (cfg.factRefDirect?.enabled && factRef?.status === "相符")) {
      const segs = findSegsForPath(factRef.file, materials);
      const seg = segs?.find((s) => s.start <= factRef.a && factRef.a <= s.end);
      loc = seg
        ? { abs: seg.abs, a: Math.max(seg.start, factRef.a - JEVCHECK_FACT_PAD), b: Math.min(seg.end, factRef.a + JEVCHECK_FACT_PAD) }
        : locateFact(fact, f, materials, docs, tracePath);
      if (seg) tracePath?.("ref-corrected");
    } else {
      loc = locateFact(fact, f, materials, docs, tracePath);
    }
    const ask = quoteDecision?.rewritten ?? (factRef?.status === "已校正" && factRef.rewritten ? factRef.rewritten : fact);
    located.push({ idx, fact, ask, kind: kind as "code" | "general", loc });
  });
  for (const e of located) {
    if (e.loc) factsCheck[e.idx]!.slice = e.loc;
  }
  const bySlice = new Map<string, typeof located>();
  for (const e of located) {
    if (!e.loc) continue;
    const key = `${e.loc.abs}:${e.loc.a}-${e.loc.b}`;
    const arr = bySlice.get(key);
    if (arr) arr.push(e);
    else bySlice.set(key, [e]);
  }
  for (const entries of bySlice.values()) {
    const loc = entries[0]!.loc!;
    const seg = segFor(materials, loc.abs, loc.a);
    const range = seg && cfg.factThicken?.enabled ? thickFactRange(seg, loc) : loc;
    const sliceText = seg ? numberedSlice(seg, range.a, range.b) : "";
    const rel = seg?.rel ?? loc.abs;
    const rawState = `## ${sliceHeading(rel)}（${rel}，第 ${range.a}-${range.b} 行）\n\`\`\`\n${sliceText}\n\`\`\``;
    const state = capStateText(rawState);
    const questions: Record<string, { q: "fact"; instructions: string; criteria: Record<string, string> }> = {};
    for (const e of entries) {
      questions[`f${e.idx}`] = {
        q: "fact",
        instructions: `${QUESTIONS.fact.instructions}\n\n## 待核对的事实\n${e.ask}`,
        criteria: QUESTIONS.fact.criteria,
      };
    }
    let r: JevAskResult;
    try {
      r = await client.ask(state, questions, cfg.sampling.fact, signal, input.cacheSeen);
    } catch (err) {
      if (err instanceof JevUnavailable) throw err;
      if (gapDiagnostics(cfg)) for (const e of entries) factsCheck[e.idx]!.askFault = true;
      r = { results: {}, calls: [] };
    }
    if (gapDiagnostics(cfg)) markState(r.calls, state, rawState.length);
    calls.push(...r.calls);
    for (const e of entries) {
      const p = r.results[`f${e.idx}`]?.p ?? null;
      // B7（波4）：逐步 P 留痕——事实步的逐样本 P 本就在采样面（ask 多键逐轮），此处收集供 truth 用。
      factSamples.set(e.idx, r.results[`f${e.idx}`]?.samples ?? []);
      const fc = factsCheck[e.idx]!;
      if (gapDiagnostics(cfg) && p === null) fc.askFault = true; // 包括响应成功但该键未解析出答案
      fc.p = p;
      fc.status = factStatusFromP(p, cfg.thresholds.fact);
    }
  }
  // P1': recheck only gray fact means. A low thick answer is a suspect gap, never an automatic refutation.
  if (cfg.grayEnrich?.enabled) {
    const baseline = cfg.sampling.entail + (jevEnforceChain(cfg) && f.chain?.length ? jevLinkSamples(cfg) : 0)
      + (cfg.fixPresent.enabled ? cfg.sampling.fixed : 0) + (input.reservedCalls ?? 0);
    let extraAttempted = 0;
    for (const e of located) {
      const fc = factsCheck[e.idx]!;
      if (!e.loc || fc.p === null || factStatusFromP(fc.p, cfg.thresholds.fact) !== "待核") continue;
      const available = input.remainingCalls?.() ?? cfg.budget.maxCalls;
      if (available - calls.length - extraAttempted - baseline < cfg.sampling.fact) {
        fc.grayEnrichSkipped = true;
        continue;
      }
      const seg = segFor(materials, e.loc.abs, e.loc.a);
      if (!seg) continue;
      const range = thickFactRange(seg, e.loc);
      const rawState = `## ${sliceHeading(seg.rel)}（${seg.rel}，第 ${range.a}-${range.b} 行）\n\`\`\`\n${numberedSlice(seg, range.a, range.b)}\n\`\`\``;
      const state = capStateText(rawState);
      try {
        const r = await client.ask(state, { [`f${e.idx}`]: {
          q: "fact-behave", instructions: `${QUESTIONS["fact-behave"].instructions}\n\n## 待核对的事实\n${e.ask}`,
          criteria: QUESTIONS["fact-behave"].criteria,
        } }, cfg.sampling.fact, signal, input.cacheSeen);
        if (gapDiagnostics(cfg)) markState(r.calls, state, rawState.length);
        calls.push(...r.calls);
        extraAttempted += Math.max(0, cfg.sampling.fact - r.calls.length);
        fc.pThick = r.results[`f${e.idx}`]?.p ?? null;
        if (fc.pThick !== null && fc.pThick >= cfg.thresholds.fact.high) {
          fc.p = fc.pThick;
          fc.status = "相符";
          fc.grayEnriched = true;
          factSamples.set(e.idx, r.results[`f${e.idx}`]?.samples ?? []);
        } else if (fc.pThick !== null && fc.pThick <= cfg.thresholds.fact.low) {
          fc.thickRefuted = true;
        }
      } catch (err) {
        if (err instanceof JevUnavailable) throw err;
        extraAttempted += cfg.sampling.fact;
        fc.pThick = null;
      }
    }
  }
  // 无法定位（locateFact 返回 null）的事实：保持 p=null、status="待核"（已在初始化时设好）。

  // ---- B7（波4）：链步采样（q:"link"，n=cfg.sampling.link=2）——state=该 finding 材料区（Q3 裁决）。
  // 灰度总闸 chain.enabled=false ⇒ 本块整体跳过（不采链步、不出 truth），checkFinding 输出与旧版逐字节等价。
  const chainOn = jevEnforceChain(cfg);
  const chainSamples = new Map<string, number[]>();
  let closureDropped = 0;
  if (chainOn && f.chain && f.chain.length > 0) {
    const closure = cfg.stateExpansion?.enabled ? findingClosureState(f, factsCheck, materials) : undefined;
    const state = closure ? closure.state : findingRegionState(f, materials);
    closureDropped = closure?.dropped ?? 0;
    const questions: Record<string, { q: "link"; instructions: string; criteria: Record<string, string> }> = {};
    for (const s of f.chain) {
      questions[s.id] = {
        q: "link",
        instructions: `${QUESTIONS.link.instructions}\n\n## 待核对的步骤\n${s.text}`,
        criteria: QUESTIONS.link.criteria,
      };
    }
    try {
      const r = await client.ask(state, questions, jevLinkSamples(cfg), signal, input.cacheSeen);
      calls.push(...r.calls);
      for (const s of f.chain) chainSamples.set(s.id, r.results[s.id]?.samples ?? []);
    } catch (err) {
      if (err instanceof JevUnavailable) throw err;
      for (const s of f.chain) chainSamples.set(s.id, []); // 单样本失败：记空样本（缺采样 ⇒ INSUFFICIENT 档，judge v2 原样）
    }
  }

  // entail（前提能否推出 claim）
  let p1: number | null = null;
  try {
    const r = await client.noul("entail", buildEntailState(f.facts, f.claim), cfg.sampling.entail, signal, input.cacheSeen);
    p1 = r.p;
    calls.push(...r.calls);
  } catch (err) {
    if (err instanceof JevUnavailable) throw err;
  }

  // fixPresent（可选，只进回执；缺省关，见 cfg.fixPresent.enabled）
  let fixPresent: number | undefined;
  if (cfg.fixPresent.enabled) {
    const segs = findSegsForPath(f.path, materials);
    const ab = parseLinesLoose(f.lines);
    if (segs && ab) {
      const seg = segs.find((s) => s.start <= ab.a && ab.b <= s.end) ?? segs[0]!;
      const body = functionBodyAround(seg, ab.a) ?? {
        a: Math.max(seg.start, ab.a - JEV_FIXED_PAD),
        b: Math.min(seg.end, ab.b + JEV_FIXED_PAD),
      };
      const rawState = `## ${sliceHeading(seg.rel)}（${seg.rel}）\n\`\`\`\n${numberedSlice(seg, body.a, body.b)}\n\`\`\`\n\n## 待核对的处理\n${f.fix_expect}`;
      const state = capStateText(rawState);
      try {
        const r = await client.noul("fixed", state, cfg.sampling.fixed, signal, input.cacheSeen);
        if (r.p !== null) fixPresent = r.p;
        if (gapDiagnostics(cfg)) markState(r.calls, state, rawState.length);
        calls.push(...r.calls);
      } catch (err) {
        if (err instanceof JevUnavailable) throw err;
      }
    }
  }

  const hasCondition = factsCheck.some((c) => c.kind === "condition");
  const conditionFlag = computeConditionFlag(factsCheck);
  const p1v = p1 ?? 0; // Jev 未答（非 JevUnavailable 的单样本失败）：按「未证」处理，不当作已满足
  const status = synthesizeStatus(factsCheck, p1v, hasCondition, cfg);

  const refConsistencyDetail = computeRefConsistencyDetail(f, materials);
  // ---- B7（波4）：truth 生产填充点——checkFinding 对每 finding 跑 evalTruth（复用已采样 P、零新增 Jev 调用：
  //   evalTruth 本体纯函数；逐步 P 的采样面 = 上方 fact 多键 ask 的逐键 samples + 链步 ask 的逐键 samples）。
  //   留痕：每步 samples[]+mechNotes[] 进 truth.steps（spool receipt 校准数据持续积累）；结果行带 run_id（R2-F4）。
  //   未采样到的步（条件类事实/机械已判不符而未问 Jev 的事实）不进步集——truth 只吃已采样 P（Q3 裁决口径）。
  let truth: FindingTruth | undefined;
  if (chainOn) {
    const truthInputs: TruthStepInput[] = [];
    for (const [idx, samples] of factSamples) {
      const text = f.facts[idx]!;
      truthInputs.push({ id: `f${idx + 1}`, kind: factKind(text), text, samples });
    }
    for (const s of f.chain ?? []) {
      const samples = chainSamples.get(s.id);
      if (samples) truthInputs.push({ id: s.id, kind: s.kind as TruthStep["kind"], text: s.text, samples });
    }
    if (truthInputs.length > 0) {
      const material = findingTruthMaterial(f, materials);
      const truthOpts = { th: jevTruthThresholds(cfg), mechEnabled: jevMechEnabled(cfg) };
      const steps = truthStepsOf(truthInputs, material, truthOpts);
      const verdict = evalTruth(truthInputs, material, truthOpts);
      truth = {
        ...verdict,
        steps: steps.map((s) => ({ id: s.id, kind: s.kind, samples: [...s.samples], mechNotes: [mechNoteOf(s)] })),
        ...(runId !== undefined ? { run_id: runId } : {}),
      };
    }
  }
  let battery: FindingCheck["battery"];
  let batteryGaps: GapRecord[] | undefined;
  let batterySkipped = 0;
  if (cfg.category?.enabled && f.category && f.category !== "behavior" && f.category in BATTERY_KEYS) {
    const category = f.category as BatteryCategory;
    const fullEvidence = input.evidenceState ?? batteryState(f, materials);
    const typedOd = category === "overdesign" && cfg.odTyped?.enabled;
    const gatesOnly = typedOd && cfg.odTyped?.gatesOnly === true;
    const route = typedOd ? odTypedRoute(f.claim) : null;
    const gate = (payload: string): Record<string, string[]> => gatesOnly
      ? odGateOnlyEvidenceGaps(payload, f, route) : typedOd
        ? odTypedEvidenceGaps(payload, f, route) : batteryEvidenceGaps(category, payload, f);
    // The gate sees the complete pool. On a delivery miss, rebuild once with the
    // missing witness sections ahead of unrelated material, then verify the payload.
    const fullGaps = gate(fullEvidence);
    const state = retryBatteryDelivery(fullEvidence, batteryDeliveryState(fullEvidence), fullGaps, gate);
    const deliveredGaps = state === fullEvidence ? {} : gate(state);
    const missing = { ...fullGaps };
    for (const [key, needs] of Object.entries(deliveredGaps)) {
      if (!missing[key]) missing[key] = ["所需证据在全材料池，但未能同装进 20k Jev state", ...needs];
    }
    batteryGaps = Object.entries(missing).map(([key, need]) => ({
      id: `${f.pid}:battery:${key}:locate-fail`, pid: f.pid, path: `${f.path}:${f.lines}`,
      factIdx: null, kind: "locate-fail" as const, need,
    }));
    const hops = category === "wiring" && !missing["wr-path"] ? wiringHopStates(fullEvidence) : null;
    if (category === "wiring" && !missing["wr-path"] && !hops) {
      batteryGaps.push({ id: `${f.pid}:battery:wr-path:locate-fail`, pid: f.pid, path: `${f.path}:${f.lines}`,
        factIdx: null, kind: "locate-fail", need: ["逐跳三段真实函数体及相邻调用表达式；注释路径不采信"] });
    }
    const odKey = route ? ({ dup: "od-dup", fut: "od-second-caller", cfg: "od-second-reader", low: "od-reach-combo" } as const)[route] : null;
    const keys: string[] = typedOd ? (!gatesOnly && odKey && !missing[odKey] ? [odKey] : [])
      : [...(hops ? ["wr-hop-1", "wr-hop-2"] : []), ...BATTERY_KEYS[category].filter((key) => !missing[key])];
    const baseline = cfg.sampling.entail + (chainOn && f.chain?.length ? jevLinkSamples(cfg) : 0)
      + (cfg.fixPresent.enabled ? cfg.sampling.fixed : 0) + (input.reservedCalls ?? 0);
    const available = input.remainingCalls?.() ?? cfg.budget.maxCalls;
    const room = Math.max(0, Math.floor((available - calls.length - baseline) / 2));
    const allowed = keys.slice(0, room);
    batterySkipped = keys.length - allowed.length;
    const answers: Array<{ key: string; p: number }> = [];
    const askFault = (key: string): void => { batteryGaps!.push({ id: `${f.pid}:battery:${key}:ask-fault`, pid: f.pid,
      path: `${f.path}:${f.lines}`, factIdx: null, kind: "ask-fault", need: ["复核 JEV 判定请求并重试该分类问"] }); };
    // Each hop receives only the two relevant real code lines: no multi-hop JEV reasoning.
    for (const [index, hopKey] of ["wr-hop-1", "wr-hop-2"].entries()) {
      if (!allowed.includes(hopKey) || !hops) continue;
      try {
        const r = await client.ask(hops[index]!, { [hopKey]: { q: hopKey as JevCall["q"], ...QUESTIONS[hopKey as JevCall["q"]] } }, 2, signal, input.cacheSeen);
        calls.push(...r.calls);
        const p = r.results[hopKey]?.p;
        if (p === null || p === undefined) askFault(hopKey); else answers.push({ key: hopKey, p });
      } catch (err) { if (err instanceof JevUnavailable) throw err; askFault(hopKey); }
    }
    const ordinary = allowed.filter((key) => !key.startsWith("wr-hop-"));
    if (ordinary.length) {
      const questions = Object.fromEntries(ordinary.map((key) => [key, { q: key as JevCall["q"], ...QUESTIONS[key as JevCall["q"]] }]));
      try {
        const r = await client.ask(state, questions, 2, signal, input.cacheSeen);
        calls.push(...r.calls);
        for (const key of ordinary) {
          const p = r.results[key]?.p;
          if (p === null || p === undefined) askFault(key); else answers.push({ key, p });
        }
      } catch (err) { if (err instanceof JevUnavailable) throw err; for (const key of ordinary) askFault(key); }
    }
    // A complete wiring path is a deterministic AND of high-confidence atomic hops.
    const hopScores = answers.filter((x) => x.key.startsWith("wr-hop-"));
    if (hops && hopScores.length === 2) answers.push({ key: "wr-path", p: Math.min(...hopScores.map((x) => x.p)) });
    else if (hops && allowed.includes("wr-hop-2")) askFault("wr-path");
    battery = answers;
  }
  return {
    pid: f.pid,
    ref,
    facts: factsCheck,
    entail: { p1: p1v },
    ...(battery?.length ? { battery } : {}),
    ...(batteryGaps?.length ? { batteryGaps } : {}),
    ...(chainEvidence?.checks.length ? { chainEvidence: chainEvidence.checks } : {}),
    ...(chainEvidence?.gaps.length ? { chainEvidenceGaps: chainEvidence.gaps } : {}),
    ...(cfg.category?.enabled && f.category && f.category !== "behavior" ? { batterySkipped } : {}),
    ...(fixPresent !== undefined ? { fixPresent } : {}),
    status,
    conditionFlag,
    calls,
    ...(cfg.stateExpansion?.enabled ? { closureDropped } : {}),
    ...(truth ? { truth } : {}),
    ...(f.refConsistency ? { refConsistency: f.refConsistency } : {}),
    ...(refConsistencyDetail ? { refConsistencyDetail } : {}),
  };
}

function makeUncheckedFindingCheck(f: FindingRecord, materials: MaterialMap): FindingCheck {
  const ref = computeRef(f, materials);
  const facts: FactCheck[] = f.facts.map((fact) => {
    const kind = factKind(fact);
    return kind === "condition"
      ? ({ text: fact, kind, p: null, status: "条件" } satisfies FactCheck)
      : ({ text: fact, kind, p: null, status: "待核" } satisfies FactCheck);
  });
  const refConsistencyDetail = computeRefConsistencyDetail(f, materials);
  return {
    pid: f.pid,
    ref,
    facts,
    entail: { p1: 0 },
    status: "未核",
    conditionFlag: computeConditionFlag(facts),
    calls: [],
    ...(f.refConsistency ? { refConsistency: f.refConsistency } : {}),
    ...(refConsistencyDetail ? { refConsistencyDetail } : {}),
  };
}

// ---------------------------------------------------------------------------
// premiseRound：补前提独立短会话（设计 v4 §3.2/§3.3/§5.2；裁决 C2/C3/C12）
// ---------------------------------------------------------------------------

function amendPrompt(p: {
  pid: string;
  rel: string;
  a: number;
  b: number;
  slice: string;
  facts: readonly string[];
  claim: string;
  id: string;
  missingEntities?: readonly string[];
}): string {
  return (
    `系统核对：你之前提交的 ${p.pid} 的事实前提被判为不足以推出其 claim。\n` +
    `## 材料（${p.rel} 第 ${p.a}-${p.b} 行）\n${p.slice}\n\n` +
    `## 已列出的前提\n${p.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\n` +
    `## claim\n${p.claim}\n` +
    (p.missingEntities?.length ? `已有缺口提示：缺关于 ${p.missingEntities.join("、")} 的前提，请针对性补充相关断言。\n` : "") +
    `请调用工具 amend_facts(id="${p.id}", facts=[…]) 补充缺失的前提，最多 4 条：代码事实带行号；` +
    `通用事实以「通用事实：」开头；环境条件以「运行时条件：」开头且如实写成条件。` +
    `补不出来就 amend_facts(id="${p.id}", facts=[], cannot_amend_reason="…")。只处理这一条。`
  );
}

export interface PremiseRoundResultEntry {
  added: FactCheck[];
  calls?: JevCall[];
  reason?: string;
  ms: number;
  entailP2?: number;
  /** entail(p2) 调用本身是否被发起过（波二修复单 12：即使 Jev 未答出可解析的 p，调用也已经
   * 发生，runJevCheck 汇总 totals.calls 时要把这次往返算进去，不能只在 entailP2 有值时才计）。 */
  entailCallMade?: boolean;
}

export interface PremiseRoundInput {
  findings: readonly FindingRecord[];
  perFinding: Readonly<Record<string, FindingCheck>>;
  materials: MaterialMap;
  docs: readonly MaterialFile[];
  cfg: JevcheckCfg;
  workers: readonly WorkerRef[];
  runSessionFn: RunSessionFn;
  modelRuntime: ModelRuntime;
  cwd: string;
  readRoots: readonly string[];
  loader?: DefaultResourceLoader;
  client: JevClientLike;
  signal?: AbortSignal;
}

/**
 * B5 分流判据（设计稿 §4 B5，波3）：**link 证伪或中带 ⇒ 不再问 Jev、不再补事实**——
 * link 步被严格证伪（DOWNGRADE 档）或弱证伪/中带（DOWNGRADE-weak 档）、破绽定位在该 finding
 * chain 的 link 步上时，补前提救不了坏链（实测 214 例：补事实只是烧预算），premiseRound 直接跳过。
 * 判据数据 = `FindingCheck.truth`（B4 verdictOf 引擎产物；逐步 P 采样的生产填充点随 B7/波4 接线，
 * 本波由 evalTruth/金标准回放覆盖）。truth 缺省（未接线/无 chain 的存量路径）⇒ 维持现行为不动。
 */
export function linkBlockedForPremise(f: FindingRecord, fc: FindingCheck | undefined): boolean {
  const t = fc?.truth;
  if (!t || t.verdict !== "因果存疑" || !t.brokenStep) return false;
  return (f.chain ?? []).some((s) => s.id === t.brokenStep && s.kind === "link");
}

/**
 * 对 status="前提不足" 的 finding，按 p1 升序取前 `cfg.premiseRound.maxFindings` 条，
 * 并行度 = `cfg.premiseRound.concurrency`，每条起一个独立短会话（同 proposer 模型，
 * 只带 amend_facts 工具，maxToolCalls=2）补前提，再对新增事实核对 + 重算 entail。
 * B5 分流（波3）：link 证伪/中带的候选不再起短会话、不再问 Jev，直标 truth=因果存疑（见
 * `linkBlockedForPremise`）；fact 缺/不符 ⇒ amend_facts 的现行为一字不改。
 */
export async function premiseRound(input: PremiseRoundInput): Promise<Map<string, PremiseRoundResultEntry>> {
  const { findings, perFinding, materials, docs, cfg, workers, runSessionFn, modelRuntime, cwd, readRoots, loader, client, signal } =
    input;

  const candidates = findings
    .filter((f) => perFinding[f.pid]?.status === "前提不足")
    .sort((a, b) => perFinding[a.pid]!.entail.p1 - perFinding[b.pid]!.entail.p1)
    .slice(0, Math.max(0, cfg.premiseRound.maxFindings));

  const results = new Map<string, PremiseRoundResultEntry>();
  if (candidates.length === 0) return results;

  const concurrency = Math.max(1, cfg.premiseRound.concurrency);
  let idx = 0;

  const runOne = async (f: FindingRecord): Promise<void> => {
    const t0 = Date.now();
    // ---- B5 分流（设计稿 §4 B5，波3）----
    // fact 缺/不符 ⇒ amend_facts（下方现行为一字不动）；link 证伪或中带 ⇒ 不再问 Jev（不重算
    // entail p2）、不再补事实（不起 amend 短会话），直标 truth=因果存疑——补事实救不了坏链。
    if (linkBlockedForPremise(f, perFinding[f.pid])) {
      const fcB5 = perFinding[f.pid];
      if (fcB5?.truth) {
        // 直标 truth=因果存疑（B5）：破绽步与 mechNotes 原样保留，rule 打 B5-link 分流留痕。
        fcB5.truth = {
          verdict: "因果存疑",
          rule: "B5-link",
          ...(fcB5.truth.brokenStep !== undefined ? { brokenStep: fcB5.truth.brokenStep } : {}),
          mechNotes: fcB5.truth.mechNotes,
          ...(gapDiagnostics(cfg) ? { steps: fcB5.truth.steps, b5From: fcB5.truth.rule, ...(fcB5.truth.run_id ? { run_id: fcB5.truth.run_id } : {}) } : {}),
        };
      }
      results.set(f.pid, { added: [], reason: "B5 分流：link 证伪/中带，不补事实、不问 Jev", ms: Date.now() - t0 });
      return;
    }
    try {
      const worker = workers[f.proposerIndex];
      if (!worker) {
        results.set(f.pid, { added: [], ms: Date.now() - t0 });
        return;
      }
      const segs = findSegsForPath(f.path, materials);
      const ab = parseLinesLoose(f.lines);
      const seg = segs && ab ? segs.find((s) => s.start <= ab.a && ab.b <= s.end) : undefined;
      const sliceText = seg && ab ? numberedSlice(seg, ab.a, ab.b) : "";
      const prompt = amendPrompt({
        pid: f.pid,
        rel: seg?.rel ?? f.path,
        a: ab?.a ?? 0,
        b: ab?.b ?? 0,
        slice: sliceText,
        facts: f.facts,
        claim: f.claim,
        id: f.id,
        ...(cfg.entailBridge?.enabled ? { missingEntities: missingEntailBridgeEntities(f, perFinding[f.pid]!) } : {}),
      });
      const amendState: AmendState = createAmendState();
      // F-W1（FB-11③ 生产接线，波3）：补链后累计全链 ≤6 的执法要看到既有链——把 `f.chain` 作为
      // baseChain 传给 amend_facts 工厂（波2 已实现校验，只欠调用方传参）；无 chain 的存量路径不受影响。
      const tool = createAmendFactsTool(
        amendState,
        materials,
        { id: f.id, path: f.path, ...(f.chain ? { baseChain: f.chain } : {}) },
        cwd,
        readRoots,
      );
      await runSessionFn(modelRuntime, worker, prompt, {
        timeoutMs: cfg.premiseRound.perCallMs,
        tools: ["amend_facts"],
        extraTools: [tool],
        cwd,
        readRoots,
        ...(loader ? { resourceLoader: loader } : {}),
        maxToolCalls: 2,
        ...(signal ? { signal } : {}),
        structuredState: amendState,
      }).catch(() => undefined); // runSession 承诺不抛；防御性吞错，按「未补充」处理

      const ms = Date.now() - t0;
      if (!amendState.accepted || amendState.accepted.length === 0) {
        results.set(f.pid, { added: [], ...(amendState.reason !== undefined ? { reason: amendState.reason } : {}), ms });
        return;
      }

      const added: FactCheck[] = [];
      const addedCalls: JevCall[] = [];
      for (const fact of amendState.accepted) {
        const kind = factKind(fact);
        if (kind === "condition") {
          added.push({ text: fact, kind, p: null, status: "条件" });
          continue;
        }
        // 波四复审（2026-09-20）：amend_facts 里 checkFactRef 的结果此前只登记进 AmendState.factRefs 没人读，
        // 补充事实照旧全部问 Jev。与 checkFinding 同一分流：未命中/行号越界/文件未附 → 不问 Jev 直判不符；
        // 已校正 → 切片用校正行、问 Jev 用改写后文本；ref/correctedLine/refDetail 一并带上供核对表标注。
        const amendRef = amendState.factRefs?.find((fr) => fr.text === fact);
        const refFields: Pick<FactCheck, "ref" | "correctedLine" | "refDetail"> = amendRef
          ? {
              ref: amendRef.status,
              ...(amendRef.status === "已校正" ? { correctedLine: amendRef.a } : {}),
              ...(factRefAnnotation(amendRef) ? { refDetail: factRefAnnotation(amendRef) } : {}),
            }
          : {};
        if (amendRef && (amendRef.status === "未命中" || amendRef.status === "行号越界" || amendRef.status === "文件未附")) {
          added.push({ text: fact, kind, p: null, status: "不符", ...refFields });
          continue;
        }
        let loc: { abs: string; a: number; b: number } | null = null;
        let locPath: FactLocPath | undefined;
        if (amendRef?.status === "已校正" || (cfg.factRefDirect?.enabled && amendRef?.status === "相符")) {
          const segC = findSegsForPath(amendRef.file, materials)?.find((s) => s.start <= amendRef.a && amendRef.a <= s.end);
          if (segC) { loc = { abs: segC.abs, a: Math.max(segC.start, amendRef.a - JEVCHECK_FACT_PAD), b: Math.min(segC.end, amendRef.a + JEVCHECK_FACT_PAD) }; locPath = "ref-corrected"; }
        }
        if (!loc) loc = locateFact(fact, f, materials, docs, gapDiagnostics(cfg) ? (path) => { locPath = path; } : undefined);
        const pathField = gapDiagnostics(cfg) && locPath ? { locPath } : {};
        if (!loc) {
          added.push({ text: fact, kind, p: null, status: "待核", ...refFields, ...pathField });
          continue;
        }
        const ask = amendRef?.status === "已校正" && amendRef.rewritten ? amendRef.rewritten : fact;
        // 与 checkFinding 同一协议约定（state=共享切片，instructions 带上本条事实文本；
        // .md/.txt 标题写「材料」，其余写「代码」——两处若不统一，同一份切片在补前提前后
        // 会以不同形状问 Jev，纯属实现细节但容易踩坑）。
        const seg2 = segFor(materials, loc.abs, loc.a);
        const rel2 = seg2?.rel ?? loc.abs;
        const rawState = `## ${sliceHeading(rel2)}（${rel2}，第 ${loc.a}-${loc.b} 行）\n\`\`\`\n${seg2 ? numberedSlice(seg2, loc.a, loc.b) : ""}\n\`\`\``;
        const state = capStateText(rawState);
        const questions = {
          fact: { q: "fact" as const, instructions: `${QUESTIONS.fact.instructions}\n\n## 待核对的事实\n${ask}`, criteria: QUESTIONS.fact.criteria },
        };
        try {
          const r = await client.ask(state, questions, cfg.sampling.fact, signal);
          const p = r.results.fact?.p ?? null;
          if (gapDiagnostics(cfg)) { markState(r.calls, state, rawState.length); addedCalls.push(...r.calls); }
          added.push({ text: fact, kind, p, status: factStatusFromP(p, cfg.thresholds.fact), slice: loc, ...refFields, ...pathField, ...(gapDiagnostics(cfg) && p === null ? { askFault: true } : {}) });
        } catch (err) {
          if (err instanceof JevUnavailable) throw err;
          added.push({ text: fact, kind, p: null, status: "待核", slice: loc, ...refFields, ...pathField, ...(gapDiagnostics(cfg) ? { askFault: true } : {}) });
        }
      }

      let entailP2: number | undefined;
      let entailCallMade = false;
      try {
        const allFacts = [...f.facts, ...amendState.accepted];
        entailCallMade = true;
        const r2 = await client.noul("entail", buildEntailState(allFacts, f.claim), cfg.sampling.entail, signal);
        if (gapDiagnostics(cfg)) addedCalls.push(...r2.calls);
        if (r2.p !== null) entailP2 = r2.p;
      } catch (err) {
        if (err instanceof JevUnavailable) throw err;
      }

      results.set(f.pid, {
        added,
        ...(gapDiagnostics(cfg) ? { calls: addedCalls } : {}),
        ms,
        ...(entailP2 !== undefined ? { entailP2 } : {}),
        ...(entailCallMade ? { entailCallMade: true } : {}),
      });
    } catch (err) {
      // 波二修复单 5：单条候选遇 JevUnavailable 不向外抛，记原因，其它候选继续；是否整份
      // 降级由外层 runJevCheck 的 client 状态（连续失败/JevUnavailable 冒泡到 runJevCheck 顶层）决定。
      if (err instanceof JevUnavailable) {
        results.set(f.pid, { added: [], reason: "补前提：Jev 不可用", ms: Date.now() - t0 });
        return;
      }
      // 其它异常（内部 bug / 会话层异常）同样只废这一条：否则 Promise.all 早 reject 会把整轮
      // 已完成的 perFinding 与 dedupe 一并丢掉（PiMoa 复审意见）。
      results.set(f.pid, { added: [], reason: `补前提：内部错误：${err instanceof Error ? err.message : String(err)}`.slice(0, 200), ms: Date.now() - t0 });
    }
  };

  const workersPool = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= candidates.length) return;
      await runOne(candidates[i]!);
    }
  });
  await Promise.all(workersPool);
  return results;
}

// ---------------------------------------------------------------------------
// dedupeAndConflicts / oneSided（跨 proposer 同题、冲突、单边；设计 v4 §3.5）
// ---------------------------------------------------------------------------

/** 两个行区间的「缺口」≤ pad 即算重叠（缺口 = 较晚区间的起点 − 较早区间的终点，双向取较大者）。
 * 只在一侧各加一次 pad（不是双向都加，否则总容差会变成 2×pad，参见第二波单测「counter 远处不配对」）。 */
function linesOverlap(a: Pick<FindingRecord, "lines">, b: Pick<FindingRecord, "lines">, pad: number): boolean {
  const pa = parseLinesLoose(a.lines);
  const pb = parseLinesLoose(b.lines);
  if (!pa || !pb) return false;
  return pa.a <= pb.b + pad && pb.a <= pa.b + pad;
}

function absOf(f: Pick<FindingRecord, "path">, materials: MaterialMap): string {
  return findSegsForPath(f.path, materials)?.[0]?.abs ?? f.path;
}

export interface DedupeResult {
  duplicates: JevCheckReport["duplicates"];
  conflicts: JevCheckReport["conflicts"];
}

/**
 * 只比跨 proposer 对，先按同 abs 预筛（不同文件的对不比）。counter 条目只与「同位置」
 * （行区间重叠 ±10）的对方 finding 直接配对问 opposite，不问 same（视为已同位置，pSame 记 1）。
 * 其余对先问 same：≥merge 记「同一问题」、[flag,merge) 记「疑似重复」；≥sameMin 再问 opposite，
 * ≥oppositeMin 记入 conflicts。
 */
export async function dedupeAndConflicts(
  findings: readonly FindingRecord[],
  materials: MaterialMap,
  client: JevClientLike,
  cfg: JevcheckCfg,
  signal?: AbortSignal,
): Promise<DedupeResult> {
  const duplicates: JevCheckReport["duplicates"] = [];
  const conflicts: JevCheckReport["conflicts"] = [];

  const byAbs = new Map<string, FindingRecord[]>();
  for (const f of findings) {
    const abs = absOf(f, materials);
    const arr = byAbs.get(abs);
    if (arr) arr.push(f);
    else byAbs.set(abs, [f]);
  }

  let pairCount = 0;
  for (const group of byAbs.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.proposerIndex === b.proposerIndex) continue; // 同 proposer 内不跑 same（E7 裁决）
        if (pairCount >= JEVCHECK_SAME_MAX_PAIRS) continue;
        pairCount++;

        const locA = `${a.path}:${a.lines}`;
        const locB = `${b.path}:${b.lines}`;
        const pairState = `## finding A（${a.pid}）\n${a.claim}（${locA}）\n\n## finding B（${b.pid}）\n${b.claim}（${locB}）`;
        const isCounterPair = a.kind === "counter" || b.kind === "counter";

        if (isCounterPair) {
          if (!linesOverlap(a, b, 10)) continue; // 只配对「同位置」
          try {
            const ro = await client.noul("opposite", pairState, cfg.sampling.opposite, signal);
            if (ro.p !== null && ro.p >= cfg.thresholds.conflict.oppositeMin) {
              conflicts.push({ a: a.pid, b: b.pid, pSame: 1, pOpposite: ro.p, viaCounter: true });
            }
          } catch (err) {
            if (err instanceof JevUnavailable) throw err;
          }
          continue;
        }

        try {
          const rs = await client.noul("same", pairState, cfg.sampling.same, signal);
          if (rs.p === null) continue;
          if (rs.p >= cfg.thresholds.same.merge) duplicates.push({ a: a.pid, b: b.pid, p: rs.p, status: "同一问题" });
          else if (rs.p >= cfg.thresholds.same.flag) duplicates.push({ a: a.pid, b: b.pid, p: rs.p, status: "疑似重复" });
          if (rs.p >= cfg.thresholds.conflict.sameMin) {
            const ro = await client.noul("opposite", pairState, cfg.sampling.opposite, signal);
            if (ro.p !== null && ro.p >= cfg.thresholds.conflict.oppositeMin) {
              conflicts.push({ a: a.pid, b: b.pid, pSame: rs.p, pOpposite: ro.p, viaCounter: false });
            }
          }
        } catch (err) {
          if (err instanceof JevUnavailable) throw err;
        }
      }
    }
  }
  return { duplicates, conflicts };
}

/** 按 abs + 行区间重叠（±10）对齐，只在一方（某个 proposer）出现的 finding（机械，不调 Jev）。 */
export function oneSided(
  findings: readonly FindingRecord[],
  materials: MaterialMap,
  report: Pick<JevCheckReport, "duplicates" | "conflicts">,
): JevCheckReport["oneSided"] {
  const paired = new Set<string>();
  for (const d of report.duplicates) {
    paired.add(d.a);
    paired.add(d.b);
  }
  for (const c of report.conflicts) {
    paired.add(c.a);
    paired.add(c.b);
  }
  const out: JevCheckReport["oneSided"] = [];
  for (const f of findings) {
    if (paired.has(f.pid)) continue;
    // 波二修复单 15：kind==="counter" 的孤立项不列入单边项——counter 是「声明某处不存在缺陷」，
    // 没配对到冲突对象时不代表「另一方漏报」，硬套单边项语义（服务端渲染会推出「能→另一方漏报」）
    // 会把一句无害的反面声明错误地暗示成对方的疏漏。
    if (f.kind === "counter") continue;
    const fAbs = absOf(f, materials);
    const hasOther = findings.some(
      (g) => g.pid !== f.pid && g.proposerIndex !== f.proposerIndex && absOf(g, materials) === fAbs && linesOverlap(f, g, 10),
    );
    if (!hasOther) out.push({ id: f.pid, proposerIndex: f.proposerIndex });
  }
  return out;
}

// ---------------------------------------------------------------------------
// renderCheckTable（原有事实只用状态词；开分类旗时电池逐问展示校准 P；设计 v4 §3.5）
// ---------------------------------------------------------------------------

const TABLE_HEADER = "===== 核对表（系统机械核验 + Jev 判定；只是材料，不是判决）=====";

/** 「引用：…」行的文案（波二修复单 14）：锚点不唯一 → 附「（待核）」；其余状态词照原样显示。 */
function refLabel(ref: FindingCheck["ref"]): string {
  return ref === "锚点不唯一" ? "锚点不唯一（待核）" : ref;
}

/**
 * 派生标记（2026-09-21「改 3：从哪里抄」）：把该 finding 触发的**条件必填**字段直接印进材料，
 * 让聚合器不必从状态词自己反推。判据与 `validateVerdicts` **同源**（见文件头 import 处注释）：
 *   · `须填：table_handling` ← `submit_verdicts.ts` 导出的 `isAnomalous`；
 *   · `须填：conditions ×N` ← 以 `fc.conditionFlag` 为门，N 取同一个 `conditionFactCount`。
 * 两者都不需要时返回空数组（不印该行）。
 */
function mustFillMarkers(fc: FindingCheck | undefined): string[] {
  const out: string[] = [];
  if (isAnomalous(fc)) out.push("须填：table_handling");
  if (fc?.conditionFlag) out.push(`须填：conditions ×${conditionFactCount(fc)}`);
  return out;
}

/** 严格证伪档的规则名（双样一致 ≤refute 定档；judge v2 `strict` 语义）——「双样一致」标注只对这些规则成立。 */
const STRICT_REFUTE_RULES = new Set(["KILL", "DOWNGRADE", "DOWNGRADE-noMech", "INSUFFICIENT-locateMiss"]);

/**
 * B6（设计 §4 B6，波4）：核对表「破绽定位」行（渲染就绪文案，数据取 FindingCheck.truth 的 brokenStep+mechNotes
 * 与逐步 samples 留痕）：`F3·c2 被证伪（0.02/0.03 双样一致）｜机械佐证: 第 57 行不含「…」`。
 * verdict≠假 时把「被证伪」位换成 verdict 词（因果存疑/依据不足），不虚报处决。
 */
function brokenStepLine(f: FindingRecord, fc: FindingCheck | undefined): string | undefined {
  const t = fc?.truth;
  if (!t?.brokenStep) return undefined;
  const trace = t.steps?.find((s) => s.id === t.brokenStep);
  const samples = trace?.samples ?? [];
  const consistent = samples.length === 2 && STRICT_REFUTE_RULES.has(t.rule);
  const sampleText =
    samples.length === 0 ? "（缺采样）" : consistent ? `（${samples.join("/")} 双样一致）` : `（${samples.join("/")}）`;
  const verdictWord = t.verdict === "假" ? "被证伪" : t.verdict;
  const noteEntry = t.mechNotes.find((m) => m.startsWith(`${t.brokenStep}｜`));
  const note = noteEntry ? noteEntry.slice(t.brokenStep.length + 1) : "—";
  return `破绽定位：${f.id}·${t.brokenStep} ${verdictWord}${sampleText}｜机械佐证: ${note}`;
}

// Per-key direction describes the subclaim only; no battery probability settles a finding.
const BATTERY_TRUE_SUPPORTS = new Set(["fg-skip", "fg-vacuous", "fg-mock", "wr-static", "hd-policy",
  "hd-gate-exist", "hd-gate-fit", "od-dup"]);
const BATTERY_TRUE_WEAKENS = new Set(["fg-readback", "wr-key", "wr-path", "wr-hop-1", "wr-hop-2",
  "hd-exempt", "od-path", "od-repro", "od-second-caller", "od-second-reader", "od-reach-combo"]);
function batteryRows(f: FindingRecord, fc: FindingCheck | undefined, enabled: boolean): string[] {
  if (!enabled || !f.category || !(f.category in BATTERY_KEYS)) return [];
  const category = f.category as BatteryCategory;
  const typed = category === "overdesign" && (!!fc?.battery?.some(x => /^od-(?:dup|second-|reach-)/.test(x.key))
    || !!fc?.batteryGaps?.some(x => /:battery:od-(?:typed|dup|second-|reach-)/.test(x.id)));
  const keys: string[] = category === "wiring" ? ["wr-hop-1", "wr-hop-2", "wr-path", ...BATTERY_KEYS.wiring]
    : typed ? ["od-typed", "od-dup", "od-second-caller", "od-second-reader", "od-reach-combo"] : [...BATTERY_KEYS[category]];
  const answers = new Map(fc?.battery?.map(x => [x.key, x.p]));
  const gaps = new Map(fc?.batteryGaps?.map(g => [g.id.split(":battery:")[1]?.split(":")[0], g]));
  const rows = keys.filter(key => answers.has(key) || gaps.has(key)).map(key => {
    const p = answers.get(key);
    if (p !== undefined) {
      const supports = BATTERY_TRUE_SUPPORTS.has(key);
      const weakens = BATTERY_TRUE_WEAKENS.has(key);
      const direction = p >= .8 ? supports ? "支持指控" : weakens ? "削弱指控" : "待核"
        : p <= .2 ? supports ? "削弱指控" : weakens ? "支持指控" : "待核" : "待核";
      return `${key}｜P ${p.toFixed(2)}｜${direction}`;
    }
    const gap = gaps.get(key);
    return `${key}｜—｜${gap?.kind === "locate-fail" ? "缺证据未发问" : "问答故障未判"}`;
  });
  if (fc?.batterySkipped) rows.push(`预算｜—｜跳过 ${fc.batterySkipped} 问（题键未记录）`);
  return rows;
}

function oneLiner(f: FindingRecord, fc: FindingCheck | undefined, categoryEnabled = true): string {
  const status = fc?.status ?? "未核";
  const refPart = fc && fc.ref !== "OK" ? ` 引用：${refLabel(fc.ref)}` : "";
  // ★派生标记必须同时进 oneLiner：renderCheckTable 超限时会把条目降级成一行摘要（正常项第一步、
  //   异常项第二步），只印进 fullBlock 的话标记会在降级后丢失。
  const must = mustFillMarkers(fc);
  const quoteAlerts = [...(fc?.facts ?? []).entries()]
    .filter(([, x]) => x.quoteStatus === "本轮材料池未找到 quote" || x.quoteStatus === "歧义" || x.quoteStatus === "校正待核")
    .map(([i, x]) => ` 🔴quote F${i + 1}：${x.quoteStatus}`).join("");
  const chainRefs = fc?.chainEvidence?.map(s => `${s.id} ${s.status}`).join(" ｜ ");
  const rows = batteryRows(f, fc, categoryEnabled);
  const compact = rows.map(row => row.replace(/｜P /, " ").replace(/｜—｜/, " ").replace(/｜/, " ")).join("·");
  const summary = compact.length > 220 ? `${compact.slice(0, 205)}…（共 ${rows.length} 项）` : `${compact}${rows.length ? `（共 ${rows.length} 项）` : ""}`;
  return `${f.pid} ${f.level}${categoryEnabled && f.category ? ` 类别：${f.category}${summary ? `｜${summary}` : ""}` : ""} ${f.path}:${f.lines} 合成状态：${status}${refPart}${must.length > 0 ? ` ${must.join(" ")}` : ""}${quoteAlerts}${chainRefs ? ` 链步引用：${chainRefs}` : ""}`;
}

function fullBlock(
  f: FindingRecord,
  fc: FindingCheck | undefined,
  dups: JevCheckReport["duplicates"],
  confs: JevCheckReport["conflicts"],
  isOneSided: boolean,
  categoryEnabled = true,
): string {
  const head = [f.level, ...(categoryEnabled && f.category ? [`类别：${f.category}`] : []), `${f.path}:${f.lines}`, `合成状态：${fc?.status ?? "未核"}`];
  if (fc?.conditionFlag) head.push("条件红旗");
  const lines: string[] = [`【核对表 ${f.pid} ｜ ${f.proposerModel} ｜ ${head.join(" ｜ ")}】`];

  // 三路互验「不一致」（徐总 09-20 追加裁定，波四）：finding 首行加「引用不一致（lines a-b / anchor L /
  // 事实 m-n）」——ref 已在 computeRef 归到「锚点不唯一」档，这里再补上具体三路的数字详情。
  if (fc?.refConsistency === "不一致" && fc.refConsistencyDetail) {
    lines.push(`引用不一致（${fc.refConsistencyDetail}）`);
  }

  // 波二修复单 14：ref 四态直接渲染状态词（不再有 nearestLine/「最相似行」——那是旧 quoteHit
  // 模糊相似度的产物，anchor 定位现在只做精确子串匹配，没有等价的相似度回退可展示）。
  if (fc && fc.ref !== "OK") {
    lines.push(`引用：${refLabel(fc.ref)}`);
  }

  // ★2026-09-21 派生标记（见 mustFillMarkers）：紧随「引用：」行印出，一行一个条件必填字段。
  lines.push(...mustFillMarkers(fc));

  const battery = batteryRows(f, fc, categoryEnabled);
  if (battery.length) lines.push("电池判定：", ...battery);
  // Presence is strictly a reference check; it never asserts the causal step's truth.
  if (fc?.chainEvidence?.length) lines.push(`链步引用：${fc.chainEvidence.map(s => `${s.id} ${s.status}`).join(" ｜ ")}`);
  // B6（波4）：truth.brokenStep 存在时显示「破绽定位」行。
  const broken = brokenStepLine(f, fc);
  if (broken) lines.push(broken);

  const codeGeneral = (fc?.facts ?? []).filter((x) => x.kind !== "condition");
  if (codeGeneral.length > 0) {
    lines.push(`事实：${codeGeneral.map((x, i) => `F${i + 1} ${x.status}${x.refDetail ?? ""}${x.quoteStatus ? ` ｜ ${x.quoteStatus === "本轮材料池未找到 quote" || x.quoteStatus === "歧义" ? "🔴" : ""}quote：${x.quoteStatus}${x.quoteAudit ? `（${x.quoteAudit}）` : ""}` : ""}`).join(" ｜ ")}`);
  }
  // ★PIMOA-DEF-05（2026-09-20）：条件集合必须与 `conditionFlag` / `conditionFactCount` 同源
  //   （`[...fc.facts, ...fc.amended.added]`）。此前只取 `fc.facts`（构造后无回写，补前提结果
  //   只落在 fc.amended.added）⇒ 补前提新增的
  //   condition 既不进本行、也不进模型可见的任何地方，模型却被要求「给 conditions 且条数等于 N」，
  //   而 N 由 `conditionFactCount` 与 flag 同源算出——可见信息与要求对不上，必然 3 次被拒
  //   （moa#e1c484fa）。来自补前提的条目加「（补前提）」标记，便于模型对齐条数。
  const conds = [
    ...(fc?.facts ?? []).filter((x) => x.kind === "condition").map((c) => ({ c, fromAmendment: false })),
    ...(fc?.amended?.added ?? []).filter((x) => x.kind === "condition").map((c) => ({ c, fromAmendment: true })),
  ];
  if (conds.length > 0) {
    lines.push(
      `成立条件：${conds
        .map(({ c, fromAmendment }) => `${c.text.replace(/^运行时条件：/, "")}${fromAmendment ? "（补前提）" : ""}`)
        .join("；")}`,
    );
  }
  if (fc?.amended) {
    if (fc.amended.added.length > 0) {
      const ok = fc.amended.added.filter((a) => a.status === "相符").length;
      const bad = fc.amended.added.filter((a) => a.status === "不符").length;
      lines.push(`补前提：新增 ${fc.amended.added.length} 条，${ok} 条相符${bad > 0 ? ` ${bad} 条不符` : ""}`);
    } else {
      lines.push(`补前提：未能补充${fc.amended.reason ? `（${fc.amended.reason}）` : ""}`);
    }
  }
  lines.push(dups.length > 0 ? `同题：${dups.map((d) => `与 ${d.a === f.pid ? d.b : d.a} ${d.status}`).join("；")}` : "同题：—");
  lines.push(
    confs.length > 0
      ? `冲突：${confs.map((c) => `与 ${c.a === f.pid ? c.b : c.a}${c.viaCounter ? "（counter）" : ""} 结论相反`).join("；")}`
      : "冲突：—",
  );
  lines.push(isOneSided ? "单边：是" : "单边：—");
  return lines.join("\n");
}

/**
 * 渲染核对表（事实为状态词；分类电池开旗时显示逐问 P）。体积超 `maxChars` 时按
 * 「有异常条目优先保留全量，其余降为一行摘要；仍超限则从尾部继续降级；最后硬截断」裁剪。
 */
function renderCheckTableCore(
  report: Pick<JevCheckReport, "perFinding" | "duplicates" | "conflicts" | "oneSided">,
  findings: readonly FindingRecord[],
  materials: MaterialMap,
  maxChars: number,
  categoryEnabled = true,
): { text: string; truncated: boolean } {
  const dupOf = (pid: string): JevCheckReport["duplicates"] => report.duplicates.filter((d) => d.a === pid || d.b === pid);
  const confOf = (pid: string): JevCheckReport["conflicts"] => report.conflicts.filter((c) => c.a === pid || c.b === pid);
  const oneSidedSet = new Set(report.oneSided.map((o) => o.id));

  // 布局用判据（**不是**门控判据，勿与 import 的 `isAnomalous` 混用）：决定超限裁剪时谁保留全量。
  // 语义比 `submit_verdicts.ts` 的 `isAnomalous` 宽得多——把所有非「前提完备且全部相符」都算异常，
  // 还含同题/冲突两档；2026-09-21 改名为 `needsFullBlock` 以免与派生标记用的门控判据同名相撞。
  const needsFullBlock = (f: FindingRecord): boolean => {
    const fc = report.perFinding[f.pid];
    if (!fc) return true;
    if (fc.status !== "前提完备且全部相符") return true;
    if (fc.ref !== "OK") return true;
    // B6（波4）：破绽定位不得在超限降级时丢失。
    if (fc.truth?.brokenStep) return true;
    if (dupOf(f.pid).length > 0 || confOf(f.pid).length > 0) return true;
    return false;
  };

  const rows = findings.map((f) => {
    const fc = report.perFinding[f.pid];
    return {
      f,
      fc,
      anomalous: needsFullBlock(f),
      full: fullBlock(f, fc, dupOf(f.pid), confOf(f.pid), oneSidedSet.has(f.pid), categoryEnabled),
    };
  });

  const render = (bodies: string[]): string => [TABLE_HEADER, ...bodies].join("\n\n");

  let bodies = rows.map((r) => r.full);
  let text = render(bodies);
  if (text.length <= maxChars) return { text, truncated: false };

  // 超限第一步：正常条目降为一行摘要，异常条目保留全量。
  bodies = rows.map((r) => (r.anomalous ? r.full : oneLiner(r.f, r.fc, categoryEnabled)));
  text = render(bodies);
  if (text.length <= maxChars) return { text, truncated: true };

  // 仍超限：异常条目也从尾部开始降级为一行摘要。
  for (let i = rows.length - 1; i >= 0 && text.length > maxChars; i--) {
    if (!rows[i]!.anomalous) continue;
    bodies[i] = oneLiner(rows[i]!.f, rows[i]!.fc, categoryEnabled);
    text = render(bodies);
  }
  if (text.length <= maxChars) return { text, truncated: true };

  // 最后手段：硬截断。波二修复单 16：maxChars 若小于标记本身的长度，标记也要跟着截——
  // 此前 `cut` 会钳到 0 但整条 marker 仍会原样拼接，返回值可能超出 maxChars。
  const marker = "\n…（核对表超限，已截断）";
  const cut = Math.max(0, maxChars - marker.length);
  return { text: (text.slice(0, cut) + marker).slice(0, Math.max(0, maxChars)), truncated: true };
}

export function renderCheckTable(
  report: Pick<JevCheckReport, "perFinding" | "duplicates" | "conflicts" | "oneSided">,
  findings: readonly FindingRecord[], materials: MaterialMap, maxChars: number,
  gaps?: readonly GapRecord[],
  categoryEnabled = true,
): { text: string; truncated: boolean } {
  if (!gaps) return renderCheckTableCore(report, findings, materials, maxChars, categoryEnabled);
  const counts = new Map<GapRecord["kind"], number>();
  for (const gap of gaps) counts.set(gap.kind, (counts.get(gap.kind) ?? 0) + 1);
  const summary = `缺口清单：${gaps.length} 条${[...counts].map(([kind, n]) => ` ${kind}=${n}`).join("")}；完整清单见 receipt.gaps`;
  // Always reserve the summary before reducing table bodies; a truncated table cannot silently hide the count.
  const budget = Math.max(0, maxChars - summary.length - 2);
  const body = renderCheckTableCore(report, findings, materials, budget, categoryEnabled);
  if (maxChars < summary.length + 2) {
    const n = String(gaps.length);
    const count = maxChars >= n.length + 3 ? `缺口:${n}` : maxChars >= n.length + 1 ? `#${n}` : n;
    // 数字本身放不下时优先完整交付计数；无法同时满足预算与显计数两条不变量。
    return { text: count, truncated: true };
  }
  return { text: `${body.text}\n\n${summary}`, truncated: body.truncated };
}

// ---------------------------------------------------------------------------
// runJevCheck（顶层编排；预算/时限/fail-open）
// ---------------------------------------------------------------------------

/** Terminal gaps are assembled after premiseRound; factIdx is a zero-based index in facts + amended.added. */
export function collectTerminalGaps(findings: readonly FindingRecord[], perFinding: Readonly<Record<string, FindingCheck>>, entailBridgeEnabled = false): GapRecord[] {
  const out = new Map<string, GapRecord>();
  for (const f of findings) {
    const fc = perFinding[f.pid];
    if (!fc || fc.status === "未核") continue;
    const put = (kind: GapRecord["kind"], factIdx: number | null, need: string[]): void => {
      const id = `${f.pid}:${factIdx === null ? "entail" : `fact${factIdx}`}:${kind}`;
      if (!out.has(id)) out.set(id, { id, pid: f.pid, path: `${f.path}:${f.lines}`, factIdx, kind, need });
    };
    for (const [i, fact] of [...fc.facts, ...(fc.amended?.added ?? [])].entries()) {
      if (fact.kind === "condition") continue;
      if (fact.ref === "未命中" || fact.ref === "行号越界" || fact.ref === "文件未附") {
        put("ref-hard-error", i, ["修正引用的文件和行号，并提供可核对的锚点"]);
      } else if (fact.lineAnchorDrift) {
        put("line-anchor-drift", i, ["factRef 行号区间端点未同时落在对应文件的附入材料段内；补充端点材料或校正行号"]);
      } else if (fact.quoteStatus === "歧义") {
        put("quote-ambiguous", i, ["quote 在本轮附入材料中命中多个不同位置，补充唯一整行原文或明确引用位置"]);
      } else if (fact.quoteStatus === "校正待核") {
        put("quote-ambiguous", i, ["校正候选已定位但事实文本无法原子改写：修正事实中的文件/行号引用后重交，或人工核对候选位置"]);
      } else if (fact.thickRefuted) {
        put("gray-refute-suspect", i, ["厚材料答疑似不符：人工或机械复核引用行、函数行为与细粒度语义，勿直接判不符"]);
      } else if (fact.askFault) {
        put("ask-fault", i, ["检查 Jev 请求/响应异常并复核该事实"]);
      } else if (fact.status === "待核" && !fact.slice) {
        put("locate-fail", i, ["附入事实引用所在文件及行区间"]);
      }
    }
    if (fc.status === "前提不足") {
      const missing = entailBridgeEnabled ? missingEntailBridgeEntities(f, fc) : [];
      put("entail-low", null, missing.length ? missing.map(entity => `缺关于 ${entity} 的前提`) : ["补充可支撑结论的前提与可核实材料"]);
    }
  }
  return [...out.values()];
}

export interface RunJevCheckInput {
  findings: readonly FindingRecord[];
  materials: MaterialMap | undefined;
  cfg: JevcheckCfg;
  workers: readonly WorkerRef[];
  runSessionFn: RunSessionFn;
  modelRuntime: ModelRuntime;
  cwd: string;
  readRoots: readonly string[];
  loader?: DefaultResourceLoader;
  emit?: (e: StageEvent) => void;
  signal?: AbortSignal;
  deadlineMs: number;
  /** 供测试注入 mock；真实运行时缺省用 `JevClient.shared(cfg)`。 */
  client?: JevClientLike;
  /** 流水化（设计 v4 §3.5）：orchestrate 在每个 proposer 会话结束时已跑过的 FindingCheck，按 pid 键入。 */
  precomputed?: ReadonlyMap<string, FindingCheck>;
  /** B7（波4）：结果行 run_id（防重跑覆盖，R2-F4）；orchestrate 透传 deps.runId。 */
  runId?: string;
}

function emptyReport(enabled: boolean, skipped: string): JevCheckReport {
  return {
    enabled,
    skipped,
    perFinding: {},
    duplicates: [],
    conflicts: [],
    oneSided: [],
    proposerQuality: {},
    totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
    tableText: "",
  };
}

/**
 * 波三 b 修复单第 6 条：供 orchestrate.ts 在 `runJevCheck` 调用点自身的 try/catch 里兜底
 * （区别于 `runJevCheck` 内部已有的 fail-open catch——这里防的是调用点周边代码，如组装
 * 入参 / 事后回填 proposerQuality 的那段，抛出未预期异常时也不拖垮整轮 verify）。
 * 等价于 `emptyReport(false, reason)`：与 Jev 不可用 / 内部错误走同一条 fail-open 路径。
 */
export function disabledReport(reason: string): JevCheckReport {
  return emptyReport(false, reason);
}

function computeProposerQuality(
  findings: readonly FindingRecord[],
  perFinding: Readonly<Record<string, FindingCheck>>,
): JevCheckReport["proposerQuality"] {
  const out: JevCheckReport["proposerQuality"] = {};
  const byProposer = new Map<number, FindingRecord[]>();
  for (const f of findings) {
    const arr = byProposer.get(f.proposerIndex);
    if (arr) arr.push(f);
    else byProposer.set(f.proposerIndex, [f]);
  }
  for (const [proposerIndex, fs] of byProposer) {
    const key = `P${proposerIndex + 1}`;
    let refMismatch = 0;
    let factsLow = 0;
    let condCount = 0;
    let factCount = 0;
    for (const f of fs) {
      const fc = perFinding[f.pid];
      if (!fc) continue;
      if (fc.ref !== "OK") refMismatch++;
      for (const fact of fc.facts) {
        factCount++;
        if (fact.status === "不符") factsLow++;
        if (fact.kind === "condition") condCount++;
      }
    }
    out[key] = {
      findings: fs.length,
      refMismatch,
      factsLow,
      // rejects（proposer 端 submit_findings 重提次数）不在 runJevCheck 输入范围内，见文件末说明。
      rejects: 0,
      conditionRate: factCount > 0 ? condCount / factCount : 0,
    };
  }
  return out;
}

/**
 * 波二修复单 10：单条 finding 的 Jev 核验可能有好几趟网络往返（fact 多键请求 + entail，
 * 甚至 fixPresent），`perCallTimeoutMs` 只管每一趟各自的上限，不管这几趟加起来的总时长。
 * 这里把 deadline 剩余时间也接进 signal：`AbortSignal.any` 让「外部 signal」与「本轮 deadline
 * 剩余时间」谁先触发就先生效，从而不让单条 finding 的多次往返整体超出 deadline。
 */
function combinedSignal(base: AbortSignal | undefined, remainingMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, remainingMs));
  return base ? AbortSignal.any([base, timeout]) : timeout;
}

/**
 * jevcheck 顶层入口（设计 v4 §3.4/§3.5）。`cfg.enabled=false` 或无材料/无 findings → 直接
 * `enabled:false` 跳过（不调用 Jev）；预算（`budget.maxCalls`/`deadlineMs`）耗尽 → 已完成的
 * finding 保留、未跑到的记 status="未核"，报告仍 `enabled:true` 但带 `skipped` 说明；
 * `JevUnavailable` 冒泡到此处 → 整份报告降级为 `enabled:false`（fail-open）；任何其它异常
 * （波二修复单 4）同样 fail-open，不再 throw——verify 主流程绝不能被 jevcheck 内部错误拖垮。
 */
export async function runJevCheck(input: RunJevCheckInput): Promise<JevCheckReport> {
  const emit = input.emit ?? ((): void => undefined);
  emit({ stage: "jevcheck", phase: "started" });
  const start = Date.now();

  if (!input.cfg.enabled) {
    emit({ stage: "jevcheck", phase: "skipped" });
    return emptyReport(false, "jevcheck.enabled=false");
  }
  if (!input.materials || input.materials.size === 0 || input.findings.length === 0) {
    emit({ stage: "jevcheck", phase: "skipped" });
    return emptyReport(true, input.findings.length === 0 ? "本轮无已接受 findings" : "本轮无附入材料");
  }

  const materials = input.materials;
  const cfg = input.cfg;
  const findings = cfg.categoryAutoRoute?.enabled ? input.findings.map(f => autoRouteCategory(f, cfg)) : input.findings;
  const client = input.client ?? JevClient.shared({ url: cfg.url, concurrency: cfg.concurrency, perCallTimeoutMs: cfg.perCallTimeoutMs, clientMode: cfg.clientMode });
  // 波二修复单 11：单例跨轮共享，每轮开始清零连续失败计数；throttled 只记「本轮」的限流重试次数
  // （用前后 throttledCount 的差值，而不是自进程启动以来的累积值）。
  if (client instanceof JevClient) client.resetConsecutiveFailures();
  const throttledStart = client instanceof JevClient ? client.throttledCount : 0;
  const docs = collectDocs(materials);
  const deadline = start + Math.max(0, input.deadlineMs);
  const remaining = (): number => deadline - Date.now();

  const perFinding: Record<string, FindingCheck> = {};
  let calls = 0;
  let inputTokens = 0;
  let budgetExceeded = false;
  const cacheSeen = cfg.category?.enabled ? new Set<string>() : undefined;

  try {
    for (const [findingIndex, f] of findings.entries()) {
      const pre = input.precomputed?.get(f.pid);
      if (pre) {
        perFinding[f.pid] = pre;
        calls += pre.calls.length;
        inputTokens += pre.calls.reduce((s, c) => s + c.inputTokens, 0);
        continue;
      }
      if (calls >= cfg.budget.maxCalls || remaining() <= 0) {
        budgetExceeded = true;
        perFinding[f.pid] = makeUncheckedFindingCheck(f, materials);
        continue;
      }
      // 波二修复单 10：把「本轮剩余时间」接进单条 finding 的 signal，防止它的多趟往返
      // （fact 多键 + entail，可能还有 fixPresent）整体超出 deadline。
      const fc = await checkFinding({ f, materials, docs, client, cfg, signal: combinedSignal(input.signal, remaining()),
        ...(cfg.grayEnrich?.enabled || cfg.category?.enabled ? { remainingCalls: () => cfg.budget.maxCalls - calls,
          reservedCalls: findings.slice(findingIndex + 1).filter(next => !input.precomputed?.has(next.pid)).length * (cfg.sampling.fact + cfg.sampling.entail) } : {}),
        ...(cacheSeen ? { cacheSeen } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}) });
      perFinding[f.pid] = fc;
      calls += fc.calls.length;
      inputTokens += fc.calls.reduce((s, c) => s + c.inputTokens, 0);
    }

    if (cfg.premiseRound.enabled && remaining() > 0 && calls < cfg.budget.maxCalls) {
      const results = await premiseRound({
        findings,
        perFinding,
        materials,
        docs,
        cfg,
        workers: input.workers,
        runSessionFn: input.runSessionFn,
        modelRuntime: input.modelRuntime,
        cwd: input.cwd,
        readRoots: input.readRoots,
        loader: input.loader,
        client,
        signal: combinedSignal(input.signal, remaining()),
      });
      for (const [pid, r] of results) {
        const fc = perFinding[pid];
        if (!fc) continue;
        fc.amended = { added: r.added, ...(r.reason !== undefined ? { reason: r.reason } : {}), ms: r.ms,
          ...(gapDiagnostics(cfg) ? { entailBefore: fc.entail.p1, entailAfter: r.entailP2 ?? fc.entail.p1, statusBefore: fc.status } : {}) };
        if (gapDiagnostics(cfg) && r.calls) fc.calls.push(...r.calls);
        // ★PIMOA-DEF-05 复审（2026-09-20）：conditionFlag 必须与 conditionFactCount / 表渲染**同源**
        //（都是 facts + amended.added）。它不依赖 entailP2，故不得嵌在 depend on p2 的分支里——
        // 否则 added 含条件而 p2 缺失时（jevcheck.ts:1167 p 为 null、:1168 catch 吞异常两条路径都可达），
        // 表里列出的条件不会被条件红旗门要求裁决（显示与校验门不同源，DEF-05 的镜像形态）。
        fc.conditionFlag = computeConditionFlag([...fc.facts, ...r.added]);
        // 计费口径与 entail 一致：发起过往返即计一次（slice 存在 = 定位成功并调用了 Jev，未答 p 也算）。
        for (const c of r.added) calls += c.slice !== undefined ? 1 : 0;
        // 波二修复单 12：entail(p2) 调用本身计一次（无论是否解析出 p 值）——此前只在
        // entailP2 有值时才隐式计数（根本没计），totals.calls 会少算补前提阶段的 entail 往返。
        if (r.entailCallMade) calls += 1;
        // ★PIMOA-DEF-07（2026-09-20 徐总选「甲」）：status 必须与 conditionFlag 同源、按并集重算——
        //   它驱动 isAnomalous ⇒ table_handling 必填门。p2 缺失（noul 返回 p=null 或 catch 吞异常，
        //   jevcheck.ts:1167/1168 两条路径）时**沿用旧的 fc.entail.p1**：
        //   ①③两档（含不符前提 / 含待核前提）本就不依赖 p，扫并集后即可正确翻档（修好「该开未开」）；
        //   ②档（前提不足）用同一个旧 p ⇒ 与前一轮同解，不产生意外翻转。
        //   语义 = 「用新事实、沿用旧 entail 分数」。
        //   反向（不该开却开）不可达：allFacts ⊇ fc.facts，非条件「不符」只增不减，故单调。
        const allFactsStatus = [...fc.facts, ...r.added];
        fc.status = synthesizeStatus(
          allFactsStatus,
          r.entailP2 ?? fc.entail.p1,
          allFactsStatus.some((c) => c.kind === "condition"),
          cfg,
        );
        if (r.entailP2 !== undefined) fc.entail.p2 = r.entailP2;
      }
    } else if (cfg.premiseRound.enabled) {
      budgetExceeded = true;
    }

    let duplicates: JevCheckReport["duplicates"] = [];
    let conflicts: JevCheckReport["conflicts"] = [];
    if (remaining() > 0 && calls < cfg.budget.maxCalls) {
      const dc = await dedupeAndConflicts(findings, materials, client, cfg, combinedSignal(input.signal, remaining()));
      duplicates = dc.duplicates;
      conflicts = dc.conflicts;
    } else {
      budgetExceeded = true;
    }
    const oneSidedList = oneSided(findings, materials, { duplicates, conflicts });
    const proposerQuality = computeProposerQuality(findings, perFinding);
    const terminalGaps = gapDiagnostics(cfg) || cfg.factRefDirect?.enabled || cfg.grayEnrich?.enabled || cfg.quote?.enabled || cfg.entailBridge?.enabled
      ? collectTerminalGaps(findings, perFinding, cfg.entailBridge?.enabled) : undefined;
    const batteryGaps = cfg.category?.enabled ? Object.values(perFinding).flatMap(fc => fc.batteryGaps ?? []) : [];
    const chainGaps = cfg.chainEvidenceGate?.enabled ? Object.values(perFinding).flatMap(fc => fc.chainEvidenceGaps ?? []) : [];
    const priorGaps = gapDiagnostics(cfg) ? terminalGaps : terminalGaps?.filter(g =>
      g.kind === "line-anchor-drift" && cfg.factRefDirect?.enabled || g.kind === "gray-refute-suspect" && cfg.grayEnrich?.enabled || g.kind === "quote-ambiguous" && cfg.quote?.enabled
      || g.kind === "entail-low" && cfg.entailBridge?.enabled);
    const gaps = batteryGaps.length || chainGaps.length ? [...(priorGaps ?? []), ...batteryGaps, ...chainGaps] : priorGaps;
    const locAudit: NonNullable<JevCheckReport["locAudit"]> = [];
    // 1% 采样率出处：jev-effectiveness…/batch0-baseline.md §6-2 建议。
    if (gapDiagnostics(cfg)) for (const f of findings) {
      const facts = [...(perFinding[f.pid]?.facts ?? []), ...(perFinding[f.pid]?.amended?.added ?? [])];
      for (const [idx, fact] of facts.entries()) {
        if (!fact.slice || Number.parseInt(sha256(`${f.pid}:${idx}`).slice(0, 8), 16) % 100 !== 0) continue;
        locAudit.push({ id: `${f.pid}:fact${idx}`, slice: fact.slice, expectedAnchor: f.anchor, fact: fact.text });
      }
    }

    const ms = Date.now() - start;
    const throttled = client instanceof JevClient ? client.throttledCount - throttledStart : 0;
    const base: JevCheckReport = {
      enabled: true,
      ...(gaps ? { gaps: { records: gaps, writeCount: gaps.length }, ...(gapDiagnostics(cfg) ? { locAudit } : {}) } : {}),
      ...(cfg.stateExpansion?.enabled ? { closureDropped: Object.values(perFinding).reduce((sum, fc) => sum + (fc.closureDropped ?? 0), 0) } : {}),
      ...(cfg.grayEnrich?.enabled ? { grayEnrichSkipped: Object.values(perFinding).reduce((sum, fc) => sum + fc.facts.filter(fact => fact.grayEnrichSkipped).length, 0) } : {}),
      ...(cfg.category?.enabled ? { batterySkipped: Object.values(perFinding).reduce((sum, fc) => sum + (fc.batterySkipped ?? 0), 0) } : {}),
      ...(cfg.chainEvidenceGate?.enabled ? { chainEvidenceTelemetry: {
        triggered: Object.values(perFinding).reduce((n, fc) => n + (fc.chainEvidence?.length ?? 0), 0),
        present: Object.values(perFinding).reduce((n, fc) => n + (fc.chainEvidence?.filter(x => x.status === "引用在场（机械）").length ?? 0), 0),
        missing: chainGaps.length,
      } } : {}),
      ...(cfg.categoryAutoRoute?.enabled ? { categoryAutoRouteTelemetry: {
        primary: findings.filter(f => f.categoryAutoRouted === "primary").length,
        secondary: findings.filter(f => f.categoryAutoRouted === "secondary").length,
        routed: findings.filter(f => f.categoryAutoRouted !== undefined).length,
      } } : {}),
      ...(cfg.entailBridge?.enabled ? { entailBridgeTelemetry: {
        triggered: findings.filter(f => perFinding[f.pid]?.status === "前提不足").length,
        named: findings.filter(f => perFinding[f.pid]?.status === "前提不足" && missingEntailBridgeEntities(f, perFinding[f.pid]!).length > 0).length,
        missingEntities: findings.reduce((n, f) => n + (perFinding[f.pid]?.status === "前提不足" ? missingEntailBridgeEntities(f, perFinding[f.pid]!).length : 0), 0),
      } } : {}),
      ...(cfg.quote?.enabled ? { quoteTierCounts: Object.values(perFinding).flatMap(fc => fc.facts)
        .reduce((counts, fact) => { if (fact.quoteStatus) counts[fact.quoteStatus] = (counts[fact.quoteStatus] ?? 0) + 1; return counts; },
          {} as NonNullable<JevCheckReport["quoteTierCounts"]>) } : {}),
      perFinding,
      duplicates,
      conflicts,
      oneSided: oneSidedList,
      proposerQuality,
      totals: { calls, inputTokens, ms, tableChars: 0, truncated: false, throttled },
      tableText: "",
    };
    const tableMax = Math.min(cfg.budget.tableMaxChars, JEVCHECK_TABLE_MAX_CHARS);
    const { text, truncated } = renderCheckTable(base, findings, materials, tableMax, gaps, cfg.category?.enabled === true);
    base.tableText = text;
    base.totals = { ...base.totals, tableChars: text.length, truncated };
    const report: JevCheckReport = budgetExceeded
      ? { ...base, skipped: "预算或时限耗尽：部分 finding/步骤未核，已完成部分保留" }
      : base;
    emit({ stage: "jevcheck", phase: "done", calls: report.totals.calls, ms: report.totals.ms });
    return report;
  } catch (err) {
    if (err instanceof JevUnavailable) {
      emit({ stage: "jevcheck", phase: "skipped" });
      return emptyReport(false, `Jev 不可用：${err.message}`);
    }
    // 波二修复单 4：fail-open 收口。设计 §3.5 的 fail-open 不只覆盖「Jev 连不上」，任何 jevcheck
    // 内部异常（比如某处空指针、编排层传错参数）都不该向上抛出去拖垮 verify 主流程——那样一个
    // 核验模块的 bug 就会让整轮审查连 proposer 的发现都拿不到。
    emit({ stage: "jevcheck", phase: "skipped" });
    return emptyReport(false, `jevcheck 内部错误：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * ---------------------------------------------------------------------------
 * 已知限制（波二修复单「只登记不改」三条 + 本波未涉及、仍然成立的既有说明；非自行变通）：
 *
 * 1. `functionBodyAround` 按字符逐个数花括号配平，不识别字符串/注释——字符串字面量或注释里的
 *    `{`/`}` 会参与配平，可能让函数体提前判定「已闭合」。只登记，本波不改（`functionBodyAround`
 *    不在修复单范围内）。
 * 2. `noul(kind, state, n, signal)` 的参数序与设计 §3.5 原文签名不同（原文把 kind 放在别处）。
 *    保留现有代码不改签名——真正需要自定义 instructions 的多键合并场景走 `ask()`；设计文档一侧
 *    由 PiMoa 主代理在波三同步改。
 * 3. `proposerQuality.rejects`（proposer 端 submit_findings 重提次数）固定为 0：这个数据来自
 *    `FindingsState.rejects`，不在 `runJevCheck` 的输入范围内（findings 只是已接受清单）；
 *    orchestrate（波三 b）接线时须自行在 receipt 组装时回填。
 * 4. `locateFact` 签名不带 cwd/readRoots（设计原文如此），故用 rel/abs 直接匹配定位材料，
 *    比 `submit_findings.resolveMaterial` 弱（不支持相对 cwd/readRoot 的写法）；因 jevcheck 阶段
 *    findings 的 path 已经过 submit_findings 校验合格，实践中 rel/abs 直接匹配足够。
 * 5. `JevClient` 请求限流重试耗尽（k>5 仍被拒）抛 `JevThrottled`，在 `ask()` 内当作「该次采样
 *    失败」吞掉继续下一轮采样，不计入 `JevUnavailable` 的连续失败计数——设计原文只说了限流
 *    重试的退避策略，未说明退避耗尽后的处置，此为工程判断。
 * ---------------------------------------------------------------------------
 */
