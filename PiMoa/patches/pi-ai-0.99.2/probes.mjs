#!/usr/bin/env node
// probes.mjs — pi-ai 0.99.2 补丁批回归探针 [v3：仅 B3 + PiMoa 依赖的上游不变量]
// 运行：node --experimental-import-meta-resolve patches/pi-ai-0.99.2/probes.mjs（cd 仓根；路径自解析）
//       ★必须带该 flag：W1a/W1b 用两参 import.meta.resolve(spec, parentURL)。
// 退出码：0=全 PASS；1=有 FAIL。
// 相对 0.84.1 批 probes.mjs 的取舍：
//   · 删 P1–P4 的双态断言（R0–R4、O5–O7、I2x 的 P4 新增三项、E1/E4 对 0.84.1 基线对照）——0.99.2 上游已含这些修复，
//     补丁退役后它们不再是「补丁在不在」的信号；
//   · 保留 W1（补丁目标 dist = 消费方实际加载的副本）、I1x/I2x 与 O3（PiMoa idle 合成消息的重试/溢出契约）、
//     E2/E3（EventStream 结构契约，session.ts 的 IdleGuardStream 依赖它）、B1–B7（B3 本体，缺 B3 时 5 条必红）。
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI_AI_ROOT = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai");
const DIST = join(PI_AI_ROOT, "dist");
const TARGET = join(DIST, "index.js");
const AGENT_SESSION = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
const AGENT_LOOP = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js");

let pass = 0, fail = 0;
const t = (name, ok, actual) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name} actual=${JSON.stringify(actual)}`); };
const pick = (name, r) => { if (r && typeof r === "object" && "ok" in r) t(name, r.ok, r.actual); else t(name, !!r); };
const safe = (name, fn) => { try { pick(name, fn()); } catch (e) { t(name, false, "THROW " + e.message); } };
const safeA = async (name, fn) => { try { pick(name, await fn()); } catch (e) { t(name, false, "THROW " + e.message); } };
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── V0 版本：本探针只对 pi-ai 0.99.2 有意义 ───────────────────────────────
safe("V0 目标 pi-ai 版本 = 0.99.2", () => {
  const v = JSON.parse(readFileSync(join(PI_AI_ROOT, "package.json"), "utf8")).version;
  return { ok: v === "0.99.2", actual: v };
});

const piAi = await import(pathToFileURL(TARGET).href);

// ── W1a/W1b 副本防伪：消费方裸说明符解析必须落在补丁目标 dist ──────────────
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

// ── I1x/I2x：PiMoa idle 合成消息可重试、配额类不可重试（session.ts idleTimeoutErrorMessage 契约）──
const idle = "stream idle timeout: no stream event for 540000ms";
const isRetry = (m) => piAi.isRetryableAssistantError({ stopReason: "error", errorMessage: m });
safe("I1x idle 合成消息可重试", () => isRetry(idle) === true);
safe("I2x quota exceeded 不可重试", () => isRetry("quota exceeded") === false);
safe("I2x insufficient_quota 不可重试", () => isRetry("insufficient_quota") === false);
safe("I2x billing 不可重试", () => isRetry("billing") === false);
safe("I2x aborted 永不重试", () => piAi.isRetryableAssistantError({ stopReason: "aborted", errorMessage: "timeout" }) === false);
safe("O3 idle 合成消息不判溢出", () => piAi.isContextOverflow({ stopReason: "error", errorMessage: idle }, 128000) === false);

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

// ── E2/E3：EventStream 结构契约（session.ts IdleGuardStream / newEventStreamLike 依赖）──────
await safeA("E2 零参构造+end(result)+迭代收尾+result()", async () => {
  const s = new piAi.AssistantMessageEventStream();
  s.push({ type: "e", v: 1 }); s.push({ type: "e", v: 2 }); s.end({ ok: true });
  const seen = []; for await (const ev of s) seen.push(ev);
  const res = await s.result();
  return { ok: seen.length === 2 && seen[1].v === 2 && eqJson(res, { ok: true }), actual: { n: seen.length, res } };
});
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

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
