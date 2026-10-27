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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ProfileName, WorkerRef } from "../config/types.js";
import type { ReadRecord, SessionTrace, StructuredSummary, Usage, VerdictsState } from "./types.js";
import type { AmendState, FindingsState } from "../tools/submit_findings.js";
import { createBashReadonlyTool } from "../tools/bash_readonly.js";
import { createReadTool } from "../tools/read_budgeted.js";
import { createLsTool } from "../tools/ls_jailed.js";
import { createSembleSearchTool } from "../tools/semble_search.js";
import { createDevkbSearchTool } from "../tools/devkb_search.js";
import { createWebFetchTool } from "../tools/web_fetch.js";
import { budgetSnapshot, createRetrievalBudget, type RetrievalBudget } from "../tools/budget.js";

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

// 2026-10-19 D-30／D-31：Anthropic 订阅 OAuth 对含 pi 文档段的 system 判第三方（400），仅 anthropic 剔除 docs。
export function stripPiDocsSections<T extends { role: string; sections?: Record<string, string | null> }>(messages: T[]): T[] {
  let found = false;
  const filtered = messages.map((message) => {
    if (message.role !== "system" || !message.sections || !("docs" in message.sections)) return message;
    const docs = message.sections.docs;
    if (docs === null) return message; // 保留既有会话显式删除 docs 的 delta。
    if (typeof docs !== "string" || !docs.startsWith("<docs>\nPi documentation (read only when") || !docs.endsWith("\n</docs>")) {
      throw new Error("[pi-moa] Anthropic OAuth 内建 docs 段结构漂移，拒绝原样请求");
    }
    found = true;
    const { docs: _docs, ...sections } = message.sections;
    return { ...message, sections } as T;
  });
  if (!found) throw new Error("[pi-moa] Anthropic OAuth 未找到内建 docs 段，拒绝原样请求");
  return filtered;
}

/** capability profile → 允许的工具集（M1 最小集）。 */
export const PROFILE_TOOLS: Record<ProfileName, string[]> = {
  // synthesize：只允许受限语义检索。修复 2026-07-25（徐总）——大输入下 proposer 会自作主张调 find/grep
  //   探索文件系统（find 单次可吐 5w+ 字符），把对话吹成多轮高 token 流，撞上游 gemini/antigravity
  //   "Stream ended without finish_reason" 间歇断流 → 正文空 → 2/2 fail-closed。综合任务应就 `context`
  //   入参给定的内容作答，不需翻盘；实测无工具版每次一轮直接答出非空。要喂文件内容走 moa_run 的 context。
  //   ★2026-08-06 加 `web_fetch`（徐总定）：综合任务常需核证带出处的外部事实。
  //     它只取**已知 URL** 的正文、不做关键词检索，输出与 read/bash_readonly 共用同一本预算账。
  //   ★2026-08-13 加 `devkb_search`：Paper System 检索分流铁律的工具面——semble_search 现在
  //     对 Paper System 路径一律 REJECT（见 semble_search.ts 分流执法），必须给出合法出口。
  "synthesize-worker": ["semble_search", "devkb_search", "web_fetch"],
  // verify：取证集 + 自建 `bash_readonly`（现为**沙箱执行**工具，M2+）。命令先过保守严格 quote-aware
  //          结构拒绝 + 取证 allowlist + 每命令 flag denylist（reject 重定向/wrapper/串接/命令替换/RCE），
  //          放行后**在 macOS sandbox-exec 沙箱内**以 execFile shell:false 跑：无网络、写限 scratch、
  //          读限 target+scratch、env 从零构建剥密钥（见 src/tools/sandbox.ts、DESIGN §5）。
  //          ★不变量：沙箱内**无网络 + 无 agent CLI 可达 + 结果不设 addedToolNames** ⇒ 无法 spawn 孙 agent。
  //          仍全部 ⊆ SAFE_SESSION_TOOLS。
  // 修复 2026-07-25（徐总）：去掉 pi 自带 find/grep——它们的输出量 pi 说了算、PiMoa 封不了顶
  //   （曾一次吐 5w+ 字符把对话撑爆 → 撞上游断流 → 正文空 → fail-closed）。verify 的搜索一律改走
  //   bash_readonly：它封顶 TOOL_SLICE_CHARS（limits.ts，现 12 万字符）+ 截断时明确提示调用方 + 在沙箱内跑（三重收益）。read/ls
  //   读单文件/单目录天然有界，保留为自带工具。
  //   ★2026-08-06 加 `web_fetch`（徐总明确决定，已知悉代价）：
  //     验真常要核证"某 CVE 是否属实""某标准原文怎么写""某库文档是否如其所述"，
  //     这些断言自带出处，缺的是「能去看一眼」。
  //     ⚠️ 两条代价已在 web_fetch.ts 文件头部诚实标注，勿在后续改动中假装不存在：
  //       ① moa.yaml 里密钥保护论证的第②条"沙箱无网络（读到也发不出去）"到此为止——
  //          本工具跑在宿主进程，沙箱本身仍无网，但 agent 可把读到的内容拼进 URL 发出去；
  //       ② 网页正文是提示注入面，而 verify 产出的是**裁决**。已用不可信数据块包裹加固，
  //          但那是缓解不是硬保证。
  "verify-worker": ["read", "ls", "bash_readonly", "semble_search", "devkb_search", "web_fetch"],
  // 交付前降级：等同 verify 只读子集。2026-07-25 同 verify 一并去自带 find/grep、改走 bash_readonly
  //   （内含 rg/ast-grep/rtk，封顶+沙箱+门控，见 §4.8）。read/ls 天然有界保留。
  "delivery-readonly-worker": ["read", "ls", "bash_readonly", "semble_search", "devkb_search"],
};

/**
 * ★安全不变量（徐总 2026-07-24）：PiMoa 子 agent（proposer/aggregator）绝不能生成孙 agent。
 * 子会话工具必须 ⊆ 此 allowlist（allowlist 非 denylist，防漏新危险工具）。
 * - 绝不加：subagent/delegate/task 等派生工具、未受控 bash/execute_code、原始 MCP 工具（尤其 moa 自身→递归扇出）。
 * - 允许 `semble_search`，但它是固定绝对路径 + cwd jail + 预算/输出/超时封顶的本机 CLI 工具，不是 MCP 递归入口。
 * - M2 加 `bash_readonly`（命令级只读 + reject agent CLI 调用）时才把它加进来。
 * 配套第二道闸：会话必须用隔离 loader（noExtensions），杜绝扩展 registerTool 注入派生工具（见 createIsolatedLoader）。
 */
/** 结构化提交工具名（schema 层拒绝计数用）。 */
const STRUCTURED_TOOL_NAMES = new Set(["submit_findings", "amend_facts", "submit_verdicts"]);

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-10）：结构化提交被 typebox schema 层拒绝时不进处理器、不计 attempts →
 * 模型反复交不合 schema 的参数（如 ``` 围栏包裹、字段超长）时重提链没有任何上限，只能等 per-call 超时 →
 * 本会话层另设「连续 schema 拒」计次，到顶即 abort 会话并以「参数格式连续 N 次不合规」终止该提交链 →
 * 边界：计次独立于业务 REJECT 的 attempts（不并入、不消耗、不重置它）；上限落会话层不落 schema（types.ts 不动）；
 * 一次手滑后正常提交照常受理。
 * ★2026-09-27 徐总裁定（批次 1 fix 批 F4）：业务 REJECT/PARTIAL 若把「连续」清零 → 模型按
 * 「schema 拒 ×(N-1) → 交一次空清单吃业务 REJECT → 再 schema 拒 ×(N-1)」交替即可无限绕开上限 →
 * 改为**只有被处理器接受（isError=false）的调用才清零**；业务 REJECT/PARTIAL 与 tool_error 既不计次也不清零 →
 * 边界：业务 REJECT 本身仍不进本计次（它有自己的 attempts 上限），只是不再有「洗白」连续计次的副作用。
 *   实测偏差（端到端用例 63 抓出，pi 0.84.1）：pi agent-core 的 executePreparedToolCall 对「处理器正常返回」一律发
 *   `tool_execution_end.isError=false`，处理器结果对象里的 `isError: true` 只留在 result 上 → 「是否被接受」不能只看
 *   事件 isError，改由 isStructuredAccept 综合判（事件 isError / result.isError / 文案「REJECT（」前缀任一命中即非接受）。
 *   pi 0.99.2 起处理器结果的 `isError: true` 会透传到事件（`tool_execution_end.isError=true`，toolResult 消息同为 true；
 *   pi-upgrade-eval-20261001 iserror 探针实测，测的是 REJECT 形态）；REJECT 仍按文案前缀归 "handler"、isStructuredAccept
 *   仍判非接受；PARTIAL 本就 isError=false，两版都算接受（见下方 isStructuredAccept 注释）。综合判据对两版结论一致，保留不改。
 * 可调：改这个常量即可（1 = 首次 schema 拒即终止；调大 = 容忍更多次格式重试）。
 */
export const SCHEMA_REJECT_MAX = 5;

/**
 * DEF-10：把一次 `tool_execution_end` 归类——非结构化工具 → null；isError=false → "handler"（处理器已受理；是否接受见 isStructuredAccept）；
 * isError 且文案以「REJECT（/PARTIAL（」开头 → "handler"（处理器业务拒）；isError 且是 pi 参数层拒绝
 * （typebox 校验失败「Validation failed for tool」或输出截断「was not executed: the response hit the output
 * token limit」，处理器均未执行）→ "schema_reject"；其余 isError → "tool_error"。
 * 与 schemaRejects 总数统计同一判据（纯函数，便于单测）。
 *
 * ★2026-09-27 徐总裁定（批次 1 fix 批 F1）：旧判据是「isError 且不带 REJECT/PARTIAL 前缀 ⇒ schema 拒」的**反向兜底** →
 * 「Tool xxx not found」、处理器抛异常、Operation aborted、被 beforeToolCall 拦截都被误记成格式拒，进连续计次、
 * 可误触发 abort → 改为**正向匹配** pi 参数层的两类固定文案才算 schema 拒，其余 isError 独立归 "tool_error"
 * （不进 schemaRejects 总数、不进连续计次、也不清零）→ 边界：schema 拒口径只收窄不放宽；REJECT 单条句式零变化。
 *
 * ★2026-09-27 徐总裁定（批次 1 fix 批 F2，政策落地）：格式拒（schema 拒）归**模型类失败** → 到顶 abort 会话，
 * 编排层 judgeAgg 归 klass="model" → 触发一层备胎聚合器自救；备胎同样受本上限（SCHEMA_REJECT_MAX）约束，
 * 到顶即终（不再有第二层 fallback、不无限尝试）→ 边界：DEF-06「契约缺陷不降级」只限**内容契约拒**
 * （处理器业务 REJECT 累计到 attempts 上限），格式拒不在此列。
 */
export function classifyStructuredToolEnd(ev: {
  toolName?: string;
  isError?: boolean;
  result?: unknown;
}): "schema_reject" | "handler" | "tool_error" | null {
  if (!ev.toolName || !STRUCTURED_TOOL_NAMES.has(ev.toolName)) return null;
  if (!ev.isError) return "handler";
  const text = extractToolResultText(ev.result);
  if (/^(REJECT|PARTIAL)（/.test(text)) return "handler";
  if (/^Validation failed for tool /.test(text)) return "schema_reject";
  if (/was not executed: the response hit the output token limit/.test(text)) return "schema_reject";
  return "tool_error";
}

/**
 * ★2026-09-27 徐总裁定（批次 1 fix 批 F4）：判一次结构化工具结束是否「被处理器接受」（唯一能清零连续 schema 拒计次的情形）→
 * pi 0.84.1 对处理器正常返回一律发事件 isError=false，业务 REJECT 的 isError 只留在 result 上，只看事件会把 REJECT 当接受清零
 * （0.99.2 起事件 isError 随 result 透传，本判据两版通用）→
 * 事件 isError、result.isError、文案「REJECT（」前缀任一命中即判非接受 → 边界：PARTIAL（部分接受，文案「已接受…」、
 * isError=false）仍算接受；只读判定，不改归类口径（classifyStructuredToolEnd 返回值不变）。
 */
export function isStructuredAccept(ev: { toolName?: string; isError?: boolean; result?: unknown }): boolean {
  if (classifyStructuredToolEnd(ev) !== "handler") return false;
  if (ev.isError) return false;
  if ((ev.result as { isError?: unknown } | null | undefined)?.isError === true) return false;
  return !/^REJECT（/.test(extractToolResultText(ev.result));
}

/** DEF-10 到顶文案（固定句式「参数格式连续 N 次不合规」，编排层原样透传进 proposal / aggregator 的 error）。 */
export function schemaRejectCapMessage(n: number): string {
  return `结构化提交参数格式连续 ${n} 次不合规（被工具参数 schema 拒绝，处理器未受理），已终止该提交链`;
}

/** 从 pi 工具结果里抽出文本（content[].text 拼接；形状未知时退回 JSON 串）。 */
function extractToolResultText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }>; text?: string } | null | undefined;
  if (!r) return "";
  if (typeof r.text === "string") return r.text;
  if (Array.isArray(r.content)) return r.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}

export const SAFE_SESSION_TOOLS = new Set<string>([
  "read",
  // ★2026-07-25（MoA 自审发现）：移除已下线的 "grep" / "find"。它们早已从 PROFILE_TOOLS 与
  //   bash_readonly 的 ALLOWED_COMMANDS 中删除（检索改走 rg / ast-grep / rtk，见架构 §4.8），
  //   但此处 allowlist 一直残留 ⇒ 若日后有人误把 find/grep 加回某 profile，本闸不会拦截。
  //   属纵深防御缺口（当时上层 PROFILE_TOOLS 仍守得住，故非漏洞），此处补齐一致性。
  "ls",
  // M2+：沙箱化取证工具（bash_readonly.ts → sandbox.ts）。经 customTools 直接注入、结果不设 addedToolNames、
  // execute 仅在 macOS sandbox-exec 沙箱内跑只读命令（无网络/无 agent CLI 可达/写限 scratch）——
  // 不开任何 spawn/写外/MCP 面，不破坏「子 agent 不生成孙 agent」不变量。
  "bash_readonly",
  "semble_search",
  // ★2026-08-13 `devkb_search`：受限 devkb 检索（固定 bin/devkb + 语料根钉死 Paper System + 预算/输出/超时封顶），Paper System 检索分流铁律的工具面。
  "devkb_search",
  // ★2026-08-06 `web_fetch`：宿主进程内跑 `lightpanda fetch` 的一次性取页工具。
  //   为什么它不破坏「子 agent 不生成孙 agent」：进程一次性、无守护、无会话状态、
  //   结果不设 addedToolNames、不开任何 spawn/写盘/MCP 面。它只把一个 URL 的正文变成文本。
  //   （它确实开了出网面——那是本工具的既定代价，见 web_fetch.ts 头部标注，与本不变量无关。）
  "web_fetch",
  // ★2026-09-20 Jev 辅助代码审查（设计 v4 §3.3）三个结构化提交工具：`submit_findings`（proposer）、
  //   `amend_facts`（补前提短会话）、`submit_verdicts`（aggregator，第三波落码）。
  //   为什么它们不破坏「子 agent 不生成孙 agent」不变量：三者只写**会话内存状态**（闭包持有的
  //   FindingsState / VerdictsState），不读盘、不出网、不 spawn、不设 addedToolNames、不开任何 MCP 面；
  //   能看到的材料是 recon 已附进 context 的同一份副本（req.materials），没有新的读面。
  //   它们不是 profile 缺省工具（PROFILE_TOOLS 不改），按角色由编排层经 opts.tools + opts.extraTools 注入。
  "submit_findings",
  "amend_facts",
  "submit_verdicts",
]);

export function assertNoGrandchildCapability(tools: string[]): void {
  const bad = tools.filter((t) => !SAFE_SESSION_TOOLS.has(t));
  if (bad.length > 0) {
    throw new Error(
      `[security] PiMoa 子 agent 工具越界（可能生成孙 agent）：[${bad.join(", ")}] 不在安全 allowlist。` +
        ` 子会话仅允许 {${[...SAFE_SESSION_TOOLS].join(", ")}}（M2 增 bash_readonly，受限 semble_search）。` +
        ` 绝不给 subagent/delegate/bash/execute_code/原始 MCP —— 防递归扇出与提权。`,
    );
  }
}

export interface RunSessionOptions {
  /** per-call 硬超时（ms）；到点 session.abort() 并置 timedOut。 */
  timeoutMs: number;
  /**
   * ★请求级 idle 看门狗阈值（ms，2026-09-22 生产缺陷修复）。
   *
   * 起因（真实生产数据，2026-09-22 当天 53 轮 7 轮 proposer 超时，全部是 `xiaomi/mimo-v2.5-pro`，
   * 且全部**精确卡在 540.0s** = `timeouts.referencePerCallMs`）：`timeoutMs` 是**整会话**预算，
   * 一个 proposer 会话含最多 6 次工具调用往返，**任何一次流式请求卡住**（HTTP 已发出、长时间不出
   * 任何 token）就把整个 540s 预算吃掉并终结会话；而失败轮的 output 只有 471/652 token —— 形态是
   * 「发出去后没人回」，不是「生成太长」。同端点健康基线实测 TTFT 8.8s、生成期 42.3 tok/s、
   * 5 路并发 ~44s 全成、8 轮抗压 0 断流 ⇒ 是**间歇性单请求卡顿**，不是端点整体挂。
   *
   * 语义：距**上一次收到内层流事件**（以及请求开始）超过本值仍无事件，就以**可重试**错误收尾
   * （errorMessage 稳定命中 pi `isRetryableAssistantError` 的可重试分支），由 pi 在**同一会话预算内**
   * 自动重试该请求；一次卡顿的代价从 540s 降到 ~requestIdleMs + 退避重试。
   *
   * **缺省 = 不启用看门狗，与改造前逐字节等价**（其它调用方/测试不被静默改变；本文件不 import
   * config 单例，值由编排层从 `config.timeouts.requestIdleMs` 显式传入，`orchestrate.ts` 必传）。
   * 非正数 / 非有限数同样视同未启用。加载期不变量（正整数、< referencePerCallMs）见
   * `src/config/load.ts` 的 ⑤-d。
   */
  idleMs?: number;
  /** 覆盖 profile 默认工具集（缺省按 worker.profile 取 PROFILE_TOOLS）。 */
  tools?: string[];
  /** 外部取消信号（编排层 deps.signal）。abort → aborted=true。 */
  signal?: AbortSignal;
  /** 工作目录（会话发现根）。缺省 process.cwd()。 */
  cwd?: string;
  /**
   * ★额外只读根（2026-08-04 跨仓核查）：来自 moa.yaml 的 `access.readRoots`，由编排层注入。
   * 只放大**读**面（read / bash_readonly 的 jail 与沙箱读白名单 / semble 搜索根），
   * **不碰 moa_deliver 的写根**（写根仍只有调用方传的 cwd，见 mcp/server.ts）。
   * 不传即退化成改造前的单根行为。
   */
  readRoots?: readonly string[];
  /** 隔离 agentDir（空目录，避免加载用户全局扩展/技能）。 */
  agentDir?: string;
  /** 复用的 resourceLoader（编排层建一次分发，省去每会话重复 reload）。 */
  resourceLoader?: DefaultResourceLoader;
  /** 本会话取证轮数上限覆盖(v4 §10-D:来自 max_tool_calls 入参,编排层已按硬顶钳制)。 */
  maxToolCalls?: number;
  /** 本会话取证字符预算覆盖(v4 §4.2:编排层按模式注入 retrievalCharBudget(mode))。 */
  retrievalCharBudget?: number;
  /**
   * ★额外工具定义（Jev 辅助代码审查设计 v4 §3.3）：按角色注入的结构化提交工具
   * （submit_findings / amend_facts / submit_verdicts），并入 customTools。**只定义不等于启用**——
   * 启用仍由 `tools` 名单决定（编排层负责把工具名加进去），且名单必须 ⊆ SAFE_SESSION_TOOLS。
   */
  extraTools?: ToolDefinition[];
  /**
   * 结构化提交的会话状态（与 extraTools 里的工具共享同一对象）。存在时 runSession 返回前把它折成
   * `structured`（accepted / count / attempts / lastReject），供编排层判定与回执。
   * ★AmendState（补前提短会话，设计 v4 §3.2/§3.3）与 FindingsState 形状相容（accepted 都是数组或
   * null）：summarizeStructured 对它同样按 accepted 数组长度计 count。
   */
  structuredState?: FindingsState | VerdictsState | AmendState;
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
  /** 最后一条 assistant 的 stopReason（stop / length / toolUse / error…）；灰度期用来看正文是否撞输出上限被截断。 */
  stopReason?: string;
  /**
   * 取证账(提速方案 §4.1):预算账本快照 + pi 自动重试计数。真 runSession **恒填**(含模型未找到 /
   * 抛异常路径);可选仅为兼容测试注入的 mock 结果——编排层 toProposalResult 对缺失值记零账 + retries=null。
   */
  trace?: SessionTrace;
  /**
   * 结构化提交摘要（设计 v4 §3.3）：仅当 opts.structuredState 存在时填；折自该状态对象，
   * 不看正文。accepted=false 且 attempts=0 表示模型压根没调工具。
   */
  structured?: StructuredSummary;
  /**
   * ★2026-09-27 徐总裁定（批次 1 fix 批 F3）：结构化提交**已被接受之后**又连续 schema 拒到顶（DEF-10 abort）时为 true。
   * 此时交付物已成形，会话只是被提前收尾：编排层据此不归因「未完成（无 agent_end）」、不计入 failedSoFar、不掐兄弟。
   * 未到顶或到顶时未接受 ⇒ 字段缺省（到顶未接受仍走 error=到顶文案的失败路径）。
   */
  schemaRejectCapAfterAccept?: boolean;
}

/**
 * 把结构化提交状态折成摘要（FindingsState / AmendState 的 accepted 是数组，按长度计 count；
 * VerdictsState 的 accepted 是含 verdicts 数组的对象，按 verdicts.length 计 count）。
 */
function summarizeStructured(state: FindingsState | VerdictsState | AmendState): StructuredSummary {
  const acc = state.accepted;
  const count = acc === null ? 0 : Array.isArray(acc) ? acc.length : acc.verdicts.length;
  const lastReject = state.rejects[state.rejects.length - 1];
  return {
    accepted: acc !== null,
    count,
    attempts: state.attempts,
    ...(lastReject !== undefined ? { lastReject } : {}),
  };
}

/**
 * 从账本 + 重试计数组装取证账。budget 为 undefined(会话尚未建账本:模型未找到)时记零账——
 * 这是事实(什么都没取证),不是占位;retries=null 表示"没有会话可数"而非 0 次。
 */
/**
 * 从 `tool_execution_end` 事件抽一条取证读取记录（纯函数，供单测）：read 成功 → {abs, a, b}（details.lines 形如
 * "4-10/120"）；bash_readonly 成功 → {cmd}；其它工具 / 出错 / 被拒 → null。事件形状按 pi 的
 * `{toolName, isError, result:{content, details}}`，字段缺失一律按 null 处理，绝不抛。
 */
export function readRecordFromToolEnd(ev: unknown, cwd: string): ReadRecord | null {
  const e = ev as { toolName?: string; isError?: boolean; result?: { details?: Record<string, unknown> } } | null;
  if (!e || e.isError || !e.toolName) return null;
  if (e.toolName !== "read" && e.toolName !== "bash_readonly") return null;
  const d = e.result?.details;
  if (d && d.rejected === true) return null;
  if (e.toolName === "read" && d && typeof d.path === "string") {
    const m = typeof d.lines === "string" ? /^(\d+)-(\d+)\//.exec(d.lines) : null;
    return { abs: resolve(cwd, d.path), ...(m ? { a: Number(m[1]), b: Number(m[2]) } : {}) };
  }
  if (e.toolName === "bash_readonly" && d && typeof d.command === "string") return { cmd: d.command };
  // 取证工具成功结束但 details 形状对不上：记 unknown，让下游退回会话级口径而非整批误降级。
  return { unknown: true };
}

function makeTrace(budget: RetrievalBudget | undefined, retries: number | null, reads: ReadRecord[] = []): SessionTrace {
  if (!budget) {
    return { calls: 0, usedChars: 0, reservedChars: 0, maxCalls: 0, maxChars: 0, exhaustedBy: null, rejections: 0, lastRejectedBy: null, retries, reads };
  }
  const snap = budgetSnapshot(budget);
  return {
    calls: snap.calls,
    reads,
    usedChars: snap.usedChars,
    reservedChars: snap.reservedChars,
    maxCalls: snap.maxCalls,
    maxChars: snap.maxChars,
    exhaustedBy: snap.exhaustedBy ?? null,
    rejections: snap.rejections,
    lastRejectedBy: snap.lastRejectedBy ?? null,
    retries,
  };
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
  // ★缓存可观测性：pi 的 Usage 带 cacheRead/cacheWrite，但 getSessionStats() 只回 input/output/total，
  //   缓存数据会被丢掉 ⇒ 无从判断多轮重发是否吃到 prompt 缓存红利。故按**全部 assistant 消息求和**
  //   补上（跨轮累计才有意义：首轮建缓存、后续轮命中）。命中率低即前缀被破坏，是可优化信号。
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const m of session.messages) {
    if (m.role !== "assistant") continue;
    const u = (m as AssistantLike).usage as { cacheRead?: number; cacheWrite?: number } | undefined;
    if (typeof u?.cacheRead === "number") cacheRead += u.cacheRead;
    if (typeof u?.cacheWrite === "number") cacheWrite += u.cacheWrite;
  }
  const cacheFields = {
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
  if (stats) {
    return {
      usage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        ...(typeof reasoning === "number" ? { reasoning } : {}),
        ...cacheFields,
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
        ...cacheFields,
        totalTokens: u.total ?? input + output,
      },
      costUsd: 0,
    };
  }
  return { usage: null, costUsd: 0 };
}

/**
 * pi 的 `AssistantMessageEventStream` 结构面。
 *
 * 为什么按结构类型写而不是 import 真类型：`AssistantMessageEventStream` 只在
 * `@earendil-works/pi-ai` 的 `utils/event-stream` 里导出，而该包在本仓是 pi-coding-agent 的
 * **嵌套依赖**（`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`），
 * 裸说明符解析不到、`exports` 映射也不转发 `./utils/*`（实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。
 * 真流可直接赋值给本类型（方法语法参数双变 + 返回值协变），运行期再用内层实例的原型取真构造器
 * （见 `newEventStreamLike`），不复制 pi 的队列语义。
 */
export interface IdleGuardStream {
  push(event: StreamEventLike): void;
  end(result?: unknown): void;
  result(): Promise<unknown>;
  [Symbol.asyncIterator](): AsyncIterator<StreamEventLike>;
}

/** 流事件最小面（只用到判别字段与 partial/terminal 载荷，其余原样透传）。 */
export interface StreamEventLike {
  type: string;
  partial?: unknown;
  message?: unknown;
  error?: unknown;
}

/**
 * 终态 `AssistantMessage` 的最小面（errorMessage/stopReason/usage 是 pi 重试分类与我们抽用量时读的字段）。
 * 供测试与验真探针断言用；pi 的真类型不导出（见 `IdleGuardStream` 的注释）。
 */
export interface IdleGuardMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  api?: string;
  provider?: string;
  model?: string;
  usage?: { input?: number; output?: number; totalTokens?: number };
}

/** `withIdleGuard` 的可选元信息。 */
export interface IdleGuardMeta {
  /** 诊断标签（如 `xiaomi/mimo-v2.5-pro`）。**只进 stderr**，绝不进 errorMessage —— 标签里若混进
   *  `quota exceeded`/`billing` 之类字样会污染 pi 的重试分类。 */
  label?: string;
  /** pi 交给 streamFunction 的 `options.signal`（= agent 的 abort 信号）。abort 时立刻清 idle timer。 */
  signal?: AbortSignal;
  /** 首个流事件之前的卡死没有 `partial` 可用 → 用它合成兜底消息的身份字段（api/provider/model）。 */
  identity?: { api?: string; provider?: string; model?: string };
}

/** 零用量占位（与 pi provider 在首个事件之前构造的 output 同形）。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * idle 收尾用的 errorMessage（**稳定契约**，测试与探针照此断言）。
 *
 * 文案必须稳定命中 pi `isRetryableAssistantError` 的**可重试**分支、且绝不撞**不可重试**分支
 * （两组正则见 `pi-ai/dist/utils/retry.js`。沿革：0.84.1 时期由 2026-09-27 本地补丁批 P4 整抄 0.87.1 版该文件、
 *   可重试表追加 3 项（buffer 限流/520/高需求）；pi 0.99.2 起 P4 退役，用 pi-ai 原生 retry.js——它是 P4 补丁件的超集，
 *   只多 3 个 ChatGPT 订阅错误码（不可重试表 +`subscription_sharing_usage_limit_exceeded`，可重试表
 *   +`subscription_sharing_usage_unavailable` / `subscription_sharing_user_unavailable`），`timeout` 项未动、
 *   新增项本文案均不含 ⇒ 本契约不受影响；test/session_idle.test.ts 的正则抄本已标「0.84.1 冻结快照」）：
 * - 命中可重试：含子串 `timeout`（该表里有独立的 `timeout` 项；`timed? out` 那项要求空格、此处不依赖它）。
 * - 不撞不可重试：`GoUsageLimitError` / `FreeUsageLimitError` / `Monthly usage limit reached` /
 *   `available balance` / `insufficient_quota` / `out of budget` / `quota exceeded` / `billing`
 *   （0.99.2 另有 `subscription_sharing_usage_limit_exceeded`）全不出现。
 * - 也不撞 `isContextOverflow` 的 OVERFLOW_PATTERNS（无 `too many tokens` / `token limit exceeded` 等）。
 * ⇒ 该请求会被 pi 在同一会话预算内自动重试，而不会被当成配额/溢出错误直接判死。
 */
export function idleTimeoutErrorMessage(idleMs: number): string {
  return `stream idle timeout: no stream event for ${idleMs}ms`;
}

/** thenable 判定（Promise / PromiseLike 都算；鸭子类型，不依赖 instanceof，跨 realm 也成立）。 */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** 流形状校验：必须有 `result()` 与 `Symbol.asyncIterator`（按行为判，不按构造器名字，避免误判 Promise 等异物）。 */
function isStreamLike(v: unknown): v is IdleGuardStream {
  if (v === null || typeof v !== "object") return false;
  const o = v as { result?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof o.result === "function" && typeof o[Symbol.asyncIterator] === "function";
}

/**
 * 取内层流的真实构造器造一只同型新流（不复制 pi 的 EventStream 队列语义，避免两套实现漂移）。
 *
 * ★2026-09-22 阻断级修复（主代理 OLD/NEW 探针实测复现）：**先验流形状，再信构造器**。
 *   pi 真实的 `agent.streamFunction` 由 `createAgentSession` 装成
 *   `streamFn: async (model, context, options) => modelRuntime.streamSimple(...)`
 *   （`pi-coding-agent/dist/core/sdk.js`；`StreamFn` 类型本身允许
 *   `AssistantMessageEventStream | Promise<AssistantMessageEventStream>`，见
 *   `pi-agent-core/dist/types.d.ts:13`）⇒ 真实路径**永远返回 `Promise<流>`**。
 *   此前直接 `Object.getPrototypeOf(like).constructor` 会拿到 `Promise`，`new Promise()` 当场抛
 *   `Promise resolver undefined is not a function`，而异常发生在**第一次请求**、被 runSession 折成
 *   error ⇒ 重启后每一轮 verify 的每个 proposer 会话全灭。故这里：Promise 直接给"先 await"的明确
 *   文案；非流形状一律 fail-closed。
 */
function newEventStreamLike(like: IdleGuardStream): IdleGuardStream {
  // ★先挡 null/undefined/非对象：否则下面 `Object.getPrototypeOf(like)` 会先抛原生
  //   `TypeError: Cannot convert undefined or null to object`，把具名诊断顶掉、只剩一句无从追的
  //   原生报错（fail-closed 语义虽在，可诊断性丢了）。必须在取原型**之前**判。
  if (like === null || like === undefined || typeof like !== "object") {
    throw new Error(
      `[pi-moa] withIdleGuard: 内层不是 pi 的 AssistantMessageEventStream（实际 ${like === null ? "null" : typeof like}），拒绝在未知流类型上装看门狗`,
    );
  }
  if (isThenable(like)) {
    throw new Error(
      "[pi-moa] withIdleGuard: 内层是 Promise/Thenable 而不是流（pi 的真实 streamFn 是 async 函数，返回 Promise<AssistantMessageEventStream>）" +
        "；必须先 await 出真流再装看门狗 —— 见 wrapStreamFunction 的双形状处理",
    );
  }
  if (!isStreamLike(like)) {
    const ctor = (Object.getPrototypeOf(like as object) as { constructor?: { name?: string } } | null)?.constructor
      ?.name;
    throw new Error(
      `[pi-moa] withIdleGuard: 内层不是 pi 的 AssistantMessageEventStream（缺 result()/Symbol.asyncIterator，实际构造器 ${ctor ?? typeof like}），拒绝在未知流类型上装看门狗`,
    );
  }
  const proto = Object.getPrototypeOf(like) as { constructor?: new () => IdleGuardStream } | null;
  const Ctor = proto?.constructor;
  if (typeof Ctor !== "function") {
    // fail-closed：宁可在装看门狗时炸，也不静默退化成"看起来装了、实际没装"。
    throw new Error("[pi-moa] withIdleGuard: 取不到内层流的构造器，拒绝在未知流类型上装看门狗");
  }
  const created = new Ctor();
  if (!isStreamLike(created)) {
    throw new Error("[pi-moa] withIdleGuard: 由内层构造器造出的对象不是流（EventStream 语义已漂移），拒绝装看门狗");
  }
  return created;
}

/**
 * ★请求级 idle 看门狗（2026-09-22，生产缺陷修复；设计口径见 `RunSessionOptions.idleMs`）。
 *
 * 用 `inner` 拿到内层 `AssistantMessageEventStream`，返回一只**同型新流**：事件逐个原样转发
 * （正常路径逐字节等价——不改事件序列、不改 stopReason、不改 usage），同时做 idle 看门狗。
 *
 * 语义与边界：
 * - 距上一次内层事件（以及请求开始）超过 `idleMs` 无任何事件 → 立刻以**可重试**错误收尾
 *   （见 `idleTimeoutErrorMessage`），把失败**编码进流**（pi 契约明文要求：Failures must be
 *   encoded in the returned stream via protocol events and a final AssistantMessage with
 *   stopReason "error"/"aborted"），**绝不 throw**。
 * - **绝不用 `session.abort()` 快速失败**：abort 是终止态（stopReason="aborted"），pi 的
 *   retry.js 明文「Never retry an aborted message」——那只会把 540s 的浪费换成 180s 的浪费。
 * - idle 触发后**不再向内层已结束的流 push**（`settled` 闸 + 转发前检查），也不再处理后续内层事件；
 *   外层消费由 pi 的 `for await` 在收到 error 事件后正常结束。
 *   诚实标注：底层 HTTP 请求本身**不会被本看门狗取消**（唯一能取消它的是会话级 abort 信号，
 *   而那是终止态、禁用）——它会挂到会话 `timeoutMs` 到点 `session.abort()` 时被一并掐掉，期间
 *   只占一个连接、不再被消费，且 push 进没人听的内层流不会产生未处理拒绝（EventStream.push 不抛）。
 * - 定时器在所有路径都清：内层正常 `end` / 内层报错 / 收到终态事件 / 外层 signal abort / idle 触发本身。
 *   不 `unref()`（与既有的会话级 per-call 定时器同口径）：unref 会让"只有这只定时器还活着"的离线探针
 *   场景下进程先以 unsettled top-level await 退出、看门狗来不及触发；泄漏口径由"每条终态路径都
 *   `clearTimeout`"保证 —— 句柄最长只活到最后一个内层事件后 `idleMs`，不会留到会话结束之后。
 * - 外层 signal abort ⇒ 清 timer 并**永久解除**看门狗：abort 的终态由内层给出（stopReason="aborted"，
 *   pi 明文不重试），绝不让本看门狗的 error 把它顶成一条"可重试"失败。**两条路径都解除**：
 *   `meta.signal.aborted` 在进入时已为真（预取消）与进入后才 abort（listener）——前者只"不装表"是不够的，
 *   因为循环体每收一个内层事件都会重新起表（主代理 P1/F1 实测复现）。
 * - 收尾幂等：`settled` 保证任何路径只 `end`（push 终态事件）一次。
 *
 * `idleMs` 非正数 / 非有限数 ⇒ **原样返回内层流**（不启用看门狗 = 改造前行为；加载期 ⑤-d 已挡越界值）。
 */
export function withIdleGuard(
  inner: IdleGuardStream,
  idleMs: number,
  meta?: IdleGuardMeta,
): IdleGuardStream {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return inner;

  const out = newEventStreamLike(inner);
  const message = idleTimeoutErrorMessage(idleMs);
  let settled = false; // 收尾幂等闸：任何路径只收尾一次
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPartial: Record<string, unknown> | undefined; // 最近一次事件的 partial（保留 usage/content）
  let onOuterAbort: (() => void) | undefined;
  // 外层取消后**永久解除**看门狗：abort 的终态必须由内层给出（stopReason="aborted"，pi 明确不重试），
  // 绝不能被本看门狗的 error 顶掉而变成一条"可重试"失败（那会在调用方已取消的会话上触发重试）。
  let disarmed = false;

  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const detachAbort = (): void => {
    if (onOuterAbort && meta?.signal) {
      meta.signal.removeEventListener("abort", onOuterAbort);
      onOuterAbort = undefined;
    }
  };

  const cleanup = (): void => {
    clearIdle();
    detachAbort();
  };

  /** 以 error 终态收尾（把失败编码进流，不 throw）。 */
  const settleWithError = (errorMessage: string): void => {
    if (settled) return;
    settled = true;
    cleanup();
    // 有 partial 就沿用它（保住内容/用量，只改终态字段，与 pi provider 自己的 catch 分支同形）；
    // 一个事件都没收到（首个事件前就卡死）才用 identity 合成一只，避免下游读到 undefined.usage。
    const base: Record<string, unknown> = lastPartial
      ? { ...lastPartial }
      : {
          role: "assistant",
          content: [],
          api: meta?.identity?.api ?? "unknown",
          provider: meta?.identity?.provider ?? "unknown",
          model: meta?.identity?.model ?? "unknown",
          usage: ZERO_USAGE,
          timestamp: Date.now(),
        };
    base.stopReason = "error";
    base.errorMessage = errorMessage;
    const errEvent = { type: "error", reason: "error", error: base };
    out.push(errEvent);
  };

  const armIdle = (): void => {
    clearIdle();
    if (disarmed) return;
    // ★不 unref：unref 会让"只有这只定时器还活着"的场景（离线合成卡死流做探针、内层永不出事件且
    //   外层无消费方）下 Node 直接以 unsettled top-level await 退出，看门狗根本来不及触发。
    //   本仓既有的会话级 per-call 定时器同样不 unref（见下方 `timer = setTimeout(..., opts.timeoutMs)`），
    //   泄漏口径由"每条终态路径都 clearTimeout"保证：定时器最多活到最后一个内层事件后 idleMs，
    //   不存在跑完还挂着的句柄。
    idleTimer = setTimeout(onIdle, idleMs);
  };

  function onIdle(): void {
    if (settled) return;
    if (meta?.label) {
      // 只能打 stderr（stdout 是 MCP 协议的 JSONL 通道，见 mcp/server.ts 顶部 stdio 卫生条款）。
      console.error(
        `[pi-moa] 请求级 idle 超时：${meta.label} 连续 ${idleMs}ms 无任何流事件 → 以可重试错误收尾（交 pi 在同一会话预算内自动重试该请求）`,
      );
    }
    settleWithError(message);
  }

  if (meta?.signal) {
    if (meta.signal.aborted) {
      // ★外层**进入时已取消**：必须置 disarmed（而不是只"这次不装表"）。否则循环体每收一个内层事件
      //   都会 armIdle() 把看门狗复活，在**已取消的会话**上推出一条含 timeout 的**可重试** error，
      //   顶掉内层本该给的 stopReason="aborted"（违反本函数自己的取消语义：abort 的终态必须由内层给）。
      //   这与下面 listener 分支的 `disarmed = true` 是同一语义，只是取消发生在进入之前。
      disarmed = true;
    } else {
      onOuterAbort = () => {
        disarmed = true;
        cleanup();
      };
      meta.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
  }

  // 请求开始即起表；此后每收到一个内层事件就重置。disarmed 时 armIdle 是 no-op（永久解除）。
  armIdle();

  void (async () => {
    try {
      for await (const event of inner) {
        if (settled) break; // idle 已收尾：不再消费内层、更不向内层已结束的流 push
        const ev = event as { type?: string; partial?: unknown } | null;
        if (ev?.partial !== undefined && typeof ev.partial === "object" && ev.partial !== null) {
          lastPartial = ev.partial as Record<string, unknown>;
        }
        armIdle();
        out.push(event);
        if (ev?.type === "done" || ev?.type === "error") {
          settled = true;
          cleanup();
          break;
        }
      }
      if (!settled) {
        // 防御路径：pi 契约要求流必以 done/error 终态（此处正常不可达）。
        settleWithError("stream guard: inner stream ended without done/error event");
      }
    } catch (err) {
      // pi 的 EventStream 迭代不会抛；防御性兜住，绝不让 Promise 未处理拒绝逃逸出 runSession。
      settleWithError(`stream guard: inner stream threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  return out;
}

/** 从 pi 的 model 对象取合成兜底消息用的身份字段（字段缺失一律留空）。 */
function modelIdentityOf(m: unknown): IdleGuardMeta["identity"] {
  const mm = m as { api?: unknown; provider?: unknown; id?: unknown } | null;
  return {
    ...(typeof mm?.api === "string" ? { api: mm.api } : {}),
    ...(typeof mm?.provider === "string" ? { provider: mm.provider } : {}),
    ...(typeof mm?.id === "string" ? { model: mm.id } : {}),
  };
}

/** streamFunction 的最小面（pi 的 `StreamFn` 允许"流"或"Promise<流>"两种返回）。 */
export type StreamFunctionLike = (m: unknown, c: unknown, o?: Record<string, unknown>) => unknown;

/** `wrapStreamFunction` 的选项。 */
export interface StreamWrapperOptions {
  /** models.json 的 maxTokens（调用方显式给的优先）。不传 = 不做 maxTokens 注入。 */
  maxTokens?: number;
  /** 请求级 idle 看门狗阈值；缺省/非正/非有限 = 不装看门狗（旧行为）。 */
  idleMs?: number;
  /** stderr 诊断标签（如 `xiaomi/mimo-v2.5-pro`）。 */
  label?: string;
  /** 按每次调用传入的 model 取身份字段（合成"零事件"兜底消息用）。 */
  identityOf?: (m: unknown) => IdleGuardMeta["identity"] | undefined;
}

/**
 * 把「maxTokens 注入 + 请求级 idle 看门狗」叠到一个既有 streamFunction 上。
 *
 * **★两形状兼容（2026-09-22 阻断级修复）**：pi 真实的 `agent.streamFunction` 来自
 * `createAgentSession` 的 `streamFn: async (model, context, options) => modelRuntime.streamSimple(...)`
 * （`pi-coding-agent/dist/core/sdk.js`），**永远是 `Promise<AssistantMessageEventStream>`**；
 * 而低层调用/测试 stub 可能直接返回流。故这里按内层实际返回值分流，并**保持返回形状不变**
 * （流进流出、Promise 进 Promise 出）——两种形状都是 `StreamFn` 允许的，pi 侧对返回值一律 `await`。
 * 之前"直接把内层返回值当流装看门狗"会让 `newEventStreamLike` 取到 `Promise` 构造器并在第一次
 * 请求就抛 `Promise resolver undefined is not a function`（每轮 verify 全灭）。
 *
 * maxTokens 注入与改造前逐字一致（调用方显式给的 maxTokens 优先）。
 */
export function wrapStreamFunction(inner: StreamFunctionLike, opts: StreamWrapperOptions): StreamFunctionLike {
  const cap = opts.maxTokens;
  const idleMs = opts.idleMs;
  return (m, c, o) => {
    const withCap =
      cap !== undefined
        ? inner(m, c, { ...(o ?? {}), maxTokens: (o?.maxTokens as number | undefined) ?? cap })
        : inner(m, c, o);
    if (idleMs === undefined || !Number.isFinite(idleMs) || idleMs <= 0) return withCap;
    // 用鸭子类型判 signal（不写 `instanceof AbortSignal`：跨 realm / polyfill 的 signal 会漏判，
    // 而漏判的后果是"外层取消后看门狗没被解除"）。
    const sig = (o as { signal?: unknown } | undefined)?.signal as AbortSignal | undefined;
    const identity = opts.identityOf?.(m);
    const meta: IdleGuardMeta = {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(sig && typeof sig.addEventListener === "function" ? { signal: sig } : {}),
      ...(identity !== undefined ? { identity } : {}),
    };
    const guard = (s: unknown): IdleGuardStream => withIdleGuard(s as IdleGuardStream, idleMs, meta);
    // 内层是 Promise/Thenable ⇒ 先解出真流再装看门狗；否则直接装。返回形状与内层保持一致。
    return isThenable(withCap) ? Promise.resolve(withCap).then(guard) : guard(withCap);
  };
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

  /**
   * ★PIMOA-DEF-04（2026-09-20）：这两个绑定被下方 `structuredFields` 闭包捕获，必须在**闭包定义之前**
   * 声明。此前它们声明在 `let text = ""` 那一组（原 :424/:425，晚于闭包定义、也晚于闭包的首次调用点），
   * 而 `structuredFields()` 在「模型未找到」早退路径（下方 `if (!model) return {...structuredFields()}`）
   * 就被调用 ⇒ opts.structuredState 存在（verify + jevcheck.enabled=true）且 modelRuntime.getModel
   * 返回 undefined 时命中 TDZ：`Cannot access 'schemaRejects' before initialization`，冒泡到
   * orchestrate.ts 的兜底 catch 折成「runMoa 内部未预期异常」，把唯一可操作的「模型未找到：
   * <provider>/<model>（检查 models.json）」整句吃掉（2026-09-20 真实崩溃轮 moa#bb99489a）。
   * 上移后初始化时机只是提前，语义不变：仅本函数体使用，正常返回（原 :614）与 catch 返回（原 :632）
   * 两条路径本就在其后调用。
   * 回归用例：test/trace.test.ts「DEF-04」——先反证过（把这两行放回原位即复现
   * `Cannot access 'schemaRejects' before initialization`，同文件既有的无 structuredState 用例仍绿）。
   */
  let schemaRejects = 0;
  const schemaRejectSamples: string[] = [];
  // DEF-10：「连续」schema 拒计次（处理器受理一次即清零）与到顶标记；与 schemaRejects 总数分账。
  let schemaRejectStreak = 0;
  let schemaRejectCapHit = false;

  /** 设计 v4 §3.3：opts.structuredState 存在时，每条返回路径都带 structured。 */
  const structuredFields = (): { structured?: StructuredSummary } =>
    opts.structuredState
      ? {
          structured: {
            ...summarizeStructured(opts.structuredState),
            ...(schemaRejects > 0 ? { schemaRejects, schemaRejectSamples: schemaRejectSamples.slice(0, 3) } : {}),
          },
        }
      : {};

  // 1) 解析模型：未找到 → 立即返回 error（负例 fail-closed 走这条）。
  const model = modelRuntime.getModel(worker.provider, worker.model);
  if (!model) {
    return {
      ...base,
      durationMs: Date.now() - start,
      error: `模型未找到：${worker.provider}/${worker.model}（检查 models.json）`,
      trace: makeTrace(undefined, null),
      ...structuredFields(),
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const readRoots = opts.readRoots ?? [];
  const tools = opts.tools ?? PROFILE_TOOLS[worker.profile] ?? [];
  assertNoGrandchildCapability(tools); // ★安全不变量：子 agent 不能生成孙 agent（越界即抛）

  // 2) 资源隔离：复用传入 loader，否则建一个隔离 loader。
  const loader =
    opts.resourceLoader ?? (await createIsolatedLoader(cwd, opts.agentDir));

  // 本会话的取证预算账本（五个取证工具共用，见 tools/budget.ts;上限可由编排层按模式/入参覆盖）。
  const sessionBudget = createRetrievalBudget({
    ...(opts.maxToolCalls !== undefined ? { maxCalls: opts.maxToolCalls } : {}),
    ...(opts.retrievalCharBudget !== undefined ? { maxChars: opts.retrievalCharBudget } : {}),
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let sessionId: string | undefined;
  let text = "";
  let sawAgentEnd = false;
  let timedOut = false;
  let aborted = false;
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  // §4.1 重试计数:pi 在上游瞬时错误(断流/Overloaded 等)自动重试时发 auto_retry_start(每次尝试一枚)。
  //   会话建起来之前(createAgentSession 抛)无从计数 → 保持 null,与"0 次重试"严格区分。
  let retries: number | null = null;
  const reads: ReadRecord[] = [];

  try {
    const created = await createAgentSession({
      cwd,
      model,
      // ★推理保持关闭（2026-07-25 实测定标，3 任务 × 4 配置 = 12 次调用）。**别想当然去打开它。**
      //   数据：开/关的**质量要素命中数完全相同**（3/4 vs 3/4、4/4 vs 4/4）；唯一差异是任务①的
      //   gemini 开 high 后反而从 3/4 掉到 2/4（丢了"无条件 abort 是根因"这条最关键的观察）。
      //   而延迟代价极不稳定：DeepSeek 开推理在架构权衡任务上 30.9s → **109.0s（3.5 倍）**，
      //   烧 5,549 推理 token 换来同样的 4/4。proposer 并行取 max ⇒ 一个慢的就拖垮整轮。
      //   **原理**：推理的价值在于"填补信息空白"，而侦查前置（§4.9 files/recon_query，带行号）
      //   已把材料喂满——答案在材料里，需要的是"看仔细"而非"想很久"，思考链无用武之地，
      //   反而会①与正文竞争输出预算（实测 DeepSeek flash 推理吃光 → 空正文）②长链发散丢掉直接观察。
      //   ★2026-08-17 复核重写（原注释按 07-25 的模型阵容写的，换代后已失效，勿再照旧理解）。
      //   每一跳的**实际下发**取决于 models.json 的 `reasoning` 标注 × 端点被 pi 探测出的
      //   `compat.thinkingFormat`（源码依据：pi-ai `api/openai-completions.js` detectCompat :1199/:1210、
      //   分支链 :565-665；anthropic 侧 `api/anthropic-messages.js` :761/:786）。三跳现状：
      //   · proposer1 deepseek-v4-flash（标 `true`）：baseUrl 命中 `deepseek.com` ⇒ thinkingFormat
      //     ="deepseek"，`reasoningEffort` 为空且未设 thinkingLevelMap ⇒ **真的发
      //     `thinking:{type:"disabled"}`**。A/B 实测（同任务 max_tokens=2000，各 3 次）：发 disabled
      //     = 3.3/3.1/3.8s、3/3 finish=stop、正文 751-806 字符；不发（=标 false 跑自身默认档）
      //     = 18.9/11.9/21.3s、reasoning_tokens 1805/1089/2000、2/3 撞 length 截断，**其中一次推理
      //     吃光预算致正文长度 0**（fail-closed ⇒ 整轮失败）。⇒ 这里的 `true` 有效且必要，别改 false。
      //   · proposer2 MiniMax-M3（标 `false`）：什么都不发，跑自身默认档。A/B 实测两组
      //     **thinking_len 全为 0** ⇒ 它默认就不产思维块，标 true 发 disabled 零收益，保持 false。
      //   · 聚合器 claude-opus-4-8（经 cliproxy）：不匹配任何命名分支 ⇒ thinkingFormat="openai"，
      //     兜底分支要求 `thinkingLevelMap.off` 为字符串才发 `reasoning_effort`，本配置未设该字段
      //     ⇒ **什么都不发**。故 2026-08-17 把它的 `reasoning` 由 `true` 改成 `false`——标 true 一个
      //     字段都不发却让人误以为在控推理（实测 CLIProxy 对 reasoning_effort:"none"/"low" 均 HTTP 200
      //     且都不返回 reasoning_tokens ⇒ 疑被静默忽略、无法验证生效，故不采用 thinkingLevelMap 方案）。
      //   ⚠️ 另一个坑：显式传 `reasoning_effort:"high"` 未必更"高"——各服务商映射不一，实测
      //   gemini 传 high 后 reasoning_token 反而变 0（被映射成关闭）。**不传比传安全。**
      //   ⚠️ 本结论只对 **code review 类任务**（答案在材料内）成立；论文审核那类需要重建论证链条、
      //   做反事实判断的任务，推理的边际收益可能相反——换场景需重新实测，勿直接套用。
      //   ★出站回归闸（2026-09-22，`test/payload_guard.test.ts`）：使 pi 真的发出 `thinking:{type:"disabled"}`
      //   的**必要条件是 `reasoning:true`（models.json）+ 这里的 `thinkingLevel:"off"`**（`thinkingFormat`
      //   已由 pi 内置目录 `pi-ai/dist/providers/data/xiaomi.json` 给出 "deepseek"，models.json 那条
      //   `compat.thinkingFormat` 是显式对齐、让意图可见，非唯一来源——见该测试文件里的实测澄清）。
      //   缺任何一环，请求体上就没有该字段，端点退回自身默认档——实测 reasoning 吃光共享输出窗口
      //   （3999/4000）⇒ 可见正文只剩 1 个 token、finish_reason=length，**空正文**；
      //   而 idle 看门狗兜不住（推理阶段端点在持续出字节，idle 计时器一直被重置）。本行是那条链路的
      //   最后一环，改动前后请跑该用例（它断言真实出站 payload 的 thinking 必须 = disabled）。
      thinkingLevel: "off",
      modelRuntime,
      tools,
      // 只读取证工具定义随会话注入；仅当 `tools` 含 "bash_readonly" 时才实际启用
      // （verify-worker 启用，proposer/synthesize 不列入即定义而不启用）。经 customTools 注入
      // 不走 ResourceLoader 扩展系统，故 isolated loader 的 noExtensions 屏障不受影响。
      // ★每会话一本共享取证预算账（20 万 token 顶）：bash_readonly 与 read 共用，防"多次读取累加撑爆
      //   上下文 → 正文空 → fail-closed"。read 为同名覆盖 pi 内置版（另加路径 jail），见 read_budgeted.ts。
      //   逐会话建实例 ⇒ 并行 proposer 互不扣额度。
      // ★readRoots 经工厂闭包注入三个工具（不走会话入参、不经模型）——配置真源 → 工具，
      //   中间没有任何模型可干预的环节，agent 无法自行扩权（对照 pi-add-dir 的 add_directory：
      //   那是让 agent 自己加目录，等于被审对象自发通行证，本项目明确不采用）。
      customTools: [
        createBashReadonlyTool(sessionBudget, readRoots),
        createReadTool(sessionBudget, readRoots),
        createSembleSearchTool(sessionBudget, readRoots),
        // ★devkb_search 只吃预算账本，不吃 readRoots——语料根钉死 Paper System（见 devkb_search.ts）。
        createDevkbSearchTool(sessionBudget),
        // ★web_fetch 只吃预算账本，不吃 readRoots——它压根不碰文件系统，只出网取页。
        createWebFetchTool(sessionBudget),
        // ★同名覆盖 pi 内置 ls（2026-08-04）：内置版 resolveToCwd 支持 ~ 展开与绝对路径且
        //   **无任何越界检查**——实测能列 ~/.ssh、/etc、整个家目录。read 早已覆盖加 jail，
        //   ls 一直被漏掉，形成"内容读得严、文件名随便枚举"的不对称缺口。见 tools/ls_jailed.ts。
        createLsTool(readRoots),
        // ★设计 v4 §3.3：按角色注入的结构化提交工具（只写会话内存状态；启用与否仍由 `tools` 名单决定）。
        ...(opts.extraTools ?? []),
      ],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        // ★compaction 打开（徐总 2026-07-25）：M0 冒烟期为"测试确定性"关掉后一路带到生产，
        //   等于拆掉了 Claude Code 子代理本来就有的安全网——上下文一涨没人兜底，直接撞上游断流吐空正文。
        //   分工：主防线 = 我们自己的会话取证预算（20 万 token，见 tools/budget.ts）+ 工具轮数上限；
        //         compaction = 最后兜底（contextTokens > contextWindow - reserveTokens 时自动压缩）。
        //   前置条件已修：models.json 的 contextWindow 早先误配成 200k（实际 1M），否则会提前压缩白丢上下文。
        compaction: { enabled: true },
        // retry 打开（徐总 2026-07-25）：上游 gemini/antigravity 在长/多轮生成上会间歇性
        //   "Stream ended without finish_reason"，这是瞬时可恢复错误；不重试则直接坐实成空正文 →
        //   2/2 fail-closed 核平整轮。重试吃 per-call timeout 预算，已配套上调超时 +50% 留出余量。
        retry: { enabled: true },
      }),
    });
    session = created.session;
    if (worker.provider === "anthropic") {
      const originalTransform = session.agent.transformContext;
      session.agent.transformContext = async (messages, signal) =>
        stripPiDocsSections(originalTransform ? await originalTransform(messages, signal) : messages);
    }
    sessionId = session.sessionId;
    retries = 0; // 会话已建,自此可数

    // ★把 models.json 的 maxTokens 真正送到接口（2026-09-20 灰度第 1–2 轮抓出的生产缺陷）：
    //   pi 的 agent-loop 只把 {model, reasoning, sessionId, apiKey, signal} 交给 streamFn，
    //   openai-completions 适配层 `if (options?.maxTokens)` 才发 max_tokens，因此 openai 类端点
    //   （DeepSeek 直连、CLIProxy）从未收到该字段，DeepSeek 按服务端缺省 8,192 截断（实测：不带参数
    //   finish=length@8192；带 20000 正常出 17,000 token）。anthropic 适配层用 `options?.maxTokens ??
    //   model.maxTokens`，MiniMax 那路本来就拿到 65535。这里包一层 streamFunction，缺省补 model.maxTokens，
    //   调用方显式给的 maxTokens 优先。
    //   ★出站回归闸（2026-09-22，`test/payload_guard.test.ts`）：该用例起本地捕获端点 + 克隆真 xiaomi
    //   provider 的临时 models.json + 真 `runSession`，对**真实出站请求体**断言三件事——①
    //   `thinking` 必须 = `{type:"disabled"}`；② `max_tokens` 必须存在且 = models.json 的 maxTokens
    //   （即本块注入生效，防"agent-loop 不传 maxTokens"那类缺陷回退）；③ 不得出现 `thinking_token_budget`
    //   （该端点接受但完全忽略，加了是假保护，别设 `compat.supportsThinkingTokenBudget`）。
    //   改本块或改上面 thinkingLevel 之后请跑该用例。
    {
      const cap = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
      // ★请求级 idle 看门狗（2026-09-22）：值由编排层显式传（本文件不 import config 单例）。
      //   缺省（undefined / 非正 / 非有限）= 不启用，与改造前逐字节等价。
      const idleMs = opts.idleMs;
      const agent = session.agent as unknown as { streamFunction: StreamFunctionLike };
      if ((cap !== undefined || idleMs !== undefined) && typeof agent.streamFunction === "function") {
        // ★maxTokens 注入 + idle 看门狗都装在 wrapStreamFunction 里；它对内层返回值做**双形状**
        //   处理（流 / Promise<流>）——pi 真实 streamFn 是 async，返回 Promise<流>，见该函数注释。
        agent.streamFunction = wrapStreamFunction(agent.streamFunction, {
          ...(cap !== undefined ? { maxTokens: cap } : {}),
          ...(idleMs !== undefined ? { idleMs } : {}),
          label: `${worker.provider}/${worker.model}`,
          identityOf: modelIdentityOf,
        });
      }
    }

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
      // ★结构化提交工具在 typebox schema 层被拒（不进处理器、不计 attempts）的次数：灰度第 3 轮 MiniMax 的
      //   anchor 超长被 schema 拒了多次却无处可见。处理器自己的 REJECT/PARTIAL 也是 isError，靠文案前缀区分。
      if (event.type === "tool_execution_end") {
        const ev = event as unknown as { toolName?: string; isError?: boolean; result?: unknown };
        const rr = readRecordFromToolEnd(ev, cwd);
        if (rr) reads.push(rr);
        const kind = classifyStructuredToolEnd(ev);
        if (kind === "schema_reject") {
          schemaRejects += 1;
          schemaRejectSamples.push(`${ev.toolName}: ${extractToolResultText(ev.result).slice(0, 200)}`);
          schemaRejectStreak += 1;
          // DEF-10：连续到顶 ⇒ 终止会话（只触发一次）；error 在 prompt 返回后按是否已接受决定。
          if (schemaRejectStreak >= SCHEMA_REJECT_MAX && !schemaRejectCapHit) {
            schemaRejectCapHit = true;
            void session?.abort();
          }
        } else if (kind === "handler" && isStructuredAccept(ev)) {
          // F4：只有被接受才清零；业务 REJECT/PARTIAL 与 tool_error 既不计次也不清零（堵交替环路）。
          schemaRejectStreak = 0;
        }
      }
      if (event.type === "auto_retry_start") {
        retries = (retries ?? 0) + 1;
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
    // DEF-10：连续 schema 拒到顶 ⇒ 明确失败（优先于 abort 带出的 stopReason 推导，文案可操作）；
    //   已有被接受的结构化提交则不置 error——保护已成形交付物（同 DEF-08 思路），只是提前收尾。
    const acceptedAtEnd = !!(opts.structuredState && summarizeStructured(opts.structuredState).accepted);
    if (schemaRejectCapHit && !acceptedAtEnd) {
      error = schemaRejectCapMessage(SCHEMA_REJECT_MAX);
    }
    // F3：已接受后再到顶 ⇒ 会话是被本层主动 abort 提前收尾，abort 带出的 stopReason/errorMessage
    //   不是模型失败，不得落成 error（否则编排层把已成形交付物判为失败）；并打标给编排层归因。
    const capAfterAccept = schemaRejectCapHit && acceptedAtEnd;
    if (capAfterAccept && !timedOut && !aborted) error = undefined;

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
      ...(lastAssistant?.stopReason ? { stopReason: String(lastAssistant.stopReason) } : {}),
      trace: makeTrace(sessionBudget, retries, reads),
      ...structuredFields(),
      ...(capAfterAccept ? { schemaRejectCapAfterAccept: true } : {}),
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (opts.signal && onExternalAbort) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
    const catchAccepted = !!(opts.structuredState && summarizeStructured(opts.structuredState).accepted);
    const catchCapAfterAccept = schemaRejectCapHit && catchAccepted;
    return {
      text,
      usage: null,
      costUsd: 0,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
      sawAgentEnd,
      ...(sessionId ? { sessionId } : {}),
      // DEF-10：到顶 abort 若让 prompt 抛出，同样落可操作文案（不让 abort 的底层异常吃掉它）。
      // F3：已接受后到顶 ⇒ 该异常是本层 abort 带出的，不落 error、只打标（超时 / 外部取消仍照报）。
      ...(catchCapAfterAccept && !timedOut && !aborted
        ? {}
        : {
            error:
              schemaRejectCapHit && !catchAccepted
                ? schemaRejectCapMessage(SCHEMA_REJECT_MAX)
                : err instanceof Error ? err.message : String(err),
          }),
      trace: makeTrace(sessionBudget, retries, reads),
      ...structuredFields(),
      ...(catchCapAfterAccept ? { schemaRejectCapAfterAccept: true } : {}),
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
