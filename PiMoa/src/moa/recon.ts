/**
 * 侦查前置（recon）—— 把"任务边界"在**进模型之前**画好（徐总 2026-07-25）。
 *
 * ## 解决什么
 * Claude Code / Codex 里调用自家子代理不出问题，而外部 MoA 反复撑爆上下文，最根本的差异**不是模型**，
 * 而是**谁画任务边界**：
 *  · 内部子代理：主 agent 先 Grep/Glob 侦查 → 锁定几个文件 → 才派活，子代理拿到的是**边界已定**的任务；
 *  · 外部 MoA：调用方把"评审这个模块"**原样**转发 → proposer 从零开始自己找 → 只好扫全库 →
 *    多轮工具调用把完整历史反复重发 → 上游长流断裂（`Stream ended without finish_reason`）→
 *    正文空 → 2/2 fail-closed。
 *
 * ## 本模块做什么（两层，都在服务端、不花模型 token）
 *  · **层次二 `files`**：调用方给精确文件清单 → 服务端直接读入附进 context（最有效）。
 *  · **层次三 `reconQuery`**：调用方给检索词 → 服务端用 `rg` 机械检索（无模型参与）→
 *    把命中文件与行号摘要附进 context，等于把"主 agent 先侦查"这一步**内置化**。
 *
 * ★2026-09-04 提速方案 §4.5 两项升级（同样服务端机械执行、不花模型 token）：
 *  · **结构化行范围 `filesRanges`**：`[{path,start,end}]`，服务端切片后打**真实行号**附入——
 *    是「少附」不是「多附」（§4.10）：改 3 行的文件不必整份 120k 全喂三遍。不用 `path:a-b` 字符串
 *    后缀：它会在 jail 校验前被当作不存在的路径拒绝，且文件名本身可含冒号。
 *  · **`deps:"auto"` 依赖函数整体附入**（缺省关）：对被附 .go 文件抽出调用的未限定标识符，在其仓根
 *    rg 定位 `func Name(` 并把函数**整体**附入（src/moa/godeps.ts）；受 DEPS_MAX_CHARS 硬顶。
 *  · 预算改**逐块**校验：每次追加前查「已用 + 本块 ≤ RECON_MAX_CHARS」，超出整块降级为 note
 *    （旧实现只在加下一个文件前查 used，单文件可越界）；结果带 `usedChars` 供调用层判断。
 *  · ★§4.11 **`refs:"auto"` 文档引用自动附入**（缺省关；src/moa/docrefs.ts）：对被附 .md/.txt 文档扫正文
 *    里的路径引用——引用的文档整份附入、带行号的代码引用只附 ±20 行、无行号代码引用只进 note；不递归；
 *    受 REFS_MAX_CHARS / REFS_MAX_FILES 硬顶并计入 RECON 总账。文档 review 因此可走闭卷 moa_run。
 *    顺序：refs 在 files/files_ranges 之后、deps 之前；refs 附入的代码范围**不**触发 deps（防链式膨胀）。
 *
 * 两层都受约束：路径 jail（复用 bash_readonly 的越界/硬链接检测）+ 总量封顶（防侦查本身撑爆）。
 * 失败绝不抛：任何一项读失败/检索失败都降级成一条说明文字，不影响主流程（fail-open，因为
 * 侦查只是"帮忙缩小范围"，不该因它失败而毙掉整轮 MoA）。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { checkPathJail } from "../tools/bash_readonly.js";
import { collectGoDeps, findGoRoot, type GoDepSource } from "./godeps.js";
import { collectDocRefs, isScannableDoc, type DocRefSource } from "./docrefs.js";
import type { MaterialFile, MaterialKind } from "./types.js";

/**
 * 侦查产出的总字符上限（防"侦查本身"把上下文撑爆）。
 * ★2026-07-26 徐总定：180_000 → 360_000。
 * 依据：当前三跳模型 contextWindow 均 ≥1,000,000（deepseek-v4-flash / MiniMax-M3 1,000,000，
 * claude-opus-4-8 1,000,000），360k 字符（中文约 240k–360k token）仍留有充裕余量。
 * ⚠️2026-08-16 订正：claude-opus-4-8 原写 1,048,576 属虚高——实测服务端自述上限为
 * `1532311 tokens > 1000000 maximum`，真实值 1,000,000。models.json 已同步改正。
 * 本常数 360_000 字符不受影响（换算后远在任何窗口之内），无需调整。
 */
// v4 §4.3(P2):值收敛到 src/config/limits.ts 单一真源(与材料预算同一 env),此处 re-export 保兼容。
export { RECON_MAX_CHARS, PER_FILE_MAX_CHARS, RG_MAX_CHARS } from "../config/limits.js";
import { RECON_MAX_CHARS, PER_FILE_MAX_CHARS, RG_MAX_CHARS } from "../config/limits.js";
/**
 * 单个文件附入的字符上限（超出按整行截断并显式提示）。
 * ★2026-07-26 徐总定：60_000 → 120_000。
 * 起因：一份大型设计文档在第 902 行（§5.1a 表头处）被截断——60k 字符对本项目的
 * 架构/设计文档偏紧（中文 md 约 66 字符/行 ⇒ 60k 仅够约 900 行）。
 * ⚠️ 与总预算的关系：单文件 120k、总量 360k ⇒ **三个满额文件即顶满总预算**，
 * 第四个及以后会被 RECON_MAX_CHARS 拦下并在回执中提示（见下方 used >= 判断）。
 */
// (定义已迁 limits.ts;历史沿革见上方注释)
// RG_MAX_CHARS 定义已迁 limits.ts。
/** rg 执行超时。 */
const RG_TIMEOUT_MS = 15_000;

/** 结构化行范围（提速方案 §4.5 改动 A）：1 基、闭区间。 */
export interface FileRange {
  path: string;
  start: number;
  end: number;
}

export interface ReconInput {
  /** 精确文件清单（层次二）。 */
  files?: string[];
  /**
   * 结构化行范围（层次二之切片版）：只附 `path` 的第 start–end 行，打真实行号。
   * 同一路径可给多段；与 `files` 同一路径并存时两者都附（调用方自负重复）。
   */
  filesRanges?: FileRange[];
  /** 机械检索词（层次三）：交给 rg，不经模型。 */
  reconQuery?: string;
  /**
   * `"auto"`：对 files/filesRanges 里的 .go 附件自动附入其调用的依赖函数整体（godeps.ts）。
   * 缺省不启用。总量受 DEPS_MAX_CHARS 硬顶且计入 RECON_MAX_CHARS 总账。
   */
  deps?: "auto";
  /**
   * `"auto"`：对 files/filesRanges 里的 .md/.txt 附件扫描路径引用并把被引用材料附入（docrefs.ts）。
   * 缺省不启用。总量受 REFS_MAX_CHARS / REFS_MAX_FILES 硬顶且计入 RECON_MAX_CHARS 总账；不递归。
   */
  refs?: "auto";
  /** 审计根（路径 jail 与 rg 的根）。 */
  cwd: string;
  /**
   * ★额外只读根（2026-08-04 跨仓核查）：来自 moa.yaml 的 `access.readRoots`。
   * 只影响 `files` 的路径 jail —— 调用方因此可以在 files 里给**其它仓库的绝对路径**
   * （跨仓核查的主用法：cwd 停在 A 仓，files 里带上 B 仓的规格文档）。
   * rg 机械检索仍以 cwd 为根（检索面不隐式扩大，避免一条 recon_query 扫穿整个工作区）。
   */
  readRoots?: readonly string[];
}

export interface ReconResult {
  /** 拼好的上下文块（空串表示没有可附加内容）。 */
  text: string;
  /** 成功附入的文件数（files 整份 + filesRanges 每段各计 1）。 */
  filesIncluded: number;
  /** 逐项说明（含被拒/截断原因），便于回执与排查。 */
  notes: string[];
  /**
   * 最终 `text.length`（含引导语头部）。预算校验以正文块之和 ≤ RECON_MAX_CHARS 为准，
   * 头部约 600 字符不计入该账（历史口径），故 usedChars 可略大于 RECON_MAX_CHARS。
   */
  usedChars: number;
  /**
   * ★材料通路（Jev 辅助代码审查设计 v4 §3.1，2026-09-20）：本轮**真正附进 text** 的每一段材料的
   * 结构化副本（裸行、真实行号），五类：file / range / deps / refs / rg。只登记 tryPush 成功的块；
   * 被预算拦下的块不登记（与 text 严格一致）。text 本身一字不改。
   */
  files: MaterialFile[];
}

/**
 * ★给每行打上行号（`   12| code`）——**行号准确性的确定性保证**（徐总 2026-07-25）。
 *
 * 为什么必须做：此前 recon 喂的是**裸代码**，模型要报行号只能**自己数行**，而 LLM 数几百行必然漂移
 * （U2 实测：`renderProjectBrief` 真实在 688 行，模型报 553–571，偏 130 行；结论与论证链全对、
 * 唯独行号不可用）。打上行号后，模型是**照抄**而非**计数**，行号即与文件真值一一对应。
 * 靠提示词"要求引用片段而非行号"是祈祷；打行号是工程保证。
 *
 * 宽度对齐到文件总行数，保证列对齐、不干扰模型读代码。
 */
function withLineNumbers(body: string, startLine = 1): string {
  const lines = body.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, " ")}| ${l}`).join("\n");
}

/** jail + stat + 读全文；绝不抛。files 与 filesRanges 共用（同一道 jail、同一套拒绝理由）。 */
function loadFile(
  path: string,
  cwd: string,
  readRoots: readonly string[],
): { ok: true; abs: string; body: string } | { ok: false; note: string } {
  // 侦查读同样发生在 server 进程内（不过沙箱），jail 里的越界+密钥两项检查是唯一防线。
  const jail = checkPathJail(["read", path], cwd, { readRoots });
  if (jail) return { ok: false, note: `跳过 ${path}：${jail}` };
  const abs = resolve(cwd, path);
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      return { ok: false, note: `跳过 ${path}：是目录（请给具体文件，或改用 reconQuery 检索）` };
    }
    return { ok: true, abs, body: readFileSync(abs, "utf8") };
  } catch (err) {
    return { ok: false, note: `跳过 ${path}：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 按**整行**截断到 PER_FILE_MAX_CHARS（不截半行，保证行号与内容严格对齐）。返回截后正文与显示行数。 */
function clampWholeLines(body: string): { body: string; truncated: boolean; shownLines: number } {
  if (body.length <= PER_FILE_MAX_CHARS) return { body, truncated: false, shownLines: body.split("\n").length };
  let b = body.slice(0, PER_FILE_MAX_CHARS);
  const lastNl = b.lastIndexOf("\n");
  if (lastNl > 0) b = b.slice(0, lastNl);
  return { body: b, truncated: true, shownLines: b.split("\n").length };
}

interface ReadOut {
  ok: boolean;
  /** 带行号的附入文本。 */
  text: string;
  note: string;
  abs: string;
  /** 附入的裸正文（供 deps 抽候选）。 */
  raw: string;
  /** 附入的裸行（切片后、不带行号前缀；= raw.split("\n")），供材料通路登记 MaterialFile.lines。 */
  rawLines: string[];
  /** 文件全文（供 deps 排除本文件已定义的函数名）。 */
  full: string;
  /** 实际附入的起止真实行号。 */
  start: number;
  end: number;
}

/** 读一个文件并做 jail + 截断；绝不抛。 */
function readOne(path: string, cwd: string, readRoots: readonly string[] = []): ReadOut {
  const f = loadFile(path, cwd, readRoots);
  if (!f.ok) return { ok: false, text: "", note: f.note, abs: "", raw: "", rawLines: [], full: "", start: 0, end: 0 };
  const totalLines = f.body.split("\n").length;
  const c = clampWholeLines(f.body);
  const note = c.truncated ? `${path}（已截断：显示第 1–${c.shownLines} 行，共 ${totalLines} 行）` : "";
  // ★打行号：模型据此**照抄**行号而非自行计数（杜绝行号漂移）。
  return {
    ok: true,
    text: withLineNumbers(c.body),
    note,
    abs: f.abs,
    raw: c.body,
    rawLines: c.body.split("\n"),
    full: f.body,
    start: 1,
    end: c.shownLines,
  };
}

/**
 * 读一个行范围并做 jail + 切片 + 截断；绝不抛。行号从 `start` 起打**真实行号**。
 * start 越界（超过文件行数）/ end < start 等一律降级为 note（fail-open，与 readOne 一致）。
 */
function readRange(r: FileRange, cwd: string, readRoots: readonly string[] = []): ReadOut {
  const fail = (note: string): ReadOut => ({ ok: false, text: "", note, abs: "", raw: "", rawLines: [], full: "", start: r.start, end: r.end });
  if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1 || r.end < r.start) {
    return fail(`跳过 ${r.path} 第 ${r.start}-${r.end} 行：范围非法（须 1 ≤ start ≤ end 的整数）`);
  }
  const f = loadFile(r.path, cwd, readRoots);
  if (!f.ok) return fail(f.note.replace(/^跳过 (.+?)：/, `跳过 $1 第 ${r.start}-${r.end} 行：`));
  const lines = f.body.split("\n");
  const total = lines.length;
  if (r.start > total) {
    return fail(`跳过 ${r.path} 第 ${r.start}-${r.end} 行：起点越界（文件共 ${total} 行）`);
  }
  const end = Math.min(r.end, total);
  let note = end < r.end ? `${r.path} 第 ${r.start}-${r.end} 行：终点越界，实际附入至第 ${end} 行（文件共 ${total} 行）` : "";
  const c = clampWholeLines(lines.slice(r.start - 1, end).join("\n"));
  const shownEnd = r.start + c.shownLines - 1;
  if (c.truncated) {
    note = `${r.path} 第 ${r.start}-${r.end} 行（已截断：显示第 ${r.start}–${shownEnd} 行，单段上限 ${PER_FILE_MAX_CHARS} 字符）`;
  }
  return {
    ok: true,
    text: withLineNumbers(c.body, r.start),
    note,
    abs: f.abs,
    raw: c.body,
    rawLines: c.body.split("\n"),
    full: f.body,
    start: r.start,
    end: shownEnd,
  };
}

/** 材料显示名：相对 cwd；跨仓（不在 cwd 之下）时等于 abs（设计 v4 §2 MaterialFile.rel）。 */
function materialRel(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
}

/** 行号前缀（withLineNumbers 产出 `  12| code`）；反解 deps 块时剥掉，还原裸行。 */
const NUMBERED_LINE_RE = /^\s*(\d+)\| ?(.*)$/;

/**
 * 从 deps 块文本反解出每个附入函数的 (rel, start, 裸行)。godeps.ts 自己 readFileSync、不经 recon 的读取器，
 * 且只回拼好的文本，故材料通路只能按其段头格式（`--- name ← 定义于 rel:line(-end)（…）---` + 带行号行）
 * 机械反解。段头里的 rel 相对**该 .go 文件所在仓根**（godeps.findGoRoot），不是 cwd；这里用已附 .go 来源的
 * 仓根集合逐个 existsSync 归一到 abs。反解出的行号必须连续且首行与段头一致，否则该段不登记（宁缺毋错）。
 */
function parseDepsBlock(text: string, goRoots: readonly string[], cwd: string): MaterialFile[] {
  const out: MaterialFile[] = [];
  const headRe = /^--- \S+ ← 定义于 (.+?):(\d+)(?:-(\d+))?（.*）---$/;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = headRe.exec(lines[i] as string);
    if (!h) continue;
    const rel = h[1] as string;
    const headStart = Number(h[2]);
    const body: string[] = [];
    let first = -1;
    let expect = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = NUMBERED_LINE_RE.exec(lines[j] as string);
      if (!m) break;
      const n = Number(m[1]);
      if (first < 0) {
        first = n;
        expect = n;
      }
      if (n !== expect) break;
      body.push(m[2] as string);
      expect++;
    }
    if (first !== headStart || body.length === 0) continue;
    const root = goRoots.find((g) => existsSync(resolve(g, rel)));
    if (!root) continue;
    const abs = resolve(root, rel);
    out.push({ abs, rel: materialRel(abs, cwd), kind: "deps", lines: body, start: first, end: first + body.length - 1 });
  }
  return out;
}

/**
 * rg 用 `--max-columns N` 跑时，超长行不打印原文，改打印一条省略占位消息（实测 ripgrep 15.1.0：
 * `[Omitted long matching line]`；较早版本按匹配数计文案，形如 `[Omitted long line with N matches]`——
 * 两种写法都识别）。这类行没有真实内容可登记，材料通路须跳过，不能把占位文本当成"原文"喂给核对。
 */
function isOmittedRgLine(content: string): boolean {
  return content === "[Omitted long matching line]" || /^\[Omitted long line with \d+ matches?\]$/.test(content);
}

/**
 * 从 rg 命中块文本（`./path:line:content` 每行一条）反解出材料：同一文件**连续行号**并成一条，
 * 不连续时每个命中行单独一条（设计 v4 §3.1）。文本被截断时末行可能不完整，丢弃末行。
 * 路径切分见 splitRgRow：行内容里也可能出现 `:数字:`（如 `"12:30:45"`），单靠贪婪或非贪婪都会切错，
 * 故按「切出的路径必须真实存在」裁决：非贪婪候选优先，其路径不存在再退回贪婪（POSIX 路径可含冒号）。
 * `--max-columns` 的省略占位行（isOmittedRgLine）不登记为材料（无真实内容），只计数供调用方记 note；
 * 登记中断（cur 置空）避免把占位行两侧的命中行错误拼接成"连续"段。
 */
/**
 * 把 rg 的一行 `path:line:content` 切成三段。非贪婪 `^(.+?):(\d+):(.*)$` 取第一组 `:数字:`，
 * 若切出的路径在 cwd 下真实存在即采用（覆盖绝大多数情况，且不会被内容里的 `:30:` 骗走）；
 * 不存在时退回贪婪 `^(.+):(\d+):(.*)$`（路径本身含冒号的少数情况）。两者都切不出则视为非命中行。
 */
function splitRgRow(row: string, cwd: string): { abs: string; line: number; content: string } | null {
  const lazy = /^(.+?):(\d+):(.*)$/.exec(row);
  const greedy = /^(.+):(\d+):(.*)$/.exec(row);
  for (const m of [lazy, greedy]) {
    if (!m) continue;
    const abs = resolve(cwd, m[1] as string);
    if (existsSync(abs)) return { abs, line: Number(m[2]), content: m[3] as string };
  }
  if (!greedy) return null;
  return { abs: resolve(cwd, greedy[1] as string), line: Number(greedy[2]), content: greedy[3] as string };
}

export function parseRgHits(text: string, truncated: boolean, cwd: string): { files: MaterialFile[]; omitted: number } {
  const out: MaterialFile[] = [];
  let omitted = 0;
  const rows = text.split("\n");
  if (truncated) rows.pop();
  let cur: MaterialFile | null = null;
  for (const row of rows) {
    if (row === "") continue;
    const m = splitRgRow(row, cwd);
    if (!m) continue;
    const content = m.content;
    if (isOmittedRgLine(content)) {
      omitted++;
      cur = null; // 中断：不让占位行两侧的命中行被误判为连续并成一条
      continue;
    }
    const abs = m.abs;
    const line = m.line;
    if (cur && cur.abs === abs && line === cur.end + 1) {
      cur.lines.push(content);
      cur.end = line;
      continue;
    }
    cur = { abs, rel: materialRel(abs, cwd), kind: "rg", lines: [content], start: line, end: line };
    out.push(cur);
  }
  return { files: out, omitted };
}

/** 用 rg 做机械检索（不经模型、不经沙箱——只在受信任的服务端进程内、参数固定）。绝不抛。 */
function ripgrep(query: string, cwd: string): Promise<{ text: string; note: string }> {
  return new Promise((res) => {
    // 固定参数：只读、限行数、限每行长度；query 经 -e 传入（不进 shell，execFile shell:false）。
    const args = ["-n", "--no-heading", "--color", "never", "-m", "5", "--max-columns", "200", "-e", query, "."];
    execFile(
      "rg",
      args,
      { cwd, shell: false, timeout: RG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const out = stdout ?? "";
        // rg 无匹配时 exit 1，不是错误。
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return res({ text: "", note: "侦查检索跳过：未找到 rg" });
        }
        if (out.trim() === "") return res({ text: "", note: `侦查检索：'${query}' 无命中` });
        let text = out;
        let note = "";
        if (text.length > RG_MAX_CHARS) {
          text = text.slice(0, RG_MAX_CHARS);
          note = `（检索结果已截断至 ${RG_MAX_CHARS} 字符）`;
        }
        res({ text, note });
      },
    );
  });
}

/**
 * 执行侦查，产出可直接拼进 `context` 的文本块。
 * 无 files / filesRanges / reconQuery ⇒ 返回空结果（零开销、零影响）。
 */
export async function runRecon(input: ReconInput): Promise<ReconResult> {
  const notes: string[] = [];
  const parts: string[] = [];
  /** 材料通路：只登记 tryPush 成功的块（与 text 严格一致）。 */
  const files: MaterialFile[] = [];
  let filesIncluded = 0;
  let used = 0;
  /** 已附 .go 材料（供 deps 抽候选）与"哪些行已在材料里"（供 deps 去重）。 */
  const goSources: GoDepSource[] = [];
  /** 已附 .md/.txt 文档（供 refs 扫引用；只扫直接附入的，不递归）。 */
  const docSources: DocRefSource[] = [];
  const attached = new Map<string, Array<[number, number]>>(); // abs → 已附行区间

  /**
   * ★逐块预算（§4.5 更正）：每次追加前查「已用 + 本块 ≤ RECON_MAX_CHARS」，超出整块降级为 note。
   * 旧实现只在加下一个文件前查 used，单文件可越界。
   */
  const tryPush = (block: string, what: string): boolean => {
    if (used + block.length > RECON_MAX_CHARS) {
      notes.push(
        `${what} 未附入：侦查总量将超上限 ${RECON_MAX_CHARS} 字符（已用 ${used}，本块 ${block.length}；请减少 files / 改用 files_ranges 只附相关行）`,
      );
      return false;
    }
    parts.push(block);
    used += block.length;
    return true;
  };
  /** ReadOut → MaterialFile（裸行、真实行号）。 */
  const toMaterial = (r: ReadOut, kind: MaterialKind): MaterialFile => ({
    abs: r.abs,
    rel: materialRel(r.abs, input.cwd),
    kind,
    lines: r.rawLines,
    start: r.start,
    end: r.end,
  });
  /** 附入成功后的登记：计数、行区间、.go 来源、材料通路。 */
  const record = (r: ReadOut, label: string, kind: MaterialKind): void => {
    filesIncluded += 1;
    const arr = attached.get(r.abs) ?? [];
    arr.push([r.start, r.end]);
    attached.set(r.abs, arr);
    if (r.abs.endsWith(".go")) goSources.push({ abs: r.abs, body: r.raw, fullText: r.full });
    if (isScannableDoc(r.abs)) docSources.push({ abs: r.abs, label, body: r.raw });
    files.push(toMaterial(r, kind));
  };

  // ── 层次二：精确文件清单 ──
  for (const f of input.files ?? []) {
    const r = readOne(f, input.cwd, input.readRoots ?? []);
    if (r.note) notes.push(r.note);
    if (!r.ok) continue;
    const block = `\n===== FILE ${f}（左侧 \`N| \` 为该文件的真实行号）=====\n${r.text}`;
    if (tryPush(block, `文件 ${f}`)) record(r, f, "file");
  }

  // ── 层次二（切片）：结构化行范围 ──
  for (const fr of input.filesRanges ?? []) {
    const r = readRange(fr, input.cwd, input.readRoots ?? []);
    if (r.note) notes.push(r.note);
    if (!r.ok) continue;
    const block =
      `\n===== FILE ${fr.path} 第 ${r.start}-${r.end} 行（行范围切片；左侧 \`N| \` 为该文件的真实行号）=====\n${r.text}`;
    if (tryPush(block, `文件 ${fr.path} 第 ${fr.start}-${fr.end} 行`)) record(r, fr.path, "range");
  }

  // ── refs:"auto"：文档引用自动附入（缺省关；REFS_MAX_CHARS/REFS_MAX_FILES 硬顶 + 计入 RECON 总账）──
  // 放在 deps 之前、且**不**调用 record()：refs 附入的代码范围不进 goSources，不触发 deps（防链式膨胀）。
  if (input.refs === "auto") {
    if (docSources.length === 0) {
      notes.push("refs 跳过：files/files_ranges 中没有成功附入的 .md/.txt 文档");
    } else {
      const cwd = input.cwd;
      const roots = input.readRoots ?? [];
      // 材料通路：docrefs 经注入的读取器读文件，但读到的段可能因 REFS 上限被它丢弃（只进 note）。
      // 故这里先收候选，等 refs 块拼好且 tryPush 成功后，只登记「带行号文本被逐字嵌进 refs 块」的那些段。
      const refCandidates: ReadOut[] = [];
      const d = collectDocRefs({
        sources: docSources,
        cwd,
        readRoots: roots,
        reconRemaining: RECON_MAX_CHARS - used,
        alreadyAttached: (abs) => attached.has(abs),
        // 同一道 jail、同一套 PER_FILE 截断与行号：读取器由 recon 注入，docrefs 不自己读文件。
        readWhole: (path) => {
          const r = readOne(path, cwd, roots);
          if (r.ok) refCandidates.push(r);
          return r;
        },
        readRange: (path, start, end) => {
          const r = readRange({ path, start, end }, cwd, roots);
          if (r.ok) refCandidates.push(r);
          return r;
        },
      });
      notes.push(...d.notes);
      if (d.text && tryPush(`\n${d.text}`, "refs 文档引用附件块")) {
        for (const r of refCandidates) {
          if (r.text === "") continue;
          if (d.text.includes(r.text)) {
            files.push(toMaterial(r, "refs"));
          } else {
            // includes 门落空：读到的内容未能在 refs 块里逐字定位（如 docrefs 内部对文本做过调整），
            // 材料通路与实际附入的 text 可能不同步——不静默丢弃，记 note 留痕。
            notes.push(`refs 材料通路：${materialRel(r.abs, input.cwd)} 未在 refs 块中逐字匹配，未登记`);
          }
        }
      }
    }
  }

  // ── deps:"auto"：依赖函数整体附入（缺省关；DEPS_MAX_CHARS 硬顶 + 计入 RECON 总账）──
  if (input.deps === "auto") {
    if (goSources.length === 0) {
      notes.push("deps 跳过：files/files_ranges 中没有成功附入的 .go 文件");
    } else {
      const d = await collectGoDeps({
        sources: goSources,
        reconRemaining: RECON_MAX_CHARS - used,
        isAttached: (abs, line) => (attached.get(abs) ?? []).some(([a, b]) => line >= a && line <= b),
      });
      notes.push(...d.notes);
      if (d.text && tryPush(`\n${d.text}`, "deps 依赖函数块")) {
        // 材料通路：godeps 只回文本，按段头格式反解（见 parseDepsBlock 注释）；仓根取自已附 .go 来源。
        const goRoots = [...new Set(goSources.map((s) => findGoRoot(s.abs)))];
        files.push(...parseDepsBlock(d.text, goRoots, input.cwd));
      }
    }
  }

  // ── 层次三：机械检索（rg，无模型参与）──
  if (input.reconQuery && input.reconQuery.trim() !== "" && used < RECON_MAX_CHARS) {
    const r = await ripgrep(input.reconQuery.trim(), input.cwd);
    if (r.note) notes.push(r.note);
    if (r.text) {
      const pushed = tryPush(
        `\n===== 机械检索命中（rg -n -m5 -e ${JSON.stringify(input.reconQuery.trim())}）=====\n` +
          `（服务端预先检索，非模型产出；每文件最多 5 处命中）\n${r.text}`,
        "机械检索命中块",
      );
      // 材料通路：命中行按文件登记（连续行并段；截断时丢末行；--max-columns 省略行跳过并记 note）。
      if (pushed) {
        const parsed = parseRgHits(r.text, r.note !== "", input.cwd);
        files.push(...parsed.files);
        if (parsed.omitted > 0) notes.push(`rg 命中 ${parsed.omitted} 行因超长未登记`);
      }
    }
  }

  if (parts.length === 0) return { text: "", filesIncluded, notes, usedChars: 0, files };

  const header =
    "===== 侦查前置（服务端预读，任务边界已画好）=====\n" +
    "以下内容由服务端**机械读取/检索**得到，非模型产出，**已是完成任务所需的全部材料**。\n" +
    "⚠️ **硬性要求**：请**直接基于以下材料作答**，默认**不要再调用任何检索/读取工具**。\n" +
    "原因（非建议，是硬约束）：每调一次工具都会把**完整对话历史重新发送**给模型——实测一次" +
    "14k token 的任务因反复调工具膨胀到 251k token（17.8 倍），直接导致上下文撑爆、正文为空、" +
    "整轮 fail-closed 不产出。本会话的工具调用轮数**上限极低**，超出即被拒绝。\n" +
    "仅当材料中**确实缺少**判定所需的关键信息时，才用最精确的单次查询补齐（给准确路径/pattern）。\n" +
    "📍 **行号规则**：下列代码每行左侧的 `N| ` 就是该文件的**真实行号**。引用位置时请**直接照抄**" +
    "这个数字，**不要自己数行**（自行计数必然偏移）。同时给出被引用行的原文片段，便于核对。\n";

  const text = header + parts.join("\n");
  return { text, filesIncluded, notes, usedChars: text.length, files };
}
