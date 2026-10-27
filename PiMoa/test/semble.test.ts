/**
 * semble_search 工具接线测试：验证真实经本机 semble CLI 的检索与 cwd jail。
 *
 * 前置：只需 ~/.local/bin/semble 存在（2026-08-14 起后端由 8756 HTTP 服务
 * 改为 CLI 短命子进程，**不再需要任何常驻服务**）。CLI 缺失时本测试 FAIL，绝不 SKIP 假绿。
 * 首次对本仓库检索需建索引（约 10 秒），之后落盘缓存约 1 秒。
 *
 * 运行：
 *   npx tsx test/semble.test.ts
 */
import { createSembleSearchTool } from "../src/tools/semble_search.ts";
if (!process.env.PIMOA_DEVKB_ROOT) { console.log("SKIP: set PIMOA_DEVKB_ROOT (an indexed repository) to run this test"); process.exit(0); }
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

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

const tool = createSembleSearchTool() as unknown as { execute: ToolCall };
const cwd = process.cwd();

const positive = await tool.execute(
  "semble-test-positive",
  { query: "createAgentSession", path: "src", content: "code", topK: 3, maxSnippetLines: 4 },
  undefined,
  undefined,
  { cwd },
);
const positiveText = positive.content.map((block) => block.text).join("\n");
if (positive.isError && positiveText.includes("不在预期路径")) {
  // CLI 缺失 ≠ 可跳过：明确指出安装路径后 FAIL，绝不 SKIP 假绿。
  throw new Error(
    "semble CLI 不在 ~/.local/bin/semble，请先核实安装再重跑本测试。\n" +
      "（注意：本工具 2026-08-14 起已不依赖 8756 常驻服务，不要去启动它。）\n" +
      `工具原始输出：${positiveText.slice(0, 600)}`,
  );
}
if (positive.isError || !positiveText.includes("session.ts")) {
  throw new Error(`semble 正例失败：${positiveText.slice(0, 1000)}`);
}
console.log("  ✅ 真实经 semble CLI 搜索返回 PiMoa session.ts");
console.log(`     命中片段：${positiveText.slice(0, 200).replace(/\n/g, " | ")}`);

const negative = await tool.execute(
  "semble-test-jail",
  { query: "createAgentSession", path: "/tmp", content: "code" },
  undefined,
  undefined,
  { cwd },
);
if (!negative.isError || !negative.content[0]?.text.includes("路径 jail")) {
  throw new Error(`cwd jail 负例失败：${negative.content.map((block) => block.text).join("\n")}`);
}
console.log("  ✅ 越界搜索路径被 cwd jail 拒绝");

// —— content 收窄负例：索引面按徐总 2026-08-13 裁决保持 code-only，docs/config/all 必须 REJECT ——
// 该拒绝发生在 spawn CLI 之前（本地参数闸）。注意：改走 CLI 后 docs/config 技术上已可用
// （semble CLI 支持 --content），这条闸是在执行裁决而非受技术所限，撤销前不得放开。
const contentDocs = await tool.execute(
  "semble-test-content-docs",
  { query: "createAgentSession", path: "src", content: "docs" },
  undefined,
  undefined,
  { cwd },
);
const contentDocsText = contentDocs.content.map((block) => block.text).join("\n");
if (
  !contentDocs.isError ||
  !contentDocsText.includes("code-only") ||
  !contentDocsText.includes("REJECTED")
) {
  throw new Error(`content=docs 收窄负例失败：${contentDocsText.slice(0, 800)}`);
}
console.log("  ✅ content=docs 被 REJECT（code-only 裁决未撤销前不放开）");

// —— 检索分流铁律（徐总 2026-08-12）：Paper System 检索拒 semble、指去 devkb_search ——
// 两例都把目标路径放进 readRoots（jail 本会放行），确保拒绝确实来自分流执法而非路径越界；
// 且都在 execFile 之前拒掉，不真跑 semble（不索引、只读）。
const PAPER_SYSTEM = WS + "/workspace/Claude dev paper system/Paper System";
const PAPER_SYSTEM_ANCESTOR = WS + "/workspace/Claude dev paper system";

const divertInside = await (createSembleSearchTool(undefined, [PAPER_SYSTEM]) as unknown as {
  execute: ToolCall;
}).execute(
  "semble-test-divert-inside",
  { query: "anything at all", path: PAPER_SYSTEM, content: "code" },
  undefined,
  undefined,
  { cwd },
);
const divertInsideText = divertInside.content.map((block) => block.text).join("\n");
if (
  !divertInside.isError ||
  !divertInsideText.includes("检索分流铁律") ||
  !divertInsideText.includes("devkb_search")
) {
  throw new Error(`Paper System 内部分流负例失败：${divertInsideText.slice(0, 800)}`);
}
console.log("  ✅ Paper System 内部路径被分流铁律拒绝并指去 devkb_search");

const divertAncestor = await (createSembleSearchTool(undefined, [PAPER_SYSTEM_ANCESTOR]) as unknown as {
  execute: ToolCall;
}).execute(
  "semble-test-divert-ancestor",
  { query: "anything at all", path: PAPER_SYSTEM_ANCESTOR, content: "code" },
  undefined,
  undefined,
  { cwd },
);
const divertAncestorText = divertAncestor.content.map((block) => block.text).join("\n");
if (
  !divertAncestor.isError ||
  !divertAncestorText.includes("一并索引") ||
  !divertAncestorText.includes("devkb_search")
) {
  throw new Error(`包含 Paper System 的祖先目录负例失败：${divertAncestorText.slice(0, 800)}`);
}
console.log("  ✅ 包含 Paper System 的祖先目录被分流铁律拒绝（防 semble 连带索引）");
