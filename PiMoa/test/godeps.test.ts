/**
 * `deps:"auto"` Go 依赖函数整体附入（提速方案 20260904 §4.5 改动 B / §4.10 硬顶）。
 *
 * 运行：node --import tsx --test test/godeps.test.ts
 * 需要机器上有 `rg`；没有则 **skip 并打印原因**（不得假绿）。无 rg 场景本身用清空 PATH 模拟。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecon } from "../src/moa/recon.ts";
import { collectGoDeps, extractCallCandidates, findGoRoot, sliceFuncBody } from "../src/moa/godeps.ts";
import { DEPS_FUNC_MAX_CHARS, DEPS_MAX_CHARS } from "../src/config/limits.ts";

const rgProbe = spawnSync("rg", ["--version"], { encoding: "utf8" });
const HAVE_RG = !rgProbe.error && rgProbe.status === 0;
const SKIP_REASON = HAVE_RG ? undefined : `机器无 rg（${rgProbe.error?.message ?? `exit ${rgProbe.status}`}），依赖 rg 的用例跳过`;
if (!HAVE_RG) console.log(`[godeps-test] SKIP: ${SKIP_REASON}`);

// ── 临时 Go 仓 ──
const repo = mkdtempSync(join(tmpdir(), "pimoa-godeps-"));
writeFileSync(join(repo, "go.mod"), "module example.com/x\n\ngo 1.22\n", "utf8");
const A_GO = [
  "package x",
  "",
  'import "example.com/x/pkg"',
  "",
  "func run() error {",
  "\tif err := helper(); err != nil {",
  "\t\treturn err",
  "\t}",
  "\tpkg.Other()",
  "\tn := len(\"abc\")",
  "\t_ = string(n)",
  "\treturn local()",
  "}",
  "",
  "func local() error { return nil }",
  "",
].join("\n");
const B_GO = [
  "package x",
  "",
  "// helper does things.",
  "func helper() error {",
  "\tx := 1",
  "\tif x > 0 {",
  "\t\treturn nil",
  "\t}",
  "\treturn nil",
  "}",
  "",
  "// Other 与 a.go 里 pkg.Other() 同名：带点调用不得被当作候选。",
  "func Other() {}",
  "",
].join("\n");
writeFileSync(join(repo, "a.go"), A_GO, "utf8");
writeFileSync(join(repo, "b.go"), B_GO, "utf8");
// 同名测试桩：多处命中时应列签名、非 _test.go 优先附体。
writeFileSync(join(repo, "a_test.go"), "package x\n\nfunc helper() error {\n\treturn nil\n}\n", "utf8");
mkdirSync(join(repo, "sub", "deep"), { recursive: true });
writeFileSync(join(repo, "sub", "deep", "z.go"), "package deep\n", "utf8");

test("extractCallCandidates：排除带点/关键字/内建/类型转换/本文件已定义", () => {
  assert.deepEqual(extractCallCandidates(A_GO), ["helper"]);
  // 切片正文只含 helper 调用与 local 调用；local 的定义在切片外但在 fullText 内 ⇒ 仍排除
  const slice = A_GO.split("\n").slice(5, 12).join("\n");
  assert.deepEqual(extractCallCandidates(slice, A_GO), ["helper"]);
  // 没给 fullText 时 local 不再被排除（定义不可见）
  assert.deepEqual(extractCallCandidates(slice), ["helper", "local"]);
  // 方法定义（带 receiver）也算本文件已定义
  assert.deepEqual(extractCallCandidates("func (s *S) M() { M(); f() }"), ["f"]);
  // 泛型定义能识别为已定义；`F[int](x)` 显式实例化调用抓不到（已知边界）
  assert.deepEqual(extractCallCandidates("func F[T any](t T) {}\nfunc g() { F[int](1); G(2) }"), ["G"]);
});

test("findGoRoot：向上找 go.mod；找不到退回文件所在目录", () => {
  assert.equal(findGoRoot(join(repo, "sub", "deep", "z.go")), repo);
  const lonely = mkdtempSync(join(tmpdir(), "pimoa-godeps-nomod-"));
  writeFileSync(join(lonely, "q.go"), "package q\n", "utf8");
  assert.equal(findGoRoot(join(lonely, "q.go")), lonely);
});

test("sliceFuncBody：多行到顶格 `}`；单行函数；无函数体 → null", () => {
  const lines = B_GO.split("\n");
  const r = sliceFuncBody(lines, 3);
  assert.ok(r);
  assert.equal(r.endLine, 10);
  assert.equal(r.text.split("\n").length, 7);
  assert.deepEqual(sliceFuncBody(["func one() int { return 1 }"], 0), { text: "func one() int { return 1 }", endLine: 1 });
  assert.equal(sliceFuncBody(["func asm(x int) int"], 0), null);
  assert.equal(sliceFuncBody(["func open() {", "\tx := 1"], 0), null, "找不到顶格 } ⇒ null");
  // 2026-09-20：gofmt 多行签名（`{` 在 `) (...) {` 收尾行）——此前直接 null 只附签名
  const multi = ["func safeQuotedStringListAppends(", "\tfile *ast.File,", "\tname string,", ") ([]*ast.CallExpr, bool) {", "\tvar out []*ast.CallExpr", "\treturn out, true", "}", "", "func next() {}"];
  assert.deepEqual(sliceFuncBody(multi, 0), { text: multi.slice(0, 7).join("\n"), endLine: 7 }, "多行签名整体附入，收尾在顶格 }");
  assert.equal(sliceFuncBody(["func decl(", "\tx int,", "", "func other() {", "}"], 0), null, "续行中断（空行）⇒ 无函数体 null");
  assert.equal(sliceFuncBody(["func asm2(", "\tx int,", ") int", "", "func other() {", "}"], 0), null, "多行签名无 { 收尾（汇编桩）⇒ null");
});

test("runRecon deps:auto：只附 helper 整体并带 b.go 真实行号；不附 Other/len/local", { skip: SKIP_REASON }, async () => {
  const r = await runRecon({ files: ["a.go"], deps: "auto", cwd: repo });
  assert.equal(r.filesIncluded, 1);
  assert.ok(/===== 依赖函数（deps:auto/.test(r.text), "含 deps 块");
  assert.ok(/--- helper ← 定义于 b\.go:4-10（被 a\.go 调用；函数整体）---/.test(r.text), r.text);
  assert.ok(/^\s*4\| func helper\(\) error \{$/m.test(r.text), "签名行带 b.go 真实行号 4");
  assert.ok(/^\s*7\| \t\treturn nil$/m.test(r.text), "函数体中间行带真实行号");
  assert.ok(/^\s*10\| \}$/m.test(r.text), "收尾 } 行号 10");
  assert.ok(!/--- Other/.test(r.text) && !/func Other\(\)/.test(r.text), "pkg.Other() 带点：不附 Other");
  assert.ok(!/--- len/.test(r.text) && !/--- local/.test(r.text) && !/--- string/.test(r.text));
  // 同名测试桩：列签名、不附体、非 _test.go 优先
  assert.ok(/另有 1 处同名定义，只附首个；其余签名：a_test\.go:3 func helper\(\) error \{/.test(r.text), r.text);
  assert.ok(r.notes.some((n) => /deps：整体附入 1 个函数，0 个只附签名/.test(n)), r.notes.join(";"));
  assert.equal(r.usedChars, r.text.length);
  // deps 块在 FILE 块之后
  assert.ok(r.text.indexOf("===== FILE a.go") < r.text.indexOf("===== 依赖函数"));
});

test("files_ranges 切片也能触发 deps；切片外定义的同文件 local 整体附入（§12.6 第 4 点，2026-09-20 起）", { skip: SKIP_REASON }, async () => {
  const r = await runRecon({ filesRanges: [{ path: "a.go", start: 6, end: 12 }], deps: "auto", cwd: repo });
  assert.ok(/--- helper ← 定义于 b\.go:4-10/.test(r.text), r.text);
  // 此前断言「不附 local」是缺陷（同文件区间外定义被静默排除，第 4 轮「7 个候选无定义命中」即此）；
  // 现在应从同文件切函数体整体附入，并带真实行号。
  assert.ok(/--- local ← 定义于 a\.go:15-15（同文件，本次附入区间之外；函数整体）---/.test(r.text), r.text);
  assert.ok(/^\s*15\| func local\(\) error \{ return nil \}$/m.test(r.text), "同文件 helper 带真实行号 15");
  // notes 逐条：候选名 → 文件:行
  assert.ok(r.notes.some((n) => n === "local → a.go:15-15"), r.notes.join(";"));
  assert.ok(r.notes.some((n) => n === "helper → b.go:4-10"), r.notes.join(";"));
  assert.ok(r.notes.some((n) => /整体附入 2 个函数，0 个只附签名/.test(n)), r.notes.join(";"));
});

test("被调函数已在附件中（b.go 整份附入）⇒ 只给指针不重复附体", { skip: SKIP_REASON }, async () => {
  const r = await runRecon({ files: ["a.go", "b.go"], deps: "auto", cwd: repo });
  assert.ok(/--- helper ← 定义于 b\.go:4（被 a\.go 调用；\*\*已在上方附件中\*\*/.test(r.text), r.text);
  // b.go 本体已附一次；deps 块里不该再出现带行号的函数体
  assert.equal((r.text.match(/^\s*4\| func helper\(\) error \{$/gm) ?? []).length, 1);
  assert.ok(r.notes.some((n) => /整体附入 0 个函数，1 个只附签名/.test(n)), r.notes.join(";"));
});

test("deps 缺省关：不带 deps 就没有 deps 块", async () => {
  const r = await runRecon({ files: ["a.go"], cwd: repo });
  assert.ok(!/依赖函数/.test(r.text));
  assert.ok(!r.notes.some((n) => /deps/.test(n)));
});

test("deps:auto 但没有 .go 附件 ⇒ 一条 note，不抛", async () => {
  writeFileSync(join(repo, "readme.md"), "# x\n", "utf8");
  const r = await runRecon({ files: ["readme.md"], deps: "auto", cwd: repo });
  assert.ok(r.notes.some((n) => /deps 跳过：files\/files_ranges 中没有成功附入的 \.go 文件/.test(n)), r.notes.join(";"));
  assert.ok(!/依赖函数/.test(r.text));
});

// ── 预算硬顶 ──
const big = mkdtempSync(join(tmpdir(), "pimoa-godeps-big-"));
writeFileSync(join(big, "go.mod"), "module example.com/big\n", "utf8");
/** 生成一个约 `chars` 字符的 Go 函数（每行 ~40 字符）。 */
function genFunc(name: string, chars: number): string {
  const n = Math.ceil(chars / 41);
  const body = Array.from({ length: n }, (_, i) => `\t_ = "${name} padding line ${String(i).padStart(6, "0")} xxxxxx"`);
  return [`func ${name}() {`, ...body, "}", ""].join("\n");
}
// 三个 ~15k 的函数：单个 < 20k，三个之和 45k > 40k ⇒ 第三个只附签名
writeFileSync(join(big, "f1.go"), "package big\n\n" + genFunc("f1", 15_000), "utf8");
writeFileSync(join(big, "f2.go"), "package big\n\n" + genFunc("f2", 15_000), "utf8");
writeFileSync(join(big, "f3.go"), "package big\n\n" + genFunc("f3", 15_000), "utf8");
// 一个 25k 的函数：> DEPS_FUNC_MAX_CHARS ⇒ 只附签名
writeFileSync(join(big, "huge.go"), "package big\n\n" + genFunc("huge", 25_000), "utf8");
writeFileSync(join(big, "caller.go"), "package big\n\nfunc call() {\n\tf1()\n\tf2()\n\tf3()\n}\n", "utf8");
writeFileSync(join(big, "caller_huge.go"), "package big\n\nfunc callHuge() {\n\thuge()\n}\n", "utf8");

test("硬顶常量：DEPS_FUNC_MAX_CHARS=20000 / DEPS_MAX_CHARS=40000（写死）", () => {
  assert.equal(DEPS_FUNC_MAX_CHARS, 20_000);
  assert.equal(DEPS_MAX_CHARS, 40_000);
});

test("单函数 > DEPS_FUNC_MAX_CHARS ⇒ 只附签名 + note「函数过长仅附签名」", { skip: SKIP_REASON }, async () => {
  const r = await runRecon({ files: ["caller_huge.go"], deps: "auto", cwd: big });
  assert.ok(/--- huge ← 定义于 huge\.go:3（被 caller_huge\.go 调用；函数过长（\d+ 字符 > 20000），仅附签名）---/.test(r.text), r.text.slice(-600));
  assert.ok(/^\s*3\| func huge\(\) \{$/m.test(r.text), "签名行带真实行号");
  assert.ok(!/huge padding line/.test(r.text), "函数体未附");
  assert.ok(r.notes.some((n) => /整体附入 0 个函数，1 个只附签名/.test(n)), r.notes.join(";"));
});

test("总量 > DEPS_MAX_CHARS ⇒ 剩余只附签名，deps 块 ≤ 40000 字符", { skip: SKIP_REASON }, async () => {
  const r = await runRecon({ files: ["caller.go"], deps: "auto", cwd: big });
  assert.ok(/--- f1 ← 定义于 f1\.go:3-\d+（被 caller\.go 调用；函数整体）---/.test(r.text));
  assert.ok(/--- f2 ← 定义于 f2\.go:3-\d+（被 caller\.go 调用；函数整体）---/.test(r.text));
  assert.ok(/--- f3 ← 定义于 f3\.go:3（被 caller\.go 调用；deps 总量已达上限 40000 字符，仅附签名）---/.test(r.text), r.text.slice(-400));
  assert.ok(!/f3 padding line/.test(r.text), "f3 函数体未附");
  const depsBlock = r.text.slice(r.text.indexOf("===== 依赖函数"));
  assert.ok(depsBlock.length <= DEPS_MAX_CHARS, `deps 块 ${depsBlock.length} ≤ ${DEPS_MAX_CHARS}`);
  assert.ok(r.notes.some((n) => /整体附入 2 个函数，1 个只附签名（总量触顶 40000 字符）/.test(n)), r.notes.join(";"));
});

test("reconRemaining 只能收紧不能放大 deps 上限", { skip: SKIP_REASON }, async () => {
  const src = { abs: join(big, "caller.go"), body: "func call() {\n\tf1()\n}\n" };
  const tight = await collectGoDeps({ sources: [src], reconRemaining: 5_000 });
  assert.equal(tight.funcsIncluded, 0);
  assert.equal(tight.signaturesOnly, 1);
  assert.ok(/deps 总量已达上限 5000 字符/.test(tight.text), tight.text.slice(-300));
  assert.ok(tight.usedChars <= 5_000);
  const loose = await collectGoDeps({ sources: [src], reconRemaining: 10_000_000 });
  assert.equal(loose.funcsIncluded, 1, "放大无效但 15k 单函数本就在 40k 内");
  assert.ok(loose.usedChars <= DEPS_MAX_CHARS);
});

test("无候选命中 ⇒ note 说明，无 deps 块", { skip: SKIP_REASON }, async () => {
  const r = await collectGoDeps({ sources: [{ abs: join(repo, "a.go"), body: "func z() { nowhere() }" }] });
  assert.equal(r.text, "");
  assert.ok(r.notes.some((n) => /1 个候选在仓根内无 `func Name\(` 定义命中/.test(n)), r.notes.join(";"));
});

test("非 .go 来源 ⇒ 空结果零开销", async () => {
  const r = await collectGoDeps({ sources: [{ abs: join(repo, "readme.md"), body: "call()" }] });
  assert.equal(r.text, "");
  assert.deepEqual(r.notes, []);
});

test("无 rg（PATH 清空）⇒ note「未找到 rg」，不抛", async () => {
  const emptyBin = mkdtempSync(join(tmpdir(), "pimoa-godeps-nopath-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const r = await collectGoDeps({ sources: [{ abs: join(repo, "a.go"), body: A_GO, fullText: A_GO }] });
    assert.equal(r.text, "");
    assert.ok(r.notes.some((n) => /deps 跳过：未找到 rg/.test(n)), r.notes.join(";"));
    const viaRecon = await runRecon({ files: ["a.go"], deps: "auto", cwd: repo });
    assert.ok(viaRecon.filesIncluded === 1 && /FILE a\.go/.test(viaRecon.text), "文件本体仍附入");
    assert.ok(viaRecon.notes.some((n) => /未找到 rg/.test(n)));
  } finally {
    process.env.PATH = savedPath;
  }
});
