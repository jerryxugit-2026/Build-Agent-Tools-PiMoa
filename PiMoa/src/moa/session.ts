/**
 * 单会话 runner（从 M0 单会话范式抽出，供 MoA 编排层复用）。
 *
 * 一个 proposer / aggregator = 一个 pi `createAgentSession`：
 *   modelRuntime.getModel(provider,id) → createAgentSession({model,tools})
 *   → session.subscribe 收 text_delta/agent_end → session.prompt → 抽 usage/cost。
 *
 * runSession 只产出「原始硬信号」（text / usage / sawAgentEnd / timedOut / aborted / error），
 * proposer success 硬定义（ok / empty）由编排层 orchestrate.ts 严格判定，本文件不下判决。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ProfileName, WorkerRef } from "../config/types.js";
import type { Usage } from "./types.js";
import { bashReadonlyTool } from "../tools/bash_readonly.js";

/** 隔离用空 agentDir（避免加载用户全局 ~/.pi 扩展/技能）。 */
export const DEFAULT_AGENT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../config/agent-empty",
);

/** 建一个完全隔离的 resourceLoader（不加载任何扩展/技能/上下文文件）。 */
export async function createIsolatedLoader(
  cwd: string,
  agentDir: string = DEFAULT_AGENT_DIR,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

/** capability profile → 允许的工具集（M1 最小集）。 */
export const PROFILE_TOOLS: Record<ProfileName, string[]> = {
  // synthesize：给基本只读工具即可（多视角提议，通常不需要写）。
  "synthesize-worker": ["read", "grep", "find", "ls"],
  // verify：取证集 + 自建 `bash_readonly`（现为**沙箱执行**工具，M2+）。命令先过保守严格 quote-aware
  //          结构拒绝 + 取证 allowlist + 每命令 flag denylist（reject 重定向/wrapper/串接/命令替换/RCE），
  //          放行后**在 macOS sandbox-exec 沙箱内**以 execFile shell:false 跑：无网络、写限 scratch、
  //          读限 target+scratch、env 从零构建剥密钥（见 src/tools/sandbox.ts、DESIGN §5）。
  //          ★不变量：沙箱内**无网络 + 无 agent CLI 可达 + 结果不设 addedToolNames** ⇒ 无法 spawn 孙 agent。
  //          仍全部 ⊆ SAFE_SESSION_TOOLS。
  "verify-worker": ["read", "grep", "find", "ls", "bash_readonly"],
  // 交付前降级：等同 verify 只读子集。
  "delivery-readonly-worker": ["read", "grep", "find", "ls"],
};

/**
 * ★安全不变量（徐总 2026-07-24）：PiMoa 子 agent（proposer/aggregator）绝不能生成孙 agent。
 * 子会话工具必须 ⊆ 此 allowlist（allowlist 非 denylist，防漏新危险工具）。
 * - 绝不加：subagent/delegate/task 等派生工具、未受控 bash/execute_code、任何 MCP 工具（尤其 moa 自身→递归扇出）。
 * - M2 加 `bash_readonly`（命令级只读 + reject agent CLI 调用）时才把它加进来。
 * 配套第二道闸：会话必须用隔离 loader（noExtensions），杜绝扩展 registerTool 注入派生工具（见 createIsolatedLoader）。
 */
export const SAFE_SESSION_TOOLS = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
  // M2+：沙箱化取证工具（bash_readonly.ts → sandbox.ts）。经 customTools 直接注入、结果不设 addedToolNames、
  // execute 仅在 macOS sandbox-exec 沙箱内跑只读命令（无网络/无 agent CLI 可达/写限 scratch）——
  // 不开任何 spawn/写外/MCP 面，不破坏「子 agent 不生成孙 agent」不变量。
  "bash_readonly",
]);

export function assertNoGrandchildCapability(tools: string[]): void {
  const bad = tools.filter((t) => !SAFE_SESSION_TOOLS.has(t));
  if (bad.length > 0) {
    throw new Error(
      `[security] PiMoa 子 agent 工具越界（可能生成孙 agent）：[${bad.join(", ")}] 不在安全 allowlist。` +
        ` 子会话仅允许 {${[...SAFE_SESSION_TOOLS].join(", ")}}（M2 增 bash_readonly）。` +
        ` 绝不给 subagent/delegate/bash/execute_code/MCP —— 防递归扇出与提权。`,
    );
  }
}

export interface RunSessionOptions {
  /** per-call 硬超时（ms）；到点 session.abort() 并置 timedOut。 */
  timeoutMs: number;
  /** 覆盖 profile 默认工具集（缺省按 worker.profile 取 PROFILE_TOOLS）。 */
  tools?: string[];
  /** 外部取消信号（编排层 deps.signal）。abort → aborted=true。 */
  signal?: AbortSignal;
  /** 工作目录（会话发现根）。缺省 process.cwd()。 */
  cwd?: string;
  /** 隔离 agentDir（空目录，避免加载用户全局扩展/技能）。 */
  agentDir?: string;
  /** 复用的 resourceLoader（编排层建一次分发，省去每会话重复 reload）。 */
  resourceLoader?: DefaultResourceLoader;
}

/** 单会话运行的原始结果（未判决 ok/empty）。 */
export interface SessionRunResult {
  /** 流式聚合正文（去尾空白前的原始 text_delta 拼接）。 */
  text: string;
  usage: Usage | null;
  costUsd: number;
  durationMs: number;
  /** per-call 超时被 abort。 */
  timedOut: boolean;
  /** 外部 signal 取消。 */
  aborted: boolean;
  /** 是否见到 agent_end（proposer success 硬定义的必要条件之一）。 */
  sawAgentEnd: boolean;
  /** pi 会话 id（供 pi-web attach / receipt）。 */
  sessionId?: string;
  /** 会话级错误（模型未找到 / stopReason=error / 抛异常）。 */
  error?: string;
}

interface AssistantLike {
  usage?: {
    input?: number;
    output?: number;
    reasoning?: number;
    total?: number;
  } | null;
  stopReason?: string;
  errorMessage?: string;
}

function extractUsage(session: {
  getSessionStats: () => {
    tokens: { input: number; output: number; total: number };
    cost: number;
  };
  messages: ReadonlyArray<{ role: string } & AssistantLike>;
}): { usage: Usage | null; costUsd: number } {
  let stats:
    | { tokens: { input: number; output: number; total: number }; cost: number }
    | undefined;
  try {
    stats = session.getSessionStats();
  } catch {
    stats = undefined;
  }
  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant") as AssistantLike | undefined;
  const reasoning = lastAssistant?.usage?.reasoning;
  if (stats) {
    return {
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        ...(typeof reasoning === "number" ? { reasoning } : {}),
        totalTokens: stats.tokens.total,
      },
      costUsd: stats.cost,
    };
  }
  // getSessionStats 不可用时退回最后一条 assistant 的 usage。
  const u = lastAssistant?.usage;
  if (u) {
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    return {
      usage: {
        input,
        output,
        ...(typeof reasoning === "number" ? { reasoning } : {}),
        totalTokens: u.total ?? input + output,
      },
      costUsd: 0,
    };
  }
  return { usage: null, costUsd: 0 };
}

/**
 * 跑一个模型会话到 agent_end（或超时 / 外部取消 / 出错）。
 * 绝不抛：所有失败折成 error/timedOut/aborted 字段回传，让编排层 fail-closed 判决。
 */
export async function runSession(
  modelRuntime: ModelRuntime,
  worker: WorkerRef,
  prompt: string,
  opts: RunSessionOptions,
): Promise<SessionRunResult> {
  const start = Date.now();
  const base: SessionRunResult = {
    text: "",
    usage: null,
    costUsd: 0,
    durationMs: 0,
    timedOut: false,
    aborted: false,
    sawAgentEnd: false,
  };

  // 1) 解析模型：未找到 → 立即返回 error（负例 fail-closed 走这条）。
  const model = modelRuntime.getModel(worker.provider, worker.model);
  if (!model) {
    return {
      ...base,
      durationMs: Date.now() - start,
      error: `模型未找到：${worker.provider}/${worker.model}（检查 models.json）`,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const tools = opts.tools ?? PROFILE_TOOLS[worker.profile] ?? [];
  assertNoGrandchildCapability(tools); // ★安全不变量：子 agent 不能生成孙 agent（越界即抛）

  // 2) 资源隔离：复用传入 loader，否则建一个隔离 loader。
  const loader =
    opts.resourceLoader ?? (await createIsolatedLoader(cwd, opts.agentDir));

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let sessionId: string | undefined;
  let text = "";
  let sawAgentEnd = false;
  let timedOut = false;
  let aborted = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  try {
    const created = await createAgentSession({
      cwd,
      model,
      thinkingLevel: "off",
      modelRuntime,
      tools,
      // 只读取证工具定义随会话注入；仅当 `tools` 含 "bash_readonly" 时才实际启用
      // （verify-worker 启用，proposer/synthesize 不列入即定义而不启用）。经 customTools 注入
      // 不走 ResourceLoader 扩展系统，故 isolated loader 的 noExtensions 屏障不受影响。
      customTools: [bashReadonlyTool],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    session = created.session;
    sessionId = session.sessionId;

    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        text += event.assistantMessageEvent.delta;
      }
      if (event.type === "agent_end") {
        sawAgentEnd = true;
      }
    });

    // per-call 超时：到点 abort，置 timedOut。
    timer = setTimeout(() => {
      timedOut = true;
      void session?.abort();
    }, opts.timeoutMs);

    // 外部取消：传播到会话，置 aborted。
    if (opts.signal) {
      if (opts.signal.aborted) {
        aborted = true;
        void session.abort();
      } else {
        onExternalAbort = () => {
          aborted = true;
          void session?.abort();
        };
        opts.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    try {
      await session.prompt(prompt);
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.signal && onExternalAbort) {
        opts.signal.removeEventListener("abort", onExternalAbort);
      }
      unsubscribe();
    }

    // 3) 会话级错误：最后一条 assistant 的 stopReason=error / errorMessage。
    const lastAssistant = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant") as AssistantLike | undefined;
    if (lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage) {
      error = lastAssistant?.errorMessage ?? "会话报错（stopReason=error）";
    }

    const { usage, costUsd } = extractUsage(
      session as unknown as Parameters<typeof extractUsage>[0],
    );

    return {
      text,
      usage,
      costUsd,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
      sawAgentEnd,
      sessionId,
      ...(error ? { error } : {}),
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (opts.signal && onExternalAbort) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
    return {
      text,
      usage: null,
      costUsd: 0,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
      sawAgentEnd,
      ...(sessionId ? { sessionId } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // 无论如何释放会话（闭合进程/监听泄漏）。
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
  }
}
