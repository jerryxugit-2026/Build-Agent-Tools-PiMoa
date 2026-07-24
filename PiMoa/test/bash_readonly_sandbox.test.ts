// 沙箱执行 + 4 条 RCE 回归 + 路径 jail 的安全测试。
// 分两层：
//  (1) 策略层：analyzeCommand 对 4 条 RCE 与附带面逐条断言「现在被拒 / 被硬化」。
//  (2) 沙箱层：真实 spawn sandbox-exec，实证「读密钥失败 / 写外部失败 / 联网失败 / env 无 *_API_KEY」。
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { analyzeCommand } from "../src/tools/bash_readonly_policy.ts";
import { runBashReadonly } from "../src/tools/bash_readonly.ts";
import { buildSandboxedInvocation, isSandboxAvailable } from "../src/tools/sandbox.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log("  ✅", name);
  } else {
    fail++;
    console.log("  ❌", name);
  }
}
function reject(cmd: string) {
  const r = analyzeCommand(cmd);
  ok(r.allowed === false, `拒绝: ${cmd}  →  ${r.allowed === false ? r.reason : "(误放！)"}`);
}
function allow(cmd: string) {
  const r = analyzeCommand(cmd);
  ok(r.allowed === true, `放行: ${cmd}`);
}

console.log("── RCE#1: git 全局带值选项吞假子命令（严格位置解析：前置全局 flag 一律拒）──");
reject("git --git-dir diff init"); // 旧洞：--git-dir 吞掉 diff，init 成真子命令
reject("git --git-dir=/x diff init");
reject("git --namespace log filter-branch --tree-filter x"); // 旧洞：任意 shell 执行
reject("git --work-tree=/tmp status");
reject("git --attr-source=HEAD log");
reject("git -c core.pager=x log"); // 前置 -c
reject("git --exec-path=/tmp log");
allow("git diff"); // 正常子命令仍放行
allow("git log --oneline");
allow("git status");
allow("git show HEAD");

console.log("── RCE#2: rg --pre 等外部程序执行（flag denylist）──");
reject("rg --pre /bin/sh pattern");
reject("rg --pre=/bin/sh pattern");
reject("rg --pre-glob x pattern");
reject("rg --hostname-bin /bin/sh pattern");
reject("rg --config /tmp/evil.rc pattern");
allow("rg pattern"); // 正常 rg 仍放行
allow("rg -n foo file");

console.log("── RCE#3: git grep -O<程序> 绕 pager（大小写敏感 -O/-o 前缀）──");
reject("git grep -Otouch pat"); // 大写 -O：旧实现只拦小写 -o 且靠 pager 子串 → 漏
reject("git grep -O/bin/sh pat");
reject("git grep -otouch pat"); // 小写粘连取值
reject("git grep --open-files-in-pager=/bin/sh pat");
allow("git grep pattern"); // 正常 git grep 仍放行

console.log("── RCE#4: 敌意 .git/config diff.external（命令级 --no-ext-diff --no-textconv 注入）──");
{
  const r = analyzeCommand("git diff");
  const argv = r.allowed ? r.argv : [];
  ok(
    r.allowed && argv.includes("--no-ext-diff") && argv.includes("--no-textconv"),
    `git diff 注入 --no-ext-diff --no-textconv  →  argv=[${argv.join(" ")}]`,
  );
  const r2 = analyzeCommand("git show HEAD");
  const argv2 = r2.allowed ? r2.argv : [];
  ok(
    r2.allowed && argv2.includes("--no-ext-diff"),
    `git show 注入 --no-ext-diff  →  argv=[${argv2.join(" ")}]`,
  );
  const r3 = analyzeCommand("git log -p");
  const argv3 = r3.allowed ? r3.argv : [];
  ok(r3.allowed && argv3.includes("--no-ext-diff"), `git log 注入 --no-ext-diff`);
  // 硬化 -c（fsmonitor/hooks/ssh/ext）注入到所有 git 命令
  const r4 = analyzeCommand("git status");
  const argv4 = r4.allowed ? r4.argv : [];
  ok(
    r4.allowed && argv4.includes("core.hooksPath=/dev/null") && argv4.includes("core.fsmonitor="),
    `git status 注入硬化 -c（禁 hooks/fsmonitor）`,
  );
}

console.log("── 附带面：tail -qf / file -C / git --config-env ──");
reject("tail -qf f"); // 组合短选项含 f
reject("tail -qF f");
reject("tail --follow=name f"); // GNU 长式 follow=name（旧洞：短簇正则不匹配、不在 deny 集 → 漏 → GNU tail 挂起）
reject("tail --follow f"); // GNU 长式 --follow
allow("tail -n 5 f"); // 正常 tail 放行
allow("tail -c 100 f");
allow("tail f"); // 无 flag 正常 tail 放行
reject("file -C -m /tmp/m f"); // file 写 magic
reject("file --compile f");
allow("file f");
reject("git --config-env=EVIL=x log"); // 前置全局 flag → 位置解析拒
reject("git log --config-env=EVIL=x"); // 子命令后 --config-env → isDangerousGitArg 拒

console.log("── 路径 jail（越出审计根即拒；沙箱外第二道）──");
{
  const base = mkdtempSync(join(tmpdir(), "pimoa-jailtest-"));
  const target = join(base, "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "in.txt"), "inside");
  const runJail = async (cmd: string) => (await runBashReadonly(cmd, target)).rejected;
  await (async () => {
    ok(await runJail("cat /etc/passwd"), "jail 拒 cat /etc/passwd（绝对路径逃逸）");
    ok(await runJail("cat ../../../../etc/passwd"), "jail 拒 .. 目录穿越");
    ok(await runJail(`cat ${join(homedir(), ".ssh", "id_rsa")}`), "jail 拒 ~/.ssh 绝对路径");
    // 目标内相对路径不误拒（放行执行）
    const rin = await runBashReadonly("cat in.txt", target);
    ok(rin.rejected === false && rin.text.includes("inside"), "jail 放行 target 内相对路径 cat in.txt");
  })();
  rmSync(base, { recursive: true, force: true });
}

console.log("── 硬链接读逃逸（nlink 检测；覆盖裸文件名，对抗审残余清零）──");
{
  const base = mkdtempSync(join(tmpdir(), "pimoa-hltest-"));
  const target = join(base, "target"); // = cwd（审计根）
  mkdirSync(target, { recursive: true });
  // cwd 外的秘密文件（同卷，才能建硬链接）
  const outsideSecret = join(base, "OUTSIDE_SECRET.txt");
  writeFileSync(outsideSecret, "HARDLINK-LEAK-SECRET");
  // cwd 内硬链接 → 指向 cwd 外秘密（realpath 不解硬链接、沙箱按路径放行 → 旧洞可读出秘密）
  const hlPath = join(target, "hl_secret");
  const hlBareName = "hl_secret"; // 裸文件名参数（jail 的 looksPath 会漏，正是 PoC）
  linkSync(outsideSecret, hlPath);
  // 正常文件（nlink=1）
  writeFileSync(join(target, "normal.txt"), "normal-ok");
  await (async () => {
    ok(statSync(hlPath).nlink > 1, `前置：硬链接 nlink=${statSync(hlPath).nlink}（>1）`);
    // 1) 绝对路径硬链接被拒
    const rAbs = await runBashReadonly(`cat ${hlPath}`, target);
    ok(rAbs.rejected === true && !rAbs.text.includes("HARDLINK-LEAK-SECRET"), `拒 cat <绝对硬链接>（未泄密）→ ${rAbs.reason ?? ""}`);
    // 2) ★裸文件名硬链接被拒（PoC 场景：cat hl_secret）
    const rBare = await runBashReadonly(`cat ${hlBareName}`, target);
    ok(rBare.rejected === true && !rBare.text.includes("HARDLINK-LEAK-SECRET"), `拒 cat hl_secret（裸文件名，未泄密）→ ${rBare.reason ?? ""}`);
    // 3) 裸文件名硬链接经其它读命令（stat/head/grep）也被拒
    const rHead = await runBashReadonly("head hl_secret", target);
    ok(rHead.rejected === true, "拒 head hl_secret（裸文件名硬链接）");
    // 4) 正常文件（nlink=1）仍放行
    const rNorm = await runBashReadonly("cat normal.txt", target);
    ok(rNorm.rejected === false && rNorm.text.includes("normal-ok"), "放行 cat normal.txt（nlink=1，不误伤）");
  })();
  rmSync(base, { recursive: true, force: true });
}

console.log("── symlink 越界读逃逸（realpath jail；修复 &&→只判 canonical real）──");
{
  const base = mkdtempSync(join(tmpdir(), "pimoa-symtest-"));
  const target = join(base, "target"); // = cwd（审计根）
  mkdirSync(target, { recursive: true });
  // cwd 外的秘密文件
  const outsideSecret = join(base, "OUTSIDE_SECRET.txt");
  writeFileSync(outsideSecret, "SYMLINK-LEAK-SECRET");
  // cwd 内 symlink → 指向 cwd 外秘密（abs 字面在 cwd 内，realpath 解出 target 外 → 旧 && 逻辑漏判）
  symlinkSync(outsideSecret, join(target, "slink_dot")); // 带 ./ 前缀访问（looksPath）
  symlinkSync(outsideSecret, join(target, "slink_bare")); // ★裸文件名访问（旧 looksPath gate 会漏 → 元数据侧信道）
  // 正常文件（cwd 内、非 symlink）
  writeFileSync(join(target, "normal.txt"), "normal-ok");
  await (async () => {
    // 1) 带 ./ 前缀（路径样式）：跟随 symlink 读 target 外元数据 → 必须被拒（第一轮已修）
    const rStat = await runBashReadonly("stat -L ./slink_dot", target);
    ok(
      rStat.rejected === true && !rStat.text.includes("SYMLINK-LEAK-SECRET"),
      `拒 stat -L ./slink_dot（symlink 越界，未泄元数据）→ ${rStat.reason ?? ""}`,
    );
    const rCat = await runBashReadonly("cat ./slink_dot", target);
    ok(
      rCat.rejected === true && !rCat.text.includes("SYMLINK-LEAK-SECRET"),
      `拒 cat ./slink_dot（symlink 越界，未泄密）→ ${rCat.reason ?? ""}`,
    );
    // 2) ★裸文件名 symlink（PoC：stat -L slink_bare）→ 必须被拒、元数据不进 text（收口元数据侧信道）
    const rStatBare = await runBashReadonly("stat -L slink_bare", target);
    ok(
      rStatBare.rejected === true && !rStatBare.text.includes("SYMLINK-LEAK-SECRET"),
      `拒 stat -L slink_bare（裸名 symlink 越界，元数据未泄）→ ${rStatBare.reason ?? ""}`,
    );
    const rCatBare = await runBashReadonly("cat slink_bare", target);
    ok(
      rCatBare.rejected === true && !rCatBare.text.includes("SYMLINK-LEAK-SECRET"),
      `拒 cat slink_bare（裸名 symlink 越界，未泄密）→ ${rCatBare.reason ?? ""}`,
    );
    const rLsBare = await runBashReadonly("ls -lL slink_bare", target);
    ok(rLsBare.rejected === true, `拒 ls -lL slink_bare（裸名 symlink 越界）→ ${rLsBare.reason ?? ""}`);
    // 3) 不误伤：cwd 内正常裸名文件仍放行
    const rNorm = await runBashReadonly("cat normal.txt", target);
    ok(
      rNorm.rejected === false && rNorm.text.includes("normal-ok"),
      "放行 cat normal.txt（cwd 内真实裸名文件，不误伤）",
    );
    // 4) 不误伤：git-revision 风格裸 token（cwd 内无 HEAD 文件）→ realpath 上溯到 root → 不因 jail 拒
    //    （stat 会因文件不存在自身失败，但不能是「路径 jail」拒——rejected 仍为 false）
    const rRev = await runBashReadonly("stat HEAD", target);
    ok(
      rRev.rejected === false,
      `不误拒 stat HEAD（不存在的裸 token 交命令自身处理，非 jail 拒）→ rejected=${rRev.rejected}`,
    );
  })();
  rmSync(base, { recursive: true, force: true });
}

console.log("── cwd 前缀含 symlink 的合法场景不误拒（canonical root vs canonical real）──");
{
  const base = mkdtempSync(join(tmpdir(), "pimoa-symcwd-"));
  const realRoot = join(base, "realroot"); // 真实目录
  mkdirSync(realRoot, { recursive: true });
  writeFileSync(join(realRoot, "inside.txt"), "prefixed-ok");
  // linkroot → symlink 指向 realRoot；用它当 cwd（cwd 前缀本身含 symlink）
  const linkedCwd = join(base, "linkroot");
  symlinkSync(realRoot, linkedCwd);
  await (async () => {
    // ./inside.txt 是路径样式：realpath 解出 realroot/inside.txt（canonical），root=realpath(linkroot)=realroot
    //   → withinRoot(real) 真 → jail 放行（不误拒）。旧若误比 abs（linkroot/inside.txt）会误拒。
    const rIn = await runBashReadonly("cat ./inside.txt", linkedCwd);
    ok(rIn.rejected === false, `放行 cat ./inside.txt（cwd 前缀含 symlink，canonical 比较不误拒）→ ${rIn.reason ?? ""}`);
  })();
  rmSync(base, { recursive: true, force: true });
}

console.log("── 沙箱边界实证（真实 spawn sandbox-exec）──");
if (!isSandboxAvailable()) {
  console.log("  ⚠️ 沙箱不可用（非 darwin），跳过边界实证——但工具会 fail-closed 拒执行。");
} else {
  const base = mkdtempSync(join(tmpdir(), "pimoa-sbtest-"));
  const target = join(base, "target");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "ok.txt"), "readable");
  // target 之外的假密钥（沙箱应读不到）
  const secret = join(base, "SECRET_outside.txt");
  writeFileSync(secret, "TOP-SECRET-KEY");
  const outWrite = join(base, "escaped_write.txt");

  // 直接在沙箱层构造调用（绕过策略闸，专测沙箱围栏本身），注入假 API key 到父 env 验证剥离。
  process.env.PIMOA_FAKE_MINIMAX_API_KEY = "sk-should-be-stripped-123";

  const runSandbox = (argv: string[]): { code: number | null; out: string } => {
    const built = buildSandboxedInvocation(argv, target);
    if ("error" in built) return { code: null, out: `BUILD-ERROR:${built.error}` };
    try {
      const out = execFileSync(built.file, built.args, {
        cwd: built.cwd,
        env: built.env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      built.cleanup();
      return { code: 0, out };
    } catch (e: unknown) {
      built.cleanup();
      const ex = e as { status?: number | null; stdout?: string; stderr?: string };
      return {
        code: ex.status ?? null,
        out: `${ex.stdout ?? ""}${ex.stderr ?? ""}`,
      };
    }
  };

  // 1) 读 target 内文件：应成功
  const rIn = runSandbox(["cat", join(target, "ok.txt")]);
  ok(rIn.code === 0 && rIn.out.includes("readable"), `沙箱内读 target 文件成功  →  ${rIn.out.trim().slice(0, 40)}`);

  // 2) 读 target 之外的密钥：应失败（Operation not permitted）
  const rSecret = runSandbox(["cat", secret]);
  ok(
    rSecret.code !== 0 && !rSecret.out.includes("TOP-SECRET-KEY"),
    `沙箱挡住读 target 外密钥（code=${rSecret.code}）  →  ${rSecret.out.trim().slice(0, 60)}`,
  );

  // 3) 读 ~/.ssh：应失败
  const sshProbe = join(homedir(), ".ssh");
  const rSsh = runSandbox(["ls", sshProbe]);
  ok(rSsh.code !== 0, `沙箱挡住读 ~/.ssh（code=${rSsh.code}）  →  ${rSsh.out.trim().slice(0, 60)}`);

  // 4) 写 target 外文件：应失败且文件不落地
  const rWrite = runSandbox(["touch", outWrite]);
  ok(
    rWrite.code !== 0 && !existsSync(outWrite),
    `沙箱挡住写 scratch 外文件（code=${rWrite.code}，文件未落地=${!existsSync(outWrite)}）`,
  );

  // 5) 联网：应失败（无网络）
  const rNet = runSandbox(["nc", "-w", "2", "-z", "1.1.1.1", "443"]);
  ok(rNet.code !== 0, `沙箱挡住联网 nc 1.1.1.1:443（code=${rNet.code}）  →  ${rNet.out.trim().slice(0, 60)}`);

  // 6) env 无 *_API_KEY：子进程 env 从零构建
  const rEnv = runSandbox(["env"]);
  const leaked = /API_KEY|SECRET|TOKEN|sk-should-be-stripped/i.test(rEnv.out);
  ok(!leaked, `子进程 env 无 *_API_KEY/SECRET/TOKEN（从零构建）  →  ${leaked ? "泄漏！" : "干净"}`);
  console.log("    [env 实测输出片段]", rEnv.out.replace(/\n/g, " ").slice(0, 120));

  // 7) RCE#4 端到端：敌意仓库 .git/config diff.external 不得执行外部程序、marker 不落地
  const evilMarker = join(base, "EVIL_RAN.txt");
  const repo = join(base, "hostile_repo");
  mkdirSync(repo, { recursive: true });
  try {
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    // 敌意 repo-local 配置：diff.external 指向一个会写 marker 的脚本
    const evilSh = join(repo, "evil.sh");
    writeFileSync(evilSh, `#!/bin/sh\necho pwned > "${evilMarker}"\n`, { mode: 0o755 });
    execFileSync("git", ["-C", repo, "config", "diff.external", evilSh], { stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=a@b.c", "-c", "user.name=a", "-C", repo, "commit", "-qm", "init"],
      { stdio: "ignore" },
    );
    writeFileSync(join(repo, "a.txt"), "two\n"); // 制造 diff
    const rDiff = await runBashReadonly("git diff", repo);
    ok(
      !existsSync(evilMarker),
      `RCE#4：敌意 diff.external 未执行（--no-ext-diff 注入 + 沙箱），marker 未落地=${!existsSync(evilMarker)}`,
    );
    ok(rDiff.rejected === false, `RCE#4：git diff 仍正常返回（未误拒），text 片段=${rDiff.text.slice(0, 40).replace(/\n/g, " ")}`);
  } catch (e) {
    ok(false, `RCE#4 端到端异常：${e instanceof Error ? e.message : String(e)}`);
  }

  delete process.env.PIMOA_FAKE_MINIMAX_API_KEY;
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n[bash_readonly_sandbox-test] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
