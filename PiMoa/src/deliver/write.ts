/**
 * 确定性落盘交付 —— 受限原子写 + 回读校验（DESIGN §6 / Hermes §5）。
 *
 * 铁律：正文由**我们的代码**写盘，绝不交给 LLM 自己写文件。步骤（fail-closed，任一不符即 throw）：
 *   1) doneMarker 格式校验（`DONE_[A-Z0-9_]+`）。
 *   2) 路径 jail：realpath 解析目标父目录，必须落在 allowedRoots 之一下
 *      （`abs === root || abs.startsWith(root + sep)`，复用 pi-mcp resolveWorkspace 模式），
 *      拒绝 symlink 逃逸 / 目录穿越。
 *   3) 正文末尾非空行必须 === doneMarker（写前先卡，别写坏文件）。
 *   4) 原子写：同目录临时文件 → fsync → rename（原子替换）。
 *   5) 回读：读回文件，核对 sha256(读回) === sha256(body) 且末非空行 === doneMarker。
 * 全过才算 written；任一步失败 throw，并清理未 rename 的临时文件。
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** doneMarker 合法格式（对齐 Hermes 交付契约）。 */
export const DONE_MARKER_RE = /^DONE_[A-Z0-9_]+$/;

export interface AtomicWriteParams {
  /** 交付目标路径（文件）。父目录必须在 allowedRoots 之下。 */
  path: string;
  /** 交付正文（由聚合器产出、我们的代码写盘）。 */
  body: string;
  /** 完成标记；正文最后一非空行必须等于它；格式 DONE_[A-Z0-9_]+。 */
  doneMarker: string;
  /** 允许写入的根目录列表（路径 jail 白名单）。 */
  allowedRoots: string[];
}

export interface AtomicWriteResult {
  written: true;
  sha256: string;
  /** 实际写入的规范化绝对路径（父目录经 realpath 解析后）。 */
  path: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** realpath 解析；解析不了（不存在）则退回 resolve 绝对路径。 */
function realpathOrSelf(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** 正文最后一个非空行（trim 后）；全空则 null。 */
export function lastNonEmptyLine(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * 回读校验（安全核心，纯函数、可单测）：核对磁盘读回内容与期望一致。
 * 判据：sha256(diskContent) === expectedSha 且末非空行 === doneMarker。任一不符 throw。
 * 单独导出，便于直接对「篡改内容」做负例测试（无需触发真实磁盘损坏）。
 */
export function verifyReadback(
  diskContent: string,
  expectedSha: string,
  doneMarker: string,
): void {
  const backSha = sha256(diskContent);
  if (backSha !== expectedSha) {
    throw new Error(
      `回读 sha256 不符：期望 ${expectedSha.slice(0, 12)}… 实读 ${backSha.slice(0, 12)}…`,
    );
  }
  const backLast = lastNonEmptyLine(diskContent);
  if (backLast !== doneMarker) {
    throw new Error(`回读末非空行 "${backLast ?? "<空>"}" ≠ doneMarker "${doneMarker}"`);
  }
}

/**
 * 路径 jail：解析目标父目录的 realpath，要求落在某个 allowedRoot 之下。
 * 父目录必须已存在（realpath 才有意义）——不存在即视为越界拒绝。
 * 返回规范化后的目标绝对路径 join(realParent, basename)。
 */
function resolveJailedTarget(path: string, allowedRoots: string[]): string {
  if (allowedRoots.length === 0) {
    throw new Error("路径 jail：allowedRoots 为空，拒绝一切写入");
  }
  const abs = resolve(path);
  const name = basename(abs);
  if (name.length === 0 || name === "." || name === "..") {
    throw new Error(`路径 jail：非法目标文件名 "${name}"（path=${path}）`);
  }
  const parent = dirname(abs);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new Error(`路径 jail：父目录不存在或不可解析：${parent}`);
  }
  const roots = allowedRoots.map(realpathOrSelf);
  const allowed = roots.some(
    (root) => realParent === root || realParent.startsWith(root + sep),
  );
  if (!allowed) {
    throw new Error(
      `路径 jail：父目录 ${realParent} 不在允许根下：[${roots.join(", ")}]`,
    );
  }
  return join(realParent, name);
}

/**
 * 确定性交付写盘 + 回读校验。成功返回 { written:true, sha256, path }；任一步失败 throw。
 */
export function atomicWriteWithVerify(params: AtomicWriteParams): AtomicWriteResult {
  const { path, body, doneMarker, allowedRoots } = params;

  // 1) doneMarker 格式。
  if (!DONE_MARKER_RE.test(doneMarker)) {
    throw new Error(`doneMarker 格式非法："${doneMarker}"（须匹配 DONE_[A-Z0-9_]+）`);
  }

  // 2) 路径 jail（拒 symlink 逃逸 / 目录穿越）。
  const target = resolveJailedTarget(path, allowedRoots);

  // 3) 正文末非空行 === doneMarker（写前卡，别落坏文件）。
  const bodyLast = lastNonEmptyLine(body);
  if (bodyLast !== doneMarker) {
    throw new Error(
      `正文最后一非空行 "${bodyLast ?? "<空>"}" ≠ doneMarker "${doneMarker}"`,
    );
  }

  const expectedSha = sha256(body);

  // 4) 原子写：同目录临时文件 → fsync → rename。
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );
  let pendingTmp: string | undefined = tmp;
  try {
    // wx：独占创建，绝不覆盖已有临时文件。
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, body, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 原子替换目标（rename 覆盖目标符号链接本身，不跟随，无逃逸）。
    renameSync(tmp, target);
    pendingTmp = undefined; // 已 rename，临时文件不复存在。

    // 5) 回读校验：sha256 + 末非空行（纯函数，任一不符 throw）。
    const back = readFileSync(target, "utf8");
    verifyReadback(back, expectedSha, doneMarker);

    return { written: true, sha256: expectedSha, path: target };
  } finally {
    // 仅清理「未 rename」的临时文件（回读失败时 target 已是新文件，不在此删）。
    if (pendingTmp !== undefined) {
      try {
        unlinkSync(pendingTmp);
      } catch {
        /* 临时文件可能未创建成功；忽略 */
      }
    }
  }
}
