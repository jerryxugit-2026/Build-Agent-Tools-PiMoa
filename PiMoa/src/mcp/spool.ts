/**
 * spool 审计落盘(v4 §7):proposer/聚合全文的"新家"——回包只留摘录+指针+sha,
 * 全文进本模块管理的目录,增长有界、并行(多进程/多程序)无冲突。
 *
 * 铁律:
 *   - 目录只来自 env(PIMOA_SPOOL_DIR)或缺省 ~/.pimoa/spool,**绝不接受调用方路径**;
 *     文件名不含任何调用方字符串(preset 是自由入参,入名即注入面——只进文件内容)。
 *   - 写入 fail-open:spool 失败绝不毙回包,调用方拿到 error 字符串自行标注。
 *   - 清理并发安全:O_EXCL 锁,拿不到就跳过;锁龄 >10 分钟按 rename 原语强夺(消 TOCTOU)。
 *   - 双上限(14 天 / 512MB)+ <60 分钟在途豁免 + 总量超 2× 硬熔断(无视豁免删最旧)。
 *
 * env(P2 将迁入 src/config/limits.ts 统一解析;本模块每次调用时读取,便于测试注入):
 *   PIMOA_SPOOL_DIR / PIMOA_SPOOL_MAX_AGE_DAYS / PIMOA_SPOOL_MAX_BYTES
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteRaw, sha256Text } from "../deliver/write.js";
import type { MoaResult, ProposalTrace } from "../moa/types.js";

/** 单文件硬顶(超出头尾截+标注)。 */
export const SPOOL_FILE_CAP_BYTES = 5 * 1024 * 1024;
/** 在途豁免窗口:比它年轻的文件常规清理不删。 */
const EXEMPT_MS = 60 * 60 * 1000;
/** 清理锁判死年龄。 */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** 同进程清理节流(写前惰性触发,最多每 30s 一次)。 */
const CLEANUP_THROTTLE_MS = 30 * 1000;

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function spoolDir(): string {
  return process.env.PIMOA_SPOOL_DIR ?? join(homedir(), ".pimoa", "spool");
}
export function spoolMaxAgeMs(): number {
  return envInt("PIMOA_SPOOL_MAX_AGE_DAYS", 14) * 24 * 60 * 60 * 1000;
}
export function spoolMaxBytes(): number {
  return envInt("PIMOA_SPOOL_MAX_BYTES", 512 * 1024 * 1024);
}

export interface SpoolAudit {
  path: string;
  bytes: number;
  sha256: string;
  retainUntil: string;
}

/** UTC 紧凑时间戳(文件名用,字典序=时间序)。 */
function utcStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function rand(n: number): string {
  let s = "";
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}

/**
 * 组装 spool 文件正文:receipt JSON + 聚合全文(可选)+ 各 proposer 全文。
 * 波三 b 修复单第 5 条导出（此前模块内私有）：供 test/spool.test.ts 直接单测三节
 * （`## findings` / `## jevcheck` / `## verdicts`）的存在性、顺序与内容，不必绕经
 * `writeSpool` 的真实落盘路径（省去每条用例都要收拾临时文件）。
 */
export function buildSpoolBody(r: MoaResult, includeAggregated: boolean): string {
  const parts: string[] = [];
  parts.push("## receipt\n");
  parts.push("```json");
  try {
    parts.push(JSON.stringify({ ...r.receipt, audit: undefined }, null, 1));
  } catch {
    parts.push("{}");
  }
  parts.push("```\n");
  if (r.error) parts.push(`## error\n\nstage=${r.error.stage} reason=${r.error.reason}\n`);
  if (includeAggregated && r.aggregated.trim().length > 0) {
    parts.push("## aggregated(全文,与 receipt.bodySha256 对账)\n");
    parts.push(r.aggregated);
    parts.push("");
  }
  // ── Jev 辅助代码审查（设计 v4 §3.7，2026-09-20，第三波 b）：只在有数据时输出对应节 ──
  if (r.receipt.findings && r.receipt.findings.length > 0) {
    parts.push("## findings\n");
    parts.push("```json");
    try {
      parts.push(JSON.stringify(r.receipt.findings, null, 1));
    } catch {
      parts.push("[]");
    }
    parts.push("```\n");
  }
  // 各 proposer 的 submit_findings REJECT 原文：灰度期定位「为什么交不出合格清单」的唯一落盘处。
  if (r.structuredRejectsFull && Object.keys(r.structuredRejectsFull).length > 0) {
    parts.push("## structured rejects\n");
    for (const [key, texts] of Object.entries(r.structuredRejectsFull)) {
      texts.forEach((t, i) => {
        parts.push(`----- ${key} 第 ${i + 1} 次记录（REJECT / PARTIAL）-----`);
        parts.push(t);
        parts.push("");
      });
    }
  }
  // receipt 头部 JSON 里的 jevcheck 已去 calls/tableText（裁决 C11）；spool 用 MoaResult.jevcheckFull
  // （含 calls 与 tableText 的完整报告）——两处不重复:receipt 精简版只进头部,本节是唯一带 calls 的落盘处。
  if (r.jevcheckFull) {
    parts.push("## jevcheck\n");
    if (r.jevcheckFull.tableText.trim().length > 0) {
      parts.push(r.jevcheckFull.tableText);
      parts.push("");
    }
    parts.push("```json");
    try {
      parts.push(JSON.stringify(r.jevcheckFull, null, 1));
    } catch {
      parts.push("{}");
    }
    parts.push("```\n");
  }
  if (r.receipt.verdicts) {
    parts.push("## verdicts\n");
    parts.push("```json");
    try {
      parts.push(JSON.stringify(r.receipt.verdicts, null, 1));
    } catch {
      parts.push("{}");
    }
    parts.push("```\n");
  }
  for (const p of r.proposals) {
    if (p.text.trim().length === 0) continue;
    const mark = p.ok ? "completed" : p.timeout ? "timeout" : p.error ? "error" : "aborted/partial";
    // ★段头字符串不改(既有解析脚本以它为锚);§4.1 取证账在段头之后**另起一行** `[trace] k=v …`。
    parts.push(`\n----- proposer ${p.model} (${mark}) -----\n`);
    if (p.trace) parts.push(traceLine(p.trace) + (p.stopReason ? ` stop=${p.stopReason}` : ""));
    parts.push(p.text);
  }
  return parts.join("\n");
}

/**
 * proposer 取证账行(提速方案 §4.1)。固定键序、空格分隔 k=v,便于 awk/rg 直接切;
 * 缺省口径与 types.ts SessionTrace 一致:exhaustedBy 结算后未耗尽=null、lastRejectedBy 从未被拒=null、retries 无法计数=null、usage 缺失=null。
 * 聚合器的 trace 已随 receipt JSON 落在文件头部,不另加行。
 */
export function traceLine(t: ProposalTrace): string {
  const v = (x: number | string | null | undefined): string => (x === null || x === undefined ? "null" : String(x));
  return (
    `[trace] durationMs=${v(t.durationMs)} input=${v(t.input)} output=${v(t.output)} cacheRead=${v(t.cacheRead)}` +
    ` calls=${v(t.calls)} usedChars=${v(t.usedChars)} reservedChars=${v(t.reservedChars)}` +
    ` exhaustedBy=${v(t.exhaustedBy)} rejections=${v(t.rejections)} lastRejectedBy=${v(t.lastRejectedBy)}` +
    ` retries=${v(t.retries)} maxCalls=${v(t.maxCalls)} maxChars=${v(t.maxChars)}`
  );
}

/**
 * 落一份审计文件。fail-open:任何异常折成 { error } 返回,绝不 throw。
 * 文件名:<UTC>-<tool>-<pid>-<rand6>-<sha12|rand12>.md(无任何调用方字符串)。
 */
export function writeSpool(params: {
  tool: string;
  result: MoaResult;
  includeAggregated: boolean;
}): { audit?: SpoolAudit; error?: string } {
  const { tool, result, includeAggregated } = params;
  const hasText =
    (includeAggregated && result.aggregated.trim().length > 0) ||
    result.proposals.some((p) => p.text.trim().length > 0);
  if (!hasText) return {}; // 无正文(如 config 阶段失败)不落空文件
  try {
    const dir = spoolDir();
    mkdirSync(dir, { recursive: true });
    maybeCleanup();
    let body = buildSpoolBody(result, includeAggregated);
    if (Buffer.byteLength(body, "utf8") > SPOOL_FILE_CAP_BYTES) {
      // 单文件硬顶:头 60% 尾 20%(字符近似),中间显式标注。
      const capChars = Math.floor(SPOOL_FILE_CAP_BYTES / 3); // utf8 最坏 3 字节/字符,保守
      const head = body.slice(0, Math.floor(capChars * 0.75));
      const tail = body.slice(-Math.floor(capChars * 0.25));
      body =
        `${head}\n\n…… [spool 单文件超 ${SPOOL_FILE_CAP_BYTES} 字节硬顶,中段已截,原文 ${body.length} 字符] ……\n\n${tail}`;
    }
    const shaPart =
      result.receipt.bodySha256 && result.receipt.bodySha256.length >= 12
        ? result.receipt.bodySha256.slice(0, 12)
        : rand(12); // 失败路径 bodySha256 为空串时回退(v4 审查 C4)
    const name = `${utcStamp()}-${tool}-${process.pid}-${rand(6)}-${shaPart}.md`;
    const target = join(dir, name);
    atomicWriteRaw(target, body);
    return {
      audit: {
        path: target,
        bytes: Buffer.byteLength(body, "utf8"),
        sha256: sha256Text(body),
        retainUntil: new Date(Date.now() + spoolMaxAgeMs()).toISOString(),
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let lastCleanupAt = 0;
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) return;
  lastCleanupAt = now;
  try {
    cleanupSpool();
  } catch {
    /* 清理绝不影响主流程 */
  }
}

const LOCK_NAME = ".cleanup.lock";

/** 尝试拿清理锁。true=拿到(用后须 unlink);false=别处在清,跳过。 */
function acquireLock(dir: string): boolean {
  const lock = join(dir, LOCK_NAME);
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid} ${Date.now()} ${rand(8)}`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (tryCreate()) return true;
  // 锁已存在:判死(>10 分钟)。强夺用 rename 原语——rename 成功者独占清理权,消 TOCTOU 双删竞态。
  try {
    const st = statSync(lock);
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
    const stolen = join(dir, `${LOCK_NAME}.steal-${process.pid}-${rand(6)}`);
    renameSync(lock, stolen); // 并发强夺时只有一个 rename 成功,其余 ENOENT 落 catch
    try {
      unlinkSync(stolen);
    } catch {
      /* 忽略 */
    }
    return tryCreate();
  } catch {
    // P2 审查 backlog F13:rename 竞态里锁可能刚被正主 finally 释放——再试一次创建,仍失败才让路。
    return tryCreate();
  }
}

/**
 * 清理:14 天龄 + 512MB 双上限(超额删最旧,<60 分钟豁免)+ 2× 硬熔断(无视豁免)。
 * 只处理本目录**顶层 .md**,不递归。返回删除数;拿不到锁返回 null(跳过,绝不阻塞)。
 */
export function cleanupSpool(now = Date.now()): { deleted: number } | null {
  const dir = spoolDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { deleted: 0 }; // 目录不存在等,无事可做
  }
  if (!acquireLock(dir)) return null;
  let deleted = 0;
  try {
    const files: { path: string; mtimeMs: number; size: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 竞态下文件可能已消失 */
      }
    }
    const maxAge = spoolMaxAgeMs();
    const maxBytes = spoolMaxBytes();
    // 1) 过龄删除。
    for (const f of [...files]) {
      if (now - f.mtimeMs > maxAge) {
        try {
          unlinkSync(f.path);
          deleted++;
          files.splice(files.indexOf(f), 1);
        } catch {
          /* 忽略 */
        }
      }
    }
    // 2) 容量:删最旧,豁免 <60 分钟;总量超 2× 时硬熔断(无视豁免)。
    const total = (): number => files.reduce((s, f) => s + f.size, 0);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // 旧在前
    let fuse = total() > maxBytes * 2;
    while (total() > maxBytes && files.length > 0) {
      const idx = fuse ? 0 : files.findIndex((f) => now - f.mtimeMs > EXEMPT_MS);
      if (idx === -1) {
        if (total() > maxBytes * 2) {
          fuse = true; // 全是新文件仍超 2× → 熔断
          continue;
        }
        break; // 超 1× 但全在豁免窗口:容忍(硬熔断线未破)
      }
      const [victim] = files.splice(idx, 1);
      try {
        unlinkSync(victim.path);
        deleted++;
      } catch {
        /* 忽略 */
      }
    }
  } finally {
    try {
      unlinkSync(join(dir, LOCK_NAME));
    } catch {
      /* 忽略 */
    }
  }
  return { deleted };
}

/** 启动健康检查:spool 卷剩余空间 <1GB 时返回告警文案(调用方打日志),否则 null。 */
export function spoolHealthWarning(): string | null {
  try {
    const dir = spoolDir();
    mkdirSync(dir, { recursive: true });
    const st = statfsSync(dir);
    const free = Number(st.bsize) * Number(st.bavail);
    if (free < 1024 * 1024 * 1024) {
      return `spool 卷剩余空间仅 ${(free / 1024 / 1024).toFixed(0)}MB(<1GB):spool 写失败将触发回包内联回退,请尽快清理磁盘`;
    }
    return null;
  } catch {
    return null; // 健康检查绝不影响启动
  }
}
