/**
 * recon 结构化行范围 files_ranges + 逐块预算（提速方案 20260904 §4.5 改动 A / 预算更正）。
 *
 * 运行：node --import tsx --test test/recon_ranges.test.ts
 * 预算常量在模块加载时读 env，故本文件**先设 env 再动态 import** recon：
 *   PIMOA_RECON_MAX_CHARS=2500、PIMOA_PER_FILE_MAX_CHARS=1000（只作用于本测试进程）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PIMOA_RECON_MAX_CHARS = "2500";
process.env.PIMOA_PER_FILE_MAX_CHARS = "1000";

const { runRecon, RECON_MAX_CHARS, PER_FILE_MAX_CHARS } = await import("../src/moa/recon.ts");

const cwd = mkdtempSync(join(tmpdir(), "pimoa-recon-ranges-"));
// 200 行、每行约 30 字符（含换行约 6,200 字符 > PER_FILE 1000）。
const LINES = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1).padStart(3, "0")} content xxxxxxxxxx`);
writeFileSync(join(cwd, "big.txt"), LINES.join("\n"), "utf8");
writeFileSync(join(cwd, "big2.txt"), LINES.join("\n"), "utf8");
writeFileSync(join(cwd, "big3.txt"), LINES.join("\n"), "utf8");
mkdirSync(join(cwd, "sub"));
writeFileSync(join(cwd, "sub", "small.txt"), "a\nb\nc", "utf8");

/** 附入文本里是否含真实行号 N 的行（行号列右对齐，允许前导空格）。 */
function hasLine(text: string, n: number): boolean {
  return new RegExp(`^\\s*${n}\\| line ${String(n).padStart(3, "0")} content`, "m").test(text);
}

test("env 已生效：RECON_MAX_CHARS=2500 / PER_FILE_MAX_CHARS=1000", () => {
  assert.equal(RECON_MAX_CHARS, 2500);
  assert.equal(PER_FILE_MAX_CHARS, 1000);
});

test("files_ranges 50-60：只附 50..60 行且行号为真实行号", async () => {
  const r = await runRecon({ filesRanges: [{ path: "big.txt", start: 50, end: 60 }], cwd });
  assert.equal(r.filesIncluded, 1);
  assert.ok(/FILE big\.txt 第 50-60 行/.test(r.text), "块头标注「path 第 start-end 行」");
  for (const n of [50, 55, 60]) assert.ok(hasLine(r.text, n), `含第 ${n} 行`);
  assert.ok(!hasLine(r.text, 49), "不含第 49 行");
  assert.ok(!hasLine(r.text, 61), "不含第 61 行");
  assert.ok(!/^\s*1\| /m.test(r.text), "行号不是从 1 重排");
  assert.equal(r.usedChars, r.text.length, "usedChars = text.length");
  assert.ok(/行号规则/.test(r.text), "带引导语头部");
});

test("同一文件多段 + 段内顺序保持", async () => {
  const r = await runRecon(
    { filesRanges: [{ path: "big.txt", start: 10, end: 12 }, { path: "big.txt", start: 100, end: 101 }], cwd },
  );
  assert.equal(r.filesIncluded, 2);
  assert.ok(hasLine(r.text, 10) && hasLine(r.text, 12) && hasLine(r.text, 100) && hasLine(r.text, 101));
  assert.ok(r.text.indexOf("第 10-12 行") < r.text.indexOf("第 100-101 行"));
});

test("start 越界 → 降级 note，不抛", async () => {
  const r = await runRecon({ filesRanges: [{ path: "big.txt", start: 250, end: 260 }], cwd });
  assert.equal(r.filesIncluded, 0);
  assert.equal(r.text, "");
  assert.ok(r.notes.some((n) => /big\.txt 第 250-260 行/.test(n) && /起点越界/.test(n) && /共 200 行/.test(n)), r.notes.join(";"));
});

test("end 越界 → 附到文件末行并写 note", async () => {
  const r = await runRecon({ filesRanges: [{ path: "big.txt", start: 198, end: 260 }], cwd });
  assert.equal(r.filesIncluded, 1);
  assert.ok(hasLine(r.text, 198) && hasLine(r.text, 200));
  assert.ok(/第 198-200 行/.test(r.text), "块头标注实际附入的终点");
  assert.ok(r.notes.some((n) => /终点越界/.test(n) && /第 200 行/.test(n)));
});

test("非法范围（end < start / start 0）→ note，不抛", async () => {
  const r = await runRecon({ filesRanges: [{ path: "big.txt", start: 60, end: 50 }, { path: "big.txt", start: 0, end: 5 }], cwd });
  assert.equal(r.filesIncluded, 0);
  assert.equal(r.notes.filter((n) => /范围非法/.test(n)).length, 2);
});

test("路径 jail：越界路径被拒为 note，合法段仍附入", async () => {
  const r = await runRecon(
    { filesRanges: [{ path: "/etc/passwd", start: 1, end: 3 }, { path: "sub/small.txt", start: 2, end: 3 }], cwd },
  );
  assert.equal(r.filesIncluded, 1);
  assert.ok(r.notes.some((n) => /跳过 \/etc\/passwd 第 1-3 行/.test(n)), r.notes.join(";"));
  assert.ok(!/root:/.test(r.text), "越界内容未泄入材料");
  assert.ok(/^\s*2\| b$/m.test(r.text) && /^\s*3\| c$/m.test(r.text));
});

test("目录 / 不存在的文件 → note", async () => {
  const r = await runRecon({ filesRanges: [{ path: "sub", start: 1, end: 2 }, { path: "nope.txt", start: 1, end: 2 }], cwd });
  assert.equal(r.filesIncluded, 0);
  assert.ok(r.notes.some((n) => /是目录/.test(n)));
  assert.ok(r.notes.some((n) => /nope\.txt/.test(n)));
});

test("单段超 PER_FILE_MAX_CHARS → 按整行截断并写 note，行号仍真实", async () => {
  // 1..100 行约 3,100 字符 > 1000
  const r = await runRecon({ filesRanges: [{ path: "big.txt", start: 1, end: 100 }], cwd });
  assert.equal(r.filesIncluded, 1);
  const note = r.notes.find((n) => /已截断/.test(n) && /单段上限 1000/.test(n));
  assert.ok(note, r.notes.join(";"));
  assert.ok(hasLine(r.text, 1));
  assert.ok(!hasLine(r.text, 100), "第 100 行已被截掉");
  // 截在整行边界：最后一行必须是完整的一行
  const last = r.text.trimEnd().split("\n").pop() ?? "";
  assert.ok(/^\s*\d+\| line \d{3} content xxxxxxxxxx$/.test(last), `末行完整: ${last}`);
});

test("总量超 RECON_MAX_CHARS：逐块校验，装不下的整块降级为 note", async () => {
  // 每个整份文件截到 ~1000 字符 + 块头 ≈ 1,100；两个装得下、第三个 3,300 > 2,500 降级。
  const r = await runRecon({ files: ["big.txt", "big2.txt", "big3.txt"], cwd });
  assert.equal(r.filesIncluded, 2, r.notes.join(";"));
  assert.ok(/FILE big\.txt/.test(r.text) && /FILE big2\.txt/.test(r.text));
  assert.ok(!/FILE big3\.txt/.test(r.text));
  assert.ok(r.notes.some((n) => /big3\.txt 未附入/.test(n) && /超上限 2500/.test(n)), r.notes.join(";"));
  // 正文块之和 ≤ RECON_MAX（头部不计入该账，历史口径）
  const bodyLen = r.text.length - r.text.indexOf("\n=====");
  assert.ok(bodyLen <= RECON_MAX_CHARS, `正文 ${bodyLen} ≤ ${RECON_MAX_CHARS}`);
});

test("总量顶满后 files_ranges 小块同样受逐块校验；只装得下的进", async () => {
  const r = await runRecon(
    {
      files: ["big.txt", "big2.txt"],
      filesRanges: [{ path: "big3.txt", start: 1, end: 60 }, { path: "big3.txt", start: 5, end: 6 }],
      cwd,
    },
  );
  // 1-60 行约 1,860 字符装不下（已用 ~2,200）；5-6 行约 130 字符装得下。
  assert.equal(r.filesIncluded, 3, r.notes.join(";"));
  assert.ok(r.notes.some((n) => /big3\.txt 第 1-60 行 未附入/.test(n)));
  assert.ok(/FILE big3\.txt 第 5-6 行/.test(r.text));
});

test("无任何入参 → 空结果 usedChars=0", async () => {
  const r = await runRecon({ cwd });
  assert.equal(r.text, "");
  assert.equal(r.usedChars, 0);
});

test("zod 入参：files_ranges 形状与 deps 字面量", async () => {
  const { z } = await import("zod");
  const { moaToolInput } = await import("../src/mcp/tools.ts");
  const schema = z.object(moaToolInput);
  assert.ok(schema.safeParse({ prompt: "x", files_ranges: [{ path: "a.go", start: 1, end: 1 }] }).success, "start=end 合法");
  assert.ok(schema.safeParse({ prompt: "x", files_ranges: [{ path: "a.go", start: 3, end: 9 }], deps: "auto" }).success);
  assert.ok(!schema.safeParse({ prompt: "x", files_ranges: [{ path: "a.go", start: 0, end: 9 }] }).success, "start=0 被拒");
  assert.ok(!schema.safeParse({ prompt: "x", files_ranges: [{ path: "a.go", start: 9, end: 3 }] }).success, "end<start 被拒");
  assert.ok(!schema.safeParse({ prompt: "x", files_ranges: [{ path: "", start: 1, end: 3 }] }).success, "空 path 被拒");
  assert.ok(!schema.safeParse({ prompt: "x", files_ranges: [{ path: "a.go", start: 1.5, end: 3 }] }).success, "非整数被拒");
  assert.ok(!schema.safeParse({ prompt: "x", deps: "yes" }).success, "deps 只收 \"auto\"");
});

test("applyRecon 透传 files_ranges/deps 到 runRecon（context 含切片块）", async () => {
  const { applyRecon } = await import("../src/mcp/tools.ts");
  const req = await applyRecon(
    { prompt: "p", preset: "default", cwd },
    { prompt: "p", files_ranges: [{ path: "big.txt", start: 7, end: 8 }] },
  );
  assert.ok(req.context && /FILE big\.txt 第 7-8 行/.test(req.context) && hasLine(req.context, 7) && hasLine(req.context, 8));
  const none = await applyRecon({ prompt: "p", preset: "default", cwd }, { prompt: "p" });
  assert.equal(none.context, undefined, "无 files/files_ranges/recon_query ⇒ 不动 req");
});
