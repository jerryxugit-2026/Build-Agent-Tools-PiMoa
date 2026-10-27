/**
 * 出站 payload 回归闸（2026-09-22）。
 *
 * 运行：npx tsx test/payload_guard.test.ts
 * 特性：脱网、脱真实 key、**不需要 8758**；只绑 127.0.0.1 上随机高位端口。
 *
 * 为什么必须用「真实出站 payload」而不是单测 stub 来验：
 *   `src/moa/session.ts` 的 `wrapStreamFunction` 给 pi 的 streamFunction 叠了两件事——
 *   ①补 `max_tokens`（`model.maxTokens`）；②请求级 idle 看门狗。而「thinking 是否被关掉」**不是
 *   PiMoa 自己发的字段**：它由 pi-ai 的 `compat.thinkingFormat` 分支（`api/openai-completions.js`
 *   的 `:611-617`）依 `model.reasoning` 决定。PiMoa 侧影响它的**必要条件**是 `model.reasoning === true`
 *   + `thinkingLevel:"off"`（`src/moa/session.ts` 内 `createAgentSession({ thinkingLevel: "off" })`）；
 *   models.json 的 `compat.thinkingFormat:"deepseek"` 是**显式对齐**（也让意图可见），**不是唯一来源**
 *   ——pi-ai 内置目录 `providers/data/xiaomi.json` 自带该 compat，`ModelRuntime` 解析时合并回来（该事实
 *   由 2026-09-22 本仓一次性探针实测，**未固化为本文件用例**）。所以**只有从真实出站请求体上读**才能
 *   证明这条链路还连着；任何一层被"清理"掉，都不会有本地信号。
 *
 * 锁死的两条生产事实（真 xiaomi 端点实测，max_tokens=4000、同一道推理题）：
 *   · `thinking:{type:"enabled"}` ⇒ reasoning_tokens=3999、可见正文 **1 个 token**、
 *     finish_reason=length（推理把共享输出窗口烧穿，答案没了）；
 *   · `thinking:{type:"disabled"}` ⇒ reasoning_tokens=0、可见正文 1226 token、finish_reason=stop。
 *   ⇒ PiMoa 之所以安全，**唯一原因**就是它下发 disabled。这条一旦回退，生产立刻出现空正文，
 *   而 idle 看门狗**兜不住**——推理阶段端点在持续出字节，idle 计时器一直被重置。
 *   ⇒ 同时锁死 `max_tokens` 确实送达（2026-09-20 修过的生产缺陷：pi 的 agent-loop 原本不传
 *   maxTokens，deepseek 按服务端缺省 8,192 截断）。
 *
 * ⚠️ 附带事实（**故意不断言**，写在这里防后人误加）：顶层 `thinking_token_budget` 经实测**被该端点
 *   接受但完全忽略**（预算 0/100/1000 下 reasoning 均跑到 ~4000），所以**不要**去加
 *   `compat.supportsThinkingTokenBudget`。本用例只断言该字段**不存在**（防止有人误加这个被端点忽略的
 *   开关），不把它当"生效的预算"用。
 *
 * 用例：
 *   ① 本地捕获端点 + 临时 models.json（克隆真 config/models.json 的 xiaomi provider，含 reasoning:true
 *      与真 compat）+ **真 runSession** ⇒ 拿到真实出站请求体；
 *   ② 真 payload 三断言：thinking={type:"disabled"}、max_tokens=models.json 的 maxTokens、
 *      无 thinking_token_budget；
 *   ③ ★反向自证：同一套校验函数对「删掉 thinking」「thinking 改成 enabled」「删掉 max_tokens」
 *      「加回 thinking_token_budget」四种坏 payload 必须判红——没有这一步，本闸只是摆设。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createIsolatedLoader, runSession } from "../src/moa/session.js";

// ---------------------------------------------------------------------------
// 断言台账（与 test/session_idle.test.ts 同风格：不抛异常，逐条记分，末尾非零退出）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 被测契约：一条出站请求体是否满足 PiMoa 生产不变量
//   （抽成纯函数，正向真 payload 与反向坏 payload 走**同一套判据**——这是反向自证成立的前提）
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_MODELS = resolve(HERE, "../config/models.json");

const PROVIDER = "xiaomi";
const MODEL_ID = "mimo-v2.5-pro";
const KEY_ENV = "PIMOA_PAYLOAD_GUARD_KEY";

/**
 * 校验一条**真实出站** chat/completions 请求体的 PiMoa 生产不变量。
 * 返回失败原因数组（空数组 = 过闸）。只读不改。
 */
function validateOutboundPayload(body: unknown, expectedMaxTokens: number): string[] {
  const bad: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return [`请求体不是对象：${JSON.stringify(body)?.slice(0, 80)}`];
  }
  const b = body as Record<string, unknown>;

  // ① 推理必须显式关闭。这是 PiMoa 现在**唯一**的保护：
  //    thinkingFormat="deepseek" + reasoning:true + 无 reasoningEffort ⇒ 必须发 disabled。
  const th = b.thinking as { type?: unknown } | undefined;
  if (th === undefined || th === null) {
    bad.push(
      "thinking 字段缺失（期望 {\"type\":\"disabled\"}）——pi 的 deepseek 分支没走到，" +
        "生产会退回端点自身默认档：实测 reasoning 吃光共享输出窗口 ⇒ 空正文",
    );
  } else if (typeof th !== "object" || th.type !== "disabled") {
    bad.push(
      `thinking.type=${JSON.stringify((th as { type?: unknown }).type)}，期望 "disabled"` +
        `（"enabled" 实测 reasoning_tokens=3999 / 可见正文 1 token / finish_reason=length）`,
    );
  }

  // ② max_tokens 必须真的送达，且等于 models.json 声明的上限（2026-09-20 修过的生产缺陷）。
  if (typeof b.max_tokens !== "number") {
    bad.push(
      `max_tokens 未送达或非数字（实际 ${JSON.stringify(b.max_tokens)}）——pi 的 agent-loop 不传 ` +
        `maxTokens，必须由 wrapStreamFunction 注入；缺失则端点按服务端缺省 8192 截断`,
    );
  } else if (b.max_tokens !== expectedMaxTokens) {
    bad.push(`max_tokens=${b.max_tokens}，期望 ${expectedMaxTokens}（= models.json 该模型的 maxTokens）`);
  }

  // ③ thinking_token_budget 不该出现：该端点收下但完全忽略（实测预算 0/100/1000 下 reasoning 均 ~4000），
  //    出现它说明有人误加了 compat.supportsThinkingTokenBudget，是"以为控住了其实没有"的假保护。
  if ("thinking_token_budget" in b) {
    bad.push(
      `出现了 thinking_token_budget=${JSON.stringify(b.thinking_token_budget)}：该端点接受但完全忽略，` +
        `加它等于假保护（不要设 compat.supportsThinkingTokenBudget）`,
    );
  }

  return bad;
}

// ---------------------------------------------------------------------------
// 从**真** config/models.json 克隆 xiaomi provider（保住 reasoning:true 与真实 compat 形状）
// ---------------------------------------------------------------------------
interface ClonedProvider {
  provider: Record<string, unknown>;
  maxTokens: number;
}

function cloneRealXiaomiProvider(localBaseUrl: string, mangleModel?: (m: Record<string, unknown>) => void): ClonedProvider {
  if (!existsSync(CONFIG_MODELS)) {
    throw new Error(`真 models.json 不存在：${CONFIG_MODELS}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_MODELS, "utf8")) as {
    providers?: Record<string, Record<string, unknown>>;
  };
  const xiaomi = raw.providers?.[PROVIDER];
  if (!xiaomi) throw new Error(`真 models.json 里没有 ${PROVIDER} provider：${CONFIG_MODELS}`);
  const models = (xiaomi.models ?? []) as Array<Record<string, unknown>>;
  const target = models.find((m) => m.id === MODEL_ID);
  if (!target) throw new Error(`真 models.json 的 ${PROVIDER} 里没有模型 ${MODEL_ID}`);
  if (target.reasoning !== true) {
    throw new Error(
      `${PROVIDER}/${MODEL_ID} 的 reasoning 不是 true（实际 ${String(target.reasoning)}）——` +
        `pi 的 deepseek 分支要求 model.reasoning，关掉它 thinking 字段根本不会发。`,
    );
  }
  const maxTokens = target.maxTokens;
  if (typeof maxTokens !== "number" || maxTokens <= 0) {
    throw new Error(`${PROVIDER}/${MODEL_ID} 的 maxTokens 非法：${JSON.stringify(maxTokens)}`);
  }
  // 只改 baseUrl 指到本地；apiKey 用临时 env 名（本端点不看鉴权，只要求能解析出非空 key）。
  // ★`compat` 与 `reasoning` **原样带过去**，因为被测的就是真实配置形状。实测澄清（2026-09-22 本仓
  //   一次性探针，**未固化为本文件用例**）：即使把 `compat.thinkingFormat` 从这里删掉，闸**仍然过**
  //   ——因为 pi-ai 内置目录 `providers/data/xiaomi.json` 里 mimo-v2.5-pro 本来就带
  //   `compat.thinkingFormat:"deepseek"`，ModelRuntime 解析时把它合并回来了。所以
  //   `thinking:{type:"disabled"}` 的**必要条件**是 `model.reasoning === true` + PiMoa 的
  //   `thinkingLevel:"off"`；models.json 里那条 thinkingFormat 是**显式对齐**（也让意图可见），不是
  //   唯一来源。**这条澄清没有被下面的用例固化**：本文件的活体探针只钉死其中两环——
  //   ④ `reasoning:false` ⇒ 出站 payload 不再有 disabled 的 thinking（本用例断言该字段「缺失或
  //   非 disabled」，实测为 undefined）⇒ 闸判红；
  //   ⑤ `thinkingLevel:"high"` ⇒ pi 真发 enabled ⇒ 闸判红。
  const modelsOut = models.map((m) => (m.id === MODEL_ID ? { ...m } : m));
  const outTarget = modelsOut.find((m) => m.id === MODEL_ID) as Record<string, unknown>;
  mangleModel?.(outTarget);
  const provider = { ...xiaomi, baseUrl: localBaseUrl, apiKey: `$${KEY_ENV}`, models: modelsOut };
  return { provider, maxTokens };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), "pimoa-payload-guard-"));
const captured: Array<Record<string, unknown>> = [];
const sockets = new Set<Socket>();

/** 一条 OpenAI 兼容 SSE chunk。 */
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

const server = createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c: string) => {
    raw += c;
  });
  req.on("end", () => {
    // 只捕获 chat/completions；其余路径 404（照 session_idle 的写法）。
    if (!/\/chat\/completions$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
    captured.push({
      url: req.url,
      method: req.method,
      contentType: req.headers["content-type"],
      authorizationPresent: typeof req.headers.authorization === "string",
      rawBytes: Buffer.byteLength(raw, "utf8"),
      body: parsed,
      raw,
    });

    // 最小但合法的 OpenAI 流式响应：一帧正文 + 一帧 finish_reason=stop（带 usage）+ [DONE]。
    // `supportsFinishReason` 探测为 true，所以**必须**给 finish_reason，否则 pi 抛
    // "Stream ended without finish_reason"。
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      sse({
        id: "payload-guard-1",
        object: "chat.completion.chunk",
        created: 0,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: "payload-guard-ok" }, finish_reason: null }],
      }),
    );
    res.write(
      sse({
        id: "payload-guard-1",
        object: "chat.completion.chunk",
        created: 0,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
server.on("connection", (s: Socket) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});

try {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  assert(port > 0, `本地捕获端点已绑 127.0.0.1:${port}`);

  const { provider, maxTokens } = cloneRealXiaomiProvider(`http://127.0.0.1:${port}/v1`);
  const modelsPath = join(tmpDir, "models.payload-guard.json");
  const authPath = join(tmpDir, "auth.payload-guard.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { [PROVIDER]: provider } }), "utf8");
  writeFileSync(authPath, "{}", "utf8");
  process.env[KEY_ENV] = process.env[KEY_ENV] ?? "dummy-payload-guard-key";

  const runtime = await ModelRuntime.create({ modelsPath, authPath });
  const model = runtime.getModel(PROVIDER, MODEL_ID);
  assert(model !== undefined, `临时 models.json + ModelRuntime 解析出 ${PROVIDER}/${MODEL_ID}`);
  assert(
    typeof model?.maxTokens === "number" && model.maxTokens > 0,
    `pi Model.maxTokens 有值：${String(model?.maxTokens)}（期望 ${maxTokens}）`,
  );

  // ---- 真 runSession（走 thinkingLevel 缺省路径；runSession 内部硬编码 "off"）----
  const worker = { provider: PROVIDER, model: MODEL_ID, profile: "synthesize-worker" } as never;
  const result = await runSession(runtime, worker, "只回答 ok", {
    timeoutMs: 30_000,
    tools: [],
    cwd: tmpDir,
    readRoots: [],
  } as never);

  // 会话收尾 sanity：端到端真跑通了，"payload 是真的发出去过"才有意义。
  assert(result.error === undefined, `runSession 无 error（实际 ${JSON.stringify(result.error)}）`);
  assert(result.stopReason === "stop", `runSession 终态 stopReason=stop（实际 ${String(result.stopReason)}）`);
  assert(result.text.includes("payload-guard-ok"), `runSession 拿到正文：${JSON.stringify(result.text)}`);
  assert(captured.length === 1, `捕获到恰好 1 条出站请求（实际 ${captured.length}）`);

  const first = captured[0];
  const body = first?.body as Record<string, unknown> | undefined;
  assert(typeof body === "object" && body !== null, "捕获的请求体是合法 JSON（非空对象）");

  // 请求级证据同样进闸：确保这条捕获体是**真 POST 到本端点**的（不是别的路径/别的形状被误记）。
  const reqBad: string[] = [];
  if (typeof first?.url !== "string" || !/\/chat\/completions$/.test(first.url)) {
    reqBad.push(`URL 不是 chat/completions：${JSON.stringify(first?.url)}`);
  }
  if (first?.method !== "POST") reqBad.push(`方法不是 POST：${JSON.stringify(first?.method)}`);
  if (first?.authorizationPresent !== true) reqBad.push("Authorization 头缺失（pi 未带鉴权发出）");
  assert(reqBad.length === 0, `请求级不变量过闸（失败项 ${reqBad.length} 条：${reqBad.join(" ｜ ") || "无"}）`);

  // 落盘一份捕获体，便于事后取证（tmp 目录，不污染仓内）。
  const dumpPath = join(tmpDir, "captured-payload.json");
  writeFileSync(
    dumpPath,
    JSON.stringify(
      captured.map((c) => ({ url: c.url, method: c.method, contentType: c.contentType })),
      null,
      2,
    ) + "\n" + (first?.raw ?? ""),
    "utf8",
  );
  console.log(`  ℹ️ 捕获体落盘：${dumpPath}`);

  // ---- ② 真 payload 三断言（核心闸）----
  const realBad = validateOutboundPayload(body, maxTokens);
  assert(realBad.length === 0, `真出站 payload 过闸（失败项 ${realBad.length} 条：${realBad.join(" ｜ ") || "无"}）`);

  const realThinking = body?.thinking as { type?: unknown } | undefined;
  assert(
    realThinking !== undefined && realThinking !== null && realThinking.type === "disabled",
    `★核心：真实出站 payload 的 thinking=${JSON.stringify(realThinking)}，即 pi 发的是 disabled`,
  );
  assert(
    body?.max_tokens === maxTokens,
    `真实出站 payload 的 max_tokens=${JSON.stringify(body?.max_tokens)} === models.json 的 maxTokens=${maxTokens}`,
  );
  assert(
    !("thinking_token_budget" in (body ?? {})),
    `真实出站 payload 没有 thinking_token_budget（实际 ${JSON.stringify(body?.thinking_token_budget)}）`,
  );
  // 模型/流式形状 sanity：确认被测的就是生产那条 openai-completions 流式路径。
  assert(body?.model === MODEL_ID, `payload.model=${JSON.stringify(body?.model)}（期望 ${MODEL_ID}）`);
  assert(body?.stream === true, `payload.stream=${JSON.stringify(body?.stream)}（pi 走流式）`);

  // ---- ③ 反向自证：同一套校验函数必须对四种坏 payload 判红 ----
  //    没有这一步，本闸只是摆设（校验函数写错成"永远返回空"也会全绿）。
  console.log("  —— 反向自证（坏 payload 必须被判红）——");
  const goodBody = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  assert(
    validateOutboundPayload(goodBody, maxTokens).length === 0,
    "反向自证前置：克隆出来的好 payload 仍然过闸（确保下面那几条判红不是「它本来就红」）",
  );

  const withoutThinking = JSON.parse(JSON.stringify(goodBody)) as Record<string, unknown>;
  delete withoutThinking.thinking;
  const r1 = validateOutboundPayload(withoutThinking, maxTokens);
  assert(
    r1.length > 0 && r1.some((m) => m.includes("thinking")),
    `★反向自证 1：删掉 thinking ⇒ 判红（${r1[0] ?? "无失败项"}）`,
  );

  const thinkingEnabled = JSON.parse(JSON.stringify(goodBody)) as Record<string, unknown>;
  thinkingEnabled.thinking = { type: "enabled" };
  const r2 = validateOutboundPayload(thinkingEnabled, maxTokens);
  assert(
    r2.length > 0 && r2.some((m) => m.includes("disabled")),
    `★反向自证 2：thinking 改成 enabled（真实生产回退形态）⇒ 判红（${r2[0] ?? "无失败项"}）`,
  );

  const withoutMaxTokens = JSON.parse(JSON.stringify(goodBody)) as Record<string, unknown>;
  delete withoutMaxTokens.max_tokens;
  const r3 = validateOutboundPayload(withoutMaxTokens, maxTokens);
  assert(
    r3.length > 0 && r3.some((m) => m.includes("max_tokens")),
    `★反向自证 3：删掉 max_tokens ⇒ 判红（${r3[0] ?? "无失败项"}）`,
  );

  const withBudget = JSON.parse(JSON.stringify(goodBody)) as Record<string, unknown>;
  withBudget.thinking_token_budget = 0;
  const r4 = validateOutboundPayload(withBudget, maxTokens);
  assert(
    r4.length > 0 && r4.some((m) => m.includes("thinking_token_budget")),
    `★反向自证 4：加回 thinking_token_budget ⇒ 判红（${r4[0] ?? "无失败项"}）`,
  );

  // -------------------------------------------------------------------------
  // ④ ★活体接线探针（比 ③ 的合成坏 payload 更进一步）：
  //    同一套闸函数，跑在**真 runSession 真发出的**、但配置被故意打回退形态的 payload 上，
  //    必须判红。这一条直接证明「thinking 打开」这条回退**真的会被这条闸拦住**，而不只是
  //    "函数对伪造输入返回了非空数组"。
  //    回退形态取 `reasoning:false`：这是 pi `deepseek` 分支的开关
  //    （`openai-completions.js` 里 `compat.thinkingFormat === "deepseek" && model.reasoning`），
  //    关掉它之后 pi **不再发** `thinking`（本用例断言该字段「缺失或非 disabled」，实测为
  //    undefined）⇒ 端点退回自身默认档（真端点实测：reasoning_tokens=3999、正文 1 token、
  //    finish_reason=length）——正好是"生产出现空正文"的现场。
  // -------------------------------------------------------------------------
  console.log("  —— 活体接线探针（真 runSession + 回退配置，必须判红）——");
  {
    const { provider: regressedProvider, maxTokens: regressedCap } = cloneRealXiaomiProvider(
      `http://127.0.0.1:${port}/v1`,
      (m) => {
        m.reasoning = false;
      },
    );
    const regressedPath = join(tmpDir, "models.payload-guard-regressed.json");
    writeFileSync(regressedPath, JSON.stringify({ providers: { [PROVIDER]: regressedProvider } }), "utf8");
    const regressedRuntime = await ModelRuntime.create({ modelsPath: regressedPath, authPath });
    const regressedModel = regressedRuntime.getModel(PROVIDER, MODEL_ID) as unknown as
      | { reasoning?: unknown }
      | undefined;
    assert(
      regressedModel?.reasoning === false,
      `活体探针前置：回退模型 reasoning=${JSON.stringify(regressedModel?.reasoning)}（期望 false）`,
    );

    captured.length = 0; // 只统计这一轮的出站请求
    const regressedResult = await runSession(
      regressedRuntime,
      { provider: PROVIDER, model: MODEL_ID, profile: "synthesize-worker" } as never,
      "只回答 ok",
      { timeoutMs: 30_000, tools: [], cwd: tmpDir, readRoots: [] } as never,
    );
    assert(
      regressedResult.error === undefined && regressedResult.stopReason === "stop",
      `活体探针：回退配置下会话仍正常收尾（error=${JSON.stringify(regressedResult.error)}、stopReason=${String(regressedResult.stopReason)}）——所以下面的判红不是"没跑通"造成的`,
    );
    assert(captured.length === 1, `活体探针：回退配置下捕获到恰好 1 条出站请求（实际 ${captured.length}）`);

    const regressedBody = captured[0]?.body as Record<string, unknown> | undefined;
    console.log(
      `  ℹ️ 回退配置下真实出站 payload 的 thinking=${JSON.stringify(regressedBody?.thinking)}，` +
        `max_tokens=${JSON.stringify(regressedBody?.max_tokens)}`,
    );
    const regressedBad = validateOutboundPayload(regressedBody, regressedCap);
    assert(
      regressedBad.length > 0,
      `★活体接线探针：reasoning=false（thinking 不再 disabled）⇒ 同一套闸判红（${regressedBad[0] ?? "无失败项"}）`,
    );
    assert(
      regressedBody?.thinking === undefined || (regressedBody.thinking as { type?: unknown }).type !== "disabled",
      `活体探针：回退 payload 确实不再是 disabled（实际 ${JSON.stringify(regressedBody?.thinking)}）`,
    );
    // 反向边界：这只证明闸对"thinking 回退"敏感；max_tokens 注入仍在，故该条不应误报。
    assert(
      regressedBody?.max_tokens === regressedCap,
      `活体探针：回退配置下 max_tokens 仍被注入（${JSON.stringify(regressedBody?.max_tokens)} === ${regressedCap}），未误报`,
    );
  }

  // -------------------------------------------------------------------------
  // ⑤ 最强回退形态：真 pi 会话 + `thinkingLevel:"high"`（= reasoning 被打开，
  //    即"有人抬了 thinkingLevel"这条最贴近现实的回退），pi 真发
  //    `thinking:{type:"enabled"}` ⇒ 同一套闸必须判红。③ 里对合成 payload 的判红在这里
  //    被一条**真实出站**的 enabled payload 独立坐实。
  // -------------------------------------------------------------------------
  console.log("  —— 最强回退形态（真 pi 会话 thinkingLevel:high ⇒ thinking enabled）——");
  {
    const { provider: llmProvider, maxTokens: llmCap } = cloneRealXiaomiProvider(`http://127.0.0.1:${port}/v1`);
    const llmPath = join(tmpDir, "models.payload-guard-high.json");
    writeFileSync(llmPath, JSON.stringify({ providers: { [PROVIDER]: llmProvider } }), "utf8");
    const llmRuntime = await ModelRuntime.create({ modelsPath: llmPath, authPath });
    const llmModel = llmRuntime.getModel(PROVIDER, MODEL_ID);
    assert(llmModel !== undefined, "最强回退形态：模型解析成功");

    // ★口径更正（勿再写成"与生产唯一差异"）：就**thinking 相关配置**而言，本探针与生产的唯一差异
    //   才是 thinkingLevel:"high"（生产是 "off"）——这一处差异足以让 pi 真发 enabled（由紧随本块的
    //   那条"前置"断言坐实）。整体配置**不止这一处差异**，本探针不能代表生产的出厂 payload：
    //     · 本探针走 createAgentSession 直连，**不经过** `runSession` 的 `wrapStreamFunction`
    //       （文件头 8–10 行的 max_tokens 注入就装在那个函数里，见 `src/moa/session.ts`）⇒ 本探针
    //       捕获到的 payload **同时不含 `max_tokens`**；
    //     · settingsManager 是 `{ retry: { enabled: false } }`，而生产是 `retry: enabled:true`。
    //   证据力不受此影响（勿据此判定本探针失效）：下面那条断言要的是"同一套闸判红且失败项含
    //   `disabled`"，该子串只由 thinking 判据产出；缺 `max_tokens` 那条的文案不含 `disabled`、
    //   不参与这条断言，故本条只坐实"闸对 enabled 判红"这一件事，不外推为对生产出厂 payload 的判红。
    const loader = await createIsolatedLoader(tmpDir);
    const created = await createAgentSession({
      cwd: tmpDir,
      model: llmModel as never,
      thinkingLevel: "high" as never,
      modelRuntime: llmRuntime,
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(tmpDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    } as never);
    captured.length = 0;
    await created.session.prompt("只回答 ok");
    created.session.dispose();

    assert(captured.length === 1, `最强回退形态：捕获到恰好 1 条出站请求（实际 ${captured.length}）`);
    const enabledBody = captured[0]?.body as Record<string, unknown> | undefined;
    console.log(`  ℹ️ thinkingLevel:high 下真实出站 payload 的 thinking=${JSON.stringify(enabledBody?.thinking)}`);
    assert(
      (enabledBody?.thinking as { type?: unknown } | undefined)?.type === "enabled",
      `最强回退形态前置：pi 真的发了 enabled（实际 ${JSON.stringify(enabledBody?.thinking)}）——证明这条回退真的会发生`,
    );
    const enabledBad = validateOutboundPayload(enabledBody, llmCap);
    assert(
      enabledBad.length > 0 && enabledBad.some((m) => m.includes("disabled")),
      `★最强回退形态：真发 enabled ⇒ 同一套闸判红（${enabledBad[0] ?? "无失败项"}）`,
    );
  }
} finally {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n[payload-guard-test] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
