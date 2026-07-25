// bash_readonly 安全测试：命令级只读闸（放行取证只读、拒绝一切写/执行/重定向/串接/不可解析）。
// 直接测纯判决内核 analyzeCommand（无 I/O、无 pi 依赖），再加一条 execFile shell:false 冒烟。
import { analyzeCommand, tokenize } from "../src/tools/bash_readonly_policy.ts";
import { runBashReadonly } from "../src/tools/bash_readonly.ts";
import { resolve as resolveP } from "node:path";

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
allow("rg pattern");
allow("rg -n 'a b' f"); // 引号内空格：单 token，不误拒
allow("pwd");
allow("echo hello");

console.log("── 检索三件套（rg / ast-grep / rtk，§4.8）──");
// rg 保留（见上）；ast-grep 只读搜索
allow("ast-grep run -p 'isProposalOk($$$)' -l ts src"); // 单引号内 $ 作字面
allow("ast-grep -p 'foo($$$)' -l ts src/a.ts"); // 裸 -p = 默认 run
// rtk 只放纯读子命令
allow("rtk read package.json");
allow("rtk ls .");
allow("rtk json config/models.json");
// find / grep 已下线 → 拒（带引导替代）
reject("grep x f"); // grep 下线 → 引导 rg
reject("grep -n 'a b' f");
reject("find . -name '*.py'"); // find 下线 → 引导 rg/ast-grep

console.log("── 检索三件套门控：越权子命令/写 flag 一律拒 ──");
reject("ast-grep scan"); // scan 加载规则/可写
reject("ast-grep new rule"); // new 写盘
reject("ast-grep test"); // test 子命令
reject("ast-grep run -p 'x' -U"); // 原地更新（写）
reject("ast-grep run -p 'x' --update-all"); // 写
reject("ast-grep run -p 'x' --rewrite 'y'"); // 改写
reject("ast-grep run -p 'x' -i"); // 交互式应用（写）
reject("ast-grep run -p 'x' --config /tmp/sg.yml"); // 外部 sgconfig（可载动态库）
reject("ast-grep run -p 'x' -c /tmp/sg.yml"); // 对抗审#7：--config 短别名 -c
reject("ast-grep run -p 'x' -c=/tmp/sg.yml"); // -c=value
reject("ast-grep run -cx/tmp/sg.yml -p 'x'"); // -c 粘连取值
reject("rtk git diff"); // rtk git 沙箱跑不了 → 不放
reject("rtk grep foo ."); // rtk grep 归 rg
reject("rtk find . -name x"); // rtk find 归 ast-grep
reject("rtk docker ps"); // 任意命令执行
reject("rtk test npm test"); // 任意命令执行
reject("rtk err cargo build"); // 任意命令执行
reject("rtk -v read f"); // 前置全局 flag
reject("rtk"); // 缺子命令

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

console.log("── 对抗审 #8：ast-grep sgconfig 动态库加载 jail（live，真沙箱前置拒）──");
await (async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pimoa-sgcfg-"));
  try {
    // 敌意仓库：审计根放含 customLanguages/libraryPath 的 sgconfig.yml + 一个占位 .ts。
    writeFileSync(
      join(dir, "sgconfig.yml"),
      "ruleDirs: [rules]\ncustomLanguages:\n  evil:\n    libraryPath: ./libpwn.dylib\n    extensions: [evil]\n",
    );
    writeFileSync(join(dir, "a.ts"), "const isProposalOk = (r:any)=>!!r;\n");
    const r = await runBashReadonly("ast-grep run -p 'isProposalOk($$$)' -l ts .", dir);
    ok(r.rejected === true && /sgconfig|customLanguages|libraryPath/i.test(r.reason ?? ""), "含 customLanguages 的 sgconfig → ast-grep 前置拒");
    // 对照：无 sgconfig 时同命令应放行（不误伤正常仓库）。
    rmSync(join(dir, "sgconfig.yml"));
    const r2 = await runBashReadonly("ast-grep run -p 'isProposalOk($$$)' -l ts .", dir);
    ok(r2.rejected === false, "无 sgconfig 时 ast-grep 正常放行（不误伤）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

console.log("── 会话级检索预算（20 万 token 顶，超顶拒绝继续检索）──");
await (async () => {
  const { createBashReadonlyTool, createRetrievalBudget, SESSION_OUTPUT_CHAR_BUDGET, SESSION_TOKEN_BUDGET } =
    await import("../src/tools/bash_readonly.ts");
  ok(SESSION_TOKEN_BUDGET === 200_000, "预算 = 20 万 token");
  ok(SESSION_OUTPUT_CHAR_BUDGET === 600_000, "≈60 万字符（3 字符/token）");

  const budget = createRetrievalBudget();
  const tool: any = createBashReadonlyTool(budget);
  const ctx = { cwd: process.cwd() };

  // 1) 预算未耗尽：正常放行且记账。
  const r1 = await tool.execute("t1", { command: "echo budget-probe" }, undefined, undefined, ctx);
  ok(r1.isError !== true && budget.usedChars > 0, "预算内：放行且计入用量");

  // 2) 人为把预算撑满 → 下一次调用应被前置拒绝（不执行）。
  budget.usedChars = SESSION_OUTPUT_CHAR_BUDGET;
  const r2 = await tool.execute("t2", { command: "echo should-be-blocked" }, undefined, undefined, ctx);
  const t2 = r2.content?.[0]?.text ?? "";
  ok(r2.isError === true && /预算/.test(t2), "预算耗尽：后续检索被拒");
  ok(/给出结论|收敛|不要再扫描|立即基于/.test(t2), "拒绝时给出可执行引导（让模型收敛出结论）");

  // 3) 预算是**逐会话**的：另建一份实例应重新起算（并行 proposer 不互扣）。
  const tool2: any = createBashReadonlyTool();
  const r3 = await tool2.execute("t3", { command: "echo fresh-session" }, undefined, undefined, ctx);
  ok(r3.isError !== true, "新会话实例：预算独立、重新起算");
})();

console.log("── read 纳入同一本预算账（覆盖 pi 内置 read，含路径 jail）──");
await (async () => {
  const { createBashReadonlyTool } = await import("../src/tools/bash_readonly.ts");
  const { createReadTool } = await import("../src/tools/read_budgeted.ts");
  const { createRetrievalBudget, SESSION_OUTPUT_CHAR_BUDGET } = await import("../src/tools/budget.ts");

  const budget = createRetrievalBudget();
  const readTool: any = createReadTool(budget);
  const bashTool: any = createBashReadonlyTool(budget); // 同一本账
  const ctx = { cwd: process.cwd() };

  ok(readTool.name === "read", "工具名为 read（同名覆盖 pi 内置）");

  // 1) 正常读 + 记账
  const r1 = await readTool.execute("r1", { path: "package.json" }, undefined, undefined, ctx);
  const t1 = r1.content?.[0]?.text ?? "";
  ok(r1.isError !== true && /pi-moa/.test(t1), "read 正常读到文件内容");
  ok(budget.usedChars > 0, "read 计入预算");

  // 2) offset/limit 片段读
  const r2 = await readTool.execute("r2", { path: "package.json", offset: 2, limit: 2 }, undefined, undefined, ctx);
  const t2 = r2.content?.[0]?.text ?? "";
  ok(r2.isError !== true && t2.split("\n").filter((l: string) => l.trim()).length <= 4, "offset/limit 只回片段");

  // 3) ★共享账：read 用掉的额度会让 bash_readonly 也被拒
  budget.usedChars = SESSION_OUTPUT_CHAR_BUDGET;
  const r3 = await bashTool.execute("r3", { command: "echo x" }, undefined, undefined, ctx);
  ok(r3.isError === true && /预算/.test(r3.content?.[0]?.text ?? ""), "read 耗尽预算 → bash_readonly 同被拒（共用一本账）");
  const r4 = await readTool.execute("r4", { path: "package.json" }, undefined, undefined, ctx);
  ok(r4.isError === true && /预算/.test(r4.content?.[0]?.text ?? ""), "预算耗尽 → read 亦被拒");

  // 4) ★路径 jail：读不到审计根之外（pi 内置 read 没有这层）
  const b2 = createRetrievalBudget();
  const readTool2: any = createReadTool(b2);
  const r5 = await readTool2.execute("r5", { path: "/etc/passwd" }, undefined, undefined, ctx);
  ok(r5.isError === true && /jail|越出|审计根/.test(r5.content?.[0]?.text ?? ""), "read 越界读 /etc/passwd 被 jail 拒");
})();

console.log("── 工具调用轮数上限（每轮重发完整历史，故轮数本身要限）──");
await (async () => {
  const { createBashReadonlyTool } = await import("../src/tools/bash_readonly.ts");
  const { createReadTool } = await import("../src/tools/read_budgeted.ts");
  const { createRetrievalBudget, SESSION_MAX_TOOL_CALLS, isBudgetExhausted } = await import("../src/tools/budget.ts");
  ok(SESSION_MAX_TOOL_CALLS === 5, "轮数上限 = 5（U2 极端实测定标：15 轮会放大到 ~250k input）");

  const b = createRetrievalBudget();
  const tool: any = createBashReadonlyTool(b);
  const ctx = { cwd: process.cwd() };
  for (let i = 0; i < SESSION_MAX_TOOL_CALLS; i++) {
    await tool.execute(`c${i}`, { command: "echo x" }, undefined, undefined, ctx);
  }
  ok(b.calls === SESSION_MAX_TOOL_CALLS, `跑满 ${SESSION_MAX_TOOL_CALLS} 轮后 calls 计数正确`);
  ok(isBudgetExhausted(b) === true, "达轮数上限即判耗尽（字符量未超也算）");
  const over = await tool.execute("over", { command: "echo x" }, undefined, undefined, ctx);
  ok(over.isError === true && /轮数/.test(over.content?.[0]?.text ?? ""), "超轮数：bash_readonly 被拒且说明是轮数");
  // read 与 bash_readonly 共用同一本账 ⇒ 轮数也共用
  const readTool: any = createReadTool(b);
  const r2 = await readTool.execute("r", { path: "package.json" }, undefined, undefined, ctx);
  ok(r2.isError === true, "超轮数：read 同被拒（共用一本账）");
})();

console.log("── 侦查前置 recon（层次二 files + 层次三 rg 检索）──");
await (async () => {
  const { runRecon } = await import("../src/moa/recon.ts");
  const cwd = process.cwd();

  // 层次二：精确文件清单
  const r1 = await runRecon({ files: ["package.json"], cwd });
  ok(r1.filesIncluded === 1 && /FILE package\.json/.test(r1.text) && /pi-moa/.test(r1.text), "files：读入指定文件并标注文件名");
  ok(
    /侦查前置/.test(r1.text) && /不要再调用任何检索\/读取工具/.test(r1.text) && /17\.8 倍/.test(r1.text),
    "recon 头部含「边界已画好·勿再调工具」硬约束引导（含实测放大倍数佐证）",
  );

  // 路径 jail：越界文件被拒且不影响其余
  const r2 = await runRecon({ files: ["/etc/passwd", "package.json"], cwd });
  ok(r2.filesIncluded === 1 && r2.notes.some((n: string) => /passwd/.test(n)), "files：越界文件被 jail 拒、合法文件仍附入");

  // ★行号确定性：recon 附入的代码必须带真实行号，且与文件真值逐行对齐
  {
    const { readFileSync } = await import("node:fs");
    const real = readFileSync(resolveP(cwd, "src/moa/recon.ts"), "utf8").split("\n");
    const rr = await runRecon({ files: ["src/moa/recon.ts"], cwd });
    // 抽查三个行号：附入文本里 `N| <原文>` 必须与真实第 N 行一致
    let aligned = 0;
    for (const n of [1, 40, Math.min(120, real.length)]) {
      const want = real[n - 1] ?? "";
      // 行号列宽右对齐，故用正则匹配 “空格*N| ”
      const re = new RegExp(`^\\s*${n}\\| ${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
      if (re.test(rr.text)) aligned++;
    }
    ok(aligned === 3, "recon 代码带真实行号且与文件逐行对齐（杜绝模型自行数行导致的行号漂移）");
    ok(/行号规则/.test(rr.text) && /照抄/.test(rr.text), "引导语明确告知「行号照抄、勿自行计数」");
  }

  // 层次三：rg 机械检索
  const r3 = await runRecon({ reconQuery: "isProposalOk", cwd });
  ok(/机械检索命中/.test(r3.text) && /orchestrate\.ts/.test(r3.text), "recon_query：rg 检索到命中并附行号");

  // 无入参 ⇒ 零开销
  const r4 = await runRecon({ cwd });
  ok(r4.text === "" && r4.filesIncluded === 0, "无 files/query：不产生任何附加内容");
})();

console.log(`\n[bash_readonly-test] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
