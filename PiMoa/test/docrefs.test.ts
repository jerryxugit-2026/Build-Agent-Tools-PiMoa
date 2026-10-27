/**
 * recon `refs:"auto"` 文档引用自动附件（提速方案 20260904 §4.11 / §4.10 硬顶；src/moa/docrefs.ts）。
 *
 * 运行：node --import tsx --test test/docrefs.test.ts
 * 预算常量在模块加载时读 env，故本文件**先设 env 再动态 import** recon：
 *   PIMOA_RECON_MAX_CHARS=200000（只作用于本测试进程；REFS_MAX_CHARS=100_000 写死不受 env 影响，
 *   200k 让「超 REFS 顶」与「recon 剩余额度更小」两种上限都能各自触发）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PIMOA_RECON_MAX_CHARS = "200000";

const { runRecon, RECON_MAX_CHARS } = await import("../src/moa/recon.ts");
const { extractDocRefs, mergeRanges } = await import("../src/moa/docrefs.ts");
const { REFS_MAX_CHARS, REFS_MAX_FILES, REFS_CODE_CONTEXT_LINES } = await import("../src/config/limits.ts");

// ── 临时仓 ──
const cwd = mkdtempSync(join(tmpdir(), "pimoa-docrefs-"));
mkdirSync(join(cwd, "docs"));
mkdirSync(join(cwd, "internal"));
mkdirSync(join(cwd, "sub dir"));
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
const outside = mkdtempSync(join(tmpdir(), "pimoa-docrefs-outside-"));
writeFileSync(join(outside, "secret.md"), "outside root\n", "utf8");

const C_YAML = join(cwd, "c.yaml");
const SPACED = join(cwd, "sub dir", "e.md");
const GO_LINES = Array.from({ length: 120 }, (_, i) => `func line${String(i + 1).padStart(3, "0")}() {}`);

writeFileSync(join(cwd, "docs", "b.md"), ["# b", "", "b 再引用 `" + join(cwd, "d.md") + "`（验证不递归）", "b line 4"].join("\n"), "utf8");
writeFileSync(join(cwd, "d.md"), "# d\nshould not be attached\n", "utf8");
writeFileSync(C_YAML, "key: value\nlist:\n  - a\n  - b\n", "utf8");
writeFileSync(SPACED, "# e\nspaced path doc\n", "utf8");
writeFileSync(join(cwd, "internal", "x.go"), GO_LINES.join("\n"), "utf8");
writeFileSync(join(cwd, "internal", "y.go"), GO_LINES.join("\n"), "utf8");
writeFileSync(join(cwd, "old.md.bak-20260101"), "# bak\n", "utf8");
writeFileSync(join(cwd, "node_modules", "pkg", "README.md"), "# nm\n", "utf8");

const A_MD = [
  "# a（被审文档）",
  "",
  "见 `docs/b.md` 的规格，配置在 " + C_YAML + " 里。",
  "实现在 internal/x.go:40-60，另见 internal/y.go（无行号）。",
  "缺失引用：" + join(cwd, "missing.md") + " 与 `docs/missing2.md`（裸写无前缀的 missing.md 不抓，见 docrefs 已知边界）。",
  "自身引用：a.md 与 " + join(cwd, "a.md") + "。",
  "含空格绝对路径：`" + SPACED + "`",
  "越界：`" + join(outside, "secret.md") + "`",
  "备份与 node_modules 不附：`" + join(cwd, "old.md.bak-20260101") + "` `" + join(cwd, "node_modules", "pkg", "README.md") + "`",
  "URL 不是路径：https://example.com/docs/x.md",
  "",
].join("\n");
writeFileSync(join(cwd, "a.md"), A_MD, "utf8");

const refsBlockRe = /文档引用附件（refs:auto/;
function fileHeader(text: string, re: RegExp): boolean {
  return re.test(text);
}

// ── 扫描器单元 ──

test("extractDocRefs：反引号包裹 / 裸写绝对与相对 / 行号后缀四种写法 / 含空格绝对路径 / URL 不误抓", () => {
  const body = [
    "见 `docs/b.md` 与 " + C_YAML + "。",
    "internal/x.go:40-60 internal/x.go:70–80 internal/y.go#L5 internal/y.go#L10-L12 cmd/z.go:7",
    "`" + SPACED + "`",
    "https://example.com/docs/x.md 与 //cdn/x.md",
    "[link](docs/b.md) 以及 (internal/x.go:40-60)",
    "无扩展名 docs/README 与目录 docs/ 不抓",
  ].join("\n");
  const refs = extractDocRefs(body, cwd);
  const byRaw = new Map(refs.map((r) => [r.raw + (r.range ? `:${r.range.start}-${r.range.end}` : ""), r]));
  assert.ok(byRaw.has("docs/b.md"), "反引号包裹相对路径");
  assert.equal(byRaw.get("docs/b.md")?.abs, join(cwd, "docs", "b.md"));
  assert.ok(byRaw.has(C_YAML), "裸写绝对路径（尾部中文句号被剥）");
  assert.deepEqual(byRaw.get("internal/x.go:40-60")?.range, { start: 40, end: 60 }, "path:N-M");
  assert.deepEqual(byRaw.get("internal/x.go:70-80")?.range, { start: 70, end: 80 }, "path:N–M（en dash）");
  assert.deepEqual(byRaw.get("internal/y.go:5-5")?.range, { start: 5, end: 5 }, "path#LN");
  assert.deepEqual(byRaw.get("internal/y.go:10-12")?.range, { start: 10, end: 12 }, "path#LN-LM");
  assert.deepEqual(byRaw.get("cmd/z.go:7-7")?.range, { start: 7, end: 7 }, "path:N");
  assert.ok(byRaw.has(SPACED), "反引号包裹的含空格绝对路径整段抓到");
  assert.ok(!refs.some((r) => r.raw.includes("example.com") || r.raw.startsWith("//")), "URL 不被当作路径");
  assert.ok(!refs.some((r) => r.abs.endsWith("/docs/x.md")), "URL 里的 /docs/x.md 不被切出");
  assert.ok(!refs.some((r) => r.raw === "docs/README" || r.raw === "docs/"), "无扩展名与目录不抓");
  // 同一 (abs, range) 只出现一次
  const keys = refs.map((r) => `${r.abs}|${r.range?.start ?? ""}-${r.range?.end ?? ""}`);
  assert.equal(new Set(keys).size, keys.length, "去重");
});

test("mergeRanges：重叠/相邻合并为并集，保持排序", () => {
  assert.deepEqual(
    mergeRanges([{ start: 50, end: 60 }, { start: 20, end: 30 }, { start: 31, end: 40 }, { start: 55, end: 70 }]),
    [{ start: 20, end: 40 }, { start: 50, end: 70 }],
  );
});

// ── 集成：runRecon refs:"auto" ──

test("refs:auto 全景：整份附入 / 代码 ±20 行 / 无行号进 note / 不存在进 note / 不递归 / 不重复 / 跳过 .bak 与 node_modules / jail 越界进 note", async () => {
  const r = await runRecon({ files: ["a.md"], refs: "auto", cwd });
  assert.equal(r.filesIncluded, 1, "filesIncluded 只计 files/files_ranges（refs 不计）");
  assert.ok(refsBlockRe.test(r.text), "有 refs 块");

  // b.md 与 c.yaml 整份附入带行号
  assert.ok(fileHeader(r.text, /===== FILE docs\/b\.md（refs:auto，被 a\.md 引用/), "b.md 块头");
  assert.ok(/^\s*3\| b 再引用 `/m.test(r.text), "b.md 带真实行号");
  assert.ok(fileHeader(r.text, /===== FILE c\.yaml（refs:auto，被 a\.md 引用/), "c.yaml 块头（绝对路径按 cwd 相对显示）");
  assert.ok(/^\s*1\| key: value/m.test(r.text), "c.yaml 带行号");
  // 含空格绝对路径
  assert.ok(fileHeader(r.text, /===== FILE sub dir\/e\.md（refs:auto/), "含空格绝对路径的文档附入");

  // x.go 只附 20–80 行范围
  const lo = 40 - REFS_CODE_CONTEXT_LINES;
  const hi = 60 + REFS_CODE_CONTEXT_LINES;
  assert.ok(fileHeader(r.text, new RegExp(`===== FILE internal/x\\.go 第 ${lo}-${hi} 行（refs:auto 行范围`)), "x.go 行范围块头");
  assert.ok(new RegExp(`^\\s*${lo}\\| func line0${lo}`, "m").test(r.text), `含第 ${lo} 行`);
  assert.ok(new RegExp(`^\\s*${hi}\\| func line0${hi}`, "m").test(r.text), `含第 ${hi} 行`);
  assert.ok(!new RegExp(`^\\s*${lo - 1}\\| `, "m").test(r.text), `不含第 ${lo - 1} 行`);
  assert.ok(!new RegExp(`^\\s*${hi + 1}\\| `, "m").test(r.text), `不含第 ${hi + 1} 行`);

  // y.go 无行号：不附体，note 给 moa_verify 提示
  assert.ok(!/===== FILE internal\/y\.go/.test(r.text), "y.go 不附体");
  const noLine = r.notes.find((n) => n.includes("被引用代码未附") && n.includes("internal/y.go"));
  assert.ok(noLine, "y.go 出现在「未附」note");
  assert.ok(noLine?.includes("moa_verify"), "note 含 moa_verify 提示");

  // missing.md / docs/missing2.md 进「不存在」note
  const missing = r.notes.find((n) => n.includes("引用路径不存在"));
  assert.ok(missing, "有「引用路径不存在」note");
  assert.ok(missing?.includes("missing.md") && missing?.includes("docs/missing2.md"), "两条缺失引用都列出");

  // 不递归：b.md 引用的 d.md 不附
  assert.ok(!/===== FILE d\.md/.test(r.text), "d.md 不附（不递归）");
  // a.md 自身不重复附：只有 files 附入的那一份
  assert.equal((r.text.match(/===== FILE a\.md/g) ?? []).length, 1, "a.md 只出现一次");
  // .bak / node_modules 跳过
  assert.ok(!/===== FILE [^\n]*old\.md\.bak/.test(r.text), ".bak 不附（a.md 正文里提到它是正常的，只查块头）");
  assert.ok(!/===== FILE [^\n]*node_modules/.test(r.text), "node_modules 不附");
  assert.ok(!r.notes.some((n) => n.includes("old.md.bak") || n.includes("node_modules")), ".bak/node_modules 刻意排除，不留 note");
  // jail 越界
  const jailed = r.notes.find((n) => n.includes("路径越界") && n.includes("secret.md"));
  assert.ok(jailed, "越界路径被拒进 note");
  assert.ok(!/outside root/.test(r.text), "越界内容不进材料");

  // 附入汇总 note：路径 + 行范围 + 字符数
  const summary = r.notes.find((n) => n.startsWith("refs：附入"));
  assert.ok(summary, "有附入汇总 note");
  assert.ok(/docs\/b\.md（整份 第 1-4 行，\d+ 字符）/.test(summary ?? ""), "汇总含 b.md 路径+行范围+字符数");
  assert.ok(new RegExp(`internal/x\\.go（第 ${lo}-${hi} 行，\\d+ 字符）`).test(summary ?? ""), "汇总含 x.go 行范围+字符数");
  assert.equal(r.usedChars, r.text.length);
});

test("refs 缺省：不产生任何 refs 块与 refs note", async () => {
  const r = await runRecon({ files: ["a.md"], cwd });
  assert.ok(!refsBlockRe.test(r.text));
  assert.ok(!/===== FILE docs\/b\.md/.test(r.text));
  assert.ok(!r.notes.some((n) => n.startsWith("refs")));
});

test("去重：已在 files/files_ranges 中的路径不重复附（note 标明）", async () => {
  const r = await runRecon({ files: ["a.md", "docs/b.md"], refs: "auto", cwd });
  assert.equal((r.text.match(/===== FILE docs\/b\.md/g) ?? []).length, 1, "b.md 只由 files 附一次");
  assert.ok(r.notes.some((n) => n.includes("不重复附") && n.includes("docs/b.md")));
  // b.md 也是被扫文档：它引用的 d.md 现在**会**被附（直接附入的文档都扫，不是递归）
  assert.ok(/===== FILE d\.md（refs:auto，被 docs\/b\.md 引用/.test(r.text), "d.md 由被直接附入的 b.md 引出");
});

test("同一代码文件多处引用：范围取并集、相邻/重叠合并，只附一次", async () => {
  writeFileSync(
    join(cwd, "m.md"),
    "internal/x.go:40-60 与 internal/x.go:70-80 以及 internal/x.go:100-105\n",
    "utf8",
  );
  const r = await runRecon({ files: ["m.md"], refs: "auto", cwd });
  // 20-80 ∪ 50-100 → 20-100；80-125 与 20-100 重叠 → 20-125 → 钳到文件末 120 行
  assert.ok(/===== FILE internal\/x\.go 第 20-120 行（refs:auto 行范围/.test(r.text), "并集单块，终点钳到文件末行");
  assert.equal((r.text.match(/===== FILE internal\/x\.go/g) ?? []).length, 1, "只附一块");
  assert.ok(!r.notes.some((n) => n.includes("终点越界")), "±20 越过文件末尾不产生越界 note");
});

test("files_ranges 附入的 .md 切片也扫引用（只扫切片正文）", async () => {
  const r = await runRecon({ filesRanges: [{ path: "a.md", start: 3, end: 3 }], refs: "auto", cwd });
  assert.ok(/===== FILE docs\/b\.md（refs:auto，被 a\.md 引用/.test(r.text), "第 3 行的 b.md 引用抓到");
  assert.ok(!/===== FILE internal\/x\.go/.test(r.text), "第 4 行的 x.go 不在切片内，不附");
});

test("非 .md/.txt 附件不触发扫描（note 说明）", async () => {
  const r = await runRecon({ files: ["c.yaml"], refs: "auto", cwd });
  assert.ok(!refsBlockRe.test(r.text));
  assert.ok(r.notes.some((n) => n.includes("refs 跳过") && n.includes("没有成功附入的 .md/.txt")));
});

test("REFS_MAX_CHARS=100_000 写死：超顶的引用只在 note 里列路径", async () => {
  assert.equal(REFS_MAX_CHARS, 100_000);
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i + 1} ${"x".repeat(45)}`).join("\n"); // ≈ 60k
  writeFileSync(join(cwd, "docs", "big1.md"), big, "utf8");
  writeFileSync(join(cwd, "docs", "big2.md"), big, "utf8");
  writeFileSync(join(cwd, "over.md"), "见 docs/big1.md 与 docs/big2.md\n", "utf8");
  const r = await runRecon({ files: ["over.md"], refs: "auto", cwd });
  assert.ok(/===== FILE docs\/big1\.md（refs:auto/.test(r.text), "big1 附入（≈66k < 100k）");
  assert.ok(!/===== FILE docs\/big2\.md/.test(r.text), "big2 不附（66k+66k > 100k）");
  const over = r.notes.find((n) => n.includes("超字符上限") && n.includes("docs/big2.md"));
  assert.ok(over, "big2 出现在超顶 note");
  assert.ok(over?.includes(`REFS_MAX_CHARS ${REFS_MAX_CHARS}`), "note 标明触的是 REFS_MAX_CHARS");
  assert.ok(r.text.length <= RECON_MAX_CHARS + 1_000, "总量仍在 recon 账内");
});

test("有效上限 = min(REFS_MAX_CHARS, recon 剩余额度)：files 先吃掉额度后 refs 随之收紧", async () => {
  // filler ≈ 150k，RECON=200k ⇒ 剩余 ≈ 50k < REFS 100k ⇒ big1（≈66k）放不下
  const filler = Array.from({ length: 3000 }, (_, i) => `f ${i} ${"y".repeat(45)}`).join("\n");
  writeFileSync(join(cwd, "filler.txt"), filler, "utf8");
  writeFileSync(join(cwd, "over2.md"), "见 docs/big1.md\n", "utf8");
  const r = await runRecon({ files: ["filler.txt", "over2.md"], refs: "auto", cwd });
  assert.ok(!/===== FILE docs\/big1\.md/.test(r.text), "big1 不附");
  const over = r.notes.find((n) => n.includes("超字符上限") && n.includes("docs/big1.md"));
  assert.ok(over, "big1 进超顶 note");
  assert.ok(over?.includes("recon 剩余额度"), "note 标明触的是 recon 剩余额度");
  assert.ok(r.usedChars <= RECON_MAX_CHARS + 1_000, "不越 recon 总账");
});

test("REFS_MAX_FILES=20 生效：第 21 个及以后只列路径", async () => {
  assert.equal(REFS_MAX_FILES, 20);
  const names: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const n = `docs/many${String(i).padStart(2, "0")}.md`;
    writeFileSync(join(cwd, n), `# many ${i}\n`, "utf8");
    names.push(n);
  }
  writeFileSync(join(cwd, "many.md"), names.map((n) => `- ${n}`).join("\n") + "\n", "utf8");
  const r = await runRecon({ files: ["many.md"], refs: "auto", cwd });
  const attached = (r.text.match(/===== FILE docs\/many\d\d\.md（refs:auto/g) ?? []).length;
  assert.equal(attached, REFS_MAX_FILES, "恰好附 20 个");
  const over = r.notes.find((n) => n.includes(`REFS_MAX_FILES=${REFS_MAX_FILES}`));
  assert.ok(over, "有超文件数 note");
  for (const n of names.slice(20)) assert.ok(over?.includes(n), `${n} 在超文件数 note 中`);
  assert.ok(!r.text.includes("many21.md（refs:auto"), "第 21 个不附体");
});

test("fail-open：readRoots 下的其它仓绝对路径可附；空正文文档不抛", async () => {
  writeFileSync(join(cwd, "empty.txt"), "", "utf8");
  const r0 = await runRecon({ files: ["empty.txt"], refs: "auto", cwd });
  assert.ok(r0.notes.some((n) => n.includes("未抽到可解析的路径引用")));
  // readRoots 放开 outside ⇒ secret.md 可附
  const r1 = await runRecon({ files: ["a.md"], refs: "auto", cwd, readRoots: [outside] });
  assert.ok(new RegExp(`===== FILE ${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/secret\\.md（refs:auto`).test(r1.text), "读根内的绝对路径整份附入，块头用绝对路径");
  assert.ok(!r1.notes.some((n) => n.includes("路径越界")), "不再有越界 note");
});
