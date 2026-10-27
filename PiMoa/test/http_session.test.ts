/**
 * 无效会话拒绝应答回归(2026-09-07;真 HTTP 环回,脱网脱 key)。
 *
 * 运行:npx tsx test/http_session.test.ts
 * 被堵的洞:8758 重启后,重启前建立的 codex 线程带旧 Mcp-Session-Id 发 tools/call,旧实现回 400 + id:null,
 * codex 客户端对不上请求 id 当作没收到,干等 tool_timeout 1410s(08-14 起复发 6 次)。
 * 验收:① 状态 404(MCP 规范:会话不存在);② 回显请求 id(单条/批量逐条);③ 无 id 的通知回 id:null;④ 错误码 -32000。
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { readJsonBody, rejectNoSession, jsonRpcIds } from "../src/mcp/http_util.js";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.error(`  ❌ ${msg}`); }
}

const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readJsonBody(req, res, 1024 * 1024);
  rejectNoSession(res, body, req.headers["mcp-session-id"] as string | undefined);
});

function post(json: unknown, sid?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const port = (srv.address() as { port: number }).port;
    const data = Buffer.from(JSON.stringify(json));
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/mcp",
        headers: { "content-type": "application/json", "content-length": data.length, ...(sid ? { "mcp-session-id": sid } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolveP({ status: res.statusCode ?? 0, body: b })); },
    );
    req.on("error", rejectP);
    req.end(data);
  });
}

await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
try {
  const r1 = await post({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "moa_verify", arguments: {} } }, "00000000-dead-dead-dead-000000000000");
  const j1 = JSON.parse(r1.body);
  assert(r1.status === 404, `旧会话 tools/call → HTTP 404(实际 ${r1.status})`);
  assert(j1.id === 77, `回显请求 id=77(实际 ${JSON.stringify(j1.id)})——客户端能对上号秒失败,不再等 1410s`);
  assert(j1.error?.code === -32000 && /initialize/.test(j1.error?.message ?? ""), "错误码 -32000 且文案提示重新 initialize");

  const r2 = await post({ jsonrpc: "2.0", id: "abc", method: "tools/list" });
  const j2 = JSON.parse(r2.body);
  assert(r2.status === 404 && j2.id === "abc", "无 session 头的非 initialize 请求同样 404 并回显字符串 id");

  const r3 = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, "stale");
  const j3 = JSON.parse(r3.body);
  assert(r3.status === 404 && j3.id === null, "无 id 的通知:404 且 id:null(通知本就无应答可对)");

  const r4 = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "ping" }], "stale");
  const j4 = JSON.parse(r4.body);
  assert(Array.isArray(j4) && j4.length === 2 && j4[0].id === 1 && j4[1].id === 2, "批量请求逐条回显 id");

  assert(JSON.stringify(jsonRpcIds({ id: 5 })) === "[5]" && JSON.stringify(jsonRpcIds({})) === "[null]", "jsonRpcIds 单条取值/缺省 null");
} finally {
  srv.close();
}

// ============================================================================
// O2 hybrid modern 用例组（2026-09-30）：打**真的** src/mcp/server.ts（隔离端口，见 test/o2_hybrid_harness.ts）。
// 验：isLegacyRequest 分流后，legacy 腿会话语义逐字不变（含形态 A），modern 腿无会话、重启后照常可用；
//     discover 按有无信封分走两腿（设计决定 2：不带信封仍是 200 + 2025 系列，DSH auto 旧回落路径不破）。
// ============================================================================
{
  const H = await import("./o2_hybrid_harness.js");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  console.log("\n=== O2 modern 用例组：真 server.ts 隔离端口 ===");
  let h = await H.startHybrid();
  const port = h.port;
  try {
    // M1 不带信封的 discover → legacy 腿原有分支：200 + 2025 系列，无会话头
    const d1 = await H.legacyPost(h.url, { jsonrpc: "2.0", id: 11, method: "server/discover", params: {} });
    const v1 = d1.msg?.result?.supportedVersions ?? [];
    assert(
      d1.status === 200 && d1.msg?.id === 11 && v1.includes("2025-11-25") && !v1.includes(H.MODERN_VERSION) && d1.sessionHdr === null,
      `M1 不带信封 discover → 200 + 2025 系列（legacy 腿原分支保留）：status=${d1.status} versions=${JSON.stringify(v1)}`,
    );
    // M2 带信封的 discover → modern 腿（v2 应答）：supportedVersions=["2026-07-28"]，无会话头
    const d2 = await H.modernPost(h.url, "server/discover", {});
    assert(
      d2.status === 200 && JSON.stringify(d2.msg?.result?.supportedVersions) === JSON.stringify([H.MODERN_VERSION]) && d2.sessionHdr === null,
      `M2 带信封 discover → 200 + ["2026-07-28"]（modern 腿）：status=${d2.status} versions=${JSON.stringify(d2.msg?.result?.supportedVersions)}`,
    );
    // M3 modern tools/list 不握手、不带会话 → 200，三个工具，响应无 Mcp-Session-Id
    const l = await H.modernPost(h.url, "tools/list", {});
    const names = (l.msg?.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    assert(
      l.status === 200 && JSON.stringify(names) === JSON.stringify(["moa_deliver", "moa_run", "moa_verify"]) && l.sessionHdr === null,
      `M3 modern tools/list 免会话 200，工具=${JSON.stringify(names)}，会话头=${l.sessionHdr}`,
    );
    // M4 modern 请求即使带一个陈旧 Mcp-Session-Id 也不受会话表约束（按信封分流，不走 rejectNoSession）
    const l2 = await H.modernPost(h.url, "tools/list", {}, { headers: { "mcp-session-id": "00000000-dead-dead-dead-000000000000" } });
    assert(l2.status === 200 && Array.isArray(l2.msg?.result?.tools), `M4 modern 请求带陈旧会话头仍 200（实际 ${l2.status}）`);
    // M5 legacy 握手照旧建会话；带会话 tools/list 可用
    const hs = await H.legacyHandshake(h.url);
    assert(typeof hs.sid === "string" && hs.sid.length > 0, `M5 legacy initialize 建会话：Mcp-Session-Id=${hs.sid}`);
    const ll = await H.legacyPost(h.url, { jsonrpc: "2.0", id: H.newId(), method: "tools/list", params: {} }, hs.sid!);
    assert(ll.status === 200 && (ll.msg?.result?.tools ?? []).length === 3, `M5 legacy 带会话 tools/list 200（实际 ${ll.status}）`);
    // M6 legacy 陈旧会话 → 仍是 404 + 回显 id（原有 rejectNoSession 行为不变）
    const st = await H.legacyPost(h.url, { jsonrpc: "2.0", id: 4242, method: "tools/call", params: { name: "moa_verify", arguments: { prompt: "x" } } }, "stale-sid");
    assert(st.status === 404 && st.msg?.id === 4242 && st.msg?.error?.code === -32000, `M6 legacy 陈旧会话 → 404 回显 id（实际 ${st.status} id=${st.msg?.id}）`);
    // M7 modern 头/体不一致 → 交 modern 腿的校验阶梯（400 -32020），不落进 legacy 的 404
    const mm = await H.modernPost(h.url, "tools/call", { name: "moa_verify", arguments: { prompt: "x" } }, { headers: { "mcp-name": "moa_run" } });
    assert(mm.status === 400 && mm.msg?.error?.code === -32020, `M7 modern Mcp-Name 不一致 → 400 -32020（实际 ${mm.status} code=${mm.msg?.error?.code}）`);
    // M8 官方 client 2.0.0：auto → modern；默认（legacy）→ legacy 有会话
    const ca = new Client({ name: "o2-auto", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await ca.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    const caTools = await ca.listTools();
    assert(ca.getProtocolEra() === "modern" && caTools.tools.length === 3, `M8 client 2.0 auto 协商 → era=${ca.getProtocolEra()}，tools=${caTools.tools.length}`);
    await ca.close();
    const cl = new Client({ name: "o2-legacy", version: "1" });
    const clT = new StreamableHTTPClientTransport(new URL(h.url));
    await cl.connect(clT);
    assert(cl.getProtocolEra() === "legacy" && typeof clT.sessionId === "string", `M8 client 2.0 默认 → era=${cl.getProtocolEra()}，有会话=${typeof clT.sessionId === "string"}`);
    await cl.close();

    // M9 重启（同一隔离端口）：modern 免会话照常可用（形态 A 对 modern 消失）；legacy 旧会话 404（形态 A 对 legacy 仍在，hybrid 已知代价）
    await h.stop();
    h = await H.startHybrid({ port });
    const after = await H.modernPost(h.url, "tools/list", {});
    assert(after.status === 200 && (after.msg?.result?.tools ?? []).length === 3, `M9 重启后 modern tools/list 直接 200（实际 ${after.status}）`);
    const oldSid = await H.legacyPost(h.url, { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }, hs.sid!);
    assert(oldSid.status === 404 && oldSid.msg?.id === 99, `M9 重启后 legacy 旧会话 → 404（形态 A 仍在，实际 ${oldSid.status}）`);
  } finally {
    const code = await h.stop();
    assert(code === 0, `隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }
}
console.log(`\nhttp_session: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
