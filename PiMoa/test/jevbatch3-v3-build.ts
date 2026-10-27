// Freeze a corrected exam only after independently checking its own source/keys/scope/lines.
// This script NEVER reads or rewrites the voided v2, and NEVER reads any JEV result.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }
const root = WS + "/artifacts/jev-material-supply-20261022";
const out = `${root}/goldcases-v3-new.json`;
const checks = `${root}/goldcases-v3-selfcheck.jsonl`;
if (existsSync(out) || existsSync(checks)) throw new Error(`已冻结，不覆盖 ${out} 或 ${checks}`);
const source = JSON.parse(readFileSync(`${root}/goldcases-v1.json`, "utf8"));
const from = (id: string) => structuredClone(source.cases.find((c: { id: string }) => c.id === id));
type Case = { id: string; category: string; kind: string; finding: string; state: string; expected: Record<string, boolean | "gate-gap">; ground_truth: string };
const cases: Case[] = [];
const add = (id: string, src: string, key: string, expected: boolean | "gate-gap", state?: string, truth?: string): void => {
  const c = from(src);
  if (!c) throw new Error(`no source ${src}`);
  cases.push({ id, category: c.category, kind: c.kind, finding: c.finding,
    state: state ?? c.state, expected: { [key]: expected }, ground_truth: truth ?? c.truth });
};
function replacePath(c: { state: string }, written: string, read: string, install: string): string {
  const block = `## 材料-5｜入口→注册路径段（逐跳真实代码行）\n\`\`\`go\n// cmd/papergo/main.go\nfunc main() { bootstrap.Run() }\n// internal/bootstrap/bootstrap.go\nfunc Run() { r := gov.NewRegistry(); gov.${install}(r); orchestrator.RunAll(r) }\n// internal/gov/registry.go\nfunc ${install}(r *Registry) { r.Register("${written}", Gate{}) }\n// internal/orchestrator/run.go\nfunc Consume(r *Registry) { _ = r.Get("${read}") }\n\`\`\`\n`;
  const old = /## 材料-\d+｜入口→注册路径段[^\n]*\n```go\n[\s\S]*?```/;
  if (!old.test(c.state)) throw new Error("no path to replace");
  return c.state.replace(old, block.trimEnd());
}
const w1 = from("wr-pos-1");
add("wr3-pos-1", "wr-pos-1", "wr-path", true,
  replacePath(w1, "docgate.check.v2", "docgate.check", "InstallDefaults"), "真实代码路径 main→Run→InstallDefaults，原命题断键属独立问题");
const w2 = from("wr-pos-3");
add("wr3-pos-2", "wr-pos-3", "wr-path", true,
  replacePath(w2, "hooks.f2.enabled", "hooks.F2.enabled", "Install"), "注册写入键 normalize 后为 hooks.f2.enabled、消费键为 hooks.F2.enabled，两端及逐跳路径均在场");
const wn = from("wr-neg-1");
add("wr3-blind-1", "wr-neg-1", "wr-path", true,
  replacePath(wn, "gates.doc-review.enabled", "GATES_DOC_REVIEW_ENABLED", "InstallDefaults"), "盲反例：双端转换后同键；入口注册链仍真实存在");
add("wr3-miss-1", "wr-miss-1", "wr-path", "gate-gap", undefined, "消费段缺席且路径是注释；必须gap拒发");
const prior1 = "\n## 材料-5｜机制先例代码段（来源 internal/api/ws_origin.go）\n```go\nfunc WSOriginAllowed(cfg Config, origin string) bool {\n return slices.Contains(cfg.AllowedOrigins, origin) // []string 来源政策值\n}\n```\n";
add("hd3-pos-1", "hd-pos-1", "hd-gate-fit", true, from("hd-pos-1").state + prior1, "Config.AllowedOrigins 的同类来源值在 WS 真实代码被消费");
const prior2 = "\n## 材料-5｜机制先例代码段（来源 internal/intake/scan.go）\n```go\nfunc ScanIntake(path string, p *PathPolicy) bool {\n return p.Matches(\"intake\", path) // intake 路径资格值\n}\nfunc LoadIntakePolicy(p *PathPolicy) { p.Register(\"intake\", Root(\"/data/in\")) }\n```\n";
add("hd3-pos-2", "hd-pos-2", "hd-gate-fit", true, from("hd-pos-2").state + prior2, "PathPolicy.Matches 同类型路径值覆盖 intake 域");
const priorNeg = "\n## 材料-5｜机制先例代码段（来源 internal/flags/export.go）\n```go\nfunc ExportButtonEnabled(g *FeatureFlagGate) bool {\n return g.On(\"export_button\") // bool 开关，非整数配额\n}\n```\n";
add("hd3-blind-1", "hd-pos-3", "hd-gate-fit", false, from("hd-pos-3").state + priorNeg, "盲反例：布尔 gate 的调用域代码在场，但与整数配额用途不匹配");
add("hd3-miss-1", "hd-pos-2", "hd-gate-fit", "gate-gap", undefined, "先例只见注释，无机制消费同类路径值的代码");
function od(id: string, kind: string, risk: string, scope: string, diff: string, expected: boolean | "gate-gap", finding: string): void {
  const contract = expected === "gate-gap" ? "## 材料-1｜docs/task/TASK-OD-301.md（任务合同节选）\n（本轮材料未附：合同原文不在 state）\n" :
    `## 材料-1｜docs/task/TASK-OD-301.md（任务合同节选，来源可识别）\n\`\`\`markdown\n## §scope\n- ${scope}\n\`\`\`\n`;
  const state = `## 被审 finding（category=overdesign）\n${finding}\n\n${contract}\n## 材料-2｜修复 diff 段（internal/api/route.go）\n\`\`\`diff\n@@ -8,3 +8,5 @@\n${diff}\n\`\`\`\n\n## 材料-3｜风险对象和实际调用路径\n被审问题/风险明确为「${risk}」。合同中的必修问题只按 §scope 原文对照；改动项是否违反合同不是 od-conflict 的判定对象。\n\`\`\`go\nfunc main() { api.Start() }\nfunc Start() { route.Handle() }\n\`\`\`\n`;
  cases.push({ id, category: "overdesign", kind, finding, state, expected: { "od-conflict": expected },
    ground_truth: expected === true ? "合同明令防御此风险，风险与条款直接冲突" : expected === false ? "风险与限定合同任务不直接冲突" : "合同条款缺席，绝不得猜" });
}
od("od3-pos-1", "pos", "计划在未来多租户场景下出现的未知 tenant header", "修复 export 页码 off-by-one；不新增租户请求能力。", "+func parseTenantHeader(r Request) string { return r.Header.Get(\"X-Tenant\") }", false, "新增 tenant header 解析防御未来多租户需求，却声称为 export 页码修复所必需——overdesign 嫌疑。");
od("od3-pos-2", "pos", "debug 专用工具未来可能同时抢占 writer 的假设", "修复 report JSON 序列化缺失字段；不改 writer 并发模型。", "+func lockAllTables(w *Writer) { w.LockEverything() }", false, "为 debug 未来可能并发的假设新增全表锁，声称是 report JSON 序列化修复的必要改动——overdesign 嫌疑。");
od("od3-blind-1", "blindneg", "未签名请求被接受并放行", "修复 unsigned request 放行漏洞；必须拒绝未签名请求。", "+if !request.Signed() { return reject(401) }", true, "新增未签名请求拒绝分支，疑似过度防御——overdesign 嫌疑。");
od("od3-miss-1", "missmat", "未签名请求被接受并放行", "合同未附", "+if !request.Signed() { return reject(401) }", "gate-gap", "新增未签名请求拒绝分支，任务合同未附——材料不足须gap。");

// Independent static self-consistency check, before writing any frozen exam.
const rows: Array<{ case: string; key: string; checks: Record<string, boolean>; expected: boolean | "gate-gap" }> = [];
for (const c of cases) {
  const key = Object.keys(c.expected)[0]!;
  const expected = c.expected[key]!;
  const checksForCase: Record<string, boolean> = {};
  const sections = [...c.state.matchAll(/^## 材料-\d+[^\n]*\n([\s\S]*?)(?=^## 材料-\d+|$(?![\s\S]))/gm)];
  checksForCase.sections = sections.length >= 2;
  // Every section has its own continuous implicit 1-based line numbering; no sparse N| lines.
  checksForCase.contiguous = sections.every(s => !/^\s*\d+\|/m.test(s[1]!) && !s[1]!.includes("（该行未附）"));
  if (key === "wr-path") {
    const path = /## 材料-\d+｜入口→注册路径段[^\n]*\n```go\n([\s\S]*?)```/.exec(c.state)?.[1] ?? "";
    const keys = [...c.finding.matchAll(/(?:docgate\.check(?:\.v2)?|hooks\.[fF]2\.enabled|gates\.doc-review\.enabled|GATES_DOC_REVIEW_ENABLED)/g)].map(m => m[0]);
    checksForCase.keysAgree = expected === "gate-gap" ? path === "" || !/^\s*func\s+/m.test(path) : keys.length >= 2 && [...new Set(keys)].every(k => path.includes(`"${k}"`));
    checksForCase.pathCode = expected === "gate-gap" ? !/^\s*func\s+/m.test(path) : (path.match(/^func\s+/gm) ?? []).length >= 3 && /\.Register\("/.test(path) && /\.Get\("/.test(path);
  } else if (key === "hd-gate-fit") {
    const prior = /## 材料-5｜机制先例代码段[^\n]*\n```go\n([\s\S]*?)```/.exec(c.state)?.[1] ?? "";
    checksForCase.prior = expected === "gate-gap" ? prior === "" : /^(?:func|\s*return)\b/m.test(prior) && /\.(?:AllowedOrigins|Matches\(|On\()/.test(prior);
    checksForCase.type = expected === "gate-gap" ? true : c.id.includes("blind") ? /bool|开关/.test(prior) && /int|配额/.test(c.state) :
      c.id.includes("pos-1") ? /AllowedOrigins/.test(prior) && /AllowedOrigins/.test(c.state) : /Matches\("intake"/.test(prior) && /路径资格/.test(prior);
  } else {
    const contract = /## 材料-1[^\n]*\n([\s\S]*?)(?=^## 材料-2)/m.exec(c.state)?.[1] ?? "";
    checksForCase.scope = expected === "gate-gap" ? !/## §scope\n- /.test(contract) : /## §scope\n- (?:修复|消灭)/.test(contract);
    checksForCase.diff = /## 材料-2｜修复 diff 段[^\n]*\n```diff\n@@[^\n]*\n\+(?:func|if)/.test(c.state);
  }
  rows.push({ case: c.id, key, checks: checksForCase, expected });
}
const failed = rows.filter(row => Object.values(row.checks).some(v => !v));
writeFileSync(checks, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx" });
if (failed.length) throw new Error(`机械自洽检查失败，不得冻结：${failed.map(x => x.case + JSON.stringify(x.checks)).join("; ")}; log=${checks}`);
const payload = { version: "goldcases-v3-new / appendix-G-corrected", origin: `${root}/goldcases-v1.json`,
  frozen_expectations_before_judging: true, scoring: "true >=0.8 / false <=0.2 / gate-gap means no question and GapRecord",
  selfcheck: checks, cases };
const text = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(out, text, { flag: "wx" });
console.log(`V3_FROZEN sha256=${createHash("sha256").update(text).digest("hex")} cases=${cases.length} selfcheck=${rows.length} path=${out}`);
