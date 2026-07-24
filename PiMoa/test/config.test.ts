// Pi-MoA · loadConfig 加载期不变量测试（无测试框架，直接 npx tsx 跑）。
// 每条不变量：至少一个"违规配置→抛错"负例 + 合法配置正例。
// 运行：CLIPROXY_API_KEY=dummy npx tsx test/config.test.ts
//   （不变量④要求 apiKeyEnv 指向的 env 存在，故正例需设 CLIPROXY_API_KEY。）

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { ConfigError, loadConfig } from "../src/config/load.js";

const TMP = mkdtempSync(join(tmpdir(), "pimoa-cfg-"));
let pass = 0;
let fail = 0;

/** 深拷贝，便于每个用例独立改。 */
function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v));
}

/** 合法基线配置（对齐 config/moa.yaml）。 */
function baseConfig(): Record<string, unknown> {
	return {
		providers: {
			cliproxy: {
				kind: "openai",
				baseUrl: "http://127.0.0.1:8317/v1",
				apiKeyEnv: "CLIPROXY_API_KEY",
			},
		},
		presets: {
			default: {
				mode: "synthesize",
				quorum: "all",
				proposers: [
					{ provider: "cliproxy", model: "MiniMax-M3", profile: "synthesize-worker" },
					{ provider: "cliproxy", model: "mimo-v2.5-pro", profile: "synthesize-worker" },
				],
				aggregator: { provider: "cliproxy", model: "gpt-5.5", profile: "synthesize-worker" },
			},
			moa_verify: {
				mode: "verify",
				quorum: "all",
				proposers: [
					{ provider: "cliproxy", model: "MiniMax-M3", profile: "verify-worker" },
					{ provider: "cliproxy", model: "mimo-v2.5-pro", profile: "verify-worker" },
				],
				aggregator: { provider: "cliproxy", model: "gpt-5.5", profile: "verify-worker" },
			},
		},
		timeouts: {
			referencePerCallMs: 180000,
			aggregatorPerCallMs: 480000,
			moaTotalBackstopMs: 720000,
		},
		defaults: { preset: "default" },
	};
}

/**
 * 基线 models.json（运行期真源）。与 baseConfig 的 providers 对齐：cliproxy + $CLIPROXY_API_KEY。
 * loadConfig 缺省读 moa.yaml 同目录的 models.json，故写到 TMP/models.json 供 expectPass/derive 用。
 */
function baseModels(): Record<string, unknown> {
	return {
		providers: {
			cliproxy: {
				baseUrl: "http://127.0.0.1:8317/v1",
				api: "openai-completions",
				apiKey: "$CLIPROXY_API_KEY",
				models: [],
			},
		},
	};
}
// 写基线 models.json 到 TMP（作为 case-N.yaml 的同目录兄弟，供默认派生路径用）。
writeFileSync(join(TMP, "models.json"), JSON.stringify(baseModels()), "utf8");

let caseCounter = 0;
function writeFixture(cfg: unknown): string {
	const p = join(TMP, `case-${caseCounter++}.yaml`);
	writeFileSync(p, yamlStringify(cfg), "utf8");
	return p;
}

/** 写一份独立命名的 models.json，返回其绝对路径（供交叉校验用例显式传 modelsJson）。 */
function writeModels(models: unknown): string {
	const p = join(TMP, `models-${caseCounter++}.json`);
	writeFileSync(p, JSON.stringify(models), "utf8");
	return p;
}

/** 负例（显式 modelsJson）：期望 loadConfig 抛 ConfigError 且 message 含 needle。 */
function expectThrowWithModels(
	label: string,
	cfg: unknown,
	modelsJson: string,
	needle: string,
): void {
	const p = writeFixture(cfg);
	try {
		loadConfig({ moaYaml: p, modelsJson });
		console.error(`❌ FAIL  ${label}：期望抛错，却通过了`);
		fail++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (err instanceof ConfigError && msg.includes(needle)) {
			console.log(`✅ PASS  ${label}\n         → ${msg}`);
			pass++;
		} else {
			console.error(`❌ FAIL  ${label}：抛错但不符预期（needle="${needle}"）\n         → ${msg}`);
			fail++;
		}
	}
}

/** 正例（显式 modelsJson）：期望 loadConfig 成功返回。 */
function expectPassWithModels(label: string, cfg: unknown, modelsJson: string): void {
	const p = writeFixture(cfg);
	try {
		loadConfig({ moaYaml: p, modelsJson });
		console.log(`✅ PASS  ${label}`);
		pass++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`❌ FAIL  ${label}：期望通过，却抛错\n         → ${msg}`);
		fail++;
	}
}

/** 负例：期望 loadConfig 抛 ConfigError 且 message 含 needle。 */
function expectThrow(label: string, cfg: unknown, needle: string): void {
	const p = writeFixture(cfg);
	try {
		loadConfig({ moaYaml: p });
		console.error(`❌ FAIL  ${label}：期望抛错，却通过了`);
		fail++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (err instanceof ConfigError && msg.includes(needle)) {
			console.log(`✅ PASS  ${label}\n         → ${msg}`);
			pass++;
		} else {
			console.error(`❌ FAIL  ${label}：抛错但不符预期（needle="${needle}"）\n         → ${msg}`);
			fail++;
		}
	}
}

/** 正例：期望 loadConfig 成功返回。 */
function expectPass(label: string, cfg: unknown): void {
	const p = writeFixture(cfg);
	try {
		const out = loadConfig({ moaYaml: p });
		if (out && out.providers && out.presets && out.timeouts && out.defaults) {
			console.log(`✅ PASS  ${label}（返回 MoaConfig，presets=${Object.keys(out.presets).join(",")}）`);
			pass++;
		} else {
			console.error(`❌ FAIL  ${label}：返回结构不完整`);
			fail++;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`❌ FAIL  ${label}：期望通过，却抛错\n         → ${msg}`);
		fail++;
	}
}

// 不变量④要求 CLIPROXY_API_KEY 存在——正例前置。
process.env.CLIPROXY_API_KEY = process.env.CLIPROXY_API_KEY || "dummy-for-test";

console.log(`\n=== loadConfig 不变量测试（tmp=${TMP}）===\n`);

// ---- 正例 ----
expectPass("正例A：完整合法配置（default + moa_verify）", baseConfig());

{
	// 正例B：verify preset 用 delivery-readonly-worker 做 aggregator（不变量②允许的另一值）。
	const c = clone(baseConfig());
	(c as any).presets.moa_verify.aggregator.profile = "delivery-readonly-worker";
	expectPass("正例B：verify aggregator=delivery-readonly-worker", c);
}

// ---- 不变量① proposer/aggregator 的 provider 必须在 providers；都必须带 profile ----
{
	const c = clone(baseConfig());
	(c as any).presets.default.proposers[0].provider = "ghost-provider";
	expectThrow("①-neg1：proposer.provider 未注册", c, "不变量①");
}
{
	const c = clone(baseConfig());
	(c as any).presets.default.aggregator.provider = "ghost-provider";
	expectThrow("①-neg2：aggregator.provider 未注册", c, "不变量①");
}
{
	const c = clone(baseConfig());
	delete (c as any).presets.default.aggregator.profile;
	expectThrow("①-neg3：aggregator 缺 profile", c, "缺少 profile");
}

// ---- 不变量② verify preset 的 aggregator.profile 必须只读 ----
{
	const c = clone(baseConfig());
	(c as any).presets.moa_verify.aggregator.profile = "synthesize-worker";
	expectThrow("②-neg：verify aggregator=synthesize-worker（可写）", c, "不变量②");
}

// ---- 不变量③ quorum 锁死 = "all" ----
{
	const c = clone(baseConfig());
	(c as any).presets.default.quorum = 1;
	expectThrow("③-neg1：quorum=1", c, "quorum");
}
{
	const c = clone(baseConfig());
	(c as any).presets.default.quorum = "any";
	expectThrow("③-neg2：quorum=any", c, "quorum");
}

// ---- 不变量④ apiKeyEnv 指向的环境变量必须存在 ----
{
	const c = clone(baseConfig());
	(c as any).providers.cliproxy.apiKeyEnv = "PIMOA_DEFINITELY_UNSET_ENV_XYZ";
	expectThrow("④-neg：apiKeyEnv 指向未设置的 env", c, "不变量④");
}

// ---- 不变量⑤ 超时三嵌套 ----
{
	const c = clone(baseConfig());
	(c as any).timeouts.moaTotalBackstopMs = 400000; // < aggregatorPerCallMs(480000)
	expectThrow("⑤-neg1：backstop < aggregatorPerCall", c, "不变量⑤-a");
}
{
	const c = clone(baseConfig());
	// backstop 够大于单个 per_call，但 < ref+agg(660000)。
	(c as any).timeouts.moaTotalBackstopMs = 500000;
	expectThrow("⑤-neg2：backstop < ref+agg 串行链", c, "不变量⑤-b");
}

// ---- 不变量⑥ defaults.preset 必须存在于 presets ----
{
	const c = clone(baseConfig());
	(c as any).defaults.preset = "nonexistent";
	expectThrow("⑥-neg：defaults.preset 不在 presets", c, "不变量⑥");
}

// ---- 附加：结构层 fail-loud（非核心不变量，防御性）----
{
	const c = clone(baseConfig());
	(c as any).providers.cliproxy.kind = "grpc";
	expectThrow("结构-neg：provider.kind 非法", c, "kind 非法");
}

// ---- 不变量⑦：moa.yaml↔models.json 交叉校验（fix #3：providers 运行期真源是 models.json）----
// 多 provider 基线：对齐真实 config（minimax/xiaomi 直连 + cliproxy 聚合）。
function multiProviderConfig(): Record<string, unknown> {
	return {
		providers: {
			cliproxy: { kind: "openai", baseUrl: "http://127.0.0.1:8317/v1", apiKeyEnv: "CLIPROXY_API_KEY" },
			minimax: { kind: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic", apiKeyEnv: "MINIMAX_API_KEY" },
			xiaomi: { kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", apiKeyEnv: "XIAOMI_API_KEY" },
		},
		presets: {
			default: {
				mode: "synthesize",
				quorum: "all",
				proposers: [
					{ provider: "minimax", model: "MiniMax-M3", profile: "synthesize-worker" },
					{ provider: "xiaomi", model: "mimo-v2.5-pro", profile: "synthesize-worker" },
				],
				aggregator: { provider: "cliproxy", model: "gpt-5.5", profile: "synthesize-worker" },
			},
		},
		timeouts: { referencePerCallMs: 180000, aggregatorPerCallMs: 480000, moaTotalBackstopMs: 720000 },
		defaults: { preset: "default" },
	};
}
function multiProviderModels(): Record<string, unknown> {
	return {
		providers: {
			cliproxy: { baseUrl: "http://127.0.0.1:8317/v1", api: "openai-completions", apiKey: "$CLIPROXY_API_KEY", models: [] },
			minimax: { baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", apiKey: "$MINIMAX_API_KEY", models: [] },
			xiaomi: { baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions", apiKey: "$XIAOMI_API_KEY", models: [] },
		},
	};
}
// 交叉校验需 env 存在（不变量④ 先于⑦；正例这三者都要设）。
process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "dummy-for-test";
process.env.XIAOMI_API_KEY = process.env.XIAOMI_API_KEY || "dummy-for-test";

// ⑦-pos：moa.yaml 与 models.json 一致 → 通过。
expectPassWithModels("⑦-pos：moa.yaml↔models.json 一致（3 provider）", multiProviderConfig(), writeModels(multiProviderModels()));

// ⑦-neg1：presets 引用的 provider 在 models.json 中缺失 → fail-loud。
{
	const models = multiProviderModels();
	delete (models as any).providers.xiaomi; // 运行期真源里没有 xiaomi
	expectThrowWithModels("⑦-neg1：引用的 provider 不在 models.json", multiProviderConfig(), writeModels(models), "在 models.json 中不存在");
}

// ⑦-neg2：apiKeyEnv 与 models.json 的 apiKey env 名不一致（漂移）→ fail-loud。
{
	const models = multiProviderModels();
	(models as any).providers.minimax.apiKey = "$MINIMAX_WRONG_KEY"; // env 名对不上 moa.yaml 的 MINIMAX_API_KEY
	expectThrowWithModels("⑦-neg2：apiKeyEnv 与 models.json env 名对不上", multiProviderConfig(), writeModels(models), "env 名对不上");
}

// ⑦-neg3：models.json 的 apiKey 非 "$ENV" 形式 → fail-loud（无从核对真源 env）。
{
	const models = multiProviderModels();
	(models as any).providers.cliproxy.apiKey = "sk-plaintext"; // 非 $ENV 引用
	expectThrowWithModels("⑦-neg3：models.json apiKey 非 $ENV 形式", multiProviderConfig(), writeModels(models), "非 \"$ENV\" 形式");
}

// ⑦-neg4：models.json 读取失败（路径不存在）→ 清晰错误。
expectThrowWithModels("⑦-neg4：models.json 读取失败", multiProviderConfig(), join(TMP, "does-not-exist.json"), "读取 models.json 失败");

// ⑦-neg5：models.json JSON 解析失败 → 清晰错误。
{
	const bad = join(TMP, `bad-models-${caseCounter++}.json`);
	writeFileSync(bad, "{ not json ", "utf8");
	expectThrowWithModels("⑦-neg5：models.json JSON 解析失败", multiProviderConfig(), bad, "JSON 解析失败");
}

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
