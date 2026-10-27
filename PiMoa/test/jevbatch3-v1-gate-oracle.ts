// Freeze Appendix G reclassification before final live scoring; v1 expectations stay unchanged.
// Explicit case/key whitelist, independently curated from frozen source section shapes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }
const root = WS + "/artifacts/jev-material-supply-20261022";
const path = `${root}/goldcases-v1-gate-oracle.json`;
if (existsSync(path)) throw new Error(`已冻结，不覆盖：${path}`);
const source = JSON.parse(readFileSync(`${root}/goldcases-v1.json`, "utf8"));
const rules: Record<string, Record<string, string>> = {};
const put = (id: string, keys: string[], why: string): void => {
  const row = rules[id] ??= {};
  for (const key of keys) { if (row[key]) throw new Error(`duplicate ${id}/${key}`); row[key] = why; }
};
const fg = ["fg-skip", "fg-vacuous", "fg-mock", "fg-readback"];
const hd = ["hd-policy", "hd-gate-exist", "hd-gate-fit", "hd-exempt"];
const od = ["od-path", "od-conflict", "od-repro"];
for (const id of ["fg-pos-1", "fg-pos-2", "fg-pos-4", "fg-neg-1", "fg-neg-2"])
  put(id, ["fg-mock"], "测试函数与被测段在场，但依赖装配/真实依赖入口代码段未附");
put("fg-miss-1", fg, "缺真实验收命令及运行结果，四问均无前置证据");
for (const id of ["wr-pos-1", "wr-pos-2", "wr-pos-3", "wr-pos-4", "wr-neg-1", "wr-neg-2", "wr-miss-1", "wr-xfile-1"])
  put(id, ["wr-path"], "路径段的注册跳仅注释式或不足实际调用代码；附录G禁止注释充证");
for (const id of ["wr-pos-2", "wr-miss-1"])
  put(id, ["wr-static"], "消费点真实运行时读取代码未附，池内检索摘要不替代消费点代码行");
for (const id of ["hd-pos-1", "hd-pos-2", "hd-pos-3", "hd-pos-4", "hd-neg-1", "hd-neg-2", "hd-miss-1", "hd-xfile-1"])
  put(id, ["hd-gate-fit"], "机制调用域/同类值先例仅注释断言或缺席，没有附真实先例代码段");
put("hd-pos-4", hd.filter(key => key !== "hd-gate-fit"), "Gate/Registry/配置机制定义段未附，机制不存在≠可以捏造在场段");
put("hd-miss-1", ["hd-exempt"], "现行豁免裁决节选未附，不允许以未见判不豁免");
put("od-miss-1", od, "可识别来源的任务合同节选未附，只有未附占位标题");
for (const [id, byKey] of Object.entries(rules)) {
  const c = source.cases.find((x: { id: string }) => x.id === id);
  if (!c) throw new Error(`unknown ${id}`);
  for (const key of Object.keys(byKey)) if (c.expected[key] === undefined || c.expected[key] === "nf") throw new Error(`not own key ${id}/${key}`);
}
const payload = { version: "v1-appendix-G-oracle-fixed-before-final-run", source: `${root}/goldcases-v1.json`,
  rule: "only listed case/key pairs may be scored as hard-gate rejection; all others retain frozen numeric expectation",
  rules };
const text = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(path, text, { flag: "wx" });
console.log(`V1_GATE_ORACLE_FROZEN sha256=${createHash("sha256").update(text).digest("hex")} cases=${Object.keys(rules).length} path=${path}`);
