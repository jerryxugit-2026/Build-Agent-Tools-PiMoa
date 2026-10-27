// One last independently self-checked mini exam, frozen BEFORE live JEV scoring.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }
const root = WS + "/artifacts/jev-material-supply-20261022";
const path = `${root}/goldcases-v4-mini.json`, log = `${root}/goldcases-v4-selfcheck.jsonl`;
if (existsSync(path) || existsSync(log)) throw new Error(`已冻结，不覆盖 ${path}`);
const source = JSON.parse(readFileSync(`${root}/goldcases-v3-new.json`, "utf8"));
const wr = source.cases.filter((c: { category: string }) => c.category === "wiring").map((c: { id: string }) => ({ ...c, id: c.id.replace("wr3-", "wr4-") }));
if (wr.length !== 4) throw new Error("v3缺4例wiring");
const hd1 = structuredClone(source.cases.find((c: { id: string }) => c.id === "hd3-pos-1"));
const hd2 = structuredClone(source.cases.find((c: { id: string }) => c.id === "hd3-pos-2"));
if (!hd1 || !hd2) throw new Error("v3缺先例正例");
hd1.id = "hd4-rich-1";
hd1.state += "\n## 材料-6｜第二个机制先例代码段（来源 internal/api/cors_dynamic.go）\n```go\nfunc CORSOriginAllowed(cfg Config, requestOrigin string) bool {\n for _, allowed := range cfg.AllowedOrigins { if allowed == requestOrigin { return true } }\n return false\n}\n```\n";
hd1.ground_truth = "已冻结前推理：相同 Config.AllowedOrigins []string 来源值同时被 WS/CORS 两个真实消费点代码读取；机制语义与调用域覆盖常量用途";
hd2.id = "hd4-rich-2";
hd2.state += "\n## 材料-6｜第二个机制先例代码段（来源 internal/intake/validator.go）\n```go\nfunc IntakeAllowed(path string, p *PathPolicy) bool {\n if !p.Matches(\"intake\", path) { return false }\n return true\n}\n```\n";
hd2.ground_truth = "已冻结前推理：PathPolicy.Matches 在 intake/scan 与 intake/validator 的两个真实代码消费点核同类型路径资格值";
const cases = [...wr, hd1, hd2];
const rows: Array<{ id: string; selfcheck: Record<string, boolean> }> = [];
for (const c of cases) {
  const section = [...c.state.matchAll(/^## 材料-\d+[^\n]*\n([\s\S]*?)(?=^## 材料-\d+|$(?![\s\S]))/gm)];
  const checks: Record<string, boolean> = { sections: section.length >= 3,
    contiguous: section.every(s => !/^\s*\d+\|/m.test(s[1]!) && !s[1]!.includes("（该行未附）")) };
  if (c.category === "wiring") {
    const pathBody = /## 材料-\d+｜入口→注册路径段[^\n]*\n```go\n([\s\S]*?)```/.exec(c.state)?.[1] ?? "";
    const keys = [...c.finding.matchAll(/(?:docgate\.check(?:\.v2)?|hooks\.[fF]2\.enabled|gates\.doc-review\.enabled|GATES_DOC_REVIEW_ENABLED)/g)].map((m: RegExpMatchArray) => m[0]);
    checks.hops = c.expected["wr-path"] === "gate-gap" ? !/^func\s+/m.test(pathBody) :
      (pathBody.match(/^func\s+/gm) ?? []).length >= 3 && /\.Run\(/.test(pathBody) && /\.Register\(/.test(pathBody);
    checks.keys = c.expected["wr-path"] === "gate-gap" ? true : keys.length >= 2 && [...new Set(keys)].every(k => pathBody.includes(`"${k}"`));
  } else {
    const precedent = [...c.state.matchAll(/## 材料-[56]｜[^\n]*先例代码段[^\n]*\n```go\n([\s\S]*?)```/g)].map((m: RegExpMatchArray) => m[1]!);
    checks.prior = precedent.length === 2 && precedent.every((text: string) => /^(?:func|\s*(?:return|for|if))\b/m.test(text) && /\.AllowedOrigins|\.Matches\(/.test(text));
    checks.sameType = c.id.endsWith("1") ? precedent.every((text: string) => text.includes("AllowedOrigins")) : precedent.every((text: string) => text.includes("Matches(\"intake\""));
  }
  rows.push({ id: c.id, selfcheck: checks });
}
writeFileSync(log, rows.map(x => JSON.stringify(x)).join("\n") + "\n", { flag: "wx" });
const bad = rows.filter(x => Object.values(x.selfcheck).some(v => !v));
if (bad.length) throw new Error(`自洽检查失败，不冻结：${bad.map(x => x.id).join(",")}`);
const payload = { version: "goldcases-v4-mini / two-atomic-wiring-hops", frozen_expectations_before_judging: true,
  source: `${root}/goldcases-v3-new.json`, selfcheck: log,
  scoring: "wr-path=min(two sampled hop p), true>=0.8; hd-gate-fit true>=0.8; gate-gap means no question and GapRecord",
  cases };
const text = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(path, text, { flag: "wx" });
console.log(`V4_FROZEN sha256=${createHash("sha256").update(text).digest("hex")} cases=${cases.length} selfcheck=${rows.length} path=${path}`);
