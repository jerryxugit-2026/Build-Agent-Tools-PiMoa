/** JEV 退役后的 on/off 消费侧行为契约；npx tsx test/jevcheck_contract.test.ts。 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.js";
import { buildAggregatorPrompt, runMoa } from "../src/moa/orchestrate.js";
import { renderCheckTable } from "../src/moa/jevcheck.js";
import { renderAggregated } from "../src/moa/render_verdicts.js";
import type { FindingCheck, FindingRecord, JevCheckReport, SubmitVerdicts } from "../src/moa/types.js";
import type { SessionRunResult } from "../src/moa/session.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const finding = {
  pid: "P1/F1", id: "F1", level: "MAJOR", path: "src/example.ts", lines: "7", proposerModel: "mock/mock",
} as FindingRecord;
const check: FindingCheck = {
  pid: finding.pid, ref: "OK", facts: [], entail: { p1: 0.9 },
  status: "前提完备且全部相符", conditionFlag: false, calls: [],
  truth: { verdict: "假", rule: "KILL", brokenStep: "c2", mechNotes: ["c2｜行文核对: 第 7 行不含该分支"] },
};
const report: JevCheckReport = {
  enabled: true, perFinding: { [finding.pid]: check }, duplicates: [], conflicts: [], oneSided: [],
  proposerQuality: {}, totals: { calls: 0, inputTokens: 0, ms: 0, tableChars: 0, truncated: false, throttled: 0 },
  tableText: "",
};
const table = renderCheckTable(report, [finding], new Map(), 40_000).text;
assert.match(table, /破绽定位：F1·c2 被证伪/);
assert.doesNotMatch(table, /闸门：|抽检=|熔断/);
const request = { prompt: "请审查示例" };
const onPrompt = buildAggregatorPrompt(request, [], [], "verify", 5, table);
assert.match(onPrompt, /核对表（系统机械核验/);
assert.match(onPrompt, /破绽定位：F1·c2/);
assert.doesNotMatch(onPrompt, /server-KILL|采纳服务端驳回|翻案.*rebuttal/);
const verdicts: SubmitVerdicts = {
  verdicts: [{ finding_ids: [finding.pid], level: "MAJOR", can_happen: "能", consequence: "数据错误",
    trigger: "特定输入或环境", strength: "推理", reason: "该分支在特定输入时会返回错误数据", evidence: "src/example.ts:7" }],
  final: "此处为测试用的最终裁决，细节交由人工复核确认。",
};
const rendered = renderAggregated(verdicts, [finding], report, "");
const sections = ["一、【冲突点与采信】", "二、【逐条裁决】", "三、【最终裁决】"];
assert(sections.every((part, i) => rendered.includes(part) && (i === 0 || rendered.indexOf(part) > rendered.indexOf(sections[i - 1]!))));
assert.match(rendered, /MAJOR \| src\/example\.ts:7 \| 能否发生：能/);
assert.match(rendered, /该分支在特定输入时会返回错误数据/);
assert.match(rendered, /此处为测试用的最终裁决/);
assert.doesNotMatch(rendered, /## closure|四、【结案与分流】|闸门：|熔断/);

// off：既有 test/moa.test.ts 用例 34/49 校验旧提示与聚合器工具面；这里补两端工具注入探针。
const offPrompt = buildAggregatorPrompt(request, [], [], "verify", 0);
assert.match(offPrompt, /输出按以下三部分定型/);
assert.doesNotMatch(offPrompt, /核对表|submit_verdicts|server-KILL|采纳服务端驳回/);
// 加载期强校验要求所有已注册 provider 有 key；本测试只用注入 mock，不发网络请求。
for (const key of ["CLIPROXY_API_KEY", "MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] ??= "test-only";
const config = loadConfig({ moaYaml: resolve(projectRoot, "config/moa.yaml") });
assert.equal(Object.hasOwn(config.jevcheck, "closure"), false);
config.jevcheck.enabled = false;
const sessions: Array<{ prompt: string; tools?: string[]; extraTools?: Array<{ name: string }> }> = [];
const mock = async (_runtime: unknown, _worker: unknown, prompt: string, opts: { tools?: string[]; extraTools?: Array<{ name: string }> }): Promise<SessionRunResult> => {
  sessions.push({ prompt, tools: opts.tools, extraTools: opts.extraTools });
  return { text: "审查正文", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false, sawAgentEnd: true };
};
const result = await runMoa(config, { prompt: "审查示例", preset: "moa_verify" }, { modelRuntime: null, runSessionImpl: mock as never });
assert.equal(result.status, "ok");
assert.equal(result.aggregated, "审查正文");
assert.equal(sessions.length, 3);
const actualOffTail = sessions[2]!.prompt;
assert.match(actualOffTail, /一、【冲突点与采信】表[\s\S]*二、【逐条裁决】[\s\S]*三、【最终裁决】/);
assert(actualOffTail.endsWith("不复述提议原文；不设总篇幅上限，但每条裁决一行。"));
for (const session of sessions) {
  assert.equal(session.tools, undefined);
  assert.equal(session.extraTools?.some((tool) => tool.name === "submit_findings" || tool.name === "submit_verdicts") ?? false, false);
  assert.doesNotMatch(session.prompt, /核对表|submit_verdicts|submit_findings/);
}
// on：真实编排入口，mock 仅代替模型会话；预算零调用避免触及外部 Jev 服务。
config.jevcheck.enabled = true;
config.jevcheck.budget.maxCalls = 0;
const sourceAbs = resolve(projectRoot, "src/example.ts");
const sourceLines = ["package example", "", "", "", "", "", "const broken = true;"];
const materials = new Map([[sourceAbs, [{ abs: sourceAbs, rel: "src/example.ts", kind: "range" as const,
  lines: sourceLines, start: 1, end: 7 }]]]);
const submittedFinding = {
  id: "F1", kind: "finding", level: "MAJOR", path: "src/example.ts", lines: "7", anchor: "const broken = true;",
  facts: ["代码第 7 行存在 broken 分支", "通用事实：输入到达该分支", "通用事实：结果可能错误"],
  claim: "该分支在特定输入时可能输出错误数据", fix_expect: "校验输入并修正结果", strength: "推理",
};
const onSessions: Array<{ prompt: string; tools?: string[]; extraTools?: Array<{ name: string; description: string }> }> = [];
const onMock = async (_runtime: unknown, _worker: unknown, prompt: string, opts: {
  tools?: string[]; extraTools?: Array<{ name: string; description: string }>;
  structuredState?: { accepted: unknown; attempts: number };
}): Promise<SessionRunResult> => {
  const index = onSessions.push({ prompt, tools: opts.tools, extraTools: opts.extraTools }) - 1;
  if (opts.structuredState) {
    opts.structuredState.attempts = 1;
    opts.structuredState.accepted = index < 2 ? [submittedFinding] : {
      ...verdicts, verdicts: [{ ...verdicts.verdicts[0]!, finding_ids: ["P1/F1", "P2/F1"] }],
    };
  }
  return { text: "审查正文", usage: null, costUsd: 0, durationMs: 1, timedOut: false, aborted: false,
    sawAgentEnd: true, structured: { accepted: true, count: 1, attempts: 1 } };
};
const onResult = await runMoa(config, { prompt: "审查示例", preset: "moa_verify", materials },
  { modelRuntime: null, runSessionImpl: onMock as never });
assert.equal(onResult.status, "ok", JSON.stringify(onResult.error));
assert.equal(onSessions.length, 3);
for (const proposer of onSessions.slice(0, 2)) {
  assert(proposer.tools?.includes("submit_findings"));
  assert(proposer.extraTools?.some((tool) => tool.name === "submit_findings"));
  assert.match(proposer.prompt, /submit_findings/);
}
const actualOn = onSessions[2]!;
assert.deepEqual(actualOn.tools, ["submit_verdicts"]);
assert(actualOn.extraTools?.some((tool) => tool.name === "submit_verdicts"));
assert.match(actualOn.prompt, /===== 核对表（系统机械核验/);
assert.match(actualOn.prompt, /P1\/F1|P2\/F1/);
assert.doesNotMatch(actualOn.prompt, /server-KILL|采纳服务端驳回/);
assert.doesNotMatch(actualOn.extraTools?.[0]?.description ?? "", /server-KILL|采纳服务端驳回|翻案|rebuttal/);
assert.match(onResult.aggregated, /一、【冲突点与采信】[\s\S]*二、【逐条裁决】[\s\S]*三、【最终裁决】/);
assert.doesNotMatch(onResult.aggregated, /四、【结案与分流】|闸门：|熔断/);
console.log("[jevcheck-contract] on/off 合约通过");
