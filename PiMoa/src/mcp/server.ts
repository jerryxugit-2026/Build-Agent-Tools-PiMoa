#!/usr/bin/env node
/**
 * Pi-MoA MCP 前门（stdio server）。fork 自 pi-mcp 外壳（McpServer + StdioServerTransport
 * + zod inputSchema + registerTool + sendNotification 进度通知 + signal/abort），
 * 但把 pi_ask/continue/fork/list 换成 moa_run / moa_verify（内部驱动 runMoa）。
 *
 * 启动一次性：loadConfig(moa.yaml) + ModelRuntime.create(models.json/auth.json)，缓存复用。
 *   加载期不变量校验失败即 fail-loud（stderr + exit 1），绝不带病启动（承 Coder A §4.5 不变量）。
 *
 * stdio 卫生（DESIGN P2-8）：MCP 协议吃 stdout 的 JSONL —— 本进程**绝不往 stdout 打日志**，
 *   所有诊断走 stderr（console.error）或 MCP notification。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
// O2 hybrid（UG-6/ACT-37，2026-09-30）：modern（2026-07-28 无状态）腿用 TS SDK v2 服务端包；
// legacy（2025 系列有状态会话）腿与 stdio 仍用上面的 SDK 1.29，逐字不变。三代包同进程并存已隔离验证
// （<workspace>/artifacts/pimoa-modern-validation-20260929/PIMOA-MODERN-VALIDATION.md §5.3/§5.4）。
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer as V2McpServer,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.js";
import { stageEventToNotification, type StageEvent } from "./events.js";
import {
  moaToolInput,
  moaDeliverToolInput,
  moaToolOutput,
  runMoaTool,
  runMoaDeliverTool,
  MOA_RUN_DESCRIPTION,
  MOA_VERIFY_DESCRIPTION,
  MOA_DELIVER_DESCRIPTION,
  type MoaToolInput,
  type MoaDeliverToolInput,
  type ToolResponse,
} from "./tools.js";
import { cleanupSpool, spoolHealthWarning } from "./spool.js";
import {
  readJsonBody,
  reject413,
  rejectNoSession,
  oversizedByHeader,
  isDiscoverRequest,
  respondDiscover,
  startSseKeepalive,
  isToolsCallBody,
  SSE_KEEPALIVE_MS,
  type HttpJsonError,
} from "./http_util.js";
import { HTTP_MAX_BODY_BYTES } from "../config/limits.js";
import { ConcurrencyGate, GateRejectError } from "./gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");

/** fail-loud：诊断到 stderr 后退出，绝不启动带病 server。 */
function die(msg: string, err?: unknown): never {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.error(`[pi-moa-mcp] 启动失败：${msg}${detail ? `\n  ${detail}` : ""}`);
  process.exit(1);
}

// ---- 启动一次性：配置 + ModelRuntime（缓存复用）----
const config = (() => {
  try {
    return loadConfig({ moaYaml: resolve(projectRoot, "config/moa.yaml") });
  } catch (err) {
    die("loadConfig（config/moa.yaml）不变量校验未过", err);
  }
})();

const modelRuntime = await (async () => {
  try {
    return await ModelRuntime.create({
      modelsPath: resolve(projectRoot, "config/models.json"),
      authPath: resolve(projectRoot, "config/auth.json"),
    });
  } catch (err) {
    die("ModelRuntime.create（config/models.json、config/auth.json）失败", err);
  }
})();

// spool 启动例行（v4 §7）：清一次过期/超额审计文件 + 卷空间健康检查。绝不影响启动。
try {
  const warn = spoolHealthWarning();
  if (warn) console.error(`[pi-moa-mcp] ⚠️ ${warn}`);
  cleanupSpool();
} catch {
  /* fail-open */
}

// 版本号（用于 server 元信息）。
const pkg = (() => {
  try {
    return JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      version: string;
    };
  } catch {
    return { version: "0.0.0" };
  }
})();

// 服务端身份与能力声明(**单一真源**)。`initialize`(McpServer 构造)与 `server/discover`
// 应答必须报告同一份事实——两处各写一份迟早漂移,而 discover 的语义就是"广告我真正支持什么"。
//
// ⚠️ `tools.listChanged: true` 不是我们主动声明的:SDK 的 `McpServer.registerTool()` 一被调用就会
//   无条件 `registerCapabilities({ tools: { listChanged: true } })`(sdk/dist/esm/server/mcp.js:62),
//   经 mergeCapabilities 并进构造期能力。所以本服务端**在线上真实的 initialize 应答**就是
//   `{"tools":{"listChanged":true},"logging":{}}`(已用真请求核对)。discover 必须照报这一份,
//   否则同一个服务端在 discover 与 initialize 两处自相矛盾——而"提前告知"正是 discover 的全部意义。
const SERVER_INFO = { name: "pi-moa", version: pkg.version };
const SERVER_CAPABILITIES = { tools: { listChanged: true }, logging: {} };

// 活跃 server 实例登记（shutdown 时统一 close）：stdio 恒为 1 个；
// http 模式每 MCP 会话一个（SDK 的 Server 一实例只绑一个 transport）。
// 重资产（config/modelRuntime）与 inFlight 追踪仍是模块级单份，buildServer 只是薄注册层。
const activeServers = new Set<McpServer>();
// modern 腿（v2）是每请求一个 server 实例、请求结束即弃，不进 activeServers；
// 关停时由 createMcpHandler 自带的 close()（abort 在飞 modern 交换 + 关其实例）统一收尾。只在 http 模式赋值。
let closeModernLeg: (() => Promise<void>) | undefined;

/** 把 onStageEvent 接到 MCP sendNotification（客户端不支持 logging 时静默吞）。 */
function makeStageNotifier(
  sendNotification: ((msg: unknown) => void) | undefined,
): (e: StageEvent) => void {
  if (!sendNotification) return () => {};
  return (e) => {
    try {
      sendNotification(stageEventToNotification(e));
    } catch {
      /* 客户端可能不支持 logging 通知；忽略 */
    }
  };
}

/** 进度心跳间隔。20s 远小于 MCP 客户端的 60s 默认请求超时，留三倍余量抗调度抖动。 */
const PROGRESS_HEARTBEAT_MS = 20_000;

/**
 * 长任务进度心跳：周期性发 `notifications/progress`，重置客户端的请求超时计时器。
 *
 * 【为什么必须有 —— 2026-09-19 双侧探针实测出来的根因】
 * 病症：客户端报 `MCP server "pi-moa" transport dropped mid-call; response for tool
 *   "moa_verify" was lost`，而服务端照常跑完并落盘 spool（结果不丢，只是送不回）。
 *   2026-09-19 的 reviewer 对比矩阵 6 格里掉线 2 格（第 169s、第 315s）。
 * 排查链（每一环都实测，不是推理）：
 *   ① 不是 HTTP 层超时 —— `server.timeout` 默认 0（禁用），服务端根本不会主动掐断长响应；
 *      `requestTimeout` 管的是「接收请求」阶段，不管响应阶段。
 *   ② 是客户端侧 MCP 协议层的请求超时 —— 造一个故意睡 330s 的服务端，客户端在第 60.1s
 *      报 `MCP error -32001: Request timed out` 并随即发 `notifications/cancelled`；
 *      SDK 常量 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`。
 *   ③ 协议给的续命机制是 `resetTimeoutOnProgress`：客户端每收到一条 **progress** 通知就
 *      重置计时器。**只认 `notifications/progress`，不认 `notifications/message`。**
 *   ④ PiMoa 原有的 onStageEvent → `stageEventToNotification` 发的是 `notifications/message`
 *      （logging 类型，见 events.ts:46），一条都不续命；
 *      且聚合器阶段只有 started(orchestrate.ts:851)/done(:962) 两个事件，
 *      中间实测 361s 毫无动静 —— 所以「把 logging 改成 progress」也不够，必须有周期心跳。
 *   ⑤ 客户端确实给了 token：实测 `_meta={"claudecode/toolUseId":"…","progressToken":2}`
 *      （ua=claude-code/2.1.275），所以服务端有权回发 progress。
 *
 * 契约细节：`progress` 必须单调递增（MCP 规范）；不传 `total`（总量未知，进度条不可估算）；
 * 客户端断开后发送会 reject，静默吞掉即可（此时 spool 已是唯一取回路径）。
 * 定时器 unref，不阻止进程退出（SIGTERM 要能立刻走）。
 *
 * 【发送函数注入（O2 hybrid）】第一参是**注入的发送函数**，本函数不认 SDK：
 *   legacy 腿（SDK 1.29）注入回调 extra 里的 `sendNotification`；
 *   modern 腿（SDK v2）注入 `ctx.mcpReq.notify`（见 handleToolCall 的两处适配）。
 *   progressToken 两腿都取自请求 `_meta.progressToken`（v2 里是 `ctx.mcpReq._meta`，信封键已被 SDK 摘走、它不受影响）。
 */
function startProgressHeartbeat(
  sendNotification: ((msg: unknown) => Promise<void> | void) | undefined,
  progressToken: string | number | undefined,
): () => void {
  if (!sendNotification || progressToken === undefined || progressToken === null) {
    return () => {};
  }
  const startedAt = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    try {
      void Promise.resolve(
        sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: ticks,
            message: `MoA 进行中…已用 ${Math.round((Date.now() - startedAt) / 1000)}s`,
          },
        }),
      ).catch(() => {
        /* 客户端已断开：此时 spool 是唯一取回路径，发送失败无需处理 */
      });
    } catch {
      /* 同上 */
    }
  }, PROGRESS_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `[pi-moa-mcp] error: ${msg}` }],
    isError: true,
  };
}

// ---- 并发闸(v4 §9,P3):进程级全局单例;10 路并行 = 6 在跑 + 4 有序排队,零静默丢弃 ----
/**
 * modern 腿（O2 hybrid）的并发闸 key：固定值，且与 "stdio" 并列**豁免会话公平配额**，只受全局 6 在跑 + 10 排队约束。
 * 裁决：F-1（徐总 2026-09-30 批准）——沿用 gate.ts quotaExemptKeys 机制与 P3 复审 F8 方案 A 先例。
 * 背景：modern 无会话，而真实客户端的 clientInfo 是写死的常量（DSH rc.2 恒为 dsh-mcp-client@0.0.1，
 *   dsh-mcp-client lib/index.js:596-599），按 clientInfo 计配额会把全机所有 DSH 会话压进同一份 3+4；
 *   故 modern 腿不再按客户端身份计会话配额。legacy 腿仍按每会话 key 受 3+4 约束（逐字不变）。
 * "modern" 不是 8 位十六进制，不会与 legacy 会话 key 撞名。
 */
const MODERN_QUOTA_KEY = "modern";
const gate = new ConcurrencyGate({ quotaExemptKeys: ["stdio", MODERN_QUOTA_KEY] });

/** 闸拒绝 → 结构化工具错误(isError,outputSchema 豁免)。fail-loud:kind+统计+建议全透出。 */
function gateRejectResponse(err: unknown, runId: string) {
  const kind = err instanceof GateRejectError ? err.kind : "unknown";
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[moa#${runId}] 并发闸拒绝(${kind}):${msg}`);
  return {
    content: [{ type: "text" as const, text: `[pi-moa-mcp] 并发闸拒绝(${kind}):${msg}` }],
    isError: true,
  };
}

// ---- 在途调用追踪 + 优雅关闭（资源回收，徐总 2026-07-24；对齐 pi-mcp registerShutdownHandlers）----
// 每次工具调用登记进 inFlight，结束即移除（runSession 的 finally 已 dispose 各会话）；
// server 收 SIGTERM/SIGINT 时 abort 全部在途 → 各会话 dispose → drain → 退出，避免在途请求悬挂。
interface InFlight {
  ac: AbortController;
  promise?: Promise<unknown>;
}
const inFlight = new Set<InFlight>();

/**
 * 把 MCP per-call signal 链到自建 AbortController（这样 server 关闭时也能 abort 在途调用）。
 * 返回 dispose 以解绑 listener（DESIGN §8.3 修复 fix #9：正常结束时若不 remove，长命 mcpSignal
 * 上会累积 once listener 泄漏）。
 */
function linkedController(mcpSignal?: AbortSignal): {
  ac: AbortController;
  dispose: () => void;
} {
  const ac = new AbortController();
  let handler: (() => void) | undefined;
  if (mcpSignal) {
    if (mcpSignal.aborted) ac.abort();
    else {
      handler = (): void => ac.abort();
      mcpSignal.addEventListener("abort", handler, { once: true });
    }
  }
  const dispose = (): void => {
    if (mcpSignal && handler) mcpSignal.removeEventListener("abort", handler);
  };
  return { ac, dispose };
}

/** 追踪一次工具调用：登记 → 跑（用链接后的 signal）→ finally 移除 + 解绑 listener。 */
function track<T>(
  mcpSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { ac, dispose } = linkedController(mcpSignal);
  const entry: InFlight = { ac };
  const p = run(ac.signal).finally(() => {
    inFlight.delete(entry);
    dispose(); // 解绑 signal listener（fix #9：正常结束也解绑，防泄漏）
  });
  entry.promise = p;
  inFlight.add(entry);
  return p;
}

// ---- 工具描述（O2 hybrid：与 SDK 无关的单一真源，legacy/modern 两腿各注册一次）----
// 【为什么抽描述】hybrid 下同一进程里有两代 McpServer：legacy 腿每会话一个 1.29 实例，modern 腿每请求一个 v2 实例。
//   三个工具的名字/描述/入参/出参/执行体若在两处各写一份，迟早漂移（两腿对同一工具报出不同 schema）。
//   故执行体、闸门、心跳、在途追踪全部收进 handleToolCall，两腿只剩「把各自 SDK 的回调上下文适配成 ToolCallIo」这一步。
interface ToolRunDeps {
  signal: AbortSignal;
  runId: string;
  onStageEvent: (e: StageEvent) => void;
}
interface ToolDef {
  name: "moa_run" | "moa_verify" | "moa_deliver";
  description: string;
  /** ZodRawShape：legacy 腿（1.29）直接吃 raw shape；modern 腿（v2）要 z.object 包一层（见 V2_INPUT_SCHEMAS）。 */
  inputShape: typeof moaToolInput | typeof moaDeliverToolInput;
  run: (input: unknown, d: ToolRunDeps) => Promise<ToolResponse>;
}
const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "moa_run",
    description: MOA_RUN_DESCRIPTION,
    inputShape: moaToolInput,
    run: (input, d) =>
      runMoaTool(input as MoaToolInput, config.defaults.preset, {
        config,
        modelRuntime,
        signal: d.signal,
        runId: d.runId,
        onStageEvent: d.onStageEvent,
      }),
  },
  {
    name: "moa_verify",
    description: MOA_VERIFY_DESCRIPTION,
    inputShape: moaToolInput,
    run: (input, d) =>
      runMoaTool(input as MoaToolInput, "moa_verify", {
        config,
        modelRuntime,
        signal: d.signal,
        runId: d.runId,
        onStageEvent: d.onStageEvent,
      }),
  },
  {
    name: "moa_deliver",
    description: MOA_DELIVER_DESCRIPTION,
    inputShape: moaDeliverToolInput,
    run: (input, d) => {
      const del = input as MoaDeliverToolInput;
      // 路径 jail 根 = 受信任工作区（req.cwd），并显式排除安装目录（projectRoot 及子路径）。
      // DESIGN §8.3 修复 fix #3/#4：此前根 = projectRoot 可覆写自身源码/配置；且 allowedRoots
      // 不再回退 cwd/process.cwd（cwd 缺省 → 无受信任根 → deliver 拒绝写入）。
      const workspace = del.cwd;
      return runMoaDeliverTool(del, config.defaults.preset, {
        config,
        modelRuntime,
        signal: d.signal,
        runId: d.runId,
        onStageEvent: d.onStageEvent,
        allowedRoots: workspace ? [workspace] : [],
        denyRoots: [projectRoot],
      });
    },
  },
];

/** 一次工具调用从各自 SDK 回调上下文里适配出来的四样东西（两腿唯一的差异面）。 */
interface ToolCallIo {
  signal: AbortSignal | undefined;
  /** 注入的发送函数：legacy = extra.sendNotification；modern = ctx.mcpReq.notify（已包成永不 reject）。 */
  send: ((msg: unknown) => Promise<void> | void) | undefined;
  progressToken: string | number | undefined;
  /** 并发闸 key：legacy = 每会话 key（受 3+4 会话配额）；modern = 固定豁免 key MODERN_QUOTA_KEY（F-1 裁决，只受全局上限）。 */
  quotaKey: string;
  /** 仅供观测的客户端标签（modern = modernClientLabel(envelope)），只进「准入配额」日志，不参与限额。 */
  clientLabel?: string;
}

/**
 * 两腿共用的工具调用体：闸门准入 → 进度心跳 → 在途追踪下跑执行体 → finally 停心跳、放名额。
 * 逻辑与 O2 之前三个 registerTool 回调里逐字重复的那三份一致，只是抽成一份；唯一新增是一行配额 key 归因日志。
 */
async function handleToolCall(def: ToolDef, input: unknown, io: ToolCallIo) {
  const runId = randomUUID().slice(0, 8); // v4 §9：run-id 归因（日志前缀 [moa#<id>]）
  // 准入归因日志：legacy 打每会话 key；modern 打固定豁免 key + 客户端自报的 clientInfo 标签（仅观测，F-1 裁决）。
  // JSON.stringify 防 clientInfo 里的换行/控制字符污染日志行。
  console.error(
    `[moa#${runId}] ${def.name} 准入配额 key=${JSON.stringify(io.quotaKey)}` +
      (io.clientLabel !== undefined ? ` client=${JSON.stringify(io.clientLabel)}` : ""),
  );
  let release: (() => void) | undefined;
  try {
    release = await gate.acquire(io.quotaKey, io.signal);
  } catch (err) {
    return gateRejectResponse(err, runId);
  }
  // 进度心跳：MoA 编排期间持续发 notifications/progress，重置客户端的请求超时计时器。
  // 根因与实测依据见 startProgressHeartbeat 的注释块。声明必须在 try **外**，
  // 否则下面的 finally 取不到 stopHeartbeat（块级作用域）。
  const stopHeartbeat = startProgressHeartbeat(io.send, io.progressToken);
  try {
    return await track(io.signal, (sig) =>
      def.run(input, {
        signal: sig,
        runId,
        onStageEvent: makeStageNotifier(io.send as unknown as (msg: unknown) => void),
      }),
    );
  } catch (err) {
    return errorResponse(err);
  } finally {
    stopHeartbeat(); // 先停心跳定时器，再放闸门名额
    release?.(); // 复审②③已证 acquire 失败不进本块;?.仅防御(复审建议)
  }
}

/** legacy 腿：SDK 1.29 McpServer，每 MCP 会话一个（有状态会话语义与 O2 之前逐字相同）。 */
function buildServer(sessionKey: string): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: SERVER_CAPABILITIES });
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      // `as`：两种 raw shape 的并集会让 1.29 registerTool 的重载推断失败；回调把 input 当 unknown 交给
      // def.run 自行收窄，运行期传入的仍是 def 自己的那份 shape（moa_deliver = moaDeliverToolInput）。
      {
        description: def.description,
        inputSchema: def.inputShape as typeof moaToolInput,
        outputSchema: moaToolOutput,
      },
      async (input, { signal, sendNotification, _meta }) =>
        handleToolCall(def, input, {
          signal,
          send: sendNotification as unknown as (msg: unknown) => Promise<void> | void,
          progressToken: (_meta as { progressToken?: string | number } | undefined)?.progressToken,
          quotaKey: sessionKey, // legacy 腿配额 key 保持现状：每会话一个（v4 §9）
        }),
    );
  }
  activeServers.add(server);
  return server;
}

// ---- modern 腿（O2 hybrid）----
/**
 * modern 腿客户端标签（**仅观测，不参与限额**）。
 * 口径沿革：O2 设计决定 1 原按 clientInfo 计 modern 会话配额；F-1 裁决（徐总 2026-09-30 批准）改为 modern 腿
 * 固定豁免 key（MODERN_QUOTA_KEY，与 stdio 并列豁免，P3 复审 F8 方案 A 先例），只受全局 6+10 约束——因为真实
 * 客户端 clientInfo 是常量（DSH rc.2 恒为 dsh-mcp-client@0.0.1），按它计配额会把全机 DSH 会话压成一份 3+4。
 * 本函数只把客户端自报身份写进「准入配额」日志供归因：
 *   `_meta["io.modelcontextprotocol/clientInfo"]`（v2 已摘到 `ctx.mcpReq.envelope`）→ `modern:<name>@<version>`；
 *   缺 clientInfo / name 非字符串或空串 → `modern-anon`。
 * 以参数形式注入 buildModernServer，便于替换口径。
 */
const MODERN_ANON_CLIENT_LABEL = "modern-anon";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
function modernClientLabel(envelope: unknown): string {
  const ci =
    envelope && typeof envelope === "object"
      ? (envelope as Record<string, unknown>)[CLIENT_INFO_META_KEY]
      : undefined;
  if (ci && typeof ci === "object") {
    const { name, version } = ci as { name?: unknown; version?: unknown };
    if (typeof name === "string" && name !== "") {
      return `modern:${name}@${typeof version === "string" ? version : ""}`;
    }
  }
  return MODERN_ANON_CLIENT_LABEL;
}

// v2 的 inputSchema/outputSchema 要 z.object 包裹（raw-shape 形态在 v2 已 deprecated）。模块级建一次，
// 不在每请求的 factory 里重建（factory 每请求跑一次）。外层 z.object 与 1.29 内部对 raw shape 的包裹同义。
const V2_OUTPUT_SCHEMA = z.object(moaToolOutput);
const V2_INPUT_SCHEMAS = new Map<ToolDef["name"], z.ZodObject<z.ZodRawShape>>(
  TOOL_DEFS.map((d) => [d.name, z.object(d.inputShape as z.ZodRawShape)]),
);

/** modern 腿：SDK v2 McpServer，createMcpHandler 每请求 new 一个（无会话、无状态）。 */
function buildModernServer(clientLabelOf: (envelope: unknown) => string = modernClientLabel): V2McpServer {
  const server = new V2McpServer(SERVER_INFO, { capabilities: SERVER_CAPABILITIES });
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: V2_INPUT_SCHEMAS.get(def.name)!,
        outputSchema: V2_OUTPUT_SCHEMA,
      },
      async (input, ctx) =>
        handleToolCall(def, input, {
          signal: ctx.mcpReq.signal,
          // v2 的 notify 返回 Promise，交换已结束/客户端断开后可能 reject；makeStageNotifier 只 try/catch 同步异常，
          // 故在适配层吞掉 reject，保持与 legacy 腿「发送失败静默」同一语义，杜绝 unhandledRejection。
          send: (msg: unknown) =>
            ctx.mcpReq.notify(msg as Parameters<typeof ctx.mcpReq.notify>[0]).catch(() => {}),
          progressToken: (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken,
          quotaKey: MODERN_QUOTA_KEY, // F-1：固定豁免 key，只受全局上限
          clientLabel: clientLabelOf(ctx.mcpReq.envelope), // 仅观测
        }),
    );
  }
  return server;
}

// ---- 优雅关闭：SIGTERM/SIGINT → abort 全部在途调用 → drain（≤5s）→ dispose → 退出 ----
let shuttingDown = false;
async function shutdown(sigName: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // 并发闸先关(v4 §9/审查 C8):排队中请求立即 fail-loud 拒绝——旧在途追踪只覆盖"已开跑",
  // 排队者若不在此处拒绝,会被 drain 后的 process.exit 无响应丢弃(客户端只见 connection reset)。
  const rejectedQueued = gate.shutdown();
  console.error(
    `[pi-moa-mcp] 收到 ${sigName}，优雅关闭：拒绝排队 ${rejectedQueued} 个、abort ${inFlight.size} 个在途调用…`,
  );
  for (const e of inFlight) e.ac.abort(); // → 各 runSession 见 signal.abort → session.dispose()
  // drain：等在途 settle（各会话在其 finally 里 dispose），最多 5s 硬兜底。
  const drain = Promise.allSettled(
    [...inFlight].map((e) => e.promise).filter(Boolean) as Promise<unknown>[],
  );
  await Promise.race([
    drain,
    new Promise<void>((r) => setTimeout(r, 5000).unref?.()),
  ]);
  // modern 腿（O2）：abort 在飞 modern 交换并关其每请求实例（在途 MoA 已由上面 inFlight abort 收尾）。
  try {
    await closeModernLeg?.();
  } catch (e) {
    console.error("[pi-moa-mcp] modern 腿 close() 异常(继续退出):", (e as Error)?.message ?? e);
  }
  // 快照迭代（MoA 评审防御性建议）：s.close() 会经 transport.onclose 同步 delete 当前元素，
  // Set 迭代中删当前项虽是规范安全的，但快照隔绝未来 close 级联删除他项的风险。
  for (const s of [...activeServers]) {
    try {
      await s.close();
    } catch (e) {
      // fail-soft 继续退出，但如实留痕（客户端已死时 close 冲刷 stdout 可能 EPIPE）
      console.error("[pi-moa-mcp] server.close() 异常(继续退出):", (e as Error)?.message ?? e);
    }
  }
  try {
    (modelRuntime as unknown as { dispose?: () => void }).dispose?.();
  } catch (e) {
    console.error("[pi-moa-mcp] modelRuntime.dispose() 异常(继续退出):", (e as Error)?.message ?? e);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// ---- 传输选择：PIMOA_MCP_TRANSPORT=http 起共享 HTTP 单实例；默认 stdio（行为与旧版完全一致）----
// http 模式动机（2026-08-12）：ChatGPT 内嵌 codex 对 stdio MCP 是「每线程 fork 一套、线程结束
// 不回收」（openai/codex#20883/#25015/#37402 已知缺陷），实测 46 线程 × ~17MB ≈ 780MB 纯堆积，
// 且每套各自重复 loadConfig+ModelRuntime。url 型没有 command 可 fork，全部线程共享本进程一份重资产。
// 信任模型（徐总 2026-08-12 拍板）：本机开发环境，只绑 127.0.0.1，不加鉴权。
const TRANSPORT = process.env.PIMOA_MCP_TRANSPORT ?? "stdio";
// ---- HTTP 入口形态（O3，统一升级台账 r92 DEC-72 ④ / r97 DEC-75，2026-10-01）----
// 真源 = config/moa.yaml 的 `http.mode`（load.ts parseHttp；缺省 hybrid，非法值/未知键加载期 fail-loud）。
//   hybrid = O2 现网形态，下面的 isLegacyRequest 分流与 legacy 腿逐字不变；
//   modern = 只认 2026-07-28：所有 /mcp 请求（读完 body、判完 413 之后）直接交给 modern 腿的 v2 handler，
//            它以 legacy:"reject" 对 2025 系列请求（带或不带版本头的 initialize、无信封 discover、GET/DELETE 会话操作、
//            批数组）一律回 -32022 / 405 / 400；legacy 腿（会话表、discover 分支、rejectNoSession、startSseKeepalive）不再被触达。
// 故意不设 env 开关：上线改配置 + 重启，回滚改回 hybrid + 重启（与 jevcheck.clientMode 同一套配置纪律）。
const HTTP_MODE = config.http?.mode ?? "hybrid";

if (TRANSPORT === "http") {
  const PORT = Number(process.env.PIMOA_MCP_PORT ?? 8758);
  // 会话表：Mcp-Session-Id → transport。initialize 建会话，DELETE/onclose 拆会话。
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // MoA 评审 P2-1/P2-2（2026-08-12）：body 加大小上限（共享单实例，一个失控客户端不能打爆全机）；
  // 畸形 JSON 归为 400 客户端错误，不再冒充 500 服务器故障污染监控。
  // v4 §5：413 送达修复（旧实现 req.destroy() 先于响应 → 客户端只见 reset）挪进 http_util.ts；
  //   P2 起上限 8MB（limits.ts HTTP_MAX_BODY_BYTES）——材料合并闸(tools.enforceMaterialBudget)已上,
  //   传输层只做兜底,不再兼任材料闸。
  const MAX_BODY_BYTES = HTTP_MAX_BODY_BYTES;

  // ---- modern 腿（O2 hybrid，2026-09-30）：SDK v2 createMcpHandler，每请求一个 buildModernServer() 实例 ----
  // 选项逐条的依据（PIMOA-MODERN-VALIDATION.md §5.3 关键观察 3/4 + 主代理设计决定 3/4/5）：
  //   legacy:"reject"  —— hybrid 下这里只收 isLegacyRequest=false 的流量（与 SDK 入口用同一个分类函数，二者不会分歧）；
  //                      万一有 legacy 请求被误路由进来，fail-loud 回 -32022，绝不静默改走无状态 legacy
  //                      （那会悄悄丢掉会话语义与按会话配额）。前置探针已证：不带信封的 server/discover、
  //                      v1 initialize、JevClient 形状 initialize 均判 legacy，不会进这里（决定 2/5）。
  //                      O3 http.mode=modern 下这里收**全部** /mcp 流量，legacy 请求正是靠这一项被统一拒绝（同一选项，不另建 handler）。
  //   responseMode:"sse" —— 缺省 "auto" 在工具跑完前不发响应头、回 application/json，长轮次整轮零字节，
  //                      撞 undici bodyTimeout 300s（形态 C）；"sse" 立即发头并按 keepAliveMs 写 `: keepalive` 注释帧。
  //                      modern 腿因此**不再挂** http_util.startSseKeepalive（SDK 自己写注释帧，双写无益）。
  //   keepAliveMs      —— 15000，等于 SDK 缺省，也等于 legacy 腿 SSE_KEEPALIVE_MS（同一依据：300s 的 1/20）。
  //   maxRequestBodySize —— 显式 8MiB（与 MAX_BODY_BYTES 同值；SDK 缺省 4MiB）。实际请求体由下面共用的
  //                      readJsonBody 先读完再判超限（413 可送达），解析后的 body 作第三参交给 nodeHandler，
  //                      SDK 对 parsedBody 不再二次读/判；显式设值只是让三处（handler/isLegacyRequest/toNodeHandler）口径一致。
  const modernHandler = createMcpHandler(() => buildModernServer(), {
    legacy: "reject",
    responseMode: "sse",
    keepAliveMs: SSE_KEEPALIVE_MS,
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (e: Error): void => {
      console.error(`[pi-moa-mcp] modern 腿拒绝/异常：${e?.message ?? e}`);
    },
  });
  const modernNodeHandler = toNodeHandler(modernHandler, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (e: Error): void => {
      console.error(`[pi-moa-mcp] modern 腿适配层 500：${e?.message ?? e}`);
    },
  });
  closeModernLeg = () => modernHandler.close();

  const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
        if (url.pathname !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        const body = req.method === "POST" ? await readJsonBody(req, res, MAX_BODY_BYTES) : undefined;
        // 掉线归因用（2026-09-19）：记录 tools/call 是否带 progressToken。
        // 背景：实测确认 transport 掉线是**客户端侧 MCP 协议层的请求超时**（客户端报
        // `-32001 Request timed out` 后发 notifications/cancelled），与 HTTP 层任何超时无关。
        // MCP 为长任务准备的保命机制是 progress notification —— 客户端每收到一条就重置超时
        // 计时器。但服务端只有在客户端于 params._meta.progressToken 给了 token 时才能回发。
        // PiMoa 目前全链零 progress（grep sendProgress/progressToken 零命中），所以一旦聚合器
        // 耗时越过客户端超时，连接必被掐断，而服务端照常跑完落盘 spool（结果不丢，但送不回）。
        // 这行日志用来确认 Claude/Codex 的真实客户端到底带不带 token，决定能不能走 progress 路。
        if ((body as { method?: string } | undefined)?.method === "tools/call") {
          const meta = (body as { params?: { _meta?: unknown; name?: string } }).params;
          console.error(
            `[pi-moa-mcp] tools/call name=${meta?.name ?? "?"} _meta=${JSON.stringify(meta?._meta ?? null)}` +
              `｜ua=${req.headers["user-agent"] ?? "-"}`,
          );
        }
        // ---- O3 http.mode=modern：不分流，全部交给 modern 腿（legacy 请求由 v2 handler 以 legacy:"reject" 拒绝）----
        // body 已由上面共用的 readJsonBody 读完（超限已回 413、畸形 JSON 已抛 400），与 hybrid 的 modern 腿同一送法：
        // parsed body 作第三参，toNodeHandler 不再读 Node 流（§5.3 观察 3：边收边回 413 会被重置，这里不会发生）。
        // GET/DELETE/空 body 时 body=undefined，toNodeHandler 读到的是已结束的空流，交 SDK 判 405 / 400。
        // 保活同 hybrid modern 腿：SDK responseMode:"sse" + keepAliveMs 自写注释帧，不挂 startSseKeepalive。
        if (HTTP_MODE === "modern") {
          await modernNodeHandler(req, res, body);
          return;
        }
        // ---- O2 hybrid 分流（2026-09-30）：按请求形态把一次请求交给 modern 腿或 legacy 腿 ----
        // 判据 = SDK v2 导出的 isLegacyRequest（与 createMcpHandler 入口路由同一段代码，不自己重写分类）。
        //   · 请求体已由上面的 readJsonBody 读完（两腿共用：超限先读完再回 413，确保 413 送达）→ 以 parsed body
        //     作第二参分类（SDK 文档：body 已被读走时必须这样传，否则无法 clone），并作第三参交给 nodeHandler
        //     （toNodeHandler 见到 parsedBody 就不再读 Node 流，也不会重演 §5.3 观察 3 的「边收边回 413 → 连接被重置」）。
        //   · 只有「POST 且有 JSON body」才可能是 modern：GET/DELETE（会话操作）、空 body 在 SDK 里同样判 legacy，
        //     这里直接走 legacy 腿，与 O2 之前逐字相同。
        //   · isLegacyRequest=false 的**全部**交给 modern 腿——包括它的校验阶梯拒绝（-32020/-32602/-32022）：
        //     SDK 明文要求这类请求「必须交给 modern handler、绝不能交给 legacy handler」。
        // discover 处置（设计决定 2，前置探针 /private/tmp/pimoa-o2-20260930T161855Z/logs/probeA-islegacy.json）：
        //   带信封的 server/discover（v2 客户端 auto 协商实际发出的形状，已抓包）判 modern → 由 v2 应答
        //   supportedVersions=["2026-07-28"]；不带信封的 discover 判 legacy → 仍由下面原有分支应答 200 + 2025 系列。
        //   所以原 discover 分支**保留原样**，它只会再收到不带信封的 discover，带信封部分自然移交 v2。
        if (
          req.method === "POST" &&
          body !== undefined &&
          !(await isLegacyRequest(await toWebRequest(req, body), body, {
            maxRequestBodySize: MAX_BODY_BYTES,
          }))
        ) {
          // 保活（设计决定 3）：modern 腿由 SDK 按 responseMode:"sse" + keepAliveMs 自写注释帧，
          // 这里不挂 startSseKeepalive（它只属于下面的 legacy 腿）。
          await modernNodeHandler(req, res, body);
          return;
        }
        // ======== 以下为 legacy 腿（SDK 1.29 有状态会话），O2 之前的代码路径逐字不变 ========
        // ---- server/discover：免会话的能力发现（协议修订 2026-07-28）----
        // 【为什么必须放在会话校验**之前**】规范原文："Servers MUST implement `server/discover`"，
        //   且它是**能力发现**——客户端在 `initialize` **之前**就发它（实测抵达时 `sid=(缺)`）。
        //   放到下面 sid 查表之后就必然落进 rejectNoSession → HTTP 404，客户端拿到的是"请先发
        //   initialize"而不是能力清单（ChatGPT/Codex 据此报 `legacy MCP endpoint does not
        //   support server/discover`）。所以本分支必须早于会话校验返回。
        // 【安全边界】此处**只**放行 `server/discover` 这一个方法；其余方法（含 tools/call）一律
        //   继续走原有会话校验，不因本次改动被放宽。
        if (req.method === "POST" && isDiscoverRequest(body)) {
          respondDiscover(res, body, {
            // 版本取 SDK 真正能协商的那份列表（与 initialize 的协商同源），不手抄常量：
            // 本服务端 SDK 的列表全是 2025 纪（最新 2025-11-25），**不含 2026-07-28**——
            // 如实照报，客户端据此判为 legacy 并回退到 initialize 握手。谎报 2026-07-28 会把
            // 客户端切到现代 wire 编解码，而本服务端 SDK 解析不了，等于把能用的连接弄坏。
            supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO,
          });
          return;
        }
        const sid = req.headers["mcp-session-id"];
        let transport = typeof sid === "string" ? transports.get(sid) : undefined;
        if (!transport) {
          if (req.method !== "POST" || !isInitializeRequest(body)) {
            // 2026-09-07:改 404 + 回显请求 id + 打日志(原 400 + id:null 让 codex 干等 1410s,见 http_util.rejectNoSession)。
            rejectNoSession(res, body, typeof sid === "string" ? sid : undefined);
            return;
          }
          // 显式类型注解断开 t 的自引用推断环（TS7022/7023）
          const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string): void => {
              transports.set(id, t);
            },
          });
          const sessionServer = buildServer(randomUUID().slice(0, 8)); // 每 MCP 会话一个公平配额 key(v4 §9)
          // 会话关闭必须同时清 transports 表和 activeServers 登记——
          // 只清前者会让死 McpServer 实例在 Set 里无限积累（慢泄漏）。
          t.onclose = (): void => {
            if (t.sessionId) transports.delete(t.sessionId);
            activeServers.delete(sessionServer);
          };
          await sessionServer.connect(t);
          transport = t;
        }
        // ---- 工具调用期间 SSE 保活(2026-09-21):治形态 C「客户端 HTTP 空闲超时把长轮次掐断」----
        // 【病症】一轮 PiMoa 审查超过约 300s 时,客户端报 `Error: Request timed out` 放弃,而服务端
        //   那一轮仍在跑、稍后才落 spool(结果不丢,送不回)。服务端日志:`⚠ 工具调用连接在响应完成前
        //   被关闭:第 323.6s｜writableEnded=false ⇒ 断在客户端侧`。
        // 【根因(探针实测,非推断)】响应头这道墙已过——服务端已发 200 + text/event-stream + 首批字节;
        //   卡的是**字节之间的空闲**:Node 内置 fetch(undici)的 `bodyTimeout` 默认 300_000ms,探针实测
        //   第 301.0s 抛 `TypeError: terminated`(cause `UND_ERR_BODY_TIMEOUT`)。
        // 【为什么现在整轮零字节】既有 `startProgressHeartbeat` 在客户端没给 `_meta.progressToken` 时
        //   直接返回空函数(实测 DSH 客户端 `_meta=null`,8/8 次)⇒ 心跳退化成 no-op。故保活必须与
        //   progressToken **完全解耦**:它是传输层通道,不是 MCP 协议通知。
        // 【为什么只挂 tools/call】只有它会长时间占着响应不写字节;`initialize`/`tools/list` 等即时返回。
        // 【必须含批数组形态】JSON-RPC 批数组里只要有请求,SDK 同样开 SSE 长流(sdk 的
        //   webStandardStreamableHttp.js:408 拆批、:456 `messages.some(isJSONRPCRequest)`、
        //   :464 `The default behavior is to use SSE streaming`)⇒ 含 tools/call 的批数组同属长轮次。
        //   故挂载条件走 isToolsCallBody(认数组),不看顶层 .method。
        // 【安全边界】写不写由 http_util.startSseKeepalive 每次判定 content-type 是否为 SSE —— JSON 形态
        //   回包一个字节都不会被插入(见 test/sse_keepalive.test.ts 的反例用例)。
        // 清理:res 的 finish/close 任一触发即清定时器,不在此处 stop(此处 handleRequest 返回时
        //   SSE 流可能还没结束,提前 stop 会掐掉保活)。
        if (isToolsCallBody(body)) {
          startSseKeepalive(res);
        }
        await transport.handleRequest(req, res, body);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode ?? 500;
        if (status >= 500) console.error("[pi-moa-mcp] http 请求处理失败:", err);
        // 413 已由 http_util.reject413 写出（handled）；其余按 headersSent 防重复写。
        if (!(err as HttpJsonError)?.handled && !res.headersSent) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: (err as Error)?.message ?? "internal error",
              },
              id: null,
            }),
          );
        }
      }
    };
  const httpServer = createHttpServer(handleHttpRequest);

  // ---- HTTP 传输层超时显式化：补齐「内部预算 ↔ 传输层」这一环的不变量 ----
  //
  // 【本次要修的真实问题】moa.yaml 的内部预算是 aggregatorPerCallMs=720s、
  //   moaTotalBackstopMs=1350s，而本文件从未设置任何 http.Server 超时，全部吃 Node 默认值。
  //   内部敢跑 1350s、传输层却是一组没人校对过的默认数字 —— 这是「同类配置散落多处、
  //   互相覆盖静默改错」的又一处敞口（徐总 2026-07-13 铁律；上一例是聚合器 per_call 抬到
  //   480s 却被另一文件的 hardBackstop 360s 掐断）。moa.yaml 那套「超时三嵌套加载期强校验」
  //   只校内部三个值彼此的嵌套关系，传输层这一环在校验之外，故此处补上并加不变量。
  //
  // 【⚠️ 一条必须写清的更正】2026-09-19 首次分析时，我把 `requestTimeout=300s` 当成了
  //   transport 掉线的根因（因为 doc-high 的连接恰在第 315s 断开，看着像越线）。**这个归因
  //   是错的**，查 Node 语义后确认：
  //     · `requestTimeout`   = 接收【完整请求】的超时 —— 管的是客户端上传阶段，不管服务端
  //                            处理与响应阶段，因此解释不了「聚合器跑到一半连接断」；
  //     · `server.timeout`   = socket 不活动超时，Node 默认 **0（禁用）** —— 所以服务端
  //                            本来就不会主动掐断长响应；
  //     · `keepAliveTimeout` = 响应【结束之后】等待下一个请求的空闲窗口，同样不在响应期内。
  //   也就是说：**掉线大概率断在客户端侧或连接层，不是这三个值造成的**。同批实测的另一格
  //   code-high 在第 169s 就掉线（远未到 300s），也否证了 300s 阈值假说。真正根因正在用
  //   双侧计时探针定位（服务端记 res "close" 时刻 + 客户端记报错时刻），结论出来前不要
  //   把下面这几行当成掉线的修复。
  //
  // 取值：总兜底 + 60s 余量。不用 0（禁用）—— 那会连真正卡死的上传也不回收；保持有界。
  const HTTP_REQUEST_TIMEOUT_MS = config.timeouts.moaTotalBackstopMs + 60_000;
  // 不变量（fail-loud）：传输层必须严格宽于内部总预算。将来若有人调大 moaTotalBackstopMs
  // 而忘了这里，启动期就炸，而不是等到某次长聚合跑到一半被静默掐断才发现。
  if (HTTP_REQUEST_TIMEOUT_MS <= config.timeouts.moaTotalBackstopMs) {
    die(
      "超时不变量未过：HTTP requestTimeout 必须严格大于 moaTotalBackstopMs",
      new Error(
        `requestTimeout=${HTTP_REQUEST_TIMEOUT_MS}ms ≤ moaTotalBackstopMs=${config.timeouts.moaTotalBackstopMs}ms`,
      ),
    );
  }
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  // headersTimeout 只管 header 阶段，Node 要求它 ≤ requestTimeout。显式写出来，免得将来
  // Node 改默认值时引入静默的行为差异。
  httpServer.headersTimeout = 60_000;
  // keepAliveTimeout：响应【结束之后】等待下一个请求的空闲窗口。Node 默认 5s 偏短 ——
  // MCP 客户端在两次工具调用之间的停顿经常远超 5s，连接被回收后每次都要重建 TCP+握手。
  // 抬到 120s 减少无谓重建。它不在响应期内，故与 transport 掉线无关（见上方更正说明）。
  httpServer.keepAliveTimeout = 120_000;

  // ---- 连接生命周期可观测性（2026-09-19 新增，为掉线归因提供硬证据）----
  // 掉线事故此前完全不可归因：客户端只报 "transport dropped mid-call"，服务端一行日志都没有，
  // 既不知道连接在第几秒断、也不知道是哪一侧先断。这里记三个事实，下次掉线即可直接定性：
  //   · `writableEnded=false` ⇒ 服务端还没写完响应就断了 ⇒ 断在客户端侧或连接层；
  //   · `writableEnded=true`  ⇒ 服务端已写完 ⇒ 是收尾/keep-alive 阶段的事。
  // 只在异常断开时打（正常结束不打），避免污染日志。
  httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now();
    res.on("close", () => {
      // 只告警 POST（工具调用）的异常断开。GET 是 MCP 的 SSE 通知长连，它的 writableEnded
      // 恒为 false、关闭是正常生命周期（会话结束或客户端主动关），告警它只会淹没真信号。
      if (!res.writableEnded && req.method === "POST") {
        console.error(
          `[pi-moa-mcp] ⚠ 工具调用连接在响应完成前被关闭：第 ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
            `｜sid=${req.headers["mcp-session-id"] ?? "(无)"}` +
            `｜writableEnded=false ⇒ 断在客户端侧或连接层，非本服务主动掐断。` +
            `若该次调用耗时长且未见 progress 心跳，检查 startProgressHeartbeat 是否拿到 progressToken`,
        );
      }
    });
  });

  // Expect: 100-continue 路径（v4 §5）：超大 Content-Length 在 body 发出前直接 413；
  // 正常请求 writeContinue 放行后走同一 handler。不挂此监听时 Node 会自动回 100（等于无差别放行）。
  httpServer.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
    if (oversizedByHeader(req, MAX_BODY_BYTES)) {
      reject413(req, res, MAX_BODY_BYTES);
      return;
    }
    res.writeContinue();
    void handleHttpRequest(req, res);
  });
  httpServer.listen(PORT, "127.0.0.1", () => {
    // O3：形态必须在启动日志里可见（上线/回滚后据此确认生效的是哪个形态）。
    console.error(
      `[pi-moa-mcp] http mode=${HTTP_MODE}` +
        (HTTP_MODE === "modern"
          ? "（只认 2026-07-28；legacy 腿不挂，2025 系列请求一律由 v2 handler 拒绝 -32022）"
          : "（modern 走 SDK v2；legacy 走 SDK 1.29 有状态会话）"),
    );
    console.error(
      `[pi-moa-mcp] server 就绪（http://127.0.0.1:${PORT}/mcp）：tools = moa_run, moa_verify, moa_deliver`,
    );
  });
  // http 模式绝不挂 stdin 监听：nohup 起服务时 stdin 立即 close，挂了=起来就自杀。
  // 单个 codex 线程死亡不再整体退出——它的在途调用由 per-request signal 取消（track/linkedController
  // 原样生效），其他线程不受影响；整体退出只走 SIGTERM/SIGINT（手动 kill）。
} else {
  // stdin EOF = 客户端(Codex/ChatGPT 线程)死亡。SDK 的 StdioServerTransport 只听 data/error，
  // EOF 什么都不触发；没有这两行时，空闲态靠事件循环排空自然退出（掩盖了问题），
  // 但 moa_run 在途时 LLM 套接字/沙箱子进程钉住事件循环 → 整个编排白跑到底（ppid=1 有界孤儿，
  // 正是 reap-pimoa-orphans.sh 间歇抓到的东西）。接上后与 SIGTERM 同路：abort 在途 → drain → 退出。
  // end/close 故意双挂（Node 流契约里 end 后几乎必再来 close）；本地去抖保证只触发一次 shutdown，
  // 不依赖 shutdown 内部的 shuttingDown 闩（那个闩防的是 SIGTERM 与 EOF 交叉）。
  let stdinDown = false;
  const onStdinDown = (why: string): void => {
    if (stdinDown) return;
    stdinDown = true;
    void shutdown(why);
  };
  process.stdin.on("end", () => onStdinDown("stdin EOF(客户端退出)"));
  process.stdin.on("close", () => onStdinDown("stdin close(客户端退出)"));

  const transport = new StdioServerTransport();
  await buildServer("stdio").connect(transport);
  console.error(
    "[pi-moa-mcp] server 就绪（stdio）：tools = moa_run, moa_verify, moa_deliver",
  );
}
