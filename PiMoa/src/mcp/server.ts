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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.js";
import { stageEventToNotification, type StageEvent } from "./events.js";
import {
  moaToolInput,
  moaDeliverToolInput,
  runMoaTool,
  runMoaDeliverTool,
  MOA_RUN_DESCRIPTION,
  MOA_VERIFY_DESCRIPTION,
  MOA_DELIVER_DESCRIPTION,
  type MoaToolInput,
  type MoaDeliverToolInput,
} from "./tools.js";

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

const server = new McpServer(
  { name: "pi-moa", version: pkg.version },
  { capabilities: { tools: {}, logging: {} } },
);

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

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `[pi-moa-mcp] error: ${msg}` }],
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

server.registerTool(
  "moa_run",
  { description: MOA_RUN_DESCRIPTION, inputSchema: moaToolInput },
  async (input, { signal, sendNotification }) => {
    try {
      return await track(signal, (sig) =>
        runMoaTool(input as MoaToolInput, config.defaults.preset, {
          config,
          modelRuntime,
          signal: sig,
          onStageEvent: makeStageNotifier(
            sendNotification as unknown as (msg: unknown) => void,
          ),
        }),
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.registerTool(
  "moa_verify",
  { description: MOA_VERIFY_DESCRIPTION, inputSchema: moaToolInput },
  async (input, { signal, sendNotification }) => {
    try {
      return await track(signal, (sig) =>
        runMoaTool(input as MoaToolInput, "moa_verify", {
          config,
          modelRuntime,
          signal: sig,
          onStageEvent: makeStageNotifier(
            sendNotification as unknown as (msg: unknown) => void,
          ),
        }),
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.registerTool(
  "moa_deliver",
  { description: MOA_DELIVER_DESCRIPTION, inputSchema: moaDeliverToolInput },
  async (input, { signal, sendNotification }) => {
    try {
      const del = input as MoaDeliverToolInput;
      // 路径 jail 根 = 受信任工作区（req.cwd），并显式排除安装目录（projectRoot 及子路径）。
      // DESIGN §8.3 修复 fix #3/#4：此前根 = projectRoot 可覆写自身源码/配置；且 allowedRoots
      // 不再回退 cwd/process.cwd（cwd 缺省 → 无受信任根 → deliver 拒绝写入）。
      const workspace = del.cwd;
      return await track(signal, (sig) =>
        runMoaDeliverTool(del, config.defaults.preset, {
          config,
          modelRuntime,
          signal: sig,
          onStageEvent: makeStageNotifier(
            sendNotification as unknown as (msg: unknown) => void,
          ),
          allowedRoots: workspace ? [workspace] : [],
          denyRoots: [projectRoot],
        }),
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ---- 优雅关闭：SIGTERM/SIGINT → abort 全部在途调用 → drain（≤5s）→ dispose → 退出 ----
let shuttingDown = false;
async function shutdown(sigName: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(
    `[pi-moa-mcp] 收到 ${sigName}，优雅关闭：abort ${inFlight.size} 个在途调用…`,
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
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  try {
    (modelRuntime as unknown as { dispose?: () => void }).dispose?.();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[pi-moa-mcp] server 就绪（stdio）：tools = moa_run, moa_verify, moa_deliver",
);
