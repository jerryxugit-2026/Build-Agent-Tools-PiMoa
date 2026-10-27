/**
 * HTTP 传输层小工具(v4 §5 / §10-E):把 readJson 与 413 送达逻辑抽出 server.ts,
 * 便于单测(server.ts 是带副作用的入口脚本,测试不可 import)。
 *
 * 413 送达的协议细节(E3 实锤修复,审查 C7):
 *   - 旧实现超限即 req.destroy() → socket 已死,外层写不回 413,客户端只见 connection reset。
 *   - 非 100-continue 客户端(curl 默认小 body、undici/fetch)不等确认就推 body:
 *     若不把在途 body 读弃干净就关连接,TCP 会因未读数据在 close 时发 RST,客户端的写先报
 *     EPIPE/ECONNRESET、读不到 413。
 *   - ★DEBT-10 更正(2026-09-30,复现器实测):旧顺序「先写 413(Connection: close)+ end,再弃读」仍会 RST——
 *     Node http server 对 Connection: close 的响应在**写完即关 socket**(不等我们的弃读),此时入站数据未读完
 *     ⇒ RST。原版对不变的 http_util 连跑:http.request/Content-Length 14/60、chunked 7/60;fetch 2/60、
 *     fetch chunked 20/60 失败。故 body 正在流入的两条路径(Content-Length 预检、流中超限)改为
 *     **先有界弃读完剩余 body,再写 413 并关连接**;弃读超量/超时仍 destroy 兜底(不被恶意大 body 拖住)。
 *   - Expect: 100-continue 路径由 server 的 checkContinue 处理器在 body 发出前直接拒(server.ts 接线):
 *     客户端在等 100、body 尚未发出,故该路径保持「立即写 413」(reject413 缺省模式),不能等弃读。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

// ---- SSE 保活(2026-09-21;治形态 C「客户端 HTTP 空闲超时把长轮次掐断」)----
/**
 * 保活间隔。**依据**:Node 内置 fetch(undici)的 `bodyTimeout` 默认 **300_000ms** ——
 * 它计的是「响应体两个 chunk 之间的空闲」,不是整轮时长。故只要间隔明显小于 300s,
 * 任何「字节间空闲」计时器都不会烧穿。取 15s = 300s 的 1/20,留 20 倍余量抗调度抖动,
 * 同时远小于常见 60s 代理/网关空闲回收窗口。不取更短:那只是无意义的网络噪音。
 *
 * 【实测背景】2026-09-21 双侧探针确证:服务端已发出 `200 + content-type: text/event-stream`
 *   + 首批字节(响应头这道墙已过),随后整轮零字节,客户端 fetch 在第 301.0s 抛
 *   `TypeError: terminated`(`cause: UND_ERR_BODY_TIMEOUT`)。即卡的是**字节之间的空闲**。
 */
export const SSE_KEEPALIVE_MS = 15_000;

/**
 * 保活字节:SSE 注释行(`:` 开头)+ 空行。
 * SSE 规范:以 `:` 开头的行是注释,任何合规解析器一律忽略;且注释不写 data 缓冲 ⇒ 不派发事件。
 * 故对**所有**客户端安全。**绝不能改成 `data:` 形态**——那会被当成一条真实 MCP 消息交给客户端处理。
 */
const SSE_KEEPALIVE_BYTES = ": keepalive\n\n";

/**
 * 启动 SSE 保活:每 `intervalMs` 往 res 写一行 SSE 注释,使「响应体字节间空闲」计时器
 * (undici `bodyTimeout` 默认 300s)永不烧穿。返回 stop 供显式收尾(正常路径靠 finish/close 自清)。
 *
 * 【为什么必须与 progressToken 解耦】`startProgressHeartbeat`(server.ts)只在客户端给了
 *   `params._meta.progressToken` 时才真正发通知;DSH 的 MCP 客户端实测 `_meta=null`(8/8 次),
 *   于是心跳退化成 no-op、整轮零字节。保活是**传输层**通道,不依赖客户端任何声明,
 *   也不改变 progress 心跳的语义(两条通道并行)。
 *
 * 【安全边界(本改动最易造成的回归)】写之前**每次**都判「本响应实际写出去的 content-type 是否
 *   text/event-stream」;响应头未发或不是 SSE(JSON 形态回包)时**一个字节都不写** —— 盲写会把
 *   JSON 响应体插脏,使客户端再也解析不出来。
 *
 * 【⚠️ 为什么不能只用 `res.getHeader("content-type")` —— 实测踩到,务必保留这段注释】
 *   Node 文档明载:`writeHead(status, obj)` 会把给出的头**直接写到网络**而不进内部缓存,
 *   此后 `getHeader()` 拿不到该头。2026-09-21 在 Node v22.22.2 + **真** SDK transport 上实测:
 *     `res.writeHead(200, {"content-type":"text/event-stream"})` 之后
 *     `headersSent === true`,而 `getHeader("content-type") === undefined`、`getHeaders() === {}`
 *     (`_header` 原始头块里确写着 `content-type: text/event-stream`)。
 *   SDK 的 StreamableHTTPServerTransport(底层 `@hono/node-server`)走的**正是**这条 fast path,
 *   所以「headersSent && getHeader 含 text/event-stream」这个判据在本栈上**恒假** ——
 *   按它写出来的保活会静默失效(一个字节都不发,病症原样保留)。
 *   故:在武装的这一刻截住 `writeHead`,把**真正要写出去**的 content-type 记下来;
 *   `setHeader` 路径(`getHeader` 可用)作为并列来源。两条路皆无 ⇒ 判非 SSE,一个字节不写。
 *
 * 【fail-open】流已收尾/写失败一律静默吞掉,绝不把异常抛进请求路径。
 * 【清理】`finish` 与 `close` 任一触发即 clearInterval + 还原 writeHead;
 *   每个请求各持一个定时器,互不串联(ServerResponse 是每请求新建的对象,不存在跨请求共享)。
 * 【不阻止退出】定时器 `unref()`。
 *
 * @param intervalMs 仅供单测注入短间隔;生产路径一律用缺省 `SSE_KEEPALIVE_MS`。
 */
export function startSseKeepalive(
  res: ServerResponse,
  intervalMs: number = SSE_KEEPALIVE_MS,
): () => void {
  // ① 截住本响应真正写出的头(见上方「为什么不能只用 getHeader」)
  let declared = "";
  const realWriteHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    for (const a of args) {
      if (a === null || typeof a !== "object") continue; // 跳过 statusCode / statusMessage
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        if (k.toLowerCase() === "content-type") {
          declared = Array.isArray(v) ? v.join(",") : String(v);
        }
      }
    }
    return (realWriteHead as (...x: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;

  // ② setHeader 路径的并列来源(getHeader 只在响应头尚未发出、或走的是 setHeader 时有效)
  const emittedContentType = (): string => {
    if (declared) return declared;
    const h = res.getHeader("content-type");
    return Array.isArray(h) ? h.join(",") : h === undefined ? "" : String(h);
  };

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return; // 已收尾:交给 finish/close 清的定时器
    if (!res.headersSent) return; // 响应还没开始:形态未知,写下去就是往未来的 JSON 体里插脏
    if (!emittedContentType().toLowerCase().includes("text/event-stream")) return; // ★防回归
    try {
      res.write(SSE_KEEPALIVE_BYTES);
    } catch {
      /* fail-open:流已坏,静默吞掉,清理走 close */
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  const stop = (): void => {
    clearInterval(timer);
    res.writeHead = realWriteHead; // 还原(幂等;res 是每请求新建对象,不会外溢)
  };
  res.on("finish", stop);
  res.on("close", stop);
  return stop;
}

/** 413 弃读上限:超过就不再陪客户端耗,直接断(防恶意无限流)。 */
const DRAIN_MAX_BYTES = 64 * 1024 * 1024;
/** 413 弃读时限。 */
const DRAIN_TIMEOUT_MS = 15_000;

export interface HttpJsonError extends Error {
  statusCode: number;
  /** true=响应已由本模块写出(413),外层 catch 不必再写。 */
  handled?: boolean;
}

export function httpError(status: number, message: string, handled = false): HttpJsonError {
  return Object.assign(new Error(message), { statusCode: status, handled });
}

/** 413 响应体(JSON-RPC 形):附当前上限与"大材料请改 files"引导(v4 §5)。 */
function payload413(limit: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message:
        `请求体超过 ${limit} 字节上限。大材料请改用 files 传路径(由服务端 recon 读入),` +
        "或分段传 context;本上限只是传输兜底,不是材料预算。",
    },
    id: null,
  });
}

/** 写 413 响应(Connection: close)。幂等:headersSent 时跳过;响应通道已坏时静默。 */
function write413(res: ServerResponse, limit: number): void {
  try {
    if (!res.headersSent) {
      res.writeHead(413, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(payload413(limit));
    }
  } catch {
    /* 响应通道已坏,交给弃读/断连兜底 */
  }
}

/**
 * 把 413 真正送达客户端。两种模式:
 *   - 缺省(立即):写 413 → 有界弃读 → 断连。**只给 Expect: 100-continue 的 checkContinue 路径用**——
 *     那时客户端在等 100、body 尚未发出,没有在途数据可触发 RST;等弃读反而会干等到超时。
 *   - drainFirst(DEBT-10):**先**有界弃读完剩余 body(req 'end'),**再**写 413 并关连接——body 正在流入的
 *     路径(Content-Length 预检、流中超限)必须用它,否则 Node 在 Connection: close 响应写完即关 socket,
 *     未读入站数据 ⇒ RST,客户端读不到 413(见文件头 DEBT-10 更正)。
 *     兜底:弃读超 DRAIN_MAX_BYTES 或超 DRAIN_TIMEOUT_MS ⇒ 尽力写 413 后 destroy(不被恶意大 body 拖住);
 *     Content-Length 已声明超过 DRAIN_MAX_BYTES 时弃读注定触顶,直接退回立即模式(与改前同一尽力送达)。
 */
export function reject413(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
  opts: { drainFirst?: boolean } = {},
): void {
  // 声明长度已超弃读上限 ⇒ 弃读注定触顶 destroy,等它只会把「尽力送达的 413」变成必然 reset:退回立即模式。
  const drainFirst = opts.drainFirst === true && !oversizedByHeader(req, DRAIN_MAX_BYTES);
  if (!drainFirst) write413(res, limit);
  // 弃读在途 body:恢复流动但丢弃数据;超量/超时 destroy 兜底。
  let drained = 0;
  let settled = false;
  const finish = (complete: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (drainFirst) write413(res, limit); // 入站已读尽(complete)⇒ 关连接不再 RST
    if (!complete) req.destroy();
  };
  const timer = setTimeout(() => finish(false), DRAIN_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  req.on("data", (c: Buffer) => {
    drained += c.length;
    if (drained > DRAIN_MAX_BYTES) finish(false);
  });
  req.on("end", () => finish(true));
  req.on("error", () => {
    settled = true;
    clearTimeout(timer);
  });
  req.resume();
}

/** Content-Length 预检:显式超限的请求不必等 body 流入。 */
export function oversizedByHeader(req: IncomingMessage, maxBytes: number): boolean {
  const len = Number(req.headers["content-length"]);
  return Number.isFinite(len) && len > maxBytes;
}

/**
 * 读 JSON body(带上限)。超限:交给 reject413(drainFirst:先弃读完再写 413),并立即以 handled=true 的
 * 413 错误 reject——此刻 413 可能尚未写出(还在弃读),外层 catch 必须据 handled 跳过、绝不自行写响应。
 * 畸形 JSON → 400(未 handled,外层写)。
 */
export function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    if (oversizedByHeader(req, maxBytes)) {
      reject413(req, res, maxBytes, { drainFirst: true }); // body 正在流入:先弃读再回 413(DEBT-10)
      reject(httpError(413, `请求体超过 ${maxBytes} 字节上限(Content-Length 预检)`, true));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return; // 已 413:后续 data 由 reject413 的弃读接管
      total += c.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject413(req, res, maxBytes, { drainFirst: true }); // 同上(DEBT-10)
        reject(httpError(413, `请求体超过 ${maxBytes} 字节上限`, true));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise(undefined);
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(httpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// ---- 无有效会话的拒绝应答(2026-09-07) ----
/** 从已解析的 JSON-RPC body 里取请求 id(单条或批量);取不到记 null。 */
export function jsonRpcIds(body: unknown): Array<string | number | null> {
  const one = (m: unknown): string | number | null => {
    if (m && typeof m === "object" && "id" in m) {
      const id = (m as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
    return null;
  };
  return Array.isArray(body) ? body.map(one) : [one(body)];
}

/**
 * 无有效会话(Mcp-Session-Id 缺失/未 initialize/服务重启后旧会话失效)的拒绝应答。
 *
 * 2026-09-07 徐总反映"PiMoa 原生调用及重试均 timed out awaiting tools/call after 1410s":8758 于 00:23 重启后,
 * 重启前建立的 codex 线程仍带旧 Mcp-Session-Id 发 tools/call;旧实现回 **HTTP 400 + `"id":null`**,codex 的 MCP
 * 客户端无法把该错误对上自己发出的请求 id,当作没收到,一直等到 tool_timeout_sec(1410s)——服务端零日志零 spool。
 * 08-14 起同一形状已复发 6 次(见会话记录"无有效会话：请先发 initialize")。
 *
 * 现在:① **回显请求 id**(批量逐条回显),客户端能立即把 -32000 错误对上号、秒失败而非等 23.5 分钟;
 * ② HTTP 状态改 **404**(MCP streamable HTTP 规范:会话不存在 → 404,客户端应重新 initialize 开新会话;
 *    会自动重连的客户端可透明恢复,不会的也能立刻报错);③ stderr 打一行,不再零痕迹。
 */
export function rejectNoSession(res: ServerResponse, body: unknown, sid: string | undefined): void {
  const ids = jsonRpcIds(body);
  const method =
    body && typeof body === "object" && !Array.isArray(body) && "method" in body
      ? String((body as { method?: unknown }).method)
      : Array.isArray(body)
        ? `batch(${body.length})`
        : "?";
  console.error(
    `[pi-moa-mcp] 拒绝无效会话：sid=${sid ?? "(缺)"} method=${method} id=${ids.map(String).join(",")}` +
      `——多为 8758 重启后客户端沿用旧会话；客户端须重新 initialize(codex/Claude 线程开新的)。`,
  );
  const mk = (id: string | number | null) => ({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message:
        "无有效会话：请先发 initialize（8758 已重启或会话已过期，旧 Mcp-Session-Id 失效；codex/Claude 线程请开新的）",
    },
    id,
  });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? ids.map(mk) : mk(ids[0])));
}

// ---- tools/call 判据(2026-09-21;SSE 保活的挂载条件) ----
/**
 * body 里是否含 `tools/call` —— **含 JSON-RPC 批数组形态**。
 *
 * 【为什么必须认数组形态】JSON-RPC 允许批量请求,SDK 也确实支持,并会为**含请求的批**开 SSE 长流:
 *   `sdk/dist/esm/server/webStandardStreamableHttp.js:408` `if (Array.isArray(rawMessage))`
 *   把批拆成 messages;`:456` `messages.some(isJSONRPCRequest)` 判定「含请求」;
 *   `:464` 注释原文 `The default behavior is to use SSE streaming`。
 *   外层 `streamableHttp.js` 只做 Node 包装后委派(其中 `batch` / `Array.isArray` 零命中)。
 *   若只读顶层 `.method`,数组形态恒为 `undefined` ⇒ 保活不会被挂上,而含 `tools/call` 的批
 *   同样会整轮零字节 —— 与形态 C(客户端 HTTP 空闲超时把长轮次掐断)**同病**。
 *   故语义定为:**数组里任意一个成员是 `tools/call` 即为真**。
 *
 * 非对象成员(`null` / 字符串 / 数字)经可选链取 `.method` 得 `undefined`,自然为假。
 */
export function isToolsCallBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((m) => (m as { method?: string } | undefined)?.method === "tools/call");
  }
  return (body as { method?: string } | undefined)?.method === "tools/call";
}

// ---- server/discover 免会话应答(协议修订 2026-07-28) ----
/**
 * 是否 `server/discover` 请求(只认单条 JSON-RPC;批量形态不由本函数认领)。
 *
 * 规范原文(protocol revision 2026-07-28):"Servers MUST implement `server/discover`"。
 * 它是**能力发现**——客户端在 `initialize` 之前就发它,所以抵达服务端时天然没有会话。
 */
export function isDiscoverRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === "server/discover"
  );
}

/** discover 应答的**真实**事实来源:由调用方从实际 SDK/服务声明传入,不在本模块硬编码。 */
export interface DiscoverFacts {
  /** 服务端真正能协商的协议版本(与 `initialize` 的协商同一份来源)。 */
  supportedVersions: readonly string[];
  /** 服务端真正声明的能力(与 `initialize` 同一份来源,防两处漂移)。 */
  capabilities: Record<string, unknown>;
  /** 服务端身份,写入 `_meta["io.modelcontextprotocol/serverInfo"]`(规范 SHOULD)。 */
  serverInfo: { name: string; version: string };
}

/**
 * 免会话应答 `server/discover`:HTTP 200 + 该方法自己的成功结果(不是错误)。
 *
 * 分层依据:本函数与 `rejectNoSession` 同层(HTTP 层、SDK transport 之前)。无会话时压根没有
 * transport 可投递,而本方法按规范就不要求会话,故只能在会话校验之前就地应答。
 *
 * 字段照官方 `DiscoverResultSchema` 逐字对齐:`supportedVersions`(必需)、`capabilities`(必需)、
 * `instructions`(可选)、`_meta`(可选)。`instructions` 故意不写——本服务端从未声明过,写就是编造。
 * 响应体走 `application/json`(MCP streamable HTTP 允许 POST 请求回单条 JSON,客户端
 * transport 同时接受 `application/json` 与 `text/event-stream`)。
 */
export function respondDiscover(res: ServerResponse, body: unknown, facts: DiscoverFacts): void {
  const id = jsonRpcIds(body)[0];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      result: {
        supportedVersions: [...facts.supportedVersions],
        capabilities: facts.capabilities,
        _meta: { "io.modelcontextprotocol/serverInfo": facts.serverInfo },
      },
      id,
    }),
  );
}
