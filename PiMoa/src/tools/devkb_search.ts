/**
 * `devkb_search` —— PiMoa 子会话的 Paper System 专用检索工具（dev-kb CLI 前门）。
 *
 * 检索分流铁律（徐总 2026-08-12）：凡涉及 PaperGo / Paper System 仓库的检索一律走 devkb
 * （语义+全文+调用图三模态，索引駐盘 SurrealDB 8019），禁止对该仓库使用 semble 或全文扫库
 * ——semble 曾因重复索引 Paper System 酿成 9.6GB 常驻内存事故。本工具是该铁律在
 * PiMoa 子会话里的工具面；semble_search 侧的拒绝执法复用这里导出的 PAPER_SYSTEM_ROOT。
 *
 * 与 semble_search 同一套安全口径：
 * - 固定绝对可执行文件（bin/devkb），避免 PATH 劫持；
 * - 语料根钉死为 Paper System（不吃会话 cwd / readRoots，子进程 cwd 也必须是它——
 *   devkb 的新鲜度门与相对路径都以仓库根为基准）；
 * - query、k、超时和输出都有硬上限；
 * - 与 read / bash_readonly / semble_search 共用同一份会话取证预算；
 * - 绝不返回 addedToolNames，不能生成孙 agent。
 *
 * devkb 退出码约定（照抄 devkb-mcp 前门 server.mjs）：0=正常；2=DEGRADED（embedding
 * 不可用退 BM25，结果仍可用，降级说明在 stderr）；2 且 stderr 无 DEGRADED=新鲜度门拦截
 * （索引落后，需要先刷新——子代理无权刷新，只能上报）；其余=失败。
 * stderr 是诊断（新鲜度警示/降级说明），必须拼进返回正文让模型看到。
 */
import { TOOL_SLICE_CHARS } from "../config/limits.js";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  budgetCrossedNotice,
  budgetMaxChars,
  createRetrievalBudget,
  releaseBudget,
  reserveBudget,
  settleBudget,
  type RetrievalBudget,
} from "./budget.js";

const RAW_PAPER_SYSTEM_ROOT =
  process.env.PIMOA_DEVKB_ROOT ??
  "./paper-system"; // set PIMOA_DEVKB_ROOT to your indexed repository

/**
 * Paper System 仓库根（realpath 归一，供 semble_search 分流执法复用做前缀比较）。
 * 根不存在时退回 resolve 归一——工具调用时 execFile 会以 ENOENT fail-loud，
 * 不能因为一台机器没挂载该卷就让整个模块 import 崩掉。
 */
export const PAPER_SYSTEM_ROOT = (() => {
  try {
    return realpathSync(RAW_PAPER_SYSTEM_ROOT);
  } catch {
    return resolve(RAW_PAPER_SYSTEM_ROOT);
  }
})();
const DEVKB_BIN = `${PAPER_SYSTEM_ROOT}/bin/devkb`;

const EXEC_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_CHARS = 500;
const MAX_OUTPUT_CHARS = TOOL_SLICE_CHARS; // 统一口径(limits.ts,v4 §4.3;原 30_000)
const MAX_K = 30;
const SEARCH_CMDS = new Set(["find", "search"]);
const CMDS = new Set(["find", "search", "callers", "callees", "impact"]);
const MODALITIES = new Set(["code", "doc", "schema", "all"]);

interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted?: boolean;
  error?: string;
}

interface DevkbDetails {
  rejected: boolean;
  reason?: string;
  exitCode?: number | null;
  aborted?: boolean;
  degraded?: boolean;
  staleIndex?: boolean;
  cmd?: string;
  query?: string;
  k?: number;
  modality?: string;
  excludeTests?: boolean;
  budgetUsedChars?: number;
  budgetLimitChars?: number;
}

function runDevkb(args: string[], signal: AbortSignal | undefined): Promise<ExecOutcome> {
  return new Promise((resolveResult) => {
    execFile(
      DEVKB_BIN,
      args,
      {
        cwd: PAPER_SYSTEM_ROOT, // devkb 的新鲜度门/相对路径都以仓库根为工作目录
        shell: false,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        signal, // session abort → 杀子进程（与 semble_search 同例），否则只能等 timeout 兜底
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          LANG: process.env.LANG ?? "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "",
        },
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolveResult({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: typeof err?.code === "number" ? err.code : error ? 1 : 0,
          // abort（signal 触发，code='ABORT_ERR'）≠ 检索失败：单独打标，别折进通用 exit=1
          ...(err?.code === "ABORT_ERR" ? { aborted: true } : {}),
          ...(error ? { error: error.message } : {}),
        });
      },
    );
  });
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[devkb 输出已按 ${MAX_OUTPUT_CHARS} 字符截断]`
    : text;
}

export function createDevkbSearchTool(budget: RetrievalBudget = createRetrievalBudget()) {
  return defineTool({
    name: "devkb_search",
    label: "DevKB Search (Paper System)",
    description:
      "对 PaperGo（Paper System 仓库）做语义+全文检索 + 调用图查询（dev-kb 三模态駐盘索引）。" +
      "★检索分流铁律：Paper System 仓库的检索一律用本工具，不要对该仓库用 semble_search 或全文扫库。" +
      "cmd=find（检索+调用图邻居融合，首选）/search（纯检索略快）时可用 k/modality/excludeTests；" +
      "cmd=callers/callees 查谁调用谁、impact 查改动波及面，此时 query=Go 符号裸名。" +
      "结果带 DEGRADED 标记时表示 embedding 降级为 BM25，结果仍可用但语义召回变弱。",
    promptSnippet:
      "devkb_search: PaperGo（Paper System 仓库）检索一律用它（勿对该仓库用 semble_search/全文扫库）；不知道代码在哪时用 cmd=find/search 语义定位，已知 Go 符号名用 callers/callees/impact 查调用关系（验真档精确定位行号用 bash_readonly 的 rg）；DEGRADED=降级 BM25 结果仍可用",
    parameters: Type.Object({
      cmd: Type.Optional(
        Type.String({
          description:
            "子命令：find（检索+调用图融合，默认）、search（纯检索）、callers/callees/impact（调用图，query=Go 符号裸名）",
        }),
      ),
      query: Type.String({
        description: "检索语句（中英文均可），最多 500 字符；callers/callees/impact 时为 Go 符号裸名",
      }),
      k: Type.Optional(Type.Number({ description: "返回条数 1-30，仅 find/search 生效" })),
      modality: Type.Optional(
        Type.String({
          description: "检索面：code、doc、schema 或 all（默认 all），仅 find/search 生效",
        }),
      ),
      excludeTests: Type.Optional(
        Type.Boolean({ description: "true 时排除 *_test.go，仅 find/search 生效" }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        cmd?: string;
        query: string;
        k?: number;
        modality?: string;
        excludeTests?: boolean;
      },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ) => {
      // ★取证预算——原子预扣（提速方案 §4.2）：同步 reserve 后才 await，并行调用互见在途额度。
      const reservation = reserveBudget(budget, MAX_OUTPUT_CHARS);
      if (!reservation.ok) {
        const reason = reservation.reason;
        return {
          content: [{ type: "text" as const, text: `REJECTED（取证预算耗尽）：${reason}` }],
          details: { rejected: true, reason } as DevkbDetails,
          isError: true,
        };
      }
      const ticket = reservation.ticket;
      try {
        const cmd = params.cmd ?? "find";
        if (!CMDS.has(cmd)) {
          releaseBudget(budget, ticket); // 入参拒：未消耗取证额度，退还预扣与轮数
          const reason = "cmd 只能是 find、search、callers、callees 或 impact";
          return {
            content: [{ type: "text" as const, text: `REJECTED：${reason}` }],
            details: { rejected: true, reason } as DevkbDetails,
            isError: true,
          };
        }

        const query = params.query.trim();
        if (!query || query.length > MAX_QUERY_CHARS) {
          releaseBudget(budget, ticket);
          const reason = `query 必须为 1-${MAX_QUERY_CHARS} 个字符`;
          return {
            content: [{ type: "text" as const, text: `REJECTED：${reason}` }],
            details: { rejected: true, reason } as DevkbDetails,
            isError: true,
          };
        }

        const args: string[] = [cmd, query];
        let k: number | undefined;
        let modality: string | undefined;
        let excludeTests: boolean | undefined;
        // k/modality/excludeTests 仅 find/search 生效；其余 cmd 传了就忽略（不报错）。
        if (SEARCH_CMDS.has(cmd)) {
          modality = params.modality ?? "all";
          if (!MODALITIES.has(modality)) {
            releaseBudget(budget, ticket);
            const reason = "modality 只能是 code、doc、schema 或 all";
            return {
              content: [{ type: "text" as const, text: `REJECTED：${reason}` }],
              details: { rejected: true, reason } as DevkbDetails,
              isError: true,
            };
          }
          if (Number.isFinite(params.k)) {
            k = Math.min(MAX_K, Math.max(1, Math.floor(params.k as number)));
            args.push("--k", String(k));
          }
          args.push("--modality", modality);
          excludeTests = params.excludeTests === true;
          if (excludeTests) args.push("--exclude-tests");
        }

        const result = await runDevkb(args, signal);
        if (result.aborted) {
          // 会话被取消（不是检索失败），如实标注，别记成一次普通 exit=1；未产出内容 → 退还预扣。
          releaseBudget(budget, ticket);
          return {
            content: [{ type: "text" as const, text: "devkb 检索已中止（会话取消）" }],
            details: { rejected: false, aborted: true, cmd, query } as DevkbDetails,
            isError: true,
          };
        }

        // stderr 是诊断（新鲜度警示/降级说明），一并拼进正文让模型看到。
        const diag = result.stderr.trim() ? `\n\n[devkb 诊断]\n${result.stderr.trim()}` : "";
        const degraded = result.code === 2 && /DEGRADED/.test(result.stderr);
        if (result.code === 2 && !degraded) {
          // 新鲜度门拦截：索引落后于源码。子代理无权刷新索引，标错防止被误读成"没找到"。不记预算账。
          releaseBudget(budget, ticket);
          return {
            content: [
              {
                type: "text" as const,
                text: clip(
                  "[需要先刷新索引] devkb 新鲜度门拦截——索引落后于源码。子会话无权刷新索引，" +
                    "请在结论中上报需要刷新索引（由主会话运行 tools/sidecar/devkb-refresh.sh 后重试）。\n" +
                    `${result.stdout}${diag}`,
                ),
              },
            ],
            details: { rejected: false, staleIndex: true, exitCode: result.code, cmd, query } as DevkbDetails,
            isError: true,
          };
        }
        if (result.code !== 0 && result.code !== 2) {
          releaseBudget(budget, ticket); // 检索失败无结果：不记账（改造前口径）
          const failText = `${result.stdout}${diag}`.trim() || result.error || "devkb 无输出";
          return {
            content: [
              { type: "text" as const, text: clip(`devkb ${cmd} 失败（exit=${String(result.code)}）：\n${failText}`) },
            ],
            details: { rejected: false, exitCode: result.code, cmd, query } as DevkbDetails,
            isError: true,
          };
        }

        // 退出码 0，或 2 且带 DEGRADED（结果可用，降级说明已在 diag 里）。
        let text = clip(`${result.stdout || "(无输出)"}${diag}`);
        // settle：预扣 cap 换成实际字符；settle 后跨过阈值则附加收敛提示。
        if (settleBudget(budget, ticket, text.length)) text += budgetCrossedNotice(budget);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            rejected: false,
            exitCode: result.code,
            degraded,
            cmd,
            query,
            k,
            modality,
            excludeTests,
            budgetUsedChars: budget.usedChars,
            budgetLimitChars: budgetMaxChars(budget),
          } as DevkbDetails,
          // 绝不设置 addedToolNames：检索结果不能向会话引入新工具。
        };
      } finally {
        // 抛错兜底：预扣绝不悬挂。已 settle/release 的票据幂等跳过。
        settleBudget(budget, ticket, 0);
      }
    },
  });
}
