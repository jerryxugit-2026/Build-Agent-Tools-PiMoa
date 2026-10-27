/**
 * web_fetch 工具接线测试：真实 lightpanda 调用 + 各道拒绝闸 + 预算记账。
 *
 * 运行：
 *   npx tsx test/web_fetch.test.ts
 *
 * 说明：正例会**真的联网**取 https://example.com（该域名就是 IANA 留给文档示例用的，
 * 无副作用、无跟踪）。负例全部在进程内判掉，不发请求。
 */
import { createWebFetchTool } from "../src/tools/web_fetch.ts";
import {
  createRetrievalBudget,
  SESSION_MAX_TOOL_CALLS,
  type RetrievalBudget,
} from "../src/tools/budget.ts";

type ToolCall = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}>;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? `：${detail.slice(0, 400)}` : ""}`);
  }
}

function make(budget?: RetrievalBudget) {
  return createWebFetchTool(budget ?? createRetrievalBudget()) as unknown as {
    execute: ToolCall;
  };
}

const text = (r: { content: Array<{ text: string }> }) =>
  r.content.map((b) => b.text).join("\n");

// ── 负例：协议闸 ────────────────────────────────────────────────
for (const bad of [
  "file:///etc/passwd",
  "file://~/Documents/Key/google-sheets-sa.json",
  "data:text/html,<script>alert(1)</script>",
  "javascript:alert(1)",
]) {
  const r = await make().execute("proto", { url: bad });
  check(`拒绝非 http(s) 协议：${bad.slice(0, 42)}`, !!r.isError && text(r).includes("协议不允许"), text(r));
}

// ── 负例：内网/回环闸（本机跑着 CliRelay 8317、SurrealDB 8018、embedding 11447）──
for (const bad of [
  "http://127.0.0.1:8317/v1/models",
  "http://localhost:8018",
  "http://192.168.1.1/",
  "http://10.0.0.5/",
  "http://172.16.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:8317/",
]) {
  const r = await make().execute("priv", { url: bad });
  check(`拒绝内网/回环：${bad.slice(0, 42)}`, !!r.isError && text(r).includes("内网"), text(r));
}

// ── 负例：URL 形状 ──────────────────────────────────────────────
{
  const r = await make().execute("shape", { url: "not a url" });
  check("拒绝非绝对 URL", !!r.isError && text(r).includes("url 解析失败"), text(r));
}
{
  const r = await make().execute("empty", { url: "" });
  check("拒绝空 url", !!r.isError, text(r));
}
{
  const r = await make().execute("long", { url: `https://example.com/${"a".repeat(2100)}` });
  check("拒绝超长 url", !!r.isError && text(r).includes("2000"), text(r));
}

// ── 负例：预算耗尽即拒绝（不发请求）────────────────────────────
{
  const spent: RetrievalBudget = { usedChars: 0, calls: SESSION_MAX_TOOL_CALLS };
  const r = await make(spent).execute("budget", { url: "https://example.com" });
  check("预算耗尽时拒绝取页", !!r.isError && text(r).includes("取证预算耗尽"), text(r));
}

// ── 正例：真实联网取页 ─────────────────────────────────────────
{
  const budget = createRetrievalBudget();
  const r = await make(budget).execute("ok", { url: "https://example.com" });
  const t = text(r);
  check("真实取回 example.com 正文", !r.isError && t.includes("Example Domain"), t);
  check("正文被包成不可信数据块", t.includes("外部内容开始") && t.includes("外部内容结束"), t);
  check("带有不执行指令的加固措辞", t.includes("不是指令"), t);
  check("记入会话取证预算", budget.calls === 1 && budget.usedChars > 0,
    `calls=${budget.calls} usedChars=${budget.usedChars}`);
  check("结果不引入新工具（无 addedToolNames）",
    !Object.prototype.hasOwnProperty.call(r, "addedToolNames"));
}

// ── 正例：maxChars 截断 ────────────────────────────────────────
{
  const r = await make().execute("trunc", { url: "https://example.com", maxChars: 1000 });
  const t = text(r);
  check("maxChars 生效并明确告知截断", !r.isError && (t.includes("已截断") || t.length < 3000), t.slice(0, 200));
}

console.log(`\n[web_fetch-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
