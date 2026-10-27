// Explicit live-only adapter: npx tsx test/jevbatch2-gold-live.ts [case ids...]
// Writes only to /tmp/goldstd-live/jevbatch2-adapter-20261022; never mutates original gold corpus.
import assert from "node:assert/strict";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { JEVCHECK_DEFAULTS } from "../src/config/load.js";
import { checkFinding, JevClient } from "../src/moa/jevcheck.js";
import type { FindingRecord, MaterialFile, MaterialMap } from "../src/moa/types.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

const corpus = WS + "/artifacts/jev-finding-truth-20260922/cases.json";
const output = "/tmp/goldstd-live/jevbatch2-adapter-20261022";
mkdirSync(output, { recursive: true });
const rowsPath = resolve(output, "results.jsonl");
const cfg = structuredClone(JEVCHECK_DEFAULTS);
cfg.enabled = true; cfg.stateExpansion = { enabled: true }; cfg.factThicken = { enabled: true };
cfg.grayEnrich = { enabled: true }; cfg.factRefDirect = { enabled: true }; cfg.gapList = { enabled: true };
cfg.chain = { enabled: true, minSteps: 2, maxSteps: 6 }; cfg.sampling.fact = 2;
cfg.sampling.link = 2; cfg.sampling.entail = 2; cfg.premiseRound.enabled = false;
cfg.budget.maxCalls = 2500;
const client = JevClient.shared({ url: cfg.url, concurrency: cfg.concurrency, perCallTimeoutMs: cfg.perCallTimeoutMs, clientMode: "modern" });
interface GoldStep { id: string; kind: string; text: string; from?: string; to?: string | null }
interface GoldCase { id: string; material: string; claim: string; facts: GoldStep[]; chain: GoldStep[];
  bucket: string[]; gt: { finding_truth: string }; }
const all: GoldCase[] = JSON.parse(readFileSync(corpus, "utf8")).cases;
const filter = new Set(process.argv.slice(2));
const selected = filter.size ? all.filter(c => filter.has(c.id)) : all;
const invalid = new Set(["L-A3", "L-A6", "L-A8", "L-A60", "L-A61", "L-A62"]);

function adapt(c: GoldCase): { f: FindingRecord; materials: MaterialMap; docs: MaterialFile[]; note: string[] } {
  const materials: MaterialMap = new Map();
  const note: string[] = [];
  let current: string | null = null;
  let label = "";
  let lines: Array<{ n: number; text: string }> = [];
  const flush = (): void => {
    if (!current || !lines.length) return;
    lines.sort((a, b) => a.n - b.n);
    // Preserve the declared heading range with explicit 'not supplied' placeholders for omitted lines.
    // The missing bytes remain unknown; never infer an absent branch from these placeholders.
    const start = lines[0]!.n, end = lines[lines.length - 1]!.n;
    if (end - start > 300) note.push(`${label} 稀疏材料跨度 ${end - start} 行（未附行有显式占位）`);
    const actual = new Map(lines.map(line => [line.n, line.text]));
    const segment: MaterialFile = { abs: current, rel: label, kind: "range", start, end,
      lines: Array.from({ length: end - start + 1 }, (_, offset) => actual.get(start + offset) ?? "（该行未附）") };
    const previous = materials.get(current);
    if (previous) previous.push(segment); else materials.set(current, [segment]);
    lines = [];
  };
  for (const raw of c.material.split("\n")) {
    const heading = /^##\s+([^（\n]+?)(?:（.*)?$/.exec(raw);
    if (heading) {
      flush();
      label = heading[1]!.trim();
      current = label.startsWith("/") ? label : `/goldstd/${c.id}/${label}`;
      label = basename(label);
      continue;
    }
    const match = /^(\d+):\s?(.*)$/.exec(raw);
    if (match && current) lines.push({ n: Number(match[1]), text: match[2]! });
  }
  flush();
  const first = materials.values().next().value?.[0] as MaterialFile | undefined;
  assert(first, `gold ${c.id} 无可用带行号材料`);
  const anchor = first.lines[0]!.trim().slice(0, 100);
  const f: FindingRecord = { pid: `P1/${c.id}`, id: c.id, kind: "finding", level: "MAJOR",
    path: first.rel, lines: String(first.start), anchor, facts: c.facts.map(step => step.text),
    chain: c.chain.map(step => ({ id: step.id, kind: step.kind, text: step.text,
      from: step.from ?? "f1", to: step.to ?? undefined })) as FindingRecord["chain"],
    claim: c.claim, fix_expect: c.claim, strength: "推理", proposerModel: "gold/live", proposerIndex: 0 };
  if (materials.size > 1) note.push(`跨文件材料 ${materials.size} 份：truthMaterial 只覆盖 finding.path 对应文件`);
  return { f, materials, docs: [...materials.values()].flat().filter(s => /\.(md|txt)$/i.test(s.rel)), note };
}
const started = Date.now();
const judged: Array<{ case: string; verdict: string; gt: string; valid: boolean; grayRefuted: boolean }> = [];
for (const c of selected) {
  try {
    const { f, materials, docs, note } = adapt(c);
    const result = await checkFinding({ f, materials, docs, client, cfg });
    const row = { case: c.id, gt: c.gt, bucket: c.bucket, verdict: result.truth?.verdict ?? "无truth", rule: result.truth?.rule,
      broken: result.truth?.brokenStep, ref: result.ref, calls: result.calls.length, closureDropped: result.closureDropped,
      facts: result.facts, truth: result.truth, note, run_ts: Date.now() };
    appendFileSync(rowsPath, JSON.stringify(row) + "\n");
    judged.push({ case: c.id, verdict: row.verdict, gt: c.gt.finding_truth, valid: !invalid.has(c.id),
      grayRefuted: result.facts.some(fc => fc.thickRefuted) });
    console.log(`${c.id} ${row.verdict} ${row.rule} gt=${c.gt.finding_truth} calls=${row.calls} grayRefuted=${judged.at(-1)!.grayRefuted}`);
  } catch (err) {
    appendFileSync(rowsPath, JSON.stringify({ case: c.id, error: String(err) }) + "\n");
    console.error(`${c.id} ERROR ${String(err)}`);
  }
}
const valid = judged.filter(r => r.valid);
const killed = valid.filter(r => r.verdict === "假");
const trues = valid.filter(r => r.gt === "真");
const traps = valid.filter(r => /^T\d+$/.test(r.case));
const summary = { requested: selected.length, completed: judged.length, elapsedMs: Date.now() - started,
  killCorrect: killed.filter(r => r.gt === "假").length, killTotal: killed.length,
  trueWrong: trues.filter(r => r.verdict === "假").length, trueTotal: trues.length,
  trapKill: traps.filter(r => r.verdict === "假").length, trapTotal: traps.length,
  grayRefutedTrue: trues.filter(r => r.grayRefuted).map(r => r.case) };
writeFileSync(resolve(output, `summary-${filter.size ? "smoke" : "full"}.json`), JSON.stringify(summary, null, 2) + "\n");
console.log("LIVE_ADAPTER_SUMMARY", JSON.stringify(summary));
if (!filter.size && (summary.completed !== 214 || summary.killCorrect !== 42 || summary.killTotal !== 42
  || summary.trueWrong !== 0 || summary.trueTotal !== 150 || summary.trapKill !== 14 || summary.trapTotal !== 14)) process.exitCode = 1;
