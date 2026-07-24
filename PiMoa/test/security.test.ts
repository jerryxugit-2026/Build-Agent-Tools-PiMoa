// 安全不变量测试：PiMoa 子 agent 不能生成孙 agent（徐总 2026-07-24）。
// 验证 assertNoGrandchildCapability 的 allowlist 强制。
import { assertNoGrandchildCapability, SAFE_SESSION_TOOLS } from "../src/moa/session.ts";

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
function throws(tools: string[]): boolean {
	try {
		assertNoGrandchildCapability(tools);
		return false;
	} catch {
		return true;
	}
}

console.log("[security-test] allowlist =", [...SAFE_SESSION_TOOLS]);

// 放行：allowlist 内的只读工具
ok(!throws([]), "空工具集放行");
ok(!throws(["read", "grep", "find", "ls"]), "只读四件套放行");

// 拦截：任何越界工具（防孙 agent / 提权 / 递归扇出）
ok(throws(["subagent"]), "subagent 拦截");
ok(throws(["delegate"]), "delegate 拦截");
ok(throws(["task"]), "task 拦截");
ok(throws(["moa_run"]), "moa_run（递归扇出）拦截");
ok(throws(["bash"]), "未受控 bash 拦截");
ok(throws(["execute_code"]), "execute_code 拦截");
ok(throws(["read", "bash"]), "混入一个危险工具即整体拦截");
ok(throws(["write"]), "write 拦截");

console.log(`[security-test] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
