// 跨仓只读根 + 密钥拒读 测试（2026-08-04，徐总："<volume>/ai_workspace 及子目录对 PiMoa 可读"）。
// 无测试框架，直接 npx tsx 跑：
//   CLIPROXY_API_KEY=dummy npx tsx test/access.test.ts
//
// 覆盖四类断言（每类都带**负例**，正例单独看不出闸有没有真拦）：
//   A. 路径 jail：跨根放行 / 根外拒 / 密钥拒（含 symlink 指向密钥）
//   B. 沙箱 SBPL：跨根真能读到 / 密钥文件**内核级**拒（含 `rg 目录/` 递归读这条 argv 检查管不到的路）
//   C. semble 搜索根：跨根绝对路径放行 / 根外拒
//   D. ★回归锁：读根放开后，**写根不得跟着放大** —— deliver 往读根内、写根外的路径写必须仍被拒
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalizeReadRoots,
  effectiveReadRoots,
  isWithinRoots,
  secretDenyReason,
  ReadRootError,
} from "../src/tools/access.ts";
import { checkPathJail, runBashReadonly } from "../src/tools/bash_readonly.ts";
import { buildSandboxProfile } from "../src/tools/sandbox.ts";
import { atomicWriteWithVerify } from "../src/deliver/write.ts";
import { runRecon } from "../src/moa/recon.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log("  ✅", name);
  } else {
    fail++;
    console.log("  ❌", name);
  }
}
function threw(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── 造两棵互不包含的树，模拟"跨仓"：repoA=会话 cwd，repoB=另一个仓 ──
// ★realpath：macOS 的 $TMPDIR（/var/folders/…）本身是指向 /private/var/… 的 symlink。
//   产品侧 checkPathJail 会把根与目标**都** realpath 后再比，故测试也必须用 canonical 路径，
//   否则测的是 "/var 前缀 vs /private/var 前缀" 这个与被测逻辑无关的差异。
const BASE = realpathSync(mkdtempSync(join(tmpdir(), "pimoa-access-")));
const repoA = join(BASE, "repoA");
const repoB = join(BASE, "repoB");
const outside = join(BASE, "outside"); // 两棵树之外（BASE 本身不作为读根）
for (const d of [repoA, repoB, outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(repoA, "a.txt"), "AAA_CONTENT\n");
writeFileSync(join(repoB, "spec.md"), "BBB_SPEC_CONTENT\n");
writeFileSync(join(outside, "o.txt"), "OUTSIDE_CONTENT\n");
// 密钥类文件（放在**允许根内**——正是放开读根后新增的暴露面）
writeFileSync(join(repoB, ".env"), "SECRET_ENV=leak\n");
writeFileSync(join(repoB, "auth.json"), '{"token":"leak"}\n');
writeFileSync(join(repoB, "server.pem"), "PRIVATE_KEY_LEAK\n");
writeFileSync(join(repoB, "model_registry.yaml"), "api_key: leak\n");
mkdirSync(join(repoB, ".ssh"), { recursive: true });
writeFileSync(join(repoB, ".ssh", "config"), "Host leak\n");
// symlink：根内的普通名字指向根内的密钥文件（检验判的是 realpath 而非字面名）
symlinkSync(join(repoB, ".env"), join(repoB, "innocent.txt"));

const ROOTS = [repoB]; // 配置读根（cwd=repoA 恒自动为根）

console.log("\n=== A. 路径 jail（server 进程内直读的唯一防线）===");
ok(checkPathJail(["read", join(repoA, "a.txt")], repoA, { readRoots: ROOTS }) === null, "cwd 内文件放行");
ok(
  checkPathJail(["read", join(repoB, "spec.md")], repoA, { readRoots: ROOTS }) === null,
  "★跨仓：另一只读根内的绝对路径放行（改造前必被拒）",
);
ok(
  checkPathJail(["read", join(repoB, "spec.md")], repoA) !== null,
  "负例：不传 readRoots ⇒ 仍是单根，跨仓被拒（向后兼容，未偷偷放开）",
);
ok(
  checkPathJail(["read", join(outside, "o.txt")], repoA, { readRoots: ROOTS }) !== null,
  "负例：所有根之外的路径仍被拒",
);
ok(
  checkPathJail(["read", "/etc/passwd"], repoA, { readRoots: ROOTS }) !== null,
  "负例：/etc/passwd 仍被拒",
);
for (const f of [".env", "auth.json", "server.pem", "model_registry.yaml"]) {
  ok(
    checkPathJail(["read", join(repoB, f)], repoA, { readRoots: ROOTS }) !== null,
    `负例：允许根内的密钥文件 ${f} 被拒`,
  );
}
ok(
  checkPathJail(["read", join(repoB, ".ssh", "config")], repoA, { readRoots: ROOTS }) !== null,
  "负例：允许根内的 .ssh/ 目录分量被拒",
);
ok(
  checkPathJail(["read", join(repoB, "innocent.txt")], repoA, { readRoots: ROOTS }) !== null,
  "负例：无辜文件名 symlink 指向密钥 ⇒ 按 realpath 判，仍被拒",
);

console.log("\n=== A2. 纯函数：根归一 / 密钥判定 ===");
ok(effectiveReadRoots(repoA, ROOTS).length === 2, "effectiveReadRoots = cwd + 配置根");
ok(effectiveReadRoots(repoA, [repoA]).length === 1, "重复根去重");
ok(isWithinRoots(join(repoB, "x", "y.ts"), effectiveReadRoots(repoA, ROOTS)), "子路径在根内");
ok(!isWithinRoots(join(BASE, "repoBB", "x.ts"), effectiveReadRoots(repoA, ROOTS)), "前缀相同但非子目录不算在根内（repoBB vs repoB）");
ok(secretDenyReason("/x/.env.production") !== null, ".env.local/.env.production 类命中");
ok(secretDenyReason("/x/AUTH.JSON") !== null, "大小写不敏感命中（APFS 默认大小写不敏感）");
ok(secretDenyReason("/x/credentials.ts") === null, "误伤检查：credentials.ts 不算密钥");
ok(secretDenyReason("/x/session.ts") === null, "误伤检查：普通源码不算密钥");

console.log("\n=== A3. 配置加载期强校验（fail-loud）===");
ok(canonicalizeReadRoots([repoB]).length === 1, "合法根通过并归一");
ok(threw(() => canonicalizeReadRoots(["relative/path"])) !== null, "负例：相对路径拒");
ok(threw(() => canonicalizeReadRoots([join(BASE, "no-such-dir")])) !== null, "负例：不存在的根拒");
ok(threw(() => canonicalizeReadRoots([join(repoA, "a.txt")])) !== null, "负例：根是文件而非目录 ⇒ 拒");
ok(threw(() => canonicalizeReadRoots(["/"])) !== null, '负例：根为 "/" 拒');
ok(
  threw(() => canonicalizeReadRoots([process.env.HOME as string])) !== null,
  "负例：根覆盖 $HOME ⇒ 拒（否则 ~/.ssh 全进可读面）",
);
ok(
  (threw(() => canonicalizeReadRoots(["relative/path"])) ?? "").includes("[access]"),
  "错误信息带 [access] 前缀，便于定位",
);
ok(new ReadRootError("x") instanceof Error, "ReadRootError 是 Error 子类");

console.log("\n=== B. 沙箱 SBPL（挡目录级递归读，argv 检查管不到的那条路）===");
const profile = buildSandboxProfile(repoA, join(BASE, "scratch-unused"), ROOTS);
mkdirSync(join(BASE, "scratch-unused"), { recursive: true });
function sandboxCat(path: string): { out: string; denied: boolean } {
  try {
    const out = execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, denied: false };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { out: "", denied: /not permitted|Operation not permitted/i.test(String(e.stderr ?? e.message ?? "")) };
  }
}
ok(sandboxCat(join(repoA, "a.txt")).out.includes("AAA_CONTENT"), "沙箱内可读 cwd 根");
ok(
  sandboxCat(join(repoB, "spec.md")).out.includes("BBB_SPEC_CONTENT"),
  "★沙箱内可读另一只读根（跨仓取证真能跑）",
);
ok(sandboxCat(join(outside, "o.txt")).denied, "负例：沙箱内读根外文件被拒");
for (const f of [".env", "auth.json", "server.pem", "model_registry.yaml"]) {
  ok(sandboxCat(join(repoB, f)).denied, `负例：沙箱内读允许根中的 ${f} 被内核拒`);
}
// ★关键：目录级递归读——`rg 模式 目录/` 的 argv 里没有密钥文件名，checkPathJail 看不到它，
//   只有 SBPL 的 deny 挡得住。这里直接验"递归读不出密钥内容"。
let recursiveOut = "";
try {
  recursiveOut = execFileSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/opt/homebrew/bin/rg", "--no-heading", "-n", "leak", repoB],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  recursiveOut = String((err as { stdout?: string }).stdout ?? "");
}
ok(
  !recursiveOut.includes("SECRET_ENV") &&
    !recursiveOut.includes("PRIVATE_KEY_LEAK") &&
    !recursiveOut.includes("api_key"),
  "★负例（最关键）：`rg leak <目录>` 递归读不出任何密钥内容（argv 检查管不到，靠 SBPL 内核 deny）",
);

console.log("\n=== B2. 端到端：bash_readonly 工具级跨仓 ===");
const rBash = await runBashReadonly(`cat ${JSON.stringify(join(repoB, "spec.md"))}`, repoA, undefined, ROOTS);
ok(!rBash.rejected && rBash.text.includes("BBB_SPEC_CONTENT"), "★bash_readonly 跨仓 cat 取到另一仓内容");
const rBashOut = await runBashReadonly(`cat ${JSON.stringify(join(outside, "o.txt"))}`, repoA, undefined, ROOTS);
ok(rBashOut.rejected, "负例：bash_readonly 读根外文件被拒");
const rBashSecret = await runBashReadonly(`cat ${JSON.stringify(join(repoB, ".env"))}`, repoA, undefined, ROOTS);
ok(rBashSecret.rejected && !rBashSecret.text.includes("SECRET_ENV"), "负例：bash_readonly 读密钥被拒且不回显内容");
const rBashNoRoots = await runBashReadonly(`cat ${JSON.stringify(join(repoB, "spec.md"))}`, repoA);
ok(rBashNoRoots.rejected, "负例：不传 readRoots ⇒ 跨仓仍被拒（默认不放开）");

console.log("\n=== B3. 侦查前置（recon）跨仓读 ===");
const recon = await runRecon({ files: [join(repoB, "spec.md")], cwd: repoA, readRoots: ROOTS });
ok(recon.filesIncluded === 1 && recon.text.includes("BBB_SPEC_CONTENT"), "★recon 的 files 可给另一仓绝对路径");
const reconOut = await runRecon({ files: [join(outside, "o.txt")], cwd: repoA, readRoots: ROOTS });
ok(reconOut.filesIncluded === 0, "负例：recon 读根外文件被拒（降级为 note，不抛）");
const reconSecret = await runRecon({ files: [join(repoB, "auth.json")], cwd: repoA, readRoots: ROOTS });
ok(
  reconSecret.filesIncluded === 0 && !reconSecret.text.includes("leak"),
  "负例：recon 读密钥被拒且内容不进 context",
);

console.log("\n=== D. ★回归锁：读根放开，写根不得跟着放大 ===");
// deliver 的写根是**调用方传的 cwd**（mcp/server.ts: allowedRoots=[del.cwd]），与读根完全无关。
// 若哪天有人图省事把 readRoots 也喂给 allowedRoots，本组用例即刻变红。
const body = "报告正文\n\nDONE_REPORT\n";
const wrote = threw(() =>
  atomicWriteWithVerify({
    path: join(repoB, "should_not_be_written.md"),
    body,
    doneMarker: "DONE_REPORT",
    allowedRoots: [repoA], // 写根 = 会话 cwd，**不含** repoB（后者只是只读根）
  }),
);
ok(wrote !== null, "★往只读根（非写根）写入被拒 —— 读放开没有带写放开");
ok(
  threw(() => readFileSync(join(repoB, "should_not_be_written.md"), "utf8")) !== null,
  "★被拒后磁盘上确实没有该文件（不是只报错却写了）",
);
const wroteOk = threw(() =>
  atomicWriteWithVerify({
    path: join(repoA, "report.md"),
    body,
    doneMarker: "DONE_REPORT",
    allowedRoots: [repoA],
  }),
);
ok(wroteOk === null, "对照：写根内写入正常（不是把写路整个写死了）");
ok(readFileSync(join(repoA, "report.md"), "utf8") === body, "对照：写根内内容正确落盘");

console.log("\n=== C. semble 搜索根 ===");
// resolveSearchRoot 是模块私有，经工具入口间接验：构造 ctx.cwd=repoA，搜索 repoB 的绝对路径。
// 这里只验根解析（不依赖 semble CLI 是否装好）：越界必须在跑 CLI 之前就被拒。
const { createSembleSearchTool } = await import("../src/tools/semble_search.ts");
const tool = createSembleSearchTool(undefined, ROOTS);
const outRes = (await tool.execute(
  "t1",
  { query: "x", path: outside },
  undefined,
  undefined,
  { cwd: repoA } as never,
)) as { details?: { rejected?: boolean; reason?: string } };
ok(outRes.details?.rejected === true, "负例：semble 搜索根外目录被拒");
ok(String(outRes.details?.reason ?? "").includes("越界"), "负例：拒绝理由是越界");
const toolNoRoots = createSembleSearchTool(undefined, []);
const crossNoRoots = (await toolNoRoots.execute(
  "t2",
  { query: "x", path: repoB },
  undefined,
  undefined,
  { cwd: repoA } as never,
)) as { details?: { rejected?: boolean } };
ok(crossNoRoots.details?.rejected === true, "负例：不配 readRoots ⇒ semble 跨仓仍被拒");

console.log("\n=== E. `ls` 同名覆盖：内置 ls 无 jail（实证）→ 我们的版本必须拦住 ===");
// E0 先实证"被修的洞是真的"：pi 内置 ls 用 resolveToCwd，支持 ~ 与绝对路径且不做越界检查。
// 走文件系统绝对路径 import：该子路径不在包的 exports 映射里，按包名 import 会 ERR_PACKAGE_PATH_NOT_EXPORTED。
const PI_LS = resolve(
  import.meta.dirname,
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js",
);
const builtinLs = await import(PI_LS).then((m: any) => m.createLsToolDefinition(repoA));
const builtinOut = await (builtinLs as any).execute(
  "b1", { path: outside, limit: 5 }, undefined, undefined, {} as never,
);
ok(
  String(builtinOut.content?.[0]?.text ?? "").includes("o.txt"),
  "实证：pi 内置 ls **能**列审计根之外的目录（这正是要修的洞，不是假想）",
);
const { createLsTool } = await import("../src/tools/ls_jailed.ts");
const lsTool = createLsTool(ROOTS);
async function runLs(p: string) {
  return (await lsTool.execute("l1", { path: p }, undefined, undefined, { cwd: repoA } as never)) as {
    content?: Array<{ text: string }>;
    details?: { rejected?: boolean };
  };
}
const lsA = await runLs(".");
ok(lsA.details?.rejected !== true && String(lsA.content?.[0]?.text).includes("a.txt"), "jailed ls 列 cwd 正常");
const lsB = await runLs(repoB);
ok(lsB.details?.rejected !== true && String(lsB.content?.[0]?.text).includes("spec.md"), "★jailed ls 跨仓列另一只读根");
ok((await runLs(outside)).details?.rejected === true, "负例：jailed ls 列根外目录被拒");
ok((await runLs(`${process.env.HOME}/.ssh`)).details?.rejected === true, "负例：jailed ls 列 ~/.ssh 被拒（内置版会列出来）");
ok((await runLs("/etc")).details?.rejected === true, "负例：jailed ls 列 /etc 被拒");
ok((await runLs(join(repoB, ".ssh"))).details?.rejected === true, "负例：读根**内**的 .ssh 目录也被拒");
const lsNoRoots = createLsTool([]);
const lsCross = (await lsNoRoots.execute("l2", { path: repoB }, undefined, undefined, { cwd: repoA } as never)) as {
  details?: { rejected?: boolean };
};
ok(lsCross.details?.rejected === true, "负例：不配 readRoots ⇒ jailed ls 跨仓仍被拒");

console.log(`\n[access-test] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
