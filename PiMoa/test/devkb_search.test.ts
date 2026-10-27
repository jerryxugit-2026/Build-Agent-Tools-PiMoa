/**
 * devkb_search 工具接线测试：预算闸、入参校验、args 组装、退出码语义（0/2-DEGRADED/2-新鲜度门/其他）。
 *
 * 外部依赖隔离：不碰真 devkb / 真 Paper System——用 PIMOA_DEVKB_ROOT 指到临时假根，
 * 假 bin/devkb 按 query（$2）切换行为（degraded→exit2+DEGRADED stderr；stale→exit2 无
 * DEGRADED；boom→exit1）。env 覆盖必须发生在动态 import 之前（模块加载时定根）。
 *
 * 运行：
 *   npx tsx test/devkb_search.test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetrievalBudget, SESSION_MAX_TOOL_CALLS } from "../src/tools/budget.ts";

const fakeRoot = mkdtempSync(join(tmpdir(), "pimoa-devkb-test-"));
mkdirSync(join(fakeRoot, "bin"), { recursive: true });
writeFileSync(
  join(fakeRoot, "bin", "devkb"),
  `#!/bin/sh
echo "ARGS: $*"
echo "CWD: $(pwd)"
case "$2" in
  degraded*) echo "DEGRADED: embedding 不可用，已退 BM25-only" >&2; exit 2 ;;
  stale*) echo "index behind source; refresh required" >&2; exit 2 ;;
  boom*) echo "boom diagnostics" >&2; exit 1 ;;
esac
exit 0
`,
);
chmodSync(join(fakeRoot, "bin", "devkb"), 0o755);
process.env.PIMOA_DEVKB_ROOT = fakeRoot;
const realFakeRoot = realpathSync(fakeRoot);

// 根注入在前、import 在后（PAPER_SYSTEM_ROOT 在模块加载时 realpath 定根）。
const { createDevkbSearchTool, PAPER_SYSTEM_ROOT } = await import("../src/tools/devkb_search.ts");
if (PAPER_SYSTEM_ROOT !== realFakeRoot) {
  throw new Error(`PIMOA_DEVKB_ROOT 覆盖未生效：${PAPER_SYSTEM_ROOT} ≠ ${realFakeRoot}`);
}

type ToolCall = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const ctx = { cwd: process.cwd() };

function makeTool(budget = createRetrievalBudget()) {
  return {
    tool: createDevkbSearchTool(budget) as unknown as { execute: ToolCall },
    budget,
  };
}

try {
  // 1) 取证预算耗尽 → REJECT（与 read/bash_readonly/semble 共用一本账）。
  {
    const exhausted = createRetrievalBudget();
    exhausted.calls = SESSION_MAX_TOOL_CALLS;
    const { tool } = makeTool(exhausted);
    const res = await tool.execute("devkb-budget", { query: "anything" }, undefined, undefined, ctx);
    const text = res.content.map((b) => b.text).join("\n");
    if (!res.isError || !text.includes("REJECTED（取证预算耗尽）")) {
      throw new Error(`预算耗尽负例失败：${text.slice(0, 500)}`);
    }
    console.log("  ✅ 取证预算耗尽被 REJECT");
  }

  // 2) 非法 cmd → REJECT（不落到子进程）。
  {
    const { tool } = makeTool();
    const res = await tool.execute("devkb-badcmd", { cmd: "refresh", query: "x" }, undefined, undefined, ctx);
    const text = res.content.map((b) => b.text).join("\n");
    if (!res.isError || !text.includes("cmd 只能是")) {
      throw new Error(`非法 cmd 负例失败：${text.slice(0, 500)}`);
    }
    console.log("  ✅ 非法 cmd 被 REJECT");
  }

  // 3) 非法 query（空 / 超 500 字符）→ REJECT。
  {
    const { tool } = makeTool();
    const empty = await tool.execute("devkb-emptyq", { query: "   " }, undefined, undefined, ctx);
    const long = await tool.execute("devkb-longq", { query: "q".repeat(501) }, undefined, undefined, ctx);
    for (const [name, res] of [["空 query", empty], ["超长 query", long]] as const) {
      const text = res.content.map((b) => b.text).join("\n");
      if (!res.isError || !text.includes("query 必须为 1-500")) {
        throw new Error(`${name} 负例失败：${text.slice(0, 500)}`);
      }
    }
    console.log("  ✅ 非法 query（空/超长）被 REJECT");
  }

  // 4) find 的 args 组装：--k 收敛入界、--modality 默认 all、--exclude-tests、cwd=Paper System 根。
  {
    const { tool, budget } = makeTool();
    const res = await tool.execute(
      "devkb-args-find",
      { query: "argscheck query", k: 7, excludeTests: true },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content.map((b) => b.text).join("\n");
    if (res.isError) throw new Error(`find 正例失败：${text.slice(0, 500)}`);
    if (!text.includes("ARGS: find argscheck query --k 7 --modality all --exclude-tests")) {
      throw new Error(`find args 组装不符：${text.slice(0, 500)}`);
    }
    if (!text.includes(`CWD: ${realFakeRoot}`)) {
      throw new Error(`子进程 cwd 不是 Paper System 根：${text.slice(0, 500)}`);
    }
    if (budget.calls !== 1 || budget.usedChars <= 0) {
      throw new Error(`成功检索未记预算账：calls=${budget.calls} usedChars=${budget.usedChars}`);
    }
    console.log("  ✅ find args 组装正确（--k/--modality 默认 all/--exclude-tests + cwd 钉死）且已记预算");
  }

  // 5) callers 是图谱查询：k/modality/excludeTests 传了就忽略，不进 args。
  {
    const { tool } = makeTool();
    const res = await tool.execute(
      "devkb-args-callers",
      { cmd: "callers", query: "MySymbol", k: 9, modality: "code", excludeTests: true },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content.map((b) => b.text).join("\n");
    if (res.isError) throw new Error(`callers 正例失败：${text.slice(0, 500)}`);
    if (!text.includes("ARGS: callers MySymbol\n")) {
      throw new Error(`callers args 组装不符（应只有 cmd+symbol）：${text.slice(0, 500)}`);
    }
    if (text.includes("--k") || text.includes("--modality") || text.includes("--exclude-tests")) {
      throw new Error(`callers 不应携带 find/search 专属旗标：${text.slice(0, 500)}`);
    }
    console.log("  ✅ callers 只传 [cmd, symbol]，忽略 k/modality/excludeTests");
  }

  // 6) 退出码 2 + stderr 带 DEGRADED → 成功（非错误），正文含 stderr 诊断。
  {
    const { tool, budget } = makeTool();
    const res = await tool.execute(
      "devkb-degraded",
      { cmd: "search", query: "degraded probe" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content.map((b) => b.text).join("\n");
    if (res.isError) throw new Error(`DEGRADED 应视为成功，实际报错：${text.slice(0, 500)}`);
    if (!text.includes("[devkb 诊断]") || !text.includes("DEGRADED")) {
      throw new Error(`DEGRADED 诊断未拼进正文：${text.slice(0, 500)}`);
    }
    if (budget.calls !== 1) throw new Error(`DEGRADED 成功未记预算账：calls=${budget.calls}`);
    console.log("  ✅ 退出码 2（DEGRADED）视为成功，stderr 诊断在正文");
  }

  // 7) 退出码 2 无 DEGRADED = 新鲜度门拦截 → 标错 + 提示上报刷新（子会话无权刷新）。
  {
    const { tool, budget } = makeTool();
    const res = await tool.execute("devkb-stale", { query: "stale probe" }, undefined, undefined, ctx);
    const text = res.content.map((b) => b.text).join("\n");
    if (!res.isError || !text.includes("[需要先刷新索引]") || !text.includes("上报")) {
      throw new Error(`新鲜度门语义不符：${text.slice(0, 500)}`);
    }
    if (budget.calls !== 0) throw new Error(`新鲜度门拦截不应记预算账：calls=${budget.calls}`);
    console.log("  ✅ 退出码 2（无 DEGRADED）按新鲜度门标错并提示上报");
  }

  // 8) 其他退出码 → isError，带 stdout/stderr 原文。
  {
    const { tool } = makeTool();
    const res = await tool.execute("devkb-boom", { query: "boom probe" }, undefined, undefined, ctx);
    const text = res.content.map((b) => b.text).join("\n");
    if (!res.isError || !text.includes("devkb find 失败（exit=1）") || !text.includes("boom diagnostics")) {
      throw new Error(`真失败语义不符：${text.slice(0, 500)}`);
    }
    console.log("  ✅ 退出码 1 报失败并带 stdout/stderr 原文");
  }
} finally {
  rmSync(fakeRoot, { recursive: true, force: true });
}
