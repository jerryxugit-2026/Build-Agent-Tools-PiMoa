/**
 * 413 送达测试(v4 §5 / E3 bug 回归;真 HTTP 环回,脱网脱 key)。
 *
 * 运行:npx tsx test/http_413.test.ts
 * 关键验收(审查 C7):**非 100-continue 大 body 必须实收 HTTP 413**,而非 connection reset。
 * 覆盖:①Content-Length 预检 413;②chunked(无 Content-Length)流中超限 413;
 *      ③Expect:100-continue 大 body 在 checkContinue 处 413;④正常小 JSON 照常解析。
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { readJsonBody, reject413, oversizedByHeader } from "../src/mcp/http_util.js";

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

const LIMIT = 256 * 1024; // 测试用小上限,原理同 2MB

// 与 server.ts 同款接线的最小 http 服务。
const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const body = await readJsonBody(req, res, LIMIT);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: body }));
  } catch (err) {
    if (!(err as { handled?: boolean })?.handled && !res.headersSent) {
      res.writeHead((err as { statusCode?: number })?.statusCode ?? 500).end();
    }
  }
});
srv.on("checkContinue", (req, res) => {
  if (oversizedByHeader(req, LIMIT)) {
    reject413(req, res, LIMIT);
    return;
  }
  res.writeContinue();
  srv.emit("request", req, res);
});

function post(opts: {
  body: Buffer;
  chunked?: boolean;
  expectContinue?: boolean;
}): Promise<{ status: number; body: string; err?: string }> {
  return new Promise((resolveP) => {
    const port = (srv.address() as { port: number }).port;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "content-type": "application/json",
          ...(opts.chunked ? {} : { "content-length": String(opts.body.length) }),
          ...(opts.expectContinue ? { expect: "100-continue" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolveP({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", (e) => resolveP({ status: -1, body: "", err: String(e) }));
    if (opts.expectContinue) {
      req.on("continue", () => {
        req.write(opts.body);
        req.end();
      });
      // 若服务端直接 413(不回 100),response 事件会先来,promise 已 resolve。
      setTimeout(() => req.end(), 1500).unref?.();
    } else {
      req.write(opts.body);
      req.end();
    }
  });
}

const big = Buffer.from(`{"pad":"${"A".repeat(LIMIT * 3)}"}`);
const small = Buffer.from('{"hello":"world"}');

srv.listen(0, "127.0.0.1", async () => {
  // ① 非 continue + Content-Length 超限(E3 主用例形态)
  const r1 = await post({ body: big });
  assert(r1.status === 413, `非 continue 大 body 实收 HTTP 413(实际 ${r1.status}${r1.err ? " " + r1.err : ""})`);
  assert(r1.body.includes("files"), "413 响应体含 files 引导");

  // ② chunked(无 Content-Length)→ 流中超限
  const r2 = await post({ body: big, chunked: true });
  assert(r2.status === 413, `chunked 大 body 实收 HTTP 413(实际 ${r2.status})`);

  // ③ Expect: 100-continue 大 body → checkContinue 直接 413
  const r3 = await post({ body: big, expectContinue: true });
  assert(r3.status === 413, `100-continue 大 body 在 checkContinue 处 413(实际 ${r3.status})`);

  // ④ 正常小 JSON
  const r4 = await post({ body: small });
  assert(r4.status === 200 && r4.body.includes("world"), "正常小 JSON 照常解析");
  const r5 = await post({ body: small, expectContinue: true });
  assert(r5.status === 200 && r5.body.includes("world"), "100-continue 小 JSON 照常解析");

  await debt10Group();
  srv.close();
  await o2ModernGroup();
  console.log(`\n[http-413-test] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
});

// ============================================================================
// DEBT-10（2026-09-30）：413 送达竞态回归。
//   病：旧 reject413「先写 413(Connection: close)+end,再弃读」——Node 对 Connection: close 响应写完即关 socket,
//   客户端仍在推 body ⇒ 入站未读数据触发 RST ⇒ 客户端写报 EPIPE/ECONNRESET、读不到 413。原版对不变 http_util
//   连跑 60 次：http.request Content-Length 14 次、chunked 7 次；fetch Content-Length 2 次、chunked 20 次失败。
//   修：body 正在流入的路径（CL 预检、流中超限）先有界弃读完再写 413（reject413 drainFirst）。
//   ⓐ 反复验同形请求（单次跑绿不足以证明竞态已除）：两种客户端 × 两种分帧；
//   ⓑ 兜底不退化：停滞 body 在 DRAIN_TIMEOUT_MS(15s) 内被断开；>64MB chunked 在弃读上限处被断开；
//      声明 CL>64MB 退回立即 413（与改前同一尽力送达）。
// ============================================================================
async function debt10Group(): Promise<void> {
  const { connect } = await import("node:net");
  const port = (srv.address() as { port: number }).port;
  console.log("\n=== DEBT-10：413 送达竞态（反复验 + 弃读兜底）===");
  const is413Body = (s: number, b: string) => {
    try {
      const j = JSON.parse(b);
      return s === 413 && j.error?.code === -32000 && String(j.error?.message).includes("files");
    } catch {
      return false;
    }
  };
  // ⓐ-1 http.request：Content-Length 预检 × 50、chunked 流中超限 × 50
  for (const [label, chunked, n] of [["http.request Content-Length", false, 50], ["http.request chunked", true, 50]] as const) {
    let bad = 0;
    const errs: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await post({ body: big, chunked });
      if (!is413Body(r.status, r.body)) {
        bad++;
        if (errs.length < 3) errs.push(r.err ?? `status=${r.status}`);
      }
    }
    assert(bad === 0, `DEBT-10 ⓐ ${label} 超限 × ${n}：每次都收到 413 JSON（失败 ${bad}${errs.length ? " " + errs.join(";") : ""}）`);
  }
  // ⓐ-2 fetch(undici)：Content-Length × 30、chunked 流 × 30
  for (const [label, chunked, n] of [["fetch Content-Length", false, 30], ["fetch chunked", true, 30]] as const) {
    let bad = 0;
    const errs: string[] = [];
    for (let i = 0; i < n; i++) {
      try {
        const body = chunked
          ? new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(big));
                c.close();
              },
            })
          : big;
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          ...(chunked ? { duplex: "half" } : {}),
        } as RequestInit);
        if (!is413Body(res.status, await res.text())) bad++;
      } catch (e) {
        bad++;
        if (errs.length < 3) errs.push(`${e} cause=${String((e as { cause?: unknown }).cause)}`);
      }
    }
    assert(bad === 0, `DEBT-10 ⓐ ${label} 超限 × ${n}：每次都收到 413 JSON（失败 ${bad}${errs.length ? " " + errs.join(";") : ""}）`);
  }
  // ⓑ-1 停滞：声明 CL=1MB、只发 300KB 后不再发 ⇒ 服务端须在 DRAIN_TIMEOUT_MS(15s)附近断开，不被拖住
  {
    const t0 = Date.now();
    const r = await new Promise<{ ms: number; closedByServer: boolean }>((resolveP) => {
      const s = connect(port, "127.0.0.1");
      s.on("close", () => resolveP({ ms: Date.now() - t0, closedByServer: true }));
      s.on("error", () => {});
      s.on("data", () => {});
      s.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024}\r\n\r\n`);
      s.write("A".repeat(300 * 1024));
      setTimeout(() => {
        s.destroy();
        resolveP({ ms: Date.now() - t0, closedByServer: false });
      }, 30_000).unref();
    });
    assert(r.closedByServer && r.ms >= 14_000 && r.ms < 20_000, `DEBT-10 ⓑ 停滞 body：服务端在弃读超时处断开（${r.ms}ms，closedByServer=${r.closedByServer}）`);
  }
  // ⓑ-2 超量：chunked 连推 80MB（> DRAIN_MAX_BYTES 64MB）⇒ 服务端在弃读上限附近断开，不无限吞
  {
    // 服务端在弃读上限处 finish(false)：尽力写 413 后 destroy。客户端可能先读到那份 413（响应 end），
    // 也可能先在写上报 EPIPE/ECONNRESET——两者都说明服务端不再吞数据；判据是「客户端没能推完 80MB」，
    // 若拿到了响应则必须是 413。
    const r = await new Promise<{ sentMB: number; err?: string; status?: number }>((resolveP) => {
      let sent = 0;
      const chunk = Buffer.alloc(1024 * 1024, 65);
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolveP({ sentMB: sent / 1048576, status: res.statusCode }));
      });
      req.on("error", (e) => resolveP({ sentMB: sent / 1048576, err: String(e) }));
      const pump = (): void => {
        while (sent < 80 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    assert(
      r.sentMB < 80 && (r.err !== undefined || r.status === 413),
      `DEBT-10 ⓑ >64MB chunked：服务端在弃读上限处断开（客户端写出 ${r.sentMB}MB 后 ${r.err ?? `收到 ${r.status}`}）`,
    );
  }
  // ⓑ-3 声明 CL=100MB（> DRAIN_MAX_BYTES）：弃读注定触顶 ⇒ 退回立即写 413（只发头部也能很快读到 413）
  {
    const got = await new Promise<string>((resolveP) => {
      const s = connect(port, "127.0.0.1");
      let buf = "";
      const fin = () => {
        s.destroy();
        resolveP(buf);
      };
      s.on("data", (c) => {
        buf += c.toString();
        if (buf.includes("\r\n\r\n")) setTimeout(fin, 50);
      });
      s.on("close", () => resolveP(buf));
      s.on("error", () => {});
      s.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${100 * 1024 * 1024}\r\n\r\n`);
      setTimeout(fin, 5_000).unref();
    });
    assert(got.startsWith("HTTP/1.1 413"), `DEBT-10 ⓑ 声明 CL=100MB：立即 413（${JSON.stringify(got.slice(0, 20))}）`);
  }
}

// ============================================================================
// O2 hybrid modern 用例组（2026-09-30）：打**真的** src/mcp/server.ts（隔离端口，真 8MiB 上限）。
// 背景（PIMOA-MODERN-VALIDATION.md §5.3 观察 3）：SDK v2 自带 toNodeHandler 边收边回 413 → 客户端还在写时
//   连接被重置（dual 不稳定、reject 直接 fetch failed）。O2 让两腿共用 readJsonBody（读完再判、超限继续读完再丢），
//   parsed body 作第三参交 nodeHandler。这里对**两条腿**各断言 413 真送达（有状态码、有 JSON 体，不是 reset）。
// ============================================================================
async function o2ModernGroup(): Promise<void> {
  const H = await import("./o2_hybrid_harness.js");
  console.log("\n=== O2 modern 用例组：真 server.ts 两腿 413 送达 ===");
  // 真上限 = limits.ts HTTP_MAX_BODY_BYTES 缺省 8MiB（夹具不设 PIMOA_HTTP_MAX_BODY_BYTES）；下面用 9MiB 超限、5MiB 未超限。
  const h = await H.startHybrid();
  const send = (o: {
    body: Buffer;
    headers: Record<string, string>;
    chunked?: boolean;
    expectContinue?: boolean;
  }): Promise<{ status: number; body: string; ct?: string; err?: string }> =>
    new Promise((resolveP) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: h.port,
          method: "POST",
          path: "/mcp",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...o.headers,
            ...(o.chunked ? {} : { "content-length": String(o.body.length) }),
            ...(o.expectContinue ? { expect: "100-continue" } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolveP({ status: res.statusCode ?? 0, body: data, ct: String(res.headers["content-type"] ?? "") }),
          );
        },
      );
      req.on("error", (e) => resolveP({ status: -1, body: "", err: String(e) }));
      if (o.expectContinue) {
        req.on("continue", () => {
          req.write(o.body);
          req.end();
        });
        setTimeout(() => req.end(), 1500).unref?.();
      } else {
        req.write(o.body);
        req.end();
      }
    });
  const pad = (n: number) => "A".repeat(n);
  // legacy 形状：无信封 initialize（isLegacyRequest=legacy）
  const legacyBody = (n: number) =>
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "big", version: "0" }, pad: pad(n) },
      }),
    );
  // modern 形状：带信封的 tools/call（isLegacyRequest=modern）
  const modernHeaders = {
    "mcp-protocol-version": H.MODERN_VERSION,
    "mcp-method": "tools/call",
    "mcp-name": "moa_verify",
  };
  const modernBody = (n: number) =>
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "moa_verify",
          arguments: { prompt: "big", context: pad(n) },
          _meta: { [H.META_PV]: H.MODERN_VERSION, [H.META_CC]: {}, [H.META_CI]: { name: "o2-413", version: "1" } },
        },
      }),
    );
  const nine = 9 * 1024 * 1024;
  try {
    const is413 = (r: { status: number; body: string }) => {
      try {
        const j = JSON.parse(r.body);
        return r.status === 413 && j.error?.code === -32000 && String(j.error?.message).includes("files");
      } catch {
        return false;
      }
    };
    // legacy 腿
    const a1 = await send({ body: legacyBody(nine), headers: {} });
    assert(is413(a1), `O2-L1 legacy 形状 9MiB（Content-Length）→ 413 JSON 送达（实际 ${a1.status}${a1.err ? " " + a1.err : ""}）`);
    const a2 = await send({ body: legacyBody(nine), headers: {}, chunked: true });
    assert(is413(a2), `O2-L2 legacy 形状 9MiB（chunked）→ 413 JSON 送达（实际 ${a2.status}${a2.err ? " " + a2.err : ""}）`);
    // modern 腿
    const b1 = await send({ body: modernBody(nine), headers: modernHeaders });
    assert(is413(b1), `O2-M1 modern 形状 9MiB（Content-Length）→ 413 JSON 送达（实际 ${b1.status}${b1.err ? " " + b1.err : ""}）`);
    const b2 = await send({ body: modernBody(nine), headers: modernHeaders, chunked: true });
    assert(is413(b2), `O2-M2 modern 形状 9MiB（chunked，流中超限）→ 413 JSON 送达（实际 ${b2.status}${b2.err ? " " + b2.err : ""}）`);
    const b3 = await send({ body: modernBody(nine), headers: modernHeaders, expectContinue: true });
    assert(b3.status === 413, `O2-M3 modern 形状 9MiB（Expect: 100-continue）→ checkContinue 处 413（实际 ${b3.status}）`);
    // 未超限：5MiB（> SDK v2 缺省 4MiB，< 8MiB）走 modern 腿正常处理，拿到 tools/call 的结果而不是 413
    const b4 = await send({ body: modernBody(5 * 1024 * 1024), headers: modernHeaders });
    const b4msg = H.parseRpc(b4.ct ?? null, b4.body, 2).msg;
    assert(
      b4.status === 200 && (b4.ct ?? "").includes("text/event-stream") && b4msg?.result !== undefined,
      `O2-M4 modern 5MiB（介于 SDK 缺省 4MiB 与本服务 8MiB 之间）→ 200 SSE 正常结果（实际 ${b4.status} ct=${b4.ct}）`,
    );
  } finally {
    const code = await h.stop();
    assert(code === 0, `隔离实例 SIGTERM 优雅退出 exit=${code}`);
  }
}
