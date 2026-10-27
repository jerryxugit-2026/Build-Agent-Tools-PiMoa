/**
 * 并发闸单测(v4 §9,P3;确定性、纯内存、毫秒级超时)。
 *
 * 运行:npx tsx test/gate.test.ts
 * 覆盖:全局上限、FIFO 出队、队满拒绝、排队超时、会话公平配额(含队头跳过防阻塞)、
 *      排队期取消移出、shutdown 拒绝队列、release 幂等、10 路并行语义(6 跑+4 队零丢弃)。
 */
import { ConcurrencyGate, GateRejectError } from "../src/mcp/gate.js";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rejectKind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no-reject";
  } catch (e) {
    return e instanceof GateRejectError ? e.kind : `other:${e}`;
  }
}

// ---- 1) 全局上限 + FIFO + 10 路并行语义 ----
{
  const g = new ConcurrencyGate({ maxInflight: 6, queueMax: 10, queueTimeoutMs: 2_000, sessionMaxInflight: 6, sessionMaxQueued: 10 });
  const releases: (() => void)[] = [];
  for (let i = 0; i < 6; i++) releases.push(await g.acquire(`s${i}`));
  assert(g.stats().running === 6, "6 路直接放行");
  const order: number[] = [];
  const queued = Array.from({ length: 4 }, (_, i) =>
    g.acquire(`q${i}`).then((rel) => {
      order.push(i);
      return rel;
    }),
  );
  await sleep(20);
  assert(g.stats().queued === 4, "第 7-10 路进入排队(10 路并行=6 跑+4 队)");
  releases[0]();
  releases[1]();
  await sleep(20);
  assert(g.stats().running === 6 && g.stats().queued === 2, "释放 2 → 队头 2 个补位");
  releases.slice(2).forEach((r) => r());
  const rels = await Promise.all(queued);
  assert(order.join(",") === "0,1,2,3", "FIFO 顺序出队");
  rels.forEach((r) => r());
  assert(g.stats().running === 0 && g.stats().queued === 0, "全部归零,零丢弃");
}

// ---- 2) 队满拒绝(fail-loud) ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 2, queueTimeoutMs: 2_000, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const p1 = g.acquire("b");
  const p2 = g.acquire("c");
  assert((await rejectKind(g.acquire("d"))) === "queue_full", "队满 → queue_full 拒绝");
  r0();
  (await p1)();
  (await p2)();
}

// ---- 3) 排队超时 ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 80, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const kind = await rejectKind(g.acquire("b"));
  assert(kind === "queue_timeout", "排队超时 → queue_timeout 拒绝");
  assert(g.stats().queued === 0, "超时后移出队列");
  r0();
}

// ---- 4) 会话公平配额 + 队头跳过 ----
{
  const g = new ConcurrencyGate({ maxInflight: 2, queueMax: 10, queueTimeoutMs: 2_000, sessionMaxInflight: 1, sessionMaxQueued: 1 });
  const ra = await g.acquire("A"); // A 在跑 1(达会话上限)
  const rb = await g.acquire("B"); // 全局满(2)
  const pa2 = g.acquire("A"); // A 排队 1(达会话排队上限)
  assert((await rejectKind(g.acquire("A"))) === "session_quota", "同会话超配额 → session_quota 拒绝");
  let cGranted = false;
  const pc = g.acquire("C").then((rel) => {
    cGranted = true;
    return rel;
  });
  await sleep(10);
  rb(); // 释放一个全局位:队头是 A 的排队,但 A 在跑=1 已达会话上限 → 跳过队头,放 C
  await sleep(20);
  assert(cGranted, "队头被会话配额挡住时跳过,后位 C 补位(防队头阻塞)");
  ra(); // A 的在跑释放 → 排队的 A 补位
  const ra2 = await pa2;
  ra2();
  (await pc)();
}

// ---- 5) 排队期取消(客户端断连) ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 2_000, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const ac = new AbortController();
  const p = g.acquire("b", ac.signal);
  await sleep(10);
  ac.abort();
  assert((await rejectKind(p)) === "client_aborted", "排队期取消 → client_aborted 并移出");
  assert(g.stats().queued === 0, "取消后队列为空");
  r0();
}

// ---- 6) shutdown 拒绝队列 + 拒新 ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 5_000, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const p1 = g.acquire("b");
  const p2 = g.acquire("c");
  const n = g.shutdown();
  assert(n === 2, "shutdown 报告拒绝的排队数");
  assert((await rejectKind(p1)) === "shutdown" && (await rejectKind(p2)) === "shutdown", "排队者全部 fail-loud 拒绝(非静默丢弃)");
  assert((await rejectKind(g.acquire("d"))) === "shutdown", "关停后拒新");
  r0();
}

// ---- 7) release 幂等 ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 2_000, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r = await g.acquire("a");
  r();
  r();
  assert(g.stats().running === 0, "double release 不把计数打负");
  const r2 = await g.acquire("a");
  assert(g.stats().running === 1, "后续 acquire 正常");
  r2();
}

// ---- 8) stdio 豁免会话配额(P3 复审 F8 方案 A) ----
{
  const g = new ConcurrencyGate({ maxInflight: 6, queueMax: 10, queueTimeoutMs: 2_000, sessionMaxInflight: 3, sessionMaxQueued: 4 });
  const rels: (() => void)[] = [];
  for (let i = 0; i < 6; i++) rels.push(await g.acquire("stdio"));
  assert(g.stats().running === 6, "F8:stdio 单会话拿满全局 6 槽(豁免 3+4 配额)");
  const httpG = await g.acquire("http-a").catch(() => null);
  assert(httpG === null || g.stats().queued === 1, "全局满时其他会话正常排队");
  rels.forEach((r) => r());
  const gB = new ConcurrencyGate({ maxInflight: 6, queueMax: 10, queueTimeoutMs: 200, sessionMaxInflight: 3, sessionMaxQueued: 4 });
  const ra = [await gB.acquire("http-x"), await gB.acquire("http-x"), await gB.acquire("http-x")];
  const p4 = gB.acquire("http-x"); // 排队 1
  assert(gB.stats().running === 3 && gB.stats().queued === 1, "http 会话仍受 3 在跑配额(全局有空也不放)");
  ra.forEach((r) => r());
  (await p4)();
}

// ---- 9) 竞态:超时后 abort 为 no-op、监听器已摘(F2/F3) ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 60, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const ac = new AbortController();
  const kind = await rejectKind(g.acquire("b", ac.signal)); // 超时先到
  assert(kind === "queue_timeout", "F3:超时先结算");
  ac.abort(); // 迟到的 abort:监听器已被 settle 摘除/终态闩挡住 → 绝不二次结算
  await sleep(10);
  assert(g.stats().queued === 0 && g.stats().running === 1, "F2:迟到 abort 零副作用,计数不漂");
  r0();
  const r1 = await g.acquire("b"); // 会话计数未被打坏
  assert(g.stats().running === 1, "后续同会话 acquire 正常");
  r1();
}

// ---- 10) 竞态:grant 后迟到超时/abort 均 no-op(F3) ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 120, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const ac = new AbortController();
  const p = g.acquire("b", ac.signal);
  r0(); // pump grant b(settle 已摘 timer+listener)
  const rb = await p;
  ac.abort();
  await sleep(150); // 原 timer 时刻已过
  assert(g.stats().running === 1 && g.stats().queued === 0, "F3:grant 后迟到 abort/超时零副作用");
  rb();
  assert(g.stats().running === 0, "release 正常归零");
}

// ---- 11) shutdown 后 release 触发的 pump 不放行残留(F9) ----
{
  const g = new ConcurrencyGate({ maxInflight: 1, queueMax: 5, queueTimeoutMs: 5_000, sessionMaxInflight: 5, sessionMaxQueued: 5 });
  const r0 = await g.acquire("a");
  const p1 = g.acquire("b");
  g.shutdown();
  await rejectKind(p1);
  r0(); // release → pump:down 短路,绝不放行
  assert(g.stats().running === 0 && g.stats().queued === 0, "F9:shutdown 后 pump 零放行");
}

// ============================================================================
// O2 hybrid modern 用例组（F-1 裁决口径，徐总 2026-09-30 批准）
//   modern 腿不再按客户端身份计会话配额：并发闸 key 固定为 "modern"，与 "stdio" 并列进 quotaExemptKeys
//   （gate.ts 豁免机制，P3 复审 F8 方案 A 先例），只受全局 6 在跑 + 10 排队约束；clientInfo 只进日志做观测。
//   legacy 腿不变：每会话一个 8 位十六进制 key，受会话 3 在跑 + 4 排队约束。
//   12) 闸门语义（纯内存，同一组豁免表）：modern 同 key 并发 >3 不排队；全局上限仍生效；legacy key 3+4 不变。
//   13) 真 server.ts 日志：modern 恒用 key="modern"，client= 标签按 clientInfo 推导；legacy 仍为每会话 key。
//   14) 真 server.ts 行为（隔离端口 + 假 rg 占住名额，见 o2_hybrid_harness.ts 的 slowRgMs）：
//       a. 同一 clientInfo 的 modern 并发 5 路（>3）全部直接开跑：零「并发闸拒绝」、墙钟≈一次占用时长；
//       b. modern 并发 8 路：全局 6 在跑、第 7/8 路排队并按短排队超时被拒 queue_timeout（全局上限仍约束 modern）；
//       c. 同一 legacy 会话并发 5 路：3 在跑、2 排队并按短排队超时被拒（legacy 会话 3+4 配额零变化）。
// ============================================================================
// ---- 12) 豁免语义（纯内存）----
{
  const EXEMPT = ["stdio", "modern"]; // 与 server.ts 构造 ConcurrencyGate 时的 quotaExemptKeys 同一口径
  const g = new ConcurrencyGate({ maxInflight: 6, queueMax: 10, queueTimeoutMs: 2_000, sessionMaxInflight: 3, sessionMaxQueued: 4, quotaExemptKeys: EXEMPT });
  const rels: (() => void)[] = [];
  for (let i = 0; i < 6; i++) rels.push(await g.acquire("modern"));
  assert(g.stats().running === 6 && g.stats().queued === 0, "O2-12 modern 同 key 并发 6 路（>会话 3）全部直接放行：不受会话配额约束");
  const p7 = g.acquire("modern");
  await sleep(10);
  assert(g.stats().running === 6 && g.stats().queued === 1, "O2-12 第 7 路 modern 排队：仍受全局 6 在跑上限约束");
  rels[0]();
  const r7 = await p7;
  assert(g.stats().running === 6 && g.stats().queued === 0, "O2-12 释放 1 个全局位后第 7 路补位");
  r7();
  rels.slice(1).forEach((r) => r());
  assert(g.stats().running === 0 && g.stats().queued === 0, "O2-12 全部归零");
  // legacy 会话 key 在同一豁免表下仍受 3+4
  const gl = new ConcurrencyGate({ maxInflight: 6, queueMax: 10, queueTimeoutMs: 2_000, sessionMaxInflight: 3, sessionMaxQueued: 4, quotaExemptKeys: EXEMPT });
  const lr = [await gl.acquire("0a1b2c3d"), await gl.acquire("0a1b2c3d"), await gl.acquire("0a1b2c3d")];
  const lq = [0, 1, 2, 3].map(() => gl.acquire("0a1b2c3d"));
  await sleep(10);
  assert(gl.stats().running === 3 && gl.stats().queued === 4, "O2-12 legacy 会话 key：3 在跑 + 4 排队（全局有空也不放）");
  assert((await rejectKind(gl.acquire("0a1b2c3d"))) === "session_quota", "O2-12 legacy 会话第 8 路 → session_quota（legacy 会话配额零变化）");
  lr.forEach((r) => r());
  for (const p of lq) (await p)();
  assert(gl.stats().running === 0 && gl.stats().queued === 0, "O2-12 legacy 组归零");
}

// ---- 13) 准入日志：真 server.ts（隔离端口） ----
{
  const H = await import("./o2_hybrid_harness.js");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const h = await H.startHybrid();
  type Adm = { key: string; client: string | null };
  const admSince = (from: number): Adm[] =>
    [...h.stderr().slice(from).matchAll(/准入配额 key=("(?:[^"\\]|\\.)*")(?: client=("(?:[^"\\]|\\.)*"))?/g)].map((m) => ({
      key: JSON.parse(m[1]) as string,
      client: m[2] ? (JSON.parse(m[2]) as string) : null,
    }));
  const verifyArgs = { name: "moa_verify", arguments: { prompt: "x" } };
  try {
    let mark = h.stderr().length;
    await H.modernPost(h.url, "tools/call", verifyArgs, { clientInfo: { name: "dsh", version: "0.2.0-rc.2" } });
    await H.modernPost(h.url, "tools/call", verifyArgs, { clientInfo: null });
    await H.modernPost(h.url, "tools/call", verifyArgs, { clientInfo: { name: "", version: "1" } });
    const m1 = admSince(mark);
    assert(
      JSON.stringify(m1) ===
        JSON.stringify([
          { key: "modern", client: "modern:dsh@0.2.0-rc.2" },
          { key: "modern", client: "modern-anon" },
          { key: "modern", client: "modern-anon" },
        ]),
      `O2-13 modern 恒用豁免 key="modern"；clientInfo 只进 client= 观测标签（缺/空名 → modern-anon）（实际 ${JSON.stringify(m1)}）`,
    );

    mark = h.stderr().length;
    const hs1 = await H.legacyHandshake(h.url);
    const lcall = (sid: string) =>
      H.legacyPost(h.url, { jsonrpc: "2.0", id: H.newId(), method: "tools/call", params: verifyArgs }, sid);
    await lcall(hs1.sid!);
    await lcall(hs1.sid!);
    const hs2 = await H.legacyHandshake(h.url);
    await lcall(hs2.sid!);
    const lk = admSince(mark);
    assert(
      lk.length === 3 && lk.every((a) => /^[0-9a-f]{8}$/.test(a.key) && a.client === null) && lk[0].key === lk[1].key && lk[2].key !== lk[0].key,
      `O2-13 legacy 腿保持现状：每会话一个 8 位十六进制 key，同会话复用、新会话换新，无 client= 标签（实际 ${JSON.stringify(lk)}）`,
    );

    mark = h.stderr().length;
    const c = new Client({ name: "dsh-mcp-client", version: "0.0.1" }, { versionNegotiation: { mode: "auto" } });
    await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    await c.callTool({ name: "moa_verify", arguments: { prompt: "x" } });
    await c.close();
    const m3 = admSince(mark);
    assert(
      JSON.stringify(m3) === JSON.stringify([{ key: "modern", client: "modern:dsh-mcp-client@0.0.1" }]),
      `O2-13 官方 client 2.0 auto（DSH rc.2 同款 clientInfo）→ key="modern"、client=modern:dsh-mcp-client@0.0.1（实际 ${JSON.stringify(m3)}）`,
    );
  } finally {
    const code = await h.stop();
    assert(code === 0, `O2-13 隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }
}

// ---- 14) 豁免的真实行为：真 server.ts（隔离端口，假 rg 占住名额 HOLD_MS） ----
{
  const H = await import("./o2_hybrid_harness.js");
  const HOLD_MS = 2_000;
  const QUEUE_TIMEOUT_MS = 600; // 排队者在占用结束前必然超时 ⇒ 任何「排队」都会以 queue_timeout 显形
  const h = await H.startHybrid({ slowRgMs: HOLD_MS, env: { PIMOA_QUEUE_TIMEOUT_MS: String(QUEUE_TIMEOUT_MS) } });
  const holdArgs = { name: "moa_verify", arguments: { prompt: "x", recon_query: "o2-f1-hold" } };
  const kindOf = (r: { msg: any }): string => {
    const text = String(r.msg?.result?.content?.[0]?.text ?? r.msg?.error?.message ?? "");
    const m = /并发闸拒绝\((\w+)\)/.exec(text);
    if (m) return `reject:${m[1]}`;
    return r.msg?.result?.structuredContent?.status === "failed" && r.msg?.result?.structuredContent?.error?.stage === "config"
      ? "ran"
      : `other:${text.slice(0, 80)}`;
  };
  const tally = (ks: string[]) => ks.reduce<Record<string, number>>((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {});
  try {
    // 前提：一次调用确实占住 ≈HOLD_MS（假 rg 生效），且结果是进模型前的 config 失败
    const t0 = Date.now();
    const one = await H.modernPost(h.url, "tools/call", holdArgs);
    const oneMs = Date.now() - t0;
    assert(kindOf(one) === "ran" && oneMs >= HOLD_MS - 100, `O2-14 前提：单次调用占用 ${oneMs}ms（≈${HOLD_MS}ms）且在进模型前 config 失败（${kindOf(one)}）`);

    // a. 同一 clientInfo modern 并发 5 路
    const ta = Date.now();
    const a = await Promise.all(
      Array.from({ length: 5 }, () => H.modernPost(h.url, "tools/call", holdArgs, { clientInfo: { name: "dsh-mcp-client", version: "0.0.1" } })),
    );
    const aMs = Date.now() - ta;
    const aT = tally(a.map(kindOf));
    assert(aT.ran === 5, `O2-14a 同一 clientInfo 的 modern 并发 5 路（>会话 3）全部直接开跑、零并发闸拒绝（实际 ${JSON.stringify(aT)}）`);
    assert(aMs < HOLD_MS * 2 - 200, `O2-14a 墙钟 ${aMs}ms < 2×占用 ⇒ 5 路并行而非排队串行`);

    // b. modern 并发 8 路：全局 6 在跑，2 路排队 → 短排队超时被拒
    const b = await Promise.all(
      Array.from({ length: 8 }, (_, i) => H.modernPost(h.url, "tools/call", holdArgs, { clientInfo: { name: `c${i % 2}`, version: "1" } })),
    );
    const bT = tally(b.map(kindOf));
    assert(bT.ran === 6 && bT["reject:queue_timeout"] === 2, `O2-14b modern 并发 8 路：6 路开跑、2 路排队超时（全局 6 在跑上限仍约束 modern）（实际 ${JSON.stringify(bT)}）`);

    // c. 同一 legacy 会话并发 5 路：会话 3 在跑，2 路排队 → 短排队超时被拒
    const hs = await H.legacyHandshake(h.url);
    const c = await Promise.all(
      Array.from({ length: 5 }, () =>
        H.legacyPost(h.url, { jsonrpc: "2.0", id: H.newId(), method: "tools/call", params: holdArgs }, hs.sid!),
      ),
    );
    const cT = tally(c.map(kindOf));
    assert(cT.ran === 3 && cT["reject:queue_timeout"] === 2, `O2-14c 同一 legacy 会话并发 5 路：3 路开跑、2 路排队超时（legacy 会话 3+4 配额零变化）（实际 ${JSON.stringify(cT)}）`);
  } finally {
    const code = await h.stop();
    assert(code === 0, `O2-14 隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }
}

console.log(`\n[gate-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
