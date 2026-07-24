#!/usr/bin/env -S npx tsx
/**
 * PiMoa MCP 启动器。目的:host 配置文件里零密钥明文。
 * spawn 时从 ~/.hermes/config.yaml 读 minimax/xiaomi key 注入 env,再启动 MCP server。
 * 若 env 已有对应 key 则优先用 env(不覆盖)。CLIPROXY 用 dummy(本地代理接受任意值)。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

process.env.CLIPROXY_API_KEY ||= "dummy";
if (!process.env.MINIMAX_API_KEY || !process.env.XIAOMI_API_KEY) {
  try {
    const cfg = parse(readFileSync(join(homedir(), ".hermes/config.yaml"), "utf8"));
    const walk = (o: any) => {
      if (o && typeof o === "object") {
        if (o.api_key) {
          const id = `${o.provider || ""}${o.model || ""}${o.base_url || ""}`.toLowerCase();
          if (/minimax/.test(id) && !process.env.MINIMAX_API_KEY) process.env.MINIMAX_API_KEY = String(o.api_key);
          if (/(xiaomi|mimo)/.test(id) && !process.env.XIAOMI_API_KEY) process.env.XIAOMI_API_KEY = String(o.api_key);
        }
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(cfg);
  } catch (e) {
    console.error("[pi-moa launcher] 无法从 ~/.hermes/config.yaml 读取 key:", (e as Error).message);
  }
}
// 启动 server(其 top-level 读 process.env + config/*，__dirname 自解析,与 cwd 无关)
await import(new URL("../src/mcp/server.ts", import.meta.url).href);
