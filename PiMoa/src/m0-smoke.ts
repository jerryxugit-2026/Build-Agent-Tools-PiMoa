/**
 * M0 smoke: 证明 pi SDK 能在本机用本地 CLIProxy 模型（gpt-5.5）跑并产出流式 token。
 * 不实现 MoA，只做单会话 stream 验证。
 *
 * 运行：
 *   CLIPROXY_API_KEY=dummy npx tsx src/m0-smoke.ts
 * （CLIProxy 目前接受任意 key；api_key 走 env，不落明文。）
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const PROVIDER = process.env.M0_PROVIDER ?? "cliproxy";
const MODEL_ID = process.env.M0_MODEL ?? "gpt-5.5";
const PROMPT = process.env.M0_PROMPT ?? "用一句话解释万有引力";
const TIMEOUT_MS = Number(process.env.M0_TIMEOUT_MS ?? 120000);

function log(...args: unknown[]): void {
  console.log("[m0]", ...args);
}

async function main(): Promise<void> {
  if (!process.env.CLIPROXY_API_KEY) {
    // CLIProxy 接受 dummy；给个默认值，避免因缺 env 导致 401。真实密钥不落文件。
    process.env.CLIPROXY_API_KEY = "dummy";
    log("CLIPROXY_API_KEY 未设置，已用占位 'dummy'（CLIProxy 接受任意 key）");
  }

  // 1) 自定义模型运行时：指向项目内 config/models.json（含 cliproxy provider）。
  //    authPath 指向项目内（可不存在）；避免读用户 ~/.pi。
  const modelRuntime = await ModelRuntime.create({
    modelsPath: resolve(projectRoot, "config/models.json"),
    authPath: resolve(projectRoot, "config/auth.json"),
  });

  const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
  if (!model) {
    throw new Error(
      `模型未找到：${PROVIDER}/${MODEL_ID}（检查 config/models.json）`,
    );
  }
  log(
    `模型已解析: ${model.provider}/${model.id} api=${model.api} baseUrl=${
      (model as { baseUrl?: string }).baseUrl ?? "(provider 默认)"
    }`,
  );

  // 2) 隔离资源加载：空 agentDir，避免加载用户全局扩展/技能。
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: resolve(projectRoot, "config/agent-empty"),
  });
  await loader.reload();

  // 3) 建会话：M0 无工具、内存会话、关闭 compaction/retry 干扰。
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: projectRoot,
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: [],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(projectRoot),
    settingsManager,
  });
  if (modelFallbackMessage) log("modelFallbackMessage:", modelFallbackMessage);

  // 4) 订阅事件，打印 text_delta 流，统计 delta 数，捕获错误与 usage。
  let deltaCount = 0;
  let streamed = "";
  let sawError: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        deltaCount++;
        streamed += ame.delta;
        process.stdout.write(ame.delta);
      }
    }
    if (event.type === "agent_end") {
      process.stdout.write("\n");
    }
  });

  log(`发送 prompt: ${JSON.stringify(PROMPT)}`);
  process.stdout.write("--- 流式输出开始 ---\n");

  const timer = setTimeout(() => {
    log(`超时 ${TIMEOUT_MS}ms，abort`);
    void session.abort();
  }, TIMEOUT_MS);

  try {
    await session.prompt(PROMPT);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  // 5) 汇总：从会话历史取最后一条 assistant 消息的 usage 与错误。
  const messages = session.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant") as
    | { content?: unknown; usage?: unknown; stopReason?: string; errorMessage?: string }
    | undefined;

  if (lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage) {
    sawError = lastAssistant?.errorMessage ?? "unknown error";
  }

  process.stdout.write("--- 流式输出结束 ---\n");
  log(`text_delta 数量: ${deltaCount}`);
  log(`聚合正文长度: ${streamed.length}`);
  log(`usage: ${JSON.stringify(lastAssistant?.usage ?? null)}`);

  session.dispose();

  if (sawError) {
    log(`❌ 会话报错: ${sawError}`);
    process.exitCode = 1;
    return;
  }
  if (deltaCount === 0 || streamed.trim().length === 0) {
    log("❌ 未收到任何 text_delta 或正文为空 —— 未出流");
    process.exitCode = 1;
    return;
  }
  log("✅ M0 通过：pi SDK 用本地 CLIProxy 模型产出了流式 token + 最终答案");
}

main().catch((err) => {
  console.error("[m0] 未捕获错误:", err);
  process.exitCode = 1;
});
