/**
 * SSE 保活回归(2026-09-21;真 HTTP 环回,脱网脱 key,不碰 8758)。
 *
 * 被治的病:一轮 PiMoa 审查超过约 300s 时,客户端报 `Error: Request timed out` 放弃,
 * 而服务端那一轮仍在跑、稍后才落 spool(形态 C)。根因由双侧探针确证:响应头这道墙已过,
 * 卡的是**响应体字节之间的空闲**——Node 内置 fetch(undici)的 `bodyTimeout` 默认 300_000ms。
 *
 * 本文件的验收:
 *   ① ★反例(防「盲写破坏 JSON」回归):响应是 application/json 时,**一个字节**都不许被插入,
 *      响应体必须仍能与发送端逐字节相等并被 JSON.parse 吃下。这是本改动最容易造成的回归。
 *   ② 正例:响应是 text/event-stream 时,保活注释行周期出现,且真实事件不被破坏。
 *   ③ 真 transport 环回:真 McpServer + 真 StreamableHTTPServerTransport + 慢工具,保活与
 *      最终 JSON-RPC 回包共存。
 *   ④ 定时器不泄漏:请求结束后保活定时器确已被 clearInterval 清掉。
 *   ⑤ 保活间隔常量与 undici bodyTimeout 的量级关系。
 *   ⑥ 挂载判据 isToolsCallBody(含 JSON-RPC 批数组形态)。
 *
 * 【⚠️ 本文件覆盖到哪、覆盖不到哪 —— 别把它读成比实际更强的保证】
 *   覆盖:①保活守卫 `startSseKeepalive` 的写入条件与清理;②挂载判据 `isToolsCallBody` 的取值。
 *   **不覆盖**:`src/mcp/server.ts` 里的**调用点本身**(那两行 `if (isToolsCallBody(body))
 *   { startSseKeepalive(res); }`)。原因是 `server.ts` 是带副作用的入口脚本、**没有任何 export**,
 *   本文件 import 的只有 `../src/mcp/http_util.js`(见下方 import) ⇒ **把调用点整段删掉,
 *   本文件一条断言都不会红**。调用点目前**只能靠真跑来覆盖**(起临时实例、打真实请求);
 *   将来若把挂载决策抽成可导入的纯函数,才谈得上在这里锁住它。
 *
 * 运行:npx tsx test/sse_keepalive.test.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startSseKeepalive, SSE_KEEPALIVE_MS, isToolsCallBody } from "../src/mcp/http_util.js";

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
/** 只数**保活注释行**(SSE 注释 = 行首 `:`),不与正文里可能出现的冒号混淆。 */
const keepaliveCount = (raw: string): number =>
  raw.split("\n").filter((l) => l.startsWith(": keepalive")).length;

// 用例内注入的短间隔(仅测试用;生产路径由 server.ts 走缺省 SSE_KEEPALIVE_MS)。
const FAST_MS = 20;
const TICKS = 6; // 6 × 20ms = 120ms,确保定时器确实烧穿了多次

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
async function withServer(handler: Handler, fn: (port: number) => Promise<void>): Promise<void> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 反例:JSON 形态响应 —— 保活必须一个字节都不写(否则响应体被插脏,客户端解析不出来)
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[① 反例] 非 SSE(application/json)响应:零插入、仍可 JSON.parse");
  const payload = { jsonrpc: "2.0", id: 1, result: { ok: true, nested: { a: [1, 2, 3] } } };
  const bodyText = JSON.stringify(payload);
  await withServer(
    (req, res) => {
      const stop = startSseKeepalive(res, FAST_MS);
      // 阶段 A:响应头尚未发出(headersSent=false)时,定时器已烧穿数次 —— 一个字节都不该写
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        // 阶段 B:content-type 已明确是 JSON,继续烧穿数次 —— 仍是一个字节都不该写
        setTimeout(() => {
          stop();
          res.end(bodyText);
        }, TICKS * FAST_MS);
      }, TICKS * FAST_MS);
    },
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
      const raw = await res.text();
      assert(res.headers.get("content-type") === "application/json", "响应 content-type 仍是 application/json");
      assert(raw === bodyText, `响应体与发送端逐字节相等(未插入任何保活字节;实收 ${raw.length} 字节 / 应为 ${bodyText.length})`);
      assert(keepaliveCount(raw) === 0, `保活注释行 0 条(实际 ${keepaliveCount(raw)})`);
      let parsed: unknown;
      let parseOk = true;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseOk = false;
      }
      assert(parseOk, "响应体仍能被 JSON.parse 吃下");
      assert(JSON.stringify(parsed) === bodyText, "JSON.parse 后的对象与原始 payload 完全一致");
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ①b 反例(另一条 header 路径):content-type 走 setHeader(而非 writeHead(status,obj))
//     —— 两条写头路径都必须判对,任一漏判都会让 JSON 体被插脏。
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[①b 反例] 非 SSE,且 content-type 经 res.setHeader 走:零插入、仍可 JSON.parse");
  const payload = { jsonrpc: "2.0", id: 7, result: { path: "setHeader" } };
  const bodyText = JSON.stringify(payload);
  await withServer(
    (req, res) => {
      startSseKeepalive(res, FAST_MS);
      res.setHeader("content-type", "application/json");
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200); // 不带 obj:走 setHeader 那条路
        setTimeout(() => res.end(bodyText), TICKS * FAST_MS);
      }, TICKS * FAST_MS);
    },
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
      const raw = await res.text();
      assert(raw === bodyText, `响应体逐字节相等(实收 ${JSON.stringify(raw)} / 应为 ${JSON.stringify(bodyText)})`);
      assert(keepaliveCount(raw) === 0, `保活注释行 0 条(实际 ${keepaliveCount(raw)})`);
      let ok = true;
      try {
        JSON.parse(raw);
      } catch {
        ok = false;
      }
      assert(ok, "响应体仍能被 JSON.parse 吃下");
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 正例:SSE 形态响应 —— 保活注释行周期出现,真实事件不被破坏
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[② 正例] SSE(text/event-stream)响应:保活周期出现、事件完好");
  const ev = (phase: string): string =>
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { phase } })}\n\n`;
  await withServer(
    (req, res) => {
      startSseKeepalive(res, FAST_MS);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(ev("first"));
      setTimeout(() => {
        res.write(ev("second"));
        res.end();
      }, TICKS * FAST_MS);
    },
    async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
      const raw = await res.text();
      const n = keepaliveCount(raw);
      assert(
        (res.headers.get("content-type") ?? "").includes("text/event-stream"),
        "响应 content-type 是 text/event-stream",
      );
      assert(n >= 2, `保活注释行周期出现(收到 ${n} 条,期望 ≥2;静默窗口 ${TICKS * FAST_MS}ms / 间隔 ${FAST_MS}ms)`);
      assert(raw.includes(": keepalive\n\n"), "保活字节是标准 SSE 注释行形态 `: keepalive` + 空行");
      const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"));
      assert(dataLines.length === 2, `两条真实 data 事件一根不少(实际 ${dataLines.length})`);
      assert(
        dataLines.every((l) => {
          try {
            JSON.parse(l.slice("data:".length).trim());
            return true;
          } catch {
            return false;
          }
        }),
        "两条 data 事件仍各自是合法 JSON(保活没把事件切碎)",
      );
      assert(
        raw.includes(`"phase":"first"`) && raw.includes(`"phase":"second"`),
        "首/末两条事件内容都完整抵达",
      );
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 真 transport 环回:真 McpServer + 真 StreamableHTTPServerTransport + 慢工具
//    ⚠️ 本用例的 handler 是**测试自建的**挂载条件(形如 server.ts 的调用点),不是 server.ts 本身;
//       server.ts 无 export、不被本文件加载,故其调用点不在此覆盖范围内(见文件头「覆盖到哪」)。
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[③ 真 transport 环回] 真 MCP transport + 慢工具:保活与最终 JSON-RPC 回包共存");
  const TOOL_MS = 1200;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "test-session-0000",
  });
  const server = new McpServer({ name: "keepalive-test", version: "0.0.0" });
  server.registerTool(
    "slow_echo",
    { description: "sleep then echo", inputSchema: { text: z.string() } },
    async ({ text }) => {
      await sleep(TOOL_MS); // 模拟 MoA 编排期:整段零字节
      return { content: [{ type: "text" as const, text: `echo:${text}` }] };
    },
  );
  await server.connect(transport);

  // 测试自建的挂载条件(形如 server.ts 的调用点;server.ts 本身不在本文件覆盖范围内)。
  // 间隔换成短值(150ms)以便断言的确定性;生产路径由 server.ts 走缺省 SSE_KEEPALIVE_MS。
  const handler: Handler = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end();
        return;
      }
      if ((body as { method?: string })?.method === "tools/call") startSseKeepalive(res, 150);
      void transport.handleRequest(req, res, body);
    });
  };

  await withServer(handler, async (port) => {
    const base = `http://127.0.0.1:${port}/mcp`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initRes = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "keepalive-test", version: "0.0.0" },
        },
      }),
    });
    const initRaw = await initRes.text();
    const sid = initRes.headers.get("mcp-session-id");
    assert(!!sid, `initialize 拿到 mcp-session-id(${sid ?? "(无)"})`);
    assert(initRaw.includes('"serverInfo"'), "initialize 应答含 serverInfo");

    await fetch(base, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const t0 = Date.now();
    const callRes = await fetch(base, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid ?? "" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "slow_echo", arguments: { text: "hi" } },
      }),
    });
    const callRaw = await callRes.text();
    const elapsed = Date.now() - t0;
    const n = keepaliveCount(callRaw);
    assert(elapsed >= TOOL_MS, `工具确实跑了 ${elapsed}ms(≥ 静默 ${TOOL_MS}ms)`);
    assert(n >= 4, `静默 ${TOOL_MS}ms 内收到 ${n} 条保活(间隔 150ms,期望 ≥4)`);
    const first = callRaw.indexOf(": keepalive");
    const last = callRaw.lastIndexOf(": keepalive");
    assert(first >= 0 && first < last, "保活分布在静默期两端之间(不是只在末尾补一笔)");
    const resultLines = callRaw.split("\n").filter((l) => l.startsWith("data:"));
    assert(resultLines.length === 1, `恰有一条真实 data 事件(实际 ${resultLines.length})`);
    let rpc: { id?: unknown; result?: { content?: Array<{ text?: string }> } } | undefined;
    let ok = false;
    try {
      rpc = JSON.parse(resultLines[0]!.slice("data:".length).trim());
      ok = true;
    } catch {
      ok = false;
    }
    assert(ok, "最终回包仍是合法 JSON-RPC(保活注释行未污染 data 行)");
    assert(rpc?.id === 2, `回包 id 对得上(实际 ${JSON.stringify(rpc?.id)})`);
    assert(rpc?.result?.content?.[0]?.text === "echo:hi", `工具结果完好(实际 ${rpc?.result?.content?.[0]?.text})`);
  });
  await server.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 定时器不泄漏:请求结束后保活定时器已被 clearInterval 清掉
//    (getActiveResourcesInfo 看不到 unref 过的 timer,故直接对 setInterval/clearInterval 记账)
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[④ 清理] 请求结束后保活定时器已清除");
  type Timer = ReturnType<typeof setInterval>;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set<unknown>();
  const patched = globalThis as unknown as {
    setInterval: (fn: () => void, ms?: number) => Timer;
    clearInterval: (t?: Timer) => void;
  };
  patched.setInterval = ((fn: () => void, ms?: number): Timer => {
    const t = realSetInterval(fn, ms);
    live.add(t);
    return t;
  }) as typeof globalThis.setInterval;
  patched.clearInterval = ((t?: Timer): void => {
    live.delete(t);
    return realClearInterval(t as Timer);
  }) as typeof globalThis.clearInterval;

  try {
    const baseline = live.size;
    let seenWhileInFlight = -1;
    let closed = false;
    await withServer(
      (req, res) => {
        startSseKeepalive(res, FAST_MS);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": opening\n\n");
        // 断言「已武装」:此刻活着的定时器比基线恰好多 1 个
        seenWhileInFlight = live.size - baseline;
        setTimeout(() => res.end(), TICKS * FAST_MS);
        res.on("close", () => {
          closed = true;
        });
      },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
        await res.text(); // 读到流结束 = 服务端已 end
        await sleep(100); // 留出 close 事件派发与清理的余量
        assert(seenWhileInFlight === 1, `武装后活着的保活定时器恰为 1 个(实际 ${seenWhileInFlight})——并发请求各持一个,不串联`);
        assert(closed, "服务端已观测到响应 close");
        assert(live.size === baseline, `响应结束后保活定时器已清零(基线 ${baseline} → 实际 ${live.size})`);
      },
    );
    // 再等若干倍间隔,确认没有「复活」的定时器(若清理没生效,这里会涨)
    await sleep(5 * FAST_MS);
    assert(live.size === baseline, `再等 ${5 * FAST_MS}ms 后仍为基线(实际 ${live.size})——无泄漏、无复活`);
  } finally {
    patched.setInterval = realSetInterval;
    patched.clearInterval = realClearInterval;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 挂载判据 isToolsCallBody:必须认 JSON-RPC **批数组**形态
//    被修的洞:旧内联判据 `(body as {method?:string})?.method === "tools/call"` 只读顶层 .method,
//    数组恒为 undefined ⇒ `[tools/call]` 判 false ⇒ 含 tools/call 的批数组整轮零字节(与形态 C 同病)。
//    SDK 确实为「含请求的批」开 SSE 流:webStandardStreamableHttp.js:408 拆批、
//    :456 `messages.some(isJSONRPCRequest)`、:464 `The default behavior is to use SSE streaming`。
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[⑥ 挂载判据] isToolsCallBody:认批数组,且不误报");
  const CALL = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "moa_run", arguments: {} } };
  const LIST = { jsonrpc: "2.0", id: 3, method: "tools/list" };
  const NOTE = { jsonrpc: "2.0", method: "notifications/initialized" };

  // 正例
  assert(isToolsCallBody(CALL), "对象 tools/call → true");
  assert(isToolsCallBody([LIST, CALL]), "[其它, tools/call] → true(本单修的洞)");
  assert(isToolsCallBody([CALL]), "[tools/call] → true(本单修的洞)");
  assert(isToolsCallBody([CALL, LIST]), "[tools/call, 其它] → true(位置无关)");
  assert(isToolsCallBody([NOTE, CALL, NOTE]), "[通知, tools/call, 通知] → true(混通知也算)");

  // 反例
  assert(!isToolsCallBody(LIST), "对象其它方法 → false");
  assert(!isToolsCallBody([]), "空数组 [] → false");
  assert(!isToolsCallBody([LIST]), "[其它] → false");
  assert(!isToolsCallBody([LIST, NOTE]), "[其它, 通知] → false");
  assert(!isToolsCallBody([] as unknown[]), "[] 复核 → false");
  assert(!isToolsCallBody(null), "null → false(不抛)");
  assert(!isToolsCallBody(undefined), "undefined → false(不抛)");
  assert(!isToolsCallBody([null]), "[null] → false(不抛)");
  assert(!isToolsCallBody(["x"]), '["x"] → false(不抛)');
  assert(!isToolsCallBody([{ method: 1 }]), "[{method:1}] → false(非字符串 method)");
  assert(!isToolsCallBody(0), "0 → false(不抛)");
  assert(!isToolsCallBody("tools/call"), '裸字符串 "tools/call" → false(不是合法 JSON-RPC)');
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 常量自证:生产间隔必须显著小于 undici bodyTimeout 默认值(300_000ms)
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[⑤ 常量] 保活间隔与 undici bodyTimeout 的关系");
  const UNDICI_BODY_TIMEOUT_MS = 300_000;
  assert(SSE_KEEPALIVE_MS >= 15_000 && SSE_KEEPALIVE_MS <= 20_000, `间隔落在 15–20s 区间(实际 ${SSE_KEEPALIVE_MS}ms)`);
  assert(
    SSE_KEEPALIVE_MS * 2 < UNDICI_BODY_TIMEOUT_MS,
    `间隔的 2 倍仍远小于 undici bodyTimeout ${UNDICI_BODY_TIMEOUT_MS}ms(实际 2×${SSE_KEEPALIVE_MS}=${SSE_KEEPALIVE_MS * 2}ms)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ O2 hybrid modern 腿保活（2026-09-30，设计决定 3）
//    modern 腿不挂 startSseKeepalive，改由 SDK v2 `createMcpHandler({responseMode:"sse", keepAliveMs})` 自写注释帧。
//    【覆盖到哪】
//     ⑦a 真 server.ts（隔离端口）：modern tools/call / tools/list 的响应是 text/event-stream —— 快调用在 v2 缺省
//         responseMode:"auto" 下必是 application/json（⑦c 对照实测），所以这一条**行为上**锁住了 server.ts 的
//         responseMode:"sse" 接线；删掉该选项本条即红。
//     ⑦b SDK 机制（进程内，同一组选项值，只把 keepAliveMs 缩到 150ms）：慢工具期间响应头立即发出、周期性注释帧、
//         最终 JSON-RPC 结果完整。
//     ⑦c 对照（不设 responseMode = v2 缺省 auto）：头要等工具跑完才发、application/json、0 注释帧 —— 即
//         PIMOA-MODERN-VALIDATION.md §5.3 观察 4 的退化形态，证明 ⑦a/⑦b 不是「怎么配都绿」。
//     ⑦d 源码守卫：server.ts 的 modern 选项里 keepAliveMs 取 SSE_KEEPALIVE_MS（15000）且未被置 0。
//    【覆盖不到】真 server.ts 上 15s 间隔的注释帧实际出现：需要一次 >15s 且不触达模型的真工具调用，本仓现有工具
//     路径里不存在（快失败闸都是毫秒级；进模型会连真 provider）。该项由 ⑦b 的 SDK 机制 + ⑦d 的取值守卫合并覆盖，
//     真跑长轮次登记为「待主代理隔离探针」。
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n[⑦ O2 modern 腿保活] responseMode:\"sse\" + keepAliveMs");
  const H = await import("./o2_hybrid_harness.js");
  const { createMcpHandler, McpServer: V2McpServer } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  // ⑦a 真 server.ts
  const h = await H.startHybrid();
  try {
    const call = await H.modernPost(h.url, "tools/call", { name: "moa_verify", arguments: { prompt: "x" } });
    assert(
      call.status === 200 && (call.ct ?? "").includes("text/event-stream") && call.msg?.result !== undefined,
      `⑦a 真 server.ts：modern tools/call → 200 text/event-stream 且结果完整（ct=${call.ct}）`,
    );
    const list = await H.modernPost(h.url, "tools/list", {});
    assert((list.ct ?? "").includes("text/event-stream"), `⑦a 真 server.ts：modern tools/list 同为 SSE（ct=${list.ct}）`);
    const hs = await H.legacyHandshake(h.url);
    const lcall = await H.legacyPost(
      h.url,
      { jsonrpc: "2.0", id: H.newId(), method: "tools/call", params: { name: "moa_verify", arguments: { prompt: "x" } } },
      hs.sid!,
    );
    assert(
      lcall.status === 200 && (lcall.ct ?? "").includes("text/event-stream") && lcall.msg?.result !== undefined,
      `⑦a 真 server.ts：legacy 腿 tools/call 照旧 SSE 且结果完整（ct=${lcall.ct}）`,
    );
  } finally {
    const code = await h.stop();
    assert(code === 0, `⑦a 隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }

  // ⑦b/⑦c SDK 机制与对照
  const TOOL_MS = 1200;
  const makeFactory = () => () => {
    const s = new V2McpServer({ name: "o2-keepalive", version: "0" }, { capabilities: {} });
    s.registerTool(
      "slow_echo",
      { description: "sleep then echo", inputSchema: z.object({ text: z.string() }) },
      async ({ text }: { text: string }) => {
        await sleep(TOOL_MS);
        return { content: [{ type: "text" as const, text: `echo:${text}` }] };
      },
    );
    return s;
  };
  const runOnce = async (responseMode: "sse" | undefined) => {
    const handler = createMcpHandler(makeFactory(), {
      legacy: "reject",
      ...(responseMode ? { responseMode } : {}),
      keepAliveMs: 150,
      maxRequestBodySize: 8 * 1024 * 1024,
    });
    const node = toNodeHandler(handler, { maxRequestBodySize: 8 * 1024 * 1024 });
    let out = { headersMs: -1, ct: "", frames: 0, text: "" as unknown, totalMs: -1 };
    await withServer(
      (req, res) => void node(req, res),
      async (port) => {
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": H.MODERN_VERSION,
            "mcp-method": "tools/call",
            "mcp-name": "slow_echo",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "slow_echo",
              arguments: { text: "hi" },
              _meta: { [H.META_PV]: H.MODERN_VERSION, [H.META_CC]: {} },
            },
          }),
        });
        const headersMs = Date.now() - t0;
        const raw = await res.text();
        const ct = res.headers.get("content-type") ?? "";
        const p = H.parseRpc(ct, raw, 7);
        out = { headersMs, ct, frames: p.commentFrames, text: p.msg?.result?.content?.[0]?.text, totalMs: Date.now() - t0 };
      },
    );
    await handler.close();
    return out;
  };
  const sse = await runOnce("sse");
  assert(sse.ct.includes("text/event-stream"), `⑦b sse：content-type=${sse.ct}`);
  // 注：经 toNodeHandler 时响应头随**第一个注释帧**一起冲刷（≈keepAliveMs，探针
  //   /private/tmp/pimoa-o2-20260930T161855Z/logs/probe-headerflush.log：150→175ms、400→412ms、1000→1007ms），
  //   不是立即发出；生产 15000ms 下头约在第 15s 到达，仍远小于 undici 300s 的头/体超时。
  assert(sse.headersMs < TOOL_MS / 2, `⑦b sse：响应头在工具跑完前就发出（随首个注释帧冲刷，${sse.headersMs}ms < ${TOOL_MS / 2}ms）`);
  assert(sse.frames >= 4, `⑦b sse：工具 ${TOOL_MS}ms 期间出现 ≥4 个注释帧（实际 ${sse.frames}，间隔 150ms）`);
  assert(sse.text === "echo:hi", `⑦b sse：注释帧不破坏最终 JSON-RPC 结果（text=${JSON.stringify(sse.text)}）`);
  const auto = await runOnce(undefined);
  assert(auto.ct.includes("application/json"), `⑦c 对照 auto（v2 缺省）：content-type=${auto.ct}（退化形态）`);
  assert(auto.headersMs >= TOOL_MS - 100, `⑦c 对照 auto：响应头要等工具跑完才发（${auto.headersMs}ms）——长轮次整轮零字节`);
  assert(auto.frames === 0, `⑦c 对照 auto：0 个注释帧（实际 ${auto.frames}）`);

  // ⑦d 源码守卫（server.ts 无 export，只能读源码核对取值；⑦a 已从行为上锁 responseMode）
  const src = readFileSync(join(H.PIMOA_ROOT, "src/mcp/server.ts"), "utf8");
  const m = /createMcpHandler\(\(\) => buildModernServer\(\), \{([\s\S]*?)\n  \}\);/.exec(src);
  const opts = m?.[1] ?? "";
  assert(/responseMode:\s*"sse"/.test(opts), "⑦d server.ts modern 选项含 responseMode: \"sse\"");
  assert(/keepAliveMs:\s*SSE_KEEPALIVE_MS/.test(opts) && SSE_KEEPALIVE_MS === 15_000, `⑦d server.ts modern keepAliveMs = SSE_KEEPALIVE_MS（${SSE_KEEPALIVE_MS}ms，= SDK 缺省）`);
  assert(/legacy:\s*"reject"/.test(opts), "⑦d server.ts modern 选项含 legacy: \"reject\"（误路由 fail-loud）");
}

console.log(`\nsse_keepalive: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
