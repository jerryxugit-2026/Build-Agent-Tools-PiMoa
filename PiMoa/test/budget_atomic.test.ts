/**
 * §4.2 预算预扣原子化（提速方案 2026-09-04）：reserve(同步) → await → settle/release(finally 兜底)。
 *
 * 被堵的洞：pi agent-loop 并行执行一条消息里的多个工具调用，每个调用同步跑到第一个 await 才让出；
 * 旧「isBudgetExhausted 检查 → await → chargeBudget 记账」让 N 个调用全在 usedChars=0/calls=0 时过闸。
 * 本文件用「返回 pending Promise 的假执行函数」把并行交错钉死，再用真 bash_readonly 8 路并行复现。
 *
 * 运行：node --import tsx --test test/budget_atomic.test.ts
 */
import assert from "node:assert/strict";
import {
  budgetExhaustedKind,
  budgetReservedChars,
  budgetSnapshot,
  chargeBudget,
  createRetrievalBudget,
  isBudgetExhausted,
  releaseBudget,
  reserveBudget,
  settleBudget,
  SESSION_MAX_TOOL_CALLS,
  type BudgetTicket,
  type RetrievalBudget,
} from "../src/tools/budget.ts";
import { TOOL_SLICE_CHARS } from "../src/config/limits.ts";
import { createBashReadonlyTool } from "../src/tools/bash_readonly.ts";
import { createReadTool } from "../src/tools/read_budgeted.ts";

function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  console.log(`  ✅ ${msg}`);
}

/** 一个手动放行的闸：所有并行调用都 await 同一个 pending Promise，直到测试显式 release。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeOutcome =
  | { granted: true; crossed: boolean; ticket: BudgetTicket }
  | { granted: false; reason: string; exhaustedBy: string };

/**
 * 假取证工具：与真工具同一骨架——同步 reserve → await 外部 pending → settle(实际字符)，finally 兜底 settle(0)。
 * pending 解析出的数字 = 本次实际字符数。
 */
async function fakeTool(budget: RetrievalBudget, cap: number, pending: Promise<number>): Promise<FakeOutcome> {
  const r = reserveBudget(budget, cap);
  if (!r.ok) return { granted: false, reason: r.reason, exhaustedBy: r.exhaustedBy };
  const ticket = r.ticket;
  try {
    const actual = await pending;
    const crossed = settleBudget(budget, ticket, actual);
    return { granted: true, crossed, ticket };
  } finally {
    settleBudget(budget, ticket, 0);
  }
}

console.log("── 1) 8 路并行 × 单次上限 cap：只有预算内的拿到 ticket，其余在 reserve 阶段被拒 ──");
await (async () => {
  const CAP = 1_000;
  // 字符上限 3.5×cap：3 个能预扣，第 4 个起「账面未满但余量装不下单次上限」→ exhaustedBy="reserve"。
  const budget = createRetrievalBudget({ maxChars: Math.floor(CAP * 3.5), maxCalls: 10 });
  const gate = deferred<number>();
  const inflight = Array.from({ length: 8 }, () => fakeTool(budget, CAP, gate.promise));

  // 此刻 8 个调用都已同步跑过 reserve、停在 await 上，没有任何一个 settle。
  assert.equal(budget.calls, 3, `并行 8 路 reserve 后 calls 应=3(预算内数量),实际 ${budget.calls}`);
  assert.equal(budgetReservedChars(budget), 3 * CAP, "在途预扣 = 3×cap");
  assert.equal(budget.usedChars, 0, "尚无 settle,usedChars 仍为 0");
  assert.equal(budget.lastRejection?.kind, "reserve", "最近一次拒绝的类别记为 reserve(账面未满但余量装不下单次上限)");
  assert.equal(budget.rejections, 5, "8 路里 5 路被拒 → rejections=5");
  ok(true, "并行 8 路：reserve 阶段即只放行 3 路（calls=3、reservedChars=3×cap、usedChars=0）——旧实现此处会 8 路全过闸");
  ok(isBudgetExhausted(budget, CAP), "isBudgetExhausted 把在途预扣计入：usedChars(0)+reservedChars(3cap)+cap > maxChars → 已耗尽");

  gate.resolve(100); // 每路实际只产出 100 字符
  const results = await Promise.all(inflight);
  const granted = results.filter((r) => r.granted);
  const rejected = results.filter((r) => !r.granted) as Extract<FakeOutcome, { granted: false }>[];
  assert.equal(granted.length, 3, `拿到 ticket 的数量应=3,实际 ${granted.length}`);
  assert.equal(rejected.length, 5, `被拒数量应=5,实际 ${rejected.length}`);
  ok(rejected.every((r) => r.exhaustedBy === "reserve"), "5 路被拒的 exhaustedBy 全为 reserve");
  ok(
    rejected.every((r) => /余量不足/.test(r.reason) && /在途预扣/.test(r.reason)),
    "拒绝文案仍走 budgetExhaustedReason 的「余量不足」分支,且写明并行在途预扣量",
  );
  assert.equal(budgetReservedChars(budget), 0, "全部 settle 后 reservedChars 归零");
  assert.equal(budget.usedChars, 300, "settle 把预扣 cap 换成实际字符：3×100=300");
  assert.equal(budget.calls, 3, "轮数只记真正放行的 3 次");
  ok(granted.every((r) => r.crossed === false), "settle 后未跨阈值(300 < 3500,calls 3 < 10) → 不附收敛提示");
  ok(true, "settle 后账本：usedChars=300、reservedChars=0、calls=3");
  // ★2026-09-06 语义:并行互挤的瞬时拒绝不粘滞——结算后余量够(300+1000 ≤ 3500)即 exhaustedBy 不带键。
  const snapAfter = budgetSnapshot(budget);
  assert.equal(snapAfter.exhaustedBy, undefined, "结算后余量够 → exhaustedBy 不再粘滞为 reserve");
  assert.equal(snapAfter.rejections, 5);
  assert.equal(snapAfter.lastRejectedBy, "reserve");
  ok(true, "快照:exhaustedBy=undefined(未耗尽)、rejections=5、lastRejectedBy=reserve——被挤过但没耗尽,如实分开记");
  // 预扣释放后,后续串行调用应能重新放行(余量 3200 ≥ cap)。
  const again = reserveBudget(budget, CAP);
  ok(again.ok, "settle 释放在途额度后,新调用按真实用量重新过闸(不会被幽灵预扣卡死)");
  if (again.ok) settleBudget(budget, again.ticket, 0);
})();

console.log("── 2) 8 路并行撞轮数上限（缺省 5）：exhaustedBy=calls ──");
await (async () => {
  const budget = createRetrievalBudget(); // 缺省:maxCalls=5, maxChars=240k
  assert.equal(SESSION_MAX_TOOL_CALLS, 5);
  const gate = deferred<number>();
  const inflight = Array.from({ length: 8 }, () => fakeTool(budget, 1_000, gate.promise));
  assert.equal(budget.calls, 5, `reserve 阶段 calls 应钉在 5,实际 ${budget.calls}`);
  assert.equal(budget.lastRejection?.kind, "calls");
  assert.equal(budgetSnapshot(budget).exhaustedBy, "calls", "轮数真到顶:结算前后快照都判 calls");
  gate.resolve(10);
  const results = await Promise.all(inflight);
  const rejected = results.filter((r) => !r.granted) as Extract<FakeOutcome, { granted: false }>[];
  assert.equal(rejected.length, 3);
  ok(rejected.every((r) => r.exhaustedBy === "calls" && /轮数/.test(r.reason)), "8 路并行只放 5 路,3 路被拒且 exhaustedBy=calls、文案说明是轮数");
  const granted = results.filter((r) => r.granted) as Extract<FakeOutcome, { granted: true }>[];
  ok(granted.every((r) => r.crossed === true), "settle 后 calls=5 ≥ 上限 → 每路 settle 都判「已跨阈值」(按已结算量,给模型收敛提示)");
  assert.equal(budgetReservedChars(budget), 0);
  assert.equal(budget.calls, 5);
})();

console.log("── 3) 失败路径：抛错 → finally settle(0) 预扣归零；无内容拒绝 → release 退还轮数 ──");
await (async () => {
  const budget = createRetrievalBudget({ maxChars: 10_000, maxCalls: 5 });
  const gate = deferred<number>();
  const p = fakeTool(budget, 4_000, gate.promise);
  assert.equal(budgetReservedChars(budget), 4_000);
  gate.reject(new Error("boom"));
  await assert.rejects(p, /boom/);
  assert.equal(budgetReservedChars(budget), 0, "抛错后 finally settle(0):reservedChars 归零");
  assert.equal(budget.usedChars, 0, "抛错不记字符");
  assert.equal(budget.calls, 1, "抛错的调用确实发生过,轮数保留(settle 不退轮数)");
  ok(true, "抛错路径：finally settle(0) → reservedChars=0、usedChars=0、calls=1");

  // release：策略/入参拒等"没产出内容"的路径,退还预扣与轮数(与改造前不记账口径一致)。
  const r = reserveBudget(budget, 4_000);
  assert.ok(r.ok);
  if (r.ok) {
    releaseBudget(budget, r.ticket);
    assert.equal(budgetReservedChars(budget), 0);
    assert.equal(budget.calls, 1, "release 退回轮数(回到抛错那一次)");
    // 幂等:同一票据再 settle/release 不重复扣减。
    settleBudget(budget, r.ticket, 999);
    releaseBudget(budget, r.ticket);
    assert.equal(budget.usedChars, 0, "已关闭票据再 settle 不记字符(幂等)");
    assert.equal(budget.calls, 1, "已关闭票据再 release 不再退轮数(幂等)");
    assert.equal(budgetReservedChars(budget), 0, "reservedChars 不会被扣成负数");
  }
  ok(true, "release 退还预扣+轮数；settle/release 对同一票据幂等,reservedChars 永不为负");
})();

console.log("── 4) exhaustedBy 三类各自触发：calls / chars / reserve；账本记 rejections+lastRejection,快照按结算后现算 ──");
{
  // calls
  const b1 = createRetrievalBudget({ maxCalls: 2, maxChars: 100_000 });
  const t1 = reserveBudget(b1, 10);
  const t2 = reserveBudget(b1, 10);
  assert.ok(t1.ok && t2.ok);
  const t3 = reserveBudget(b1, 10);
  assert.ok(!t3.ok && t3.exhaustedBy === "calls" && /轮数/.test(t3.reason));
  assert.equal(b1.lastRejection?.kind, "calls");
  assert.equal(budgetSnapshot(b1).exhaustedBy, "calls");
  ok(true, "轮数上限(2)触发 → exhaustedBy=calls");

  // chars:账面已满(usedChars ≥ maxChars)
  const b2 = createRetrievalBudget({ maxChars: 1_000 });
  b2.usedChars = 1_000;
  const r2 = reserveBudget(b2, 100);
  assert.ok(!r2.ok && r2.exhaustedBy === "chars" && /输出量/.test(r2.reason));
  assert.equal(b2.lastRejection?.kind, "chars");
  assert.equal(budgetSnapshot(b2).exhaustedBy, "chars");
  ok(true, "字符上限已满(1000/1000)触发 → exhaustedBy=chars");

  // reserve:账面未满但余量装不下单次上限(F5 预扣拒)
  const b3 = createRetrievalBudget({ maxChars: 1_000 });
  b3.usedChars = 900;
  const r3 = reserveBudget(b3, 200);
  assert.ok(!r3.ok && r3.exhaustedBy === "reserve" && /余量不足/.test(r3.reason));
  assert.equal(b3.lastRejection?.kind, "reserve");
  assert.equal(budgetSnapshot(b3).exhaustedBy, "reserve", "结算后 900+200 > 1000:余量真装不下 → reserve");
  ok(true, "余量 100 装不下单次上限 200 → exhaustedBy=reserve");

  // 不粘滞:b3 随后撞 chars,lastRejection 跟着变 chars,快照按结算后账面判 chars。
  b3.usedChars = 1_000;
  const r3b = reserveBudget(b3, 200);
  assert.ok(!r3b.ok && r3b.exhaustedBy === "chars");
  assert.equal(b3.lastRejection?.kind, "chars");
  assert.equal(b3.rejections, 2);
  assert.equal(budgetSnapshot(b3).exhaustedBy, "chars");
  ok(true, "exhaustedBy 不再粘滞首次:lastRejection 随最近一次拒绝更新,快照按结算后账面判");

  // 被挤过但结算后余量够:并行瞬时拒绝(在途预扣撑满)→ 全部 settle 成小量 → 快照不算耗尽。
  const b5 = createRetrievalBudget({ maxChars: 1_000, maxCalls: 10 });
  b5.reservedChars = 1_000; // 模拟并行在途预扣撑满账面
  const r5 = reserveBudget(b5, 100);
  assert.ok(!r5.ok && r5.exhaustedBy === "chars");
  b5.reservedChars = 0; b5.usedChars = 50; // 在途全部结算成 50 字符
  const snap5 = budgetSnapshot(b5);
  assert.equal(snap5.exhaustedBy, undefined, "结算后 50+100 ≤ 1000 → 不算耗尽");
  assert.equal(snap5.rejections, 1);
  assert.equal(snap5.lastRejectedBy, "chars");
  ok(true, "并行瞬时拒绝后结算余量够:exhaustedBy=undefined、rejections=1、lastRejectedBy=chars(修 DeepSeek 616/240000 被标耗尽)");

  // 在途预扣也计入 chars 判定
  const b4 = createRetrievalBudget({ maxChars: 1_000 });
  b4.reservedChars = 1_000;
  assert.equal(budgetExhaustedKind(b4, 100), "chars");
  assert.equal(isBudgetExhausted(b4), true, "usedChars=0 但 reservedChars=1000 → 已耗尽");
  ok(true, "isBudgetExhausted/budgetExhaustedKind 把 reservedChars 一并计入");

  // 手写字面量(无 reservedChars 字段)兼容:与 web_fetch.test.ts 的用法一致。
  const literal: RetrievalBudget = { usedChars: 0, calls: SESSION_MAX_TOOL_CALLS };
  assert.equal(budgetReservedChars(literal), 0);
  assert.equal(budgetExhaustedKind(literal, 10), "calls");
  ok(true, "缺 reservedChars 字段的旧字面量按 0 处理(兼容既有测试/调用方)");
}

console.log("── 5) settle 的「跨阈值」语义 = 本次 settle 后按已结算量判，不受他人在途预扣干扰 ──");
{
  const b = createRetrievalBudget({ maxChars: 2_000, maxCalls: 10 });
  const a = reserveBudget(b, 1_000);
  const c = reserveBudget(b, 1_000);
  assert.ok(a.ok && c.ok);
  assert.equal(settleBudget(b, a.ticket, 100), false, "A settle 后 usedChars=100,虽有 C 在途 1000 也不算跨阈值");
  assert.equal(settleBudget(b, c.ticket, 1_900), true, "C settle 后 usedChars=2000 ≥ 上限 → 跨阈值");
  ok(true, "跨阈值只看已结算量(usedChars/calls),在途预扣不触发误报");

  const b2 = createRetrievalBudget({ maxCalls: 2, maxChars: 100_000 });
  const x = reserveBudget(b2, 10);
  assert.ok(x.ok && settleBudget(b2, x.ticket, 5) === false);
  const y = reserveBudget(b2, 10);
  assert.ok(y.ok && settleBudget(b2, y.ticket, 5) === true);
  ok(true, "第 2 次 settle 使 calls 达上限 2 → 跨阈值(与旧 chargeBudget 的「因本次而跨过」等价)");
}

console.log("── 6) budgetSnapshot 纯读 + chargeBudget 兼容 ──");
{
  const b = createRetrievalBudget({ maxChars: 5_000, maxCalls: 3 });
  const r = reserveBudget(b, 1_000);
  assert.ok(r.ok);
  const snap = budgetSnapshot(b);
  assert.deepEqual(snap, { calls: 1, usedChars: 0, reservedChars: 1_000, maxChars: 5_000, maxCalls: 3, rejections: 0 });
  assert.equal(b.calls, 1, "snapshot 不改账");
  if (r.ok) settleBudget(b, r.ticket, 200);
  reserveBudget(b, 10_000); // 必拒(reserve)
  const snap2 = budgetSnapshot(b);
  assert.deepEqual(snap2, { calls: 1, usedChars: 200, reservedChars: 0, maxChars: 5_000, maxCalls: 3, exhaustedBy: "reserve", rejections: 1, lastRejectedBy: "reserve" });
  ok(true, "budgetSnapshot 返回 {calls, usedChars, reservedChars, maxChars(生效值), maxCalls(生效值), exhaustedBy?, rejections, lastRejectedBy?}(200+10000 > 5000 余量真不够 → reserve)");

  const legacy = createRetrievalBudget({ maxCalls: 1 });
  assert.equal(chargeBudget(legacy, 10), true, "chargeBudget(deprecated) 语义不变:因本次跨过轮数上限返回 true");
  assert.equal(legacy.calls, 1);
  assert.equal(legacy.usedChars, 10);
  ok(true, "chargeBudget 保留兼容(仅旧调用方/测试;新工具一律 reserve/settle)");
}

console.log("── 7) 真工具：8 路并行 bash_readonly（沙箱内 echo）只放行预算内数量 ──");
await (async () => {
  // 字符上限 3.5×TOOL_SLICE(120k):按单次上限预扣只能放 3 路;轮数上限取硬顶 10 以免先撞轮数。
  const budget = createRetrievalBudget({ maxChars: Math.floor(TOOL_SLICE_CHARS * 3.5), maxCalls: 10 });
  const tool: any = createBashReadonlyTool(budget);
  const ctx = { cwd: process.cwd() };
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => tool.execute(`par${i}`, { command: `echo parallel-${i}` }, undefined, undefined, ctx)),
  );
  const passed = results.filter((r: any) => r.isError !== true);
  const rejected = results.filter((r: any) => r.isError === true);
  assert.equal(passed.length, 3, `8 路并行 bash_readonly 应只放行 3 路,实际 ${passed.length}`);
  assert.equal(rejected.length, 5, `应拒 5 路,实际 ${rejected.length}`);
  ok(
    rejected.every((r: any) => /取证预算耗尽/.test(r.content?.[0]?.text ?? "") && /余量不足/.test(r.content?.[0]?.text ?? "")),
    "5 路被拒:REJECTED（取证预算耗尽）+ 余量不足文案",
  );
  ok(passed.every((r: any) => /parallel-\d/.test(r.content?.[0]?.text ?? "")), "3 路放行的确实拿到了 echo 输出");
  assert.equal(budget.calls, 3, `轮数只记放行的 3 次,实际 ${budget.calls}`);
  assert.equal(budgetReservedChars(budget), 0, "全部结束后 reservedChars 归零");
  assert.ok(budget.usedChars > 0 && budget.usedChars < 3 * TOOL_SLICE_CHARS, `usedChars 按实际输出记(${budget.usedChars})而非 3×cap`);
  assert.equal(budget.lastRejection?.kind, "reserve");
  assert.equal(budget.rejections, 5);
  assert.equal(budgetSnapshot(budget).exhaustedBy, undefined, "结算后 usedChars 很小 + 120k ≤ 420k → 不算耗尽(旧实现此处粘滞 reserve)");
  ok(true, `真 bash_readonly 8 路并行:放行 3 / 拒 5,calls=3,usedChars=${budget.usedChars},reservedChars=0,rejections=5,结算后 exhaustedBy=null`);
  ok(rejected.every((r: any) => r.details?.budgetLimitChars === Math.floor(TOOL_SLICE_CHARS * 3.5)), "details.budgetLimitChars 报的是本账本生效上限(非模块缺省)");
})();

console.log("── 9) read 按文件实际大小预扣(2026-09-06)：小文件并行多路不再被 120k 单次上限互挤 ──");
await (async () => {
  const { statSync } = await import("node:fs");
  const size = statSync("package.json").size; // 几百字节
  assert.ok(size < 10_000 && size > 0);
  // 账本只有 4×size 余量(远小于 120k):旧实现每路预扣 120k → 第 1 路就被 reserve 拒;新实现按文件大小预扣 → 3 路并行全放行,
  // 且结算后 3×size < 4×size 不算耗尽。
  const budget = createRetrievalBudget({ maxChars: size * 4, maxCalls: 10 });
  const tool: any = createReadTool(budget);
  const ctx = { cwd: process.cwd() };
  const results = await Promise.all(Array.from({ length: 3 }, (_, i) => tool.execute(`rd${i}`, { path: "package.json" }, undefined, undefined, ctx)));
  assert.ok(results.every((r: any) => r.isError !== true && /pi-moa/.test(r.content?.[0]?.text ?? "")), "3 路并行 read 小文件全部放行(按文件大小预扣)");
  assert.equal(budget.calls, 3);
  assert.equal(budgetReservedChars(budget), 0);
  assert.equal(budget.rejections ?? 0, 0, "没有任何一路被拒");
  assert.equal(budgetSnapshot(budget).exhaustedBy, undefined);
  ok(true, `read 按 min(文件字节数 ${size}, TOOL_SLICE) 预扣:3 路并行全放行,usedChars=${budget.usedChars},rejections=0`);
  // 无内容拒绝(jail/目录/不存在)发生在预扣之前:calls/rejections 都不动。
  const b2 = createRetrievalBudget({ maxChars: 100, maxCalls: 1 });
  const t2: any = createReadTool(b2);
  const rDir = await t2.execute("d", { path: "src" }, undefined, undefined, ctx);
  const rMissing = await t2.execute("m", { path: "definitely-not-here.txt" }, undefined, undefined, ctx);
  assert.ok(rDir.isError === true && rMissing.isError === true);
  assert.equal(b2.calls, 0);
  assert.equal(b2.rejections ?? 0, 0);
  ok(true, "目录/不存在文件的拒绝在预扣之前判定:calls=0、rejections=0(不是 reserve→release 绕一圈)");
})();

console.log("── 8) 真工具：无内容拒绝路径退还轮数（bash 策略拒 / read 读目录）──");
await (async () => {
  const budget = createRetrievalBudget();
  const bashTool: any = createBashReadonlyTool(budget);
  const readTool: any = createReadTool(budget);
  const ctx = { cwd: process.cwd() };
  const r1 = await bashTool.execute("rej", { command: "rm -rf /" }, undefined, undefined, ctx);
  assert.equal(r1.isError, true);
  assert.equal(budget.calls, 0, "策略拒的调用不计轮数(release 退还)");
  const r2 = await readTool.execute("dir", { path: "src" }, undefined, undefined, ctx);
  assert.equal(r2.isError, true);
  assert.equal(budget.calls, 0, "read 读目录被拒不计轮数(release 退还)");
  assert.equal(budgetReservedChars(budget), 0);
  const r3 = await readTool.execute("okread", { path: "package.json" }, undefined, undefined, ctx);
  assert.equal(r3.isError, undefined);
  assert.equal(budget.calls, 1);
  assert.ok(budget.usedChars > 0);
  assert.equal(budgetReservedChars(budget), 0);
  ok(true, "拒绝路径 release 不留预扣/不计轮数;成功路径 settle 记实际字符(read 已改 reserve/settle 统一口径)");
})();

console.log("budget_atomic: 全部断言通过");
