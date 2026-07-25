/**
 * `read` —— **覆盖 pi 内置 read** 的预算版读文件工具（徐总 2026-07-25）。
 *
 * 为什么要覆盖：pi 内置 `read` 的输出量由 pi 决定，PiMoa 封不了顶；proposer 连续 read 多个大文件即可
 * 把对话堆到 60 万 token 撞爆上游（gemini 吐空正文；MiniMax-M3 / mimo-v2.5-pro 仅 20 万直接 overflow）
 * → 正文空 → 2/2 fail-closed、不落盘。`bash_readonly` 已纳入预算，`read` 这条路必须一并收口，
 * 否则预算形同虚设。
 *
 * 覆盖机制（已核 pi 0.81.1 源码 agent-session.ts:2485-2490 与 2520-2524）：`customTools` 中的同名工具
 * 在**定义注册表**与**执行注册表**上都会 `.set()` 覆盖内置同名工具 ⇒ 本工具生效、pi 内置 read 不被调用。
 *
 * 相对 pi 内置 read 的差异（均为收紧，不放宽）：
 *  · **纳入会话取证预算**（与 bash_readonly 共用一本账，见 budget.ts）；
 *  · **路径 jail**：复用 bash_readonly 的 `checkPathJail`（realpath 越界 + nlink>1 硬链接检测），
 *    只允许读审计根（cwd）内的文件 —— 内置 read 无此限制（可读 ~/.ssh 等），故此覆盖亦是安全收紧；
 *  · 不支持图片附件（取证场景不需要；请求图片时明确告知改用 bash_readonly 的 file/stat）。
 * 接口与内置一致：`{ path, offset?, limit? }`，默认截断沿用 pi 的 2000 行 / 50KB。
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkPathJail } from "./bash_readonly.js";
import {
  budgetCrossedNotice,
  budgetExhaustedReason,
  chargeBudget,
  createRetrievalBudget,
  isBudgetExhausted,
  type RetrievalBudget,
} from "./budget.js";

/** 工具返回的 details 统一形状（各分支一致，避免 TS 从首个 return 推窄）。 */
interface ReadDetails {
  path: string;
  rejected: boolean;
  reason?: string;
  lines?: string;
  budgetUsedChars?: number;
}

/** 与 pi 内置 read 对齐的单次截断上限。 */
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
/** 二进制/图片扩展名：取证场景不回传内容。 */
const NON_TEXT_RE = /\.(jpe?g|png|gif|webp|bmp|ico|pdf|zip|gz|tar|so|dylib|dll|exe|o|a|wasm|mp[34]|mov)$/i;

/**
 * 预算版 read 的工厂：每个会话建一份，绑定该会话的取证预算账本
 * （与同会话的 bash_readonly **共用同一本账**）。
 */
export function createReadTool(budget: RetrievalBudget = createRetrievalBudget()) {
  return defineTool({
    name: "read", // ★同名覆盖 pi 内置 read
    label: "Read (budgeted)",
    description:
      "读取文件内容（限审计目录内的文本文件）。默认最多 2000 行 / 50KB，用 offset/limit 读大文件的指定片段。\n" +
      "★本会话的取证有**总预算**（与 bash_readonly 共用）：超出后读取会被拒绝，请优先用" +
      "`bash_readonly` 的 `rg -n 模式 路径` 只取匹配行、或用 offset/limit 精确读片段，" +
      "**不要整库整文件地扫**。读不到审计目录之外的文件。",
    promptSnippet:
      "read: 读审计目录内的文本文件（2000 行/50KB 上限，支持 offset/limit）；计入会话取证预算，超预算即拒——优先用 rg 取匹配行而非整文件读",
    parameters: Type.Object({
      path: Type.String({ description: "要读取的文件路径（相对或绝对，须在审计目录内）" }),
      offset: Type.Optional(Type.Number({ description: "起始行号（1 起）" })),
      limit: Type.Optional(Type.Number({ description: "最多读取的行数" })),
    }),
    execute: async (
      _toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();

      // ★预算闸：已超顶即拒绝再读（读盘前就判）。
      if (isBudgetExhausted(budget)) {
        const reason = budgetExhaustedReason(budget);
        return {
          content: [{ type: "text" as const, text: `REJECTED（取证预算耗尽）：${reason}` }],
          details: { path: params.path, rejected: true, reason } as ReadDetails,
          isError: true,
        };
      }

      // ★路径 jail：复用 bash_readonly 的越界/硬链接检测（内置 read 没有这层）。
      const jailReason = checkPathJail(["read", params.path], cwd);
      if (jailReason) {
        return {
          content: [{ type: "text" as const, text: `REJECTED（路径 jail）：${jailReason}` }],
          details: { path: params.path, rejected: true, reason: jailReason } as ReadDetails,
          isError: true,
        };
      }

      const abs = resolve(cwd, params.path);
      let raw: string;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `REJECTED：'${params.path}' 是目录，请用 bash_readonly 的 \`ls\` 或 \`rtk ls\`` }],
            details: { path: params.path, rejected: true } as ReadDetails,
            isError: true,
          };
        }
        if (NON_TEXT_RE.test(abs)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `REJECTED：'${params.path}' 是二进制/图片文件，取证不回传其内容。需要元数据请用 bash_readonly 的 \`stat\` / \`file\` / \`sha256sum\`。`,
              },
            ],
            details: { path: params.path, rejected: true } as ReadDetails,
            isError: true,
          };
        }
        raw = readFileSync(abs, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `读取失败：${msg}` }],
          details: { path: params.path, rejected: true, reason: msg } as ReadDetails,
          isError: true,
        };
      }

      // 行切片（offset 1 起）+ 与 pi 内置一致的 2000 行 / 50KB 截断。
      const allLines = raw.split("\n");
      const start = Math.max(1, Math.floor(params.offset ?? 1));
      const maxLines = Math.max(1, Math.floor(params.limit ?? DEFAULT_MAX_LINES));
      const slice = allLines.slice(start - 1, start - 1 + Math.min(maxLines, DEFAULT_MAX_LINES));

      let text = slice.join("\n");
      const notices: string[] = [];
      if (text.length > DEFAULT_MAX_BYTES) {
        text = text.slice(0, DEFAULT_MAX_BYTES);
        notices.push(`[已按 ${DEFAULT_MAX_BYTES / 1024}KB 上限截断]`);
      }
      const lastLine = start - 1 + slice.length;
      if (lastLine < allLines.length) {
        notices.push(
          `[仅显示第 ${start}-${lastLine} 行，共 ${allLines.length} 行；继续读请用 offset=${lastLine + 1}]`,
        );
      }
      if (notices.length > 0) text += `\n${notices.join(" ")}`;

      // 记账（与 bash_readonly 共用同一本账）；跨阈值则附加收敛提示。
      if (chargeBudget(budget, text.length)) text += budgetCrossedNotice(budget);

      return {
        content: [{ type: "text" as const, text }],
        details: {
          path: params.path,
          rejected: false,
          lines: `${start}-${lastLine}/${allLines.length}`,
          budgetUsedChars: budget.usedChars,
        } as ReadDetails,
        // ★绝不设 addedToolNames（防孙 agent 不变量）。
      };
    },
  });
}
