#!/usr/bin/env node
// probes.mjs — pi 基座补丁批回归探针 [v2.1 §6 修正版断言清单落地]
// 运行：node --experimental-import-meta-resolve patches/pi-ai-0.84.1/probes.mjs（cd 仓根；路径自解析）
//       ★必须带该 flag：W1a/W1b 用两参 import.meta.resolve(spec, parentURL)，不带时第二参被忽略、
//       回落本文件位置求解而报 ERR_MODULE_NOT_FOUND（探针会记 FAIL 并点名缺 flag，不崩）。
// 退出码：0=全 PASS；1=有 FAIL（基线态 R0-R3/B1/O5/O7/I2x 等真双态项 FAIL 属预期留痕）。
// 纪律：逐条 safe() try 隔离（抛错记 FAIL 不中断，修 F1/I3）；has() 导出存在性守卫（R0 双态锚）。
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist");
const TARGET = join(DIST, "index.js");
const PRISTINE_ES = join(REPO_ROOT, "patches/pi-ai-0.84.1/pristine/utils/event-stream.js");
const AGENT_SESSION = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
const AGENT_LOOP = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js");

const piAi = await import(pathToFileURL(TARGET).href);
const pristine = await import(pathToFileURL(PRISTINE_ES).href);
let pass = 0, fail = 0;
const t = (name, ok, actual) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name} actual=${JSON.stringify(actual)}`); };
const pick = (name, r) => { if (r && typeof r === "object" && "ok" in r) t(name, r.ok, r.actual); else t(name, !!r); };
const safe = (name, fn) => { try { pick(name, fn()); } catch (e) { t(name, false, "THROW " + e.message); } };
const safeA = async (name, fn) => { try { pick(name, await fn()); } catch (e) { t(name, false, "THROW " + e.message); } };
const has = (f) => typeof piAi[f] === "function";
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── W1a/W1b 副本防伪：消费方裸说明符解析必须落在补丁目标 dist ──────────────
// createRequire(...).resolve(...) 在本包必抛 ERR_PACKAGE_PATH_NOT_EXPORTED（exports 只有
// import/types 条件；session_idle.test.ts 因此用 file-URL 直引）⇒ 定稿形态=真 ESM 解析器：
// 两参 import.meta.resolve(spec, 消费方文件 URL)，再 realpath 比对（DESIGN §6 W1a/W1b）。
const RESOLVE_FLAG = process.execArgv.includes("--experimental-import-meta-resolve");
function resolveFrom(parentFile, spec) {
  if (!RESOLVE_FLAG) return { err: "缺 --experimental-import-meta-resolve（两参 resolve 不生效）" };
  try { return { url: import.meta.resolve(spec, pathToFileURL(parentFile).href) }; }
  catch (e) { return { err: e.code ?? e.message }; }
}
const distReal = realpathSync(DIST);
for (const [name, parent, spec] of [
  ["W1a agent-session.js→@earendil-works/pi-ai/compat", AGENT_SESSION, "@earendil-works/pi-ai/compat"],
  ["W1b agent-loop.js→@earendil-works/pi-ai", AGENT_LOOP, "@earendil-works/pi-ai"],
]) {
  safe(name, () => {
    const r = resolveFrom(parent, spec);
    if (r.err) return { ok: false, actual: "RESOLVE-THROW " + r.err };
    const p = realpathSync(fileURLToPath(r.url));
    return { ok: p.startsWith(distReal + "/"), actual: p };
  });
}

// ── retry 分类（I1x/I2x：前四不变量 + 后三 P4 新增真双态）──────────────────
const idle = "stream idle timeout: no stream event for 540000ms";
const isRetry = (m) => piAi.isRetryableAssistantError({ stopReason: "error", errorMessage: m });
safe("I1x idle 合成消息可重试", () => isRetry(idle) === true);
safe("I2x quota exceeded 不可重试", () => isRetry("quota exceeded") === false);
safe("I2x insufficient_quota 不可重试", () => isRetry("insufficient_quota") === false);
safe("I2x billing 不可重试", () => isRetry("billing") === false);
safe("I2x 混合串「billing error 520」不可重试表优先", () => isRetry("billing error 520") === false);
safe("I2x buffer 限流可重试(P4)", () => isRetry("exceeded request buffer limit while retrying upstream") === true);
safe("I2x 520 可重试(P4)", () => isRetry("520 status code") === true);
safe("I2x high demand 可重试(P4)", () => isRetry("The model is currently experiencing high demand") === true);

// ── R0/R1-R3 retryDelayMs（基线态=导出缺失，FAIL 留痕不抛）────────────────
safe("R0 retryDelayMs 导出存在(P4 新增)", () => ({ ok: has("retryDelayMs"), actual: typeof piAi.retryDelayMs }));
if (has("retryDelayMs")) {
  safe("R1 封顶 60000", () => piAi.retryDelayMs({ baseDelayMs: 1000 }, 10) === 60000);
  safe("R2 maxAgentDelayMs 覆盖", () => piAi.retryDelayMs({ baseDelayMs: 1000, maxAgentDelayMs: 5000 }, 10) === 5000);
  safe("R3 首试=baseDelayMs", () => piAi.retryDelayMs({ baseDelayMs: 1000 }, 1) === 1000);
  safe("R3 溢出安全(有限值)", () => Number.isFinite(piAi.retryDelayMs({ baseDelayMs: 1e9 }, 60)));
} else {
  for (const n of ["R1 封顶 60000", "R2 maxAgentDelayMs 覆盖", "R3 首试=baseDelayMs", "R3 溢出安全(有限值)"])
    t(n, false, "导出缺失(改前态)");
}

// ── R4 aborted 形状与不重试 ─────────────────────────────────────────────
await safeA("R4 aborted 形状(删键)", async () => {
  const ac = new AbortController(); ac.abort();
  const msg = await piAi.retryAssistantCall(
    async () => ({ stopReason: "error", errorMessage: "timeout" }),
    { enabled: true, maxRetries: 3, baseDelayMs: 1 }, ac.signal, undefined);
  return { ok: msg.stopReason === "aborted" && !("errorMessage" in msg), actual: msg };
});
safe("R4 aborted 永不重试", () => piAi.isRetryableAssistantError({ stopReason: "aborted", errorMessage: "timeout" }) === false);

// ── overflow（O1-O8）────────────────────────────────────────────────────
safe("O1 z.ai 静默溢出保留", () => piAi.isContextOverflow({ stopReason: "stop", usage: { input: 200000, cacheRead: 0 } }, 128000) === true);
safe("O2 Xiaomi length-stop 保留", () => piAi.isContextOverflow({ stopReason: "length", usage: { input: 127000, cacheRead: 0, output: 0 } }, 128000) === true);
safe("O3 idle 合成消息不判溢出", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: idle }, 128000) === false);
safe("O4 NON_OVERFLOW 优先", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: "429 rate limit: prompt is too long" }, 128000) === false);
safe("O5 bodyless 400 非 Cerebras 不判溢出(P2)", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: "400 status code (no body)", provider: "deepseek" }, 128000) === false);
safe("O6 bodyless 400 Cerebras 仍判(P2)", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: "400 status code (no body)", provider: "cerebras" }, 128000) === true);
safe("O7 z.ai 1261 Prompt too long 判溢出(P2)", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: '{"code":"1261","message":"Prompt too long"}' }, 128000) === true);
safe("O8 Anthropic prompt is too long 判溢出", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" }, 128000) === true);

// ── B3（B1-B5、B6a/b/c、B7）─────────────────────────────────────────────
const psj = piAi.parseStreamingJson;
safe("B1 headFenceFull 还原", () => eqJson(psj('```json\n{"cmd":"ls","path":"/tmp"}\n```'), { cmd: "ls", path: "/tmp" }));
safe("B1 headFencePartial 还原", () => eqJson(psj('```json\n{"cmd":"ls","path":"/tm'), { cmd: "ls", path: "/tm" }));
safe("B1 barePartial 逐字节一致", () => eqJson(psj('{"cmd":"ls","path":"/tm'), { cmd: "ls", path: "/tm" }));
safe("B1 tailFenceFull 逐字节一致", () => eqJson(psj('{"cmd":"ls"}\n```'), { cmd: "ls" }));
safe("B1 tailJunk 逐字节一致", () => eqJson(psj('{"cmd":"ls"}\nSome trailing prose'), { cmd: "ls" }));
safe("B2 半程完整前缀", () => eqJson(psj('```json\n{"cmd":"ls","path":"/tm'), { cmd: "ls", path: "/tm" }));
safe("B3 无语言标号", () => eqJson(psj('```\n{"a":1}'), { a: 1 }));
safe("B4 围栏后无换行", () => eqJson(psj('```json {"a":1}'), { a: 1 }));
safe("B5 纯围栏终止", () => eqJson(psj("```"), {}) && eqJson(psj("```json"), {}) && eqJson(psj("```json\n"), {}));
safe("B6a 值内围栏·真实换行半程帧={}（改前改后一致）", () => eqJson(psj('{"code":"print()\n```'), {}));
safe("B6b 值内围栏·转义换行={code:print()\\n```}", () => eqJson(psj('{"code":"print()\\n```'), { code: "print()\n```" }));
safe("B6c 终态={code:print()\\n```}", () => eqJson(psj('{"code":"print()\n```"}'), { code: "print()\n```" }));
safe("B7 双层围栏递归终止", () => eqJson(psj('```json\n```json\n{"a":1}'), { a: 1 }));

// ── P1（E1-E4）─────────────────────────────────────────────────────────
async function drain(Cls, objs) {
  const s = new Cls(); const out = [];
  for (const o of objs) s.push(o);
  s.end({ ok: true });
  for await (const ev of s) out.push(ev);
  return { out, res: await s.result() };
}
// E1：同一批对象喂两个实现，逐序比【对象身份】
await safeA("E1 顺序/对象身份等价(10001 事件)", async () => {
  const objs = Array.from({ length: 10001 }, (_, i) => ({ type: "e", i }));
  const a = await drain(pristine.AssistantMessageEventStream, objs);
  const b = await drain(piAi.AssistantMessageEventStream, objs);
  return { ok: a.out.length === b.out.length && a.out.every((e, i) => e === b.out[i]) && eqJson(a.res, b.res), actual: b.out.length };
});
// E2：零参构造 + push→end(result)→迭代收尾 + result()
await safeA("E2 零参构造+end(result)+迭代收尾+result()", async () => {
  const s = new piAi.AssistantMessageEventStream();
  s.push({ type: "e", v: 1 }); s.push({ type: "e", v: 2 }); s.end({ ok: true });
  const seen = []; for await (const ev of s) seen.push(ev);
  const res = await s.result();
  return { ok: seen.length === 2 && seen[1].v === 2 && eqJson(res, { ok: true }), actual: { n: seen.length, res } };
});
// E3：等待者即时唤醒 + 双等待者 end() 唤醒不挂死
await safeA("E3 等待者即时唤醒", async () => {
  const s = new piAi.AssistantMessageEventStream();
  const got = (async () => { for await (const ev of s) return ev; })();
  s.push({ type: "e", v: 1 });
  return { ok: (await got).v === 1 };
});
await safeA("E3 双等待者 end() 唤醒不挂死", async () => {
  const s = new piAi.AssistantMessageEventStream();
  const c1 = (async () => { for await (const _ of s) {} return "c1-done"; })();
  const c2 = (async () => { for await (const _ of s) {} return "c2-done"; })();
  s.push({ type: "e", v: 1 });
  s.end();
  const r = await Promise.race([
    Promise.all([c1, c2]).then((x) => x.join(",")),
    new Promise((res) => setTimeout(() => res("TIMEOUT-HANG"), 3000)),
  ]);
  return { ok: r !== "TIMEOUT-HANG", actual: r };
});
// E4：50k 事件 ×2 实现交替各 3 次取中位（先 1 轮 JIT 预热）；门槛外仅记录不判红（兜底=顺序等价）
await safeA("E4 性能对照(记录型)", async () => {
  const med = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const bench = async (Cls) => {
    const s = new Cls(); const t0 = performance.now();
    for (let i = 0; i < 50000; i++) s.push({ i });
    s.end(); for await (const _ of s);
    return performance.now() - t0;
  };
  const O = pristine.AssistantMessageEventStream, N = piAi.AssistantMessageEventStream;
  await bench(O); await bench(N);                       // JIT 预热 1 轮
  const tsO = [], tsN = [];
  for (let k = 0; k < 3; k++) { tsO.push(await bench(O)); tsN.push(await bench(N)); }
  const tOld = med(tsO), tNew = med(tsN), ratio = tOld / tNew;
  const gate = ratio >= 10 && tNew < 50;
  // 记录型：门槛（比值≥10 且新实现中位<50ms）达标记 gate=true；门槛外仅记录不判红（兜底=顺序等价，E1 已钉）
  return { ok: true, actual: { tOld: +tOld.toFixed(1), tNew: +tNew.toFixed(1), ratio: +ratio.toFixed(2), gate, note: gate ? "门槛达标" : "门槛外仅记录(顺序等价由 E1 钉)" } };
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
