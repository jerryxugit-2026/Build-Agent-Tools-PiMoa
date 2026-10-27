/**
 * `semble_search` —— PiMoa 子会话的受限语义代码检索工具。
 *
 * 检索后端走本机 semble CLI 短命子进程（2026-08-14 徐总裁决：semble 降级为 CLI 按需）。
 * 此前走 8756 HTTP 单实例服务，该服务已停用并从 Claude/codex 两端 MCP 配置摘除——
 * 原因是分流铁律把 Paper System 检索划给 devkb 后，semble 46 小时只有 2 次真实调用
 * 却收了 809 次握手，常驻 80MB 不划算。CLI 实测冷启约 8.5s、缓存热约 1s，跑完进程退出、
 * 内存全额归还、零残留，且不再有"服务没起"这一类故障面。
 * - 不依赖任何常驻服务，无需手动启动；
 * - 搜索根目录必须落在会话允许根内（cwd + 配置只读根）；
 * - query、结果数量、snippet 大小、超时和输出都有硬上限；
 * - 与 read / bash_readonly 共用同一份会话取证预算；
 * - 索引面保持 code-only（徐总 2026-08-13 裁决）：不传 --content，CLI 默认即 code；
 * - 绝不返回 addedToolNames，不能生成孙 agent。
 */
import { TOOL_SLICE_CHARS } from "../config/limits.js";
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { effectiveReadRoots, isWithinRoots } from "./access.js";
import { PAPER_SYSTEM_ROOT } from "./devkb_search.js";
import {
  budgetCrossedNotice,
  budgetMaxChars,
  createRetrievalBudget,
  releaseBudget,
  reserveBudget,
  settleBudget,
  type RetrievalBudget,
} from "./budget.js";

const SEMBLE_CLI = process.env.PIMOA_SEMBLE_CLI ?? `${process.env.HOME ?? ""}/.local/bin/semble`;
/**
 * 120s：CLI 每次都要重新加载 embedding 模型（无常驻热索引），比原 HTTP 服务的 60s 需要更多余量。
 * 实测已缓存的中型仓库约 1s、冷启约 8.5s；首次索引大仓库才可能逼近这个上限。
 */
const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_CHARS = 500;
const MAX_OUTPUT_CHARS = TOOL_SLICE_CHARS; // 统一口径(limits.ts,v4 §4.3;原 40_000)
const MAX_TOP_K = 10;
const MAX_SNIPPET_LINES = 10;

interface SembleOutcome {
  text?: string;
  aborted?: boolean; // 外部会话取消（AbortSignal 触发）
  timedOut?: boolean; // 总超时 120s 兜底触发（子进程被 SIGTERM）
  missing?: boolean; // ENOENT → semble CLI 不在预期路径
  error?: string; // 其它失败（非零退出码 / stderr / 输出超缓冲区）
}

interface SembleDetails {
  rejected: boolean;
  reason?: string;
  aborted?: boolean;
  query?: string;
  path?: string;
  content?: string;
  topK?: number;
  maxSnippetLines?: number;
  budgetUsedChars?: number;
  budgetLimitChars?: number;
}

/**
 * 每次调用 spawn 一个短命 semble CLI 子进程，stdout 即 JSON 结果，进程退出后资源全额归还。
 *
 * 参数经 execFile 数组传递（不过 shell），query/路径含空格或引号都不会被解释成命令；
 * 刻意不传 `--content`：CLI 默认即 code，与"保持 code-only"裁决一致，无需额外开关。
 */
function runSembleCli(
  args: { query: string; repo: string; topK: number; maxSnippetLines: number },
  signal: AbortSignal | undefined,
): Promise<SembleOutcome> {
  return new Promise((resolvePromise) => {
    execFile(
      SEMBLE_CLI,
      [
        "search",
        args.query,
        args.repo,
        "--top-k",
        String(args.topK),
        "--max-snippet-lines",
        String(args.maxSnippetLines),
      ],
      {
        signal,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BUFFER_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ text: stdout });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals };
        // 顺序要紧：会话取消优先于超时，两者都优先于"当作普通失败"。
        if (err.name === "AbortError" || signal?.aborted) {
          resolvePromise({ aborted: true });
          return;
        }
        if (err.killed === true) {
          resolvePromise({ timedOut: true });
          return;
        }
        if (err.code === "ENOENT") {
          resolvePromise({
            missing: true,
            error: `找不到 semble CLI：${SEMBLE_CLI}`,
          });
          return;
        }
        const detail = (stderr || stdout || err.message || String(error)).toString().trim();
        resolvePromise({ error: detail || "semble CLI 以非零状态退出且无输出" });
      },
    );
  });
}

function resolveSearchRoot(
  cwd: string,
  searchPath: string,
  readRoots: readonly string[] = [],
): { root?: string; error?: string } {
  // 允许根 = 会话 cwd ∪ 配置读根（moa.yaml 的 access.readRoots）。不配即退化成旧的单根行为。
  const roots = effectiveReadRoots(cwd, readRoots);
  let searchReal: string;
  try {
    searchReal = realpathSync(resolve(cwd, searchPath || "."));
  } catch (error) {
    return { error: `搜索路径不存在或无法解析：${error instanceof Error ? error.message : String(error)}` };
  }

  if (!isWithinRoots(searchReal, roots)) {
    return { error: `搜索路径越界：只允许搜索这些只读根内部：${roots.join(" | ")}` };
  }
  try {
    if (!statSync(searchReal).isDirectory()) {
      return { error: `搜索路径不是目录：${searchReal}` };
    }
  } catch (error) {
    return { error: `无法检查搜索路径：${error instanceof Error ? error.message : String(error)}` };
  }
  return { root: searchReal };
}

/**
 * 检索分流铁律执法（徐总 2026-08-12）：Paper System 仓库检索一律走 devkb_search，
 * 禁止对该仓库用 semble——semble 重复索引 Paper System 曾酿成 9.6GB 常驻内存事故。
 * 两个方向都拦（realpath + 带分隔符前缀比较，防 "Paper System-x" 误伤）：
 *   ① 搜索根落在 Paper System 内部（含相等）；
 *   ② 搜索根是 Paper System 的祖先（如整个 ai_workspace）——semble 会把它一并索引进去。
 * 命中返回人读理由，否则返回 null。
 */
function paperSystemDivertReason(searchReal: string): string | null {
  if (searchReal === PAPER_SYSTEM_ROOT || searchReal.startsWith(PAPER_SYSTEM_ROOT + sep)) {
    return (
      `检索分流铁律（徐总 2026-08-12）：Paper System 仓库（${PAPER_SYSTEM_ROOT}）的检索一律走 devkb_search` +
      "（语义+全文+调用图三模态駐盘索引），禁止对该仓库使用 semble——semble 重复索引 Paper System " +
      "曾酿成 9.6GB 常驻内存事故。请改用 devkb_search。"
    );
  }
  if (PAPER_SYSTEM_ROOT.startsWith(searchReal + sep)) {
    return (
      `搜索根 ${searchReal} 包含 Paper System 仓库：semble 会把 Paper System 一并索引` +
      "（9.6GB 内存事故根因）。请把 path 缩小到 Paper System 之外的具体目录；" +
      "Paper System 本身的检索改用 devkb_search。"
    );
  }
  return null;
}

function numericLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value as number)));
}

export function createSembleSearchTool(
  budget: RetrievalBudget = createRetrievalBudget(),
  readRoots: readonly string[] = [],
) {
  return defineTool({
    name: "semble_search",
    label: "Semble Search",
    description:
      "语义代码检索，走本机 semble CLI（短命子进程，仅代码索引面，无需任何常驻服务）。" +
      "query 应描述要找的行为、函数或配置；" +
      "搜索根限审计根内（= 会话 cwd + 服务端配置的跨仓只读根；给绝对路径可搜其它仓库），" +
      "返回带路径与行号的代码片段。★用在不知道代码在哪、只能描述行为时；已知符号名/字面量不要用它" +
      "（验真档请用 bash_readonly 的 rg 精确定位）。在有 read 的验真档里可再对命中文件精读。" +
      "不要把它当作整库扫描器；query、结果数和输出均有硬上限。",
    promptSnippet:
      "semble_search: 不知道代码在哪时用自然语言定位（返回路径+行号片段）；已知符号名/字面量别用它（验真档用 bash_readonly 的 rg）；有 read 的档可再精读命中文件；走本机 semble CLI（仅代码索引面，无常驻服务依赖）；限审计根内（cwd + 配置的跨仓只读根），不能递归调用 agent/MCP",
    parameters: Type.Object({
      query: Type.String({ description: "要查找的代码、行为或配置，最多 500 字符" }),
      path: Type.Optional(
        Type.String({
          description: "搜索根目录：相对 cwd 或**绝对路径**（跨仓时给绝对路径），默认当前目录",
        }),
      ),
      content: Type.Optional(
        Type.String({ description: "内容类型：仅支持 code（服务端当前只索引代码），缺省即 code" }),
      ),
      topK: Type.Optional(Type.Number({ description: "最多返回多少个结果，1-10，默认 5" })),
      maxSnippetLines: Type.Optional(
        Type.Number({ description: "每个结果最多返回多少行上下文，0-10，默认 6" }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        query: string;
        path?: string;
        content?: string;
        topK?: number;
        maxSnippetLines?: number;
      },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      // ★取证预算——原子预扣（提速方案 §4.2）：同步 reserve 后才 await，并行调用互见在途额度。
      const reservation = reserveBudget(budget, MAX_OUTPUT_CHARS);
      if (!reservation.ok) {
        const reason = reservation.reason;
        return {
          content: [{ type: "text" as const, text: `REJECTED（取证预算耗尽）：${reason}` }],
          details: { rejected: true, reason } as SembleDetails,
          isError: true,
        };
      }
      const ticket = reservation.ticket;
      try {
        const query = params.query.trim();
        if (!query || query.length > MAX_QUERY_CHARS) {
          releaseBudget(budget, ticket); // 入参拒：未消耗取证额度，退还预扣与轮数
          const reason = `query 必须为 1-${MAX_QUERY_CHARS} 个字符`;
          return {
            content: [{ type: "text" as const, text: `REJECTED：${reason}` }],
            details: { rejected: true, reason } as SembleDetails,
            isError: true,
          };
        }

        const content = params.content ?? "code";
        if (content !== "code") {
          // 索引面保持 code-only（徐总 2026-08-13 裁决）。改走 CLI 后 docs/config 在技术上已可用
          // （semble CLI 支持 --content docs|config|all），但裁决未变，仍如实拒绝、不擅自放开。
          // 要检索文档/配置：用 rg/read 直读目标文件，或由徐总先撤销 code-only 裁决。
          releaseBudget(budget, ticket);
          const reason =
            "content 仅支持 code（缺省即 code）：索引面按徐总 2026-08-13 裁决保持 code-only。" +
            "要检索文档/配置请改用 rg/read 直读目标文件，不要上报请求放开。";
          return {
            content: [{ type: "text" as const, text: `REJECTED：${reason}` }],
            details: { rejected: true, reason } as SembleDetails,
            isError: true,
          };
        }

        const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
        const resolved = resolveSearchRoot(cwd, params.path ?? ".", readRoots);
        if (!resolved.root) {
          releaseBudget(budget, ticket);
          return {
            content: [{ type: "text" as const, text: `REJECTED（路径 jail）：${resolved.error}` }],
            details: { rejected: true, reason: resolved.error } as SembleDetails,
            isError: true,
          };
        }

        // 分流执法在越界检查之后：只对"jail 本会放行"的路径做 devkb 分流，两闸互不遮蔽。
        const divertReason = paperSystemDivertReason(resolved.root);
        if (divertReason) {
          releaseBudget(budget, ticket);
          return {
            content: [{ type: "text" as const, text: `REJECTED（检索分流铁律）：${divertReason}` }],
            details: { rejected: true, reason: divertReason } as SembleDetails,
            isError: true,
          };
        }

        const topK = numericLimit(params.topK, 5, MAX_TOP_K);
        const maxSnippetLines = Math.min(
          MAX_SNIPPET_LINES,
          Math.max(0, Number.isFinite(params.maxSnippetLines) ? Math.floor(params.maxSnippetLines as number) : 6),
        );
        const result = await runSembleCli(
          { query, repo: resolved.root, topK, maxSnippetLines },
          signal,
        );
        if (result.aborted) {
          // 会话被取消（不是搜索失败），如实标注，别记成一次普通失败；未产出内容 → 退还预扣。
          releaseBudget(budget, ticket);
          return {
            content: [{ type: "text" as const, text: "semble 搜索已中止（会话取消）" }],
            details: { rejected: false, aborted: true, query, path: resolved.root } as SembleDetails,
            isError: true,
          };
        }
        if (result.missing) {
          releaseBudget(budget, ticket);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `semble CLI 不在预期路径（${SEMBLE_CLI}），无法检索。请转告徐总核实安装；` +
                  "本工具已不依赖任何常驻服务，不要去启动 8756（该服务 2026-08-14 已停用）。\n" +
                  `底层错误：${result.error ?? "ENOENT"}`,
              },
            ],
            details: { rejected: false, reason: "semble CLI 缺失", query, path: resolved.root } as SembleDetails,
            isError: true,
          };
        }
        if (result.timedOut) {
          releaseBudget(budget, ticket);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `semble 搜索超时（${CLI_TIMEOUT_MS / 1000}s）：若为首次索引该仓库（${resolved.root}）` +
                  "可稍后重试——首次索引大仓库耗时较长，索引建好后落盘缓存，后续调用约 1 秒。",
              },
            ],
            details: { rejected: false, reason: "semble CLI 超时", query, path: resolved.root } as SembleDetails,
            isError: true,
          };
        }
        if (result.error !== undefined || result.text === undefined) {
          releaseBudget(budget, ticket);
          let errText = result.error ?? "semble 无输出";
          if (errText.length > MAX_OUTPUT_CHARS) errText = errText.slice(0, MAX_OUTPUT_CHARS);
          return {
            content: [{ type: "text" as const, text: `semble 搜索失败：\n${errText}` }],
            details: { rejected: false, reason: errText.slice(0, 500), query, path: resolved.root } as SembleDetails,
            isError: true,
          };
        }

        let text = result.text.trim() || "semble 无输出";
        if (text.length > MAX_OUTPUT_CHARS) {
          text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[semble 输出已按 ${MAX_OUTPUT_CHARS} 字符截断]`;
        }
        // settle：预扣 cap 换成实际字符；settle 后跨过阈值则附加收敛提示。
        if (settleBudget(budget, ticket, text.length)) text += budgetCrossedNotice(budget);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            rejected: false,
            query,
            path: resolved.root,
            content,
            topK,
            maxSnippetLines,
            budgetUsedChars: budget.usedChars,
            budgetLimitChars: budgetMaxChars(budget),
          } as SembleDetails,
          // 绝不设置 addedToolNames：搜索结果不能向会话引入新工具。
        };
      } finally {
        // 抛错兜底：预扣绝不悬挂。已 settle/release 的票据幂等跳过。
        settleBudget(budget, ticket, 0);
      }
    },
  });
}
