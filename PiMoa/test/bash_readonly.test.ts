// bash_readonly 安全测试：命令级只读闸（放行取证只读、拒绝一切写/执行/重定向/串接/不可解析）。
// 直接测纯判决内核 analyzeCommand（无 I/O、无 pi 依赖），再加一条 execFile shell:false 冒烟。
import { analyzeCommand, tokenize } from "../src/tools/bash_readonly_policy.ts";
import { runBashReadonly } from "../src/tools/bash_readonly.ts";

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

function allow(cmd: string) {
	const r = analyzeCommand(cmd);
	ok(r.allowed === true, `放行: ${cmd}`);
}
function reject(cmd: string) {
	const r = analyzeCommand(cmd);
	const rejected = r.allowed === false;
	const why = r.allowed === false ? r.reason : "(误放！)";
	ok(rejected, `拒绝: ${cmd}  →  ${why}`);
}

console.log("── 放行（只读取证 allowlist）──");
allow("git diff");
allow("git log --oneline");
allow("git status");
allow("git show HEAD");
allow("sha256sum f");
allow("md5sum f");
allow("shasum -a 256 f");
allow("stat f");
allow("file f");
allow("wc -l f");
allow("readlink f");
allow("realpath f");
allow("du -sh f");
allow("df -h");
allow("ls -la");
allow("cat f");
allow("head -n 5 f");
allow("tail -n 5 f");
allow("grep x f");
allow("grep -n 'a b' f"); // 引号内空格：单 token，不误拒
allow("rg pattern");
allow("pwd");
allow("echo hello");
allow("find . -name '*.py'"); // 只读 find（无 -exec/-delete）

console.log("── 拒绝（安全关键，逐条）──");
reject("echo x > f"); // 写重定向
reject("git diff > /tmp/x"); // 白名单命令带写重定向（正是 tree-sitter 会漏的洞）
reject("git diff >> /tmp/x"); // 追加重定向
reject("sed -i s/a/b/ f"); // 非白名单 + 原地写
reject("rm f"); // 删除
reject("bash -c 'rm f'"); // shell wrapper
reject("eval \"rm f\""); // eval wrapper
reject("git diff && rm f"); // && 串接
reject("git diff ; rm f"); // ; 串接
reject("git diff || rm f"); // || 串接
reject("cat f | tee g"); // 管道写
reject("find . -exec rm {} \\;"); // find -exec
reject("find . -delete"); // find -delete（无结构元字符也拦）
reject("$(rm f)"); // 命令替换
reject("cat `rm f`"); // 反引号命令替换
reject('echo "$(rm f)"'); // 双引号内命令替换
reject("sudo cat /etc/shadow"); // sudo wrapper（非白名单）
reject("env X=1 rm f"); // env wrapper（非白名单）
reject("xargs rm < list"); // xargs + 重定向
reject("git diff 'unclosed"); // 引号未闭合 → 不可解析
reject("cat f\nrm g"); // 换行多命令
reject("/bin/sh"); // 路径限定二进制
reject("FOO=bar cat f"); // 赋值前缀
reject("git -c core.pager=touch\\ x log"); // git -c 配置注入执行外部命令
reject("git config user.name x"); // git 写子命令
reject("git commit -m x"); // git 写子命令
reject("git diff --output=/tmp/x"); // git 写文件 flag
reject("git diff --ext-diff"); // git 外部 diff 工具
reject("tail -f f"); // 会挂起
reject(""); // 空命令
reject("   "); // 纯空白
reject("cat ${HOME}/f"); // 变量展开
reject("cat f{1,2}"); // brace 展开
reject("(cat f)"); // 子 shell

console.log("── tokenize 直测（quote-aware）──");
{
	const t = tokenize("grep -n 'a b' f");
	ok(t.ok && t.tokens.length === 4 && t.tokens[2] === "a b", "引号聚合成单 token");
}
{
	const t = tokenize("git diff > f");
	ok(t.ok === false, "tokenize 拦 >");
}

console.log("── execFile shell:false 冒烟（真实执行放行命令）──");
await (async () => {
	const r = await runBashReadonly("echo hello-readonly", process.cwd());
	ok(r.rejected === false && r.text.includes("hello-readonly"), "echo 执行回 stdout");
	const r2 = await runBashReadonly("pwd", process.cwd());
	ok(r2.rejected === false && r2.text.includes("/"), "pwd 执行回 stdout");
	// 拒绝路径：不执行、带原因
	const r3 = await runBashReadonly("echo x > /tmp/should_not_exist_xyz", process.cwd());
	ok(r3.rejected === true, "写重定向在 runBashReadonly 层被拒（不落地）");
	// 确认未落地（execFile shell:false 也不会解释 >，双重保证）
	const r4 = await runBashReadonly("rm -rf /tmp/nope", process.cwd());
	ok(r4.rejected === true, "rm 被拒");
})();

console.log(`\n[bash_readonly-test] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
