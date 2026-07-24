/**
 * 确定性落盘交付测试（确定性、脱网、脱 key）。
 *
 * 运行：npx tsx test/deliver.test.ts
 *
 * A. atomicWriteWithVerify 直测：
 *   ① 正常写 + 回读通过（文件真存在、内容一致、sha256/末行核对）。
 *   ② 篡改 body（mock 回读不同内容）→ sha 不符 → throw。※ 用真回读 + 事后改文件模拟。
 *   ③ 末行非 doneMarker → throw（写前卡）。
 *   ④ path 在 allowedRoots 外 → throw。
 *   ⑤ symlink 逃逸（父目录是指向 root 外的软链）→ throw。
 * B. moa_deliver 工具：runSessionImpl mock 跑 synthesize → 写盘 → 断言文件存在 + 内容 + receipt.delivery。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteWithVerify, verifyReadback } from "../src/deliver/write.js";
import { runMoaDeliverTool, type MoaDeliverToolInput } from "../src/mcp/tools.js";
import type { MoaConfig, WorkerRef } from "../src/config/types.js";
import type { RunSessionImpl } from "../src/moa/orchestrate.js";
import type { SessionRunResult } from "../src/moa/session.js";

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
  console.log("[deliver-test]", ...a);
}
function sha256(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

/** 每个用例开一个隔离临时目录，返回 { root, cleanup }。 */
function mkRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pimoa-deliver-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const MARKER = "DONE_REPORT";
const BODY = `# 交付报告\n\n结论：一切正常。\n\n${MARKER}\n`;

// ---------- A① 正常写 + 回读通过 ----------
function testWriteOk(): void {
  log("=== A① 正常写 + 回读通过 ===");
  const { root, cleanup } = mkRoot();
  try {
    const target = join(root, "report.md");
    const r = atomicWriteWithVerify({
      path: target,
      body: BODY,
      doneMarker: MARKER,
      allowedRoots: [root],
    });
    assert(r.written === true, "written === true");
    assert(existsSync(target), "目标文件真存在");
    assert(readFileSync(target, "utf8") === BODY, "落盘内容 === body（逐字节一致）");
    assert(r.sha256 === sha256(BODY), "返回 sha256 === sha256(body)");
    assert(/^[0-9a-f]{64}$/.test(r.sha256), "sha256 是 64 位 hex");
    log(`written path=${r.path} sha=${r.sha256.slice(0, 12)}…`);
  } finally {
    cleanup();
  }
}

// ---------- A② 篡改 body → 回读 sha 不符 → throw ----------
// 回读校验（verifyReadback）是安全核心：磁盘读回内容与期望 sha/marker 不符即 throw。
// 直接对该纯函数喂「被篡改的磁盘内容」，确定性触发 throw（无需制造真实磁盘损坏）。
function testTamperShaThrows(): void {
  log("=== A② 篡改 body → 回读 sha 不符 → throw ===");
  const original = `原始正文\n${MARKER}\n`;
  const expectedSha = sha256(original);

  // 改一字节的「磁盘内容」→ sha 与交付时不符 → verifyReadback throw。
  let threw = false;
  let msg = "";
  try {
    verifyReadback(`原始正文X\n${MARKER}\n`, expectedSha, MARKER);
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, "回读内容被篡改（sha 不符）→ 抛错");
  assert(/sha256 不符/.test(msg), "错误信息指出 sha256 不符");
  log(`throw: ${msg}`);

  // 反证：内容一致时 verifyReadback 不抛（回读通过）。
  let okNoThrow = true;
  try {
    verifyReadback(original, expectedSha, MARKER);
  } catch {
    okNoThrow = false;
  }
  assert(okNoThrow, "内容一致 → 回读校验通过（不抛）");
}

// ---------- A③ 末行非 doneMarker → throw ----------
function testBadLastLine(): void {
  log("=== A③ 末行非 doneMarker → throw ===");
  const { root, cleanup } = mkRoot();
  try {
    let threw = false;
    let msg = "";
    try {
      atomicWriteWithVerify({
        path: join(root, "c.md"),
        body: `正文\n没有标记结尾\n`,
        doneMarker: MARKER,
        allowedRoots: [root],
      });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, "末行非 marker → 抛错");
    assert(!existsSync(join(root, "c.md")), "写前卡 → 不落坏文件");
    log(`throw: ${msg}`);
  } finally {
    cleanup();
  }
}

// ---------- A④ path 在 allowedRoots 外 → throw ----------
function testOutsideRoot(): void {
  log("=== A④ path 在 allowedRoots 外 → throw ===");
  const { root, cleanup } = mkRoot();
  const other = mkRoot(); // 另一个 root，作越界目标
  try {
    let threw = false;
    let msg = "";
    try {
      atomicWriteWithVerify({
        path: join(other.root, "evil.md"), // 目标在 other，但只允许 root
        body: BODY,
        doneMarker: MARKER,
        allowedRoots: [root],
      });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, "目标在允许根外 → 抛错");
    assert(!existsSync(join(other.root, "evil.md")), "越界目标未落盘");
    log(`throw: ${msg}`);
  } finally {
    cleanup();
    other.cleanup();
  }
}

// ---------- A⑤ symlink 逃逸 → throw ----------
function testSymlinkEscape(): void {
  log("=== A⑤ symlink 逃逸（父目录软链指向 root 外）→ throw ===");
  const { root, cleanup } = mkRoot();
  const outside = mkRoot();
  try {
    // root/link → outside.root（软链）。path = root/link/escape.md，
    // realpath(root/link) = outside.root，不在允许根 [root] 下 → 拒绝。
    const link = join(root, "link");
    symlinkSync(outside.root, link, "dir");
    let threw = false;
    let msg = "";
    try {
      atomicWriteWithVerify({
        path: join(link, "escape.md"),
        body: BODY,
        doneMarker: MARKER,
        allowedRoots: [root],
      });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, "symlink 逃逸 → 抛错");
    assert(!existsSync(join(outside.root, "escape.md")), "软链目标目录未被写入");
    log(`throw: ${msg}`);
  } finally {
    cleanup();
    outside.cleanup();
  }
}

// ---------- B moa_deliver 端到端（mock） ----------
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
    },
    timeouts: { referencePerCallMs: 180000, aggregatorPerCallMs: 480000, moaTotalBackstopMs: 720000 },
    defaults: { preset: "default" },
  };
}

async function testDeliverToolOk(): Promise<void> {
  log("=== B 端到端（mock）：synthesize → 写盘 → receipt.delivery ===");
  const { root, cleanup } = mkRoot();
  try {
    const aggBody = `# 综合结论\n\n两个方案取长补短后的最终答案。\n\n${MARKER}\n`;
    let capturedAggProfile = "";
    const mock: RunSessionImpl = (async (_mr, worker: WorkerRef, _p, _o) => {
      const key = `${worker.provider}/${worker.model}`;
      // 记录 aggregator 的 profile，验证被降为 delivery-readonly-worker。
      if (key === "cliproxy/gpt-5.5") capturedAggProfile = worker.profile;
      const table: Record<string, SessionRunResult> = {
        "minimax/MiniMax-M3": mkResult({ text: "提议A", sawAgentEnd: true }),
        "xiaomi/mimo-v2.5-pro": mkResult({ text: "提议B", sawAgentEnd: true }),
        "cliproxy/gpt-5.5": mkResult({ text: aggBody, sawAgentEnd: true }),
      };
      return table[key];
    }) as RunSessionImpl;

    const target = join(root, "final_report.md");
    const input: MoaDeliverToolInput = {
      prompt: "综合两个方案",
      path: target,
      done_marker: MARKER,
    };
    const resp = await runMoaDeliverTool(input, "default", {
      config: makeConfig(),
      modelRuntime: null,
      runSessionImpl: mock,
      allowedRoots: [root],
    });

    const sc = resp.structuredContent as {
      status: string;
      aggregated: string;
      receipt: { delivery?: { written: boolean; path: string; sha256: string } | null; profile: string };
    };
    log(`status=${sc.status} delivery=${JSON.stringify(sc.receipt.delivery)}`);
    assert(sc.status === "ok", "status === ok");
    assert(resp.isError === undefined, "非协议错误（isError 未置）");
    assert(existsSync(target), "交付文件真存在于磁盘");
    assert(readFileSync(target, "utf8") === aggBody, "落盘内容 === 聚合正文");
    assert(sc.receipt.delivery?.written === true, "receipt.delivery.written === true");
    assert(sc.receipt.delivery?.sha256 === sha256(aggBody), "receipt.delivery.sha256 正确");
    assert(sc.receipt.profile === "delivery-readonly-worker", "receipt.profile 已降为 delivery-readonly-worker");
    assert(capturedAggProfile === "delivery-readonly-worker", "aggregator profile 被强制降为只读");
  } finally {
    cleanup();
  }
}

async function testDeliverToolMoaFail(): Promise<void> {
  log("=== B' MoA 失败（proposer 空正文）→ 不写盘、透传 failed ===");
  const { root, cleanup } = mkRoot();
  try {
    const mock = makeMockRunSession({
      "minimax/MiniMax-M3": mkResult({ text: "有正文", sawAgentEnd: true }),
      "xiaomi/mimo-v2.5-pro": mkResult({ text: "   ", sawAgentEnd: true }), // 空正文 → fail-closed
      "cliproxy/gpt-5.5": mkResult({ text: `x\n${MARKER}\n`, sawAgentEnd: true }),
    });
    const target = join(root, "should_not_exist.md");
    const resp = await runMoaDeliverTool(
      { prompt: "x", path: target, done_marker: MARKER },
      "default",
      { config: makeConfig(), modelRuntime: null, runSessionImpl: mock, allowedRoots: [root] },
    );
    const sc = resp.structuredContent as { status: string; receipt: { delivery?: unknown } };
    assert(sc.status === "failed", "status === failed（fail-closed 透传）");
    assert(resp.isError === true, "isError === true");
    assert(!existsSync(target), "MoA 失败 → 未写盘");
    assert(sc.receipt.delivery === null, "receipt.delivery 保持 null（未交付）");
  } finally {
    cleanup();
  }
}

async function testDeliverToolWriteFail(): Promise<void> {
  log("=== B'' 写盘失败（末行非 marker）→ status=failed(stage=delivery) ===");
  const { root, cleanup } = mkRoot();
  try {
    // 聚合正文末行不是 marker → atomicWriteWithVerify throw → 交付失败。
    const mock = makeMockRunSession({
      "minimax/MiniMax-M3": mkResult({ text: "A", sawAgentEnd: true }),
      "xiaomi/mimo-v2.5-pro": mkResult({ text: "B", sawAgentEnd: true }),
      "cliproxy/gpt-5.5": mkResult({ text: `综合结论但没有以标记结尾`, sawAgentEnd: true }),
    });
    const target = join(root, "nomark.md");
    const resp = await runMoaDeliverTool(
      { prompt: "x", path: target, done_marker: MARKER },
      "default",
      { config: makeConfig(), modelRuntime: null, runSessionImpl: mock, allowedRoots: [root] },
    );
    const sc = resp.structuredContent as {
      status: string;
      error: { stage: string } | null;
      receipt: { delivery?: { written: boolean } | null };
    };
    log(`status=${sc.status} error=${JSON.stringify(sc.error)}`);
    assert(sc.status === "failed", "status === failed");
    assert(sc.error?.stage === "delivery", "error.stage === delivery");
    assert(!existsSync(target), "写盘失败 → 无残留文件");
    assert(sc.receipt.delivery?.written === false, "receipt.delivery.written === false");
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  testWriteOk();
  testTamperShaThrows();
  testBadLastLine();
  testOutsideRoot();
  testSymlinkEscape();
  await testDeliverToolOk();
  await testDeliverToolMoaFail();
  await testDeliverToolWriteFail();

  console.log(`\n[deliver-test] 通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[deliver-test] 未捕获错误:", err);
  process.exitCode = 1;
});
