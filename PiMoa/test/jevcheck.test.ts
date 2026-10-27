/**
 * jevcheck 模块单测（Jev 辅助代码审查详细设计 v4 §3.5，第二波验收）。
 *
 * 运行：
 *   npx tsx test/jevcheck.test.ts                 # 只跑 mock/本地 HTTP 用例（脱网、脱 key）
 *   JEV_SMOKE=1 npx tsx test/jevcheck.test.ts      # 额外对真 8760 跑一次 10 条事实 smoke
 *
 * 覆盖：statusFact 分档边界；locateFact 四条路径；functionBodyAround Go/TS/sh 各一例与失败回落；
 *       checkFinding 四态合成 + 条件红旗；dedupe 同文件预筛与跨 proposer 限制；counter 配对进冲突；
 *       oneSided 区间重叠 ±10；renderCheckTable 无数字断言 + 超限裁剪顺序；预算超限保留已完成步骤
 *       并写 skipped；JevUnavailable → enabled=false 且 skipped 有原因；限流重试计数；
 *       多键合并请求的解析（真 JevClient + 本地 HTTP mock server）。
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FactCheck, FindingCheck, JevCall, MaterialFile, MaterialMap } from "../src/moa/types.js";
import {
  checkFinding,
  dedupeAndConflicts,
  factStatusFromP,
  findingRegionState,
  findingTruthMaterial,
  functionBodyAround,
  JevClient,
  JevRpcError,
  JevUnavailable,
  locateFact,
  oneSided,
  premiseRound,
  QUESTIONS,
  renderCheckTable,
  runJevCheck,
  synthesizeStatus,
  type FindingRecord,
  type JevAskResult,
  type JevClientLike,
  type RunSessionFn,
} from "../src/moa/jevcheck.js";
import { ConfigError, JEVCHECK_DEFAULTS, loadConfig } from "../src/config/load.js";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as Client2, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { Client as Sdk129Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer as Sdk129McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport as Sdk129ServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { JevcheckCfg } from "../src/config/types.js";
import type { SessionRunResult } from "../src/moa/session.js";
import { conditionFactCount, isAnomalous } from "../src/tools/submit_verdicts.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

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
function log(...a: unknown[]): void {
  console.log("[jevcheck-test]", ...a);
}

// ---------- 材料 fixture（不读盘）----------
function seg(abs: string, rel: string, kind: MaterialFile["kind"], start: number, lines: string[]): MaterialFile {
  return { abs, rel, kind, lines, start, end: start + lines.length - 1 };
}

const ABS_GO = "/repo/internal/x/ratchet.go";
const ABS_TS = "/repo/src/handler.ts";
const ABS_SH = "/repo/scripts/deploy.sh";
const ABS_MD = "/repo/docs/spec.md";

const GO_LINES = [
  "package x",
  "",
  "func (r *Ratchet) Check(origin Origin) error {",
  '\tif origin.Layer != "management_proof_missing" || origin.Kind == "" {',
  "\t\treturn nil",
  "\t}",
  "\tcmd := svcIdentityMatches(origin.Command)",
  "\tif cmd == nil {",
  '\t\treturn fmt.Errorf("no command")',
  "\t}",
  "\tr.count++",
  "\treturn r.apply(cmd)",
  "}",
  "",
];
const TS_LINES = [
  "export const config = {};",
  "",
  "export async function loadUser(id: string): Promise<User> {",
  "  const row = await db.get(id);",
  "  if (!row) {",
  "    throw new Error('not found');",
  "  }",
  "  return row;",
  "}",
];
const SH_LINES = [
  "#!/usr/bin/env bash",
  "",
  "deploy() {",
  '  echo "deploying $1"',
  "  rsync -av ./dist/ \"$1\":/srv/app/",
  "}",
  "",
  'deploy "$1"',
];
const MD_LINES = [
  "# 设计",
  "",
  "## 2. 事实核对",
  "系统必须在提交前核验行号。",
  "第二段细节。",
  "",
  "## 3. 补前提",
  "补前提独立于 proposer 会话。",
];
// TS 函数体缺闭合 } —— 用来测 functionBodyAround 失败回落。
const TS_UNBALANCED = ["export function broken(x: number) {", "  if (x > 0) {", "    return x;", "  // 缺右花括号，向下配平不到"];

function makeMaterials(): MaterialMap {
  const m: MaterialMap = new Map();
  m.set(ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", "range", 1, GO_LINES)]);
  m.set(ABS_TS, [seg(ABS_TS, "src/handler.ts", "range", 1, TS_LINES)]);
  m.set(ABS_SH, [seg(ABS_SH, "scripts/deploy.sh", "range", 1, SH_LINES)]);
  m.set(ABS_MD, [seg(ABS_MD, "docs/spec.md", "file", 1, MD_LINES)]);
  return m;
}
const materials = makeMaterials();
const docs = [...materials.get(ABS_MD)!];

function cfgWith(over: Partial<JevcheckCfg> = {}): JevcheckCfg {
  return { ...JEVCHECK_DEFAULTS, enabled: true, ...over };
}

function mkFinding(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id: "F1",
    kind: "finding",
    level: "MAJOR",
    path: "internal/x/ratchet.go",
    lines: "4-5",
    anchor: "management_proof_missing",
    facts: [
      "ratchet.go 第 4 行只在 Layer 等于 management_proof_missing 且 Kind 非空时继续",
      "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
    ],
    claim: "Kind 为空时直接放行，缺少来源校验的 origin 会被当作合法",
    fix_expect: "Kind 为空时应返回错误而不是 nil",
    strength: "亲验",
    pid: "P1/F1",
    proposerIndex: 0,
    proposerModel: "deepseek/deepseek-v4-flash",
    ...over,
  };
}

// ---------- mock JevClient：按 state/instructions 内容返回预设 P ----------
class MockJevClient implements JevClientLike {
  calls = 0;
  /** rule(state, key, instructions) => p | null；第一条命中的规则生效。 */
  constructor(private readonly rules: Array<(state: string, key: string, instructions: string) => number | null | undefined>) {}
  async ask(
    state: string,
    questions: Record<string, { q: import("../src/moa/types.js").JevCall["q"]; instructions: string; criteria: { true: string; false: string } }>,
    n: number,
  ): Promise<JevAskResult> {
    this.calls++;
    const results: JevAskResult["results"] = {};
    const calls: JevAskResult["calls"] = [];
    for (const [key, q] of Object.entries(questions)) {
      let p: number | null = null;
      for (const rule of this.rules) {
        const v = rule(state, key, q.instructions);
        if (v !== undefined) {
          p = v;
          break;
        }
      }
      results[key] = { p };
      if (p !== null) {
        for (let i = 0; i < Math.max(1, n); i++) {
          calls.push({ q: q.q, p, stateSha256: "mock", inputTokens: 10, ms: 1 });
        }
      }
    }
    return { results, calls };
  }
  async noul(kind: import("../src/moa/types.js").JevCall["q"], state: string, n: number): Promise<{ p: number | null; calls: JevAskResult["calls"] }> {
    const r = await this.ask(state, { q: { q: kind, ...QUESTIONS[kind] } }, n);
    return { p: r.results.q?.p ?? null, calls: r.calls };
  }
}

// ============================================================================
// 用例 1：factStatusFromP 分档边界
// ============================================================================
{
  log("=== 用例 1：factStatusFromP 分档边界（high=0.8, low=0.2）===");
  const th = { high: 0.8, low: 0.2 };
  assert(factStatusFromP(0.8, th) === "相符", "p=high 边界 → 相符");
  assert(factStatusFromP(0.81, th) === "相符", "p>high → 相符");
  assert(factStatusFromP(0.2, th) === "不符", "p=low 边界 → 不符");
  assert(factStatusFromP(0.19, th) === "不符", "p<low → 不符");
  assert(factStatusFromP(0.5, th) === "待核", "low<p<high → 待核");
  assert(factStatusFromP(null, th) === "待核", "p=null（未答/无法定位）→ 待核");
}

// ============================================================================
// 用例 2：locateFact 四条路径
// ============================================================================
{
  log("=== 用例 2：locateFact 四条定位路径 ===");
  const f = mkFinding();

  // GO_LINES 共 14 行、TS_LINES 共 9 行：±15 会越界，locateFact 按段界裁剪（Math.max/min）。
  const loc1 = locateFact("ratchet.go 第 4 行判 Layer 与 Kind", f, materials, docs);
  assert(loc1?.abs === ABS_GO && loc1.a === 1 && loc1.b === 14, `① 文件名+行号 → ratchet.go 第 4 行 ±15，裁到段界 1-14：${JSON.stringify(loc1)}`);
  const loc1b = locateFact("handler.ts 第 4-6 行读取用户", f, materials, docs);
  assert(loc1b?.abs === ABS_TS && loc1b.a === 1 && loc1b.b === 9, `① 文件名+行区间 → handler.ts 第 4-6 行 ±15，裁到段界 1-9：${JSON.stringify(loc1b)}`);

  const loc2 = locateFact("通用事实：第 2 节所述行号核验规则适用于全部提交", f, materials, docs);
  assert(loc2?.abs === ABS_MD && loc2.a === 3 && loc2.b === 6, `② 第 X 节 → 「## 2. 事实核对」到下一同级标题前（第 3-6 行）：${JSON.stringify(loc2)}`);
  const loc2b = locateFact("参见 §3 的说明", f, materials, docs);
  assert(loc2b?.abs === ABS_MD && loc2b.a === 7, `② §X 写法同样命中「## 3. 补前提」：${JSON.stringify(loc2b)}`);

  // MD_LINES 共 8 行：3+15=18 越界，裁到段尾 8。
  const loc3 = locateFact("设计文档第 3 行有明确规定", f, materials, docs);
  assert(loc3?.abs === ABS_MD && loc3.a === 1 && loc3.b === 8, `③ (设计|文档|方案)…第 N 行 → 主文档该行 ±15，裁到段界 1-8：${JSON.stringify(loc3)}`);

  const loc4 = locateFact("通用事实：Go 的 || 短路求值，左侧为真时不计算右侧", f, materials, docs);
  assert(loc4?.abs === ABS_GO && loc4.a === 3 && loc4.b === 13, `④ 无引用 → 退回 finding 所在函数体（Check 函数 3-13 行）：${JSON.stringify(loc4)}`);

  const loc4b = locateFact("通用事实：无法定位到任何函数体的孤立陈述", mkFinding({ path: "src/handler.ts", lines: "1-1" }), materials, docs);
  assert(loc4b?.abs === ABS_TS && loc4b.a === 1 && loc4b.b === 9, `④ 函数体定位失败（第 1 行是 const，非函数）→ 退回 finding lines ±25，裁到段尾 9：${JSON.stringify(loc4b)}`);

  assert(locateFact("无任何引用的孤立陈述", mkFinding({ path: "nope.go" }), materials, docs) === null, "path 不在材料里 → null");
}

// ============================================================================
// 用例 3：functionBodyAround（Go / TS / sh 各一 + 失败回落）
// ============================================================================
{
  log("=== 用例 3：functionBodyAround ===");
  const goSeg = materials.get(ABS_GO)![0]!;
  const goBody = functionBodyAround(goSeg, 4);
  assert(goBody?.a === 3 && goBody.b === 13, `Go：func (r *Ratchet) Check(...) { 到顶格 } → 3-13：${JSON.stringify(goBody)}`);

  const tsSeg = materials.get(ABS_TS)![0]!;
  const tsBody = functionBodyAround(tsSeg, 4);
  assert(tsBody?.a === 3 && tsBody.b === 9, `TS：export async function loadUser(...) { 到 } → 3-9：${JSON.stringify(tsBody)}`);

  const shSeg = materials.get(ABS_SH)![0]!;
  const shBody = functionBodyAround(shSeg, 4);
  assert(shBody?.a === 3 && shBody.b === 6, `sh：deploy() { 到 } → 3-6：${JSON.stringify(shBody)}`);

  const brokenSeg = seg("/repo/broken.ts", "broken.ts", "range", 1, TS_UNBALANCED);
  assert(functionBodyAround(brokenSeg, 3) === null, "大括号到段末仍未配平 → null（失败）");
  assert(functionBodyAround(goSeg, 1) === null, "向上找不到函数起始行（第 1 行是 package 声明）→ null");
}

// ============================================================================
// 用例 4：checkFinding 四态合成 + 条件红旗
// ============================================================================
{
  log("=== 用例 4：checkFinding 四态合成 ===");
  const cfg = cfgWith();

  // 4a：前提完备且全部相符（facts 全 0.9、entail 0.9、无条件事实）
  {
    const client = new MockJevClient([(_s, key) => (key.startsWith("f") ? 0.9 : key === "entail" || key === "q" ? undefined : undefined)]);
    // 更直接：按 instructions 分流——entail 问法 instructions 固定含「仅凭上述前提即可推出」
    const client2 = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined),
    ]);
    void client;
    const fc = await checkFinding({ f: mkFinding(), materials, docs, client: client2, cfg });
    assert(fc.status === "前提完备且全部相符", `全部相符 + entail 高 → 前提完备且全部相符（实际 ${fc.status}）`);
    assert(fc.conditionFlag === false, "无运行时条件 → conditionFlag=false");
    assert(fc.ref === "OK", "anchor 命中 → ref=OK");
  }

  // 4b：含不符前提（某条 fact 判不符，优先级最高）
  {
    let n = 0;
    const client = new MockJevClient([
      (_s, _k, instr) => {
        if (instr.includes("待核对的事实")) {
          n++;
          return n === 1 ? 0.1 : 0.9; // 第一条事实不符
        }
        if (instr.includes("仅凭上述前提")) return 0.9; // entail 本身很高
        return undefined;
      },
    ]);
    const fc = await checkFinding({ f: mkFinding(), materials, docs, client, cfg });
    assert(fc.status === "含不符前提", `事实不符即使 entail 高也判「含不符前提」（实际 ${fc.status}）`);
  }

  // 4c：前提不足（facts 都相符，但 entail 低）
  {
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.3 : undefined),
    ]);
    const fc = await checkFinding({ f: mkFinding(), materials, docs, client, cfg });
    assert(fc.status === "前提不足", `facts 全相符但 entail<阈值 → 前提不足（实际 ${fc.status}）`);
    assert(fc.entail.p1 === 0.3, `entail.p1 记录 Jev 均值：${fc.entail.p1}`);
  }

  // 4d：条件性成立（含运行时条件事实，其余相符，entail 高）
  {
    const fWithCond = mkFinding({
      facts: [
        "ratchet.go 第 4 行只在 Layer 等于 management_proof_missing 且 Kind 非空时继续",
        "运行时条件：origin.Command 取自该无关进程的命令行",
        "运行时条件：调用方未做额外的来源校验",
      ],
    });
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined),
    ]);
    const fc = await checkFinding({ f: fWithCond, materials, docs, client, cfg });
    assert(fc.status === "条件性成立", `含运行时条件 + 其余相符 + entail 高 → 条件性成立（实际 ${fc.status}）`);
    assert(fc.conditionFlag === true, "2 条运行时条件（≥ JEVCHECK_CONDITION_FLAG_MIN=2）→ 条件红旗=true");
    const condFacts = fc.facts.filter((x) => x.kind === "condition");
    assert(condFacts.length === 2 && condFacts.every((x) => x.status === "条件" && x.p === null), "运行时条件类事实不送 Jev（p=null，status=条件）");
  }

  // 4e：单条运行时条件（<阈值、占比<50%）不触发条件红旗，但仍算「条件性成立」
  {
    const fWithOneCond = mkFinding({
      facts: [
        "ratchet.go 第 4 行只在 Layer 等于 management_proof_missing 且 Kind 非空时继续",
        "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
        "通用事实：错误处理应显式返回 error",
        "运行时条件：origin.Command 取自该无关进程的命令行",
      ],
    });
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined),
    ]);
    const fc = await checkFinding({ f: fWithOneCond, materials, docs, client, cfg });
    assert(fc.status === "条件性成立", "1 条运行时条件仍归「条件性成立」（合成状态看是否含条件，不看红旗阈值）");
    assert(fc.conditionFlag === false, "1/4=25%<50% 且条数<2 → 条件红旗=false");
  }
}

// ============================================================================
// 用例 5：dedupe 同文件预筛 + 跨 proposer 限制 + counter 配对
// ============================================================================
{
  log("=== 用例 5：dedupeAndConflicts ===");
  const cfg = cfgWith();

  // 5a：同 proposer 内的两条 finding 不跑 same（E7 裁决）
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
    const b = mkFinding({ id: "F2", pid: "P1/F2", proposerIndex: 0, claim: "另一种说法但其实同一处" });
    const client = new MockJevClient([() => 0.95]);
    const { duplicates } = await dedupeAndConflicts([a, b], materials, client, cfg);
    assert(duplicates.length === 0 && client.calls === 0, "同一 proposer 内的对不发起任何 Jev 调用（跨 proposer 限制）");
  }

  // 5b：不同 abs 的对不比（同文件预筛）
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go" });
    const b = mkFinding({ id: "F1", pid: "P2/F1", proposerIndex: 1, path: "src/handler.ts" });
    const client = new MockJevClient([() => 0.95]);
    const { duplicates, conflicts } = await dedupeAndConflicts([a, b], materials, client, cfg);
    assert(duplicates.length === 0 && conflicts.length === 0 && client.calls === 0, "不同 abs 的对（不同文件）预筛掉，不发起调用");
  }

  // 5c：跨 proposer、同文件 → same 高 → 合并；same 高 + opposite 高 → 冲突
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go", claim: "Kind 为空时放行" });
    const b = mkFinding({ id: "G1", pid: "P2/G1", proposerIndex: 1, path: "internal/x/ratchet.go", claim: "Kind 为空是设计意图，不算缺陷" });
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("同一个问题") ? 0.95 : instr.includes("相反或明显不一致") ? 0.9 : undefined),
    ]);
    const { duplicates, conflicts } = await dedupeAndConflicts([a, b], materials, client, cfg);
    assert(duplicates.length === 1 && duplicates[0]!.status === "同一问题", `same≥merge(0.8) → 记「同一问题」：${JSON.stringify(duplicates)}`);
    assert(conflicts.length === 1 && conflicts[0]!.pSame === 0.95 && conflicts[0]!.pOpposite === 0.9 && conflicts[0]!.viaCounter === false, `same≥sameMin 后再问 opposite≥oppositeMin → 记入 conflicts：${JSON.stringify(conflicts)}`);
  }

  // 5d：疑似重复（same 在 [flag, merge) 区间）
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go" });
    const b = mkFinding({ id: "G1", pid: "P2/G1", proposerIndex: 1, path: "internal/x/ratchet.go", claim: "措辞不同的类似说法" });
    const client = new MockJevClient([(_s, _k, instr) => (instr.includes("同一个问题") ? 0.5 : instr.includes("相反或明显不一致") ? 0.1 : undefined)]);
    const { duplicates, conflicts } = await dedupeAndConflicts([a, b], materials, client, cfg);
    assert(duplicates.length === 1 && duplicates[0]!.status === "疑似重复", `same∈[flag 0.4, merge 0.8) → 「疑似重复」：${JSON.stringify(duplicates)}`);
    assert(conflicts.length === 0, "same<sameMin(0.6) 不再问 opposite");
  }

  // 5e：counter 条目与对方同位置 finding 直接配对问 opposite（不问 same），命中进冲突
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go", lines: "4-5" });
    const c = mkFinding({
      id: "C1",
      pid: "P2/C1",
      proposerIndex: 1,
      kind: "counter",
      level: "COUNTER",
      path: "internal/x/ratchet.go",
      lines: "4-6",
      claim: "该处不存在此问题，Kind 为空是合法输入",
    });
    let sameAsked = false;
    const client = new MockJevClient([
      (_s, _k, instr) => {
        if (instr.includes("同一个问题")) {
          sameAsked = true;
          return 0.9;
        }
        if (instr.includes("相反或明显不一致")) return 0.85;
        return undefined;
      },
    ]);
    const { conflicts } = await dedupeAndConflicts([a, c], materials, client, cfg);
    assert(!sameAsked, "counter 与同位置 finding 配对不问 same");
    assert(conflicts.length === 1 && conflicts[0]!.viaCounter === true && conflicts[0]!.pSame === 1, `counter 配对直接问 opposite，命中记 viaCounter=true、pSame=1：${JSON.stringify(conflicts)}`);
  }

  // 5f：counter 与不同位置的 finding 不配对（行区间不重叠 ±10）
  {
    const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go", lines: "4-5" });
    const c = mkFinding({
      id: "C1",
      pid: "P2/C1",
      proposerIndex: 1,
      kind: "counter",
      level: "COUNTER",
      path: "internal/x/ratchet.go",
      lines: "20-21",
      claim: "该处不存在此问题",
    });
    const client = new MockJevClient([() => 0.9]);
    const { conflicts } = await dedupeAndConflicts([a, c], materials, client, cfg);
    assert(conflicts.length === 0 && client.calls === 0, "counter 与远处（超出 ±10）finding 不配对，不发起调用");
  }
}

// ============================================================================
// 用例 6：oneSided 区间重叠 ±10
// ============================================================================
{
  log("=== 用例 6：oneSided ===");
  const a = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, path: "internal/x/ratchet.go", lines: "4-5" });
  const bNear = mkFinding({ id: "G1", pid: "P2/G1", proposerIndex: 1, path: "internal/x/ratchet.go", lines: "14-14" }); // 4-5 与 14 相距 9 ≤10 → 重叠
  const cFar = mkFinding({ id: "H1", pid: "P3/H1", proposerIndex: 2, path: "internal/x/ratchet.go", lines: "30-30" }); // 相距 25 → 不重叠 → 单边

  const r1 = oneSided([a, bNear], materials, { duplicates: [], conflicts: [] });
  assert(r1.length === 0, "±10 内视为同位置 → 双方都不是单边");

  const r2 = oneSided([a, cFar], materials, { duplicates: [], conflicts: [] });
  assert(r2.length === 2 && r2.some((o) => o.id === "P1/F1") && r2.some((o) => o.id === "P3/H1"), `远处不重叠 → 双方各自单边：${JSON.stringify(r2)}`);

  const r3 = oneSided([a, cFar], materials, { duplicates: [{ a: "P1/F1", b: "P3/H1", p: 0.9, status: "同一问题" }], conflicts: [] });
  assert(r3.length === 0, "已在 duplicates 里配对过的 pid 不再算单边（即便行不重叠）");
}

// ============================================================================
// 用例 7：renderCheckTable 无数字断言 + 超限裁剪顺序
// ============================================================================
{
  log("=== 用例 7：renderCheckTable ===");
  const cfg = cfgWith();
  const f1 = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const f2 = mkFinding({ id: "F2", pid: "P2/F2", proposerIndex: 1, level: "MINOR" });
  const clientAllGood = new MockJevClient([(_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined)]);
  const clientBad = new MockJevClient([
    (_s, _k, instr) => {
      if (instr.includes("待核对的事实")) return 0.1; // 不符
      if (instr.includes("仅凭上述前提")) return 0.9;
      return undefined;
    },
  ]);
  const fc1 = await checkFinding({ f: f1, materials, docs, client: clientAllGood, cfg });
  const fc2 = await checkFinding({ f: f2, materials, docs, client: clientBad, cfg });
  const report = { perFinding: { [f1.pid]: fc1, [f2.pid]: fc2 }, duplicates: [], conflicts: [], oneSided: [] };

  const { text, truncated } = renderCheckTable(report, [f1, f2], materials, 100_000);
  assert(!truncated, "预算充足 → 不截断");
  assert(!/P\(成立\)/.test(text) && !/0\.\d/.test(text.replace(/F\d/g, "")), `核对表只用状态词，不含 P(成立) 或裸小数概率（去掉 F1/F2 编号后检查）：${text.includes("0.9") ? "含疑似数字" : "干净"}`);
  assert(text.includes("含不符前提") && text.includes("前提完备且全部相符"), "两条 finding 的合成状态词都出现在表中");
  assert(text.startsWith("===== 核对表"), "表头逐字节固定");

  // 超限裁剪顺序：正常条目先降为一行摘要，异常条目（fc2 含不符前提）不从硬截断收场。
  // 预算从「全量文本长度的一半」起向上机械搜索，取第一个「确实超限、且未落到硬截断」的预算：
  // 2026-09-21 派生标记（须填：…）让一行摘要变长，原来的「一半」恰好落到硬截断边界（会截掉状态词）；
  // 改为按本用例的原意选预算，断言口径不变。
  let budget1 = Math.floor(text.length / 2);
  let tinyText = "";
  let tinyTruncated = false;
  for (let b = budget1; b <= text.length; b++) {
    const r = renderCheckTable(report, [f1, f2], materials, b);
    if (r.truncated && !r.text.includes("…（核对表超限，已截断）")) {
      budget1 = b;
      tinyText = r.text;
      tinyTruncated = r.truncated;
      break;
    }
  }
  assert(tinyTruncated, `预算 ${budget1} 字符（全量 ${text.length} 字符）→ 判定超限`);
  assert(tinyText.includes("含不符前提"), `裁剪后异常条目（含不符前提）的状态词仍可见：${tinyText}`);
  const f1FullMarkers = (tinyText.match(/事实：F1/g) ?? []).length;
  assert(f1FullMarkers === 0, `正常条目 F1（前提完备且全部相符）优先降级为一行摘要，不再出现全量的「事实：F1…」：${tinyText}`);
  assert(tinyText.includes(`F1 MAJOR`) && tinyText.includes("合成状态：前提完备且全部相符"), `F1 仍以一行摘要形式出现：${tinyText}`);

  // 极限预算：连异常条目也要降级 / 硬截断
  const { text: microText, truncated: microTruncated } = renderCheckTable(report, [f1, f2], materials, 60);
  assert(microTruncated && microText.length <= 60 + 30, `极限预算下硬截断且不过度超限（实际 ${microText.length} 字符）：${microText}`);
}

// ============================================================================
// 用例 8：runJevCheck —— 预算超限保留已完成、JevUnavailable→enabled=false
// ============================================================================
{
  log("=== 用例 8：runJevCheck 预算/不可用路径 ===");
  const cfg = cfgWith({ budget: { maxCalls: 1, maxMs: 90_000, tableMaxChars: 40_000 } });
  const findings = [
    mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 }),
    mkFinding({ id: "F2", pid: "P1/F2", proposerIndex: 0, lines: "7-8", anchor: "no command" }),
    mkFinding({ id: "F3", pid: "P1/F3", proposerIndex: 0, lines: "10-11", anchor: "r.count++" }),
  ];
  const client = new MockJevClient([(_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined)]);
  const noopRunSession = async (): Promise<SessionRunResult> => ({
    text: "",
    usage: null,
    costUsd: 0,
    durationMs: 1,
    timedOut: false,
    aborted: false,
    sawAgentEnd: true,
  });
  const report = await runJevCheck({
    findings,
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    client,
  });
  assert(report.enabled === true, "预算超限属「未跑到」，不是「不可用」→ enabled 仍 true");
  assert(typeof report.skipped === "string" && report.skipped.includes("预算或时限耗尽"), `report.skipped 写明原因：${report.skipped}`);
  const doneCount = Object.values(report.perFinding).filter((fc) => fc.status !== "未核").length;
  const uncheckedCount = Object.values(report.perFinding).filter((fc) => fc.status === "未核").length;
  assert(doneCount >= 1 && uncheckedCount >= 1, `已完成的 finding 保留真实状态、未跑到的记「未核」（done=${doneCount}, unchecked=${uncheckedCount}）`);
  assert(Object.keys(report.perFinding).length === 3, "全部 3 条 finding 都在 perFinding 里（含未跑到的）");

  // JevUnavailable → enabled=false
  const alwaysUnavailable: JevClientLike = {
    async ask() {
      throw new JevUnavailable("模拟连续失败");
    },
    async noul() {
      throw new JevUnavailable("模拟连续失败");
    },
  };
  const report2 = await runJevCheck({
    findings: [findings[0]!],
    materials,
    cfg: cfgWith(),
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    client: alwaysUnavailable,
  });
  assert(report2.enabled === false, "JevUnavailable 冒泡 → 整份报告 enabled=false（fail-open）");
  assert(typeof report2.skipped === "string" && report2.skipped.includes("Jev 不可用"), `skipped 写明「Jev 不可用」及原因：${report2.skipped}`);

  // enabled=false 配置：直接跳过，不发起任何调用
  const report3 = await runJevCheck({
    findings,
    materials,
    cfg: { ...cfg, enabled: false },
    workers: [],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    client,
  });
  assert(report3.enabled === false && report3.skipped === "jevcheck.enabled=false", "cfg.enabled=false → 直接跳过");
}

// ============================================================================
// 用例 9：premiseRound —— 补前提短会话（mock runSessionFn 写 amend_facts）
// ============================================================================
{
  log("=== 用例 9：premiseRound ===");
  const cfg = cfgWith();
  const f = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const perFinding = {
    [f.pid]: {
      pid: f.pid,
      ref: "OK" as const,
      facts: f.facts.map((t) => ({ text: t, kind: "code" as const, p: 0.9, status: "相符" as const })),
      entail: { p1: 0.1 },
      status: "前提不足" as const,
      conditionFlag: false,
      calls: [],
    },
  };
  const client = new MockJevClient([(_s, _k, instr) => (instr.includes("待核对的事实") ? 0.85 : instr.includes("仅凭上述前提") ? 0.9 : undefined)]);
  // mock runSessionFn：调用 amend_facts 补一条事实（通过 opts.extraTools 里的工具直接执行）。
  const mockRunSession: import("../src/moa/jevcheck.js").RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute("call-1", { id: "F1", facts: ["ratchet.go 第 7 行 cmd 为 nil 时直接返回错误"] } as never, undefined as never, undefined as never, { cwd: "/repo" } as never);
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true, structured: { accepted: true, count: 1, attempts: 1 } };
  };
  const results = await premiseRound({
    findings: [f],
    perFinding,
    materials,
    docs,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client,
  });
  const r = results.get(f.pid);
  assert(r !== undefined && r.added.length === 1 && r.added[0]!.status === "相符", `补充事实核对：${JSON.stringify(r)}`);
  assert(r?.entailP2 === 0.9, `补前提后重算 entail.p2：${r?.entailP2}`);

  // maxFindings 截断：3 条候选、maxFindings=1，只处理 p1 最小的那条
  const f2 = mkFinding({ id: "F2", pid: "P1/F2", proposerIndex: 0 });
  const f3 = mkFinding({ id: "F3", pid: "P1/F3", proposerIndex: 0 });
  const perFinding2 = {
    [f.pid]: { ...perFinding[f.pid]!, entail: { p1: 0.4 } },
    [f2.pid]: { ...perFinding[f.pid]!, pid: f2.pid, entail: { p1: 0.05 } },
    [f3.pid]: { ...perFinding[f.pid]!, pid: f3.pid, entail: { p1: 0.3 } },
  };
  let calledFor: string[] = [];
  const trackingRunSession: import("../src/moa/jevcheck.js").RunSessionFn = async (_mr, _worker, prompt) => {
    const m = /系统核对：你之前提交的 (\S+) 的/.exec(prompt);
    if (m) calledFor.push(m[1]!);
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  await premiseRound({
    findings: [f, f2, f3],
    perFinding: perFinding2,
    materials,
    docs,
    cfg: cfgWith({ premiseRound: { enabled: true, maxFindings: 1, concurrency: 4, perCallMs: 30_000 } }),
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: trackingRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client,
  });
  assert(calledFor.length === 1 && calledFor[0] === f2.pid, `maxFindings=1 → 只处理 p1 最小（0.05）的 ${f2.pid}（实际 ${JSON.stringify(calledFor)}）`);
}

// ============================================================================
// 用例 10：JevClient 真实协议（本地 HTTP mock server）—— 限流重试计数 + 多键合并解析
// ============================================================================
/** 官方 client 2.0 的 modern 协议代版本号（与 src/moa/jevcheck.ts 的 JEV_MODERN_PROTOCOL_VERSION 同值）。 */
const JEV_MODERN = "2026-07-28";
type JevRpcReq = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: {
    arguments?: { state?: string; questions?: Record<string, unknown> };
    _meta?: { progressToken?: string | number };
    protocolVersion?: string;
  };
};
interface JevTestServer {
  url: string;
  stats: {
    discover: number;
    initialize: number;
    toolCalls: number;
    /** 每个 tools/call 的协议头：modern 走 mcp-protocol-version=2026-07-28 且无会话；legacy 带 Mcp-Session-Id。 */
    toolCallHeaders: Array<{ protocolVersion?: string; sessionId?: string }>;
  };
  /** 作废全部 legacy 会话（模拟 Jev 重启）：此后带旧 Mcp-Session-Id 的请求回 404。 */
  expireSessions(): void;
  close(): Promise<void>;
}
/**
 * 本地 Jev MCP 测试服务端，按官方 client 2.0 的握手实测行为实现两个协议代：
 *  · era=legacy（缺省，与真实 8760 同代）：server/discover 回 -32601 → 客户端回落 initialize（回 Mcp-Session-Id）；
 *  · era=modern：discover 回 complete（supportedVersions=[2026-07-28]），initialize 回 -32601（modern-only）；
 *  · era=both：两者都支持。
 * 无 id 的通知回 202，GET/DELETE 回 405（不开独立 SSE 流）。请求判定为 modern 的依据：请求头
 * mcp-protocol-version=2026-07-28 且不带会话。tools/call 交给 onToolCall 直接写 res（原始应答/挂起/分段进度由用例定）。
 * handshakeDelayMs：discover/initialize 延迟应答（并发懒连接只握手一次的用例用）；failInitialize：前 N 次 initialize 回 HTTP 500。
 */
async function startJevTestServer(opts: {
  era?: "legacy" | "modern" | "both";
  onToolCall: (p: JevRpcReq, res: ServerResponse, modern: boolean) => void;
  handshakeDelayMs?: number;
  failInitialize?: number;
}): Promise<JevTestServer> {
  const era = opts.era ?? "legacy";
  const stats: JevTestServer["stats"] = { discover: 0, initialize: 0, toolCalls: 0, toolCallHeaders: [] };
  const live = new Set<string>();
  let sessionSeq = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      let p: JevRpcReq = {};
      try {
        p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* 忽略畸形请求体 */
      }
      const sid = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      const pv = typeof req.headers["mcp-protocol-version"] === "string" ? req.headers["mcp-protocol-version"] : undefined;
      const json = (o: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(o));
      };
      const notFound = (): void => json({ jsonrpc: "2.0", id: p.id, error: { code: -32601, message: "Method not found" } });
      const later = (fn: () => void): void => {
        if (opts.handshakeDelayMs) setTimeout(fn, opts.handshakeDelayMs);
        else fn();
      };
      if (sid !== undefined && !live.has(sid)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: p.id ?? null, error: { code: -32001, message: "Session not found" } }));
        return;
      }
      if (p.method === "server/discover") {
        stats.discover++;
        later(() =>
          era === "legacy"
            ? notFound()
            : json({
                jsonrpc: "2.0",
                id: p.id,
                result: {
                  resultType: "complete",
                  supportedVersions: [JEV_MODERN],
                  capabilities: { tools: {} },
                  serverInfo: { name: "jev-test", version: "1" },
                  ttlMs: 0,
                  cacheScope: "private",
                },
              }),
        );
        return;
      }
      if (p.method === "initialize") {
        stats.initialize++;
        later(() => {
          if (era === "modern") return notFound();
          if ((opts.failInitialize ?? 0) >= stats.initialize) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("initialize boom");
            return;
          }
          const s = `sess-${++sessionSeq}`;
          live.add(s);
          json(
            {
              jsonrpc: "2.0",
              id: p.id,
              result: { protocolVersion: p.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "jev-test", version: "1" } },
            },
            { "Mcp-Session-Id": s },
          );
        });
        return;
      }
      if (p.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (p.method === "tools/call") {
        stats.toolCalls++;
        stats.toolCallHeaders.push({ protocolVersion: pv, sessionId: sid });
        opts.onToolCall(p, res, pv === JEV_MODERN && sid === undefined);
        return;
      }
      notFound();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    stats,
    expireSessions: () => live.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
/** tools/call 成功帧：modern 协议代的结果带 resultType=complete（官方 client 2.0 要求）。 */
function toolFrame(p: JevRpcReq, modern: boolean, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: p.id, result: modern ? { ...result, resultType: "complete" } : result });
}
async function startMockJevServer(
  handler: (payload: JevRpcReq) => { text: string; isError?: boolean },
  era: "legacy" | "modern" | "both" = "legacy",
): Promise<JevTestServer> {
  return startJevTestServer({
    era,
    onToolCall: (p, res, modern) => {
      const { text, isError } = handler(p);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${toolFrame(p, modern, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) })}\n\n`);
    },
  });
}

{
  log("=== 用例 10a：限流重试计数（真 JevClient + 本地 mock server）===");
  JevClient.resetForTest();
  let n = 0;
  const { url, close } = await startMockJevServer(() => {
    n++;
    if (n <= 2) return { text: "jev 在飞请求已达上限 8", isError: true };
    return { text: "【q】P(成立)=0.91 [用量] 输入 100 token" };
  });
  const client = JevClient.shared({ url, concurrency: 8, perCallTimeoutMs: 5000 });
  const r = await client.noul("fact", "## 代码\nfoo", 1);
  assert(r.p === 0.91, `前两次限流退避重试后第三次成功拿到 p=0.91（实际 ${r.p}）`);
  assert(client.throttledCount === 2, `throttledCount=2（实际 ${client.throttledCount}）`);
  await close();
  JevClient.resetForTest();
}

{
  log("=== 用例 10b：多键合并请求的解析（真 JevClient + 本地 mock server）===");
  JevClient.resetForTest();
  const { url, close } = await startMockJevServer((payload) => {
    const keys = Object.keys(payload.params?.arguments?.questions ?? {});
    const text = keys.map((k, i) => `【${k}】P(成立)=${(0.2 + i * 0.3).toFixed(2)} [用量] 输入 50 token`).join(" ");
    return { text };
  });
  const client = JevClient.shared({ url, concurrency: 8, perCallTimeoutMs: 5000 });
  const r = await client.ask(
    "## 代码\nfoo",
    {
      f0: { q: "fact", instructions: "事实 A", criteria: { true: "相符", false: "不符" } },
      f1: { q: "fact", instructions: "事实 B", criteria: { true: "相符", false: "不符" } },
    },
    1,
  );
  assert(Math.abs((r.results.f0?.p ?? -1) - 0.2) < 1e-9, `f0 解析出 0.2（实际 ${r.results.f0?.p}）`);
  assert(Math.abs((r.results.f1?.p ?? -1) - 0.5) < 1e-9, `f1 解析出 0.5（实际 ${r.results.f1?.p}）`);
  assert(r.calls.length === 2, `一次网络往返产出两个键各一条 JevCall（实际 ${r.calls.length}）`);
  // 波二修复单 12：一次网络往返只有一份 inputTokens/ms，只记在该轮第一个解析成功的键上，
  // 其余键记 0——不然 totals.inputTokens/ms 会按键数虚高。
  assert(
    r.calls[0]?.inputTokens === 50 && r.calls[0]?.ms >= 0,
    `该轮第一个解析成功的键（f0）记录真实 inputTokens/ms（实际 ${JSON.stringify(r.calls[0])}）`,
  );
  assert(
    r.calls[1]?.inputTokens === 0 && r.calls[1]?.ms === 0,
    `同一轮网络往返的第二个键（f1）不重复计 inputTokens/ms，记 0（实际 ${JSON.stringify(r.calls[1])}）`,
  );
  await close();
  JevClient.resetForTest();
}

{
  log("=== 用例 10c：连续 HTTP 5xx 3 次 → JevUnavailable ===");
  JevClient.resetForTest();
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const client = JevClient.shared({ url: `http://127.0.0.1:${addr.port}/mcp`, concurrency: 8, perCallTimeoutMs: 2000 });
  let threw: unknown;
  try {
    await client.noul("fact", "state", 3);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof JevUnavailable, `连续 3 次 HTTP 500 → 抛 JevUnavailable（实际 ${threw instanceof Error ? threw.constructor.name : String(threw)}）`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  JevClient.resetForTest();
}

// ============================================================================
// 波二修复单（18 条必修）新增用例：用例 11 起
// ============================================================================

async function noopRunSession(): Promise<SessionRunResult> {
  return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
}

// ----------------------------------------------------------------------------
// 用例 11：locateFact 路径① 找不到包含 lo/hi 的段 → null；checkFinding 记「待核」（修复单 1）
// ----------------------------------------------------------------------------
{
  log("=== 用例 11：locateFact 找不到包含行号的段 → null，不退回路径④核别人的事实（修复单 1）===");
  const factOutOfRange = "ratchet.go 第 99 行 有描述（该文件只到 14 行）";
  const loc = locateFact(factOutOfRange, mkFinding(), materials, docs);
  assert(loc === null, `行号 99 不在 ratchet.go 任何已附入段内 → null（实际 ${JSON.stringify(loc)}）`);

  const fOut = mkFinding({ facts: [factOutOfRange] });
  const client = new MockJevClient([(_s, _k, instr) => (instr.includes("仅凭上述前提") ? 0.9 : undefined)]);
  const fc = await checkFinding({ f: fOut, materials, docs, client, cfg: cfgWith() });
  assert(fc.facts[0]!.status === "待核" && fc.facts[0]!.p === null, `定位失败的事实：p=null、status=待核（实际 ${JSON.stringify(fc.facts[0])}）`);
  assert(fc.status === "含待核前提", `entail 高但含「待核」事实 → 合成「含待核前提」（实际 ${fc.status}）`);
}

// ----------------------------------------------------------------------------
// 用例 12：locateFact 路径① 同名文件两处的候选消歧（修复单 3）
// ----------------------------------------------------------------------------
{
  log("=== 用例 12：locateFact 同名文件两处 —— 优先 f.path，其次全 rel，都不确定 → null（修复单 3）===");
  const ABS_AX = "/repo/a/x.ts";
  const ABS_BX = "/repo/b/x.ts";
  const XT_LINES = ["export const v = 1;", "export const w = 2;", "export const y = 3;", "export const z = 4;", "export const done = true;"];
  const materialsXY: MaterialMap = new Map(materials);
  materialsXY.set(ABS_AX, [seg(ABS_AX, "a/x.ts", "range", 1, XT_LINES)]);
  materialsXY.set(ABS_BX, [seg(ABS_BX, "b/x.ts", "range", 1, XT_LINES)]);

  const locByPath = locateFact("x.ts 第 2 行的常量声明", mkFinding({ path: "a/x.ts" }), materialsXY, []);
  assert(locByPath?.abs === ABS_AX, `候选多于一个（都靠 basename「x.ts」命中）→ 优先 f.path 所指文件（实际 ${JSON.stringify(locByPath)}）`);

  const locByRel = locateFact("b/x.ts 第 2 行的常量声明", mkFinding({ path: "c/other.ts" }), materialsXY, []);
  assert(locByRel?.abs === ABS_BX, `f.path 不匹配任一候选 → 取事实文本里完整出现的 rel 路径（实际 ${JSON.stringify(locByRel)}）`);

  const locAmbiguous = locateFact("x.ts 第 2 行的常量声明", mkFinding({ path: "c/other.ts" }), materialsXY, []);
  assert(locAmbiguous === null, `f.path 不匹配、事实里也没写全 rel → 无法唯一确定 → null（实际 ${JSON.stringify(locAmbiguous)}）`);
}

// ----------------------------------------------------------------------------
// 用例 13：locateFact 路径① 去扩展名短名不再匹配（修复单 3）
// ----------------------------------------------------------------------------
{
  log("=== 用例 13：去扩展名短名不再匹配（事实含「load」不命中 load.ts，修复单 3）===");
  const ABS_LOAD = "/repo/load.ts";
  const LOAD_LINES = ["export function load(id: string) {", "  return db.find(id);", "}"];
  const materialsLoad: MaterialMap = new Map(materials);
  materialsLoad.set(ABS_LOAD, [seg(ABS_LOAD, "load.ts", "range", 1, LOAD_LINES)]);

  const fact = "load 相关处理缺少错误检查，第 3 行";
  const loc = locateFact(fact, mkFinding({ path: "internal/x/ratchet.go", lines: "4-5" }), materialsLoad, []);
  assert(
    loc?.abs === ABS_GO,
    `事实含裸词「load」不应命中 load.ts；退回路径④落在 finding 自己的文件 ratchet.go（实际 ${JSON.stringify(loc)}）`,
  );
}

// ----------------------------------------------------------------------------
// 用例 14：synthesizeStatus 五态优先级（修复单 2）——「含待核前提」+ 补前提回灌后同规则
// ----------------------------------------------------------------------------
{
  log("=== 用例 14：synthesizeStatus 五态优先级（含不符前提 ＞ 前提不足 ＞ 含待核前提 ＞ 条件性成立 ＞ 前提完备，修复单 2）===");
  const cfg = cfgWith();
  const factsAllGood: FactCheck[] = [{ text: "a", kind: "code", p: 0.9, status: "相符" }];
  const factsWithPending: FactCheck[] = [...factsAllGood, { text: "b 第 1 行", kind: "code", p: null, status: "待核" }];
  const factsWithBad: FactCheck[] = [...factsWithPending, { text: "c", kind: "code", p: 0.1, status: "不符" }];
  const factsWithCond: FactCheck[] = [...factsAllGood, { text: "运行时条件：d", kind: "condition", p: null, status: "条件" }];

  assert(synthesizeStatus(factsAllGood, 0.9, false, cfg) === "前提完备且全部相符", "全相符 + entail 高 + 无条件 → 前提完备且全部相符");
  assert(
    synthesizeStatus(factsWithPending, 0.9, false, cfg) === "含待核前提",
    "待核事实 + entail 高(0.9) → 含待核前提（不因 entail 高就合成「前提完备」）",
  );
  assert(synthesizeStatus(factsWithPending, 0.3, false, cfg) === "前提不足", "entail 低优先于待核前提（前提不足 ＞ 含待核前提）");
  assert(synthesizeStatus(factsWithBad, 0.9, false, cfg) === "含不符前提", "不符前提优先于待核前提（含不符前提 ＞ 含待核前提）");
  assert(synthesizeStatus(factsWithCond, 0.9, true, cfg) === "条件性成立", "无待核、含条件 → 条件性成立（不受新增状态影响）");
  const mergedStillPending: FactCheck[] = [...factsAllGood, { text: "补充事实但 Jev 未答", kind: "code", p: null, status: "待核" }];
  assert(
    synthesizeStatus(mergedStillPending, 0.95, false, cfg) === "含待核前提",
    "补前提回灌后重合成（runJevCheck 里对应 :1488 前后的合并逻辑）同样适用五态优先级",
  );
}

// ----------------------------------------------------------------------------
// 用例 15：runJevCheck 注入非 JevUnavailable 异常 → fail-open，不 reject（修复单 4）
// ----------------------------------------------------------------------------
{
  log("=== 用例 15：runJevCheck 对任意内部异常 fail-open，不 reject（修复单 4）===");
  // 违反 JevClientLike 契约：ask() 不抛错但返回值缺 calls 字段（模拟写坏的客户端）。checkFinding
  // 里 `calls.push(...r.calls)` 在 try/catch 之外，会因此抛出真正未被内部吞掉的异常——借此验证
  // runJevCheck 的 fail-open catch-all 覆盖的不只是 JevUnavailable（各调用点已各自吞掉普通 Error）。
  const brokenClient: JevClientLike = {
    async ask() {
      return { results: {} } as unknown as JevAskResult;
    },
    async noul() {
      return { p: 0.9, calls: [] };
    },
  };
  let threw: unknown;
  let report: Awaited<ReturnType<typeof runJevCheck>> | undefined;
  try {
    report = await runJevCheck({
      findings: [mkFinding()],
      materials,
      cfg: cfgWith(),
      workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
      runSessionFn: noopRunSession,
      modelRuntime: null as never,
      cwd: "/repo",
      readRoots: [],
      deadlineMs: 90_000,
      client: brokenClient,
    });
  } catch (err) {
    threw = err;
  }
  assert(
    threw === undefined,
    `runJevCheck 不 reject，即使内部触发了非 JevUnavailable 异常（实际抛出：${threw instanceof Error ? threw.message : String(threw)}）`,
  );
  assert(report?.enabled === false, "任意内部异常 → enabled=false（fail-open）");
  assert(typeof report?.skipped === "string" && report.skipped.includes("内部错误"), `skipped 写明「内部错误」（实际 ${report?.skipped}）`);
}

// ----------------------------------------------------------------------------
// 用例 16：premiseRound 单条 JevUnavailable 不向外抛，其它候选照常出结果（修复单 5）
// ----------------------------------------------------------------------------
{
  log("=== 用例 16：premiseRound 单条 JevUnavailable 不影响其它候选（修复单 5）===");
  const cfg = cfgWith();
  const f1 = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, claim: "TRIGGER_UNAVAILABLE：缺少来源校验" });
  const f2 = mkFinding({ id: "F2", pid: "P1/F2", proposerIndex: 0, claim: "另一处缺陷，Kind 为空时放行" });
  const perFinding = {
    [f1.pid]: {
      pid: f1.pid,
      ref: "OK" as const,
      facts: f1.facts.map((t) => ({ text: t, kind: "code" as const, p: 0.9, status: "相符" as const })),
      entail: { p1: 0.1 },
      status: "前提不足" as const,
      conditionFlag: false,
      calls: [],
    },
    [f2.pid]: {
      pid: f2.pid,
      ref: "OK" as const,
      facts: f2.facts.map((t) => ({ text: t, kind: "code" as const, p: 0.9, status: "相符" as const })),
      entail: { p1: 0.2 },
      status: "前提不足" as const,
      conditionFlag: false,
      calls: [],
    },
  };
  const clientMixed: JevClientLike = {
    async ask(state, questions) {
      const results: JevAskResult["results"] = {};
      const calls: JevAskResult["calls"] = [];
      for (const [key, q] of Object.entries(questions)) {
        results[key] = { p: 0.85 };
        calls.push({ q: q.q, p: 0.85, stateSha256: "mock", inputTokens: 5, ms: 1 });
      }
      return { results, calls };
    },
    async noul(kind, state) {
      if (kind === "entail" && state.includes("TRIGGER_UNAVAILABLE")) {
        throw new JevUnavailable("模拟补前提阶段 Jev 不可用");
      }
      return { p: 0.9, calls: [{ q: kind, p: 0.9, stateSha256: "mock", inputTokens: 5, ms: 1 }] };
    },
  };
  const mockRunSession: RunSessionFn = async (_mr, _worker, prompt, opts) => {
    const m = /amend_facts\(id="([^"]+)"/.exec(prompt);
    const id = m?.[1] ?? "";
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute(
        "call-1",
        { id, facts: ["ratchet.go 第 7 行 cmd 为 nil 时直接返回错误"] } as never,
        undefined as never,
        undefined as never,
        { cwd: "/repo" } as never,
      );
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const results = await premiseRound({
    findings: [f1, f2],
    perFinding,
    materials,
    docs,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: clientMixed,
  });
  const r1 = results.get(f1.pid);
  const r2 = results.get(f2.pid);
  assert(r1?.added.length === 0 && r1?.reason === "补前提：Jev 不可用", `F1 遇 JevUnavailable：added=[]、reason 记不可用（实际 ${JSON.stringify(r1)}）`);
  assert(r2 !== undefined && r2.added.length === 1 && r2.entailP2 === 0.9, `F2 不受影响，正常出结果（实际 ${JSON.stringify(r2)}）`);

  // 用例 16b（PiMoa 复审）：非 JevUnavailable 的异常（内部 bug / 会话层同步抛）同样只废这一条，不让 Promise.all 早 reject 丢整轮。
  const boomRunSession: RunSessionFn = (mr, worker, prompt, opts) => {
    if (prompt.includes('id="F1"')) throw new Error("模拟会话层同步异常");
    return mockRunSession(mr, worker, prompt, opts);
  };
  const clientOk: JevClientLike = {
    ask: clientMixed.ask,
    async noul(kind) {
      return { p: 0.9, calls: [{ q: kind, p: 0.9, stateSha256: "mock", inputTokens: 5, ms: 1 }] };
    },
  };
  const rb = await premiseRound({
    findings: [f1, f2],
    perFinding,
    materials,
    docs,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: boomRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: clientOk,
  });
  const b1 = rb.get(f1.pid);
  const b2 = rb.get(f2.pid);
  assert(b1?.added.length === 0 && (b1?.reason ?? "").startsWith("补前提：内部错误：模拟会话层同步异常"), `F1 内部异常被隔离并记原因（实际 ${JSON.stringify(b1)}）`);
  assert(b2 !== undefined && b2.added.length === 1 && b2.entailP2 === 0.9, `F2 仍正常出结果（实际 ${JSON.stringify(b2)}）`);
}

// ----------------------------------------------------------------------------
// 用例 17：非限流 isError 三次不触发 JevUnavailable（修复单 6）
// ----------------------------------------------------------------------------
{
  log("=== 用例 17：非限流 isError 三次不触发 JevUnavailable，按单样本失败处理（修复单 6）===");
  JevClient.resetForTest();
  let hits = 0;
  const { url, close } = await startMockJevServer(() => {
    hits++;
    return { text: "上游模型报错：额度耗尽", isError: true }; // 非限流的 isError
  });
  const client = JevClient.shared({ url, concurrency: 8, perCallTimeoutMs: 5000 });
  let threw: unknown;
  let r: { p: number | null; calls: unknown[] } | undefined;
  try {
    r = await client.noul("fact", "## 代码\nfoo", 3);
  } catch (err) {
    threw = err;
  }
  assert(
    threw === undefined,
    `非限流 isError 不触发 JevUnavailable，noul 正常返回（实际抛出：${threw instanceof Error ? threw.constructor.name : String(threw)}）`,
  );
  assert(r?.p === null, "三次都是非限流 isError，无法解析出 p → null");
  assert(hits === 3, `3 次采样各自独立发起 1 次请求，互不提前中断（实际 ${hits} 次）`);
  await close();
  JevClient.resetForTest();
}

// ----------------------------------------------------------------------------
// 用例 18：限流 k=5（6400ms）仍退避重试、k=6 才抛 JevThrottled（修复单 7，耗时约 12.6s）
// ----------------------------------------------------------------------------
{
  log("=== 用例 18：限流 200ms×2^k（k≤5）全部退避重试，k=6 才抛 JevThrottled（修复单 7，本用例耗时约 12.6s）===");
  JevClient.resetForTest();
  let hits = 0;
  const { url, close } = await startMockJevServer(() => {
    hits++;
    return { text: "jev 在飞请求已达上限 8", isError: true }; // 永远限流
  });
  const client = JevClient.shared({ url, concurrency: 8, perCallTimeoutMs: 5000 });
  // requestOnce 内部在 k=6（第 7 次请求）仍被拒时抛 JevThrottled，但 ask() 的采样循环把它当
  // 「该次采样失败」吞掉（catch 里只对 JevUnavailable 才 rethrow，其它错误 continue 到下一轮
  // 采样——既有设计，见文件尾「已知限制」第 5 条）：noul() 因此不会向外抛，只会拿不到 p 值。
  // 本用例改用 hits（服务端实际收到的请求数）与 throttledCount 间接证明 k=5 那次真的退避重试了
  // （而不是像旧实现那样在 k=5 就直接放弃）。
  let threw: unknown;
  let r: { p: number | null; calls: unknown[] } | undefined;
  try {
    r = await client.noul("fact", "## 代码\nfoo", 1);
  } catch (err) {
    threw = err;
  }
  assert(threw === undefined, `JevThrottled 被 ask() 当作单样本失败吞掉，noul 不 reject（实际抛出：${threw instanceof Error ? threw.constructor.name : String(threw)}）`);
  assert(r?.p === null, "重试耗尽、整轮都没拿到答案 → p=null");
  assert(
    hits === 7,
    `k=0..5 共 6 次请求各自退避重试（含 k=5 的 6400ms 那次），第 7 次（k=6）仍被拒才放弃 —— 服务端应收到 7 次请求` +
      `（实际 ${hits} 次；旧实现在 k=5 那次的 6400ms 退避前就直接放弃，只会收到 6 次）`,
  );
  assert(client.throttledCount === 7, `throttledCount 计入全部 7 次限流响应（实际 ${client.throttledCount}）`);
  await close();
  JevClient.resetForTest();
}

// ----------------------------------------------------------------------------
// 用例 19：已 abort 的 signal → 不计连续失败、ask 立即结束（修复单 9）
// ----------------------------------------------------------------------------
{
  log("=== 用例 19：已 abort 的 signal → requestOnce 直接短路、不计连续失败（修复单 9）===");
  JevClient.resetForTest();
  let hits = 0;
  const { url, close } = await startMockJevServer(() => {
    hits++;
    return { text: "【q】P(成立)=0.9 [用量] 输入 10 token" };
  });
  const client = JevClient.shared({ url, concurrency: 8, perCallTimeoutMs: 5000 });
  const ac = new AbortController();
  ac.abort();
  for (let i = 0; i < 3; i++) {
    const r = await client.noul("fact", "state", 1, ac.signal);
    assert(r.p === null, `第 ${i + 1} 次已 abort 调用 → p=null，不抛异常（若 abort 被误计入连续失败，第 3 次就会抛 JevUnavailable）`);
  }
  assert(hits === 0, `已 abort 的 signal 下 requestOnce 在发起前就短路，从不真正发起网络请求（实际 ${hits} 次）`);
  await close();
  JevClient.resetForTest();
}

// ----------------------------------------------------------------------------
// 用例 20：deadline 传播 —— perCallTimeoutMs 很大而 deadline 很小时单条 finding 及时结束（修复单 10）
// ----------------------------------------------------------------------------
class SlowClient implements JevClientLike {
  async ask(
    _state: string,
    questions: Record<string, { q: JevCall["q"]; instructions: string; criteria: { true: string; false: string } }>,
    _n: number,
    signal?: AbortSignal,
  ): Promise<JevAskResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const results: JevAskResult["results"] = {};
        for (const key of Object.keys(questions)) results[key] = { p: 0.9 };
        resolve({ results, calls: [] });
      }, 5000); // 远大于本用例的 deadlineMs，靠 signal 提前打断
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  async noul(kind: JevCall["q"], state: string, n: number, signal?: AbortSignal): Promise<{ p: number | null; calls: JevAskResult["calls"] }> {
    const r = await this.ask(state, { q: { q: kind, ...QUESTIONS[kind] } }, n, signal);
    return { p: r.results.q?.p ?? null, calls: r.calls };
  }
}
{
  log("=== 用例 20：deadline 传播 —— deadlineMs 远小于 perCallTimeoutMs 时单条 finding 及时结束（修复单 10）===");
  const t0 = Date.now();
  const cfg = cfgWith({ perCallTimeoutMs: 60_000 }); // 故意设很大的单次超时，验证真正兜底的是 deadlineMs
  const report = await runJevCheck({
    findings: [mkFinding()],
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 150,
    client: new SlowClient(),
  });
  const elapsed = Date.now() - t0;
  assert(
    elapsed < 3000,
    `deadlineMs=150 远小于 perCallTimeoutMs=60000 且 SlowClient 要 5000ms 才答时，单条 finding 仍在数秒内结束` +
      `（实际耗时 ${elapsed}ms），证明 deadline 已下传进单次 Jev 请求的 signal`,
  );
  assert(report.enabled === true, "deadline 提前结束不算「不可用」，report 仍 enabled=true（只是各步骤可能未核）");
}

// ----------------------------------------------------------------------------
// 用例 21：JevClient.shared 配置变更后重建实例；throttled 为本轮（前后差值）（修复单 11）
// ----------------------------------------------------------------------------
{
  log("=== 用例 21：JevClient.shared 配置变更后重建实例（修复单 11）===");
  JevClient.resetForTest();
  const s1 = JevClient.shared({ url: "http://127.0.0.1:19999/mcp", concurrency: 8, perCallTimeoutMs: 1000 });
  const s2 = JevClient.shared({ url: "http://127.0.0.1:19999/mcp", concurrency: 8, perCallTimeoutMs: 1000 });
  assert(s1 === s2, "url/concurrency/perCallTimeoutMs 都相同 → 复用同一实例");
  const s3 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 8, perCallTimeoutMs: 1000 });
  assert(s1 !== s3, "url 改变 → 重建新实例");
  const s4 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 1000 });
  assert(s3 !== s4, "concurrency 改变 → 重建新实例");
  const s5 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 2000 });
  assert(s4 !== s5, "perCallTimeoutMs 改变 → 重建新实例");
  const s6 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 2000, clientMode: "auto" });
  assert(s5 === s6, "clientMode 显式 auto 与缺省（auto）等价 → 复用同一实例");
  const s7 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 2000, clientMode: "modern" });
  assert(s6 !== s7, "clientMode 改变（auto→modern）→ 重建新实例");
  const s8 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 2000, clientMode: "legacy" });
  assert(s7 !== s8, "clientMode 改变（modern→legacy）→ 重建新实例");
  const s9 = JevClient.shared({ url: "http://127.0.0.1:18888/mcp", concurrency: 4, perCallTimeoutMs: 2000, clientMode: "legacy" });
  assert(s8 === s9, "clientMode 相同 → 复用同一实例");
  JevClient.resetForTest();
}
{
  log("=== 用例 21b：runJevCheck 的 totals.throttled 是本轮差值，不是跨轮累积（修复单 11）===");
  JevClient.resetForTest();
  let n = 0;
  const { url, close } = await startMockJevServer(() => {
    n++;
    if (n === 1) return { text: "jev 在飞请求已达上限 8", isError: true }; // 只让全程第一次请求限流一次
    return { text: "【q】P(成立)=0.9 [用量] 输入 10 token" };
  });
  const cfg = cfgWith({ url, concurrency: 8, perCallTimeoutMs: 5000, budget: { maxCalls: 100, maxMs: 90_000, tableMaxChars: 40_000 } });
  const report1 = await runJevCheck({
    findings: [mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 })],
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    // 不传 client：走 JevClient.shared(cfg)，故意验证单例共享路径。
  });
  assert(report1.totals.throttled === 1, `第一轮命中 1 次限流（实际 ${report1.totals.throttled}）`);
  const report2 = await runJevCheck({
    findings: [mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0, lines: "7-8", anchor: "no command" })],
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: noopRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
  });
  assert(
    report2.totals.throttled === 0,
    `第二轮沿用同一单例但没再触发限流，totals.throttled 是本轮前后差值而非累积值（实际 ${report2.totals.throttled}）`,
  );
  await close();
  JevClient.resetForTest();
}

// ----------------------------------------------------------------------------
// 用例 22：补前提 entail(p2) 调用计入 calls（修复单 12）
// ----------------------------------------------------------------------------
{
  log("=== 用例 22a：premiseRound entail(p2) 调用未解析出 p 也标记 entailCallMade（修复单 12）===");
  const cfg = cfgWith();
  const f = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const perFinding = {
    [f.pid]: {
      pid: f.pid,
      ref: "OK" as const,
      facts: f.facts.map((t) => ({ text: t, kind: "code" as const, p: 0.9, status: "相符" as const })),
      entail: { p1: 0.1 },
      status: "前提不足" as const,
      conditionFlag: false,
      calls: [],
    },
  };
  const clientNoEntailAnswer: JevClientLike = {
    async ask(_state, questions) {
      const results: JevAskResult["results"] = {};
      const calls: JevAskResult["calls"] = [];
      for (const [key, q] of Object.entries(questions)) {
        results[key] = { p: 0.85 };
        calls.push({ q: q.q, p: 0.85, stateSha256: "mock", inputTokens: 5, ms: 1 });
      }
      return { results, calls };
    },
    async noul(kind) {
      if (kind === "entail") return { p: null, calls: [] }; // Jev 没答出可解析的 p
      return { p: 0.9, calls: [] };
    },
  };
  const mockRunSession: RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute(
        "call-1",
        { id: "F1", facts: ["ratchet.go 第 7 行 cmd 为 nil 时直接返回错误"] } as never,
        undefined as never,
        undefined as never,
        { cwd: "/repo" } as never,
      );
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const results = await premiseRound({
    findings: [f],
    perFinding,
    materials,
    docs,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client: clientNoEntailAnswer,
  });
  const r = results.get(f.pid);
  assert(r?.entailP2 === undefined, "Jev 未答出 p → entailP2 undefined");
  assert(r?.entailCallMade === true, "entail(p2) 调用仍然发起过（entailCallMade=true），calls 计费不能漏计这次往返");
}
{
  log("=== 用例 22b：runJevCheck totals.calls 计入补前提 entail(p2) 往返（修复单 12）===");
  const cfg = cfgWith({ premiseRound: { enabled: true, maxFindings: 10, concurrency: 4, perCallMs: 30_000 } });
  const f = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const client = new MockJevClient([
    (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.2 : undefined),
  ]);
  const mockRunSession: RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute(
        "call-1",
        { id: "F1", facts: ["ratchet.go 第 7 行 cmd 为 nil 时直接返回错误"] } as never,
        undefined as never,
        undefined as never,
        { cwd: "/repo" } as never,
      );
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
  };
  const report = await runJevCheck({
    findings: [f],
    materials,
    cfg,
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    client,
  });
  const fc = report.perFinding[f.pid]!;
  assert(fc.entail.p2 !== undefined, "补前提回合算出 entail.p2（初始 entail 低 0.2 → 前提不足 → 进补前提）");
  // 初始 checkFinding 的 calls 已固定记在 fc.calls 里（不受补前提影响）；补前提阶段新增：
  // 1 条补充事实的 fact 调用 + 1 次 entail(p2) 调用——后者正是修复单 12 要求补记的那一次。
  assert(
    report.totals.calls === fc.calls.length + 2,
    `totals.calls = 初始 fc.calls.length(${fc.calls.length}) + 补前提 1 条事实 + entail(p2) 1 次（实际 ${report.totals.calls}）`,
  );
}

// ----------------------------------------------------------------------------
// 用例 23：fact 问法原文 + 文档切片标题「材料」/「代码」（修复单 13）
// ----------------------------------------------------------------------------
{
  log("=== 用例 23：fact 问法原文断言 + 切片标题按文档类型区分（修复单 13）===");
  assert(
    QUESTIONS.fact.instructions === "这条事实与所给材料（或所述通用规范）相符。",
    `fact 问法改回设计 §4 原文（实际 ${QUESTIONS.fact.instructions}）`,
  );

  const capturedStates: string[] = [];
  const recordingClient: JevClientLike = {
    async ask(state, questions) {
      capturedStates.push(state);
      const results: JevAskResult["results"] = {};
      const calls: JevAskResult["calls"] = [];
      for (const [key, q] of Object.entries(questions)) {
        results[key] = { p: 0.9 };
        calls.push({ q: q.q, p: 0.9, stateSha256: "mock", inputTokens: 1, ms: 1 });
      }
      return { results, calls };
    },
    async noul() {
      return { p: 0.9, calls: [] };
    },
  };
  await checkFinding({ f: mkFinding({ facts: ["ratchet.go 第 4 行判断 Layer 与 Kind"] }), materials, docs, client: recordingClient, cfg: cfgWith() });
  await checkFinding({
    f: mkFinding({ facts: ["通用事实：第 2 节所述行号核验规则适用于全部提交"] }),
    materials,
    docs,
    client: recordingClient,
    cfg: cfgWith(),
  });
  assert(
    capturedStates.some((s) => s.startsWith("## 代码（internal/x/ratchet.go")),
    `.go 切片标题写「## 代码（…）」（实际 ${JSON.stringify(capturedStates)}）`,
  );
  assert(
    capturedStates.some((s) => s.startsWith("## 材料（docs/spec.md")),
    `.md 文档切片标题写「## 材料（…）」（实际 ${JSON.stringify(capturedStates)}）`,
  );
}

// ----------------------------------------------------------------------------
// 用例 24：ref 四态透传与渲染文案（修复单 14）+ counter 不进 oneSided（修复单 15）
//         + maxChars 小于截断标记长度（修复单 16）+ state 超 20,000 字符被截断（修复单 17）
//         + sampling.fixed 生效（修复单 18）
// ----------------------------------------------------------------------------
{
  log("=== 用例 24a：ref 四态透传 + 渲染文案（修复单 14）===");
  const cfg = cfgWith();
  const clientOk = new MockJevClient([(_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined)]);

  const fOk = mkFinding(); // anchor="management_proof_missing"，在给定 lines="4-5" 范围内直接命中
  const fcOk = await checkFinding({ f: fOk, materials, docs, client: clientOk, cfg });
  assert(fcOk.ref === "OK", `anchor 在给定范围内命中 → ref=OK（实际 ${fcOk.ref}）`);

  // 「行号已校正」归一为 OK：anchor 只在文件内别处唯一命中（给定范围 4-5 内不含它）。
  const fCorrected = mkFinding({ lines: "4-5", anchor: "r.count++" }); // 唯一出现在第 11 行
  const fcCorrected = await checkFinding({ f: fCorrected, materials, docs, client: clientOk, cfg });
  assert(fcCorrected.ref === "OK", `anchorHit 判「行号已校正」时 computeRef 归一为 OK（实际 ${fcCorrected.ref}），避免 isAnomalous 误判`);

  // 锚点不唯一：anchor 在文件内出现 ≥2 处（"return" 在 GO_LINES 出现 3 次）。
  const fAmbiguous = mkFinding({ id: "F1", pid: "P1/F1", lines: "1-1", anchor: "return" });
  const fcAmbiguous = await checkFinding({ f: fAmbiguous, materials, docs, client: clientOk, cfg });
  assert(fcAmbiguous.ref === "锚点不唯一", `anchor 多处命中 → ref=锚点不唯一（实际 ${fcAmbiguous.ref}）`);

  // 锚点未命中：anchor 全文件都找不到。
  const fMissing = mkFinding({ id: "F2", pid: "P1/F2", lines: "1-1", anchor: "totally_absent_token_xyz" });
  const fcMissing = await checkFinding({ f: fMissing, materials, docs, client: clientOk, cfg });
  assert(fcMissing.ref === "锚点未命中", `anchor 全文件都找不到 → ref=锚点未命中（实际 ${fcMissing.ref}）`);

  const table = renderCheckTable(
    { perFinding: { [fAmbiguous.pid]: fcAmbiguous, [fMissing.pid]: fcMissing }, duplicates: [], conflicts: [], oneSided: [] },
    [fAmbiguous, fMissing],
    materials,
    100_000,
  );
  assert(table.text.includes("引用：锚点不唯一（待核）"), `核对表渲染「锚点不唯一」附「（待核）」：\n${table.text}`);
  assert(table.text.includes("引用：锚点未命中") && !table.text.includes("锚点未命中（待核）"), `「锚点未命中」不附「（待核）」：\n${table.text}`);
}

{
  log("=== 用例 24b：kind=counter 的孤立项不列入单边项（修复单 15）===");
  const c1 = mkFinding({ id: "C1", pid: "P1/C1", proposerIndex: 0, kind: "counter", level: "COUNTER", path: "internal/x/ratchet.go", lines: "30-30" });
  const r = oneSided([c1], materials, { duplicates: [], conflicts: [] });
  assert(r.length === 0, `counter 类型的孤立项不进 oneSided（即便行区间与任何人都不重叠，实际 ${JSON.stringify(r)}）`);
}

{
  log("=== 用例 24c：renderCheckTable maxChars 小于截断标记长度时返回值不超过 maxChars（修复单 16）===");
  const cfg = cfgWith();
  const f1 = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const client = new MockJevClient([(_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined)]);
  const fc1 = await checkFinding({ f: f1, materials, docs, client, cfg });
  const report = { perFinding: { [f1.pid]: fc1 }, duplicates: [], conflicts: [], oneSided: [] };
  for (const tiny of [10, 5, 1, 0]) {
    const { text, truncated } = renderCheckTable(report, [f1], materials, tiny);
    assert(text.length <= tiny, `maxChars=${tiny}（小于截断标记本身长度）时返回值不超过 maxChars（实际 ${text.length} 字符）：${JSON.stringify(text)}`);
    assert(truncated, `maxChars=${tiny} 判定超限`);
  }
}

{
  log("=== 用例 24d：state 超 JEVCHECK_STATE_MAX_CHARS(20,000) 字符被截断（修复单 17）===");
  const ABS_BIG = "/repo/big.go";
  const BIG_LINES = Array.from({ length: 50 }, (_, i) => `x${i}`.padEnd(2000, "z"));
  const materialsBig: MaterialMap = new Map(materials);
  materialsBig.set(ABS_BIG, [seg(ABS_BIG, "big.go", "range", 1, BIG_LINES)]);

  let capturedState = "";
  const recordingClient: JevClientLike = {
    async ask(state, questions) {
      capturedState = state;
      const results: JevAskResult["results"] = {};
      const calls: JevAskResult["calls"] = [];
      for (const [key, q] of Object.entries(questions)) {
        results[key] = { p: 0.9 };
        calls.push({ q: q.q, p: 0.9, stateSha256: "mock", inputTokens: 1, ms: 1 });
      }
      return { results, calls };
    },
    async noul() {
      return { p: 0.9, calls: [] };
    },
  };
  const fBig = mkFinding({ path: "big.go", lines: "25-25", anchor: "x25", facts: ["big.go 第 25 行 存在过长内容，需要人工确认"] });
  await checkFinding({ f: fBig, materials: materialsBig, docs: [], client: recordingClient, cfg: cfgWith() });
  assert(capturedState.length <= 20_000, `state 体积被截到 ≤20,000 字符（实际 ${capturedState.length}）`);
  assert(capturedState.includes("…（切片过长已截断）"), `截断后附「…（切片过长已截断）」标记：${capturedState.slice(-40)}`);
}

{
  log("=== 用例 24e：sampling.fixed 生效（修复单 18）===");
  const cfg = cfgWith({ fixPresent: { enabled: true }, sampling: { ...JEVCHECK_DEFAULTS.sampling, fixed: 3 } });
  const client = new MockJevClient([
    (_s, _k, instr) =>
      instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : instr.includes("待核对的处理") ? 0.8 : undefined,
  ]);
  const fc = await checkFinding({ f: mkFinding(), materials, docs, client, cfg });
  const fixedCalls = fc.calls.filter((c) => c.q === "fixed");
  assert(fixedCalls.length === 3, `cfg.sampling.fixed=3 生效，"fixed" 问法产生 3 条 JevCall（实际 ${fixedCalls.length}）`);
  assert(fc.fixPresent === 0.8, `fixPresent 记录 Jev 均值（实际 ${fc.fixPresent}）`);
}

// ============================================================================
// 用例 26：factRefs 驱动的 Jev 分流（设计 v4 §12.2 C / 任务书第 3 点，波四 2026-09-20）
// ============================================================================
{
  log("=== 用例 26：factRefs Jev 分流（未命中不问 Jev / 已校正切片行 / 核对表标注）===");

  // 26a：factRef.status="未命中" → 不问 Jev，直接判「不符」，ref/refDetail 记原因。
  {
    let factAsks = 0;
    const client = new MockJevClient([
      (_s, _k, instr) => {
        if (instr.includes("待核对的事实")) factAsks++;
        return instr.includes("仅凭上述前提") ? 0.9 : undefined;
      },
    ]);
    // 单条 code 事实（checkFinding 不要求 3 条下限——那是 submit_findings 处理器的规则），
    // 避免额外的 general 事实各自走 locateFact 正常路径混进 factAsks 计数。
    const factText = "ratchet.go 第 4 行使用 nonExistentTokenABC";
    const f = mkFinding({
      facts: [factText],
      factRefs: [{ text: factText, file: "internal/x/ratchet.go", a: 4, b: 4, status: "未命中", token: "nonExistentTokenABC" }],
    });
    const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
    assert(factAsks === 0, "未命中的事实不占用一次 fact 类 Jev 调用");
    assert(fc.facts[0]?.status === "不符" && fc.facts[0]?.ref === "未命中", `未命中 → 不问 Jev 直接判不符：${JSON.stringify(fc.facts[0])}`);
    assert(fc.facts[0]?.refDetail?.includes("nonExistentTokenABC") && fc.facts[0]?.refDetail?.includes("第 4 行"), `refDetail 记原因：${fc.facts[0]?.refDetail}`);
    assert(fc.status === "含不符前提", `不符事实压过其它前提，finding 合成状态含不符前提（实际 ${fc.status}）`);
  }

  // 26b：factRef.status="行号越界" / "文件未附" 同样不问 Jev，直接判「不符」。
  {
    let factAsks = 0;
    const client = new MockJevClient([
      (_s, _k, instr) => {
        if (instr.includes("待核对的事实")) factAsks++;
        return instr.includes("仅凭上述前提") ? 0.9 : undefined;
      },
    ]);
    const f = mkFinding({
      facts: ["ratchet.go 第 950 行 越界引用"],
      factRefs: [{ text: "ratchet.go 第 950 行 越界引用", file: "internal/x/ratchet.go", a: 950, b: 950, status: "行号越界" }],
    });
    const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
    assert(factAsks === 0 && fc.facts[0]?.status === "不符" && fc.facts[0]?.ref === "行号越界", `行号越界 → 不问 Jev 直接判不符：${JSON.stringify(fc.facts[0])}`);
  }

  // 26c：factRef.status="已校正" → 切片改用校正后的行（第 7 行，而非事实原写的第 900 行）。
  {
    let sliceState = "";
    const client = new MockJevClient([
      (state, _k, instr) => {
        if (instr.includes("待核对的事实")) {
          sliceState = state;
          return 0.9;
        }
        return instr.includes("仅凭上述前提") ? 0.9 : undefined;
      },
    ]);
    const factText = "ratchet.go 第 900 行调用 svcIdentityMatches";
    const f = mkFinding({
      facts: [factText],
      factRefs: [{ text: factText, file: "internal/x/ratchet.go", a: 7, b: 7, status: "已校正", token: "svcIdentityMatches", originalLine: "900" }],
    });
    const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
    // pad=JEVCHECK_FACT_PAD=15，窗口 [max(1,7-15), min(14,7+15)] 被段界（1-14）钳死，故标题只显示
    // 段界；真正验证「切片用校正后的第 7 行」看切片正文里第 7 行的行号前缀与内容都在同一行。
    const line7 = sliceState.split("\n").find((l) => /^\s*7\|/.test(l));
    assert(!!line7 && line7.includes("svcIdentityMatches"), `切片正文第 7 行含 svcIdentityMatches（校正后位置）：${line7}`);
    assert(!sliceState.includes("第 900"), `切片不再围绕事实原写的第 900 行：${sliceState.slice(0, 60)}`);
    assert(
      fc.facts[0]?.status === "相符" && fc.facts[0]?.ref === "已校正" && fc.facts[0]?.correctedLine === 7,
      `已校正 fact 记 ref/correctedLine：${JSON.stringify(fc.facts[0])}`,
    );
    assert(fc.facts[0]?.refDetail === "（引用已校正 900→7）", `refDetail 文案「引用已校正 900→7」：${fc.facts[0]?.refDetail}`);
  }

  // 26d：renderCheckTable 事实行标注快照（不符/已校正两种标注同时出现在同一份核对表里）。
  {
    const missText = "ratchet.go 第 4 行使用 nonExistentTokenABC";
    const corrText = "ratchet.go 第 900 行调用 svcIdentityMatches";
    const f = mkFinding({
      facts: [missText, corrText],
      factRefs: [
        { text: missText, file: "internal/x/ratchet.go", a: 4, b: 4, status: "未命中", token: "nonExistentTokenABC" },
        { text: corrText, file: "internal/x/ratchet.go", a: 7, b: 7, status: "已校正", token: "svcIdentityMatches", originalLine: "900" },
      ],
    });
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined),
    ]);
    const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
    const table = renderCheckTable({ perFinding: { [f.pid]: fc }, duplicates: [], conflicts: [], oneSided: [] }, [f], materials, 40_000);
    assert(table.text.includes("F1 不符（引用：标识符 nonExistentTokenABC 不在第 4 行）"), `核对表标注「不符（引用：…）」：${table.text}`); // 见 jevcheck.ts factRefAnnotation：token 前后各留一空格
    assert(table.text.includes("F2 相符（引用已校正 900→7）"), `核对表标注「相符（引用已校正 …）」：${table.text}`);
  }

  // 26e：refConsistency="不一致"（徐总 09-20 追加裁定，波四）透传后，ref 汇总归到「锚点不唯一」档，
  // 核对表首行加「引用不一致（…）」。
  {
    const client = new MockJevClient([
      (_s, _k, instr) => (instr.includes("待核对的事实") ? 0.9 : instr.includes("仅凭上述前提") ? 0.9 : undefined),
    ]);
    const f = mkFinding({ refConsistency: "不一致" });
    const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
    assert(fc.ref === "锚点不唯一", `refConsistency=不一致 → ref 汇总为锚点不唯一（实际 ${fc.ref}）`);
    assert(fc.refConsistency === "不一致" && !!fc.refConsistencyDetail, `refConsistency/refConsistencyDetail 透传：${fc.refConsistencyDetail}`);
    const table = renderCheckTable({ perFinding: { [f.pid]: fc }, duplicates: [], conflicts: [], oneSided: [] }, [f], materials, 40_000);
    assert(table.text.includes(`引用不一致（${fc.refConsistencyDetail}）`), `核对表首行加「引用不一致（…）」：${table.text}`);
  }
}

// ============================================================================
// 用例 25（可选）：真 8760 smoke —— 10 条事实真判一次
// ============================================================================
if (process.env.JEV_SMOKE === "1") {
  log("=== 用例 25：JEV_SMOKE=1 —— 真 8760 判 10 条事实 ===");
  JevClient.resetForTest();
  const client = JevClient.shared({ url: "http://127.0.0.1:8760/mcp", concurrency: 4, perCallTimeoutMs: 30_000 });
  const facts = Array.from({ length: 10 }, (_, i) => `ratchet.go 第 ${4 + (i % 3)} 行判断 Layer 是否等于 management_proof_missing（样本 ${i}）`);
  for (const fact of facts) {
    const state = `## 代码（internal/x/ratchet.go，第 1-13 行）\n\`\`\`\n${GO_LINES.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")}\n\`\`\``;
    const r = await client.noul("fact", `${state}\n\n## 待核对的事实\n${fact}`, 1);
    assert(r.p === null || (r.p >= 0 && r.p <= 1), `真判返回 0-1 之间的数或 null（实际 ${r.p}）：${fact}`);
  }
} else {
  log("（跳过用例 25：设 JEV_SMOKE=1 对真 8760 跑一次真判 smoke）");
}


// ============================================================================
// 用例 27：波四复审（2026-09-20）——已校正事实问 Jev 用改写后文本；premiseRound 补充事实的机械校验结果回流
// ============================================================================
{
  log("=== 用例 27a：checkFinding 对「已校正」事实问 Jev 用 rewritten 文本（行号 900→7），不再把原行号喂给 Jev ===");
  let asked = "";
  const client = new MockJevClient([
    (_s, _k, instr) => {
      if (instr.includes("待核对的事实")) {
        asked = instr;
        return 0.9;
      }
      return instr.includes("仅凭上述前提") ? 0.9 : undefined;
    },
  ]);
  const factText = "ratchet.go 第 900 行调用 svcIdentityMatches";
  const f = mkFinding({
    facts: [factText],
    factRefs: [{ text: factText, file: "internal/x/ratchet.go", a: 7, b: 7, status: "已校正", token: "svcIdentityMatches", originalLine: "900", rewritten: "ratchet.go 第 7 行调用 svcIdentityMatches" }],
  });
  const fc = await checkFinding({ f, materials, docs, client, cfg: cfgWith() });
  assert(asked.includes("ratchet.go 第 7 行调用 svcIdentityMatches") && !asked.includes("第 900 行"), `Jev 收到的是改写后的事实：${asked.split("## 待核对的事实")[1]?.trim()}`);
  assert(fc.facts[0]?.text === factText, "FactCheck.text 仍是原文（核对表展示 proposer 原写）");
}
{
  log("=== 用例 27b：premiseRound 补充事实经 checkFactRef 分流——未命中直判不符不问 Jev；已校正切片/提问用校正行 ===");
  let factAsks = 0;
  let askedText = "";
  let askedState = "";
  const client = new MockJevClient([
    (state, _k, instr) => {
      if (instr.includes("待核对的事实")) {
        factAsks++;
        askedText = instr;
        askedState = state;
        return 0.9;
      }
      return instr.includes("仅凭上述前提") ? 0.9 : undefined;
    },
  ]);
  const f = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const perFinding = {
    [f.pid]: {
      pid: f.pid,
      ref: "OK" as const,
      facts: f.facts.map((t) => ({ text: t, kind: "code" as const, p: 0.9, status: "相符" as const })),
      entail: { p1: 0.1 },
      status: "前提不足" as const,
      conditionFlag: false,
      calls: [],
    },
  };
  // 两条补充事实：第 1 条 token 全文件零命中（未命中）；第 2 条写第 12 行、真在第 7 行（唯一命中 → 已校正）。
  const missFact = "ratchet.go 第 4 行使用 nonExistentTokenABC";
  const corrFact = "ratchet.go 第 12 行调用 svcIdentityMatches";
  const mockRunSession: RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) await tool.execute("call-1", { id: "F1", facts: [missFact, corrFact] } as never, undefined as never, undefined as never, { cwd: "/repo" } as never);
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true, structured: { accepted: true, count: 2, attempts: 1 } };
  };
  const results = await premiseRound({
    findings: [f],
    perFinding,
    materials,
    docs,
    cfg: cfgWith(),
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    client,
  });
  const r = results.get(f.pid);
  assert(r !== undefined && r.added.length === 2, `补充 2 条都进 added：${JSON.stringify(r?.added.map((a) => a.status))}`);
  const a0 = r?.added[0];
  assert(a0?.status === "不符" && a0?.ref === "未命中" && a0?.refDetail?.includes("nonExistentTokenABC"), `未命中 → 不问 Jev 直判不符并带标注：${JSON.stringify(a0)}`);
  assert(factAsks === 1, `Jev 只被问了已校正那一条（fact 提问 ${factAsks} 次）`);
  const a1 = r?.added[1];
  assert(a1?.status === "相符" && a1?.ref === "已校正" && a1?.correctedLine === 7 && a1?.refDetail === "（引用已校正 12→7）", `已校正 → ref/correctedLine/refDetail：${JSON.stringify(a1)}`);
  assert(askedText.includes("ratchet.go 第 7 行调用 svcIdentityMatches"), `问 Jev 用改写后文本：${askedText.split("## 待核对的事实")[1]?.trim()}`);
  const line7 = askedState.split("\n").find((l) => /^\s*7\|/.test(l));
  assert(!!line7 && line7.includes("svcIdentityMatches"), `切片围绕校正后的第 7 行：${line7}`);
}

// ----------------------------------------------------------------------------
// 用例 27：★PIMOA-DEF-05 —— 核对表「成立条件：」行必须与 conditionFlag / conditionFactCount 同源
//          （facts + amended.added），否则模型看不见 N 条条件却被要求给 N 条（moa#e1c484fa）
// ----------------------------------------------------------------------------
{
  log("=== 用例 27（DEF-05）：成立条件行列出补前提新增的条件并加「（补前提）」标记 ===");
  const f = mkFinding({ id: "F1", pid: "P1/F1" });
  /** 本地 FindingCheck 构造器（本文件此前只用内联字面量，无共享 helper）。 */
  const mkCheck = (over: Partial<FindingCheck> & { pid: string }): FindingCheck => ({
    ref: "OK",
    facts: [],
    entail: { p1: 0.9 },
    status: "前提完备且全部相符",
    conditionFlag: false,
    calls: [],
    ...over,
  });
  const FACT_COND: FactCheck = { text: "运行时条件：facts 侧条件", kind: "condition", p: null, status: "条件" };
  const AMENDED_COND: FactCheck = { text: "运行时条件：补前提补出的条件", kind: "condition", p: null, status: "条件" };
  const AMENDED_CODE: FactCheck = { text: "补前提：某代码事实", kind: "code", p: 0.9, status: "相符" };

  // 只取 facts 侧条件：不加标记（旧行为不变）。
  const tableFactsOnly = renderCheckTable(
    { perFinding: { [f.pid]: mkCheck({ pid: f.pid, facts: [FACT_COND], conditionFlag: true, status: "条件性成立" }) }, duplicates: [], conflicts: [], oneSided: [] },
    [f],
    materials,
    100_000,
  ).text;
  assert(
    tableFactsOnly.includes("成立条件：facts 侧条件") && !tableFactsOnly.includes("facts 侧条件（补前提）"),
    `facts 侧条件不加「（补前提）」标记：\n${tableFactsOnly}`,
  );

  // 补前提新增条件：必须出现在同一行、带（补前提）标记；非 condition 的补前提事实不进这一行。
  const tableAmended = renderCheckTable(
    {
      perFinding: {
        [f.pid]: mkCheck({ pid: f.pid, facts: [FACT_COND], amended: { added: [AMENDED_COND, AMENDED_CODE], ms: 1 }, conditionFlag: true, status: "条件性成立" }),
      },
      duplicates: [],
      conflicts: [],
      oneSided: [],
    },
    [f],
    materials,
    100_000,
  ).text;
  log(`（补前提条件渲染）${tableAmended.split("\n").find((l) => l.startsWith("成立条件：")) ?? "（无成立条件行）"}`);
  assert(
    tableAmended.includes("成立条件：facts 侧条件；补前提补出的条件（补前提）"),
    `★成立条件行 = facts 侧 + 补前提侧、补前提项带标记（修前该行只有 facts 侧，补前提条件完全不可见）：\n${tableAmended}`,
  );
  assert(tableAmended.includes("补前提：新增 2 条，1 条相符"), "「补前提：新增 N 条…」那行不改（仍是 2 条计数）");
  assert(!/成立条件：.*补前提：某代码事实/.test(tableAmended), "非 condition 的补前提事实不混进成立条件行");
}

// ----------------------------------------------------------------------------
// 用例 28：★PIMOA-DEF-07 —— entailP2 缺失时 fc.status 也必须与 conditionFlag 同源、按并集重算
//          （2026-09-20 徐总选「甲」：用新事实、沿用旧 entail.p1。修前 status 陈旧 ⇒ isAnomalous
//           为假 ⇒ table_handling 必填门「该开未开」：Jev 已判「不符」的新前提可不表态就通过）
// ----------------------------------------------------------------------------
{
  log("=== 用例 28（DEF-07）：entailP2 缺失 + 补前提新增非条件「不符」事实 → status 翻「含不符前提」、isAnomalous=true ===");
  // facts 只 1 条 code（相符）；初始 entail 答 0.1 < entail.low(0.5) ⇒ status「前提不足」⇒ 进补前提回合。
  const f = mkFinding({
    id: "F1",
    pid: "P1/F1",
    proposerIndex: 0,
    facts: ["ratchet.go 第 4 行只在 Layer 等于 management_proof_missing 且 Kind 非空时继续"],
  });
  // 补前提新增 3 条：2 条 condition（并集后 conditionFlag 才可能为 true，DEF-05 口径）+ 1 条 token
  // 全文件零命中的 code 事实（checkFactRef 未命中 ⇒ 不问 Jev 直判「不符」，正是 DEF-07 的触发事实）。
  const AMENDED_COND_A = "运行时条件：核验进程以 root 身份运行";
  const AMENDED_COND_B = "运行时条件：origin.Command 取自不可信进程";
  const AMENDED_BAD = "ratchet.go 第 4 行使用 nonExistentTokenABC";
  // entail 路由：初始 entail（state 只含 f.facts）答 0.1；补前提 entail（state 含 AMENDED_BAD 原文）
  // 答 null ⇒ 走 jevcheck.ts:1167 的「Jev 未给出 p 值」路径 ⇒ entailP2 缺失（本用例要打的那条路）。
  const client = new MockJevClient([
    (state, _k, instr) => {
      if (instr.includes("待核对的事实")) return 0.9;
      if (instr.includes("仅凭上述前提")) return state.includes("nonExistentTokenABC") ? null : 0.1;
      return undefined;
    },
  ]);
  const mockRunSession: RunSessionFn = async (_mr, _worker, _prompt, opts) => {
    const tool = opts.extraTools?.[0];
    if (tool) {
      await tool.execute(
        "call-1",
        { id: "F1", facts: [AMENDED_COND_A, AMENDED_COND_B, AMENDED_BAD] } as never,
        undefined as never,
        undefined as never,
        { cwd: "/repo" } as never,
      );
    }
    return { text: "", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true, structured: { accepted: true, count: 3, attempts: 1 } };
  };
  const report = await runJevCheck({
    findings: [f],
    materials,
    cfg: cfgWith({ premiseRound: { enabled: true, maxFindings: 10, concurrency: 10, perCallMs: 30_000 } }),
    workers: [{ provider: "x", model: "y", profile: "verify-worker" }],
    runSessionFn: mockRunSession,
    modelRuntime: null as never,
    cwd: "/repo",
    readRoots: [],
    deadlineMs: 90_000,
    client,
  });
  const fc = report.perFinding[f.pid]!;
  log(`（DEF-07）entail=${JSON.stringify(fc.entail)} status=${fc.status} conditionFlag=${fc.conditionFlag} added=${JSON.stringify(fc.amended?.added.map((a) => `${a.kind}/${a.status}`))}`);
  assert(fc.entail.p2 === undefined, `前提①：本轮 entailP2 缺失（jevcheck.ts:1167 p=null 路径）：${JSON.stringify(fc.entail)}`);
  assert(
    fc.amended?.added.length === 3 && fc.amended.added.some((a) => a.kind !== "condition" && a.status === "不符"),
    `前提②：补前提新增了非条件且 status="不符" 的事实：${JSON.stringify(fc.amended?.added.map((a) => [a.kind, a.status]))}`,
  );
  // ★修前：status 保持初始「前提不足」（陈旧）；修后：按并集重算 ⇒「含不符前提」（synthesizeStatus ① 档，与 p 无关）。
  assert(fc.status === "含不符前提", `★status 按并集重算为「含不符前提」（修前＝陈旧的「前提不足」）：实际 ${fc.status}`);
  assert(isAnomalous(fc) === true, `★isAnomalous=true ⇒ table_handling 必填门打开（修前 false，该开未开）：${isAnomalous(fc)}`);
  // DEF-05 既有口径不许回退：conditionFlag / conditionFactCount 仍按并集（facts 侧 0 条 condition）。
  assert(fc.conditionFlag === true, `★DEF-05 不回退：conditionFlag 按并集 = true（facts 侧只有 1 条 code）：${fc.conditionFlag}`);
  assert(conditionFactCount(fc) === 2, `★DEF-05 不回退：conditionFactCount 按并集 = 2：${conditionFactCount(fc)}`);
}

// ============================================================================
// 用例 29（2026-09-21「改 3：从哪里抄」）：核对表派生标记「须填：…」——判据必须与
// validateVerdicts 门控**同源**（BACKLOG-首次提交打回.md §6.2 两项必修前置）。
// ============================================================================
{
  log("=== 用例 29（改 3）：派生标记 须填：table_handling / 须填：conditions ×N ===");
  // 直接构造 FindingCheck（不经 checkFinding）：本用例只测渲染，状态词/条件旗标全由 fixture 精确控制。
  const rawCheck = (over: Partial<FindingCheck> & { pid: string }): FindingCheck => ({
    ref: "OK",
    facts: [],
    entail: { p1: 0.9 },
    status: "前提完备且全部相符",
    conditionFlag: false,
    calls: [],
    ...over,
  });
  const condFact = (i: number): FactCheck => ({ text: `运行时条件：C${i}`, kind: "condition", p: null, status: "条件" });

  const fNormal = mkFinding({ id: "F1", pid: "P1/F1", proposerIndex: 0 });
  const fCond = mkFinding({ id: "F2", pid: "P2/F2", proposerIndex: 1, lines: "10-11", anchor: "r.count++" });
  const fAnomal = mkFinding({ id: "F3", pid: "P2/F3", proposerIndex: 1, lines: "7-8", anchor: "no command" });
  const fBoth = mkFinding({ id: "F4", pid: "P3/F4", proposerIndex: 2, lines: "3-5", anchor: "Ratchet" });

  const checks: Record<string, FindingCheck> = {
    [fNormal.pid]: rawCheck({ pid: fNormal.pid }),
    // 条件红旗：status=条件性成立 + ref=OK + 2 条运行时条件（1 条来自 facts、1 条来自补前提）
    // —— 门控意义上**不是**异常（isAnomalous=false），但 conditions 必填门开着。
    [fCond.pid]: rawCheck({
      pid: fCond.pid,
      status: "条件性成立",
      conditionFlag: true,
      facts: [condFact(1)],
      amended: { added: [condFact(2)], ms: 1 },
    }),
    // 引用异常（anchor 未命中）→ table_handling 门开；无运行时条件 → conditions 门关。
    [fAnomal.pid]: rawCheck({ pid: fAnomal.pid, ref: "锚点未命中", status: "前提完备且全部相符" }),
    // 两者同时成立：含不符前提（table_handling 门开）+ 条件红旗 3 条（conditions 门开，N=3）。
    [fBoth.pid]: rawCheck({
      pid: fBoth.pid,
      status: "含不符前提",
      conditionFlag: true,
      facts: [condFact(1), condFact(2), condFact(3)],
    }),
  };
  const report = { perFinding: checks, duplicates: [], conflicts: [], oneSided: [] };
  const findings = [fNormal, fCond, fAnomal, fBoth] as FindingRecord[];
  const { text } = renderCheckTable(report, findings, materials, 100_000);
  const blockOf = (pid: string): string => text.split("\n\n").find((p) => p.startsWith(`【核对表 ${pid} `)) ?? "";

  const bNormal = blockOf(fNormal.pid);
  assert(bNormal.length > 0 && !bNormal.includes("须填："), `正常 finding（前提完备且全部相符 / ref=OK / 无条件红旗）**不印**任何派生标记：${JSON.stringify(bNormal)}`);

  const bCond = blockOf(fCond.pid);
  assert(
    conditionFactCount(checks[fCond.pid]) === 2,
    `（同源校验）conditionFactCount = 2（facts 1 条 + 补前提 1 条，DEF-05 口径）：${conditionFactCount(checks[fCond.pid])}`,
  );
  assert(
    bCond.includes("须填：conditions ×2"),
    `条件红旗印「须填：conditions ×N」且 N 取自同一个 conditionFactCount（=2）：${JSON.stringify(bCond)}`,
  );
  assert(
    !bCond.includes("须填：table_handling"),
    `★前置 (i)：条件性成立 + ref=OK 不触发 table_handling 门 ⇒ 不印该行（改用本文件语义更宽的布局判据就会误印）：${JSON.stringify(bCond)}`,
  );

  const bAnomal = blockOf(fAnomal.pid);
  assert(bAnomal.includes("须填：table_handling"), `引用异常（锚点未命中）印「须填：table_handling」：${JSON.stringify(bAnomal)}`);
  assert(!bAnomal.includes("须填：conditions"), `无运行时条件 ⇒ 不印 conditions 标记：${JSON.stringify(bAnomal)}`);

  const bBoth = blockOf(fBoth.pid);
  assert(
    bBoth.includes("须填：table_handling") && bBoth.includes("须填：conditions ×3"),
    `两者同时成立时两行都印（N=3）：${JSON.stringify(bBoth)}`,
  );
  assert(
    bBoth.split("\n").includes("须填：table_handling") && bBoth.split("\n").includes("须填：conditions ×3"),
    `全量块里两行各占一行（不是拼在别的行尾）：${JSON.stringify(bBoth.split("\n").filter((l) => l.startsWith("须填：")))}`,
  );

  // ★oneLiner 降级路径：renderCheckTable 超限时会把条目降成一行摘要（正常项第一步、异常项第二步），
  //   派生标记必须随降级保留，否则「从哪里抄」在裁剪后失效。
  const full = renderCheckTable(report, [fBoth], materials, 100_000);
  let degraded = "";
  for (let b = 1; b <= full.text.length; b++) {
    const r = renderCheckTable(report, [fBoth], materials, b);
    if (
      r.truncated &&
      r.text.includes("须填：table_handling") &&
      r.text.includes("须填：conditions ×3") &&
      r.text.includes("合成状态：") &&
      !r.text.includes("成立条件：") && // 一行摘要里没有全量的「成立条件：」行 ⇒ 确已降级
      !r.text.includes("…（核对表超限，已截断）") // 且不是硬截断的巧合
    ) {
      degraded = r.text;
      break;
    }
  }
  assert(
    degraded.length > 0,
    `★oneLiner 降级路径也印派生标记（预算收紧到只放得下一行摘要时仍在）：${JSON.stringify(degraded || "（未找到满足条件的预算）")}`,
  );
}

// ---------- 用例 30：★PIMOA-DEF-09（2026-09-27）——findSegsForPath 百分号解码变体（修 2） ----------
// 病理：proposer 把含空格路径写成 %20 形态（f.path / 事实引用都会），jevcheck 取材按字面找不到段 →
// truth material 为空、region state 为空，整条 finding 等于没核。修法：原路径先查，未命中再用
// percentDecodedVariant（与 submit_findings 同一口径，export 复用）解码后再查一次。边界：只追加、原路径优先。
{
  log("=== 用例 30：DEF-09 findSegsForPath 补 %20 解码变体，原路径优先 ===");
  const CWD30 = WS + "/workspace";
  const REL30 = "Claude dev paper system/PiMoa/config/models.json";
  const ABS30 = `${CWD30}/${REL30}`;
  const lines30 = ['  "providerRegistry": {', '    "minimax": {}', "  },"];
  const m30: MaterialMap = new Map([[ABS30, [seg(ABS30, REL30, "range", 40, lines30)]]]);
  for (const form of [
    WS + "/workspace/Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "./Claude%20dev%20paper%20system/PiMoa/config/models.json",
  ]) {
    const mat = findingTruthMaterial({ path: form }, m30);
    assert(mat.startsWith('40:   "providerRegistry": {') && mat.split("\n").length === 3, `f.path=「${form}」→ truth material 取到 40-42 三行`);
    const region = findingRegionState({ path: form, lines: "41" }, m30);
    assert(region.includes(REL30) && region.includes("providerRegistry"), `f.path=「${form}」→ region state 非空且指向原材料`);
  }
  // 字面空格原路径照旧命中（回归）；%2520 双重编码与 + 号仍不解码（边界 4：不动）。
  assert(findingTruthMaterial({ path: REL30 }, m30).length > 0, "字面空格 rel 照旧命中");
  assert(findingTruthMaterial({ path: "Claude%2520dev%2520paper%2520system/PiMoa/config/models.json" }, m30) === "", "%2520 双重编码仍取不到（不做多轮解码）");
  assert(findingTruthMaterial({ path: "Claude+dev+paper+system/PiMoa/config/models.json" }, m30) === "", "+ 号形态仍取不到（不当空格解）");
  // 原路径优先：材料里同时有字面 %20 的文件与解码后的文件时，f.path 写字面 %20 取字面那份。
  const LIT_REL = "a%20b/x.go";
  const DEC_REL = "a b/x.go";
  const mBoth: MaterialMap = new Map([
    [`/r/${LIT_REL}`, [seg(`/r/${LIT_REL}`, LIT_REL, "range", 1, ["literalOne"])]],
    [`/r/${DEC_REL}`, [seg(`/r/${DEC_REL}`, DEC_REL, "range", 1, ["decodedOne"])]],
  ]);
  assert(findingTruthMaterial({ path: LIT_REL }, mBoth) === "1: literalOne", "字面 %20 文件存在时原路径优先（不被解码变体抢走）");
  assert(findingTruthMaterial({ path: DEC_REL }, mBoth) === "1: decodedOne", "字面空格写法取空格那份");
  // 无材料时仍为空（不造假命中）。
  assert(findingTruthMaterial({ path: "nope%20dir/x.go" }, mBoth) === "", "解码后也不在材料里 → 空");
}

// ---------- 用例 31：JevClient.callJudge 协议层错误 fail-loud（2026-09-30，官方 client 2.0） ----------
// 契约：HTTP 非 2xx、JSON-RPC error、结构非法、id 对不上一律抛（不落成「空文本成功」）；JSON-RPC error 抛
// JevRpcError（稳定消息：code + 截断 message，不带 data）；result.isError 仍是合法工具结果。官方客户端对畸形回复
// 只报 onerror 并丢弃，jevcheck 把 schema 失败 / 未知 id 判为连接故障，立即以稳定消息失败。
type JevClientInternals = {
  callJudge(
    state: string,
    questions: Record<string, { q?: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; isError: boolean }>;
  requestOnce(
    state: string,
    questions: Record<string, { q?: JevCall["q"]; instructions: string; criteria: Record<string, string> }>,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; ms: number }>;
  consecutiveFailures: number;
  conn?: {
    client: { getProtocolEra(): string | undefined; getNegotiatedProtocolVersion(): string | undefined };
    transport: { close(): Promise<void> };
  };
  connecting?: Promise<unknown>;
};
function internals(c: JevClient): JevClientInternals {
  return c as unknown as JevClientInternals;
}
async function errOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err;
  }
}
function msgOf(e: unknown): string {
  return e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
}
const SCHEMA_RPC = "jev_judge 响应结构非法：收到未通过 JSON-RPC schema 校验的消息";
const SCHEMA_CALL = "jev_judge 响应结构非法：tools/call 结果未通过官方 CallToolResult schema 校验";
const NO_TEXT = "jev_judge 响应结构非法：非 isError 结果不含任何 text 内容";
const ID_MISMATCH = "jev_judge 响应 id 不匹配：收到对不上任何在飞请求的回复";
/** tools/call 的状态码/content-type/原始响应体全由用例决定（拿请求 id 拼）；握手走统一测试服务端。 */
async function startRawJevServer(
  respond: (id: number | undefined) => { status?: number; contentType?: string; body: string },
  era: "legacy" | "modern" | "both" = "legacy",
): Promise<JevTestServer> {
  return startJevTestServer({
    era,
    onToolCall: (p, res) => {
      const r = respond(typeof p.id === "number" ? p.id : undefined);
      res.writeHead(r.status ?? 200, { "content-type": r.contentType ?? "text/event-stream" });
      res.end(r.body);
    },
  });
}
{
  log("=== 用例 31：JevClient.callJudge 协议层错误 fail-loud（HTTP 非 2xx / JSON-RPC error / 结构非法 / 无匹配 id）===");
  const Q31 = { fact: { q: "fact" as const, ...QUESTIONS.fact } };
  const okText = "【fact】P(成立)=0.77 [用量] 输入 12 token";
  const sse = (...msgs: unknown[]): string => msgs.map((m) => `data: ${typeof m === "string" ? m : JSON.stringify(m)}\n\n`).join("");
  const okResult = { content: [{ type: "text", text: okText }] };
  const rpcErr = { code: -32602, message: "invalid params:\n  questions.fact 缺 criteria", data: { apiKey: "sk-SECRET-should-not-leak" } };
  const withClient = async (
    respond: (id: number | undefined) => { status?: number; contentType?: string; body: string },
    fn: (c: JevClient) => Promise<void>,
  ): Promise<void> => {
    JevClient.resetForTest();
    const srv = await startRawJevServer(respond);
    try {
      await fn(JevClient.shared({ url: srv.url, concurrency: 8, perCallTimeoutMs: 5000 }));
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  };

  // 1 HTTP 500：抛错、消息稳定含截断后的响应体；经 requestOnce 只记 1 次连续失败，不是 JevUnavailable。
  await withClient(
    () => ({ status: 500, contentType: "text/plain", body: "boom\n  upstream down" }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(
        e instanceof Error && e.message === "Error POSTing to endpoint: boom upstream down",
        `31-1 HTTP 500 抛稳定消息（实际 ${msgOf(e)}）`,
      );
      const e2 = await errOf(internals(c).requestOnce("s", Q31, undefined));
      assert(e2 instanceof Error && !(e2 instanceof JevUnavailable) && internals(c).consecutiveFailures === 1, `31-1 requestOnce 单次 500 只记 1 次且不是 JevUnavailable（计数 ${internals(c).consecutiveFailures}）`);
    },
  );

  // 2 HTTP 200 纯 JSON 的 JSON-RPC error：抛 JevRpcError，消息含 code/message，不带 data（密钥）。
  await withClient(
    (id) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, error: rpcErr }) }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(e instanceof JevRpcError && e.code === -32602, `31-2 纯 JSON error → JevRpcError code=-32602（实际 ${msgOf(e)}）`);
      assert(
        e instanceof Error && e.message === "jev_judge JSON-RPC 错误 code=-32602：invalid params: questions.fact 缺 criteria",
        `31-2 消息稳定（单行化）（实际 ${msgOf(e)}）`,
      );
      assert(e instanceof Error && !e.message.includes("sk-SECRET") && !e.message.includes("apiKey"), "31-2 消息不带 error.data 载荷");
    },
  );
  // id=null 的纯 JSON error：官方客户端的 JSON-RPC schema 不收 id=null 的 error → 连接故障，稳定消息立即失败。
  await withClient(
    () => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(e instanceof Error && !(e instanceof JevRpcError) && e.message === SCHEMA_RPC, `31-2b id=null 的 error → 稳定 schema 失败（实际 ${msgOf(e)}）`);
    },
  );

  // 3 SSE：keepalive/注释/无 id 进度通知之后，匹配 id 的 error → 抛 JevRpcError。
  await withClient(
    (id) => ({
      body:
        ": keepalive\n\nevent: message\n" +
        sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) +
        sse({ jsonrpc: "2.0", id, error: { code: -32000, message: "jev upstream failure" } }),
    }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(
        e instanceof JevRpcError && e.message === "jev_judge JSON-RPC 错误 code=-32000：jev upstream failure",
        `31-3 SSE 匹配 id 的 error 抛 JevRpcError（实际 ${msgOf(e)}）`,
      );
    },
  );
  // error 缺 code/message：不合 JSON-RPC schema → 立即以稳定消息失败（不挂到超时）。
  await withClient(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, error: {} }) }),
    async (c) => {
      const t0 = Date.now();
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(e instanceof Error && e.message === SCHEMA_RPC && Date.now() - t0 < 2000, `31-3b error 缺字段 → 立即稳定 schema 失败（实际 ${msgOf(e)}，${Date.now() - t0}ms）`);
    },
  );

  // 4 SSE：坏 data 行在前、匹配 id 的成功在后 → 成功；别的 id 的 error 在前 → 未知 id 连接故障，立即失败。
  await withClient(
    (id) => ({ body: "data: {not json\n\n" + sse({ jsonrpc: "2.0", id, result: okResult }) }),
    async (c) => {
      const r = await internals(c).callJudge("s", Q31, undefined);
      assert(r.text === okText && r.isError === false, `31-4 跳过坏行，取匹配 id 的成功（实际 ${JSON.stringify(r)}）`);
    },
  );
  await withClient(
    (id) => ({
      body:
        sse({ jsonrpc: "2.0", id: (id ?? 0) + 777, error: { code: -32000, message: "other request failed" } }) +
        "data: {not json\n\n" +
        sse({ jsonrpc: "2.0", id, result: okResult }),
    }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(e instanceof Error && e.message === ID_MISMATCH, `31-4 别的 id 的 error 在前 → 未知 id 连接故障（实际 ${msgOf(e)}）`);
    },
  );

  // 5 SSE：匹配 id 但既无 result 也无 error / result=null → JSON-RPC schema 失败。
  for (const [label, extra] of [
    ["无 result 无 error", {}],
    ["result=null", { result: null }],
  ] as const) {
    await withClient(
      (id) => ({ body: sse({ jsonrpc: "2.0", id, ...extra }) }),
      async (c) => {
        const e = await errOf(internals(c).callJudge("s", Q31, undefined));
        assert(e instanceof Error && !(e instanceof JevRpcError) && e.message === SCHEMA_RPC, `31-5 SSE 匹配 id ${label} → 稳定 schema 失败（实际 ${msgOf(e)}）`);
      },
    );
  }

  // 6 无匹配：别的 id / {} / id=null 带结果 / SSE 只有别的 id / 空响应体 → 抛错；JSON 批量数组官方客户端接受。
  const cases6: Array<[string, (id: number | undefined) => { contentType?: string; body: string }, string]> = [
    ["纯 JSON 别的 id", (id) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: (id ?? 0) + 1, result: okResult }) }), ID_MISMATCH],
    ["纯 JSON {}", () => ({ contentType: "application/json", body: "{}" }), SCHEMA_RPC],
    ["纯 JSON id=null 带结果", () => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: null, result: okResult }) }), SCHEMA_RPC],
    ["SSE 只有别的 id", (id) => ({ body: sse({ jsonrpc: "2.0", id: (id ?? 0) + 5, result: okResult }) }), ID_MISMATCH],
    ["空响应体", () => ({ contentType: "application/json", body: "" }), "jev_judge 响应解析失败：响应体不是合法 JSON"],
    ["纯 JSON 无 id", () => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", result: okResult }) }), SCHEMA_RPC],
  ];
  for (const [label, respond, want] of cases6) {
    await withClient(respond, async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q31, undefined));
      assert(e instanceof Error && e.message === want, `31-6 ${label} → 抛「${want}」（实际 ${msgOf(e)}）`);
    });
  }
  await withClient(
    (id) => ({ contentType: "application/json", body: JSON.stringify([{ jsonrpc: "2.0", id, result: okResult }]) }),
    async (c) => {
      const r = await internals(c).callJudge("s", Q31, undefined);
      assert(r.text === okText && r.isError === false, `31-6 纯 JSON 批量数组（单元素、id 匹配）官方客户端照收（实际 ${JSON.stringify(r)}）`);
    },
  );

  // 7 result.isError 仍是合法工具结果：callJudge 照常返回，requestOnce 走既有「非限流 isError」分支，不计连续失败。
  for (const [label, body] of [
    ["SSE", (id: number | undefined) => ({ body: sse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "上游模型报错" }], isError: true } }) })],
    ["纯 JSON", (id: number | undefined) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "上游模型报错" }], isError: true } }) })],
  ] as const) {
    await withClient(body, async (c) => {
      const r = await internals(c).callJudge("s", Q31, undefined);
      assert(r.isError === true && r.text === "上游模型报错", `31-7 ${label} isError 由 callJudge 原样返回（实际 ${JSON.stringify(r)}）`);
      const e = await errOf(internals(c).requestOnce("s", Q31, undefined));
      assert(
        e instanceof Error && !(e instanceof JevRpcError) && e.message === "jev_judge isError（非限流）：上游模型报错" && internals(c).consecutiveFailures === 0,
        `31-7 ${label} requestOnce 走非限流 isError 分支、不计连续失败（实际 ${msgOf(e)}，计数 ${internals(c).consecutiveFailures}）`,
      );
    });
  }

  // 8 合法 SSE / 纯 JSON 成功不变：noul 拿到 p，计数清零。
  for (const [label, body] of [
    ["SSE", (id: number | undefined) => ({ body: `: ping\n\n${sse({ jsonrpc: "2.0", id, result: okResult })}` })],
    ["纯 JSON", (id: number | undefined) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result: okResult }) })],
  ] as const) {
    await withClient(body, async (c) => {
      internals(c).consecutiveFailures = 2;
      const r = await c.noul("fact", "s", 1);
      assert(r.p === 0.77 && r.calls.length === 1 && internals(c).consecutiveFailures === 0, `31-8 ${label} 成功路径不变：p=0.77、计数清零（实际 p=${r.p}，计数 ${internals(c).consecutiveFailures}）`);
    });
  }

  // 9 error 不再落成空文本成功：ask 不产出 calls/p；每次请求只记 1 次（2 次不抛，第 3 次才 JevUnavailable）。
  await withClient(
    (id) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, error: rpcErr }) }),
    async (c) => {
      const r = await c.noul("fact", "s", 2);
      assert(r.p === null && r.calls.length === 0, `31-9 JSON-RPC error 不产出 p/calls（实际 ${JSON.stringify(r)}）`);
      assert(internals(c).consecutiveFailures === 2, `31-9 两次请求各记 1 次、无重复计数（实际 ${internals(c).consecutiveFailures}）`);
      const e = await errOf(c.noul("fact", "s", 1));
      assert(
        e instanceof JevUnavailable && e.message === "Jev 连接失败连续 3 次：jev_judge JSON-RPC 错误 code=-32602：invalid params: questions.fact 缺 criteria",
        `31-9 第 3 次才由既有外层逻辑判 JevUnavailable（实际 ${msgOf(e)}）`,
      );
    },
  );
  await withClient(
    () => ({ contentType: "application/json", body: "{}" }),
    async (c) => {
      const r = await c.noul("fact", "s", 1);
      assert(r.p === null && r.calls.length === 0 && internals(c).consecutiveFailures === 1, `31-9 纯 JSON {} 不再是空文本成功：p=null、只记 1 次（实际 p=${r.p}，计数 ${internals(c).consecutiveFailures}）`);
    },
  );

  // 10 result 结构 fail-loud：官方 CallToolResult schema 先校验，再由 PiMoa 钉「非 isError 须有 text」；消息稳定不带载荷。
  const shapeCases: Array<[string, unknown, string]> = [
    ["result=[]", [], SCHEMA_RPC],
    ["result=字符串", "sk-SECRET-payload", SCHEMA_RPC],
    ["result={}", {}, NO_TEXT],
    ["content=[]", { content: [] }, NO_TEXT],
    ["content 是字符串", { content: "sk-SECRET-payload" }, SCHEMA_CALL],
    ["只有合法 image 项", { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }, NO_TEXT],
    ["image 项 data 非 base64", { content: [{ type: "image", data: "sk-SECRET-payload", mimeType: "image/png" }] }, SCHEMA_CALL],
    ["content 项为 null", { content: [{ type: "text", text: okText }, null] }, SCHEMA_CALL],
    ["content 项为数组", { content: [["text", okText]] }, SCHEMA_CALL],
    ["content 项缺 type", { content: [{ text: okText }] }, SCHEMA_CALL],
    ["text 项 text 非字符串", { content: [{ type: "text", text: 42 }] }, SCHEMA_CALL],
    ["text 项缺 text", { content: [{ type: "text" }] }, SCHEMA_CALL],
    ["isError 非布尔", { content: [{ type: "text", text: okText }], isError: "true" }, SCHEMA_CALL],
    ["isError=true 但项畸形", { isError: true, content: [{ type: 1 }] }, SCHEMA_CALL],
  ];
  for (const [label, result, want] of shapeCases) {
    for (const [transport, respond] of [
      ["SSE", (id: number | undefined) => ({ body: sse({ jsonrpc: "2.0", id, result }) })],
      ["纯 JSON", (id: number | undefined) => ({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id, result }) })],
    ] as const) {
      await withClient(respond, async (c) => {
        const e = await errOf(internals(c).callJudge("s", Q31, undefined));
        assert(
          e instanceof Error && !(e instanceof JevRpcError) && e.message === want && !e.message.includes("sk-SECRET"),
          `31-10 ${transport} ${label} → 抛「${want}」且不带载荷（实际 ${msgOf(e)}）`,
        );
      });
    }
  }
  // result={} 经 noul 不再成功：p=null、只记 1 次连续失败。
  await withClient(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, result: {} }) }),
    async (c) => {
      const r = await c.noul("fact", "s", 1);
      assert(r.p === null && r.calls.length === 0 && internals(c).consecutiveFailures === 1, `31-10 result={} 不再是空文本成功：p=null、只记 1 次（实际 p=${r.p}，计数 ${internals(c).consecutiveFailures}）`);
    },
  );
  // 合法形状：非 text 项与 text 项混排、项与 result 带未知额外字段 → 只收 text、照常成功；isError=true 且 content 缺/[] 仍是合法工具结果。
  await withClient(
    (id) => ({
      body: sse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "image", data: "xx", mimeType: "image/png" },
            { type: "text", text: okText, annotations: { audience: ["user"] } },
          ],
          structuredContent: { any: 1 },
          _meta: { x: true },
        },
      }),
    }),
    async (c) => {
      const r = await internals(c).callJudge("s", Q31, undefined);
      assert(r.text === okText && r.isError === false, `31-10 混排+额外字段 → 只收 text 成功（实际 ${JSON.stringify(r)}）`);
    },
  );
  for (const [label, result] of [
    ["content=[]", { content: [], isError: true }],
    ["content 缺", { isError: true }],
  ] as const) {
    await withClient(
      (id) => ({ body: sse({ jsonrpc: "2.0", id, result }) }),
      async (c) => {
        const r = await internals(c).callJudge("s", Q31, undefined);
        assert(r.isError === true && r.text === "", `31-10 isError=true 且 ${label} 仍是合法工具结果（实际 ${JSON.stringify(r)}）`);
        const e = await errOf(internals(c).requestOnce("s", Q31, undefined));
        assert(
          e instanceof Error && e.message === "jev_judge isError（非限流）：" && internals(c).consecutiveFailures === 0,
          `31-10 isError=true ${label} 走非限流 isError 分支、不计连续失败（实际 ${msgOf(e)}，计数 ${internals(c).consecutiveFailures}）`,
        );
      },
    );
  }
}

// ---------- 用例 32：单次调用超时/外部 abort 覆盖读体阶段（2026-09-30 r2） ----------
// 契约：服务端发完头再挂住响应体时，单次调用超时（SDK timeout=perCallTimeoutMs）与外部 abort 都要及时中断，
// 一律按 AbortError 抛（不计连续失败）、信号量释放。每个断言都套一层守卫超时，卡死时判失败而不是整个测试挂住。
async function startHangingJevServer(
  status: number,
  era: "legacy" | "modern" = "legacy",
): Promise<{ url: string; headersSent: () => Promise<void>; close: () => Promise<void> }> {
  // 第 n 次调用 headersSent() 等第 n 个 tools/call 的响应头发出（计数式，不丢先到的通知）。
  let sent = 0;
  let seen = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const srv = await startJevTestServer({
    era,
    onToolCall: (_p, res) => {
      // 只发响应头 + 半截响应体，永不结束。
      res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "text/plain" });
      res.write(status === 200 ? ": keepalive\n\n" : "partial error body");
      sent++;
      for (const w of waiters.filter((x) => x.n <= sent)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    },
  });
  return {
    url: srv.url,
    headersSent: () => {
      const n = ++seen;
      return sent >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }));
    },
    close: srv.close,
  };
}
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 守卫：p 在 ms 内未结束则返回 "hung"（不让无限挂起拖死整个测试）。 */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"hung">((resolve) => (t = setTimeout(() => resolve("hung"), ms)));
  try {
    return await Promise.race([errOf(p), guard]);
  } finally {
    clearTimeout(t);
  }
}
{
  log("=== 用例 32：单次调用超时/外部 abort 覆盖读体阶段（响应头已到、响应体挂住）===");
  const Q32 = { fact: { q: "fact" as const, ...QUESTIONS.fact } };
  const semActive = (c: JevClient): number => (c as unknown as { sem: { active: number } }).sem.active;

  // 1 响应体挂住：perCallTimeout=300ms 必须及时中断（有界耗时），抛 AbortError、信号量释放、不计连续失败。
  for (const [status, era] of [
    [200, "legacy"],
    [500, "legacy"],
    [200, "modern"],
  ] as const) {
    const tag = `HTTP ${status}/${era}`;
    JevClient.resetForTest();
    const srv = await startHangingJevServer(status, era);
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 1, perCallTimeoutMs: 300 });
      internals(c).consecutiveFailures = 1;
      const t0 = Date.now();
      const e = await settleWithin(internals(c).requestOnce("s", Q32, undefined), 5000);
      const elapsed = Date.now() - t0;
      assert(e !== "hung", `32-1 ${tag} 响应体挂住：超时后不再无限卡住（实际 ${e === "hung" ? "5s 守卫到点仍未结束" : "已结束"}）`);
      assert(
        e instanceof DOMException && e.name === "AbortError" && elapsed >= 250 && elapsed < 2000,
        `32-1 ${tag} 读体阶段超时及时抛 AbortError（实际 ${msgOf(e)}，耗时 ${elapsed}ms）`,
      );
      const headersArrived = await Promise.race([srv.headersSent().then(() => true), sleepMs(0).then(() => false)]);
      assert(headersArrived, `32-1 ${tag} 前置：超时发生在响应头已到之后（读体阶段），不是 fetch 阶段`);
      assert(semActive(c) === 0, `32-1 ${tag} 超时后信号量已释放（实际 active=${semActive(c)}）`);
      assert(internals(c).consecutiveFailures === 1, `32-1 ${tag} 超时按既有口径不计连续失败（实际 ${internals(c).consecutiveFailures}）`);
      if (status === 200) {
        // concurrency=1：信号量若泄漏，第二次调用会卡在 acquire；这里仍应在超时内结束。
        const e2 = await settleWithin(internals(c).requestOnce("s", Q32, undefined), 5000);
        assert(e2 instanceof DOMException && e2.name === "AbortError", `32-1 ${tag} concurrency=1 第二次调用仍能拿到信号量并按时超时（实际 ${e2 === "hung" ? "hung" : msgOf(e2)}）`);
      }
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 2 外部 AbortSignal 在响应头到达后才 abort：及时中断读体、抛 AbortError、不计连续失败、信号量释放；
  //   经 noul 则直接结束采样（p=null）而非 JevUnavailable。
  for (const era of ["legacy", "modern"] as const) {
    JevClient.resetForTest();
    const srv = await startHangingJevServer(200, era);
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 1, perCallTimeoutMs: 30000 });
      internals(c).consecutiveFailures = 2;
      const ac = new AbortController();
      const pending = settleWithin(internals(c).requestOnce("s", Q32, ac.signal), 5000);
      await srv.headersSent();
      await sleepMs(50);
      const t0 = Date.now();
      ac.abort();
      const e = await pending;
      const elapsed = Date.now() - t0;
      assert(
        e instanceof DOMException && e.name === "AbortError" && elapsed < 1000,
        `32-2 ${era} 响应头到后外部 abort：及时抛 AbortError（实际 ${e === "hung" ? "hung" : msgOf(e)}，abort 后 ${elapsed}ms）`,
      );
      assert(internals(c).consecutiveFailures === 2, `32-2 ${era} 外部 abort 不计连续失败（实际 ${internals(c).consecutiveFailures}）`);
      assert(semActive(c) === 0, `32-2 ${era} 外部 abort 后信号量已释放（实际 active=${semActive(c)}）`);

      const ac2 = new AbortController();
      const pending2 = settleWithin(c.noul("fact", "s", 3, ac2.signal), 5000);
      await srv.headersSent();
      await sleepMs(50);
      ac2.abort();
      const r2 = await pending2;
      assert(r2 === undefined, `32-2 ${era} noul 在读体阶段被外部 abort：正常结束采样、不抛 JevUnavailable（实际 ${r2 === "hung" ? "hung" : msgOf(r2)}）`);
      assert(internals(c).consecutiveFailures === 2 && semActive(c) === 0, `32-2 ${era} noul 外部 abort 后计数不变、信号量释放（实际 计数 ${internals(c).consecutiveFailures}，active=${semActive(c)}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }
}

// ---------- 用例 33：SSE 同 id 多条终态行（2026-09-30 r2） ----------
// 契约：第一条可解析、id 匹配的 data 行即权威终态；其后同 id 的行一律忽略（不覆盖、不补救、不据此判连接故障）。
{
  log("=== 用例 33：SSE 同 id 多条终态行——第一条匹配即权威，后到的忽略 ===");
  const Q33 = { fact: { q: "fact" as const, ...QUESTIONS.fact } };
  const sse = (...msgs: unknown[]): string => msgs.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
  const text = (t: string): { content: Array<{ type: string; text: string }> } => ({ content: [{ type: "text", text: t }] });
  const run = async (respond: (id: number | undefined) => { body: string }, fn: (c: JevClient) => Promise<void>): Promise<void> => {
    JevClient.resetForTest();
    const srv = await startRawJevServer(respond);
    try {
      await fn(JevClient.shared({ url: srv.url, concurrency: 8, perCallTimeoutMs: 5000 }));
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  };
  await run(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, result: text("first") }, { jsonrpc: "2.0", id, result: text("second") }) }),
    async (c) => {
      const r = await internals(c).callJudge("s", Q33, undefined);
      assert(r.text === "first" && r.isError === false, `33-1 两条同 id 成功：取第一条（实际 ${JSON.stringify(r)}）`);
      const r2 = await internals(c).callJudge("s", Q33, undefined);
      assert(r2.text === "first", `33-1 迟到的同 id 重复回复不把连接判坏：下一次调用照常成功（实际 ${JSON.stringify(r2)}）`);
    },
  );
  await run(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, error: { code: -32000, message: "first failed" } }, { jsonrpc: "2.0", id, result: text("second") }) }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q33, undefined));
      assert(e instanceof JevRpcError && e.message === "jev_judge JSON-RPC 错误 code=-32000：first failed", `33-2 第一条同 id 是 error：照抛，后到的成功不补救（实际 ${msgOf(e)}）`);
    },
  );
  await run(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, result: text("first") }, { jsonrpc: "2.0", id, error: { code: -32000, message: "late" } }) }),
    async (c) => {
      const r = await internals(c).callJudge("s", Q33, undefined);
      assert(r.text === "first", `33-3 第一条同 id 成功、后到 error：忽略后到的（实际 ${JSON.stringify(r)}）`);
    },
  );
  await run(
    (id) => ({ body: sse({ jsonrpc: "2.0", id, result: {} }, { jsonrpc: "2.0", id, result: text("second") }) }),
    async (c) => {
      const e = await errOf(internals(c).callJudge("s", Q33, undefined));
      assert(e instanceof Error && e.message === NO_TEXT, `33-4 第一条同 id 结构非法：照抛，后到的不补救（实际 ${msgOf(e)}）`);
    },
  );
}

// ---------- 用例 34：协议代协商矩阵（clientMode × 服务端协议代） ----------
{
  log("=== 用例 34：协议代协商矩阵 auto/modern/legacy × legacy/modern/both ===");
  const handler = (p: JevRpcReq): { text: string } => ({
    text: Object.keys(p.params?.arguments?.questions ?? {}).map((k) => `【${k}】P(成立)=0.61`).join(" "),
  });
  type Want = { era: "legacy" | "modern"; version: string; discover: number; initialize: number } | "fail-era" | "fail-rpc";
  const L = { era: "legacy" as const, version: "2025-11-25" };
  const M = { era: "modern" as const, version: JEV_MODERN };
  const matrix: Array<[JevcheckCfg["clientMode"], "legacy" | "modern" | "both", Want]> = [
    ["auto", "legacy", { ...L, discover: 1, initialize: 1 }],
    ["auto", "modern", { ...M, discover: 1, initialize: 0 }],
    ["auto", "both", { ...M, discover: 1, initialize: 0 }],
    ["modern", "modern", { ...M, discover: 1, initialize: 0 }],
    ["modern", "both", { ...M, discover: 1, initialize: 0 }],
    ["modern", "legacy", "fail-era"],
    ["legacy", "legacy", { ...L, discover: 0, initialize: 1 }],
    ["legacy", "both", { ...L, discover: 0, initialize: 1 }],
    ["legacy", "modern", "fail-rpc"],
  ];
  for (const [mode, era, want] of matrix) {
    const tag = `clientMode=${mode} × 服务端 ${era}`;
    JevClient.resetForTest();
    const srv = await startMockJevServer(handler, era);
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 3000, clientMode: mode });
      if (typeof want === "object") {
        const r = await c.noul("fact", "s", 2);
        const conn = internals(c).conn;
        assert(r.p === 0.61 && r.calls.length === 2, `34 ${tag}：两次调用成功 p=0.61（实际 p=${r.p}）`);
        assert(
          conn?.client.getProtocolEra() === want.era && conn?.client.getNegotiatedProtocolVersion() === want.version,
          `34 ${tag}：协商到 ${want.version}/${want.era}（实际 ${conn?.client.getNegotiatedProtocolVersion()}/${conn?.client.getProtocolEra()}）`,
        );
        assert(
          srv.stats.discover === want.discover && srv.stats.initialize === want.initialize && srv.stats.toolCalls === 2,
          `34 ${tag}：握手只做一次、两次调用共享连接（discover=${srv.stats.discover} initialize=${srv.stats.initialize} toolCalls=${srv.stats.toolCalls}）`,
        );
        const hdrOk = srv.stats.toolCallHeaders.every((h) =>
          want.era === "modern" ? h.protocolVersion === JEV_MODERN && h.sessionId === undefined : h.protocolVersion === want.version && typeof h.sessionId === "string",
        );
        assert(hdrOk, `34 ${tag}：tools/call 请求头符合协议代（${JSON.stringify(srv.stats.toolCallHeaders)}）`);
      } else {
        const e = await errOf(internals(c).callJudge("s", { fact: { q: "fact", ...QUESTIONS.fact } }, undefined));
        if (want === "fail-era") {
          assert(
            e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed,
            `34 ${tag}：钉 modern 遇 legacy-only 服务端 → SdkError EraNegotiationFailed（实际 ${msgOf(e)}）`,
          );
        } else {
          assert(e instanceof JevRpcError && e.code === -32601, `34 ${tag}：legacy 遇 modern-only 服务端 → JevRpcError -32601（实际 ${msgOf(e)}）`);
        }
        assert(srv.stats.toolCalls === 0, `34 ${tag}：握手失败在 tools/call 之前（toolCalls=${srv.stats.toolCalls}）`);
        assert(internals(c).conn === undefined && internals(c).connecting === undefined, `34 ${tag}：握手失败不留残连接`);
        const r = await c.noul("fact", "s", 1);
        assert(r.p === null && internals(c).consecutiveFailures === 1, `34 ${tag}：经 noul 按单样本失败、记 1 次连续失败（实际 p=${r.p}，计数 ${internals(c).consecutiveFailures}）`);
      }
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }
}

// ---------- 用例 35：modern 协议代下的错误/限流/超时/进度/abort 语义与 legacy 一致 ----------
{
  log("=== 用例 35：modern 协议代下 JSON-RPC error / 限流 / isError / 超时 / 进度重置 / abort ===");
  const Q35 = { fact: { q: "fact" as const, ...QUESTIONS.fact } };
  const okText = "【fact】P(成立)=0.83";
  const sseFrame = (p: JevRpcReq, modern: boolean, result: Record<string, unknown>): string => `data: ${toolFrame(p, modern, result)}\n\n`;
  const withSrv = async (
    era: "legacy" | "modern",
    onToolCall: (p: JevRpcReq, res: ServerResponse, modern: boolean) => void,
    perCallTimeoutMs: number,
    fn: (c: JevClient, srv: JevTestServer) => Promise<void>,
  ): Promise<void> => {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era, onToolCall });
    try {
      await fn(JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs, clientMode: era }), srv);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  };

  // JSON-RPC error：立即 JevRpcError、不带 data。
  await withSrv(
    "modern",
    (p, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: p.id, error: { code: -32602, message: "bad questions", data: { apiKey: "sk-SECRET-x" } } }));
    },
    3000,
    async (c) => {
      const t0 = Date.now();
      const e = await errOf(internals(c).callJudge("s", Q35, undefined));
      assert(
        e instanceof JevRpcError && e.code === -32602 && e.message === "jev_judge JSON-RPC 错误 code=-32602：bad questions" && !e.message.includes("sk-SECRET") && Date.now() - t0 < 2000,
        `35-1 modern JSON-RPC error → 立即 JevRpcError、不带载荷（实际 ${msgOf(e)}）`,
      );
    },
  );

  // 限流两次后成功：throttledCount=2、不计连续失败。
  {
    let n = 0;
    await withSrv(
      "modern",
      (p, res, modern) => {
        n++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          n <= 2
            ? sseFrame(p, modern, { content: [{ type: "text", text: "在飞请求已达上限，请稍后" }], isError: true })
            : sseFrame(p, modern, { content: [{ type: "text", text: okText }] }),
        );
      },
      3000,
      async (c) => {
        internals(c).consecutiveFailures = 2;
        const r = await c.noul("fact", "s", 1);
        assert(r.p === 0.83 && c.throttledCount === 2 && internals(c).consecutiveFailures === 0, `35-2 modern 限流两次后成功（p=${r.p} throttled=${c.throttledCount} 计数 ${internals(c).consecutiveFailures}）`);
      },
    );
  }

  // 非限流 isError：单样本失败、不计连续失败。
  await withSrv(
    "modern",
    (p, res, modern) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseFrame(p, modern, { content: [{ type: "text", text: "上游模型报错" }], isError: true }));
    },
    3000,
    async (c) => {
      const e = await errOf(internals(c).requestOnce("s", Q35, undefined));
      assert(
        e instanceof Error && e.message === "jev_judge isError（非限流）：上游模型报错" && internals(c).consecutiveFailures === 0,
        `35-3 modern 非限流 isError（实际 ${msgOf(e)}，计数 ${internals(c).consecutiveFailures}）`,
      );
    },
  );

  // 进度重置超时：每 150ms 发一次 progress、共约 900ms 才回结果，perCallTimeoutMs=400 → 成功；不发 progress → AbortError。
  for (const era of ["legacy", "modern"] as const) {
    for (const withProgress of [true, false]) {
      const tag = `${era} ${withProgress ? "带进度" : "无进度"}`;
      const timers = new Set<ReturnType<typeof setInterval>>();
      let tokenSeen: unknown;
      await withSrv(
        era,
        (p, res, modern) => {
          tokenSeen = p.params?._meta?.progressToken;
          res.writeHead(200, { "content-type": "text/event-stream" });
          let k = 0;
          const iv = setInterval(() => {
            k++;
            if (k < 6) {
              if (withProgress && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: tokenSeen, progress: k } })}\n\n`);
              }
              return;
            }
            clearInterval(iv);
            timers.delete(iv);
            if (!res.writableEnded && !res.destroyed) res.end(sseFrame(p, modern, { content: [{ type: "text", text: okText }] }));
          }, 150);
          timers.add(iv);
        },
        400,
        async (c) => {
          const t0 = Date.now();
          const e = await settleWithin(internals(c).callJudge("s", Q35, undefined), 5000);
          const elapsed = Date.now() - t0;
          if (withProgress) {
            assert(e === undefined && elapsed >= 800, `35-4 ${tag}：进度通知重置超时，约 900ms 后拿到结果（实际 ${msgOf(e)}，${elapsed}ms）`);
            assert(tokenSeen !== undefined, `35-4 ${tag}：请求带 progressToken（实际 ${String(tokenSeen)}）`);
          } else {
            assert(e instanceof DOMException && e.name === "AbortError" && elapsed < 800, `35-4 ${tag}：无进度 → 400ms 超时抛 AbortError（实际 ${msgOf(e)}，${elapsed}ms）`);
          }
        },
      );
      for (const t of timers) clearInterval(t);
    }
  }
}

// ---------- 用例 36：共享连接的并发懒连接 / 握手失败 / 断线重连 / 会话失效 / close / 连接故障 ----------
{
  log("=== 用例 36：共享连接生命周期（并发只握手一次、失败不留残连接、断线重连、会话失效、close 后可用、连接故障只计一次）===");
  const handler = (p: JevRpcReq): { text: string } => ({
    text: Object.keys(p.params?.arguments?.questions ?? {}).map((k) => `【${k}】P(成立)=0.7`).join(" "),
  });
  const mockOnToolCall = (p: JevRpcReq, res: ServerResponse, modern: boolean): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${toolFrame(p, modern, { content: [{ type: "text", text: handler(p).text }] })}\n\n`);
  };

  // 1 并发懒连接：6 个 noul 同时发、握手延迟 150ms → 只握手一次。
  for (const [mode, era, wantDiscover, wantInit] of [
    ["auto", "legacy", 1, 1],
    ["modern", "modern", 1, 0],
    ["legacy", "legacy", 0, 1],
  ] as const) {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era, onToolCall: mockOnToolCall, handshakeDelayMs: 150 });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 8, perCallTimeoutMs: 3000, clientMode: mode });
      const rs = await Promise.all(Array.from({ length: 6 }, () => c.noul("fact", "s", 1)));
      assert(rs.every((r) => r.p === 0.7), `36-1 ${mode}×${era} 6 路并发全部成功（${rs.map((r) => r.p).join(",")}）`);
      assert(
        srv.stats.discover === wantDiscover && srv.stats.initialize === wantInit && srv.stats.toolCalls === 6,
        `36-1 ${mode}×${era} 并发首调只握手一次（discover=${srv.stats.discover} initialize=${srv.stats.initialize} toolCalls=${srv.stats.toolCalls}）`,
      );
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 2 initialize 失败一次：不留残连接，下一次重新握手成功。
  {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era: "legacy", onToolCall: mockOnToolCall, failInitialize: 1 });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 3000, clientMode: "legacy" });
      const r1 = await c.noul("fact", "s", 1);
      assert(r1.p === null && internals(c).consecutiveFailures === 1, `36-2 首次握手失败 → 单样本失败、记 1 次（p=${r1.p} 计数 ${internals(c).consecutiveFailures}）`);
      assert(internals(c).conn === undefined && internals(c).connecting === undefined, "36-2 握手失败后无残连接、无挂起握手");
      const r2 = await c.noul("fact", "s", 1);
      assert(r2.p === 0.7 && srv.stats.initialize === 2 && internals(c).consecutiveFailures === 0, `36-2 下一次重新握手成功（p=${r2.p} initialize=${srv.stats.initialize}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 3 连接被关闭（onclose）→ 摘除共享位，下一次重连。
  for (const [mode, era] of [
    ["legacy", "legacy"],
    ["modern", "modern"],
  ] as const) {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era, onToolCall: mockOnToolCall });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 3000, clientMode: mode });
      assert((await c.noul("fact", "s", 1)).p === 0.7, `36-3 ${mode} 首调成功`);
      const conn = internals(c).conn;
      assert(conn !== undefined, `36-3 ${mode} 成功后持有共享连接`);
      await conn!.transport.close();
      assert(internals(c).conn === undefined, `36-3 ${mode} transport 关闭 → onclose 摘除共享连接`);
      const r = await c.noul("fact", "s", 1);
      const hs = mode === "modern" ? srv.stats.discover : srv.stats.initialize;
      assert(r.p === 0.7 && hs === 2 && internals(c).conn !== undefined && internals(c).conn !== conn, `36-3 ${mode} 下一次重新握手（握手次数 ${hs}）并成功（p=${r.p}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 4 会话失效（Jev 重启，旧 Mcp-Session-Id 回 404）：该连接退役，之后重新握手恢复。
  {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era: "legacy", onToolCall: mockOnToolCall });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 3000, clientMode: "auto" });
      assert((await c.noul("fact", "s", 1)).p === 0.7, "36-4 首调成功");
      srv.expireSessions();
      const e = await errOf(internals(c).requestOnce("s", { fact: { q: "fact", ...QUESTIONS.fact } }, undefined));
      assert(
        e instanceof Error && !(e instanceof DOMException) && internals(c).consecutiveFailures === 1,
        `36-4 会话失效 → 本次失败、记 1 次（实际 ${msgOf(e)}，计数 ${internals(c).consecutiveFailures}）`,
      );
      assert(internals(c).conn === undefined, "36-4 会话失效后连接已退役");
      const r = await c.noul("fact", "s", 1);
      assert(r.p === 0.7 && srv.stats.initialize === 2, `36-4 下一次重新握手恢复（p=${r.p} initialize=${srv.stats.initialize}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 5 close() 之后仍可服务迟到调用：按需新建连接、用完即关，不留常驻会话。
  {
    JevClient.resetForTest();
    const srv = await startJevTestServer({ era: "legacy", onToolCall: mockOnToolCall });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 3000 });
      assert((await c.noul("fact", "s", 1)).p === 0.7, "36-5 close 前成功");
      await c.close();
      assert(internals(c).conn === undefined, "36-5 close 后共享连接已摘除");
      const r = await c.noul("fact", "s", 1);
      assert(r.p === 0.7 && internals(c).conn === undefined && srv.stats.initialize === 2, `36-5 close 后迟到调用仍成功、且不留常驻连接（p=${r.p} initialize=${srv.stats.initialize}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }

  // 6 连接故障：两个在飞调用，第一个的流里收到对不上号的回复 → 两个都立即以同一稳定错误失败、只计一次；下次重新握手。
  {
    JevClient.resetForTest();
    let n = 0;
    const srv = await startJevTestServer({
      era: "legacy",
      onToolCall: (p, res, modern) => {
        n++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (n === 1) {
          setTimeout(() => res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { content: [{ type: "text", text: "x" }] } })}\n\n`), 150);
        } else if (n === 2) {
          res.write(": keepalive\n\n"); // 挂住，靠连接故障中止
        } else {
          res.end(`data: ${toolFrame(p, modern, { content: [{ type: "text", text: handler(p).text }] })}\n\n`);
        }
      },
    });
    try {
      const c = JevClient.shared({ url: srv.url, concurrency: 4, perCallTimeoutMs: 5000, clientMode: "legacy" });
      const Q = { fact: { q: "fact" as const, ...QUESTIONS.fact } };
      const t0 = Date.now();
      const [e1, e2] = await Promise.all([
        settleWithin(internals(c).requestOnce("s", Q, undefined), 4000),
        settleWithin(internals(c).requestOnce("s", Q, undefined), 4000),
      ]);
      const elapsed = Date.now() - t0;
      assert(
        e1 instanceof Error && e2 instanceof Error && e1.message === ID_MISMATCH && e2.message === ID_MISMATCH && elapsed < 2000,
        `36-6 两个在飞调用都立即以「id 不匹配」失败（${msgOf(e1)} / ${msgOf(e2)}，${elapsed}ms）`,
      );
      assert(internals(c).consecutiveFailures === 1, `36-6 同一连接故障只计一次连续失败（实际 ${internals(c).consecutiveFailures}）`);
      const r = await c.noul("fact", "s", 1);
      assert(r.p === 0.7 && srv.stats.initialize === 2, `36-6 下一次重新握手恢复（p=${r.p} initialize=${srv.stats.initialize}）`);
    } finally {
      JevClient.resetForTest();
      await srv.close();
    }
  }
}

// ---------- 用例 36-7：握手结果 schema 非法单独标注（不冒充 tools/call 结果非法） ----------
{
  log("=== 用例 36-7：initialize 结果不合 schema → 握手专属稳定消息，不发 tools/call ===");
  let toolCalls = 0;
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (ch: Buffer) => chunks.push(ch));
    req.on("end", () => {
      let p: JevRpcReq = {};
      try {
        p = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JevRpcReq;
      } catch {
        /* 忽略 */
      }
      if (p.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "Mcp-Session-Id": "bad-init" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: p.id, result: {} }));
        return;
      }
      if (p.method === "tools/call") toolCalls++;
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    JevClient.resetForTest();
    const c = JevClient.shared({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, concurrency: 2, perCallTimeoutMs: 2000, clientMode: "legacy" });
    const e = await errOf(internals(c).requestOnce("s", { fact: { q: "fact", ...QUESTIONS.fact } }, undefined));
    assert(
      e instanceof Error && e.message === "jev_judge 握手响应结构非法：server/discover 或 initialize 结果未通过官方 schema 校验",
      `36-7 initialize result={} → 握手专属消息（实际 ${msgOf(e)}）`,
    );
    assert(toolCalls === 0 && internals(c).consecutiveFailures === 1 && internals(c).conn === undefined, `36-7 不发 tools/call、记 1 次、无残连接（toolCalls=${toolCalls} 计数 ${internals(c).consecutiveFailures}）`);
  } finally {
    JevClient.resetForTest();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

// ---------- 用例 37：配置层 jevcheck.clientMode（缺省 auto、真配置显式 auto、非法值加载期 fail-loud） ----------
{
  log("=== 用例 37：jevcheck.clientMode 配置解析 ===");
  assert(JEVCHECK_DEFAULTS.clientMode === "auto", `37 JEVCHECK_DEFAULTS.clientMode 缺省 auto（实际 ${JEVCHECK_DEFAULTS.clientMode}）`);
  const cfgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "config");
  const realYaml = readFileSync(join(cfgDir, "moa.yaml"), "utf8");
  assert(/^ {2}clientMode: auto\b/m.test(realYaml), "37 config/moa.yaml 显式写 clientMode: auto");
  // 加载期不变量要求各 provider 的 apiKeyEnv 已设：只设占位值，用完恢复（不读取、不打印真实密钥）。
  const saved = new Map<string, string | undefined>();
  for (const m of realYaml.matchAll(/apiKeyEnv:\s*"?(\w+)/g)) {
    const k = m[1]!;
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (process.env[k] === undefined) process.env[k] = "placeholder-for-config-test";
  }
  const tmp = mkdtempSync(join(tmpdir(), "jeva-cfg-"));
  try {
    assert(loadConfig({ moaYaml: join(cfgDir, "moa.yaml") }).jevcheck.clientMode === "auto", "37 真实 moa.yaml 加载得 clientMode=auto");
    copyFileSync(join(cfgDir, "models.json"), join(tmp, "models.json"));
    const variants: Array<[string, string, string | "ConfigError"]> = [
      ["删掉该键", realYaml.replace(/^ {2}clientMode: auto.*\n/m, ""), "auto"],
      ["modern", realYaml.replace(/^ {2}clientMode: auto/m, "  clientMode: modern"), "modern"],
      ["legacy", realYaml.replace(/^ {2}clientMode: auto/m, "  clientMode: legacy"), "legacy"],
      ["大小写不符 Modern", realYaml.replace(/^ {2}clientMode: auto/m, "  clientMode: Modern"), "ConfigError"],
      ["数字 1", realYaml.replace(/^ {2}clientMode: auto/m, "  clientMode: 1"), "ConfigError"],
      ["空值", realYaml.replace(/^ {2}clientMode: auto/m, "  clientMode: \"\""), "ConfigError"],
    ];
    for (const [label, text, want] of variants) {
      assert(text !== realYaml, `37 ${label}：变体确实改动了 yaml`);
      writeFileSync(join(tmp, "moa.yaml"), text);
      let got: string;
      try {
        got = loadConfig({ moaYaml: join(tmp, "moa.yaml") }).jevcheck.clientMode;
      } catch (e) {
        got = e instanceof ConfigError ? (e.message.includes("jevcheck.clientMode 非法") ? "ConfigError" : `ConfigError(其它): ${e.message}`) : msgOf(e);
      }
      assert(got === want, `37 ${label} → ${want}（实际 ${got}）`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- 用例 38：@modelcontextprotocol/sdk 1.29 与 @modelcontextprotocol/client 2.0 同进程共存 ----------
{
  log("=== 用例 38：sdk 1.29 与 client 2.0 同进程共存（真 sdk 1.29 服务端 × JevClient 三种 clientMode）===");
  const nm = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@modelcontextprotocol");
  const sdkVer = (JSON.parse(readFileSync(join(nm, "sdk", "package.json"), "utf8")) as { version: string }).version;
  const clientVer = (JSON.parse(readFileSync(join(nm, "client", "package.json"), "utf8")) as { version: string }).version;
  assert(sdkVer === "1.29.0" && clientVer === "2.0.0", `38 已装版本 sdk=${sdkVer} client=${clientVer}`);
  assert(typeof Sdk129Client === "function" && typeof Client2 === "function" && (Sdk129Client as unknown) !== (Client2 as unknown), "38 两个包的 Client 类同进程各自加载、互不覆盖");

  const transports = new Map<string, InstanceType<typeof Sdk129ServerTransport>>();
  let toolCalls = 0;
  const http: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const sid = req.headers["mcp-session-id"];
    let t = typeof sid === "string" ? transports.get(sid) : undefined;
    if (!t) {
      const nt: InstanceType<typeof Sdk129ServerTransport> = new Sdk129ServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, nt),
      });
      const s = new Sdk129McpServer({ name: "jev-sdk129", version: "1" });
      s.registerTool("jev_judge", { inputSchema: { state: z.string(), questions: z.record(z.string(), z.any()) } }, async ({ questions }) => {
        toolCalls++;
        return { content: [{ type: "text" as const, text: Object.keys(questions).map((k) => `【${k}】P(成立)=0.66`).join(" ") }] };
      });
      await s.connect(nt);
      t = nt;
    }
    await t.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  try {
    for (const [mode, want] of [
      ["auto", 0.66],
      ["legacy", 0.66],
      ["modern", null],
    ] as const) {
      JevClient.resetForTest();
      const c = JevClient.shared({ url, concurrency: 2, perCallTimeoutMs: 3000, clientMode: mode });
      const before = toolCalls;
      const r = await c.noul("fact", "s", 1);
      const conn = internals(c).conn;
      assert(r.p === want, `38 clientMode=${mode} × sdk 1.29 服务端 → p=${want}（实际 ${r.p}）`);
      if (want !== null) {
        assert(conn?.client.getProtocolEra() === "legacy" && toolCalls === before + 1, `38 clientMode=${mode} 协商到 legacy（${conn?.client.getNegotiatedProtocolVersion()}/${conn?.client.getProtocolEra()}）`);
      } else {
        assert(toolCalls === before && internals(c).consecutiveFailures === 1, `38 clientMode=modern 遇 legacy-only 的 sdk 1.29：握手即失败、不发 tools/call（toolCalls 增量 ${toolCalls - before}）`);
      }
    }
  } finally {
    JevClient.resetForTest();
    for (const t of transports.values()) await t.close().catch(() => undefined);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

// ---------- 用例 39：DEBT-09 连续失败计数口径（连接失败 / 5xx / 解析失败共用一个「连续」计数，完整成功才清零） ----------
{
  log("=== 用例 39：DEBT-09 纯解析失败跨 ask 累计到 3 → JevUnavailable；完整成功才清零；isError(非限流) 不计 ===");
  // 每次 tools/call 按脚本取一种应答：ok=可解析成功；unparsed=传输成功但解析不出 P；http500=传输层失败；iserr=非限流 isError。
  type Beh = "ok" | "unparsed" | "http500" | "iserr";
  const script: Beh[] = [];
  const srv = await startJevTestServer({
    onToolCall: (p, res, modern) => {
      const b = script.shift() ?? "ok";
      if (b === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      const text = b === "ok" ? "【fact】P(成立)=0.64 [用量] 输入 9 token" : b === "unparsed" ? "无法给出判定 [用量] 输入 9 token" : "上游模型报错";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${toolFrame(p, modern, { content: [{ type: "text", text }], ...(b === "iserr" ? { isError: true } : {}) })}\n\n`);
    },
  });
  const fresh = (): JevClient => {
    JevClient.resetForTest();
    return JevClient.shared({ url: srv.url, concurrency: 2, perCallTimeoutMs: 3000 });
  };
  try {
    // 39-1 连续 3 次「传输成功、解析失败」的 ask：前两次单样本失败计 1、2，第 3 次抛 JevUnavailable（修前 :725 每次先清零，永远停在 1）。
    {
      const c = fresh();
      script.push("unparsed", "unparsed", "unparsed");
      const r1 = await c.noul("fact", "s", 1);
      const n1 = internals(c).consecutiveFailures;
      const r2 = await c.noul("fact", "s", 1);
      const n2 = internals(c).consecutiveFailures;
      assert(r1.p === null && r2.p === null && n1 === 1 && n2 === 2, `39-1 两次纯解析失败按连续口径计 1、2（实际 p=${r1.p}/${r2.p}，计数 ${n1}/${n2}）`);
      const e = await errOf(c.noul("fact", "s", 1));
      assert(e instanceof JevUnavailable && e.message === "Jev 响应解析失败连续 3 次", `39-1 第 3 次纯解析失败 → JevUnavailable（实际 ${msgOf(e)}）`);
      assert(srv.stats.toolCalls === 3, `39-1 三次都真实发出 tools/call（服务端计数 ${srv.stats.toolCalls}）`);
    }
    // 39-2 解析成功一次即清零：2 次解析失败后一次完整成功 → 0；其后再解析失败只到 1、不抛。
    {
      const c = fresh();
      script.push("unparsed", "unparsed", "ok", "unparsed");
      await c.noul("fact", "s", 1);
      await c.noul("fact", "s", 1);
      const ok = await c.noul("fact", "s", 1);
      const afterOk = internals(c).consecutiveFailures;
      const r4 = await c.noul("fact", "s", 1);
      assert(ok.p === 0.64 && afterOk === 0, `39-2 完整成功清零（实际 p=${ok.p}，计数 ${afterOk}）`);
      assert(r4.p === null && internals(c).consecutiveFailures === 1, `39-2 清零后再解析失败只计 1、不抛（实际 p=${r4.p}，计数 ${internals(c).consecutiveFailures}）`);
    }
    // 39-3 连接失败与解析失败混合按「连续」累加：5xx → 解析失败 → 5xx，第 3 次抛 JevUnavailable（修前解析失败那次先被 :725 清零，停在 2）。
    {
      const c = fresh();
      script.push("http500", "unparsed", "http500");
      await c.noul("fact", "s", 1);
      const n1 = internals(c).consecutiveFailures;
      await c.noul("fact", "s", 1);
      const n2 = internals(c).consecutiveFailures;
      const e = await errOf(c.noul("fact", "s", 1));
      assert(n1 === 1 && n2 === 2, `39-3 5xx 记 1、随后解析失败接着记到 2（实际 ${n1}/${n2}）`);
      assert(e instanceof JevUnavailable && e.message.startsWith("Jev 连接失败连续 3 次："), `39-3 5xx/解析失败/5xx 混合第 3 次 → JevUnavailable（实际 ${msgOf(e)}）`);
    }
    // 39-4 isError(非限流) 仍不计入、也不清零（既有合同）：计数 2 时连来两次 isError 仍是 2、不抛。
    {
      const c = fresh();
      script.push("iserr", "iserr");
      internals(c).consecutiveFailures = 2;
      const r = await c.noul("fact", "s", 2);
      assert(r.p === null && internals(c).consecutiveFailures === 2, `39-4 非限流 isError 不计入不清零、不抛（实际 p=${r.p}，计数 ${internals(c).consecutiveFailures}）`);
    }
    // 39-5 不引入新的误触发：计数 2 时同一 ask 内先完整成功、后 5xx → 不抛 JevUnavailable，结果照用（完整成功当场清零）。
    {
      const c = fresh();
      script.push("ok", "http500");
      internals(c).consecutiveFailures = 2;
      let threw: unknown;
      let r: { p: number | null } | undefined;
      try {
        r = await c.noul("fact", "s", 2);
      } catch (err) {
        threw = err;
      }
      assert(threw === undefined && r?.p === 0.64, `39-5 同一 ask 内完整成功后再 5xx 不误判不可用（实际 ${threw === undefined ? `p=${r?.p}` : msgOf(threw)}）`);
    }
  } finally {
    JevClient.resetForTest();
    await srv.close();
  }
}

console.log(`\n[jevcheck-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
