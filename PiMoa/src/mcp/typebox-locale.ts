/**
 * pi 侧 typebox 校验拒绝文案中文化（走官方 locale，零枚举）。
 *
 * 【为什么必须命中 pi 自己那份实例】locale 是 typebox 的**实例级**模块状态
 *   （`typebox/build/system/locale/_config.mjs` 里一个模块级 `let locale`），而校验发生在
 *   pi-ai 的 `validateToolArguments` 里（`pi-agent-core/dist/agent-loop.js` 每次工具调用都调它）：
 *   它 `import { Compile } from "typebox/compile"`、`import { Value } from "typebox/value"`，
 *   按 Node 解析规则落到 **pi 自己的 `node_modules/typebox`（pi 0.99.2 下为 v1.3.27；0.84.1 时为 v1.3.7）**。PiMoa 根
 *   `node_modules/typebox` 是另一份实例（v1.1.38），设它不生效。因此这里按 Node 解析算法
 *   **从 pi 包根出发**解析 `typebox/system`，不写死版本与路径（随升级自动跟随）。
 *
 * 【时机】本函数由 `bin/pi-moa-mcp.mts` 在 import server 之前调用一次 —— 早于任何
 *   `createAgentSession`、也早于任何一次工具入参校验。
 *
 * 【边界】① 只调 `Locale.Set`，不自建英文→中文映射表、不解析英文报错；② 不改任何 schema 语义；
 *   ③ 不动 `state.attempts += 1`；④ fail-open：定位不到 pi 侧实例只打 WARN、保持英文，不抛、不阻断启动；
 *   ⑤ 自带启动自检（编译一个必然失败的 schema，断言拿到中文，否则 WARN），把「静默英文」变成「响亮降级」；
 *   ⑥ 只此一处初始化，不进请求路径、不引入跨函数可变状态。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "[pi-moa typebox-locale]";

/** 校验实际使用的那份 typebox 挂在 pi 的依赖树里，从 pi 包出发解析。 */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** typebox locale：把一条校验错误翻成目标语言的纯函数。 */
type LocaleFn = (error: unknown) => string;
interface LocaleApi {
  Set?: (locale: LocaleFn) => void;
  zh_Hans?: LocaleFn;
}
interface Validator {
  Errors: (value: unknown) => Array<{ message?: string }>;
}
type CompileFn = (schema: unknown) => Validator;

/** 从入口文件向上找到 pi 的包根（第一个含 package.json 的目录）。 */
function packageRootOf(entryPath: string): string {
  let dir = dirname(entryPath);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`向上未找到 package.json：${entryPath}`);
    dir = parent;
  }
}

/** 必然失败的探针 schema（minLength 命中 zh_Hans 词条「不得少于 N 个字符」）。 */
const PROBE_SCHEMA = {
  type: "object",
  properties: { probe: { type: "string", minLength: 1 } },
  required: ["probe"],
} as const;

/**
 * 把 pi 校验实际使用的那份 typebox 的 locale 设为 zh_Hans。
 * 任何一步失败都只打 WARN 并返回（保持英文），绝不抛、绝不阻断启动。
 */
export async function installTypeboxZhHansLocale(): Promise<void> {
  let Locale: LocaleApi;
  let Compile: CompileFn;
  try {
    const piRoot = packageRootOf(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
    const requireFromPi = createRequire(join(piRoot, "package.json"));
    const systemUrl = pathToFileURL(requireFromPi.resolve("typebox/system")).href;
    const compileUrl = pathToFileURL(requireFromPi.resolve("typebox/compile")).href;
    const system = (await import(systemUrl)) as { Locale?: LocaleApi };
    const compile = (await import(compileUrl)) as { Compile?: CompileFn };
    Locale = system.Locale as LocaleApi;
    Compile = compile.Compile as CompileFn;
  } catch (err) {
    console.error(
      `${TAG} ⚠️ 定位 pi 侧 typebox 失败，校验拒绝文案保持英文（不影响启动）：${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (typeof Locale?.Set !== "function" || typeof Locale?.zh_Hans !== "function") {
    console.error(`${TAG} ⚠️ pi 侧 typebox 未导出 Locale.Set / Locale.zh_Hans，校验拒绝文案保持英文（不影响启动）`);
    return;
  }

  try {
    Locale.Set(Locale.zh_Hans);
    // 启动自检：用与 pi-ai 同一条链路（Compile(...).Errors(...)）取一条必然失败的文案，断言已是中文。
    const message = Compile(PROBE_SCHEMA).Errors({ probe: "" })[0]?.message ?? "";
    if (!/[\u4e00-\u9fff]/.test(message)) {
      console.error(`${TAG} ⚠️ 启动自检未过：设了 zh_Hans 但文案仍是英文「${message}」，校验拒绝文案保持原样`);
      return;
    }
    console.error(`${TAG} ✅ pi 侧 typebox 校验文案已切到 zh_Hans（自检：${message}）`);
  } catch (err) {
    console.error(
      `${TAG} ⚠️ 设 locale / 启动自检失败，校验拒绝文案保持原样（不影响启动）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
