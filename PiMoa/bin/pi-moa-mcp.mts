#!/usr/bin/env -S npx tsx
/**
 * PiMoa MCP 启动器。目的:host 配置文件里零密钥明文。
 * key 注入顺序(2026-08-30 徐总定):进程 env > PiMoa 自有 config/keys.local.yaml >
 * ~/.hermes/config.yaml(遗留兜底——Hermes 已于 2026-08-20 退役,命中即打告警)。
 * 纸面归档真源:~/Documents/Key/Key 服务和 por iMac Hermes.md §M。
 * CLIPROXY 用 dummy(本地代理接受任意值)。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const KEY_NAMES = ["MINIMAX_API_KEY", "XIAOMI_API_KEY", "DEEPSEEK_API_KEY"] as const;
const missingKeys = () => KEY_NAMES.filter((k) => !process.env[k]);

process.env.CLIPROXY_API_KEY ||= "dummy";
if (missingKeys().length > 0) {
  // ① PiMoa 自有配置源(chmod 600,已入 .gitignore 绝不进 git)
  const ownKeysPath = fileURLToPath(new URL("../config/keys.local.yaml", import.meta.url));
  try {
    const own = parse(readFileSync(ownKeysPath, "utf8"));
    for (const k of KEY_NAMES) {
      if (!process.env[k] && own?.[k]) process.env[k] = String(own[k]);
    }
  } catch (e) {
    console.error("[pi-moa launcher] 无法读取自有配置源 config/keys.local.yaml:", (e as Error).message);
  }
}
if (missingKeys().length > 0) {
  // ② 遗留兜底:正常情况下不该走到这里(自有配置源应齐全)
  console.error(`[pi-moa launcher] ⚠️ 自有配置源缺 ${missingKeys().join(",")}，回退读已退役的 ~/.hermes/config.yaml——请把缺的 key 补进 config/keys.local.yaml`);
  try {
    const cfg = parse(readFileSync(join(homedir(), ".hermes/config.yaml"), "utf8"));
    const walk = (o: any) => {
      if (o && typeof o === "object") {
        if (o.api_key) {
          const id = `${o.provider || ""}${o.model || ""}${o.base_url || ""}`.toLowerCase();
          if (/minimax/.test(id) && !process.env.MINIMAX_API_KEY) process.env.MINIMAX_API_KEY = String(o.api_key);
          if (/(xiaomi|mimo)/.test(id) && !process.env.XIAOMI_API_KEY) process.env.XIAOMI_API_KEY = String(o.api_key);
          if (/deepseek/.test(id) && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = String(o.api_key);
        }
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(cfg);
  } catch (e) {
    console.error("[pi-moa launcher] 无法从 ~/.hermes/config.yaml 读取 key:", (e as Error).message);
  }
}
// ---- stderr 落盘(2026-09-06 徐总定):手动在终端起服务时 stderr 只打在 tty 上,一关终端/重启就没了 ----
// 统一启动器 start-papergo-deps.sh 走 nohup >log 2>&1(stderr 非 TTY → 此处不重复写);只有 stderr 是 TTY 时
// 才把每一行**同时**追加到 PIMOA_LOG_FILE(缺省 ~/.codex/logs/pi-moa-http.log,与启动器同一个文件),
// >64MB 先轮转为 .old(与启动器同口径)。PIMOA_LOG_TEE=0 关闭。
if (process.stderr.isTTY && process.env.PIMOA_LOG_TEE !== "0") {
  const { appendFileSync, renameSync, statSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const logFile = process.env.PIMOA_LOG_FILE ?? join(homedir(), ".codex/logs/pi-moa-http.log");
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    try {
      if (statSync(logFile).size > 64 * 1024 * 1024) renameSync(logFile, `${logFile}.old`);
    } catch {
      /* 文件尚不存在 */
    }
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      try {
        appendFileSync(logFile, chunk);
      } catch {
        /* 落盘失败不影响 tty 输出 */
      }
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    console.error(`[pi-moa launcher] stderr 是 TTY,已同时追加到 ${logFile}(PIMOA_LOG_TEE=0 关闭)`);
  } catch (e) {
    console.error("[pi-moa launcher] stderr 落盘初始化失败(仅 tty 输出):", (e as Error).message);
  }
}

// 启动 server(其 top-level 读 process.env + config/*，__dirname 自解析,与 cwd 无关)
// ★必须先于 server：把 **pi 自己那份** typebox 实例的校验文案切成 zh_Hans（locale 是实例级状态，
//   设 PiMoa 根 node_modules/typebox 那份无效）。此处是服务启动路径的最早一点，早于任何
//   createAgentSession 与任何一次工具入参校验。零枚举（只用官方 locale），fail-open（失败只 WARN）。
//   这里的 catch 兜的是**模块求值失败**（文件缺失/语法错/加载被拒）：typebox-locale.ts 自带的
//   fail-open 只在函数体内，覆盖不到求值阶段，而中文化是纯装饰性功能，绝不能阻断服务启动。
try {
  const { installTypeboxZhHansLocale } = await import(
    new URL("../src/mcp/typebox-locale.ts", import.meta.url).href
  );
  await installTypeboxZhHansLocale();
} catch (e) {
  console.error(
    `[pi-moa launcher] ⚠️ typebox zh_Hans locale 初始化失败，校验拒绝文案保持英文（不影响启动）：${(e as Error).message}`,
  );
}

// ── 本地补丁批启动守卫（fail-closed）：dist 非补丁态 / pi-ai 版本不符 / 补丁批不符 一律拒启 ──────
// v3（2026-10-01，pi-ai 0.99.2）：除「每项 ok + exit 0」外，再要求输出确属 verify、补丁批 = EXPECTED_SET、
//   含 "@version":"ok"（载体版本闸）且至少 1 个补丁件 ⇒ 载体输出缺项/空 result/换批都不能被当成通过。
import { spawnSync } from "node:child_process";
{
  const EXPECTED_SET = "pi-ai-0.99.2";
  const r = spawnSync(process.execPath,
    // fileURLToPath 而非 .pathname：仓路径含空格（Claude dev paper system），.pathname 得 %20 ⇒ 子进程找不到脚本、必然拒启
    [fileURLToPath(new URL("./apply-pi-patches.mjs", import.meta.url)), "verify", "--expect", "patched"],
    { encoding: "utf8" });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  let j: { cmd?: string; set?: string; result?: Record<string, string> };
  try { j = JSON.parse(last); } catch {
    throw new Error(`[pi-patch] verify 输出不可解析 status=${r.status}: ${(r.stdout ?? "").slice(0, 200)}｜${(r.stderr ?? "").slice(0, 200)}`);
  }
  const entries = Object.entries(j.result ?? {});
  const bad = entries.filter(([, v]) => v !== "ok");
  const fileCount = entries.filter(([k]) => k !== "@version").length;
  if (r.status !== 0 || bad.length || j.cmd !== "verify" || j.set !== EXPECTED_SET ||
      j.result?.["@version"] !== "ok" || fileCount < 1) {
    throw new Error(`[pi-patch] verify 失败 status=${r.status} set=${String(j.set)}（期望 ${EXPECTED_SET}） files=${fileCount}: ${JSON.stringify(bad)}`);
  }
}

await import(new URL("../src/mcp/server.ts", import.meta.url).href);
