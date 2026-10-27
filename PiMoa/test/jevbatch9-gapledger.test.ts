import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../tools/gap-ledger.py", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "jevbatch9-gapledger-"));
try {
  const spool = join(tmp, "spool");
  const consumption = join(tmp, "consumption");
  mkdirSync(spool);
  mkdirSync(consumption);
  const ids = [
    "P1/F1:fact0:ref-hard-error", "P1/F2:battery:fg-skip",
    "P2/F1:fact2:delivery-gap", "P2/F2:fact3:ref-hard-error",
    "P3/F1:battery:od-dup",
  ];
  const gaps = ids.map((id, n) => ({ id, kind: ["ref-hard-error", "battery", "delivery-gap", "ref-hard-error", "battery"][n],
    path: `src/check${n}.ts:10`, factIdx: n, need: [`evidence ${n}`] }));
  const receipt = join(spool, "20261024T101500-moa_verify-fixture.md");
  writeFileSync(receipt, `## receipt\n\n\`\`\`json\n${JSON.stringify({ gaps: { records: gaps, writeCount: gaps.length } })}\n\`\`\`\n\n## jevcheck\n\n${JSON.stringify({ gaps })}\n`);
  const one = join(consumption, "PM-PROBE-decisions.md");
  const two = join(consumption, "PM-probe-followup.md");
  writeFileSync(one, [
    `审查 ${ids[0]}`, "背景", "已解决：补齐引用，完成复核。",
    "", "", "", "", "", "", "",
    `审查 ${ids[1]}`, "仍缺材料，需追加供给行态。",
    "", "", "", "", "", "", "", "",
    `审查 ${ids[2]}`, "核对结果：误报，已驳回。",
    "", "", "", "", "", "", "", "",
    `审查 ${ids[3]}`, "待人工核验，无处置结论。",
  ].join("\n"));
  writeFileSync(two, "这份材料不含任何 gap id 引用。\n");
  const output = join(tmp, "ledger.json");
  const report = join(tmp, "report.md");
  const command = [script, "--spool-dir", spool, "--consumption-glob", join(consumption, "PM-*.md"),
    "--out", output, "--report", report];
  execFileSync("python3", command, { encoding: "utf8" });
  const ledger = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(ledger.records.length, 5, "each receipt record appears exactly once, not tripled by nested gaps");
  assert.deepEqual(ledger.records.map((row: { disposition: string | null }) => row.disposition),
    ["resolved", "still-missing", "false-alarm", null, null]);
  assert.deepEqual(ledger.records.map((row: { read: boolean }) => row.read), [true, true, true, true, false]);
  assert.deepEqual(ledger.records.map((row: { unread: boolean }) => row.unread), [false, false, false, false, true]);
  assert.deepEqual(ledger.records[4].referenceSources, []);
  assert.deepEqual(ledger.records[0].referenceSources, [realpathSync(one)]);
  assert.equal(ledger.records[0].producedAt, "2026-10-24T10:15:00+00:00");
  assert.deepEqual(ledger.summary, { total: 5, read: 4, resolved: 1, "still-missing": 1,
    "false-alarm": 1, unread: 1 });
  const markdown = readFileSync(report, "utf8");
  assert.match(markdown, /\| 全部 \| 5 \| 80\.0% \| 20\.0% \| 20\.0% \| 20\.0% \| 20\.0% \|/);
  assert.match(markdown, /\| 2026-10-19 \| 5 \|/); // ISO week begins Monday UTC
  assert.match(markdown, /\| delivery-gap \| 1 \| 100\.0%/);

  // The reference outside the ±3-line window stays read with no disposition.
  writeFileSync(two, `${ids[4]}\nnoise\nnoise\nnoise\nnoise\n已确认\n`);
  execFileSync("python3", [...command, "--consumption-glob", join(consumption, "*.md")], { encoding: "utf8" });
  const second = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(second.records[4].read, true);
  assert.equal(second.records[4].disposition, null);
  assert.equal(second.records[4].unread, false);

  // Nearby IDs must not inherit each other's disposition; suffixes must not match a shorter ID.
  writeFileSync(one, `${ids[0]} 已解决\nnoise\n${ids[1]}\n${ids[2]}:stale 已修复\nnoise\nnoise\nnoise\nnoise\n${ids[2]}:stale 已修复\n`);
  writeFileSync(two, "No citations here.\n");
  const insideOutput = join(consumption, "PM-ledger.json");
  const insideReport = join(consumption, "PM-report.md");
  const adversarial = [script, "--spool-dir", spool, "--consumption-glob", join(consumption, "PM-*"),
    "--out", insideOutput, "--report", insideReport];
  execFileSync("python3", adversarial, { encoding: "utf8" });
  execFileSync("python3", adversarial, { encoding: "utf8" }); // prior outputs must not become consumption evidence
  const checked = JSON.parse(readFileSync(insideOutput, "utf8"));
  assert.equal(checked.records[0].disposition, "resolved");
  assert.equal(checked.records[1].read, true);
  assert.equal(checked.records[1].disposition, null);
  assert.equal(checked.records[2].unread, true);
  assert.equal(checked.records[4].unread, true);
  assert.deepEqual(checked.summary, { total: 5, read: 2, resolved: 1, "still-missing": 0,
    "false-alarm": 0, unread: 3 });

  // A nonempty explicit window excluding the receipt produces no gaps.
  execFileSync("python3", [...command, "--since-days", "0"], { encoding: "utf8" });
  assert.equal(JSON.parse(readFileSync(output, "utf8")).records.length, 0);
  console.log("jevbatch9 gap-ledger fixture E2E: PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
