/**
 * §4.1 取证账(trace)在 runSession 真实路径上的形状(脱网、脱 key;node:test)。
 *
 * 运行:node --import tsx --test test/trace.test.ts
 * 覆盖:
 *   1) 模型未找到(会话未建):trace 恒在 = 零账 + retries=null(无会话可数,与 0 次重试区分)。
 *   2) budgetSnapshot → SessionTrace 口径:exhaustedBy 缺省 null(非 undefined),JSON 序列化字段恒在。
 *   3) spool traceLine 固定键序与 null 渲染。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSession } from "../src/moa/session.js";
import { budgetSnapshot, createRetrievalBudget, reserveBudget, settleBudget } from "../src/tools/budget.js";
import { traceLine } from "../src/mcp/spool.js";

test("模型未找到:SessionRunResult.trace 恒在,零账 + retries=null", async () => {
  const rt = { getModel: () => undefined } as unknown as Parameters<typeof runSession>[0];
  const r = await runSession(rt, { provider: "nope", model: "none", profile: "synthesize-worker" }, "p", { timeoutMs: 1000 });
  assert.ok(r.error && /模型未找到/.test(r.error));
  assert.ok(r.trace, "trace 存在");
  assert.deepEqual(
    { calls: r.trace!.calls, usedChars: r.trace!.usedChars, reservedChars: r.trace!.reservedChars, exhaustedBy: r.trace!.exhaustedBy, retries: r.trace!.retries },
    { calls: 0, usedChars: 0, reservedChars: 0, exhaustedBy: null, retries: null },
  );
  assert.ok(JSON.stringify(r.trace).includes('"exhaustedBy":null'), "null 序列化字段恒在");
});

/**
 * ★PIMOA-DEF-04（2026-09-20）回归：verify 轮（opts.structuredState 存在）传未注册模型名时，
 * 「模型未找到」这条 fail-closed 早退路径必须走通。修复前 structuredFields 闭包捕获了后置
 * `let schemaRejects`（声明在闭包首次调用之后）⇒ TDZ「Cannot access 'schemaRejects' before
 * initialization」冒泡到 orchestrate 兜底 catch，把唯一可操作的指引吃掉（moa#bb99489a）。
 */
test("DEF-04：structuredState 存在 + 模型未找到 ⇒ 返回精确「模型未找到…（检查 models.json）」，不抛 TDZ", async () => {
  const rt = { getModel: () => undefined } as unknown as Parameters<typeof runSession>[0];
  const r = await runSession(rt, { provider: "cliproxy", model: "claude-opus-4-6-thinking", profile: "verify-worker" }, "p", {
    timeoutMs: 1000,
    // 与 orchestrate.callAggregator 的 jevOn 分支同形（verify + jevcheck.enabled=true）。
    structuredState: { accepted: null, attempts: 0, rejects: [] },
  });
  assert.ok(r.error, "有 error（fail-closed，不是抛穿）");
  assert.ok(/模型未找到/.test(r.error!), `error 含「模型未找到」（实际 ${r.error}）`);
  assert.ok(/检查 models\.json/.test(r.error!), "error 含「检查 models.json」（唯一可操作指引）");
  assert.ok(/cliproxy\/claude-opus-4-6-thinking/.test(r.error!), "error 指名 provider/model");
  assert.ok(!/Cannot access/.test(r.error!), "★不得出现 TDZ 的「Cannot access」");
  assert.ok(!/内部未预期异常/.test(r.error!), "★不得折成「runMoa 内部未预期异常」");
  // structured 字段照常带上（早退路径的 structuredFields() 调用不得被删）。
  assert.ok(r.structured, "structured 摘要仍在（structuredState 存在时每条返回路径都带）");
  assert.equal(r.structured!.accepted, false);
  assert.equal(r.structured!.attempts, 0);
});

test("账本快照 → 取证账口径:已 settle 的调用/字符、结算后耗尽类别+被拒计数", () => {
  const b = createRetrievalBudget({ maxChars: 1000, maxCalls: 2 });
  const t1 = reserveBudget(b, 300);
  assert.ok(t1.ok);
  settleBudget(b, t1.ticket, 250);
  const t2 = reserveBudget(b, 300);
  assert.ok(t2.ok);
  settleBudget(b, t2.ticket, 100);
  const t3 = reserveBudget(b, 300); // 第 3 次撞 calls 上限
  assert.ok(!t3.ok && t3.exhaustedBy === "calls");
  const snap = budgetSnapshot(b);
  assert.equal(snap.calls, 2);
  assert.equal(snap.usedChars, 350);
  assert.equal(snap.reservedChars, 0, "全部 settle 后在途预扣归零");
  assert.equal(snap.maxCalls, 2);
  assert.equal(snap.maxChars, 1000);
  assert.equal(snap.exhaustedBy, "calls");
  assert.equal(snap.rejections, 1);
  assert.equal(snap.lastRejectedBy, "calls");
  const fresh = budgetSnapshot(createRetrievalBudget());
  assert.equal(fresh.exhaustedBy, undefined, "快照层未耗尽不带键;session.ts makeTrace 归一为 null");
  assert.equal(fresh.rejections, 0);
  assert.equal(fresh.lastRejectedBy, undefined, "从未被拒不带键;makeTrace 归一为 null");
});

test("spool traceLine:固定键序、null 渲染为字面 null", () => {
  const line = traceLine({
    durationMs: 5, input: null, output: null, cacheRead: null,
    calls: 0, usedChars: 0, reservedChars: 0, maxCalls: 5, maxChars: 240000, exhaustedBy: null, rejections: 0, lastRejectedBy: null, retries: null,
  });
  assert.equal(
    line,
    "[trace] durationMs=5 input=null output=null cacheRead=null calls=0 usedChars=0 reservedChars=0 exhaustedBy=null rejections=0 lastRejectedBy=null retries=null maxCalls=5 maxChars=240000",
  );
});
