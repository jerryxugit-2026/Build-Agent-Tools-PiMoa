/**
 * 材料通路测试（Jev 辅助代码审查详细设计 v4 §3.1，第一波验收）。
 *
 * 运行：npx tsx test/materials.test.ts
 * 覆盖：runRecon 产出 files 五类各一（file / range / refs / deps / rg，裸行、真实行号、rel 显示名）；
 *       rg --max-columns 省略占位行不登记为材料、notes 记省略行数；
 *       applyRecon 把 files 装进 req.materials（Map<abs, MaterialFile[]>，同 abs 多段按 start 排序）；
 *       context 文本与改前一致（材料通路不改 text）；无 recon 入参时不写 materials。
 * 需要本机有 rg（deps / rg 两类依赖它）；临时目录自建 go.mod 让 godeps 认仓根。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRgHits, runRecon } from "../src/moa/recon.js";
import { applyRecon } from "../src/mcp/tools.js";
import type { MaterialFile } from "../src/moa/types.js";

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
  console.log("[materials-test]", ...a);
}

// ---------- fixture ----------
const cwd = mkdtempSync(join(tmpdir(), "pimoa-materials-"));
mkdirSync(join(cwd, "internal"));
mkdirSync(join(cwd, "docs"));
writeFileSync(join(cwd, "go.mod"), "module example.com/m\n\ngo 1.22\n", "utf8");
const A_GO = ["package internal", "", "func Caller() int {", "\treturn helperFn(1) // NEEDLE_A", "}", ""].join("\n");
/** rg 以 `--max-columns 200` 跑，超过 200 字节的行会被省略（实测输出「[Omitted long matching line]」），
 * 用来验证材料通路跳过省略占位行、不把占位文本当材料登记（设计 v4 §3.1）。 */
const LONG_RG_LINE = `var longLine = "${"x".repeat(240)}" // NEEDLE_B4`;
const B_GO = [
  "package internal",
  "",
  "// helperFn doc",
  "func helperFn(x int) int {",
  "\tif x > 0 { // NEEDLE_B1",
  "\t\treturn x // NEEDLE_B2",
  "\t}",
  "\treturn 0",
  "}",
  "",
  "var unrelated = 2 // NEEDLE_B3",
  LONG_RG_LINE,
  'var clock = "12:30:45" // NEEDLE_B5',
  "",
].join("\n");
writeFileSync(join(cwd, "internal", "a.go"), A_GO, "utf8");
writeFileSync(join(cwd, "internal", "b.go"), B_GO, "utf8");
/** godeps 同文件（§12.6 第 4 点，波四 2026-09-20）：调用者与被调用的 helper 同在一个文件，
 * 但 helper 定义在本次 filesRanges 切片区间之外——只切了 3-5 行（CallerSameFile），
 * sameFileHelper 定义在第 17-19 行，切片够不到。 */
const C_GO = [
  "package internal",
  "",
  "func CallerSameFile() int {",
  "\treturn sameFileHelper(2) // NEEDLE_C",
  "}",
  "",
  "// padding 1（把 helper 推到切片区间之外）",
  "// padding 2",
  "// padding 3",
  "// padding 4",
  "// padding 5",
  "// padding 6",
  "// padding 7",
  "// padding 8",
  "// padding 9",
  "// padding 10",
  "func sameFileHelper(x int) int {",
  "\treturn x + 1",
  "}",
  "",
].join("\n");
writeFileSync(join(cwd, "internal", "c.go"), C_GO, "utf8");
writeFileSync(join(cwd, "docs", "spec.md"), "# 规格\n\n细节见 docs/other.md 一节。\n", "utf8");
writeFileSync(join(cwd, "docs", "other.md"), "# 其它\n\n第三行 NEEDLE_MD。\n", "utf8");
const NOTES = Array.from({ length: 12 }, (_, i) => `note line ${i + 1}`);
writeFileSync(join(cwd, "notes.txt"), NOTES.join("\n"), "utf8");

const byKind = (files: MaterialFile[], kind: MaterialFile["kind"]): MaterialFile[] => files.filter((f) => f.kind === kind);

// ---------- 用例 1：runRecon 五类各一 ----------
{
  log("=== 用例 1：runRecon.files 五类各一 ===");
  const r = await runRecon({
    files: ["internal/a.go", "docs/spec.md"],
    filesRanges: [
      { path: "notes.txt", start: 10, end: 12 },
      { path: "notes.txt", start: 2, end: 4 },
    ],
    refs: "auto",
    deps: "auto",
    reconQuery: "NEEDLE_B",
    cwd,
  });
  log(`notes: ${r.notes.join(" ｜ ")}`);
  log(`files: ${r.files.map((f) => `${f.kind}:${f.rel}:${f.start}-${f.end}`).join(", ")}`);

  const file = byKind(r.files, "file");
  assert(file.length === 2 && file[0]!.rel === "internal/a.go" && file[0]!.abs === resolve(cwd, "internal/a.go"), "file：a.go 登记，rel 相对 cwd、abs 绝对");
  assert(file[0]!.start === 1 && file[0]!.end === 6 && file[0]!.lines.length === 6 && file[0]!.lines[3] === "\treturn helperFn(1) // NEEDLE_A", "file：裸行（无行号前缀）、start=1、end=行数");
  assert(file[1]!.rel === "docs/spec.md" && file[1]!.lines[0] === "# 规格", "file：spec.md 登记");

  const range = byKind(r.files, "range");
  assert(range.length === 2 && range[0]!.start === 10 && range[0]!.end === 12 && range[1]!.start === 2 && range[1]!.end === 4, "range：两段按入参顺序登记（10-12、2-4）");
  assert(range[0]!.lines.join("|") === "note line 10|note line 11|note line 12" && range[1]!.lines[0] === "note line 2", "range：裸行与真实行号对齐");

  const refs = byKind(r.files, "refs");
  assert(refs.length === 1 && refs[0]!.rel === "docs/other.md" && refs[0]!.start === 1 && refs[0]!.lines[2] === "第三行 NEEDLE_MD。", "refs：spec.md 引用的 other.md 整份登记为 refs");
  assert(/FILE docs\/other\.md（refs:auto/.test(r.text), "refs：other.md 确实附进了 text");

  const deps = byKind(r.files, "deps");
  assert(deps.length === 1 && deps[0]!.rel === "internal/b.go" && deps[0]!.abs === resolve(cwd, "internal/b.go"), "deps：a.go 调用的 helperFn 定义于 b.go 登记为 deps");
  assert(deps[0]!.start === 4 && deps[0]!.end === 9 && deps[0]!.lines[0] === "func helperFn(x int) int {" && deps[0]!.lines[5] === "}", "deps：start=定义行 4、end=顶格 } 行 9、裸行");
  assert(deps[0]!.lines[1] === "\tif x > 0 { // NEEDLE_B1", "deps：行号前缀已剥、内容逐字");

  const rg = byKind(r.files, "rg");
  assert(rg.length >= 1 && rg.every((f) => f.abs === resolve(cwd, "internal/b.go")), `rg：命中登记（${rg.length} 条，均指向 b.go）`);
  const merged = rg.find((f) => f.start === 5 && f.end === 6);
  assert(merged !== undefined && merged.lines.length === 2 && merged.lines[0] === "\tif x > 0 { // NEEDLE_B1", "rg：连续命中行 5-6 并成一条");
  const single = rg.find((f) => f.start === 11 && f.end === 11);
  assert(single !== undefined && single.lines[0] === "var unrelated = 2 // NEEDLE_B3", "rg：不连续的第 11 行单独一条");
  // --max-columns 省略行（第 12 行，LONG_RG_LINE）：不登记为材料、notes 记省略行数（设计 v4 §3.1）。
  const omittedSeg = rg.find((f) => f.start === 12 || f.end === 12 || f.lines.some((l) => l.includes("longLine")));
  assert(omittedSeg === undefined, "rg：--max-columns 省略的占位行（第 12 行）不登记为材料");
  assert(r.notes.some((n) => /rg 命中 1 行因超长未登记/.test(n)), `rg：notes 记录省略行数：${r.notes.join(" ｜ ")}`);
  // 行内容含 `:数字:`（第 13 行 "12:30:45"）：路径切分不能被骗走，须登记为 b.go 第 13 行、内容逐字
  const colon = rg.find((f) => f.start === 13 && f.end === 13);
  assert(colon !== undefined && colon.lines[0] === 'var clock = "12:30:45" // NEEDLE_B5', `rg：内容含 :数字: 的行按真实路径与行号登记：${JSON.stringify(rg.map((f) => [f.rel, f.start, f.end]))}`);
  // 两种 --max-columns 占位文案都跳过（第二种来自较早版本 rg，真实 rg 15.x 不产生，用合成文本核）
  const synth = parseRgHits(["./internal/b.go:5:\tif x > 0 { // NEEDLE_B1", "./internal/b.go:6:[Omitted long line with 2 matches]", "./internal/b.go:7:[Omitted long matching line]", "./internal/b.go:8:\treturn 0", ""].join("\n"), false, cwd);
  assert(synth.omitted === 2 && synth.files.length === 2 && synth.files[0]!.start === 5 && synth.files[0]!.end === 5 && synth.files[1]!.start === 8, `parseRgHits：两种占位文案都跳过且中断并段：${JSON.stringify(synth)}`);
  assert(r.files.every((f) => f.lines.every((l) => !/^\s*\d+\| /.test(l))), "所有登记行都不带 `N| ` 行号前缀（rg 段无豁免）");
}

// ---------- 用例 2：预算拦下的块不登记；text 不因材料通路改变 ----------
{
  log("=== 用例 2：只登记真附入的块 ===");
  const r = await runRecon({ files: ["internal/a.go", "internal/nope.go"], cwd });
  assert(r.files.length === 1 && r.files[0]!.rel === "internal/a.go", "读失败的文件不登记（只登记 tryPush 成功的块）");
  assert(r.notes.some((n) => n.includes("nope.go")), "读失败仍进 note（行为不变）");
  const r0 = await runRecon({ cwd });
  assert(r0.files.length === 0 && r0.text === "", "无入参 → files 空、text 空");
}

// ---------- 用例 3：applyRecon 装配 Map ----------
{
  log("=== 用例 3：applyRecon → req.materials ===");
  const req = await applyRecon(
    { prompt: "审这个", context: "既有上下文", cwd },
    {
      prompt: "审这个",
      files: ["internal/a.go"],
      files_ranges: [
        { path: "notes.txt", start: 10, end: 12 },
        { path: "notes.txt", start: 2, end: 4 },
        { path: "internal/a.go", start: 3, end: 5 },
      ],
    },
  );
  assert(req.materials instanceof Map, "req.materials 是 Map");
  assert(
    req.reconSummary !== undefined && req.reconSummary.filesIncluded > 0 && req.reconSummary.segments.some((s) => /^internal\/a\.go:\d+-\d+ (file|range)$/.test(s)),
    `applyRecon 产出 reconSummary（附入段清单 rel:start-end kind）：${JSON.stringify(req.reconSummary?.segments)}`,
  );
  const m = req.materials!;
  assert(m.size === 2 && m.has(resolve(cwd, "internal/a.go")) && m.has(resolve(cwd, "notes.txt")), "key = 绝对路径，两个文件两个 key");
  const notes = m.get(resolve(cwd, "notes.txt"))!;
  assert(notes.length === 2 && notes[0]!.start === 2 && notes[1]!.start === 10, "同 abs 多段按 start 升序（2-4 在 10-12 前）");
  const ago = m.get(resolve(cwd, "internal/a.go"))!;
  assert(ago.length === 2 && ago[0]!.kind === "file" && ago[0]!.start === 1 && ago[1]!.kind === "range" && ago[1]!.start === 3, "同一文件整份 + 切片两段并存且有序");
  assert(typeof req.context === "string" && req.context.startsWith("既有上下文\n\n===== 侦查前置") && /FILE internal\/a\.go（左侧/.test(req.context), "context 文本照旧拼接（材料通路不改 text）");

  const plain = await applyRecon({ prompt: "x", cwd }, { prompt: "x" });
  assert(plain.materials === undefined, "无 files/files_ranges/recon_query → 不写 materials");
  const miss = await applyRecon({ prompt: "x", cwd }, { prompt: "x", files: ["internal/nope.go"] });
  assert(miss.materials === undefined && typeof miss.context === "string" && miss.context.includes("[侦查说明]"), "全部读失败 → 只有说明、不写 materials");
}

// ---------- 用例 4：godeps 同文件（§12.6 第 4 点，波四 2026-09-20）----------
// 候选名先在被附入文件自身全文里找 func 定义、命中且不在本次附入区间之外 → 整体附入（不必去仓根 rg）；
// notes 逐条「候选名 → 文件:行」而非只给计数。
{
  log("=== 用例 4：godeps 同文件——切片区间之外的同文件 helper 被直接附入，notes 逐条 ===");
  const r = await runRecon({
    filesRanges: [{ path: "internal/c.go", start: 3, end: 5 }],
    deps: "auto",
    cwd,
  });
  log(`notes: ${r.notes.join(" ｜ ")}`);
  const deps = byKind(r.files, "deps");
  const sameFile = deps.find((f) => f.rel === "internal/c.go");
  assert(
    sameFile !== undefined && sameFile.start === 17 && sameFile.end === 19 && sameFile.lines[0] === "func sameFileHelper(x int) int {",
    `同文件区间外的 sameFileHelper（17-19 行）被整体附入，不误判为「本文件已定义」而丢弃：${JSON.stringify(deps.map((f) => [f.rel, f.start, f.end]))}`,
  );
  assert(sameFile!.lines[1] === "\treturn x + 1" && sameFile!.lines[2] === "}", "deps：同文件附入的裸行内容逐字、行号前缀已剥");
  assert(/--- sameFileHelper ← 定义于 internal\/c\.go:17-19（同文件，本次附入区间之外；函数整体）---/.test(r.text), `deps 块段头标注「同文件」：${r.text.slice(-400)}`);
  assert(
    r.notes.some((n) => n === "sameFileHelper → internal/c.go:17-19"),
    `notes 逐条「候选名 → 文件:行」（不只给计数，§12.6 第 4 点动机——「7 个候选无定义命中」无法排查）：${r.notes.join(" ｜ ")}`,
  );
}

console.log(`\n[materials-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
