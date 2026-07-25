/**
 * 会话级检索预算（徐总 2026-07-25）。
 *
 * 背景：单次输出封顶挡不住**多次调用累加**——proposer 自行扫全库时可把对话堆到 60 万 token，
 * 撞爆上游（gemini 100 万上下文尚且吐空正文；MiniMax-M3 / mimo-v2.5-pro 仅 20 万会直接 overflow）
 * → 正文为空 → 2/2 fail-closed、不落盘。
 *
 * 故对**每个会话**的取证输出总量统一记账：`bash_readonly`（沙箱检索）与 `read`（读文件）**共用一本账**，
 * 超预算即拒绝继续取证，并 fail-loud 提示模型立即收敛出结论。
 *
 * 单位换算：按保守 3 字符 ≈ 1 token（中英混合源码）。
 */

/**
 * ★每个会话允许的取证**调用轮数**上限（徐总 2026-07-25）。
 *
 * 为什么轮数本身要限：agent 每调一次工具，都要把**完整对话历史重新发一遍**给模型。
 * 实测 90k 输入下 3 轮工具调用即把单轮 payload 从 99k 顶到 121k token，长 SSE 流随之断裂
 * （`Stream ended without finish_reason`）→ 正文空 → fail-closed。**不是装不下，是传不完。**
 * 字符预算（下方）管"每轮多大"，轮数上限管"发多少轮"，两者缺一不可。
 *
 * **为什么是 5 而不是 15**（U2 极端实测定标，2026-07-25）：拿 PaperGo `assembly.go`（14k token）
 * 做真实 verify，**即使侦查前置已把材料喂到位**，proposer 仍会继续调工具核证，实测
 * `input=251,808 tokens` —— 是原始输入的 **17.8 倍**（每轮重发完整历史所致）。15 轮 × 14k ≈ 210k
 * 正是该量级；换成两个文件（32k）时 15 轮将达 ~480k，必炸。故收到 5：配合 files/recon_query
 * 把材料预先喂足后，5 轮足够做补充核证，且最坏放大控制在 ~5 倍。
 * 对标：Hermes 的 reference_max_iterations 原为 96（灾难性），已同步下调至 15。
 * 注：pi 0.81.1 自身不提供工具轮数上限，故由 PiMoa 在工具层自行实现。
 */
export const SESSION_MAX_TOOL_CALLS = 5;

/** 每个会话允许的取证输出总预算（token）。 */
export const SESSION_TOKEN_BUDGET = 200_000;
/** 字符/token 换算比（保守估，中英混合源码）。 */
export const CHARS_PER_TOKEN = 3;
/** 每个会话允许的取证输出总预算（字符）。 */
export const SESSION_OUTPUT_CHAR_BUDGET = SESSION_TOKEN_BUDGET * CHARS_PER_TOKEN;

/** 一个会话的取证预算账本（`bash_readonly` 与 `read` 共用）。 */
export interface RetrievalBudget {
  /** 已消耗字符数。 */
  usedChars: number;
  /** 已放行的取证调用次数。 */
  calls: number;
}

export function createRetrievalBudget(): RetrievalBudget {
  return { usedChars: 0, calls: 0 };
}

/** 预算是否已用尽（**字符量**或**调用轮数**任一触顶即耗尽）。 */
export function isBudgetExhausted(budget: RetrievalBudget): boolean {
  return budget.usedChars >= SESSION_OUTPUT_CHAR_BUDGET || budget.calls >= SESSION_MAX_TOOL_CALLS;
}

/** 预算耗尽时给模型的拒绝理由（可执行引导：让它立即出结论，而非继续扫）。 */
export function budgetExhaustedReason(budget: RetrievalBudget): string {
  const usedTok = Math.round(budget.usedChars / CHARS_PER_TOKEN);
  const hitCalls = budget.calls >= SESSION_MAX_TOOL_CALLS;
  const which = hitCalls
    ? `取证**轮数**已达上限（${budget.calls} / ${SESSION_MAX_TOOL_CALLS} 次）`
    : `取证**输出量**已达上限（约 ${usedTok} / ${SESSION_TOKEN_BUDGET} token，共 ${budget.calls} 次）`;
  return (
    `${which}。拒绝继续读取/检索——每一次工具调用都会把完整对话历史重发给模型，` +
    "再加只会撑爆上下文、触发上游断流，导致整轮 fail-closed（正文为空、不产出）。" +
    "请**立即基于已获得的证据给出结论**；确有必要时只用更精确的路径/pattern/行范围做最小化查询。"
  );
}

/** 记一次成功取证的用量；返回是否**因本次而**跨过阈值（用于附加收敛提示）。 */
export function chargeBudget(budget: RetrievalBudget, chars: number): boolean {
  const wasExhausted = isBudgetExhausted(budget);
  budget.calls += 1;
  budget.usedChars += chars;
  return !wasExhausted && isBudgetExhausted(budget);
}

/** 跨过阈值时附加到本次结果尾部的收敛提示。 */
export function budgetCrossedNotice(budget: RetrievalBudget): string {
  const usedTok = Math.round(budget.usedChars / CHARS_PER_TOKEN);
  return (
    `\n\n⚠️ [取证预算已达上限：本会话累计约 ${usedTok} / ${SESSION_TOKEN_BUDGET} token、` +
    `${budget.calls} / ${SESSION_MAX_TOOL_CALLS} 轮。**后续读取/检索将被拒绝**——` +
    "请立即基于已有证据给出结论，不要再扫描更多文件。]"
  );
}
