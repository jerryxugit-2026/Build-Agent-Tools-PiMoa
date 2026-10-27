/**
 * O3（统一升级台账 r92 DEC-72 ④ / r97 DEC-75，2026-10-01）：8758 HTTP 入口形态 `http.mode = hybrid | modern`。
 *
 * 运行：npx tsx test/o3_http_mode.test.ts（脱网、dummy key；真 server.ts 一律起在隔离端口，见 o2_hybrid_harness.ts）
 *
 * 覆盖：
 *   A  配置层：缺省 / 显式 hybrid / modern / 非法值 / 未知键 / 非对象 —— loadConfig 真解析（生产 moa.yaml + 追加片段）。
 *   B  真 server.ts，http.mode=modern 镜像树：
 *      启动日志 `http mode=modern`；官方 client 2.0.0 auto 与 pin 2026-07-28 均可 list/call；client 默认（legacy）连不上；
 *      legacy initialize（不带头 / 带 2025-11-25 头 / JevClient 形状）、无信封 discover、陈旧会话 tools/call 一律 -32022；
 *      GET/DELETE 405、空 body/批数组 400（不挂起）；legacy 腿会话表 / rejectNoSession 零触达（无会话头、无「拒绝无效会话」行）；
 *      413 送达（Content-Length / chunked / 100-continue，modern 与 legacy 两种形状）+ 5MiB 正常；tools/call 为 SSE（保活接线）；
 *      并发闸固定 key="modern"（5 路全开跑、8 路 6 跑 2 排队超时）；重启后 client auto 直接可用；SIGTERM exit 0。
 *   C  真 server.ts，hybrid（显式 `mode: hybrid` 与「无 http 段」两种）：启动日志 `http mode=hybrid`，legacy 腿行为照旧。
 *   D  非法配置：server.ts 启动即 fail-loud（exit 1 + `http.mode 非法` / 未知键），不带病起服务。
 *
 * 镜像树做法：server.ts 按自身位置读 config/moa.yaml，且故意不设 env 开关，故把 src/ 复制进 mkdtemp 目录、其余软链，
 *   只替换 moa.yaml（= 生产 moa.yaml + 追加的 http 片段），再经夹具已有的 O2_HARNESS_SERVER_ROOT 指过去。
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as H from "./o2_hybrid_harness.js";
import { ConfigError, loadConfig } from "../src/config/load.js";

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

for (const k of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) {
  process.env[k] ||= "o3-test-dummy";
}

const PROD_YAML = readFileSync(join(H.PIMOA_ROOT, "config", "moa.yaml"), "utf8");
const PROD_MODELS = join(H.PIMOA_ROOT, "config", "models.json");

/** 造镜像树（见文件头）。httpYaml=null ⇒ moa.yaml 与生产逐字节相同。 */
function makeModeTree(httpYaml: string | null): string {
  if (/^http:/m.test(PROD_YAML)) throw new Error("生产 moa.yaml 已有顶层 http: 键，追加前提不成立");
  const root = mkdtempSync(join(tmpdir(), "pimoa-o3-tree-"));
  cpSync(join(H.PIMOA_ROOT, "src"), join(root, "src"), { recursive: true });
  symlinkSync(join(H.PIMOA_ROOT, "node_modules"), join(root, "node_modules"));
  symlinkSync(join(H.PIMOA_ROOT, "package.json"), join(root, "package.json"));
  mkdirSync(join(root, "config"));
  for (const name of readdirSync(join(H.PIMOA_ROOT, "config"))) {
    if (name !== "moa.yaml") symlinkSync(join(H.PIMOA_ROOT, "config", name), join(root, "config", name));
  }
  writeFileSync(join(root, "config", "moa.yaml"), httpYaml === null ? PROD_YAML : `${PROD_YAML}\n${httpYaml}\n`);
  return root;
}

/** 在指定镜像树上起真 server.ts（经夹具既有的 O2_HARNESS_SERVER_ROOT）。 */
async function startOn(root: string, opts: Parameters<typeof H.startHybrid>[0] = {}): Promise<H.HybridInstance> {
  const prev = process.env.O2_HARNESS_SERVER_ROOT;
  process.env.O2_HARNESS_SERVER_ROOT = root;
  try {
    return await H.startHybrid(opts);
  } finally {
    if (prev === undefined) delete process.env.O2_HARNESS_SERVER_ROOT;
    else process.env.O2_HARNESS_SERVER_ROOT = prev;
  }
}

// ============================================================================
// A 配置层
// ============================================================================
console.log("\n=== A 配置层：http.mode 解析 ===");
{
  const dir = mkdtempSync(join(tmpdir(), "pimoa-o3-cfg-"));
  let n = 0;
  const load = (snippet: string | null) => {
    const p = join(dir, `moa-${n++}.yaml`);
    writeFileSync(p, snippet === null ? PROD_YAML : `${PROD_YAML}\n${snippet}\n`);
    return loadConfig({ moaYaml: p, modelsJson: PROD_MODELS });
  };
  const errOf = (snippet: string): string => {
    try {
      load(snippet);
      return "(未抛错)";
    } catch (e) {
      return e instanceof ConfigError ? e.message : `非 ConfigError：${String(e)}`;
    }
  };
  // 生产真源本身（无 http 段）⇒ hybrid：上线前缺省与 O2 现网一致
  const prodCfg = loadConfig({ moaYaml: join(H.PIMOA_ROOT, "config", "moa.yaml") });
  assert(prodCfg.http?.mode === "hybrid", `A1 生产 config/moa.yaml（无 http 段）→ mode=hybrid（实际 ${JSON.stringify(prodCfg.http)}）`);
  assert(load(null).http?.mode === "hybrid", "A2 整段缺省 → hybrid");
  assert(load("http:").http?.mode === "hybrid", "A3 `http:`（null）→ hybrid");
  assert(load("http: {}").http?.mode === "hybrid", "A4 `http: {}`（mode 缺省）→ hybrid");
  assert(load("http:\n  mode: hybrid").http?.mode === "hybrid", "A5 显式 hybrid → hybrid");
  assert(load("http:\n  mode: modern").http?.mode === "modern", "A6 显式 modern → modern");
  for (const bad of ["Modern", "reject", "legacy", "dual", "auto", '""', "1", "true", "[modern]"]) {
    const m = errOf(`http:\n  mode: ${bad}`);
    assert(/http\.mode 非法/.test(m) && /hybrid \| modern/.test(m), `A7 非法值 mode: ${bad} → ConfigError「http.mode 非法…仅允许 hybrid | modern」（${m}）`);
  }
  const typo = errOf("http:\n  mdoe: modern");
  assert(/http\.mdoe 是未知键/.test(typo), `A8 拼错键 mdoe → fail-loud，不静默留在 hybrid（${typo}）`);
  const notObj = errOf("http: modern");
  assert(/http 必须是对象/.test(notObj), `A9 \`http: modern\`（非对象）→ fail-loud（${notObj}）`);
  // jevcheck.clientMode 与 http.mode 互不干扰（同一配置纪律、两个独立键）
  const both = load("http:\n  mode: modern");
  assert(both.jevcheck.clientMode === prodCfg.jevcheck.clientMode, `A10 http.mode 不影响 jevcheck.clientMode（${both.jevcheck.clientMode}）`);
}

// ============================================================================
// B 真 server.ts，http.mode=modern
// ============================================================================
console.log("\n=== B 真 server.ts：http.mode=modern（隔离端口） ===");
const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
const MODERN_TREE = makeModeTree("http:\n  mode: modern");

type Raw = { status: number; body: string; ct: string; sid: string | null; err?: string; ms: number };
function rawSend(
  port: number,
  o: { method?: string; body?: Buffer; headers?: Record<string, string>; chunked?: boolean; expectContinue?: boolean; timeoutMs?: number },
): Promise<Raw> {
  const t0 = Date.now();
  return new Promise((resolveP) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: o.method ?? "POST",
        path: "/mcp",
        headers: {
          ...(o.method === "GET" || o.method === "DELETE" ? {} : { "content-type": "application/json" }),
          accept: "application/json, text/event-stream",
          ...(o.headers ?? {}),
          ...(o.body && !o.chunked ? { "content-length": String(o.body.length) } : {}),
          ...(o.expectContinue ? { expect: "100-continue" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolveP({
            status: res.statusCode ?? 0,
            body: data,
            ct: String(res.headers["content-type"] ?? ""),
            sid: (res.headers["mcp-session-id"] as string | undefined) ?? null,
            ms: Date.now() - t0,
          }),
        );
      },
    );
    req.setTimeout(o.timeoutMs ?? 10_000, () => {
      req.destroy(new Error("client-timeout"));
    });
    req.on("error", (e) => resolveP({ status: -1, body: "", ct: "", sid: null, err: String(e), ms: Date.now() - t0 }));
    if (o.expectContinue) {
      req.on("continue", () => {
        req.write(o.body!);
        req.end();
      });
      setTimeout(() => req.end(), 1500).unref?.();
    } else {
      if (o.body) req.write(o.body);
      req.end();
    }
  });
}
const j = (r: Raw): any => {
  try {
    return JSON.parse(r.body);
  } catch {
    return H.parseRpc(r.ct, r.body, undefined).msg;
  }
};

{
  const h = await startOn(MODERN_TREE);
  const port = h.port;
  let h2: H.HybridInstance | undefined;
  try {
    assert(/\[pi-moa-mcp\] http mode=modern/.test(h.stderr()), "B0 启动日志打出 `http mode=modern`");

    // B1/B2 官方 client 2.0.0：auto 与 pin 2026-07-28
    for (const [tag, mode] of [
      ["auto", "auto"],
      ["pin 2026-07-28", { pin: H.MODERN_VERSION }],
    ] as const) {
      const c = new Client({ name: `o3-${tag}`, version: "1" }, { versionNegotiation: { mode: mode as never } });
      const t = new StreamableHTTPClientTransport(new URL(h.url));
      await c.connect(t);
      const tools = (await c.listTools()).tools.map((x) => x.name).sort();
      const r = (await c.callTool({ name: "moa_verify", arguments: { prompt: "x" } })) as any;
      assert(
        c.getProtocolEra() === "modern" && JSON.stringify(tools) === JSON.stringify(["moa_deliver", "moa_run", "moa_verify"]) && t.sessionId === undefined,
        `B1 client 2.0 ${tag} → era=${c.getProtocolEra()}、tools=${JSON.stringify(tools)}、无会话（sessionId=${t.sessionId}）`,
      );
      assert(
        r?.structuredContent?.status === "failed" && r?.structuredContent?.error?.stage === "config",
        `B1 client 2.0 ${tag} callTool moa_verify（空材料）→ 结构化 failed/config（进模型前 fail-fast，status=${r?.structuredContent?.status} stage=${r?.structuredContent?.error?.stage}）`,
      );
      await c.close();
    }

    // B3 client 2.0 默认（legacy 握手）→ 连接失败
    {
      const c = new Client({ name: "o3-legacy", version: "1" });
      let err = "";
      try {
        await c.connect(new StreamableHTTPClientTransport(new URL(h.url)));
      } catch (e) {
        err = String((e as Error)?.message ?? e);
      }
      assert(err !== "" && /-32022|Unsupported protocol version|protocol version/i.test(err), `B3 client 2.0 默认（legacy initialize）→ 连接失败（${err.slice(0, 160)}）`);
      await c.close().catch(() => {});
    }

    // B4 legacy initialize 三种形状一律 400 -32022，回显 id、无会话头
    const mark = h.stderr().length;
    const init = (id: number, pv: string, hdr?: string) =>
      rawSend(port, {
        body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: pv, capabilities: {}, clientInfo: { name: "o3-legacy", version: "1.29" } } })),
        headers: hdr ? { "mcp-protocol-version": hdr } : {},
      });
    for (const [tag, r, id] of [
      ["不带版本头（2025-11-25）", await init(41, "2025-11-25"), 41],
      ["带版本头 2025-11-25", await init(42, "2025-11-25", "2025-11-25"), 42],
      ["JevClient 形状（2025-03-26，无头）", await init(43, "2025-03-26"), 43],
    ] as const) {
      const m = j(r);
      assert(r.status === 400 && m?.error?.code === -32022 && m?.id === id && r.sid === null, `B4 legacy initialize ${tag} → 400 -32022 回显 id=${m?.id}、无会话头（实际 ${r.status} ${m?.error?.code}）`);
    }
    // B5 无信封 discover：hybrid 下是 200 + 2025 系列，modern 下拒绝
    const d = await rawSend(port, { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "server/discover", params: {} })) });
    assert(d.status === 400 && j(d)?.error?.code === -32022, `B5 无信封 server/discover → 400 -32022（hybrid 为 200；实际 ${d.status} ${j(d)?.error?.code}）`);
    // B5' 带信封 discover → 200 ["2026-07-28"]
    const d2 = await H.modernPost(h.url, "server/discover", {});
    assert(d2.status === 200 && JSON.stringify(d2.msg?.result?.supportedVersions) === JSON.stringify([H.MODERN_VERSION]), `B5' 带信封 discover → 200 ["2026-07-28"]（实际 ${d2.status}）`);
    // B6 陈旧会话 tools/call（legacy 形状）→ -32022，不再是 rejectNoSession 的 404
    const st = await rawSend(port, {
      body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "moa_verify", arguments: { prompt: "x" } } })),
      headers: { "mcp-session-id": "00000000-dead-dead-dead-000000000000", "mcp-protocol-version": "2025-11-25" },
    });
    assert(st.status === 400 && j(st)?.error?.code === -32022 && j(st)?.id === 61, `B6 陈旧会话 legacy tools/call → 400 -32022（非 404；实际 ${st.status} ${j(st)?.error?.code}）`);
    // B7 GET / DELETE / 空 body / 批数组 / 畸形 JSON
    const g = await rawSend(port, { method: "GET" });
    assert(g.status === 405, `B7 GET /mcp → 405（会话 SSE 长连不再提供；实际 ${g.status}${g.err ?? ""}）`);
    const del = await rawSend(port, { method: "DELETE", headers: { "mcp-session-id": "x" } });
    assert(del.status === 405, `B7 DELETE /mcp → 405（实际 ${del.status}${del.err ?? ""}）`);
    const empty = await rawSend(port, { body: Buffer.alloc(0) });
    assert(empty.status === 400 && empty.ms < 5_000, `B7 空 body POST → 400 且不挂起（${empty.ms}ms，实际 ${empty.status}${empty.err ?? ""} ${empty.body.slice(0, 100)}）`);
    const batch = await rawSend(port, { body: Buffer.from(JSON.stringify([{ jsonrpc: "2.0", id: 71, method: "tools/list" }])) });
    assert(batch.status === 400, `B7 批数组 → 400（实际 ${batch.status}）`);
    const bad = await rawSend(port, { body: Buffer.from("{not json") });
    assert(bad.status === 400 && j(bad)?.error?.code === -32000, `B7 畸形 JSON → 400（共用 readJsonBody，实际 ${bad.status}）`);
    // B8 legacy 腿零触达：本段所有拒绝都不经 rejectNoSession，也不建会话
    const seg = h.stderr().slice(mark);
    assert(!/拒绝无效会话/.test(seg), "B8 legacy 腿零触达：stderr 无「拒绝无效会话」（rejectNoSession 未被调用）");
    assert(/Rejected 2025-era request on a modern-only endpoint|Rejected inbound request/.test(seg), "B8 拒绝由 v2 handler 产出（onerror 日志「modern 腿拒绝/异常：Rejected …」可见）");

    // B9 tools/call 走 SSE（responseMode:"sse" 接线；保活注释帧由 SDK 写）
    const call = await H.modernPost(h.url, "tools/call", { name: "moa_verify", arguments: { prompt: "x" } });
    assert(call.status === 200 && call.ct?.includes("text/event-stream") && call.msg?.result !== undefined && call.sessionHdr === null, `B9 modern tools/call → 200 text/event-stream 结果完整、无会话头（ct=${call.ct}）`);

    // B10 并发闸 key 固定 "modern"
    const keys = [...h.stderr().matchAll(/准入配额 key=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
    assert(keys.length >= 3 && keys.every((k) => k === "modern"), `B10 全部 tools/call 准入 key="modern"（${keys.length} 次：${JSON.stringify([...new Set(keys)])}）`);

    // B11 413 送达（modern 形状与 legacy 形状都走同一 readJsonBody）
    const nine = 9 * 1024 * 1024;
    const pad = (n: number) => "A".repeat(n);
    const mHdr = { "mcp-protocol-version": H.MODERN_VERSION, "mcp-method": "tools/call", "mcp-name": "moa_verify" };
    const mBody = (n: number) =>
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "moa_verify", arguments: { prompt: "big", context: pad(n) }, _meta: { [H.META_PV]: H.MODERN_VERSION, [H.META_CC]: {} } } }));
    const lBody = (n: number) =>
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "big", version: "0" }, pad: pad(n) } }));
    const is413 = (r: Raw) => r.status === 413 && j(r)?.error?.code === -32000 && String(j(r)?.error?.message).includes("files");
    for (let i = 1; i <= 3; i++) {
      const a = await rawSend(port, { body: mBody(nine), headers: mHdr, timeoutMs: 30_000 });
      assert(is413(a), `B11 modern 9MiB（Content-Length）第 ${i} 次 → 413 JSON 送达（实际 ${a.status}${a.err ? " " + a.err : ""}）`);
      const b = await rawSend(port, { body: mBody(nine), headers: mHdr, chunked: true, timeoutMs: 30_000 });
      assert(is413(b), `B11 modern 9MiB（chunked）第 ${i} 次 → 413 JSON 送达（实际 ${b.status}${b.err ? " " + b.err : ""}）`);
    }
    const c1 = await rawSend(port, { body: mBody(nine), headers: mHdr, expectContinue: true, timeoutMs: 30_000 });
    assert(c1.status === 413, `B11 modern 9MiB（Expect: 100-continue）→ checkContinue 处 413（实际 ${c1.status}）`);
    const l1 = await rawSend(port, { body: lBody(nine), timeoutMs: 30_000 });
    assert(is413(l1), `B11 legacy 形状 9MiB → 仍先 413 送达（超限判在形态分流之前；实际 ${l1.status}${l1.err ? " " + l1.err : ""}）`);
    const ok5 = await rawSend(port, { body: mBody(5 * 1024 * 1024), headers: mHdr, timeoutMs: 30_000 });
    assert(ok5.status === 200 && ok5.ct.includes("text/event-stream") && H.parseRpc(ok5.ct, ok5.body, 2).msg?.result !== undefined, `B11 modern 5MiB（> SDK 缺省 4MiB）→ 200 SSE 正常（实际 ${ok5.status}）`);

    // B12 重启同端口：client auto 直接可用（无会话，形态 A 消失）
    const code1 = await h.stop();
    assert(code1 === 0, `B12 SIGTERM 优雅退出 exit=${code1}`);
    h2 = await startOn(MODERN_TREE, { port });
    const c = new Client({ name: "o3-after-restart", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await c.connect(new StreamableHTTPClientTransport(new URL(h2.url)));
    const n2 = (await c.listTools()).tools.length;
    assert(c.getProtocolEra() === "modern" && n2 === 3, `B12 重启后 client auto 直接可用（era=${c.getProtocolEra()} tools=${n2}）`);
    await c.close();
  } finally {
    if (h.child.exitCode === null) await h.stop();
    if (h2) {
      const code = await h2.stop();
      assert(code === 0, `B12 重启实例 SIGTERM 优雅退出 exit=${code}`);
    }
  }
}

// B13 并发闸行为（假 rg 占住名额，见 o2_hybrid_harness.ts slowRgMs）
{
  const HOLD_MS = 2_000;
  const h = await startOn(MODERN_TREE, { slowRgMs: HOLD_MS, env: { PIMOA_QUEUE_TIMEOUT_MS: "600" } });
  const holdArgs = { name: "moa_verify", arguments: { prompt: "x", recon_query: "o3-hold" } };
  const kindOf = (r: { msg: any }): string => {
    const text = String(r.msg?.result?.content?.[0]?.text ?? r.msg?.error?.message ?? "");
    const m = /并发闸拒绝\((\w+)\)/.exec(text);
    if (m) return `reject:${m[1]}`;
    return r.msg?.result?.structuredContent?.status === "failed" && r.msg?.result?.structuredContent?.error?.stage === "config" ? "ran" : `other:${text.slice(0, 80)}`;
  };
  const tally = (ks: string[]) => ks.reduce<Record<string, number>>((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {});
  try {
    const t0 = Date.now();
    const one = await H.modernPost(h.url, "tools/call", holdArgs);
    const oneMs = Date.now() - t0;
    assert(kindOf(one) === "ran" && oneMs >= HOLD_MS - 100, `B13 前提：单次占用 ${oneMs}ms 且进模型前 config 失败（${kindOf(one)}）`);
    const ta = Date.now();
    const a = await Promise.all(Array.from({ length: 5 }, () => H.modernPost(h.url, "tools/call", holdArgs, { clientInfo: { name: "dsh-mcp-client", version: "0.0.1" } })));
    const aMs = Date.now() - ta;
    assert(tally(a.map(kindOf)).ran === 5 && aMs < HOLD_MS * 2 - 200, `B13a modern 同 clientInfo 并发 5 路全开跑（不受会话 3 配额，${aMs}ms；${JSON.stringify(tally(a.map(kindOf)))}）`);
    const b = await Promise.all(Array.from({ length: 8 }, (_, i) => H.modernPost(h.url, "tools/call", holdArgs, { clientInfo: { name: `c${i % 2}`, version: "1" } })));
    const bT = tally(b.map(kindOf));
    assert(bT.ran === 6 && bT["reject:queue_timeout"] === 2, `B13b modern 并发 8 路：6 跑 + 2 排队超时（全局 6 上限仍约束；${JSON.stringify(bT)}）`);
    assert(/并发闸拒绝\(queue_timeout\)/.test(h.stderr()), "B13b 闸拒绝 fail-loud 进 stderr（[moa#…] 并发闸拒绝(queue_timeout)）");
  } finally {
    const code = await h.stop();
    assert(code === 0, `B13 SIGTERM 优雅退出 exit=${code}`);
  }
}

// ============================================================================
// C hybrid（显式 mode: hybrid / 无 http 段）：legacy 腿照旧
// ============================================================================
console.log("\n=== C 真 server.ts：hybrid（显式 / 缺省） ===");
for (const [tag, root] of [
  ["显式 mode: hybrid", makeModeTree("http:\n  mode: hybrid")],
  ["无 http 段（与生产 moa.yaml 逐字节相同）", makeModeTree(null)],
] as const) {
  const h = await startOn(root);
  try {
    assert(/\[pi-moa-mcp\] http mode=hybrid/.test(h.stderr()), `C ${tag}：启动日志 \`http mode=hybrid\``);
    const d = await rawSend(h.port, { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 81, method: "server/discover", params: {} })) });
    assert(d.status === 200 && (j(d)?.result?.supportedVersions ?? []).includes("2025-11-25"), `C ${tag}：无信封 discover → 200 + 2025 系列（legacy 腿原分支，实际 ${d.status}）`);
    const hs = await H.legacyHandshake(h.url);
    assert(typeof hs.sid === "string" && hs.sid.length > 0, `C ${tag}：legacy initialize 建会话（sid=${hs.sid}）`);
    const st = await H.legacyPost(h.url, { jsonrpc: "2.0", id: 82, method: "tools/list", params: {} }, "stale-sid");
    assert(st.status === 404 && st.msg?.id === 82, `C ${tag}：陈旧会话 → 404（rejectNoSession 照旧，实际 ${st.status}）`);
    const l = await H.modernPost(h.url, "tools/list", {});
    assert(l.status === 200 && (l.msg?.result?.tools ?? []).length === 3, `C ${tag}：modern tools/list 200（实际 ${l.status}）`);
  } finally {
    const code = await h.stop();
    assert(code === 0, `C ${tag}：SIGTERM 优雅退出 exit=${code}`);
  }
}

// ============================================================================
// D 非法配置：启动即 fail-loud
// ============================================================================
console.log("\n=== D 非法 http 配置：server.ts 启动即 fail-loud ===");
for (const [tag, snippet, want] of [
  ["mode: reject", "http:\n  mode: reject", /http\.mode 非法/],
  ["mode: Modern（大小写）", "http:\n  mode: Modern", /http\.mode 非法/],
  ["拼错键 mdoe", "http:\n  mdoe: modern", /http\.mdoe 是未知键/],
] as const) {
  const root = makeModeTree(snippet);
  const port = await H.freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
    cwd: root,
    env: { ...(process.env as Record<string, string>), PIMOA_MCP_TRANSPORT: "http", PIMOA_MCP_PORT: String(port), PIMOA_SPOOL_DIR: mkdtempSync(join(tmpdir(), "pimoa-o3-spool-")), PIMOA_LOG_TEE: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (c: Buffer) => (err += c.toString("utf8")));
  const code = await new Promise<number | null>((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r(-999);
    }, 60_000);
    child.on("exit", (c) => {
      clearTimeout(t);
      r(c);
    });
  });
  assert(code === 1 && /启动失败：loadConfig/.test(err) && want.test(err) && !/server 就绪/.test(err), `D ${tag} → exit=${code}，stderr 含启动失败与原因、未就绪`);
}

console.log(`\no3_http_mode: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
