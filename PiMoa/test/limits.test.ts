/**
 * P2 统一预算真源测试(v4 §4;确定性、脱网、脱 key)。
 *
 * 运行:npx tsx test/limits.test.ts
 * 覆盖:码点计数与高熵折算、材料合并闸(fail-loud)、取证账本 per-call 上限与硬顶钳制、
 *      max_tool_calls zod/buildRequest 链、运行期窗口复核 validateWindowFit、
 *      加载期不变量⑦(窗口预算验算)与 aggregatorFallback model id 校验。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import {
  codePointLength,
  effectiveCharCount,
  materialBudgetChars,
  MAX_TOOL_CALLS_HARD_CAP,
  TOOL_SLICE_CHARS,
} from "../src/config/limits.js";
import {
  createRetrievalBudget,
  isBudgetExhausted,
  budgetMaxCalls,
  budgetMaxChars,
  SESSION_OUTPUT_CHAR_BUDGET,
} from "../src/tools/budget.js";
import { enforceMaterialBudget, moaToolInput, buildRequest } from "../src/mcp/tools.js";
import { validateWindowFit, validateResolvedPlan } from "../src/moa/orchestrate.js";
import { loadConfig, ConfigError } from "../src/config/load.js";

process.env.PIMOA_SPOOL_DIR = mkdtempSync(join(tmpdir(), "pimoa-limits-spool-"));

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

// ---- 1) 码点计数与高熵折算 ----
{
  assert(codePointLength("abc中文") === 5, "codePointLength:ASCII+CJK 按码点计");
  assert(codePointLength("👨‍👩‍👧") === 5, "codePointLength:emoji ZWJ 序列按码点计(非 UTF-16 码元)");
  const zh = effectiveCharCount("中文材料".repeat(100));
  assert(zh.effective === zh.codePoints && zh.exotic === 0, "常规中文无高熵折算");
  const emoji = effectiveCharCount("😀".repeat(50) + "正文".repeat(50));
  assert(emoji.exotic === 50 && emoji.effective === emoji.codePoints + 50, "emoji 占比>20% 按 ×2 折算");
  // P2 静态审查 F8:箭头/数学符/盒线/CJK 扩展 A 是正常材料,不得计 exotic。
  const codeReview = effectiveCharCount("A → B ⇒ 结果 ≥ 阈值 ├─└│ 表格".repeat(20));
  assert(codeReview.exotic === 0, "F8:箭头/数学符/盒线不计 exotic(代码 review 材料不被误伤)");
  const extA = effectiveCharCount("㐀㑇㓞".repeat(100));
  assert(extA.exotic === 0, "F8:CJK 扩展 A(正式中文用字)不计 exotic");
}

// ---- 1.5) P3 切档:分模式默认值(采样验收 29/30 后生效) ----
{
  const m = process.env.PIMOA_MATERIAL_BUDGET_CHARS;
  const r = process.env.PIMOA_RETRIEVAL_CHAR_BUDGET;
  delete process.env.PIMOA_MATERIAL_BUDGET_CHARS;
  delete process.env.PIMOA_RETRIEVAL_CHAR_BUDGET;
  assert(materialBudgetChars("synthesize") === 480_000, "P3:synthesize 材料档 480k");
  assert(materialBudgetChars("verify") === 360_000, "P3:verify 材料档 360k(给取证让位)");
  const { retrievalCharBudget } = await import("../src/config/limits.js");
  assert(retrievalCharBudget("synthesize") === 120_000, "P3:synthesize 取证 120k(联合 600k)");
  assert(retrievalCharBudget("verify") === 240_000, "P3:verify 取证 240k(联合 600k)");
  if (m !== undefined) process.env.PIMOA_MATERIAL_BUDGET_CHARS = m;
  if (r !== undefined) process.env.PIMOA_RETRIEVAL_CHAR_BUDGET = r;
}

// ---- 2) 材料合并闸(env 收紧后触发,fail-loud) ----
{
  const saved = process.env.PIMOA_MATERIAL_BUDGET_CHARS;
  process.env.PIMOA_MATERIAL_BUDGET_CHARS = "1000";
  assert(materialBudgetChars("synthesize") === 1000, "materialBudgetChars 读 env(调用时)");
  const okReq = { prompt: "短任务", context: "少量材料" };
  assert(enforceMaterialBudget(okReq, "synthesize", "default") === null, "预算内放行");
  const bigReq = { prompt: "任务", context: "料".repeat(2000) };
  const err = enforceMaterialBudget(bigReq, "synthesize", "default");
  assert(err !== null && err.status === "failed" && err.error?.stage === "config", "超限 → config 阶段 fail-loud");
  assert(err !== null && err.error!.reason.includes("材料预算超限"), "拒绝理由自述超限");
  const entropyReq = { prompt: "x", context: "😀".repeat(600) };
  const err2 = enforceMaterialBudget(entropyReq, "synthesize", "default");
  assert(err2 !== null && err2.error!.reason.includes("高熵折算"), "高熵材料按 ×2 折算并在理由中标注");
  if (saved === undefined) delete process.env.PIMOA_MATERIAL_BUDGET_CHARS;
  else process.env.PIMOA_MATERIAL_BUDGET_CHARS = saved;
}

// ---- 3) 取证账本 per-call 上限与硬顶 ----
{
  const b = createRetrievalBudget();
  assert(budgetMaxChars(b) === SESSION_OUTPUT_CHAR_BUDGET && budgetMaxCalls(b) === 5, "缺省上限=全局值");
  const b2 = createRetrievalBudget({ maxCalls: 15, maxChars: 1_000 });
  assert(budgetMaxCalls(b2) === MAX_TOOL_CALLS_HARD_CAP, "maxCalls 15 被硬顶钳制到 10");
  b2.usedChars = 1_000;
  assert(isBudgetExhausted(b2), "自定义 maxChars 生效(1000 字符即耗尽)");
  const b3 = createRetrievalBudget({ maxCalls: 3 });
  b3.calls = 3;
  assert(isBudgetExhausted(b3), "自定义 maxCalls=3 生效");
  assert(TOOL_SLICE_CHARS === 120_000, "TOOL_SLICE 统一为 120k(五工具单次上限)");
  // P2 静态审查 F5:放行前预扣——余量装不下本次单次上限即拒,堵事后记账的累加逃逸。
  const b4 = createRetrievalBudget({ maxChars: 1_000 });
  b4.usedChars = 900;
  assert(isBudgetExhausted(b4, 200), "F5:余量 100 装不下单次上限 200 → 预扣拒绝");
  assert(!isBudgetExhausted(b4, 100), "F5:余量恰好装下 → 放行");
  b4.usedChars = 700;
  assert(!isBudgetExhausted(b4, 200), "F5:余量充足 → 放行");
}

// ---- 4) max_tool_calls 入参链 ----
{
  const schema = z.object(moaToolInput);
  assert(schema.safeParse({ prompt: "x", max_tool_calls: 8 }).success, "zod:max_tool_calls=8 合法");
  assert(!schema.safeParse({ prompt: "x", max_tool_calls: 11 }).success, "zod:11 超硬顶被拒");
  assert(!schema.safeParse({ prompt: "x", max_tool_calls: 2.5 }).success, "zod:非整数被拒");
  const req = buildRequest({ prompt: "x", max_tool_calls: 8 }, "default");
  assert(req.maxToolCalls === 8, "buildRequest 透传为 MoaRequest.maxToolCalls");
  assert(buildRequest({ prompt: "x" }, "default").maxToolCalls === undefined, "缺省不注入字段");
}

// ---- 5) 运行期窗口复核 validateWindowFit ----
{
  const w = (provider: string, model: string) =>
    ({ provider, model, profile: "synthesize-worker" }) as never;
  const mk = (cw: number, maxTok = 65_535) => ({
    getModel: () => ({ contextWindow: cw, maxTokens: maxTok }),
  });
  assert(
    validateWindowFit("synthesize", [w("p", "m1")], w("p", "agg"), mk(1_000_000)) === null,
    "1M 窗口:通过",
  );
  const err = validateWindowFit("synthesize", [w("p", "m1")], w("p", "agg"), mk(200_000));
  assert(err !== null && err.reason.includes("窗口预算不闭合"), "200k 窗口:运行期拒绝(治 req.models 覆盖逃逸)");
  assert(
    validateWindowFit("synthesize", [w("p", "m1")], w("p", "agg"), { getModel: () => undefined }) === null,
    "拿不到窗口数字:跳过(不误伤 mock/未知模型)",
  );
  // P2 静态审查 F2:verify 模式 proposers 也必须只读。
  const wp = (profile: string) => ({ provider: "p", model: "m", profile }) as never;
  const vErr = validateResolvedPlan("verify", [wp("synthesize-worker")], wp("verify-worker"));
  assert(vErr !== null && vErr.stage === "config" && vErr.reason.includes("proposers[0]"),
    "F2:verify + 可写 proposer → config 错");
  assert(validateResolvedPlan("verify", [wp("verify-worker")], wp("verify-worker")) === null,
    "F2 对照:全只读 → 通过");
}

// ---- 6) 加载期不变量⑦ + fallback model id 校验 ----
{
  const TMP = mkdtempSync(join(tmpdir(), "pimoa-limits-cfg-"));
  process.env.K_PIMOA_LIMITS_TEST = "test-key"; // 不变量④:apiKeyEnv 指向的 env 必须已设置
  const cfg = {
    providers: {
      p1: { kind: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K_PIMOA_LIMITS_TEST" },
    },
    presets: {
      default: {
        mode: "synthesize",
        quorum: "all",
        proposers: [{ provider: "p1", model: "m-big", profile: "synthesize-worker" }],
        aggregator: { provider: "p1", model: "m-big", profile: "synthesize-worker" },
        aggregatorFallback: { provider: "p1", model: "m-big", profile: "synthesize-worker" },
      },
    },
    timeouts: { referencePerCallMs: 180000, aggregatorPerCallMs: 480000, moaTotalBackstopMs: 720000, requestIdleMs: 60000 },
    defaults: { preset: "default" },
  };
  const models = (cw: number) => ({
    providers: {
      p1: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "$K_PIMOA_LIMITS_TEST",
        models: [{ id: "m-big", contextWindow: cw, maxTokens: 65535 }],
      },
    },
  });
  const yamlP = join(TMP, "ok.yaml");
  writeFileSync(yamlP, yamlStringify(cfg));
  const okModels = join(TMP, "models-ok.json");
  writeFileSync(okModels, JSON.stringify(models(1_000_000)));
  let ok = true;
  try {
    loadConfig({ moaYaml: yamlP, modelsJson: okModels });
  } catch {
    ok = false;
  }
  assert(ok, "不变量⑦:1M 窗口配置通过启动");

  const smallModels = join(TMP, "models-small.json");
  writeFileSync(smallModels, JSON.stringify(models(300_000)));
  let threw = "";
  try {
    loadConfig({ moaYaml: yamlP, modelsJson: smallModels });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(
    threw.includes("窗口预算不闭合") && threw.includes("有效窗口"),
    "不变量⑦:300k 窗口装不下预算 → 启动即拒且报验算明细",
  );

  // fallback model id 打错:此前不校验、真降级才炸;现启动即拒。
  const cfgBadFb = JSON.parse(JSON.stringify(cfg));
  cfgBadFb.presets.default.aggregatorFallback.model = "m-typo";
  const yamlBad = join(TMP, "badfb.yaml");
  writeFileSync(yamlBad, yamlStringify(cfgBadFb));
  let fbErr = "";
  try {
    loadConfig({ moaYaml: yamlBad, modelsJson: okModels });
  } catch (e) {
    fbErr = e instanceof Error ? e.message : String(e);
  }
  assert(fbErr.includes("aggregatorFallback") && fbErr.includes("m-typo"), "fallback model id 打错 → 启动即拒(审查 C10)");
  let isCfgErr = false;
  try {
    loadConfig({ moaYaml: yamlBad, modelsJson: okModels });
  } catch (e) {
    isCfgErr = e instanceof ConfigError;
  }
  assert(isCfgErr, "错误类型为 ConfigError(fail-loud 口径)");
}

console.log(`\n[limits-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
