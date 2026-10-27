/**
 * 请求级 idle 看门狗单测（2026-09-22 生产缺陷修复）。
 *
 * 运行：npx tsx test/session_idle.test.ts
 * 特性：脱网、脱 key、**不需要 8758**。内层流用 pi 真正的 `AssistantMessageEventStream`
 *       （`createAssistantMessageEventStream()`）手工驱动——所以本用例驱动的就是生产同一份
 *       流类型与同一份 `withIdleGuard` 代码，不是自造 mock。
 *
 * 覆盖（编号与派单书一一对应）：
 *   ① 正常慢流不被误杀（事件间隔 < idleMs，但总时长 > idleMs ⇒ 证明是"请求级静默"不是"总时长"）
 *   ② 静默超时 → 终态 stopReason="error"、errorMessage 命中 pi 可重试分支、不撞不可重试分支
 *      （两组正则逐条照抄 pi-ai/dist/utils/retry.js，并用**真分类器** isRetryableAssistantError 复核）
 *   ③ 正常结束时计时器被清理（clearTimeout 计数）＋ 离线卡死流被真跑出 idle 收尾、句柄有界（子进程实证）
 *   ④ idle 触发后内层后续事件不再被转发、结果不被改写（幂等收尾）
 *   ⑤ 外层 signal abort ⇒ 清 timer 并永久解除看门狗（终态由内层给，绝不被顶成"可重试"）
 *   ⑥ 正常路径逐字节等价（同一批事件对象、同一顺序、同一 result 身份）
 *   ⑦ 首个事件之前就卡死（无 partial）⇒ 合成兜底消息仍带合法身份与 usage
 *   ⑧ idleMs 非正/非有限 ⇒ 原样返回内层流（不启用看门狗）
 *   ⑨ 端到端（pi 真 AgentSession，仍是脱网脱 key）：卡死流 ⇒ pi **真实自动重试**（NEW）；
 *      对照：idleMs 远大于会话预算 + 会话级 abort（= 改造前行为）⇒ 只试一次、retries=0（OLD）
 *   ⑩ wrapStreamFunction 两形状：内层返回 `Promise<流>`（pi 真实 streamFn 的形状）与直接返回流，
 *      都要装上守卫、形状保持、maxTokens 注入不丢（★2026-09-22 阻断级回归位）
 *   ⑪ newEventStreamLike 硬化：传 Promise/非流对象 ⇒ fail-closed 且文案点名；真流照常包装
 *   ⑫ 端到端真跑（真 runSession + 真 pi async streamFn + 本地合成卡死端点）：
 *      卡死 ⇒ 看门狗 ⇒ pi 重试 ⇒ 同一会话内恢复；以及有界失败路径 fail-closed
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createIsolatedLoader,
  idleTimeoutErrorMessage,
  runSession,
  withIdleGuard,
  wrapStreamFunction,
  type IdleGuardMessageLike,
  type IdleGuardStream,
} from "../src/moa/session.js";

// pi 的流工厂只在 @earendil-works/pi-ai 内部导出，而该包在本仓是 pi-coding-agent 的嵌套依赖、
// 裸说明符被 exports 映射挡住（ERR_PACKAGE_PATH_NOT_EXPORTED）⇒ 用**文件 URL** 动态 import
// （exports 映射只管裸说明符，不管绝对路径/文件 URL），拿到的就是生产同一个类。
const PI_AI_INDEX = pathToFileURL(
  "./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
).href;
const piAi = (await import(PI_AI_INDEX)) as {
  createAssistantMessageEventStream: () => IdleGuardStream;
  isRetryableAssistantError: (m: IdleGuardMessageLike) => boolean;
};

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 往流里推一帧（事件形状按 pi 契约，字段多于 IdleGuardStream 声明面，故走一次松类型）。 */
function push(stream: IdleGuardStream, ev: Record<string, unknown>): void {
  (stream.push as unknown as (e: Record<string, unknown>) => void)(ev);
}

/** 把守卫输出的流转成事件数组（直到流结束）。 */
async function drain(stream: IdleGuardStream): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = [];
  for await (const e of stream) got.push(e as Record<string, unknown>);
  return got;
}

/** AssistantMessage 最小形状（字段与 pi provider 在首个事件前构造的 output 同形）。 */
function mkPartial(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "xiaomi",
    model: "mimo-v2.5-pro",
    usage: {
      input: 1234,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1241,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

// ---- pi-ai/dist/utils/retry.js 的两组正则（逐条照抄，见文件头注释）----
// 【0.84.1 冻结快照，以 pi-ai retry.js 为唯一真源】2026-09-27 本地补丁批 P4 已整抄 0.87.1 retry.js
// （可重试表 +3：exceeded request buffer limit while retrying upstream / 520 / currently experiencing
// high demand），本抄本**不跟进**；真分类器 isRetryableAssistantError 始终走补丁后的 retry.js 复核。
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = new RegExp(
  [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
  ].join("|"),
  "i",
);
const RETRYABLE_PROVIDER_ERROR_PATTERN = new RegExp(
  [
    "overloaded",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    "provider.?returned.?error",
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "getaddrinfo",
    "ENOTFOUND",
    "EAI_AGAIN",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    "websocket.?closed",
    "websocket.?error",
    "ended without",
    "stream ended before message_stop",
    "http2 request did not get a response",
    "retry delay",
    "you can retry your request",
    "try your request again",
    "please retry your request",
    "ResourceExhausted",
  ].join("|"),
  "i",
);

/** 直接断言一段 errorMessage 的 pi 重试分类（三路：不可重试正则、可重试正则、真分类器）。 */
function assertRetryableClassification(errorMessage: string, tag: string): void {
  assert(
    !NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage),
    `${tag} errorMessage 不命中任何不可重试词（GoUsageLimitError/insufficient_quota/quota exceeded/billing…）`,
  );
  assert(
    RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage),
    `${tag} errorMessage 命中可重试正则（timeout 分支）`,
  );
  assert(
    piAi.isRetryableAssistantError({ stopReason: "error", errorMessage }) === true,
    `${tag} pi 真分类器 isRetryableAssistantError === true`,
  );
}

// ============================================================================
// ① 正常慢流不被误杀：每 60ms 一帧、共 5 帧（总时长 300ms > idleMs=100ms）
// ============================================================================
{
  const idleMs = 100;
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, { label: "slow-healthy" });
  const p = mkPartial();
  const pushed: Array<Record<string, unknown>> = [];
  const collect = drain(guarded);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const ev =
      i === 0
        ? { type: "start", partial: p }
        : {
            type: "text_delta",
            contentIndex: 0,
            delta: `t${i}`,
            partial: { ...p, content: [{ type: "text", text: `t${i}` }] },
          };
    pushed.push(ev);
    push(inner, ev);
    await sleep(60); // 每帧间隔 60ms < idleMs=100ms
  }
  const doneMsg = mkPartial({ stopReason: "stop", content: [{ type: "text", text: "hello" }] });
  pushed.push({ type: "done", reason: "stop", message: doneMsg });
  push(inner, { type: "done", reason: "stop", message: doneMsg });
  const got = await collect;
  const elapsed = Date.now() - t0;
  assert(got.length === pushed.length, `① 正常慢流：收到全部 ${pushed.length} 帧（未误杀），实际 ${got.length}`);
  assert(got.every((e) => e.type !== "error"), "① 正常慢流：全程无 error 事件");
  assert(got[got.length - 1]?.type === "done", "① 正常慢流：终态是 done");
  assert(((await guarded.result()) as IdleGuardMessageLike).stopReason === "stop", "① 正常慢流：result stopReason=stop");
  assert(
    elapsed > idleMs,
    `① 总时长 ${elapsed}ms 已超过 idleMs=${idleMs}ms 却仍走完整流（证明看门狗是"请求级静默"而非"总时长上限"）`,
  );
}

// ============================================================================
// ② 静默超时 → 可重试错误收尾（且 label 只进 stderr、绝不进 errorMessage）
// ============================================================================
{
  const idleMs = 80;
  const LABEL = "xiaomi/mimo-v2.5-pro";
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, { label: LABEL });
  const p = mkPartial();
  const collect = drain(guarded);
  push(inner, { type: "start", partial: p });
  push(inner, { type: "text_delta", contentIndex: 0, delta: "半", partial: p });
  // 此后永久静默 ⇒ 看门狗应在 ~idleMs 内收尾（而不是等会话预算）
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  const t0 = Date.now();
  const got = await collect;
  const elapsed = Date.now() - t0;
  console.error = origErr;
  const last = got[got.length - 1] as { type?: string; reason?: string; error?: IdleGuardMessageLike };
  assert(last?.type === "error" && last?.reason === "error", `② 静默超时：终态事件是 error（第 ${got.length} 帧）`);
  assert(
    elapsed >= idleMs - 20 && elapsed < idleMs + 500,
    `② 静默 ~${idleMs}ms 后收尾（实测 ${elapsed}ms，未被会话预算吞掉）`,
  );
  const msg = last?.error?.errorMessage ?? "";
  assert(msg === idleTimeoutErrorMessage(idleMs), `② errorMessage 就是稳定契约文案：${JSON.stringify(msg)}`);
  assert(last?.error?.stopReason === "error", '② 终态 AssistantMessage.stopReason === "error"');
  assertRetryableClassification(msg, "②");
  assert(!msg.includes(LABEL), "② label 未进 errorMessage（不污染 pi 重试分类）");
  assert(
    logs.some((l) => l.includes("请求级 idle 超时") && l.includes(LABEL)),
    "② label 只进 stderr 诊断行（运维可见）",
  );
  const res = (await guarded.result()) as IdleGuardMessageLike;
  assert(res.stopReason === "error" && res.errorMessage === msg, "② result() 与终态事件一致（失败编码进流，未 throw）");
  assert(res.usage?.input === 1234, "② 沿用 partial 的 usage（不丢已收到的用量）");
}

// ============================================================================
// ③ 计时器清理：终态事件后必调 clearTimeout；离线卡死流被真跑出 idle 收尾且句柄有界
// ============================================================================
{
  const origClear = globalThis.clearTimeout;
  let clears = 0;
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    clears++;
    return (origClear as (x: typeof h) => void)(h);
  }) as typeof clearTimeout;
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, 600_000); // 远大于本用例时长：只有被清掉才不会挂住进程
  const doneMsg = mkPartial({ stopReason: "stop" });
  push(inner, { type: "start", partial: mkPartial() });
  push(inner, { type: "done", reason: "stop", message: doneMsg });
  await drain(guarded);
  globalThis.clearTimeout = origClear;
  assert(clears >= 1, `③ 终态事件后 clearTimeout 被调用（实测 ${clears} 次）——timer 已清`);

  // 子进程实证（在线 8758 跑的是旧代码，这里是本轮验真的真跑证据）：
  //   内层永远不吐任何事件、外层也不消费，看门狗必须在 ~idleMs 内触发并自行收尾，然后进程正常退出——
  //   既证明"卡死请求的句柄有界、不会永久挂着"，也证明"离线合成卡死流能被真实驱动出 idle 收尾"
  //   （主代理要照此写 OLD/NEW 差分探针）。
  const sessionUrl = pathToFileURL("./src/moa/session.ts").href;
  const childScript = `
const { withIdleGuard } = await import(${JSON.stringify(sessionUrl)});
const pi = await import(${JSON.stringify(PI_AI_INDEX)});
const inner = pi.createAssistantMessageEventStream();
const t0 = Date.now();
const guarded = withIdleGuard(inner, 700, { label: "hung-probe" });
guarded.result().then((m) => {
  console.log("idle-settled:" + (m && m.stopReason) + ":" + (m && m.errorMessage) + ":" + (Date.now() - t0));
});
console.log("armed-hung-inner");
`;
  const c0 = Date.now();
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childScript],
    { encoding: "utf8", timeout: 20_000 },
  );
  const childMs = Date.now() - c0;
  assert(
    child.status === 0,
    `③ 卡死流 + 700ms 看门狗：子进程正常退出（status=${child.status}, ${childMs}ms，未挂死）`,
  );
  const out = child.stdout ?? "";
  assert(out.includes("armed-hung-inner"), "③ 子进程确实装上了看门狗（不是没跑起来）");
  const m = /idle-settled:error:(.*):(\d+)/.exec(out);
  assert(m !== null, `③ 卡死流在离线子进程里被真跑出 idle 收尾：${JSON.stringify(out.trim().split("\n").pop())}`);
  assert((m?.[1] ?? "").includes("stream idle timeout"), "③ 子进程拿到的 errorMessage 正是 idle 契约文案");
  const settleMs = Number(m?.[2] ?? 0);
  assert(settleMs >= 600 && settleMs < 5000, `③ 收尾发生在 ~700ms（实测 ${settleMs}ms）⇒ timer 真的被装上并触发，且触发后无残留句柄`);
}

// ============================================================================
// ④ idle 触发后：内层后续事件不再被转发，结果不被改写（收尾幂等）
// ============================================================================
{
  const idleMs = 60;
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, { label: "post-idle" });
  const collect = drain(guarded);
  push(inner, { type: "start", partial: mkPartial() });
  push(inner, { type: "text_delta", contentIndex: 0, delta: "x", partial: mkPartial() });
  const got = await collect;
  const nAfterIdle = got.length;
  const resBefore = (await guarded.result()) as IdleGuardMessageLike;
  assert((got[got.length - 1] as { type?: string })?.type === "error", "④ 先确认已由 idle 收尾");
  // idle 之后内层才吐出的事件：不得被转发（也不得抛）
  let threw = false;
  try {
    push(inner, { type: "text_delta", contentIndex: 0, delta: "late-1", partial: mkPartial() });
    push(inner, { type: "toolcall_start", contentIndex: 1, partial: mkPartial() });
    push(inner, { type: "done", reason: "stop", message: mkPartial({ stopReason: "stop" }) });
  } catch {
    threw = true;
  }
  await sleep(80);
  assert(!threw, "④ idle 之后向内层 push 不抛（不会产生未处理拒绝）");
  assert(got.length === nAfterIdle, `④ idle 之后内层事件不再被转发（${nAfterIdle} → ${got.length} 帧）`);
  const resAfter = (await guarded.result()) as IdleGuardMessageLike;
  assert(resAfter === resBefore, "④ result() 不被后续内层事件改写（收尾幂等：只 end 一次）");
}

// ============================================================================
// ⑤ 外层 signal abort ⇒ 清 timer 并永久解除看门狗
// ============================================================================
{
  const idleMs = 70;
  const ac = new AbortController();
  const origClear = globalThis.clearTimeout;
  let clears = 0;
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    clears++;
    return (origClear as (x: typeof h) => void)(h);
  }) as typeof clearTimeout;
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, { label: "abort-case", signal: ac.signal });
  let ended = false;
  const p = drain(guarded).then((g) => {
    ended = true;
    return g;
  });
  push(inner, { type: "start", partial: mkPartial() });
  await sleep(10);
  const clearsBeforeAbort = clears;
  ac.abort();
  const clearsAfterAbort = clears;
  globalThis.clearTimeout = origClear;
  assert(
    clearsAfterAbort > clearsBeforeAbort,
    `⑤ abort 当刻清掉 idle timer（clearTimeout ${clearsBeforeAbort} → ${clearsAfterAbort}）`,
  );
  await sleep(idleMs + 80); // 越过 idleMs 仍不得冒出 idle error
  assert(!ended, "⑤ abort 后永久解除看门狗：越过 idleMs 也不产生 idle error（终态留给内层）");
  // 内层按 abort 语义结束 → 守卫原样转发 aborted，而不是把它顶成可重试 error
  const abortedMsg = mkPartial({ stopReason: "aborted" });
  push(inner, { type: "error", reason: "aborted", error: abortedMsg });
  const got = await p;
  const last = got[got.length - 1] as { type?: string; reason?: string; error?: IdleGuardMessageLike };
  assert(last?.type === "error" && last?.reason === "aborted", "⑤ 终态是内层的 aborted（不是守卫合成的可重试 error）");
  assert(last?.error?.stopReason === "aborted", '⑤ stopReason="aborted" ⇒ pi 明文不重试（不会被误当瞬时错误）');
}

// ============================================================================
// ⑬ ★预取消路径（主代理 P1/F1 复现的缺陷）：进入 withIdleGuard 时 signal **已经 aborted**。
//    旧实现在这条分支只"不装表"、不置 disarmed，而循环体每收一个内层事件都无条件 armIdle()
//    ⇒ 看门狗在**已取消的会话**上被复活，推出一条含 timeout 的可重试 error，顶掉内层该给的 aborted。
//    ⑤ 覆盖的是"流中途 abort"（走 listener 分支）；本条覆盖"进入时即 aborted"——两条路径不同，都要在。
// ============================================================================
{
  const idleMs = 70;
  const ac = new AbortController();
  ac.abort(); // ★进入 withIdleGuard 之前就已取消
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, { label: "pre-aborted", signal: ac.signal });
  const got: Array<Record<string, unknown>> = [];
  const p = (async () => {
    for await (const e of guarded) got.push(e as Record<string, unknown>);
  })();
  // 非终态事件：旧实现正是在这里 armIdle() 把看门狗复活
  push(inner, { type: "start", partial: mkPartial() });
  await sleep(idleMs + 200); // 越过 idleMs
  assert(!got.some((e) => e.type === "error"), "⑬ 预取消下看门狗不被复活：越过 idleMs 仍无 error 事件");
  // 终态必须由内层给出
  const abortedMsg13 = mkPartial({ stopReason: "aborted" });
  push(inner, { type: "error", reason: "aborted", error: abortedMsg13 });
  await p;
  const last13 = got[got.length - 1] as { type?: string; reason?: string; error?: IdleGuardMessageLike };
  assert(last13?.type === "error" && last13?.reason === "aborted", "⑬ 终态是内层给的 aborted（未被顶成可重试 error）");
  assert(last13?.error?.stopReason === "aborted", "⑬ stopReason=aborted ⇒ pi 明文不重试");
  assert((await guarded.result()) === abortedMsg13, "⑬ result() 就是内层 aborted 消息对象（未被改写）");
}

// ============================================================================
// ⑥ 正常路径逐字节等价：同一批事件对象、同一顺序、同一 result 身份
// ============================================================================
{
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, 5000, { label: "equivalent" });
  const p0 = mkPartial();
  const p1 = mkPartial({ content: [{ type: "text", text: "abc" }] });
  const doneMsg = mkPartial({ stopReason: "stop", content: [{ type: "text", text: "abc" }] });
  const pushed: Array<Record<string, unknown>> = [
    { type: "start", partial: p0 },
    { type: "text_start", contentIndex: 0, partial: p1 },
    { type: "text_delta", contentIndex: 0, delta: "abc", partial: p1 },
    { type: "text_end", contentIndex: 0, content: "abc", partial: p1 },
    { type: "done", reason: "stop", message: doneMsg },
  ];
  const collect = drain(guarded);
  for (const ev of pushed) push(inner, ev);
  const got = await collect;
  assert(got.length === pushed.length, `⑥ 事件条数逐字节一致（${pushed.length}）`);
  assert(
    got.every((e, i) => e === pushed[i]),
    "⑥ 转发的是同一批事件对象、同一顺序（未复制/未改写）",
  );
  assert((await guarded.result()) === doneMsg, "⑥ result() 就是内层 done 的 message 对象本身（身份一致）");
}

// ============================================================================
// ⑦ 首个事件之前就卡死（无 partial）⇒ 合成兜底消息仍有合法身份与 usage
// ============================================================================
{
  const idleMs = 50;
  const inner = piAi.createAssistantMessageEventStream();
  const guarded = withIdleGuard(inner, idleMs, {
    label: "zero-event",
    identity: { api: "openai-completions", provider: "xiaomi", model: "mimo-v2.5-pro" },
  });
  const got = await drain(guarded);
  const last = got[got.length - 1] as { type?: string; error?: IdleGuardMessageLike };
  assert(last?.type === "error", "⑦ 零事件静默也以 error 收尾");
  const m = last?.error ?? {};
  assert(m.role === "assistant" && m.stopReason === "error", "⑦ 合成消息 role/stopReason 合法");
  assert(
    m.api === "openai-completions" && m.provider === "xiaomi" && m.model === "mimo-v2.5-pro",
    "⑦ 合成消息带 identity 身份字段",
  );
  assert(m.usage?.input === 0 && m.usage?.totalTokens === 0, "⑦ 合成消息 usage 是完整零值（下游不会读到 undefined）");
  assertRetryableClassification(m.errorMessage ?? "", "⑦");
}

// ============================================================================
// ⑧ idleMs 非正/非有限 ⇒ 原样返回内层流（不启用看门狗）
// ============================================================================
{
  const inner = piAi.createAssistantMessageEventStream();
  assert(withIdleGuard(inner, 0) === inner, "⑧ idleMs=0 ⇒ 原样返回内层流（未启用）");
  assert(withIdleGuard(inner, -5) === inner, "⑧ idleMs=-5 ⇒ 原样返回内层流（未启用）");
  assert(withIdleGuard(inner, Number.NaN) === inner, "⑧ idleMs=NaN ⇒ 原样返回内层流（未启用）");
}

// ============================================================================
// ⑨ 端到端（pi 真 AgentSession + 假端点 stub 流，脱网脱 key）：
//    NEW = 卡死流被看门狗收尾成可重试错误 ⇒ pi 真的自动重试该请求；
//    OLD = idleMs 远大于会话预算（看门狗来不及到点）+ 会话级 abort ⇒ 只试一次、0 重试（改造前形态）。
// ============================================================================
{
  process.env.PIMOA_IDLE_PROBE_KEY = "dummy-probe-key";
  const dir = mkdtempSync(join(tmpdir(), "pimoa-idle-probe-"));
  const modelsPath = join(dir, "models.json");
  const authPath = join(dir, "auth.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "$PIMOA_IDLE_PROBE_KEY",
          models: [
            {
              id: "probe-model",
              name: "probe",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(authPath, "{}", "utf8");
  const modelRuntime = await ModelRuntime.create({ modelsPath, authPath });
  const model = modelRuntime.getModel("probe", "probe-model");
  assert(model !== undefined, "⑨ 探针模型解析成功（脱网 models.json）");

  const mkBase = (): Record<string, unknown> => ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "probe",
    model: "probe-model",
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending",
    timestamp: Date.now(),
  });

  /** 跑一次真实 pi 会话：stub 流先给 start、此后永久静默（模拟生产里"发出去后没人回"）。 */
  const runProbe = async (
    idleMs: number,
    abortAfterMs?: number,
  ): Promise<{ attempts: number; retries: number; stopReason?: string; errorMessage?: string }> => {
    const loader = await createIsolatedLoader(process.cwd());
    const created = await createAgentSession({
      cwd: process.cwd(),
      model,
      modelRuntime,
      noTools: "all",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      // runSession 生产用 { enabled: true }；这里把退避压到 100ms 只为测试快，重试语义完全一致。
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } }),
    });
    const session = created.session as unknown as {
      agent: { streamFunction: (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown };
      messages: Array<Record<string, unknown>>;
      subscribe: (fn: (e: { type: string }) => void) => () => void;
      prompt: (p: string) => Promise<void>;
      abort: () => Promise<void>;
      dispose: () => void;
    };
    let attempts = 0;
    session.agent.streamFunction = (_m, _c, o) => {
      attempts++;
      const inner = piAi.createAssistantMessageEventStream();
      push(inner, { type: "start", partial: mkBase() });
      const sig = (o as { signal?: AbortSignal } | undefined)?.signal;
      // 真 provider 收到 abort 会推一只 stopReason="aborted" 的终态；stub 照此模拟，否则会话永不结束。
      if (sig) {
        sig.addEventListener(
          "abort",
          () => push(inner, { type: "error", reason: "aborted", error: { ...mkBase(), stopReason: "aborted" } }),
          { once: true },
        );
      }
      return withIdleGuard(inner, idleMs, { label: "probe", ...(sig ? { signal: sig } : {}) });
    };
    const events: string[] = [];
    session.subscribe((e) => events.push(e.type));
    const promptP = session.prompt("probe");
    if (abortAfterMs !== undefined) {
      await sleep(abortAfterMs);
      await session.abort(); // runSession 的 per-call 定时器就是这一步（会话级 abort = 终止态）
    }
    await promptP;
    const assistants = session.messages.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1] as IdleGuardMessageLike | undefined;
    session.dispose();
    return {
      attempts,
      retries: events.filter((t) => t === "auto_retry_start").length,
      ...(last?.stopReason ? { stopReason: String(last.stopReason) } : {}),
      ...(last?.errorMessage ? { errorMessage: String(last.errorMessage) } : {}),
    };
  };

  const newWay = await runProbe(200);
  assert(newWay.attempts === 2, `⑨-NEW 卡死流被重试：streamFunction 被调 2 次（实测 ${newWay.attempts}）`);
  assert(newWay.retries === 1, `⑨-NEW pi 真实 auto_retry_start 事件 = 1（实测 ${newWay.retries}）`);
  assert(newWay.stopReason === "error", "⑨-NEW 最后一次仍是 error（重试后仍卡死 ⇒ fail-closed，不静默转成功）");
  assert(
    newWay.errorMessage === idleTimeoutErrorMessage(200),
    `⑨-NEW 终态 errorMessage 仍是 idle 契约文案：${JSON.stringify(newWay.errorMessage)}`,
  );

  const oldWay = await runProbe(60_000, 400);
  assert(oldWay.attempts === 1, `⑨-OLD 看门狗来不及到点（idleMs 60s ≫ 会话预算）：只试 1 次（实测 ${oldWay.attempts}）`);
  assert(oldWay.retries === 0, `⑨-OLD 0 次重试（实测 ${oldWay.retries}）——这就是改造前"一次卡顿吃满整个预算"的形态`);
  assert(oldWay.stopReason === "aborted", `⑨-OLD 终态是 aborted（终止态、pi 明文不重试）：${JSON.stringify(oldWay.stopReason)}`);
}

// ============================================================================
// ⑩ wrapStreamFunction 双形状（★阻断级回归位）：
//    pi 真实的 agent.streamFunction 来自 createAgentSession 的
//    `streamFn: async (model, context, options) => modelRuntime.streamSimple(...)`（sdk.js）⇒ 返回
//    **Promise<流>**；低层 stub 可能直接返回流。旧实现把内层返回值直接当流装看门狗，取到 Promise
//    构造器 → `new Promise()` → "Promise resolver undefined is not a function" → 每轮 verify 全灭。
// ============================================================================
{
  const isStreamShaped = (v: unknown): boolean =>
    typeof (v as { result?: unknown } | null)?.result === "function" &&
    typeof (v as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === "function";

  // ⑩-A：内层返回 Promise<流>（= pi 真实形状）⇒ 包装后仍返回 Promise，await 出来是同型真流
  let seenMaxTokens: unknown;
  let innerA: IdleGuardStream | undefined;
  const innerAsync = (_m: unknown, _c: unknown, o?: Record<string, unknown>): unknown => {
    seenMaxTokens = o?.maxTokens;
    innerA = piAi.createAssistantMessageEventStream();
    return Promise.resolve(innerA); // 模拟 async streamFn
  };
  const wrappedA = wrapStreamFunction(innerAsync, {
    maxTokens: 4096,
    idleMs: 120,
    label: "promise-shape",
    identityOf: () => ({ api: "openai-completions", provider: "probe", model: "m" }),
  });
  const returnedA = wrappedA({}, {}, {}) as PromiseLike<unknown>;
  assert(
    typeof (returnedA as { then?: unknown })?.then === "function",
    "⑩-A 内层 Promise<流> ⇒ 包装后仍是 Promise（形状保持）",
  );
  const streamA = (await returnedA) as IdleGuardStream;
  assert(isStreamShaped(streamA), "⑩-A await 出来的是同型真流（result + Symbol.asyncIterator 都在）");
  assert(
    streamA.constructor.name === "AssistantMessageEventStream",
    `⑩-A 同型：${streamA.constructor.name}`,
  );
  assert(seenMaxTokens === 4096, "⑩-A maxTokens 注入未丢（Promise 路径）");
  push(innerA as IdleGuardStream, { type: "start", partial: mkPartial() });
  const gotA = await drain(streamA);
  const lastA = gotA[gotA.length - 1] as { type?: string; error?: IdleGuardMessageLike };
  assert(lastA?.type === "error", "⑩-A Promise 形状下看门狗仍生效（真流被包住且 idle 收尾）");
  assert(
    lastA?.error?.errorMessage === idleTimeoutErrorMessage(120),
    "⑩-A 收尾文案仍是 idle 契约文案",
  );

  // ⑩-B：内层直接返回流（stub 形状）⇒ 包装后仍返回流（不被无条件 Promise 化）
  let seenMaxTokensB: unknown;
  const innerSync = (_m: unknown, _c: unknown, o?: Record<string, unknown>): unknown => {
    seenMaxTokensB = o?.maxTokens;
    return piAi.createAssistantMessageEventStream();
  };
  const returnedB = wrapStreamFunction(innerSync, { maxTokens: 2048, idleMs: 5000 })({}, {}, {});
  assert(
    typeof (returnedB as { then?: unknown })?.then !== "function",
    "⑩-B 内层直接返回流 ⇒ 包装后仍是流（形状保持，未被无条件 Promise 化）",
  );
  assert(isStreamShaped(returnedB), "⑩-B 流形状下返回的是真流");
  assert(seenMaxTokensB === 2048, "⑩-B maxTokens 注入未丢（流路径）");

  // ⑩-C：显式传入的 maxTokens 优先于注入值（与改造前逐字一致）
  const innerC = (_m: unknown, _c: unknown, o?: Record<string, unknown>): unknown => {
    seenMaxTokensB = o?.maxTokens;
    return piAi.createAssistantMessageEventStream();
  };
  wrapStreamFunction(innerC, { maxTokens: 100, idleMs: 5000 })({}, {}, { maxTokens: 777 });
  assert(seenMaxTokensB === 777, "⑩-C 调用方显式 maxTokens 优先（注入行为一字未改）");
}

// ============================================================================
// ⑪ newEventStreamLike 硬化：Promise/非流对象一律 fail-closed 且文案点名
// ============================================================================
{
  let msgPromise = "";
  try {
    withIdleGuard(Promise.resolve(piAi.createAssistantMessageEventStream()) as unknown as IdleGuardStream, 100);
  } catch (e) {
    msgPromise = e instanceof Error ? e.message : String(e);
  }
  assert(
    msgPromise.includes("Promise") && msgPromise.includes("await"),
    `⑪ 传 Promise ⇒ fail-closed 且文案要求"先 await 出真流"：${JSON.stringify(msgPromise)}`,
  );

  let msgObject = "";
  try {
    withIdleGuard({} as unknown as IdleGuardStream, 100);
  } catch (e) {
    msgObject = e instanceof Error ? e.message : String(e);
  }
  assert(
    msgObject.includes("不是 pi 的 AssistantMessageEventStream"),
    `⑪ 传非流对象 ⇒ fail-closed 明确文案：${JSON.stringify(msgObject)}`,
  );

  const real = piAi.createAssistantMessageEventStream();
  assert(withIdleGuard(real, 5000) !== real, "⑪ 正常真流仍被正常包装（硬化没挡住合法输入）");
}

// ============================================================================
// ⑭ ★null / undefined 输入必须给**具名** fail-closed 文案（主代理 P1/F2）：
//    旧顺序先 `Object.getPrototypeOf(like)` ⇒ 先炸原生 `TypeError: Cannot convert undefined or null
//    to object`，具名诊断永远发不出来（fail-closed 语义还在，可诊断性丢了）。
// ============================================================================
{
  for (const bad of [null, undefined]) {
    let msg = "";
    try {
      withIdleGuard(bad as unknown as IdleGuardStream, 100);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(
      msg.includes("不是 pi 的 AssistantMessageEventStream") && !msg.includes("Cannot convert undefined or null"),
      `⑭ 传 ${String(bad)} ⇒ 具名 fail-closed 文案（不是原生 TypeError）：${JSON.stringify(msg)}`,
    );
  }
}

// ============================================================================
// ⑫ 端到端真跑（真 runSession + 真 pi async streamFn + 本地合成卡死端点；零真上游、零真 key）：
//    这条是主代理 OLD/NEW 探针的最小复刻 —— 之前的 51 条断言全部绕开了"真实 streamFn 返回
//    Promise"这一步，所以集成必炸而单测全绿。本用例专门压住那个形状。
// ============================================================================
{
  process.env.PIMOA_E2E_STALL_KEY = process.env.PIMOA_E2E_STALL_KEY ?? "dummy";
  const e2eDir = mkdtempSync(join(tmpdir(), "pimoa-idle-e2e-"));
  let requests = 0;
  let succeedFrom = 3; // 前 2 次卡死、第 3 次正常收尾 ⇒ 证"卡死→重试→同一会话内恢复"
  const sockets = new Set<Socket>();
  const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      if (!/\/chat\/completions$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (requests >= succeedFrom) {
        res.write(sse({ id: "c", object: "chat.completion.chunk", created: 0, model: "stallprobe", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
        res.write(sse({ id: "c", object: "chat.completion.chunk", created: 0, model: "stallprobe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      for (const d of ["一", "二", "三"]) {
        res.write(sse({ id: "c", object: "chat.completion.chunk", created: 0, model: "stallprobe", choices: [{ index: 0, delta: { content: d }, finish_reason: null }] }));
      }
      // 故意不 res.end() ⇒ 吐 3 帧后永久静默（复刻生产"发出去后没人回"）
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const modelsPath = join(e2eDir, "models.stall.json");
  const authPath = join(e2eDir, "auth.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        stallprobe: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "$PIMOA_E2E_STALL_KEY",
          models: [
            {
              id: "stall-model",
              name: "stall",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(authPath, "{}", "utf8");
  const e2eRuntime = await ModelRuntime.create({ modelsPath, authPath });
  const worker = { provider: "stallprobe", model: "stall-model", profile: "synthesize-worker" } as never;

  // ⑫-A：真 runSession 跑通"卡死 → 看门狗 → pi 重试 → 恢复"
  {
    const t0 = Date.now();
    const r = await runSession(e2eRuntime, worker, "只回答 ok", {
      timeoutMs: 30_000,
      idleMs: 300,
      tools: [],
      cwd: e2eDir,
    } as never);
    const wall = Date.now() - t0;
    assert(requests >= 3, `⑫-A 卡死端点收到 >=3 次请求（真 pi async streamFn 真发了 HTTP）：${requests}`);
    assert((r.trace?.retries ?? 0) >= 2, `⑫-A pi 真重试 >=2 次（trace.retries=${r.trace?.retries}）`);
    assert(r.error === undefined, `⑫-A 重试后恢复：无 error（实际 ${JSON.stringify(r.error)}）`);
    assert(r.stopReason === "stop", `⑫-A 终态 stopReason=stop（实际 ${String(r.stopReason)}）`);
    assert(r.text.includes("ok"), `⑫-A 恢复后拿到正文：${JSON.stringify(r.text)}`);
    assert(wall < 25_000, `⑫-A 在会话预算内恢复而非卡满（实测 ${(wall / 1000).toFixed(1)}s）`);
  }

  // ⑫-B：一直卡死 + 会话预算 1.5s ⇒ fail-closed（timedOut），且确实发生过重试
  {
    requests = 0;
    succeedFrom = Number.POSITIVE_INFINITY;
    const r = await runSession(e2eRuntime, worker, "只回答 ok", {
      timeoutMs: 1500,
      idleMs: 200,
      tools: [],
      cwd: e2eDir,
    } as never);
    assert(r.timedOut === true, "⑫-B 一直卡死 ⇒ 会话级预算到点 timedOut=true（fail-closed，不静默转成功）");
    assert((r.trace?.retries ?? 0) >= 1, `⑫-B 卡死已被识别为可重试并触发过重试（trace.retries=${r.trace?.retries}）`);
    assert(r.sawAgentEnd === true, "⑫-B 会话仍以 agent_end 正常收敛（不是挂死）");
  }

  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
}

// ============================================================================
// ⑮ O2 hybrid modern 用例组（2026-09-30）：modern 腿客户端断开 ⇒ ctx.mcpReq.signal abort ⇒ 看门狗解除
//    server.ts 的 modern 适配把 `ctx.mcpReq.signal` 交给 handleToolCall → track()（链到 runSession 的 signal）。
//    本组验这条链在 SDK v2 真 handler 上成立：用 createMcpHandler（选项同 server.ts：legacy:"reject" +
//    responseMode:"sse" + 8MiB）+ toNodeHandler 起进程内服务，工具体里用**同一份 withIdleGuard** 包一条
//    卡死的 pi 真流、signal 取 ctx.mcpReq.signal；客户端 fetch 发 modern tools/call 后中途 abort（断连）。
//    验：① ctx.mcpReq.signal 在断连后很快 abort；② 越过 idleMs 守卫不再冒 idle error（与 ⑤ 同语义）；
//        ③ 内层随后给的 aborted 终态被原样转发（不被顶成可重试 error）。
//    （在真 server.ts 上无法确定性造出「卡在模型阶段」的调用而不连真 provider，故用进程内 v2 handler。）
// ============================================================================
{
  console.log("\n[⑮ O2 modern 腿断连 → signal → 看门狗解除]");
  const { createMcpHandler, McpServer: V2McpServer } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { z } = await import("zod");
  const idleMs = 300;
  let abortedAt = -1;
  let calledAt = -1;
  let settle: (v: Array<Record<string, unknown>>) => void = () => {};
  const drained = new Promise<Array<Record<string, unknown>>>((r) => (settle = r));
  let innerRef: IdleGuardStream | undefined;
  const handler = createMcpHandler(
    () => {
      const s = new V2McpServer({ name: "o2-idle", version: "0" }, { capabilities: {} });
      s.registerTool("hung", { inputSchema: z.object({}) }, async (_args: Record<string, never>, ctx) => {
        calledAt = Date.now();
        const sig = ctx.mcpReq.signal;
        sig.addEventListener("abort", () => (abortedAt = Date.now()), { once: true });
        const inner = piAi.createAssistantMessageEventStream();
        innerRef = inner;
        const guarded = withIdleGuard(inner, idleMs, { label: "o2-modern-disconnect", signal: sig });
        push(inner, { type: "start", partial: mkPartial() });
        void drain(guarded).then(settle);
        await new Promise<void>((r) => (sig.aborted ? r() : sig.addEventListener("abort", () => r(), { once: true })));
        return { content: [{ type: "text" as const, text: "aborted" }] };
      });
      return s;
    },
    { legacy: "reject", responseMode: "sse", maxRequestBodySize: 8 * 1024 * 1024 },
  );
  const node = toNodeHandler(handler, { maxRequestBodySize: 8 * 1024 * 1024 });
  const srv = createServer((req, res) => void node(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const ac = new AbortController();
  const MV = "2026-07-28";
  const fetchP = fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MV,
      "mcp-method": "tools/call",
      "mcp-name": "hung",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "hung",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": MV, "io.modelcontextprotocol/clientCapabilities": {} },
      },
    }),
  }).then((r) => r.text()).catch((e: Error) => `client-aborted:${e.name}`);
  for (let i = 0; i < 100 && calledAt < 0; i++) await sleep(10);
  assert(calledAt > 0, "⑮ 前提：modern tools/call 已进入工具体（守卫已装在卡死流上）");
  const tAbort = Date.now();
  ac.abort(); // 客户端断连
  await fetchP;
  for (let i = 0; i < 100 && abortedAt < 0; i++) await sleep(10);
  assert(abortedAt > 0 && abortedAt - tAbort < 1000, `⑮① 客户端断连 ⇒ ctx.mcpReq.signal abort（${abortedAt > 0 ? abortedAt - tAbort : "未触发"}ms）`);
  let idleFired = false;
  void drained.then(() => (idleFired = true));
  await sleep(idleMs + 150);
  assert(!idleFired, "⑮② signal abort 后越过 idleMs 守卫不再冒 idle error（看门狗随 modern 腿断连解除）");
  push(innerRef!, { type: "error", reason: "aborted", error: mkPartial({ stopReason: "aborted" }) });
  const got = await drained;
  const last = got[got.length - 1] as { type?: string; reason?: string };
  assert(last?.type === "error" && last?.reason === "aborted", "⑮③ 内层 aborted 终态原样转发（不被顶成可重试 error）");
  await handler.close();
  await new Promise<void>((r) => srv.close(() => r()));
}

console.log(`\n[session-idle-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
