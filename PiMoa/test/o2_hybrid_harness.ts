/**
 * O2 hybrid（UG-6/ACT-37，2026-09-30）测试共用夹具：在**隔离端口**上起一份**真的** `src/mcp/server.ts`
 * （PIMOA_MCP_TRANSPORT=http），供各测试文件的 modern 用例组打真请求。文件名不以 `.test.ts` 结尾，
 * 不会被逐个跑测试的循环当成测试执行。
 *
 * 为什么要真起 server.ts：server.ts 是带副作用的入口脚本、没有任何 export，此前各测试只能测 http_util 的
 * 零件、测不到 server.ts 里的**接线本身**（见 sse_keepalive.test.ts 文件头「不覆盖」一节）。O2 的核心改动
 * 恰恰是接线（isLegacyRequest 分流、两腿共用 readJsonBody/413、modern 腿 responseMode、配额 key），
 * 所以 modern 用例一律打这份真进程。
 *
 * 隔离纪律（违反即事故）：
 *   - 端口：listen(0) 取系统空闲端口；8757-8762（生产 MCP 端口段）**硬拒**，绝不向其发请求。
 *   - spool：PIMOA_SPOOL_DIR 指向 mkdtemp 目录，绝不写 ~/.pimoa/spool。
 *   - key：只给 **dummy** 值满足 loadConfig 不变量④（apiKeyEnv 必须存在）；本夹具的用例只走「进模型前
 *     fail-fast」的工具路径（verify 空材料闸、preset 越界闸），不会触达任何 provider。不读任何凭据文件。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PIMOA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MODERN_VERSION = "2026-07-28";
export const META_PV = "io.modelcontextprotocol/protocolVersion";
export const META_CC = "io.modelcontextprotocol/clientCapabilities";
export const META_CI = "io.modelcontextprotocol/clientInfo";

/** 生产端口段：任何情况下都不许碰。 */
const FORBIDDEN_PORTS = new Set([8757, 8758, 8759, 8760, 8761, 8762]);

export function assertIsolatedPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || FORBIDDEN_PORTS.has(port)) {
    throw new Error(`[o2-harness] 拒绝使用端口 ${port}：非隔离端口（8757-8762 为生产段）`);
  }
}

export async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  assertIsolatedPort(port);
  return port;
}

export interface HybridInstance {
  port: number;
  url: string;
  spoolDir: string;
  /** 截至目前子进程的全部 stderr。 */
  stderr: () => string;
  /** SIGTERM 并等退出（server.ts 的优雅关闭路径）。 */
  stop: () => Promise<number | null>;
  child: ChildProcess;
}

/**
 * 起一份真的 server.ts（http 模式）在隔离端口上，等到「server 就绪」行再返回。
 * @param opts.port 指定端口（用于「重启后同端口」用例）；缺省取空闲端口。
 * @param opts.env  额外 env（例如并发闸的 PIMOA_SESSION_MAX_INFLIGHT）。
 */
export async function startHybrid(
  opts: { port?: number; env?: Record<string, string>; spoolDir?: string; slowRgMs?: number } = {},
): Promise<HybridInstance> {
  const port = opts.port ?? (await freePort());
  assertIsolatedPort(port);
  const spoolDir = opts.spoolDir ?? mkdtempSync(join(tmpdir(), "pimoa-o2-spool-"));
  // slowRgMs（F-1 用例用）：在**本隔离子进程**的 PATH 最前放一个「睡 N 毫秒后无命中退出」的假 rg。
  // 用途：让真 server.ts 上的一次工具调用**确定性地**占住并发闸名额 N 毫秒，且不触达任何 provider——
  //   moa_verify + recon_query → recon 经 execFile("rg")（异步、走 PATH，src/moa/recon.ts:362）等待假 rg →
  //   无命中 ⇒ 材料为空 ⇒ enforceVerifyMaterialsPresent 在进模型前 fail-fast。
  // 为什么要替身：本仓没有「又慢又不连模型」的真工具路径；替身只替换外部二进制 rg，服务端逻辑全真。
  // recon 的 rg 超时是 15s（recon.ts:65），slowRgMs 必须明显小于它。
  let pathPrefix = "";
  if (opts.slowRgMs !== undefined) {
    const binDir = mkdtempSync(join(tmpdir(), "pimoa-o2-slowrg-"));
    const rg = join(binDir, "rg");
    writeFileSync(rg, `#!/bin/sh\nsleep ${(opts.slowRgMs / 1000).toFixed(3)}\nexit 1\n`);
    chmodSync(rg, 0o755);
    pathPrefix = `${binDir}:`;
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PIMOA_MCP_TRANSPORT: "http",
    PIMOA_MCP_PORT: String(port),
    PIMOA_SPOOL_DIR: spoolDir,
    PIMOA_LOG_TEE: "0",
    // dummy：只为过 loadConfig 不变量④；本夹具的用例全部在进模型之前 fail-fast，不会用到。
    CLIPROXY_API_KEY: "o2-test-dummy",
    MINIMAX_API_KEY: "o2-test-dummy",
    XIAOMI_API_KEY: "o2-test-dummy",
    DEEPSEEK_API_KEY: "o2-test-dummy",
    ...(opts.env ?? {}),
    ...(pathPrefix ? { PATH: `${pathPrefix}${process.env.PATH ?? ""}` } : {}),
  };
  // O2_HARNESS_SERVER_ROOT：仅供 OLD/NEW 差分探针把同一组用例打到另一棵树（例如 /tmp 下放着改前 server.ts 的镜像树），
  // 以证明 modern 用例对改前代码会红、不是「怎么写都绿」。正常跑测试不设。
  const serverRoot = process.env.O2_HARNESS_SERVER_ROOT ?? PIMOA_ROOT;
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (c: Buffer) => (err += c.toString("utf8")));
  child.stdout!.on("data", () => {});
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const ready = await Promise.race([
    new Promise<boolean>((r) => {
      const t = setInterval(() => {
        if (err.includes(`server 就绪（http://127.0.0.1:${port}/mcp）`)) {
          clearInterval(t);
          r(true);
        }
      }, 50);
    }),
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 90_000).unref()),
  ]);
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(`[o2-harness] server.ts 未在隔离端口 ${port} 就绪。stderr:\n${err.slice(-4000)}`);
  }
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    spoolDir,
    stderr: () => err,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const code = await exited;
      clearTimeout(t);
      return code;
    },
    child,
  };
}

// ---------- 请求构造 ----------
export interface RawResp {
  status: number;
  ct: string | null;
  sessionHdr: string | null;
  raw: string;
  /** 解析出的 JSON-RPC 消息（SSE 取 data 行里 id 匹配的那条；JSON 直接解析）。 */
  msg: any;
  /** SSE 注释帧（`: ...`）条数。 */
  commentFrames: number;
}

export function parseRpc(ct: string | null, raw: string, id: unknown): { msg: any; commentFrames: number } {
  let commentFrames = 0;
  if (ct?.includes("text/event-stream")) {
    let found: any = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) commentFrames++;
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (id === undefined || m.id === id) found = m;
      } catch {
        /* 非 JSON 行 */
      }
    }
    return { msg: found, commentFrames };
  }
  try {
    return { msg: JSON.parse(raw), commentFrames };
  } catch {
    return { msg: raw.slice(0, 500), commentFrames };
  }
}

let nextId = 1000;

/** 手写 modern（2026-07-28）请求：4 个头 + `_meta` 信封。clientInfo=null 表示信封里不带 clientInfo。 */
export async function modernPost(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  o: { clientInfo?: { name: string; version: string } | null; headers?: Record<string, string>; bodyOverride?: string } = {},
): Promise<RawResp> {
  const id = nextId++;
  const meta: Record<string, unknown> = { [META_PV]: MODERN_VERSION, [META_CC]: {} };
  if (o.clientInfo !== null) meta[META_CI] = o.clientInfo ?? { name: "o2-test", version: "1.0" };
  const p = { ...params, _meta: { ...((params._meta as object) ?? {}), ...meta } };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN_VERSION,
    "mcp-method": method,
    ...(method === "tools/call" && typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    ...(o.headers ?? {}),
  };
  const body = o.bodyOverride ?? JSON.stringify({ jsonrpc: "2.0", id, method, params: p });
  const res = await fetch(url, { method: "POST", headers, body });
  const raw = await res.text();
  const ct = res.headers.get("content-type");
  const { msg, commentFrames } = parseRpc(ct, raw, id);
  return { status: res.status, ct, sessionHdr: res.headers.get("mcp-session-id"), raw, msg, commentFrames };
}

/** legacy（2025 系列）请求：无版本信封；可带会话头。 */
export async function legacyPost(url: string, body: Record<string, unknown>, sid?: string, extraHeaders: Record<string, string> = {}): Promise<RawResp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-11-25" } : {}),
    ...extraHeaders,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  const ct = res.headers.get("content-type");
  const { msg, commentFrames } = parseRpc(ct, raw, body.id);
  return { status: res.status, ct, sessionHdr: res.headers.get("mcp-session-id"), raw, msg, commentFrames };
}

/** legacy 握手：initialize + notifications/initialized，返回会话 id。 */
export async function legacyHandshake(url: string, protocolVersion = "2025-11-25"): Promise<{ sid: string | null; init: RawResp }> {
  const init = await legacyPost(url, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "o2-legacy", version: "1.29" } },
  });
  const sid = init.sessionHdr;
  if (sid) {
    await legacyPost(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  }
  return { sid, init };
}

export function newId(): number {
  return nextId++;
}
