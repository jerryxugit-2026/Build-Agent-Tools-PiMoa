/**
 * B3 围栏参数回归闸（2026-10-01，pi-ai 0.99.2 升级配套）。
 *
 * 运行：npx tsx test/b3_fence.test.ts
 * 特性：脱网、脱真实 key、**不需要 8758**；只绑 127.0.0.1 上随机高位端口（显式拒绝 8757–8762）。
 *
 * 为什么要有它：B3（`patches/pi-ai-0.99.2/utils/json-parse.js`，剥 markdown 头围栏后重走
 *   `parseStreamingJson`）是升级后唯一保留的本地补丁；升级评估实测「0.99.2 不打 B3」时全部 34 个测试文件
 *   仍然全绿 ⇒ 补丁缺失只能靠启动守卫的哈希比对发现。本文件补上这块盲区：**B3 缺失时必须红**。
 *
 * 被测链路（全部是生产实际走的代码，不 stub pi 的解析层）：
 *   ① 单元面：从 pi-coding-agent 嵌套的 pi-ai dist（= 补丁目标、= agent-loop 实际加载的那份）取
 *      `parseStreamingJson`，喂带围栏的工具参数串；
 *   ② 端到端：本地 OpenAI 兼容 SSE 端点把工具参数以 "```json\n{…}\n```" 形态分块流出 →
 *      真 `ModelRuntime` + 真 `createAgentSession` + pi-ai `openai-completions` 适配层逐块
 *      `parseStreamingJson` → agent-loop typebox 校验 → 工具 execute。B3 缺失时参数退化为 `{}`，
 *      校验失败、工具不执行 ⇒ 断言红。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { createIsolatedLoader } from "../src/moa/session.js";

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
const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_AI_INDEX = pathToFileURL(
  resolve(HERE, "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js"),
).href;
const piAi = (await import(PI_AI_INDEX)) as { parseStreamingJson: (s: string) => unknown };

// ============================================================================
// ① 单元面：真 dist 的 parseStreamingJson
// ============================================================================
console.log("=== ① parseStreamingJson（补丁目标 dist）===");
const psj = piAi.parseStreamingJson;
const FENCED_CASES: Array<[string, string, unknown]> = [
  ["头尾围栏完整", '```json\n{"path":"/tmp/x","n":3}\n```', { path: "/tmp/x", n: 3 }],
  ["头围栏半程帧", '```json\n{"path":"/tmp/x","n":3', { path: "/tmp/x", n: 3 }],
  ["无语言标号", '```\n{"path":"/tmp/x"}', { path: "/tmp/x" }],
  ["围栏后无换行", '```json {"path":"/tmp/x"}', { path: "/tmp/x" }],
  ["双层头围栏", '```json\n```json\n{"path":"/tmp/x"}', { path: "/tmp/x" }],
];
for (const [name, input, want] of FENCED_CASES) {
  const got = psj(input);
  assert(eqJson(got, want), `B3 围栏还原·${name}：${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
}
// 不变量（B3 打不打都必须成立，防补丁改坏裸 JSON 路径）
assert(eqJson(psj('{"path":"/tm'), { path: "/tm" }), "不变量：裸 JSON 半程帧逐字节一致");
assert(eqJson(psj('{"cmd":"ls"}\n```'), { cmd: "ls" }), "不变量：仅尾围栏的裸 JSON 不受影响");
assert(eqJson(psj("```"), {}), "不变量：纯围栏收敛为 {}（递归终止）");

// ============================================================================
// ② 端到端：本地 SSE 端点 → 真 pi 会话 → 工具 execute 收到的参数
// ============================================================================
console.log("=== ② 端到端：围栏工具参数经 openai-completions 流式解析后送达工具 ===");
const FORBIDDEN_PORTS = new Set([8757, 8758, 8759, 8760, 8761, 8762]);
const PROVIDER = "b3probe";
const MODEL_ID = "b3-probe-model";
const KEY_ENV = "PIMOA_B3_PROBE_KEY";
const TOOL = "fence_probe";
const WANT_ARGS = { path: "/tmp/b3-fence-probe.txt", n: 3 };
// 围栏参数按生产观测形态切块下发（头围栏、JSON 主体分两段、尾围栏），每块都会触发一次 parseStreamingJson。
const ARG_CHUNKS = ["```json\n", '{"path":"/tmp/b3-fence-', 'probe.txt","n":3}', "\n```"];

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) => ({
  id: "b3-probe",
  object: "chat.completion.chunk",
  created: 0,
  model: MODEL_ID,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

const requests: Array<Record<string, unknown>> = [];
const sockets = new Set<Socket>();
const server = createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* 留空，下方断言会暴露 */
    }
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (requests.length === 1) {
      res.write(sse(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_b3_1", type: "function", function: { name: TOOL, arguments: "" } }] }, null)));
      for (const a of ARG_CHUNKS) res.write(sse(chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }, null)));
      res.write(sse(chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })));
    } else {
      res.write(sse(chunk({ role: "assistant", content: "b3-probe-done" }, null)));
      res.write(sse(chunk({}, "stop", { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 })));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
server.on("connection", (s: Socket) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});

const executed: unknown[] = [];
const toolEnds: Array<{ isError?: boolean; text: string }> = [];
let sessionText = "";
try {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  assert(port > 0 && !FORBIDDEN_PORTS.has(port), `本地 SSE 端点绑 127.0.0.1:${port}（不在 8757–8762）`);

  const tmpDir = mkdtempSync(join(tmpdir(), "pimoa-b3-fence-"));
  const modelsPath = join(tmpDir, "models.json");
  const authPath = join(tmpDir, "auth.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: `$${KEY_ENV}`,
          models: [
            {
              id: MODEL_ID,
              name: "b3 probe",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(authPath, "{}", "utf8");
  process.env[KEY_ENV] = process.env[KEY_ENV] ?? "dummy-b3-probe-key";

  const runtime = await ModelRuntime.create({ modelsPath, authPath });
  const model = runtime.getModel(PROVIDER, MODEL_ID);
  assert(model !== undefined, `临时 models.json 解析出 ${PROVIDER}/${MODEL_ID}`);

  const probeTool = defineTool({
    name: TOOL,
    label: "B3 fence probe",
    description: "B3 回归探针：记录收到的参数",
    parameters: Type.Object({ path: Type.String(), n: Type.Number() }),
    execute: async (_id: string, params: { path: string; n: number }) => {
      executed.push(params);
      return { content: [{ type: "text" as const, text: "fence-probe-ok" }], details: {} };
    },
  });

  const loader = await createIsolatedLoader(tmpDir);
  const { session } = await createAgentSession({
    cwd: tmpDir,
    model: model!,
    thinkingLevel: "off",
    modelRuntime: runtime,
    tools: [TOOL],
    customTools: [probeTool],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(tmpDir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
  });
  const unsubscribe = session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      sessionText += ev.assistantMessageEvent.delta;
    }
    if (ev.type === "tool_execution_end") {
      const e = ev as unknown as { isError?: boolean; result?: { content?: Array<{ text?: string }> } };
      toolEnds.push({ isError: e.isError, text: (e.result?.content ?? []).map((c) => c.text ?? "").join("\n") });
    }
  });
  const timer = setTimeout(() => void session.abort(), 20_000);
  try {
    await session.prompt("调用 fence_probe");
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  const assistant = (session.messages as Array<{ role: string; content?: unknown }>).find((m) => m.role === "assistant");
  const call = (Array.isArray(assistant?.content) ? (assistant!.content as Array<Record<string, unknown>>) : []).find(
    (c) => c.type === "toolCall",
  );
  session.dispose();

  assert(requests.length >= 1, `端点收到出站请求（${requests.length} 条）`);
  assert(call?.name === TOOL, `首轮 assistant 产出 toolCall=${String(call?.name)}`);
  assert(
    eqJson(call?.arguments, WANT_ARGS),
    `★核心：pi 流式解析后的 toolCall.arguments=${JSON.stringify(call?.arguments)}（期望 ${JSON.stringify(WANT_ARGS)}；B3 缺失时为 {}）`,
  );
  assert(executed.length === 1, `★核心：工具 execute 被调用 1 次（实际 ${executed.length}；B3 缺失时参数校验失败、不执行）`);
  assert(eqJson(executed[0], WANT_ARGS), `工具收到的参数=${JSON.stringify(executed[0])}`);
  assert(
    toolEnds.length === 1 && toolEnds[0]!.isError === false && toolEnds[0]!.text === "fence-probe-ok",
    `tool_execution_end isError=false 且结果为处理器正文（实际 ${JSON.stringify(toolEnds)}）`,
  );
  assert(requests.length === 2 && sessionText.includes("b3-probe-done"), `工具结果回送后第二轮正常收尾（请求 ${requests.length} 条，正文 ${JSON.stringify(sessionText)}）`);
} catch (err) {
  assert(false, `端到端用例抛异常：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(`\n[b3-fence-test] 通过 ${passed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
