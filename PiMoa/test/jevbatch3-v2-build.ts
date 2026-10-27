// Deterministic exam construction; run ONCE before live judging. Existing v1 is never modified.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }
const root = WS + "/artifacts/jev-material-supply-20261022";
const original = JSON.parse(readFileSync(`${root}/goldcases-v1.json`, "utf8"));
const out = `${root}/goldcases-v2-new.json`;
if (existsSync(out)) throw new Error(`拒绝覆盖已冻结考卷：${out}`);
const byId = (id: string) => structuredClone(original.cases.find((c: { id: string }) => c.id === id));
const cases: Array<{ id: string; source: string; category: string; kind: string; finding: string; state: string; expected: Record<string, boolean | "gate-gap">; rationale: string }> = [];
const add = (id: string, source: string, key: string, expected: boolean | "gate-gap", addition: string, rationale: string): void => {
  const c = byId(source);
  if (!c) throw new Error(`missing ${source}`);
  cases.push({ id, source, category: c.category, kind: c.kind, finding: c.finding,
    state: c.state + addition, expected: { [key]: expected }, rationale });
};
const path = (target: string) => `\n## 材料-5｜入口→注册路径段（逐跳真实代码行）\n\`\`\`go\n// cmd/papergo/main.go\nfunc main() { bootstrap.Run() }\n// internal/bootstrap/bootstrap.go\nfunc Run() { r := gov.NewRegistry(); gov.${target}(r); orchestrator.RunAll(r) }\n// internal/gov/registry.go\nfunc ${target}(r *Registry) { r.Register("gate", Gate{}) }\n\`\`\`\n`;
add("wr-v2-pos-1", "wr-pos-1", "wr-path", true, path("InstallDefaults"), "入口 main→bootstrap.Run→InstallDefaults 注册代码逐跳同材料");
add("wr-v2-pos-2", "wr-pos-3", "wr-path", true, path("Install"), "入口与注册代码逐跳在场；键是否失配属独立子问");
add("wr-v2-blind-1", "wr-neg-1", "wr-path", true, path("InstallDefaults"), "盲反例：双端键经转换相同，路径问仍应如实肯定逐跳代码链");
add("wr-v2-miss-1", "wr-miss-1", "wr-path", "gate-gap", "", "消费点段未附且入口路径只有注释；机械硬门拒发");
add("hd-v2-pos-1", "hd-pos-1", "hd-gate-fit", true,
  "\n## 材料-5｜机制同类值先例代码段（CORS sibling WS）\n\`\`\`go\nfunc wsOriginAllowed(cfg Config, origin string) bool { return slices.Contains(cfg.AllowedOrigins, origin) }\nfunc corsOriginAllowed(cfg Config, origin string) bool { return slices.Contains(cfg.AllowedOrigins, origin) }\n\`\`\`\n",
  "AllowedOrigins 已在 WS/CORS 代码域处理来源值；硬编码同类来源可被该机制覆盖");
add("hd-v2-pos-2", "hd-pos-2", "hd-gate-fit", true,
  "\n## 材料-5｜机制同类值先例代码段（PathPolicy intake）\n\`\`\`go\nfunc ScanIntake(p string, policy *PathPolicy) bool { return policy.Matches('intake', p) }\nfunc RegisterIntake(policy *PathPolicy) { policy.Register('intake', policy.Root('/data/in')) }\n\`\`\`\n",
  "PathPolicy 同类路径资格先例在 intake 域代码中已调用");
add("hd-v2-blind-1", "hd-pos-3", "hd-gate-fit", false,
  "\n## 材料-5｜机制先例代码段（布尔 Gate 调用域）\n\`\`\`go\nfunc On(g *FeatureFlagGate, flag string) bool { return g.On(flag) }\nfunc EnableExportButton(g *FeatureFlagGate) bool { return g.On('export_button') }\n// 布尔开关并非每用户的数值配额 maxExportRows。\n\`\`\`\n",
  "盲反例：机制虽在场且有布尔先例，但完全不覆盖数值配额");
add("hd-v2-miss-1", "hd-pos-2", "hd-gate-fit", "gate-gap", "", "原始材料仅注释断言 sibling 先例，不含真实同类先例代码");
const clarify = (risk: string) => `\n## 材料-5｜被审风险指代与合同对照\n被审 finding 所指的问题明确为：${risk}。od-conflict 只核此风险与所附合同条款的直接冲突；不要把「改动项是否违反合同」当成题目的问题。\n`;
add("od-v2-pos-1", "od-pos-1", "od-conflict", false, clarify("并发 writer 同时打开同一表（debug 路径风险）；合同仅要求 UPSERT 字段修复且禁止新增锁"), "超 scope 的 debug 锁风险未与合同要求直接冲突");
add("od-v2-pos-2", "od-pos-2", "od-conflict", false, clarify("未来多租户调用缺口；合同仅修复导出分页 off-by-one，不含租户消费方"), "未来租户能力不属合同要求处理的风险");
add("od-v2-blind-1", "od-neg-1", "od-conflict", true, clarify("grep 命令 rc=2 被按 rc=0 放行的 fail-open 真实回归；合同明令消除此回归且 fail-closed"), "盲反例：风险确与合同必须 fail-closed 直接冲突");
add("od-v2-miss-1", "od-miss-1", "od-conflict", "gate-gap", "", "合同原文缺席；标题占位不可冒充条款");
const payload = { version: "goldcases-v2-new / appendix-G-corrected", source: `${root}/goldcases-v1.json`,
  frozen_expectations_before_judging: true, scoring: "boolean threshold T≥0.8 F≤0.2; gate-gap requires no JEV call and a provenance-specific GapRecord",
  cases };
const text = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(out, text, { flag: "wx" });
console.log(`v2_frozen_sha256=${createHash("sha256").update(text).digest("hex")} cases=${cases.length} path=${out}`);
