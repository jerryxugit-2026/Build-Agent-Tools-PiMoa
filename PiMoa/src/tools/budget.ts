/**
 * 会话级检索预算（徐总 2026-07-25 首定;2026-08-25 v4 §4 改字符本位并支持 per-call 上限）。
 *
 * 背景：单次输出封顶挡不住**多次调用累加**——proposer 自行扫全库时可把对话堆到几十万 token,
 * 撞爆上游窗口/触发长流断裂 → 正文为空 → 2/2 fail-closed、不落盘。
 * （2026-08-25 订正:原注释以"MiniMax-M3 仅 20 万窗口"为据——M3 现为官方 1M/保底 512K,
 * mimo-v2.5-pro 已不在任何 preset;此账本如今的依据是 v4 §4.2 的统一预算推导:
 * 材料+取证联合 ≤ min(有效窗口) − 输出预留,以及"每轮重发全历史"的传输放大。）
 *
 * 故对**每个会话**的取证输出总量统一记账:`bash_readonly`/`read`/`devkb`/`web_fetch`/`semble`
 * **共用一本账**,超预算即拒绝继续取证,并 fail-loud 提示模型立即收敛出结论。
 *
 * v4 变更:预算改**字符本位**(单一货币,最坏 1 字符=1 token;废除 3:1 换算与材料预算混币——
 * 审查 A1 的"单位不闭合"硬伤)。CHARS_PER_TOKEN 仅保留用于给模型看的 token 近似显示。
 */
import {
  MAX_TOOL_CALLS_HARD_CAP,
  retrievalCharBudget,
  SESSION_MAX_TOOL_CALLS as LIMITS_SESSION_MAX_TOOL_CALLS,
} from "../config/limits.js";

/**
 * ★每个会话允许的取证**调用轮数**缺省上限（徐总 2026-07-25）。
 *
 * 为什么轮数本身要限：agent 每调一次工具，都要把**完整对话历史重新发一遍**给模型。
 * 实测 90k 输入下 3 轮工具调用即把单轮 payload 从 99k 顶到 121k token，长 SSE 流随之断裂
 * （`Stream ended without finish_reason`）→ 正文空 → fail-closed。**不是装不下，是传不完。**
 * 字符预算（下方）管"每轮多大"，轮数上限管"发多少轮"，两者缺一不可。
 *
 * **为什么是 5 而不是 15**（U2 极端实测定标，2026-07-25）：拿 PaperGo `assembly.go`（14k token）
 * 做真实 verify，**即使侦查前置已把材料喂到位**，proposer 仍会继续调工具核证，实测
 * `input=251,808 tokens` —— 是原始输入的 **17.8 倍**（每轮重发完整历史所致）。故收到 5：
 * 配合 files/recon_query 把材料预先喂足后，5 轮足够做补充核证。
 * v4 §4.3:调用方可经 `max_tool_calls` 入参按次放宽,硬顶 MAX_TOOL_CALLS_HARD_CAP(10)。
 */
export const SESSION_MAX_TOOL_CALLS = LIMITS_SESSION_MAX_TOOL_CALLS;

/** 字符/token 换算比(**仅用于给模型看的近似显示**,不再参与任何预算运算)。 */
export const CHARS_PER_TOKEN = 3;
/**
 * 每个会话取证输出总预算的**模块级缺省**(字符本位,limits.ts 真源;v4 前为 600,000=200k token×3)。
 * 取 verify 档(240k,取证最重的模式)——编排层实际总按模式注入 per-session 覆盖(orchestrate
 * sessionBudgetOpts),此缺省只作用于独立使用/测试等未注入场景,取大值不误伤。
 * ⚠️ 纪律(P3 复审 F7):**新工具不得直接 import 本常量当硬上限**——必须经 sessionBudget 实例
 * (budgetMaxChars(budget))取额度,否则 synthesize 会话(120k)会被放大到 verify 档(240k)。
 */
export const SESSION_OUTPUT_CHAR_BUDGET = retrievalCharBudget("verify");
/** 兼容显示用:预算的 token 近似值。 */
export const SESSION_TOKEN_BUDGET = Math.round(SESSION_OUTPUT_CHAR_BUDGET / CHARS_PER_TOKEN);

/**
 * 预算耗尽的触发类别(与 budgetExhaustedReason 三个分支一一对应)。
 * 2026-09-06 语义修订:账本**不再粘滞记首次拒绝**。此前 `budget.exhaustedBy` 在第一次拒绝时写死、
 * 之后 settle 退还额度也不清除——并行 tool call 各按单次上限 120k 预扣,两路就把 verify 档 240k 账面锁满,
 * 第三路被拒即永久标"耗尽",实际结算用量常不足上限 20%(实证 616/240000),下游"耗尽即不采信"规则把这类
 * 回执整份判废(DeepSeek 爱并行发多个 read/rg,21% 回执中招;MiniMax 几乎不调工具故无感)。
 * 现在:被拒只记 `rejections` 计数 + `lastRejection`(类别+当次单次上限);快照/trace 的 `exhaustedBy`
 * 由 **结算后**的账面现算(settledExhaustedBy):轮数真到顶 / 已用真满 / 余量真装不下最近被拒那片——三者皆否即 null。
 */
export type BudgetExhaustedBy = "calls" | "chars" | "reserve";

/**
 * 一个会话的取证预算账本（五个取证工具共用）。
 *
 * ★原子预扣协议(提速方案 §4.2,2026-09-04):pi 的 agent-loop 会**并行**执行一条 assistant 消息里的多个
 * 工具调用(refs/pi/packages/agent/src/agent-loop.ts:489-553),每个调用同步跑到第一个 await 才让出。
 * 旧的「isBudgetExhausted 检查 → await 执行 → chargeBudget 记账」在这种交错下 N 个调用全在
 * usedChars=0/calls=0 时过闸(最坏 10×TOOL_SLICE 120k = 120 万字符,五倍于 verify 档 24 万)。
 * 现在取证工具一律走 `reserveBudget`(**同步**预扣 calls+1、reservedChars+cap)→ await 执行 →
 * `settleBudget`(按实际字符换掉预扣)/`releaseBudget`(未产出内容,退还)+ finally 兜底 settle(0),
 * 于是后续并行调用在 reserve 时就能看到在途预扣,超额的在 reserve 阶段即拒。
 */
export interface RetrievalBudget {
  /** 已消耗字符数(已 settle 的实际用量)。 */
  usedChars: number;
  /** 已放行的取证调用次数(reserve 时即 +1;release 时退回)。 */
  calls: number;
  /**
   * 在途预扣字符数(已 reserve 未 settle 的单次上限之和)——并行调用互见额度的关键字段。
   * 可选仅为兼容手写字面量 `{ usedChars, calls }`;读取一律经 budgetReservedChars(缺省 0)。
   */
  reservedChars?: number;
  /** 本会话字符上限(缺省 SESSION_OUTPUT_CHAR_BUDGET;由编排层按模式注入)。 */
  maxChars?: number;
  /** 本会话轮数上限(缺省 SESSION_MAX_TOOL_CALLS;来自 max_tool_calls 入参,已被硬顶钳制)。 */
  maxCalls?: number;
  /** 被拒的 reserve 次数(含并行互挤时的瞬时拒绝);纯观测,不参与判闸。 */
  rejections?: number;
  /** 最近一次被拒的类别与当次单次上限(供 settledExhaustedBy 判"余量是否真装不下");纯观测。 */
  lastRejection?: { kind: BudgetExhaustedBy; cap: number };
}

export function createRetrievalBudget(opts?: {
  maxChars?: number;
  maxCalls?: number;
}): RetrievalBudget {
  const budget: RetrievalBudget = { usedChars: 0, calls: 0, reservedChars: 0 };
  if (opts?.maxChars !== undefined && Number.isFinite(opts.maxChars) && opts.maxChars > 0) {
    budget.maxChars = Math.floor(opts.maxChars);
  }
  if (opts?.maxCalls !== undefined && Number.isFinite(opts.maxCalls) && opts.maxCalls > 0) {
    // 硬顶钳制(v4 §4.3):入参再大也不越过 MAX_TOOL_CALLS_HARD_CAP。
    budget.maxCalls = Math.min(Math.floor(opts.maxCalls), MAX_TOOL_CALLS_HARD_CAP);
  }
  return budget;
}

/** 本账本的字符上限(实例覆盖 > 全局缺省)。 */
export function budgetMaxChars(budget: RetrievalBudget): number {
  return budget.maxChars ?? SESSION_OUTPUT_CHAR_BUDGET;
}
/** 本账本的轮数上限(实例覆盖 > 全局缺省)。 */
export function budgetMaxCalls(budget: RetrievalBudget): number {
  return budget.maxCalls ?? SESSION_MAX_TOOL_CALLS;
}
/** 在途预扣字符数(字段缺省视为 0)。 */
export function budgetReservedChars(budget: RetrievalBudget): number {
  const r = budget.reservedChars;
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : 0;
}

/**
 * 判定本次(单次上限 nextCallCap)会撞哪种上限;null=放行。与 isBudgetExhausted 严格同真值
 * (isBudgetExhausted(b, cap) ⇔ budgetExhaustedKind(b, cap) !== null),三类与 budgetExhaustedReason 分支一一对应:
 *   - "calls":轮数已达上限(calls 含在途 reserve 的调用);
 *   - "chars":已用 + 在途预扣 ≥ 字符上限(账面已满);
 *   - "reserve":账面未满,但余量装不下本次单次上限(P2 F5 放行前预扣;并行调用互挤时多为此类)。
 */
export function budgetExhaustedKind(budget: RetrievalBudget, nextCallCap = 0): BudgetExhaustedBy | null {
  if (budget.calls >= budgetMaxCalls(budget)) return "calls";
  const maxChars = budgetMaxChars(budget);
  const committed = budget.usedChars + budgetReservedChars(budget);
  if (committed >= maxChars) return "chars";
  if (nextCallCap > 0 && committed + nextCallCap > maxChars) return "reserve";
  return null;
}

/**
 * 预算是否已用尽（**字符量**或**调用轮数**任一触顶即耗尽）。
 * P2 静态审查 F5:传 `nextCallCap`(本次调用的单次输出上限)可做**放行前预扣**——
 * 剩余额度装不下最坏一整片就拒,堵"事后记账"下单轮多工具各自查旧值、累计冲破上限的斜坡。
 * 不传(=0)保持旧语义(已用 ≥ 上限)。
 * §4.2:字符侧把**在途预扣 reservedChars 一并计入**(usedChars + reservedChars + nextCallCap > maxChars)。
 */
export function isBudgetExhausted(budget: RetrievalBudget, nextCallCap = 0): boolean {
  return budgetExhaustedKind(budget, nextCallCap) !== null;
}

/** 预算耗尽时给模型的拒绝理由（可执行引导：让它立即出结论，而非继续扫）。 */
export function budgetExhaustedReason(budget: RetrievalBudget, nextCallCap = 0): string {
  const maxChars = budgetMaxChars(budget);
  const maxCalls = budgetMaxCalls(budget);
  const reserved = budgetReservedChars(budget);
  const usedTok = Math.round(budget.usedChars / CHARS_PER_TOKEN);
  const maxTok = Math.round(maxChars / CHARS_PER_TOKEN);
  const kind = budgetExhaustedKind(budget, nextCallCap) ?? "chars";
  const inflight = reserved > 0 ? `,另有并行调用在途预扣 ${reserved} 字符` : "";
  const which =
    kind === "calls"
      ? `取证**轮数**已达上限（${budget.calls} / ${maxCalls} 次${reserved > 0 ? ",含并行在途调用" : ""}）`
      : kind === "reserve"
        ? `取证预算余量不足（已用 ${budget.usedChars} / ${maxChars} 字符${inflight},余量装不下本工具单次上限 ${nextCallCap} 字符——放行前预扣,防累计/并行冲破上限）`
        : `取证**输出量**已达上限（${budget.usedChars} / ${maxChars} 字符${inflight},约 ${usedTok} / ${maxTok} token,共 ${budget.calls} 次）`;
  return (
    `${which}。拒绝继续读取/检索——每一次工具调用都会把完整对话历史重发给模型，` +
    "再加只会撑爆上下文、触发上游断流，导致整轮 fail-closed（正文为空、不产出）。" +
    "请**立即基于已获得的证据给出结论**；确有必要时只用更精确的路径/pattern/行范围做最小化查询。"
  );
}

// ---- §4.2 原子预扣协议:reserve(同步) → await 执行 → settle / release(finally 兜底) ----

/** 一次预扣的票据。closed 是幂等保护:显式 settle/release 与 finally 兜底双路都会调,只第一次生效。 */
export interface BudgetTicket {
  /** 预扣的字符数(= 该工具单次输出上限)。 */
  readonly cap: number;
  /** 已 settle/release。 */
  closed: boolean;
}

export type ReserveResult =
  | { ok: true; ticket: BudgetTicket }
  | { ok: false; reason: string; exhaustedBy: BudgetExhaustedBy };

/**
 * ★同步预扣(无 await):按 cap 判闸;通过则**立即** calls+1、reservedChars+cap 记入账本,
 * 使同一 tick 内后续并行调用看到在途额度。拒绝则记 rejections+1 与 lastRejection(不再粘滞首次类别),并返回给模型的拒绝文案。
 * 调用方拿到 ticket 后必须在 finally 里 settleBudget(…, 0) 兜底,否则预扣悬挂=后续永久少一片额度。
 */
export function reserveBudget(budget: RetrievalBudget, cap: number): ReserveResult {
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  const kind = budgetExhaustedKind(budget, safeCap);
  if (kind !== null) {
    budget.rejections = (budget.rejections ?? 0) + 1;
    budget.lastRejection = { kind, cap: safeCap };
    return { ok: false, reason: budgetExhaustedReason(budget, safeCap), exhaustedBy: kind };
  }
  budget.calls += 1;
  budget.reservedChars = budgetReservedChars(budget) + safeCap;
  return { ok: true, ticket: { cap: safeCap, closed: false } };
}

/** 仅按**已结算量**判耗尽(不含在途预扣):settle 后给模型的收敛提示只能基于已定事实。 */
function isSettledExhausted(budget: RetrievalBudget): boolean {
  return budget.usedChars >= budgetMaxChars(budget) || budget.calls >= budgetMaxCalls(budget);
}

/**
 * 结算:把票据的预扣 cap 换成实际字符数(usedChars += actualChars; reservedChars -= cap),轮数保留。
 * 工具失败/抛错也必须结算(actualChars=0)——放在 finally 里;重复结算幂等(返回 false)。
 * 返回值 = **本次 settle 后**是否已跨过阈值(按已结算量判;给票据的调用在 reserve 时必未耗尽,
 * 故"跨过"等价于 settle 后已耗尽),true 时调用方把 budgetCrossedNotice 附到结果尾部。
 */
export function settleBudget(budget: RetrievalBudget, ticket: BudgetTicket, actualChars: number): boolean {
  if (ticket.closed) return false;
  ticket.closed = true;
  budget.reservedChars = Math.max(0, budgetReservedChars(budget) - ticket.cap);
  const used = Number.isFinite(actualChars) && actualChars > 0 ? Math.floor(actualChars) : 0;
  budget.usedChars += used;
  return isSettledExhausted(budget);
}

/**
 * 退还:本次调用**没有产出内容**(策略/jail/入参校验拒、新鲜度门拦截、取页失败等,与改造前"不记账"口径一致)
 * → 退回预扣 cap **与轮数**。仅用于预扣后未真正消耗取证额度的路径;真执行过的失败仍走 settle(…, 0)。
 */
export function releaseBudget(budget: RetrievalBudget, ticket: BudgetTicket): void {
  if (ticket.closed) return;
  ticket.closed = true;
  budget.reservedChars = Math.max(0, budgetReservedChars(budget) - ticket.cap);
  budget.calls = Math.max(0, budget.calls - 1);
}

/**
 * @deprecated §4.2 起取证工具改用 reserveBudget → settleBudget(并行安全)。本函数保留兼容旧调用方/测试:
 * 语义不变——无闸、直接记一次成功取证的用量;返回是否**因本次而**跨过阈值。
 * 非原子:并行调用下会漏闸,新代码禁用。
 */
export function chargeBudget(budget: RetrievalBudget, chars: number): boolean {
  const wasExhausted = isBudgetExhausted(budget);
  budget.calls += 1;
  budget.usedChars += chars;
  return !wasExhausted && isBudgetExhausted(budget);
}

/** 跨过阈值时附加到本次结果尾部的收敛提示。 */
export function budgetCrossedNotice(budget: RetrievalBudget): string {
  const usedTok = Math.round(budget.usedChars / CHARS_PER_TOKEN);
  const maxTok = Math.round(budgetMaxChars(budget) / CHARS_PER_TOKEN);
  return (
    `\n\n⚠️ [取证预算已达上限：本会话累计约 ${usedTok} / ${maxTok} token、` +
    `${budget.calls} / ${budgetMaxCalls(budget)} 轮。**后续读取/检索将被拒绝**——` +
    "请立即基于已有证据给出结论，不要再扫描更多文件。]"
  );
}

/**
 * **结算后**是否仍耗尽、以及耗尽类别(快照/trace 的 exhaustedBy 真源;2026-09-06)。只看已结算账面,不看在途预扣:
 *   - "calls":已放行轮数 ≥ 上限(release 会退回,故按当前值判);
 *   - "chars":已用字符 ≥ 上限;
 *   - "reserve":最近一次被拒时的单次上限,连已用字符一起仍装不下(余量**真**不够,不是并行瞬时互挤);
 *   - undefined:未耗尽——即使中途被拒过(rejections>0),只要结算后余量够,就不算耗尽。
 */
export function settledExhaustedBy(budget: RetrievalBudget): BudgetExhaustedBy | undefined {
  if (budget.calls >= budgetMaxCalls(budget)) return "calls";
  const maxChars = budgetMaxChars(budget);
  if (budget.usedChars >= maxChars) return "chars";
  const lr = budget.lastRejection;
  if (lr && lr.cap > 0 && budget.usedChars + lr.cap > maxChars) return "reserve";
  return undefined;
}

/**
 * 账本快照(纯读,不改账;供 receipt 落盘)。maxChars/maxCalls 为**生效值**(实例覆盖 > 全局缺省)。
 * exhaustedBy = settledExhaustedBy(结算后现算,未耗尽不带键);rejections/lastRejectedBy 为观测副信号。
 */
export interface BudgetSnapshot {
  calls: number;
  usedChars: number;
  reservedChars: number;
  maxChars: number;
  maxCalls: number;
  exhaustedBy?: BudgetExhaustedBy;
  rejections: number;
  lastRejectedBy?: BudgetExhaustedBy;
}
export function budgetSnapshot(budget: RetrievalBudget): BudgetSnapshot {
  const exhaustedBy = settledExhaustedBy(budget);
  return {
    calls: budget.calls,
    usedChars: budget.usedChars,
    reservedChars: budgetReservedChars(budget),
    maxChars: budgetMaxChars(budget),
    maxCalls: budgetMaxCalls(budget),
    ...(exhaustedBy !== undefined ? { exhaustedBy } : {}),
    rejections: budget.rejections ?? 0,
    ...(budget.lastRejection ? { lastRejectedBy: budget.lastRejection.kind } : {}),
  };
}
