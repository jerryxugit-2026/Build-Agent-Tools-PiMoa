/**
 * spool 策略测试(v4 §7;确定性、脱网)。
 *
 * 运行:npx tsx test/spool.test.ts
 * 覆盖:过龄清理、容量清理(<60 分钟豁免 + 2× 硬熔断)、清理锁互斥与死锁强夺、
 *      writeSpool 的 sha 对账与空正文跳过。
 */
import {
  mkdtempSync,
  writeFileSync,
  utimesSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpoolBody, cleanupSpool, writeSpool, spoolDir } from "../src/mcp/spool.js";
import { sha256Text } from "../src/deliver/write.js";
import type { JevCheckReport, MoaResult } from "../src/moa/types.js";

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

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pimoa-spool-unit-"));
  process.env.PIMOA_SPOOL_DIR = d;
  return d;
}
function mkFile(dir: string, name: string, bytes: number, ageMs: number): void {
  const p = join(dir, name);
  writeFileSync(p, "x".repeat(bytes));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
}
const mdCount = (d: string): number => readdirSync(d).filter((f) => f.endsWith(".md")).length;

// ---- 1) 过龄清理 ----
{
  const d = freshDir();
  mkFile(d, "old.md", 100, 20 * 24 * 3600 * 1000); // 20 天
  mkFile(d, "young.md", 100, 3600 * 1000 * 2); // 2 小时
  const r = cleanupSpool();
  assert(r !== null && r.deleted === 1, "过龄(>14 天)删 1 份");
  assert(mdCount(d) === 1, "年轻文件保留");
}

// ---- 2) 容量清理:删最旧 + 60 分钟豁免 ----
{
  const d = freshDir();
  process.env.PIMOA_SPOOL_MAX_BYTES = "1000";
  mkFile(d, "a-oldest.md", 600, 5 * 3600 * 1000);
  mkFile(d, "b-old.md", 600, 3 * 3600 * 1000);
  mkFile(d, "c-fresh.md", 600, 10 * 1000); // 豁免窗口内
  const r = cleanupSpool();
  assert(r !== null, "拿到锁");
  // 删 a(剩 1200 仍超)再删 b(剩 600 ≤1000)止;豁免的 c 保留。
  assert(
    mdCount(d) === 1 && readdirSync(d).includes("c-fresh.md"),
    "超额按最旧逐删至达标,豁免文件保留",
  );
  delete process.env.PIMOA_SPOOL_MAX_BYTES;
}

// ---- 3) 2× 硬熔断:全新文件也删 ----
{
  const d = freshDir();
  process.env.PIMOA_SPOOL_MAX_BYTES = "1000";
  for (let i = 0; i < 5; i++) mkFile(d, `f${i}.md`, 600, 10 * 1000); // 3000 > 2×1000
  cleanupSpool();
  const total = readdirSync(d)
    .filter((f) => f.endsWith(".md"))
    .reduce((s, f) => s + statSync(join(d, f)).size, 0);
  assert(total <= 1000, `硬熔断后总量 ${total} ≤ 上限(无视豁免)`);
  delete process.env.PIMOA_SPOOL_MAX_BYTES;
}

// ---- 4) 清理锁:新锁互斥,死锁强夺 ----
{
  const d = freshDir();
  mkFile(d, "victim.md", 100, 20 * 24 * 3600 * 1000);
  writeFileSync(join(d, ".cleanup.lock"), "other 0");
  assert(cleanupSpool() === null, "新鲜锁在 → 跳过(返回 null)");
  assert(mdCount(d) === 1, "跳过时不删文件");
  const t = (Date.now() - 11 * 60 * 1000) / 1000; // 锁龄 11 分钟 > 10 分钟
  utimesSync(join(d, ".cleanup.lock"), t, t);
  const r = cleanupSpool();
  assert(r !== null && r.deleted === 1, "死锁(>10 分钟)被 rename 强夺后清理执行");
  assert(!readdirSync(d).includes(".cleanup.lock"), "清理后自身锁已释放");
}

// ---- 5) writeSpool:sha 对账 + 空正文跳过 + 目录来自 env ----
{
  const d = freshDir();
  const r: MoaResult = {
    status: "ok",
    aggregated: "答案正文",
    proposals: [
      { model: "m/a", ok: true, empty: false, text: "提议全文甲", usage: null, costUsd: 0, durationMs: 1, timeout: false },
    ],
    receipt: {
      mode: "synthesize", preset: "default", models: ["m/a"], quorum: "1/1", profile: "p",
      proposerMarks: {}, aggregator: { model: "agg/x", usage: null, costUsd: 0, durationMs: 1 },
      bodySha256: sha256Text("答案正文"), totalCostUsd: 0, delivery: null,
    },
    error: null,
  };
  const w = writeSpool({ tool: "moa_run", result: r, includeAggregated: true });
  assert(!!w.audit && w.audit.path.startsWith(d), "落在 env 指定目录(spoolDir 生效)");
  assert(spoolDir() === d, "spoolDir 读 env");
  const disk = readFileSync(w.audit!.path, "utf8");
  assert(sha256Text(disk) === w.audit!.sha256, "audit.sha256 与文件对账一致");
  assert(disk.includes("提议全文甲") && disk.includes("答案正文"), "文件含聚合与提议全文");
  const empty = writeSpool({
    tool: "moa_run",
    result: { ...r, aggregated: "", proposals: [] },
    includeAggregated: true,
  });
  assert(!empty.audit && !empty.error, "无正文(如 config 失败)不落空文件");
}

// ---- 6) §4.1 取证账:段头之后另起一行 [trace],段头字符串不变 ----
{
  const d = freshDir();
  const trace = {
    durationMs: 1234, input: 1000, output: 200, cacheRead: 800,
    calls: 3, usedChars: 45678, reservedChars: 0, maxCalls: 5, maxChars: 240000,
    exhaustedBy: null, rejections: 0, lastRejectedBy: null, retries: 0,
  };
  const r: MoaResult = {
    status: "ok",
    aggregated: "答案正文",
    proposals: [
      { model: "m/a", ok: true, empty: false, text: "提议全文甲", usage: null, costUsd: 0, durationMs: 1234, timeout: false, trace },
      { model: "m/b", ok: true, empty: false, text: "提议全文乙", usage: null, costUsd: 0, durationMs: 1, timeout: false },
    ],
    receipt: {
      mode: "verify", preset: "moa_verify", models: ["m/a", "m/b"], quorum: "2/2", profile: "verify-worker",
      proposerMarks: {}, aggregator: { model: "agg/x", usage: null, costUsd: 0, durationMs: 1,
        trace: { calls: 1, usedChars: 10, reservedChars: 0, maxCalls: 5, maxChars: 240000, exhaustedBy: "calls", rejections: 1, lastRejectedBy: "calls", retries: 1 } },
      bodySha256: sha256Text("答案正文"), totalCostUsd: 0, delivery: null,
    },
    error: null,
  };
  const w = writeSpool({ tool: "moa_verify", result: r, includeAggregated: true });
  const disk = readFileSync(w.audit!.path, "utf8");
  assert(disk.startsWith("## receipt") || disk.includes("## receipt"), "落在 " + d);
  const header = "----- proposer m/a (completed) -----";
  const iHead = disk.indexOf(header);
  const iTrace = disk.indexOf("[trace] ");
  const iText = disk.indexOf("提议全文甲");
  assert(iHead !== -1, "段头字符串原样保留(解析脚本锚点不变)");
  assert(iTrace !== -1 && iTrace > iHead && iTrace < iText, "[trace] 行位于段头之后、正文之前");
  const line = disk.slice(iTrace, disk.indexOf("\n", iTrace));
  assert(disk.slice(iHead + header.length, iTrace).trim() === "", "段头与 [trace] 之间只有换行(另起一行)");
  const keys = ["durationMs", "input", "output", "cacheRead", "calls", "usedChars", "reservedChars", "exhaustedBy", "rejections", "lastRejectedBy", "retries", "maxCalls", "maxChars"];
  assert(keys.every((k) => new RegExp(`\\b${k}=`).test(line)), `[trace] 字段齐全:${keys.join(",")}`);
  assert(line.includes("durationMs=1234") && line.includes("calls=3") && line.includes("usedChars=45678"), "[trace] 数值正确");
  assert(line.includes("exhaustedBy=null") && line.includes("rejections=0") && line.includes("lastRejectedBy=null") && line.includes("retries=0"), "缺省口径:exhaustedBy 未耗尽=null、rejections=0、lastRejectedBy=null、retries 可数=0");
  assert(line.includes("cacheRead=800"), "cacheRead 落盘");
  // 无 trace 的 proposal(旧 fixture)不写 [trace] 行,段头照旧。
  const iHeadB = disk.indexOf("----- proposer m/b (completed) -----");
  const afterB = disk.slice(iHeadB);
  assert(iHeadB !== -1 && !afterB.includes("[trace]"), "无 trace 的 proposer 段不写 [trace] 行");
  // 聚合器 trace 随 receipt JSON 落盘(不另加行)。
  assert(disk.includes('"exhaustedBy": "calls"') && disk.includes('"retries": 1'), "聚合器 trace 随 receipt JSON 落盘");
  assert(sha256Text(disk) === w.audit!.sha256, "加 [trace] 行后 audit.sha256 仍与文件对账一致");
}


// ============================================================================
// Jev 辅助代码审查 v4 §3.7：spool 三节（波三 b 新增，接在既有 spool 清理/对账用例之后）
// ============================================================================

function log(...a: unknown[]): void {
  console.log("[spool-test]", ...a);
}

function sha256(text: string): string {
  return sha256Text(text);
}

/** 含 1 finding + 1 verdict + jevcheckFull 的最小合法 MoaResult（其余字段给最保守占位）。 */
function makeFullResult(): MoaResult {
  // 单行、不含内嵌换行：下方按「header 行的下一行」精确提取 spool 里的 aggregated 正文时更直接。
  const aggregated = "聚合正文示例：一、【冲突点与采信】／无分歧";
  const bodySha256 = sha256(aggregated);
  const finding = {
    id: "F1",
    kind: "finding" as const,
    level: "MAJOR" as const,
    path: "foo.ts",
    lines: "1",
    anchor: "占位锚点",
    facts: ["通用事实：占位事实"],
    claim: "占位缺陷描述",
    fix_expect: "占位修复期望",
    strength: "推理" as const,
    pid: "P1/F1",
    proposerIndex: 0,
    proposerModel: "minimax/MiniMax-M3",
  };
  const verdict = {
    finding_ids: ["P1/F1"],
    level: "MAJOR" as const,
    can_happen: "能" as const,
    consequence: "静默失败" as const,
    trigger: "常态触发" as const,
    strength: "推理" as const,
    reason: "示例裁决理由占位十字以上",
    evidence: "foo.ts:1",
  };
  const jevcheckFull: JevCheckReport = {
    enabled: true,
    perFinding: {
      "P1/F1": {
        pid: "P1/F1",
        ref: "OK",
        facts: [],
        entail: { p1: 0.9 },
        status: "前提完备且全部相符",
        conditionFlag: false,
        calls: [{ q: "fact", p: 0.9, stateSha256: "x".repeat(64), inputTokens: 20, ms: 5 }],
      },
    },
    duplicates: [],
    conflicts: [],
    oneSided: [],
    proposerQuality: { P1: { findings: 1, refMismatch: 0, factsLow: 0, rejects: 0, conditionRate: 0 } },
    totals: { calls: 1, inputTokens: 20, ms: 5, tableChars: 10, truncated: false, throttled: 0 },
    tableText: "【核对表 P1/F1 ｜ minimax/MiniMax-M3 ｜ MAJOR ｜ foo.ts:1 ｜ 合成状态：前提完备且全部相符】",
  };
  return {
    status: "ok",
    aggregated,
    proposals: [
      {
        model: "minimax/MiniMax-M3",
        ok: true,
        empty: false,
        text: "审查正文-MiniMax-M3",
        usage: null,
        costUsd: 0,
        durationMs: 1,
        timeout: false,
      },
    ],
    receipt: {
      mode: "verify",
      preset: "jev_verify",
      models: ["minimax/MiniMax-M3"],
      quorum: "1/1",
      profile: "verify-worker",
      proposerMarks: { "0:minimax/MiniMax-M3": "completed" },
      aggregator: { model: "cliproxy/gpt-5.6-luna", usage: null, costUsd: 0, durationMs: 1 },
      bodySha256,
      totalCostUsd: 0,
      delivery: null,
      findings: [finding],
      jevcheck: {
        enabled: true,
        perFinding: { "P1/F1": { pid: "P1/F1", ref: "OK", facts: [], entail: { p1: 0.9 }, status: "前提完备且全部相符", conditionFlag: false } },
        duplicates: [],
        conflicts: [],
        oneSided: [],
        proposerQuality: jevcheckFull.proposerQuality,
        totals: jevcheckFull.totals,
      },
      verdicts: { verdicts: [verdict], final: "示例最终裁决占位二十字以上占位二十字", attempts: 1 },
    },
    error: null,
    jevcheckFull,
    structuredRejectsFull: { "1:minimax/MiniMax-M3": ["REJECT（第 1/3 次）：\n- F1：第 2 条代码事实没有行号"] },
  };
}

/** 空态：无 findings/jevcheck/verdicts 数据（旧行为，未开 jevcheck 的 synthesize/verify 轮）。 */
function makeEmptyJevResult(): MoaResult {
  const aggregated = "普通聚合正文，未涉及 Jev 辅助代码审查。";
  return {
    status: "ok",
    aggregated,
    proposals: [
      { model: "minimax/MiniMax-M3", ok: true, empty: false, text: "提议正文", usage: null, costUsd: 0, durationMs: 1, timeout: false },
    ],
    receipt: {
      mode: "synthesize",
      preset: "default",
      models: ["minimax/MiniMax-M3"],
      quorum: "1/1",
      profile: "synthesize-worker",
      proposerMarks: { "0:minimax/MiniMax-M3": "completed" },
      aggregator: { model: "cliproxy/gpt-5.6-luna", usage: null, costUsd: 0, durationMs: 1 },
      bodySha256: sha256(aggregated),
      totalCostUsd: 0,
      delivery: null,
      // findings / jevcheck / verdicts 皆缺省。
    },
    error: null,
    // jevcheckFull 缺省。
  };
}

// ---------- 用例 1：三节存在 + 顺序 + aggregated sha256 对账 ----------
{
  log("=== 用例 1：`## findings`/`## jevcheck`/`## verdicts` 三节存在、顺序在 `## aggregated` 之后 `----- proposer` 之前 ===");
  const r = makeFullResult();
  const body = buildSpoolBody(r, true);

  assert(body.includes("## findings\n"), "`## findings` 节存在");
  assert(body.includes("## jevcheck\n"), "`## jevcheck` 节存在");
  assert(body.includes("## verdicts\n"), "`## verdicts` 节存在");

  const idxAggregated = body.indexOf("## aggregated");
  const idxFindings = body.indexOf("## findings");
  const idxJevcheck = body.indexOf("## jevcheck");
  const idxVerdicts = body.indexOf("## verdicts");
  const idxProposer = body.indexOf("----- proposer");
  log(`idx: aggregated=${idxAggregated} findings=${idxFindings} jevcheck=${idxJevcheck} verdicts=${idxVerdicts} proposer=${idxProposer}`);
  assert(idxAggregated >= 0 && idxProposer >= 0, "`## aggregated` 与 `----- proposer` 两个锚点均存在");
  assert(idxAggregated < idxFindings, "`## findings` 在 `## aggregated` 之后");
  assert(idxFindings < idxJevcheck, "`## jevcheck` 在 `## findings` 之后");
  assert(idxJevcheck < idxVerdicts, "`## verdicts` 在 `## jevcheck` 之后");
  assert(idxVerdicts < idxProposer, "`## verdicts` 在 `----- proposer` 之前");

  // `## aggregated` 正文 sha256 == receipt.bodySha256（设计 v4 §3.7 对账不变量）。
  // buildSpoolBody 把 r.aggregated 原样单独一行写在 header 之后（header 字符串自带尾随 "\n"，
  // 再经 parts.join("\n") 又插一个换行分隔符，故 header 与正文之间会多出一个空行——跳过它）。
  const lines = body.split("\n");
  const aggHeaderIdx = lines.findIndex((l) => l.startsWith("## aggregated"));
  const aggLine = lines[aggHeaderIdx + 1] === "" ? (lines[aggHeaderIdx + 2] ?? "") : (lines[aggHeaderIdx + 1] ?? "");
  assert(aggLine === r.aggregated, `spool 里 aggregated 正文与 r.aggregated 逐字节一致（实际首行 ${JSON.stringify(aggLine.slice(0, 40))}）`);
  assert(sha256(aggLine) === r.receipt.bodySha256, `spool 里 aggregated 正文的 sha256 与 receipt.bodySha256 对账（${sha256(aggLine)} vs ${r.receipt.bodySha256}）`);

  // 三节内容基本正确性（JSON 可解析、含关键字段）——不是本用例主线，顺带核一下不是空壳。
  assert(body.includes('"pid": "P1/F1"'), "`## findings` 节含 finding 的 pid");
  assert(body.includes(r.jevcheckFull!.tableText), "`## jevcheck` 节含 tableText 原文");
  assert(body.includes('"final"'), "`## verdicts` 节含 final 字段");
  const rj = body.indexOf("## structured rejects");
  assert(rj > body.indexOf("## findings") && rj < body.indexOf("## jevcheck") && body.includes("----- 1:minimax/MiniMax-M3 第 1 次记录（REJECT / PARTIAL）-----") && body.includes("F1：第 2 条代码事实没有行号"), "`## structured rejects` 节在 findings 与 jevcheck 之间、含每次 REJECT 原文");
}

// ---------- 用例 2：空态——无 findings/jevcheck/verdicts 数据时三节全缺 ----------
{
  log("=== 用例 2：空态（未开 jevcheck 的旧行为）——`## findings`/`## jevcheck`/`## verdicts` 三节全缺 ===");
  const r = makeEmptyJevResult();
  const body = buildSpoolBody(r, true);
  assert(!body.includes("## findings"), "`## findings` 节缺席");
  assert(!body.includes("## jevcheck"), "`## jevcheck` 节缺席");
  assert(!body.includes("## verdicts"), "`## verdicts` 节缺席");
  // 旧行为（receipt + aggregated + proposer 全文）不受影响。
  assert(body.includes("## receipt"), "`## receipt` 节仍在");
  assert(body.includes("## aggregated"), "`## aggregated` 节仍在（includeAggregated=true）");
  assert(body.includes("----- proposer"), "proposer 全文节仍在");
}


// ---------- 用例 3：`## structured rejects` 节含聚合器一路（待办 8 + 补漏 1 降级两跳） ----------
{
  log("=== 用例 3：`## structured rejects` 节渲染 aggregator: 一路（proposer 在前、聚合器在后，逐条编号；降级时主备两跳各一段）===");
  const base = makeFullResult();
  const r: MoaResult = {
    ...base,
    structuredRejectsFull: {
      "0:minimax/MiniMax-M3": ["REJECT（第 1/3 次）：\n- F1：proposer 侧原文（不得改动）"],
      "aggregator:cliproxy/gpt-5.6-luna": [
        "REJECT（第 1/3 次）：\n- 第 1 条裁决：路径解析不到本轮附入材料",
        "REJECT（第 2/3 次）：\n- 以下 finding 未被任何裁决覆盖：P1/F1",
      ],
      // ★补漏 1：降级时主跳与备胎两跳各一个 key（key 名带中文括号，仍走同一通用遍历）。
      "aggregator(主):cliproxy/gpt-5.6-luna": ["REJECT（第 1/3 次）：\n- 主跳拒收原文"],
      "aggregator(备胎):cliproxy/gpt-5.6-terra": ["REJECT（第 2/3 次）：\n- 备胎拒收原文"],
    },
  };
  const body = buildSpoolBody(r, true);

  // 通用遍历（spool.ts 不改）：每个 key 一段，逐条 `----- <key> 第 N 次记录（REJECT / PARTIAL）-----` + 原文。
  assert(
    body.includes("----- aggregator:cliproxy/gpt-5.6-luna 第 1 次记录（REJECT / PARTIAL）-----"),
    "aggregator 一路第 1 条段头按通用格式渲染",
  );
  assert(
    body.includes("----- aggregator:cliproxy/gpt-5.6-luna 第 2 次记录（REJECT / PARTIAL）-----"),
    "aggregator 一路第 2 条段头按通用格式渲染（序号连续）",
  );
  assert(
    body.includes("- 第 1 条裁决：路径解析不到本轮附入材料") && body.includes("- 以下 finding 未被任何裁决覆盖：P1/F1"),
    "aggregator 一路的 REJECT 原文逐条落版（不截断）",
  );
  // 顺序：proposer 的数字前缀 key 在前，aggregator key 在后（与 Object.entries 的插入顺序一致）。
  const iProp = body.indexOf("----- 0:minimax/MiniMax-M3 第 1 次记录");
  const iAgg = body.indexOf("----- aggregator:cliproxy/gpt-5.6-luna 第 1 次记录");
  assert(iProp >= 0 && iAgg >= 0 && iProp < iAgg, `proposer 一路在前、aggregator 一路在后（idx ${iProp} < ${iAgg}）`);
  assert(body.includes("- F1：proposer 侧原文（不得改动）"), "proposer 一路原文不受影响");
  // ★补漏 1：降级时两个 key 各一段，主跳在前、备胎在后（与采集顺序一致），原文不截断。
  assert(
    body.includes("----- aggregator(主):cliproxy/gpt-5.6-luna 第 1 次记录（REJECT / PARTIAL）-----") &&
      body.includes("----- aggregator(备胎):cliproxy/gpt-5.6-terra 第 1 次记录（REJECT / PARTIAL）-----"),
    "降级两跳的 key（aggregator(主) / aggregator(备胎)）按同一格式渲染",
  );
  assert(
    body.indexOf("----- aggregator(主):cliproxy/gpt-5.6-luna 第 1 次记录") <
      body.indexOf("----- aggregator(备胎):cliproxy/gpt-5.6-terra 第 1 次记录") &&
      body.includes("- 主跳拒收原文") &&
      body.includes("- 备胎拒收原文"),
    "主跳段在前、备胎段在后，两段原文都落版",
  );
  // 仍在 `## findings` 与 `## jevcheck` 之间（节位置不变）。
  assert(
    body.indexOf("## structured rejects") > body.indexOf("## findings") &&
      body.indexOf("## structured rejects") < body.indexOf("## jevcheck"),
    "`## structured rejects` 节位置不变",
  );
}

console.log(`\n[spool-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
