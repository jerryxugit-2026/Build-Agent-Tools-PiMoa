/**
 * 回包契约 v2 测试（v4 §6；确定性、脱网、脱 key）。
 *
 * 运行：npx tsx test/slim_payload.test.ts
 * 覆盖：
 *   1) 成功小回包：content 全文+meta；structured=SlimMoaPayload（contractVersion=2、
 *      无 proposals[].text 全文、有 textExcerpt/textChars/textSha256）。
 *   2) 成功超预算：content 截头+显式标注+spool 指针；structured.aggregated 同理。
 *   3) spool sha 对账：audit.sha256 === sha256Text(落盘文件)；文件含 proposer 全文。
 *   4) 失败 salvage：spool 正常 → 证据感知摘录（保住行号证据行）+audit 指针。
 *   5) spool 写失败 + 合计 ≤60k → 整份内联 + spool_failed 标注（留住好答案的有界回退）。
 *   6) deliver 成功 → 回执化（含 written path + 头部摘录），spool 只落 proposer。
 */
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoaResult } from "../src/moa/types.js";
import { sha256Text } from "../src/deliver/write.js";
import {
  finishToolResponse,
  toSlimPayload,
  formatSummary,
  truncateAtLine,
  salvageExcerpt,
  enforcePresetModeMatchesTool,
  extractFinalVerdict,
  prependVerdictIfNeeded,
  VERDICT_PREPEND_HEADER,
  CONTRACT_VERSION,
  RESPONSE_CONTENT_BUDGET_CHARS,
  RESPONSE_STRUCT_AGG_BUDGET_CHARS,
  type SlimMoaPayload,
} from "../src/mcp/tools.js";

const SPOOL = mkdtempSync(join(tmpdir(), "pimoa-slim-test-"));
process.env.PIMOA_SPOOL_DIR = SPOOL;

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function mkResult(over: Partial<MoaResult> & { aggregated?: string } = {}): MoaResult {
  const aggregated = over.aggregated ?? "综合最终答案:一切正常。";
  return {
    status: "ok",
    aggregated,
    proposals: [
      {
        model: "deepseek/deepseek-v4-flash",
        ok: true,
        empty: false,
        text: "提议一正文。\nsrc/mcp/tools.ts:123 处有证据。",
        usage: null,
        costUsd: 0,
        durationMs: 10,
        timeout: false,
      },
      {
        model: "minimax/MiniMax-M3",
        ok: true,
        empty: false,
        text: "提议二正文,较短。",
        usage: null,
        costUsd: 0,
        durationMs: 12,
        timeout: false,
      },
    ],
    receipt: {
      mode: "synthesize",
      preset: "default",
      models: ["deepseek/deepseek-v4-flash", "minimax/MiniMax-M3"],
      quorum: "2/2",
      profile: "synthesize-worker",
      proposerMarks: {},
      aggregator: { model: "cliproxy/claude-opus-4-8", usage: null, costUsd: 0, durationMs: 5 },
      bodySha256: sha256Text(aggregated),
      totalCostUsd: 0,
      delivery: null,
    },
    error: null,
    ...over,
  } as MoaResult;
}

// ---- 1) 成功小回包 ----
{
  const r = mkResult();
  const resp = finishToolResponse("moa_run", r, {});
  const sc = resp.structuredContent as unknown as SlimMoaPayload;
  assert(sc.contractVersion === CONTRACT_VERSION, "contractVersion=2");
  assert(sc.aggregated === r.aggregated, "structured.aggregated 小回包全文保留");
  assert(sc.aggregatedMeta.sha256 === r.receipt.bodySha256, "aggregatedMeta.sha256 对上");
  const p0 = sc.proposals[0] as Record<string, unknown>;
  assert(!("text" in p0), "proposals[] 不再携带 text 全文");
  assert(typeof p0.textExcerpt === "string", "proposals[] 有 textExcerpt");
  assert(p0.textChars === r.proposals[0].text.length, "textChars 正确");
  assert(p0.textSha256 === sha256Text(r.proposals[0].text), "textSha256 正确");
  assert(resp.content[0].text.includes("综合最终答案"), "content 含判决全文");
  assert(resp.content[0].text.includes("[moa ok]"), "content 含 meta 行");
  assert(resp.isError === undefined, "ok 不置 isError");
}

// ---- 2+3) 成功超预算 + spool sha 对账 ----
{
  const big = Array.from({ length: 1200 }, (_, i) => `判决第${i}行:细节内容若干若干。`).join("\n");
  const r = mkResult({ aggregated: big });
  const resp = finishToolResponse("moa_run", r, { runId: "t2" });
  const text = resp.content[0].text;
  assert(text.includes("超回包预算"), "content 截断有显式标注");
  assert(text.length < big.length, "content 确实被截");
  const scBig = resp.structuredContent as unknown as SlimMoaPayload;
  assert(scBig.receipt.audit !== undefined, "回包 receipt.audit 已写入");
  assert(r.receipt.audit === undefined, "入参 MoaResult 未被原位污染(F3)");
  const a = scBig.receipt.audit!;
  assert(text.includes(a.path), "标注含 spool 绝对路径");
  const disk = readFileSync(a.path, "utf8");
  assert(sha256Text(disk) === a.sha256, "spool 文件 sha256 与 audit 对账一致");
  assert(disk.includes(big.slice(0, 200)), "spool 含 aggregated 全文开头");
  assert(disk.includes("提议一正文"), "spool 含 proposer 全文");
  assert(scBig.aggregated.includes("超 structuredContent 预算"), "structured.aggregated 截断有标注");
  assert(scBig.aggregatedMeta.chars === big.length, "aggregatedMeta.chars=原文长度");
}

// ---- 4) 失败 salvage:证据感知摘录 ----
{
  const evidence = "src/moa/orchestrate.ts:622 aggPrompt 在此构造";
  const longText =
    "引言部分。\n" +
    Array.from({ length: 300 }, (_, i) => `分析第${i}段,冗长论述填充填充填充。`).join("\n") +
    `\n${evidence}\n` +
    Array.from({ length: 300 }, (_, i) => `后续第${i}段,继续冗长填充。`).join("\n") +
    "\n结论:FAIL。";
  const r = mkResult({
    status: "failed",
    aggregated: "",
    error: { stage: "aggregator", reason: "aggregator 报错" },
  });
  r.receipt.bodySha256 = "";
  r.proposals[0].text = longText;
  const resp = finishToolResponse("moa_verify", r, {});
  const text = resp.content[0].text;
  assert(resp.isError === true, "failed 置 isError");
  assert(text.includes("[moa failed]"), "失败摘要头在");
  assert(text.includes("摘录"), "salvage 走摘录形态");
  assert(text.includes(evidence), "证据行(file:line)被摘录保留");
  assert(!text.includes("分析第250段"), "非证据中段被略去");
  const scF = resp.structuredContent as unknown as SlimMoaPayload;
  assert(scF.receipt.audit && text.includes(scF.receipt.audit.path), "附 spool 全文指针");
  const disk = readFileSync(scF.receipt.audit!.path, "utf8");
  assert(disk.includes("分析第250段"), "spool 里保有完整正文");
}

// ---- 5) spool 写失败 + 合计小 → 整份内联回退 ----
{
  const blocker = join(SPOOL, "not-a-dir");
  writeFileSync(blocker, "x");
  const saved = process.env.PIMOA_SPOOL_DIR;
  process.env.PIMOA_SPOOL_DIR = join(blocker, "sub"); // mkdir 必失败(ENOTDIR)
  const r = mkResult({
    status: "failed",
    aggregated: "",
    error: { stage: "proposer", reason: "proposer x 超时" },
  });
  r.receipt.bodySha256 = "";
  const resp = finishToolResponse("moa_run", r, {});
  const text = resp.content[0].text;
  assert(text.includes("spool 写入失败"), "标注 spool 写入失败");
  assert(text.includes("提议一正文"), "有界回退:整份内联保住好答案");
  const sc = resp.structuredContent as unknown as SlimMoaPayload;
  assert(typeof sc.spoolError === "string", "structured 带 spoolError");
  assert(sc.receipt.audit === undefined, "spool 失败不写 audit");
  assert(sc.proposals.every((p) => p.spoolFailed === true), "各 proposal 挂 spoolFailed 标记(F2)");
  process.env.PIMOA_SPOOL_DIR = saved;
}

// ---- 6) deliver 成功 → 回执化 ----
{
  const body = Array.from({ length: 200 }, (_, i) => `交付正文第${i}行。`).join("\n") + "\nDONE_X";
  const r = mkResult({ aggregated: body });
  r.receipt.bodySha256 = sha256Text(body);
  r.receipt.delivery = { written: true, path: "/tmp/out.md", sha256: sha256Text(body) };
  const resp = finishToolResponse("moa_deliver", r, {});
  const text = resp.content[0].text;
  assert(text.includes("[moa deliver ok] written=/tmp/out.md"), "回执行含交付路径");
  assert(text.includes("交付回执"), "超头部摘录时有回执标注");
  assert(text.length < body.length + 600, "deliver content 不再装全文");
  const scD = resp.structuredContent as unknown as SlimMoaPayload;
  const disk = readFileSync(scD.receipt.audit!.path, "utf8");
  assert(!disk.includes("交付正文第100行"), "deliver spool 不重复落 aggregated");
  assert(disk.includes("提议一正文"), "deliver spool 落 proposer 全文");
}

// ---- 纯函数补充 ----
{
  const t = truncateAtLine("a\n".repeat(100), 50);
  assert(t.truncated && t.kept.endsWith("a"), "truncateAtLine 按行边界截");
  const s = salvageExcerpt("短文本");
  assert(!s.truncated && s.kept === "短文本", "salvageExcerpt 短文本原样");
  // F6:中段唯一证据行超长(>2500)时截取而非丢弃。
  const longEvid =
    "头部说明。\n" +
    "填充。\n".repeat(300) +
    `L123 ${"证".repeat(3000)}\n` +
    "填充。\n".repeat(300) +
    "尾部结论。";
  const e = salvageExcerpt(longEvid);
  assert(e.kept.includes("单行证据超长截取"), "F6:超长证据行被截取保留而非整行丢弃");
  assert(e.kept.includes("L123"), "F6:证据行头部仍在");
}

// ---- F1:moa_run 模式锁硬编码,不随 defaults.preset 漂移 ----
{
  const cfg = {
    presets: { vp: { mode: "verify" } },
  } as unknown as import("../src/config/types.js").MoaConfig;
  const err = enforcePresetModeMatchesTool(cfg, { prompt: "x", preset: "vp" }, "vp", "synthesize");
  assert(
    err !== null && err.status === "failed" && err.error?.stage === "config",
    "F1:即便 defaultPreset 是 verify 模式,moa_run 硬锁 synthesize 仍拒绝",
  );
  const ok = enforcePresetModeMatchesTool(cfg, { prompt: "x", preset: "vp" }, "vp", "verify");
  assert(ok === null, "F1 对照:moa_verify 硬锁 verify 时放行 verify preset");
}

// ---- §8.1 【最终裁决】前置:12k 正文、裁决在尾 → inline 头部含裁决、原文 sha 不变、verdictPrepended=true ----
{
  const verdict = "三、【最终裁决】：BLOCKER 1 项未修，整体 REJECT；须先修 src/x.ts:42 的空指针再复审。";
  const filler = Array.from({ length: 400 }, (_, i) => `二、【逐条裁决】第${i}条 MAJOR | src/a.ts#f${i} | 亲验 | 描述若干若干。`);
  const body =
    "一、【冲突点与采信】\n分歧点A / 甲说X 乙说Y / 采信甲 / 行号证据。\n" +
    filler.join("\n") +
    `\n${verdict}\n`;
  assert(body.length > 12_000, `构造正文 ${body.length} 字符 > 12k`);
  const r = mkResult({ aggregated: body });
  r.receipt.bodySha256 = sha256Text(body);
  const resp = finishToolResponse("moa_verify", r, {});
  const text = resp.content[0].text;
  const sc = resp.structuredContent as unknown as SlimMoaPayload;
  // inline content 头部含裁决(位于原有头截预算之内)。
  const iHdr = text.indexOf(VERDICT_PREPEND_HEADER);
  const iVerdict = text.indexOf(verdict);
  assert(iHdr === 0, "content 以前置说明头开头");
  assert(iVerdict !== -1 && iVerdict < RESPONSE_CONTENT_BUDGET_CHARS, "content 头部(预算内)含【最终裁决】段全文");
  assert(text.includes("超回包预算") && text.includes("头部已前置【最终裁决】段"), "截断标注仍在且注明已前置");
  // structured aggregated 同理。
  assert(sc.verdictPrepended === true, "verdictPrepended === true");
  assert(sc.aggregated.startsWith(VERDICT_PREPEND_HEADER) && sc.aggregated.includes(verdict), "structured.aggregated 头部含裁决");
  assert(sc.aggregated.indexOf(verdict) < RESPONSE_STRUCT_AGG_BUDGET_CHARS, "裁决落在 structured 头截预算内");
  // 对账三件不变:bodySha256 / aggregatedMeta.sha256 / spool 全文。
  assert(sc.aggregatedMeta.sha256 === sha256Text(body), "aggregatedMeta.sha256 仍是原始正文 sha");
  assert(sc.aggregatedMeta.chars === body.length, "aggregatedMeta.chars 仍是原始正文长度");
  assert(sc.receipt.bodySha256 === sha256Text(body), "receipt.bodySha256 不变");
  const disk = readFileSync(sc.receipt.audit!.path, "utf8");
  assert(!disk.includes(VERDICT_PREPEND_HEADER), "spool 全文不含前置段(落的是原始正文)");
  assert(disk.includes(body.slice(0, 120)) && disk.includes(verdict), "spool 含原始正文(顺序未变)");
  // 抽取函数本身。
  assert(extractFinalVerdict(body) === verdict, "extractFinalVerdict 抽出整段(到正文末尾)");
  const mid = "一、A\n【最终裁决】：通过。\n附注一行。\n二、B 多余段\n";
  assert(extractFinalVerdict(mid) === "【最终裁决】：通过。\n附注一行。", "行首【最终裁决】也识别,止于下一「二、」标题");
  assert(extractFinalVerdict("## 三、【最终裁决】\n通过") === "## 三、【最终裁决】\n通过", "markdown # 前缀标题也识别");
}
// ---- §8.1 对照:无标题 → verdictPrepended=false 且输出与改前一致;短正文含标题也不前置 ----
{
  const big = Array.from({ length: 1200 }, (_, i) => `判决第${i}行:细节内容若干若干。`).join("\n");
  assert(extractFinalVerdict(big) === null, "无标题正文 extractFinalVerdict=null");
  const r = mkResult({ aggregated: big });
  const resp = finishToolResponse("moa_run", r, {});
  const sc = resp.structuredContent as unknown as SlimMoaPayload;
  assert(sc.verdictPrepended === false, "无标题 verdictPrepended === false");
  const expectHead = truncateAtLine(big, RESPONSE_STRUCT_AGG_BUDGET_CHARS).kept;
  assert(sc.aggregated.startsWith(expectHead) && !sc.aggregated.includes(VERDICT_PREPEND_HEADER), "无标题时 structured.aggregated 与改前一致(纯头截)");
  assert(resp.content[0].text.startsWith(truncateAtLine(big, RESPONSE_CONTENT_BUDGET_CHARS).kept), "无标题时 content 与改前一致(纯头截)");
  const short = "一、A\n二、B\n三、【最终裁决】：通过。";
  const pv = prependVerdictIfNeeded(short);
  assert(pv.prepended === false && pv.text === short, "短正文(两通道都不截)含标题也不前置——避免重复");
  const sc2 = finishToolResponse("moa_verify", mkResult({ aggregated: short }), {}).structuredContent as unknown as SlimMoaPayload;
  assert(sc2.verdictPrepended === false && sc2.aggregated === short, "短正文 payload 原样、verdictPrepended=false");
}
// ---- §4.1 slim payload:proposals[].trace 紧凑子集 ----
{
  const r = mkResult();
  r.proposals[0].trace = { durationMs: 10, input: 1, output: 2, cacheRead: 0, calls: 2, usedChars: 300, reservedChars: 0, maxCalls: 5, maxChars: 120000, exhaustedBy: null, rejections: 0, lastRejectedBy: null, retries: 0 };
  const sc = finishToolResponse("moa_run", r, {}).structuredContent as unknown as SlimMoaPayload;
  const t0 = sc.proposals[0].trace!;
  assert(t0 && t0.calls === 2 && t0.usedChars === 300 && t0.exhaustedBy === null && t0.rejections === 0 && t0.durationMs === 10, "proposals[0].trace 子集 calls/usedChars/exhaustedBy/rejections/durationMs");
  assert(!("reservedChars" in t0) && !("input" in t0), "slim 子集不带 reservedChars/input 等(回包不撑大)");
  assert(sc.proposals[1].trace === undefined, "无 trace 的 proposal 不挂字段");
  assert(JSON.stringify(t0).includes('"exhaustedBy":null'), "exhaustedBy=null 序列化后字段恒在");
}

// ---- O2 hybrid modern 用例组（2026-09-30）：真回包契约 v2 经 SDK v2 modern 腿（SSE 分帧）送达严格客户端 ----
//   把本文件各形态的**真** finishToolResponse 回包（小/超预算截头/deliver 回执化/失败 salvage）交给一个
//   进程内 v2 服务端（createMcpHandler + toNodeHandler，选项同 server.ts：legacy:"reject"、responseMode:"sse"、
//   8MiB；outputSchema=z.object(moaToolOutput)，与 buildModernServer 同），由官方 client 2.0.0（auto，DSH 同款）取回。
//   验：① ok 形态过客户端按公布 schema 的严格校验（isError 形态客户端按规范跳过校验，改在本地 strict 复核）；
//       ② content 文本与 structuredContent 经 SSE 分帧后逐字不变（sha 对账）——截头标注、spool 指针不被改写。
{
  const { createMcpHandler, McpServer: V2McpServer } = await import("@modelcontextprotocol/server");
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const { createServer } = await import("node:http");
  const { z } = await import("zod");
  const { moaToolOutput } = await import("../src/mcp/tools.js");

  const big = Array.from({ length: 1200 }, (_, i) => `判决第${i}行:细节内容若干若干。`).join("\n");
  const dbody = Array.from({ length: 200 }, (_, i) => `交付正文第${i}行。`).join("\n") + "\nDONE_X";
  const deliverRes = mkResult({ aggregated: dbody });
  deliverRes.receipt.bodySha256 = sha256Text(dbody);
  deliverRes.receipt.delivery = { written: true, path: "/tmp/out.md", sha256: sha256Text(dbody) };
  const failedRes = mkResult({ status: "failed", aggregated: "", error: { stage: "aggregator", reason: "aggregator 报错" } });
  failedRes.receipt.bodySha256 = "";
  const variants: Record<string, ReturnType<typeof finishToolResponse>> = {
    ok_small: finishToolResponse("moa_run", mkResult(), {}),
    ok_over_budget: finishToolResponse("moa_run", mkResult({ aggregated: big }), {}),
    deliver_receipt: finishToolResponse("moa_deliver", deliverRes, {}),
    failed_salvage: finishToolResponse("moa_verify", failedRes, {}),
  };
  const out = z.object(moaToolOutput);
  const handler = createMcpHandler(
    () => {
      const s = new V2McpServer({ name: "o2-slim", version: "0" }, { capabilities: {} });
      for (const [name, resp] of Object.entries(variants)) {
        s.registerTool(name, { inputSchema: z.object({}), outputSchema: out }, async () => resp as never);
      }
      return s;
    },
    { legacy: "reject", responseMode: "sse", maxRequestBodySize: 8 * 1024 * 1024 },
  );
  const node = toNodeHandler(handler, { maxRequestBodySize: 8 * 1024 * 1024 });
  const srv = createServer((req, res) => void node(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const client = new Client({ name: "o2-slim-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert(client.getProtocolEra() === "modern", `O2 前提：client 2.0 auto → modern（${client.getProtocolEra()}）`);
    for (const [name, resp] of Object.entries(variants)) {
      let err: unknown;
      let got: any;
      try {
        got = await client.callTool({ name, arguments: {} });
      } catch (e) {
        err = e;
      }
      assert(!err, `O2 ${name}：严格客户端未拒收（${err ? String((err as Error).message).slice(0, 160) : "ok"}）`);
      const strict = z.object(moaToolOutput).strict().safeParse(got?.structuredContent);
      assert(strict.success, `O2 ${name}：structuredContent 过 strict（isError=${got?.isError === true}）`);
      assert(
        sha256Text(got?.content?.[0]?.text ?? "") === sha256Text(resp.content[0].text) &&
          JSON.stringify(got?.structuredContent) === JSON.stringify(resp.structuredContent),
        `O2 ${name}：content/structuredContent 经 modern SSE 分帧逐字不变（content ${resp.content[0].text.length} 字符）`,
      );
      assert((got?.isError === true) === (resp.isError === true), `O2 ${name}：isError 语义保持（${resp.isError === true}）`);
    }
  } finally {
    await client.close().catch(() => {});
    await handler.close();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const files = readdirSync(SPOOL).filter((f) => f.endsWith(".md"));
assert(files.length >= 3, `spool 目录累计 ${files.length} 份审计文件`);
assert(files.every((f) => /^\d{8}T\d{6}-moa_(run|verify|deliver)-\d+-[a-z0-9]{6}-[a-z0-9]{12}\.md$/.test(f)),
  "spool 文件名符合 <UTC>-<tool>-<pid>-<rand6>-<sha12>.md 且无调用方字符串");

console.log(`\n[slim-payload-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
