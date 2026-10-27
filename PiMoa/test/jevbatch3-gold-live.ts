// Live 8760 goldcase gate. Run: ./node_modules/.bin/tsx test/jevbatch3-gold-live.ts
// Original exam is read-only; all rows and summaries are written under /tmp.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { checkFinding, JevClient } from "../src/moa/jevcheck.js";
import type { FindingRecord, MaterialMap, MaterialFile } from "../src/moa/types.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

const examPath = process.env.JEV_GOLD_EXAM ?? WS + "/artifacts/jev-material-supply-20261022/goldcases-v1.json";
const isSupplement = /goldcases-v[23]-new\.json$|goldcases-v4-mini\.json$/.test(examPath);
const examLabel = examPath.endsWith("goldcases-v4-mini.json") ? "v4" : examPath.endsWith("goldcases-v3-new.json") ? "v3" : isSupplement ? "v2-voided" : "v1";
const exam = JSON.parse(readFileSync(examPath, "utf8")) as {
  cases: Array<{ id: string; category: FindingRecord["category"]; finding: string; state: string; expected: Record<string, boolean | "mid" | "nf" | "gate-gap">; rationale?: string }>;
  control_question?: { type: string; instructions_tpl: string; criteria: Record<string, string> };
};
const output = `/tmp/jevbatch3-${examLabel}-live-${Date.now()}`;
const v1Oracle: Record<string, Record<string, string>> = isSupplement ? {} : JSON.parse(readFileSync(
  WS + "/artifacts/jev-material-supply-20261022/goldcases-v1-gate-oracle.json", "utf8"
)).rules;
mkdirSync(output, { recursive: true });
const rowsPath = resolve(output, "results.jsonl");
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true;
cfg.category = { enabled: true };
cfg.premiseRound.enabled = false;
cfg.chain = { enabled: false, minSteps: 2, maxSteps: 6 };
cfg.gapList = { enabled: true };
cfg.budget.maxCalls = 2500;
cfg.clientMode = "modern";
const client = JevClient.shared({ url: cfg.url, concurrency: cfg.concurrency, perCallTimeoutMs: cfg.perCallTimeoutMs, clientMode: "modern" });

function adapt(c: typeof exam.cases[number]): { f: FindingRecord; materials: MaterialMap; docs: MaterialFile[] } {
  const materials: MaterialMap = new Map();
  const sections = [...c.state.matchAll(/^## 材料[^\n]*\|([^（\n]+)[^\n]*\n```[^\n]*\n([\s\S]*?)\n```/gm)];
  for (let i = 0; i < sections.length; i++) {
    const rel = sections[i]![1]!.trim();
    const lines = sections[i]![2]!.split("\n");
    const abs = `/goldcases/${c.id}/${i}/${rel}`;
    materials.set(abs, [{ abs, rel, kind: "range", lines, start: 1, end: lines.length }]);
  }
  // checkFinding is the real production path; the corpus specifies finding prose but has no
  // submit_findings fields/fact claims. An empty fact list avoids inventing alleged facts.
  const seg = materials.values().next().value?.[0];
  const f: FindingRecord = { id: "F1", pid: "P1/F1", kind: "finding", category: c.category,
    level: "MAJOR", path: seg?.rel ?? "/goldcases/absent.go", lines: "1", anchor: seg?.lines[0]?.trim() ?? "absent",
    facts: [], claim: c.finding, fix_expect: "核对原发现所指出的改动与契约是否一致。", strength: "推理",
    proposerIndex: 0, proposerModel: "goldcases/live" };
  return { f, materials, docs: [...materials.values()].flat().filter(s => /\.md$/.test(s.rel)) };
}
const stats: Record<string, { batteryPass: number; batteryTotal: number; controlPass: number; controlTotal: number; gap: number; gapCorrect: number }> = {};
const weak: Record<string, { pass: number; total: number; gap: number; gapCorrect: number }> = Object.fromEntries(["od-conflict", "wr-path", "hd-gate-fit"].map(k => [k, { pass: 0, total: 0, gap: 0, gapCorrect: 0 }]));
const scored = (p: number | null, expected: boolean | "mid" | "nf" | "gate-gap"): boolean => p !== null && (expected === true ? p >= 0.8 : expected === false ? p <= 0.2 : expected === "mid" ? p >= 0.3 && p <= 0.7 : false);
let errors = 0;
const delegated: string[] = [];
const started = Date.now();
for (const c of exam.cases) {
  const bucket = stats[c.category!] ??= { batteryPass: 0, batteryTotal: 0, controlPass: 0, controlTotal: 0, gap: 0, gapCorrect: 0 };
  const keyRows: Array<{ key: string; expected: boolean | "mid" | "gate-gap"; p: number | null; gap: string[]; oracle: string; correct: boolean }> = [];
  let controlP: number | null = null;
  let failure: string | undefined;
  try {
    const { f, materials, docs } = adapt(c);
    const fc = await checkFinding({ f, materials, docs, client, cfg, evidenceState: c.state,
      remainingCalls: () => cfg.budget.maxCalls, cacheSeen: new Set() });
    for (const [key, expected] of Object.entries(c.expected)) {
      if (key === "gen" || expected === "nf") continue;
      if (key === "od-conflict") { delegated.push(`${c.id}/${key}`); continue; } // explicit scope reduction, never a scored pass
      const gap = fc.batteryGaps?.find(g => g.id.includes(`:battery:${key}:`))?.need ?? [];
      const p = fc.battery?.find(b => b.key === key)?.p ?? null;
      // v1's expected boolean/mid remains frozen. Appendix G supersedes those
      // expectations ONLY where evidence is absent: the new oracle is hard-gate rejection.
      // v2 freezes gate-gap as a separate expected outcome before any live call.
      const oracleReason = expected === "gate-gap" ? c.rationale ?? "v3 frozen gate-gap" : v1Oracle[c.id]?.[key];
      const oracle = oracleReason ? `hard-gate rejection: ${oracleReason}` : "frozen numeric expectation";
      const needWord = /依赖装配/.test(oracleReason ?? "") ? /依赖装配/ : /验收命令/.test(oracleReason ?? "") ? /验收命令/ :
        /消费点/.test(oracleReason ?? "") ? /消费点/ : /先例|机制调用域/.test(oracleReason ?? "") ? /先例/ :
        /路径段|逐跳/.test(oracleReason ?? "") ? /逐跳|入口→注册/ :
        /豁免/.test(oracleReason ?? "") ? /豁免/ : /合同/.test(oracleReason ?? "") ? /合同/ :
        /Gate\/Registry/.test(oracleReason ?? "") ? /Gate\/Registry/ :
        expected === "gate-gap" && key === "wr-path" ? /消费点|逐跳/ : expected === "gate-gap" && key === "hd-gate-fit" ? /先例/ : /合同/;
      const correct = oracle.startsWith("hard-gate") ? p === null && gap.some(need => needWord.test(need)) : !gap.length && scored(p, expected);
      keyRows.push({ key, expected, p, gap, oracle, correct });
      if (gap.length) { bucket.gap++; if (correct) bucket.gapCorrect++; }
      bucket.batteryTotal++;
      if (correct) bucket.batteryPass++;
      if (key in weak) { weak[key]!.total++; if (gap.length) { weak[key]!.gap++; if (correct) weak[key]!.gapCorrect++; } if (correct) weak[key]!.pass++; }
    }
    if (exam.control_question && c.expected.gen !== undefined) {
      const q = exam.control_question;
      const gen = await client.ask(c.state, { gen: { q: "fact", instructions: q.instructions_tpl.replace("{finding}", c.finding), criteria: q.criteria } }, 2);
      controlP = gen.results.gen?.p ?? null;
      bucket.controlTotal++;
      if (scored(controlP, c.expected.gen)) bucket.controlPass++;
    }
  } catch (e) { failure = String(e); errors++; }
  appendFileSync(rowsPath, JSON.stringify({ case: c.id, category: c.category, keys: keyRows, controlP,
    controlExpected: c.expected.gen, controlCorrect: c.expected.gen === undefined ? null : scored(controlP, c.expected.gen),
    rationale: c.rationale, failure }) + "\n");
  console.log(`${c.id} ${keyRows.filter(x => x.correct).length}/${keyRows.length} gaps=${keyRows.filter(x => x.gap.length).length} gen=${controlP ?? "null"}${failure ? ` ERROR ${failure}` : ""}`);
}
const rates = Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { ...s,
  batteryAccuracy: s.batteryTotal ? s.batteryPass / s.batteryTotal : 0,
  answeredAccuracy: s.batteryTotal > s.gap ? (s.batteryPass - s.gapCorrect) / (s.batteryTotal - s.gap) : 0,
  gapAccuracy: s.gap ? s.gapCorrect / s.gap : 1,
  controlAccuracy: s.controlTotal ? s.controlPass / s.controlTotal : 0 }]));
const weakRates = Object.fromEntries(Object.entries(weak).map(([k, s]) => [k, { ...s,
  accuracy: s.total ? s.pass / s.total : 0,
  answeredAccuracy: s.total > s.gap ? (s.pass - s.gapCorrect) / (s.total - s.gap) : 0 }]));
const v3Path = process.env.JEV_GOLD_V3_SUMMARY;
const v3Prior = examLabel === "v4" && v3Path ? JSON.parse(readFileSync(v3Path, "utf8")) as { exam: string;
  weakRates: Record<string, { total: number; gap: number; pass: number; gapCorrect: number }> } : null;
const priorHd = v3Prior?.exam.endsWith("goldcases-v3-new.json") ? v3Prior.weakRates["hd-gate-fit"] : undefined;
const combinedHdAnswered = priorHd ? (priorHd.pass - priorHd.gapCorrect) + (weak["hd-gate-fit"]!.pass - weak["hd-gate-fit"]!.gapCorrect) : 0;
const combinedHdTotal = priorHd ? (priorHd.total - priorHd.gap) + (weak["hd-gate-fit"]!.total - weak["hd-gate-fit"]!.gap) : 0;
const gate = isSupplement
  ? examLabel === "v4" ? errors === 0 && exam.cases.length === 6
    && weakRates["wr-path"]!.total === 4 && weakRates["wr-path"]!.gapCorrect === 1
    && weakRates["wr-path"]!.accuracy >= 0.75 && weakRates["wr-path"]!.answeredAccuracy >= 0.75
    && priorHd?.total === 4 && weakRates["hd-gate-fit"]!.total === 2 && combinedHdTotal >= 5
    && combinedHdAnswered / combinedHdTotal >= 0.75
    : examLabel === "v3" && errors === 0 && exam.cases.length === 12
      && ["wr-path", "hd-gate-fit"].every(k => weakRates[k]!.total === 4 && weakRates[k]!.gapCorrect === 1 && weakRates[k]!.accuracy >= 0.75 && weakRates[k]!.answeredAccuracy >= 0.75)
      && delegated.length === 4
  : errors === 0 && exam.cases.length === 32 && Object.values(rates).every(s => s.gapAccuracy === 1 && s.batteryAccuracy >= s.controlAccuracy)
    && rates["fake-green"]!.batteryAccuracy >= 0.9;
const summary = { exam: examPath, output, cases: exam.cases.length, errors, rates, weakRates,
  delegated: { count: delegated.length, keys: delegated },
  ...(examLabel === "v4" ? { combinedHardcode: { priorSummary: v3Path ?? null, answered: combinedHdAnswered,
    total: combinedHdTotal, accuracy: combinedHdTotal ? combinedHdAnswered / combinedHdTotal : 0 } } : {}),
  gate, elapsedMs: Date.now() - started };
writeFileSync(resolve(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("GOLD_GATE", JSON.stringify(summary));
await client.close();
if (!gate) process.exitCode = 1;
