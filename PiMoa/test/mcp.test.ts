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
  type MoaToolInput,
} from "../src/mcp/tools.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function main(): Promise<void> {
  await testRunOk();
  await testVerifyPreset();
  await testStageEvents();
  await testFailClosed();
  await testAbort();
  testRunDescription();
  await testRunRejectsVerifyPreset();
  await testVerifyRejectsSynthesizePreset();
  await testDeliverAllowedRootsRequired();
  await testDeliverJailExcludesInstallDir();
  console.log(`\n[mcp-test] 通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[mcp-test] 未捕获错误:", err);
  process.exitCode = 1;
});
