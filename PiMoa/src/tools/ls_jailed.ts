/**
 * `ls` —— **覆盖 pi 内置 ls** 的带路径 jail 版（徐总 2026-08-04）。
 *
 * ## 为什么必须覆盖（实证，不是猜）
 * pi 0.81.1 的内置 `ls`（`dist/core/tools/ls.js`）用 `resolveToCwd(path, cwd)` 解析路径，
 * 而 `resolveToCwd` **支持 `~` 展开与绝对路径且不做任何越界检查**。实测（本机、真调用）：
 *   · `ls ~/.ssh`        → 列出 `agent/ authorized_keys config …`
 *   · `ls /etc`          → 列出系统配置文件名
 *   · `ls ~` → 列出整个家目录
 * 而 `ls` 一直在 verify-worker / delivery-readonly-worker 的 profile 里 ⇒ 这两类 worker
 * **一直**能枚举本机任意目录的文件名。这是**早于跨仓只读根改造就存在**的缺口，与读根放不放开无关：
 * 泄露的是**元数据**（文件名/目录结构，如"这台机器上有哪些密钥文件"），虽非内容，但与
 * `read`/`bash_readonly` 都已 jail 的现状严重不对称——`read` 早就覆盖过（read_budgeted.ts），
 * `ls` 却被漏掉了。同类缺陷一次修全（徐总铁律）。
 *
 * ## 覆盖机制（已核 pi 0.81.1 源码，非推测）
 * `agent-session.js:_refreshToolRegistry`：先用内置工具建 `definitionRegistry` / `toolRegistry`，
 * 再 `for (const tool of allCustomTools) registry.set(tool.definition.name, …)` —— **定义表与
 * 执行表都是后写覆盖**。故 `customTools` 里同名的 `ls` 完全取代内置版（与 `read` 同一机制）。
 *
 * ## 与内置版的差异（均为收紧，不放宽）
 *  · **路径 jail**：复用 `checkPathJail`（越界 + 密钥目录/文件 + realpath 抗 symlink 逃逸），
 *    根集合 = 会话 cwd ∪ `access.readRoots`；
 *  · 其余行为对齐内置：默认 500 条 / 50KB 截断、目录带 `/` 后缀、含 dotfile、按名不分大小写排序。
 *  · 不计入取证预算——目录清单体量小且是"先定位再精读"的必要一步，卡它反而逼模型去用更贵的 rg。
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkPathJail } from "./bash_readonly.js";

/** 与 pi 内置 ls 对齐的默认上限。 */
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 50 * 1024;

interface LsDetails {
  path: string;
  rejected: boolean;
  reason?: string;
  entries?: number;
  truncated?: boolean;
}

export function createLsTool(readRoots: readonly string[] = []) {
  return defineTool({
    name: "ls", // ★同名覆盖 pi 内置 ls（内置版无任何路径限制，能列 ~/.ssh 与 /etc）
    label: "ls (jailed)",
    description:
      "列出目录内容（限审计根内；审计根 = 会话 cwd + 服务端配置的跨仓只读根，给绝对路径可列其它仓库）。" +
      `按名排序、目录带 '/' 后缀、含 dotfile，最多 ${DEFAULT_LIMIT} 条 / ${DEFAULT_MAX_BYTES / 1024}KB。` +
      "审计根之外的路径与密钥目录（.ssh/.aws/.gnupg 等）一律拒。",
    promptSnippet:
      "ls: 列审计根内的目录（cwd + 配置的跨仓只读根）；根外路径与密钥目录拒",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "要列出的目录（相对 cwd 或绝对路径），默认当前目录" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `最多返回多少条，默认 ${DEFAULT_LIMIT}` }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { path?: string; limit?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
      const target = params.path && params.path.trim() !== "" ? params.path : ".";

      // ★路径 jail：越界 / 密钥目录 / symlink 逃逸一律拒（内置 ls 完全没有这层）。
      const jailReason = checkPathJail(["ls", target], cwd, { readRoots });
      if (jailReason) {
        return {
          content: [{ type: "text" as const, text: `REJECTED（路径 jail）：${jailReason}` }],
          details: { path: target, rejected: true, reason: jailReason } as LsDetails,
          isError: true,
        };
      }

      const abs = resolve(cwd, target);
      let names: string[];
      try {
        if (!statSync(abs).isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `REJECTED：'${target}' 不是目录（读文件请用 read）` }],
            details: { path: target, rejected: true } as LsDetails,
            isError: true,
          };
        }
        names = readdirSync(abs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `列目录失败：${msg}` }],
          details: { path: target, rejected: true, reason: msg } as LsDetails,
          isError: true,
        };
      }

      names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT));
      const shown = names.slice(0, limit);
      const lines: string[] = [];
      for (const n of shown) {
        let suffix = "";
        try {
          if (statSync(join(abs, n)).isDirectory()) suffix = "/";
        } catch {
          /* 权限/竞态：按普通条目输出，不因单条失败毙掉整次列目录 */
        }
        lines.push(n + suffix);
      }
      let text = lines.join("\n");
      let truncated = shown.length < names.length;
      if (text.length > DEFAULT_MAX_BYTES) {
        text = text.slice(0, DEFAULT_MAX_BYTES);
        truncated = true;
      }
      if (truncated) {
        // 明确告知截断（别让模型误以为"看全了"，与 bash_readonly 的截断提示同一原则）。
        text += `\n[已截断：共 ${names.length} 条，仅显示前 ${shown.length} 条 / ${DEFAULT_MAX_BYTES / 1024}KB。用 limit= 调大，或换更精确的子目录。]`;
      }

      return {
        content: [{ type: "text" as const, text: text || "(空目录)" }],
        details: {
          path: target,
          rejected: false,
          entries: names.length,
          truncated,
        } as LsDetails,
        // ★绝不设 addedToolNames（防孙 agent 不变量）。
      };
    },
  });
}
