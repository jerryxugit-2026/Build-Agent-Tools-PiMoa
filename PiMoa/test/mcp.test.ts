/**
 * MCP 前门测试（确定性单测，脱网、脱 key）。
 *
 * 运行：
 *   npx tsx test/mcp.test.ts
 *
 * 直调 tools.runMoaTool（transport 无关），用 runSessionImpl mock 注入（复用 moa.test 思路）。
 * 用例：
 *   1) moa_run（mock）：status=ok、structuredContent 结构正确、content 文本含最终答案、isError 缺省。
 *   2) moa_verify（mock）：走 verify preset（receipt.mode=verify、profile=verify-worker）。
 *   3) onStageEvent：收集事件，断言各阶段齐全（proposer started×2/done×2 + quorum gathered + aggregator started/done）。
 *   4) fail-closed（mock）：proposer 空正文 → status=failed、isError=true、含 quorum failed 事件。
 *   5) signal abort：预取消 → status=aborted、isError 缺省（不算协议错）。
 *   14) PIMOA-DEF-01：verify 空材料 + submit.required=true → 入口 config 失败（判据 1，零模型调用）；
 *       moa_run 空材料不拦（判据 3）；jevcheck.enabled=false 时 verify 空材料不拦（判据 4）。
 *   15) PIMOA-DEF-01 归因错位：verify + 未知 preset + 空材料 → 报「preset 未找到」而非「材料为空」。
 */
import type { MoaConfig, WorkerRef } from "../src/config/types.js";
import type { MoaResult } from "../src/moa/types.js";
import type { RunSessionImpl } from "../src/moa/orchestrate.js";
import type { SessionRunResult } from "../src/moa/session.js";
import type { StageEvent } from "../src/mcp/events.js";
import { stageEventToNotification } from "../src/mcp/events.js";
import {
  runMoaTool,
  runMoaDeliverTool,
  buildRequest,
  MOA_RUN_DESCRIPTION,
  toSlimPayload,
  RESPONSE_STRUCT_AGG_BUDGET_CHARS,
  type MoaToolInput,
  moaToolOutput,
} from "../src/mcp/tools.js";
import { z } from "zod";
import { moaToolInput } from "../src/mcp/tools.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PIMOA_SPOOL_DIR = mkdtempSync(join(tmpdir(), "pimoa-spool-test-"));

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
function log(...a: unknown[]): void {
  console.log("[mcp-test]", ...a);
}

// ---------- mock 基建（同 moa.test）----------
function mkResult(p: Partial<SessionRunResult>): SessionRunResult {
  return {
    text: "",
    usage: null,
    costUsd: 0,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    sawAgentEnd: false,
    ...p,
  };
}

function makeMockRunSession(
  responses: Record<string, SessionRunResult | SessionRunResult[]>,
): RunSessionImpl {
  const cursor: Record<string, number> = {};
  return (async (_mr, worker: WorkerRef, _prompt, _opts) => {
    const key = `${worker.provider}/${worker.model}`;
    const entry = responses[key];
    if (entry === undefined) throw new Error(`mock 缺 ${key} 的返回`);
    if (Array.isArray(entry)) {
      const i = cursor[key] ?? 0;
      cursor[key] = i + 1;
      return entry[Math.min(i, entry.length - 1)];
    }
    return entry;
  }) as RunSessionImpl;
}

/** 内联配置：含 default（synthesize）+ moa_verify（verify，只读 profile）两个 preset。 */
function makeConfig(): MoaConfig {
  return {
    providers: {
      cliproxy: { kind: "openai", baseUrl: "http://127.0.0.1:8317/v1", apiKeyEnv: "CLIPROXY_API_KEY" },
      minimax: { kind: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic", apiKeyEnv: "MINIMAX_API_KEY" },
      xiaomi: { kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_API_KEY" },
    },
    presets: {
      default: {
        mode: "synthesize",
        quorum: "all",
        proposers: [
          { provider: "minimax", model: "MiniMax-M3", profile: "synthesize-worker" },
          { provider: "xiaomi", model: "mimo-v2.5-pro", profile: "synthesize-worker" },
        ],
        aggregator: { provider: "cliproxy", model: "gpt-5.5", profile: "synthesize-worker" },
      },
      moa_verify: {
        mode: "verify",
        quorum: "all",
        proposers: [
          { provider: "minimax", model: "MiniMax-M3", profile: "verify-worker" },
          { provider: "xiaomi", model: "mimo-v2.5-pro", profile: "verify-worker" },
        ],
        aggregator: { provider: "cliproxy", model: "gpt-5.5", profile: "verify-worker" },
      },
    },
    timeouts: { referencePerCallMs: 180000, aggregatorPerCallMs: 480000, moaTotalBackstopMs: 720000 },
    defaults: { preset: "default" },
  };
}

function okMock(): RunSessionImpl {
  return makeMockRunSession({
    "minimax/MiniMax-M3": mkResult({ text: "提议A", sawAgentEnd: true, usage: { input: 10, output: 20, totalTokens: 30 } }),
    "xiaomi/mimo-v2.5-pro": mkResult({ text: "提议B", sawAgentEnd: true, usage: { input: 12, output: 18, totalTokens: 30 } }),
    "cliproxy/gpt-5.5": mkResult({ text: "综合最终答案：万有引力…", sawAgentEnd: true, usage: { input: 40, output: 30, totalTokens: 70 } }),
  });
}

const input = (p: Partial<MoaToolInput> = {}): MoaToolInput => ({ prompt: "解释万有引力。", ...p });

// ---------- 用例 1：moa_run OK ----------
async function testRunOk(): Promise<void> {
  log("=== 用例 1：moa_run 正例（mock）===");
  const resp = await runMoaTool(input(), "default", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: okMock(),
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`status=${r.status} isError=${resp.isError} text0=${JSON.stringify(resp.content[0].text.slice(0, 40))}`);
  assert(r.status === "ok", "status === ok");
  assert(resp.isError === undefined, "ok 时 isError 缺省（非错误）");
  assert(resp.content[0].type === "text", "content[0] 是 text");
  assert(resp.content[0].text.includes("综合最终答案"), "content 文本含最终答案");
  assert(resp.content[0].text.includes("[moa ok]"), "content 文本含 receipt 元信息行");
  assert(r.proposals.length === 2 && r.proposals.every((p) => p.ok), "2 个 proposal 全 ok");
  assert(r.receipt.mode === "synthesize", "receipt.mode === synthesize");
  assert(r.receipt.quorum === "2/2", "receipt.quorum === 2/2");
  assert(/^[0-9a-f]{64}$/.test(r.receipt.bodySha256), "bodySha256 64 位 hex");
}

// ---------- 用例 2：moa_verify 走 verify preset ----------
async function testVerifyPreset(): Promise<void> {
  log("=== 用例 2：moa_verify 走 verify preset（mock）===");
  const resp = await runMoaTool(input({ prompt: "核验：该函数是否处理空数组。" }), "moa_verify", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: okMock(),
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`mode=${r.receipt.mode} preset=${r.receipt.preset} profile=${r.receipt.profile}`);
  assert(r.status === "ok", "status === ok");
  assert(r.receipt.mode === "verify", "receipt.mode === verify（用了 moa_verify preset）");
  assert(r.receipt.preset === "moa_verify", "receipt.preset === moa_verify");
  assert(r.receipt.profile === "verify-worker", "receipt.profile === verify-worker（只读）");
  // buildRequest 默认 preset 兜底验证。
  const req = buildRequest(input(), "moa_verify");
  assert(req.preset === "moa_verify", "buildRequest 默认 preset 兜底为 moa_verify");
  const reqOverride = buildRequest(input({ preset: "default" }), "moa_verify");
  assert(reqOverride.preset === "default", "buildRequest 显式 preset 覆盖默认");
}

// ---------- 用例 3：onStageEvent 阶段齐全 ----------
async function testStageEvents(): Promise<void> {
  log("=== 用例 3：onStageEvent 分阶段事件齐全 ===");
  const events: StageEvent[] = [];
  const resp = await runMoaTool(input(), "default", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: okMock(),
    onStageEvent: (e) => events.push(e),
  });
  const seq = events.map((e) =>
    e.stage === "proposer"
      ? `proposer:${e.phase}`
      : e.stage === "quorum"
        ? `quorum:${e.phase}`
        : `aggregator:${e.phase}`,
  );
  log(`事件序列(${events.length}): ${seq.join(" → ")}`);
  const count = (s: string) => seq.filter((x) => x === s).length;
  assert((resp.structuredContent as unknown as MoaResult).status === "ok", "status === ok");
  assert(count("proposer:started") === 2, "proposer:started ×2");
  assert(count("proposer:done") === 2, "proposer:done ×2");
  assert(count("quorum:gathered") === 1, "quorum:gathered ×1");
  assert(count("aggregator:started") === 1, "aggregator:started ×1");
  assert(count("aggregator:done") === 1, "aggregator:done ×1");
  // 顺序不变量：quorum gathered 在两个 proposer done 之后、aggregator started 之前。
  const iQuorum = seq.indexOf("quorum:gathered");
  const iAggStart = seq.indexOf("aggregator:started");
  assert(iQuorum < iAggStart, "quorum gathered 在 aggregator started 之前");
  // 通知渲染 smoke：每条能转成 notifications/message。
  const notif = stageEventToNotification(events[events.length - 1]);
  assert(notif.method === "notifications/message" && typeof notif.params.data === "string", "stageEventToNotification 产出合法通知");
}

// ---------- 用例 4：fail-closed（空正文）----------
async function testFailClosed(): Promise<void> {
  log("=== 用例 4：fail-closed（proposer 空正文）→ failed + isError ===");
  const events: StageEvent[] = [];
  const mock = makeMockRunSession({
    "minimax/MiniMax-M3": mkResult({ text: "有正文", sawAgentEnd: true }),
    "xiaomi/mimo-v2.5-pro": mkResult({ text: "   ", sawAgentEnd: true }), // 空正文
    "cliproxy/gpt-5.5": mkResult({ text: "不该被调用", sawAgentEnd: true }),
  });
  const resp = await runMoaTool(input(), "default", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: mock,
    onStageEvent: (e) => events.push(e),
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`status=${r.status} isError=${resp.isError} error.stage=${r.error?.stage}`);
  assert(r.status === "failed", "status === failed");
  assert(resp.isError === true, "failed 时 isError === true");
  assert(r.error?.stage === "proposer", "error.stage === proposer");
  assert(r.aggregated === "", "aggregated === '' （未产出）");
  assert(resp.content[0].text.includes("[moa failed]"), "content 文本含 failed 摘要");
  assert(events.some((e) => e.stage === "quorum" && e.phase === "failed"), "含 quorum failed 事件");
  assert(!events.some((e) => e.stage === "aggregator"), "aggregator 未起（无 aggregator 事件）");
}

// ---------- 用例 5：signal abort ----------
async function testAbort(): Promise<void> {
  log("=== 用例 5：signal 预取消 → aborted ===");
  const ac = new AbortController();
  ac.abort();
  const resp = await runMoaTool(input(), "default", {
    config: makeConfig(),
    modelRuntime: null,
    signal: ac.signal,
    runSessionImpl: okMock(),
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`status=${r.status} isError=${resp.isError} error.stage=${r.error?.stage}`);
  assert(r.status === "aborted", "status === aborted");
  assert(resp.isError === undefined, "aborted 不算协议错误（isError 缺省）");
  assert(r.error?.stage === "abort", "error.stage === abort");
}

// ---------- 用例 6：MOA_RUN_DESCRIPTION 与实际只读能力一致（fix #10 / fix #4）----------
function testRunDescription(): void {
  log("=== 用例 6：MOA_RUN_DESCRIPTION 不再宣称可执行代码 + 声明拒 verify preset（fix #4）===");
  assert(
    !/要跑测试\/执行代码请用本工具|执行代码请用本工具/.test(MOA_RUN_DESCRIPTION),
    "描述不再宣称“要跑测试/执行代码用本工具”",
  );
  assert(/只读/.test(MOA_RUN_DESCRIPTION), "描述明确“只读”");
  assert(
    /不执行代码|不跑测试|不写文件/.test(MOA_RUN_DESCRIPTION),
    "描述声明不执行代码/不跑测试/不写文件",
  );
  assert(
    /只支持 synthesize|拒绝|verify/.test(MOA_RUN_DESCRIPTION),
    "描述声明只支持 synthesize preset / 拒绝 verify preset（能力与描述一致）",
  );
}

// ---------- 用例 9：moa_run 拒绝 verify preset（越界提权修复，fix #4）----------
async function testRunRejectsVerifyPreset(): Promise<void> {
  log("=== 用例 9：moa_run 传 verify preset → 拒绝（status:failed, stage:config）（fix #4）===");
  let aggregatorCalled = false;
  const spyMock: RunSessionImpl = (async (_mr, worker: WorkerRef) => {
    if (worker.provider === "cliproxy") aggregatorCalled = true;
    return mkResult({ text: "不该被调用", sawAgentEnd: true });
  }) as RunSessionImpl;
  // 模拟 moa_run（defaultPreset=default，synthesize），调用方用 preset 覆盖成 moa_verify（verify）。
  const resp = await runMoaTool(input({ preset: "moa_verify" }), "default", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: spyMock,
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`status=${r.status} isError=${resp.isError} stage=${r.error?.stage} reason=${r.error?.reason}`);
  assert(r.status === "failed", "status === failed（verify preset 被拒）");
  assert(resp.isError === true, "isError === true");
  assert(r.error?.stage === "config", "error.stage === config");
  assert(/verify|越界|synthesize/.test(r.error?.reason ?? ""), "reason 说明模式越界");
  assert(r.aggregated === "", "未产出");
  assert(!aggregatorCalled, "会话未启动（没有落到沙箱 bash_readonly）");
}

// ---------- 用例 10：moa_verify 锁死 verify、拒 synthesize preset（fix #4）----------
async function testVerifyRejectsSynthesizePreset(): Promise<void> {
  log("=== 用例 10：moa_verify 传 synthesize preset → 拒绝（强制 verify）（fix #4）===");
  const resp = await runMoaTool(input({ preset: "default" }), "moa_verify", {
    config: makeConfig(),
    modelRuntime: null,
    runSessionImpl: okMock(),
  });
  const r = resp.structuredContent as unknown as MoaResult;
  log(`status=${r.status} stage=${r.error?.stage}`);
  assert(r.status === "failed", "status === failed（moa_verify 拒 synthesize preset）");
  assert(r.error?.stage === "config", "error.stage === config");
  // 反向确认：moa_verify 用自身 verify preset 仍正常（用例 2 已覆盖，这里再确认默认不受影响）。
  const ok = await runMoaTool(input(), "moa_verify", { config: makeConfig(), modelRuntime: null, runSessionImpl: okMock() });
  assert((ok.structuredContent as unknown as MoaResult).status === "ok", "moa_verify 默认 verify preset 仍 ok");
}

// ---------- 用例 14：PIMOA-DEF-01 —— verify 空材料入口 fail-fast（判据 1/3/4）----------
/** 计数桩：任何一次会话启动都 +1（用来断言「没有发生任何模型调用」）。 */
function countingMock(): { impl: RunSessionImpl; calls: () => number } {
  let n = 0;
  const impl = (async () => {
    n++;
    return mkResult({ text: "桩返回", sawAgentEnd: true });
  }) as RunSessionImpl;
  return { impl, calls: () => n };
}

/** 内存直构 config + jevcheck 段（makeConfig 无该段 ⇒ 按 orchestrate 惯例视同 enabled=false）。 */
function makeConfigWithJev(enabled: boolean, submitRequired: boolean): MoaConfig {
  return { ...makeConfig(), jevcheck: { enabled, submit: { required: submitRequired } } as any };
}

async function testVerifyEmptyMaterialsFailFast(): Promise<void> {
  log("=== 用例 14：PIMOA-DEF-01 verify 空材料入口 fail-fast（判据 1/3/4）===");
  // 判据 1：verify + 空材料 + submit.required=true ⇒ 立即 config 失败，且零模型调用。
  const c1 = countingMock();
  const t0 = Date.now();
  const resp1 = await runMoaTool(input({ prompt: "核验：该函数是否处理空数组。" }), "moa_verify", {
    config: makeConfigWithJev(true, true),
    modelRuntime: null,
    runSessionImpl: c1.impl,
  });
  const ms1 = Date.now() - t0;
  const r1 = resp1.structuredContent as unknown as MoaResult;
  log(`(1) status=${r1.status} isError=${resp1.isError} stage=${r1.error?.stage} 模型调用=${c1.calls()} 耗时=${ms1}ms`);
  assert(r1.status === "failed", "(1) 空材料 verify → status === failed");
  assert(resp1.isError === true, "(1) isError === true");
  assert(r1.error?.stage === "config", "(1) error.stage === config");
  assert(r1.aggregated === "", "(1) 未产出（aggregated === ''）");
  assert(/材料为空/.test(r1.error?.reason ?? ""), "(1) reason 说明「材料为空」");
  assert(
    /files \/ files_ranges \/ recon_query/.test(r1.error?.reason ?? ""),
    "(1) reason 含可操作指引（files / files_ranges / recon_query）",
  );
  assert(/moa_run/.test(r1.error?.reason ?? ""), "(1) reason 指路 moa_run（确实无需材料时）");
  assert(c1.calls() === 0, "(1) ★没有任何模型调用（闸门在 runMoa 之前，不是跑满 3 次提交尝试才失败）");
  assert(ms1 < 1000, `(1) 毫秒级返回（实际 ${ms1}ms，不含任何模型调用）`);
  assert(!resp1.content[0].text.includes("[moa ok]"), "(1) content 文本不是 ok 摘要");

  // 判据 3：moa_run 空材料 ⇒ 行为不改（同样开着的硬门不影响 synthesize）：正常 synthesize 跑完。
  const resp3 = await runMoaTool(input(), "default", {
    config: makeConfigWithJev(true, true),
    modelRuntime: null,
    runSessionImpl: okMock(),
  });
  const r3 = resp3.structuredContent as unknown as MoaResult;
  log(`(3) status=${r3.status} mode=${r3.receipt.mode} quorum=${r3.receipt.quorum}`);
  assert(r3.status === "ok", "(3) moa_run 空材料 → 仍 ok（闸门只对 verify 生效）");
  assert(r3.receipt.mode === "synthesize", "(3) receipt.mode === synthesize");
  assert(r3.receipt.quorum === "2/2", "(3) 正常跑完（quorum 2/2）");

  // 判据 4：config.jevcheck.enabled=false 时 verify 空材料 ⇒ 不拦（保持既有可跑路径）。
  const c4 = countingMock();
  const resp4 = await runMoaTool(input({ prompt: "核验：该函数是否处理空数组。" }), "moa_verify", {
    config: makeConfigWithJev(false, true),
    modelRuntime: null,
    runSessionImpl: c4.impl,
  });
  const r4 = resp4.structuredContent as unknown as MoaResult;
  log(`(4) status=${r4.status} mode=${r4.receipt.mode} stage=${r4.error?.stage} 模型调用=${c4.calls()}`);
  assert(r4.status === "ok", "(4) jevcheck.enabled=false → 空材料 verify 不拦，整轮正常 ok");
  assert(r4.receipt.mode === "verify", "(4) receipt.mode === verify（走的仍是 verify preset）");
  assert(c4.calls() === 3, `(4) 2 proposer + 1 aggregator 都已真跑（实际 ${c4.calls()} 次），反证闸门确实放行`);
}

// ---------- 用例 15：DEF-01 归因错位 —— 未知 preset 时材料闸必须让路 ----------
/**
 * 调用方同时给错 preset 和空材料时，材料闸若先开枪，会把调用方指去补材料（第一次往返），
 * 补完才被 runMoa 告知 preset 写错了（第二次往返）——两次归因错位。
 * 未知 preset ⇒ enforceVerifyMaterialsPresent 返回 null（放行），runMoa 报它自己的「preset 未找到」。
 */
async function testVerifyUnknownPresetNotBlamedOnMaterials(): Promise<void> {
  log("=== 用例 15：DEF-01 归因错位 —— verify + 未知 preset + 空材料 ⇒ 报「preset 未找到」而非「材料为空」 ===");
  const cfg = makeConfigWithJev(true, true); // 硬门确实开着：材料闸本来一定开枪
  const c = countingMock();
  const resp = await runMoaTool(input({ prompt: "核验：该函数是否处理空数组。", preset: "ghost_preset" }), "moa_verify", {
    config: cfg,
    modelRuntime: null,
    runSessionImpl: c.impl,
  });
  const r = resp.structuredContent as unknown as MoaResult;
  const reason = r.error?.reason ?? "";
  log(`status=${r.status} stage=${r.error?.stage} detail=${JSON.stringify(r.error?.detail)} reason=${JSON.stringify(reason)} 模型调用=${c.calls()}`);
  assert(r.status === "failed", "未知 preset + 空材料 ⇒ status === failed");
  assert(r.error?.stage === "config", "error.stage === config");
  assert(/preset 未找到/.test(reason), "★reason 含「preset 未找到」（真错露出来）");
  assert(!/材料为空/.test(reason), "★reason 不含「材料为空」（材料闸已让路，不再掩盖真错）");
  assert(/ghost_preset/.test(r.error?.detail ?? ""), "detail 指名写错的 preset");
  assert(c.calls() === 0, "零模型调用（未知 preset 在进模型前就失败）");

  // 反向确认：已知 preset + 空材料仍然被材料闸拦住（本用例没有把 DEF-01 的闸整体放开）。
  const c2 = countingMock();
  const resp2 = await runMoaTool(input({ prompt: "核验：该函数是否处理空数组。" }), "moa_verify", {
    config: cfg,
    modelRuntime: null,
    runSessionImpl: c2.impl,
  });
  const r2 = resp2.structuredContent as unknown as MoaResult;
  log(`（反向）status=${r2.status} stage=${r2.error?.stage} reason=${JSON.stringify(r2.error?.reason ?? "")}`);
  assert(/材料为空/.test(r2.error?.reason ?? ""), "反向：已知 preset + 空材料仍报「材料为空」（闸照常生效）");
  assert(c2.calls() === 0, "反向：零模型调用");
}

const DMARK = "DONE_X";
function deliverMock(body: string): RunSessionImpl {
  return makeMockRunSession({
    "minimax/MiniMax-M3": mkResult({ text: "A", sawAgentEnd: true }),
    "xiaomi/mimo-v2.5-pro": mkResult({ text: "B", sawAgentEnd: true }),
    "cliproxy/gpt-5.5": mkResult({ text: body, sawAgentEnd: true }),
  });
}

// ---------- 用例 7：deliver allowedRoots 必填、不回退 cwd（fix #4）----------
async function testDeliverAllowedRootsRequired(): Promise<void> {
  log("=== 用例 7：deliver allowedRoots 缺省 → 拒绝、不回退 cwd（fix #4）===");
  const root = mkdtempSync(join(tmpdir(), "pimoa-mcp-del-"));
  try {
    const target = join(root, "out.md");
    // 显式传 cwd=root 但不传 allowedRoots：修复后不再回退到 cwd → 拒写。
    const resp = await runMoaDeliverTool(
      { prompt: "x", path: target, done_marker: DMARK, cwd: root },
      "default",
      { config: makeConfig(), modelRuntime: null, runSessionImpl: deliverMock(`正文\n${DMARK}\n`) },
    );
    const r = resp.structuredContent as unknown as MoaResult;
    log(`status=${r.status} stage=${r.error?.stage}`);
    assert(r.status === "failed", "无 allowedRoots → status failed（不回退 cwd）");
    assert(r.error?.stage === "delivery", "error.stage === delivery");
    assert(!existsSync(target), "未写盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- 用例 8：deliver jail 排除安装目录、工作区内正常（fix #3）----------
async function testDeliverJailExcludesInstallDir(): Promise<void> {
  log("=== 用例 8：deliver 拒写安装目录、工作区内正常（fix #3）===");
  const ws = mkdtempSync(join(tmpdir(), "pimoa-ws-"));
  const install = join(ws, "install"); // 模拟安装目录落在工作区内（最险的情形）
  mkdirSync(join(install, "src"), { recursive: true });
  try {
    const body = `报告\n${DMARK}\n`;
    // (a) 目标在安装目录内 → 拒（即便 allowedRoots=[ws] 覆盖它）。
    const evil = join(install, "src", "x.ts");
    const respEvil = await runMoaDeliverTool(
      { prompt: "x", path: evil, done_marker: DMARK, cwd: ws },
      "default",
      {
        config: makeConfig(),
        modelRuntime: null,
        runSessionImpl: deliverMock(body),
        allowedRoots: [ws],
        denyRoots: [install],
      },
    );
    const re = respEvil.structuredContent as unknown as MoaResult;
    log(`evil status=${re.status} stage=${re.error?.stage}`);
    assert(re.status === "failed", "写安装目录内 → failed");
    assert(re.error?.stage === "delivery", "stage delivery");
    assert(/安装目录|denyRoot/.test(re.error?.reason ?? ""), "reason 指出落在安装目录");
    assert(!existsSync(evil), "安装目录内文件未被写（保护自身源码）");

    // (b) 工作区内普通目标 → 正常写。
    const okTarget = join(ws, "report.md");
    const respOk = await runMoaDeliverTool(
      { prompt: "x", path: okTarget, done_marker: DMARK, cwd: ws },
      "default",
      {
        config: makeConfig(),
        modelRuntime: null,
        runSessionImpl: deliverMock(body),
        allowedRoots: [ws],
        denyRoots: [install],
      },
    );
    const ro = respOk.structuredContent as unknown as MoaResult;
    log(`ok status=${ro.status} delivery=${JSON.stringify(ro.receipt.delivery)}`);
    assert(ro.status === "ok", "工作区内目标 → ok");
    assert(existsSync(okTarget), "工作区内文件已写盘");
    assert(ro.receipt.delivery?.written === true, "receipt.delivery.written === true");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// ---------- 用例 11：§4.3 aggregator_max_tool_calls 入参:zod 只降不升(≤5),0/6 拒;buildRequest 透传 ----------
function testAggregatorMaxToolCallsSchema(): void {
  log("=== 用例 11：aggregator_max_tool_calls zod 合法域 1..5,超过 5 直接 config 拒、0 拒（§4.3）===");
  const schema = z.object(moaToolInput);
  assert(schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 3 }).success, "=3 合法");
  assert(schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 5 }).success, "=5 合法(上界)");
  assert(schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 1 }).success, "=1 合法(下界)");
  assert(!schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 6 }).success, "★=6 被拒(不接受放大,硬顶 10 也不给聚合器用)");
  assert(!schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 0 }).success, "=0 被拒");
  assert(!schema.safeParse({ prompt: "x", aggregator_max_tool_calls: 2.5 }).success, "非整数被拒");
  assert(schema.safeParse({ prompt: "x", max_tool_calls: 2 }).success, "max_tool_calls=2 仍合法(proposer 档语义不变)");
  const req = buildRequest({ prompt: "x", max_tool_calls: 2, aggregator_max_tool_calls: 3 }, "default");
  assert(req.maxToolCalls === 2 && req.aggregatorMaxToolCalls === 3, "buildRequest 分别透传 maxToolCalls/aggregatorMaxToolCalls");
  assert(!("aggregatorMaxToolCalls" in buildRequest({ prompt: "x" }, "default")), "缺省不注入 aggregatorMaxToolCalls");
  // 描述漂移消除:max_tool_calls 不再说「轮数」,改说「调用次数」且注明并行逐个计数。
  const desc = (moaToolInput.max_tool_calls as any).description as string;
  assert(!/轮数/.test(desc) && /调用次数/.test(desc) && /逐个计数/.test(desc), "max_tool_calls 描述改为「取证调用次数上限…逐个计数」");
  const adesc = (moaToolInput.aggregator_max_tool_calls as any).description as string;
  assert(/缺省 5/.test(adesc) && /≤5/.test(adesc) && /不受牵连/.test(adesc), "aggregator_max_tool_calls 描述写明缺省 5、只能 ≤5、用途");
}

// ---------- 用例 12：Jev 辅助代码审查（设计 v4 §3.7，第三波 b）findings_summary/verdicts_summary 受 8,000 预算 ----------
/** 拼一份带 N 条 findings + M 条 verdicts 的最小 MoaResult（其余字段给最保守占位）。 */
function makeJevSummaryResult(n: number, m: number, longPath: boolean): MoaResult {
  const findings = Array.from({ length: n }, (_, i) => ({
    id: `F${i + 1}`,
    kind: "finding" as const,
    // 每 10 条掺一条 BLOCKER，验证「BLOCKER 优先保留」不被普通 MINOR 挤掉。
    level: (i % 10 === 0 ? "BLOCKER" : "MINOR") as "BLOCKER" | "MINOR",
    path: longPath ? `internal/very/long/nested/package/path/for/budget/test/file_${i}.go` : `f${i}.go`,
    lines: `${i + 1}-${i + 20}`,
    anchor: "anchorText",
    facts: ["通用事实：示例事实占位文本，用于撑体积"],
    claim: "示例 claim 占位文本，用于撑体积以触发预算裁剪逻辑的边界情形测试",
    fix_expect: "示例修复占位文本",
    strength: "推理" as const,
    pid: `P1/F${i + 1}`,
    proposerIndex: 0,
    proposerModel: "minimax/MiniMax-M3",
  }));
  const verdicts = Array.from({ length: m }, (_, i) => ({
    finding_ids: [`P1/F${i + 1}`],
    level: (i % 10 === 0 ? "BLOCKER" : "MINOR") as "BLOCKER" | "MINOR",
    can_happen: "能" as const,
    consequence: "静默失败" as const,
    trigger: "常态触发" as const,
    strength: "推理" as const,
    reason: "示例裁决理由占位文本，用于撑体积以触发预算裁剪逻辑",
    evidence: `f${i}.go:${i + 1}`,
  }));
  // jevcheck.perFinding 全部给 ref:"OK"/正常 status，让 findings_summary 的优先级只由 level=BLOCKER
  // 决定（不掺 ref 异常这一路优先级），便于本用例单独验证「BLOCKER 优先」这一条。
  const perFinding: Record<string, unknown> = {};
  for (const f of findings) {
    perFinding[f.pid] = { ref: "OK", facts: [], entail: { p1: 1 }, status: "前提完备且全部相符", conditionFlag: false };
  }
  return {
    status: "ok",
    aggregated: "聚合正文",
    proposals: [],
    receipt: {
      mode: "verify",
      preset: "jev_verify",
      models: ["minimax/MiniMax-M3"],
      quorum: "1/1",
      profile: "verify-worker",
      proposerMarks: {},
      aggregator: { model: "cliproxy/gpt-5.6-luna", usage: null, costUsd: 0, durationMs: 1 },
      bodySha256: "a".repeat(64),
      totalCostUsd: 0,
      delivery: null,
      findings,
      jevcheck: {
        enabled: true,
        perFinding,
        duplicates: [],
        conflicts: [],
        oneSided: [],
        proposerQuality: {},
        totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
      } as any,
      verdicts: { verdicts, final: "示例最终裁决" as string, attempts: 1 } as any,
    } as any,
    error: null,
  };
}

function testJevSummariesBudget(): void {
  log("=== 用例 12：findings_summary/verdicts_summary 合计受 RESPONSE_STRUCT_AGG_BUDGET_CHARS（8,000）===");
  // (a) 条数少、总量远小于预算：不裁剪，条数与原始一致。
  const small = toSlimPayload(makeJevSummaryResult(3, 2, false));
  assert(small.findings_summary.length === 3, "(a) 未超预算：findings_summary 条数与原始一致（3）");
  assert(small.verdicts_summary.length === 2, "(a) 未超预算：verdicts_summary 条数与原始一致（2）");
  assert(!small.findings_summary.some((l) => l.includes("全文见 spool")), "(a) 未超预算：不出现「全文见 spool」标注");

  // (b) 用长路径撑大单行体积、条数拉到 200，必然超 8,000 字符预算，触发裁剪。
  const big = toSlimPayload(makeJevSummaryResult(200, 200, true));
  const combinedChars = [...big.findings_summary, ...big.verdicts_summary].reduce((s, l) => s + l.length, 0);
  log(`(b) findings_summary=${big.findings_summary.length} verdicts_summary=${big.verdicts_summary.length} combinedChars=${combinedChars}`);
  assert(big.findings_summary.length < 200, "(b) 超预算：findings_summary 被裁剪（条数少于原始 200）");
  // 波三 b 修复单第 8 条：「全文见 spool」标注行的字符开销已预扣进预算，合计须严格 ≤ 预算（不再留 +40 裕量）。
  assert(
    combinedChars <= RESPONSE_STRUCT_AGG_BUDGET_CHARS,
    `(b) 合计字符数严格 ≤ 预算 ${RESPONSE_STRUCT_AGG_BUDGET_CHARS}（实际 ${combinedChars}）`,
  );
  // BLOCKER 优先：每 10 条一个 BLOCKER，共 20 个 BLOCKER；裁剪后全部 BLOCKER 行都必须还在。
  const blockerCount = big.findings_summary.filter((l) => / BLOCKER /.test(l)).length;
  assert(blockerCount === 20, `(b) 全部 20 条 BLOCKER finding 行都被优先保留（实际 ${blockerCount}）`);
  assert(
    big.findings_summary.some((l) => l.includes("全文见 spool")) || big.verdicts_summary.some((l) => l.includes("全文见 spool")),
    "(b) 有裁剪时末尾出现「全文见 spool」标注",
  );
  // verdicts_summary 也须有内容保留（波三 b 修复单第 8 条：第二轮改两数组各分一半剩余额度，
  // 不再被 findings 的低优先级行整批挤空——此前 findings 排第二轮第一位会吃光共享预算池）。
  assert(big.verdicts_summary.length > 1, `(b) verdicts_summary 未被 findings 挤空（实际条数 ${big.verdicts_summary.length}）`);

  // (c) ref 非 OK 的 finding 优先保留：构造一批 ref:"OK" 的普通 MINOR 撑体积、外加几条 ref 非 OK
  // （锚点未命中）的 MINOR finding，裁剪后这几条须仍在（优先级由 level===BLOCKER || ref!=="OK" ||
  // status==="含不符前提" 三者之一决定，本例只触发 ref!=="OK" 这一支）。
  const withBadRef = makeJevSummaryResult(200, 0, true);
  // 特意选非 10 的倍数下标（level=MINOR，非 BLOCKER），确保命中的是「ref 非 OK」这一支优先级，
  // 不是「本来就是 BLOCKER」那一支。
  const badRefPids = ["P1/F2", "P1/F52", "P1/F152"];
  for (const pid of badRefPids) {
    const check = (withBadRef.receipt.jevcheck as any).perFinding[pid];
    check.ref = "锚点未命中";
  }
  const cWithBadRef = toSlimPayload(withBadRef);
  log(`(c) findings_summary.length=${cWithBadRef.findings_summary.length}`);
  assert(cWithBadRef.findings_summary.length < 200, "(c) 超预算：findings_summary 被裁剪");
  for (const pid of badRefPids) {
    assert(
      cWithBadRef.findings_summary.some((l) => l.startsWith(`${pid} `) && l.includes("锚点未命中")),
      `(c) ref 非 OK 的 finding ${pid} 被优先保留（不因非 BLOCKER 被普通 MINOR 挤掉）`,
    );
  }
}

/** 2026-09-20 DSH 会话实录：DSH 客户端严格校验 structuredContent 须符合 outputSchema，toSlimPayload 多回
 * findings_summary / verdicts_summary 而 moaToolOutput 漏列 ⇒ 三次调用全被拒收。这里用 strict 校验锁死。 */
function testOutputSchemaCoversSlimPayload(): void {
  log("=== 用例 13：toSlimPayload 的每个字段都在 moaToolOutput 里（strict，DSH 严格客户端不会拒收）===");
  const strict = z.object(moaToolOutput).strict();
  const okRes = toSlimPayload(makeJevSummaryResult(3, 2, false));
  const okParsed = strict.safeParse(okRes);
  assert(okParsed.success, `(a) jevcheck 开、ok 回包过 strict 校验：${okParsed.success ? "" : JSON.stringify(okParsed.error.issues.slice(0, 3))}`);
  const failedRes: MoaResult = {
    status: "failed",
    aggregated: "",
    proposals: [],
    receipt: { mode: "verify", preset: "moa_verify", models: [], quorum: "0/2", profile: "verify-worker", proposerMarks: {}, aggregator: { model: "x", usage: null, costUsd: 0, durationMs: 0 }, bodySha256: "", totalCostUsd: 0, delivery: null } as any,
    error: { stage: "proposer", reason: "x" },
  };
  const failedParsed = strict.safeParse(toSlimPayload(failedRes, "spool 写失败"));
  assert(failedParsed.success, `(b) failed + spoolError 回包过 strict 校验：${failedParsed.success ? "" : JSON.stringify(failedParsed.error.issues.slice(0, 3))}`);
  assert(Array.isArray(toSlimPayload(failedRes).findings_summary) && toSlimPayload(failedRes).findings_summary.length === 0, "(c) 未启用 jevcheck 时两字段为空数组（schema 声明为必填数组）");
}

/**
 * 用例 16（O2 hybrid modern 用例组，2026-09-30；§6.2 进入条件「真实 moaToolOutput 在 v2 下的 strict 行为必须实测」）。
 * 两层：
 *   16a–16c 进程内 v2（server 2.2.0 createMcpHandler + node 2.1.0 toNodeHandler，注册方式与 server.ts
 *     buildModernServer 相同：inputSchema=z.object(moaToolInput)、outputSchema=z.object(moaToolOutput)），
 *     回包走**真** runMoaTool（mock 会话，同用例 1）/ 真 toSlimPayload；客户端用**官方 client 2.0.0（auto）**——
 *     与 DSH rc.2 同一客户端，它按 tools/list 公布的 JSON Schema 严格校验 structuredContent（就是 2026-09-20
 *     DSH 拒收「data must NOT have additional properties」的那道校验）。
 *   16d–16e 真 server.ts（隔离端口）：两腿 tools/list 公布的 outputSchema 形状一致且都 additionalProperties:false；
 *     modern 腿真 tools/call 的 structuredContent 过 strict。
 */
async function testModernV2OutputSchemaStrict(): Promise<void> {
  log("=== 用例 16：O2 modern（SDK v2）下真实 moaToolOutput 的 strict 行为 ===");
  const { createMcpHandler, McpServer: V2McpServer } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const { createServer } = await import("node:http");
  const H = await import("./o2_hybrid_harness.js");

  const cfg = makeConfig();
  const jevOk = toSlimPayload(makeJevSummaryResult(3, 2, false)) as unknown as Record<string, unknown>;
  const factory = () => {
    const s = new V2McpServer({ name: "o2-mcp-test", version: "0" }, { capabilities: {} });
    const out = z.object(moaToolOutput);
    // 真执行体：runMoaTool + mock 会话（ok 回包，含 structuredContent）
    s.registerTool("moa_run", { inputSchema: z.object(moaToolInput), outputSchema: out }, async (args) =>
      (await runMoaTool(args as MoaToolInput, "default", { config: cfg, modelRuntime: {}, runSessionImpl: okMock() })) as never,
    );
    // Jev 辅助开启形态的 ok 回包（findings_summary/verdicts_summary 非空）
    s.registerTool("jev_ok", { inputSchema: z.object({}), outputSchema: out }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: jevOk,
    }));
    // 多一个未声明字段（2026-09-20 DSH 拒收同形）
    s.registerTool("extra_prop", { inputSchema: z.object({}), outputSchema: out }, async () => ({
      content: [{ type: "text" as const, text: "extra" }],
      structuredContent: { ...jevOk, bogus: 1 },
    }));
    // 少一个必填字段
    s.registerTool("missing_prop", { inputSchema: z.object({}), outputSchema: out }, async () => {
      const { findings_summary: _drop, ...rest } = jevOk;
      return { content: [{ type: "text" as const, text: "missing" }], structuredContent: rest };
    });
    return s;
  };
  const handler = createMcpHandler(factory, { legacy: "reject", responseMode: "sse", maxRequestBodySize: 8 * 1024 * 1024 });
  const node = toNodeHandler(handler);
  const srv = createServer((req, res) => void node(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const client = new Client({ name: "o2-mcp-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert(client.getProtocolEra() === "modern", `16 前提：client 2.0 auto 协商到 modern（${client.getProtocolEra()}）`);
    const tools = await client.listTools();
    const adv = tools.tools.find((t) => t.name === "moa_run")?.outputSchema as Record<string, unknown> | undefined;
    assert(adv?.additionalProperties === false, `16a v2 公布的 moaToolOutput JSON Schema 根 additionalProperties=false（实际 ${JSON.stringify(adv?.additionalProperties)}）`);

    // 16a 真 runMoaTool ok 回包：客户端严格校验通过
    let r: any;
    let err: unknown;
    try {
      r = await client.callTool({ name: "moa_run", arguments: { prompt: "解释万有引力。" } });
    } catch (e) {
      err = e;
    }
    assert(!err && r?.isError !== true && r?.structuredContent?.status === "ok",
      `16a 真 runMoaTool ok 回包在 v2 下过客户端 strict 校验：status=${r?.structuredContent?.status} err=${err ? String((err as Error).message).slice(0, 160) : "无"}`);
    err = undefined;
    try {
      r = await client.callTool({ name: "jev_ok", arguments: {} });
    } catch (e) {
      err = e;
    }
    assert(!err && Array.isArray(r?.structuredContent?.findings_summary) && r.structuredContent.findings_summary.length === 3,
      `16a Jev 开启形态 ok 回包（findings/verdicts_summary 非空）过 strict：err=${err ? String((err as Error).message).slice(0, 160) : "无"}`);

    // 16b 多一个未声明字段：v2 服务端 zod 放行（非 strict），但客户端按公布 schema 拒收 —— 即 DSH 形态 B 的根因形状
    err = undefined;
    try {
      await client.callTool({ name: "extra_prop", arguments: {} });
    } catch (e) {
      err = e;
    }
    const em = String((err as Error | undefined)?.message ?? "");
    assert(/additional properties/.test(em),
      `16b 多余字段 → 客户端 strict 拒收（${em.slice(0, 160) || "未拒收！"}）⇒ moaToolOutput 必须覆盖回包全部字段（用例 13 锁死）`);

    // 16c 少必填字段：v2 服务端输出校验先拦（Output validation error），不会把残缺回包当成功送出
    err = undefined;
    let mr: any;
    try {
      mr = await client.callTool({ name: "missing_prop", arguments: {} });
    } catch (e) {
      err = e;
    }
    const mtext = String((err as Error | undefined)?.message ?? JSON.stringify(mr?.content ?? ""));
    assert(/Output validation error/.test(mtext) && (err !== undefined || mr?.isError === true),
      `16c 缺必填字段 → v2 服务端输出校验拦截（${mtext.slice(0, 160)}）`);
  } finally {
    await client.close().catch(() => {});
    await handler.close();
    await new Promise<void>((r) => srv.close(() => r()));
  }

  // 16d–16e 真 server.ts（隔离端口）
  const h = await H.startHybrid();
  try {
    const ml = await H.modernPost(h.url, "tools/list", {});
    const hs = await H.legacyHandshake(h.url);
    const ll = await H.legacyPost(h.url, { jsonrpc: "2.0", id: H.newId(), method: "tools/list", params: {} }, hs.sid!);
    const pick = (tools: any[], n: string) => tools?.find((t) => t.name === n);
    for (const name of ["moa_run", "moa_verify", "moa_deliver"]) {
      const mo = pick(ml.msg?.result?.tools, name)?.outputSchema;
      const lo = pick(ll.msg?.result?.tools, name)?.outputSchema;
      const keys = (o: any) => JSON.stringify(Object.keys(o?.properties ?? {}).sort());
      const req = (o: any) => JSON.stringify([...(o?.required ?? [])].sort());
      assert(
        mo && lo && keys(mo) === keys(lo) && req(mo) === req(lo) && mo.additionalProperties === false && lo.additionalProperties === false,
        `16d 真 server.ts ${name}：modern/legacy 两腿公布的 outputSchema 属性集与 required 集一致，且都 additionalProperties=false`,
      );
      const mi = pick(ml.msg?.result?.tools, name)?.inputSchema;
      const li = pick(ll.msg?.result?.tools, name)?.inputSchema;
      assert(mi && li && keys(mi) === keys(li) && req(mi) === req(li),
        `16d 真 server.ts ${name}：两腿 inputSchema 属性集/required 一致（双注册单一真源）`);
    }
    // 16e modern 腿真 tools/call（verify 空材料闸，进模型前 fail-fast）：structuredContent 过 strict
    const call = await H.modernPost(h.url, "tools/call", { name: "moa_verify", arguments: { prompt: "x" } });
    const sc = call.msg?.result?.structuredContent;
    const sp = z.object(moaToolOutput).strict().safeParse(sc);
    assert(call.msg?.result?.isError === true && sc?.status === "failed" && sp.success,
      `16e 真 server.ts modern tools/call：isError=true、status=failed、structuredContent 过 strict（${sp.success ? "ok" : JSON.stringify(sp.error.issues.slice(0, 2))}）`);
    // 同一调用经官方 client 2.0 auto（DSH 同款）：不抛、拿到同形回包
    const c2 = new Client({ name: "o2-dsh-like", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await c2.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    let e2: unknown;
    let r2: any;
    try {
      r2 = await c2.callTool({ name: "moa_run", arguments: { prompt: "x", preset: "moa_verify" } });
    } catch (e) {
      e2 = e;
    }
    assert(!e2 && c2.getProtocolEra() === "modern" && r2?.structuredContent?.status === "failed" && /工具边界违反/.test(JSON.stringify(r2?.structuredContent?.error ?? "")),
      `16e 真 server.ts：client 2.0 auto 调 moa_run(preset 越界) → modern 腿正常回包（边界闸 failed），客户端未拒收：err=${e2 ? String((e2 as Error).message).slice(0, 120) : "无"}`);
    await c2.close().catch(() => {});
  } finally {
    const code = await h.stop();
    assert(code === 0, `16 隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }
}

async function main(): Promise<void> {
  await testRunOk();
  await testVerifyPreset();
  await testStageEvents();
  await testFailClosed();
  await testAbort();
  testRunDescription();
  await testRunRejectsVerifyPreset();
  await testVerifyRejectsSynthesizePreset();
  await testVerifyEmptyMaterialsFailFast();
  await testVerifyUnknownPresetNotBlamedOnMaterials();
  await testDeliverAllowedRootsRequired();
  await testDeliverJailExcludesInstallDir();
  testAggregatorMaxToolCallsSchema();
  testJevSummariesBudget();
  testOutputSchemaCoversSlimPayload();
  await testModernV2OutputSchemaStrict();
  console.log(`\n[mcp-test] 通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[mcp-test] 未捕获错误:", err);
  process.exitCode = 1;
});
