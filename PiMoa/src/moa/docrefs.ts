/**
 * 文档引用自动附件（recon `refs:"auto"`；提速方案 20260904 §4.11 / §4.10 硬顶）。
 *
 * ## 解决什么
 * 文档 review 改走闭卷 `moa_run`（worker 无 read 工具）：主代理只传被审文档路径，**服务端**把文档里
 * 引用的材料机械附进来，模型零工具轮次。徐总铁律：文档里一律写绝对路径，所以引用可正则抓取。
 * 与 `deps:"auto"`（src/moa/godeps.ts）同构：服务端机械执行、不花模型 token、硬顶写死、fail-open。
 *
 * ## 做什么（只对 files / files_ranges 里**直接附入**的 .md/.txt 文档扫正文，**不递归**）
 *  · 抽引用：绝对路径（`/` 开头；支持反引号/引号包裹——含空格路径常在其中——与裸写两种）、
 *    相对路径（`docs/` `internal/` `cmd/` `tools/` `.claude/` 开头，相对 cwd 解析）、
 *    行号后缀 `path:N` / `path:N-M` / `path:N–M`（en dash）/ `path#LN` / `path#LN-LM`。
 *  · 引用的是文档（.md/.txt/.yaml/.yml/.surql/.toml）→ 整份附入（走 recon 的 loadFile：jail + PER_FILE
 *    截断 + 打行号）；引用的是代码且**带行号** → 只附 `[N-20, M+20]` 行范围（复用 recon 的 readRange，
 *    行号真实）；**不带行号**的代码引用不附体，只在 note 列「未附，代码事实断言请走 moa_verify」。
 *  · 去重：已在 files/files_ranges 中的路径不重复附；同一路径多处引用只附一次（范围取并集，相邻/重叠合并）。
 *  · 跳过：被审文档自身、`.bak*`、`node_modules/`、二进制；不存在的路径写 note「引用路径不存在」
 *    （这是文档质量信号，必须留痕）；jail 越界写 note。
 *
 * ## 预算（§4.10，写死不放大）
 *  有效上限 = min(REFS_MAX_CHARS, reconRemaining)；文件数 ≤ REFS_MAX_FILES；超顶后剩余引用只在 note 列路径。
 *  refs 块由调用方（recon）经 tryPush 计入 RECON_MAX_CHARS 总账；refs 附入的代码范围**不**再触发 deps。
 *
 * ## 已知边界（接受漏检，只影响"少附一段材料"，不影响正确性）
 *  · 只认带扩展名的路径（`Makefile` / `Dockerfile` 这类无扩展名文件名与目录引用不抓）；
 *  · 含空格的绝对路径只在反引号/引号包裹时抓得到，裸写在第一个空白处截断→多半落进「不存在」note；
 *  · 相对路径只认上述五个前缀（其它相对写法歧义太大：`a/b.md` 可能是示例而非引用）。
 *
 * 读文件不在本模块内做：recon 把 readOne / readRange 以回调注入（同一道 jail、同一套截断与行号），
 * 避免 recon ↔ docrefs 反向导入成环（godeps 的做法是复制 withLineNumbers；这里改为注入更彻底）。
 */
import { existsSync, statSync } from "node:fs";
import { extname, relative, resolve, isAbsolute, sep } from "node:path";
import { checkPathJail } from "../tools/bash_readonly.js";
import { REFS_CODE_CONTEXT_LINES, REFS_MAX_CHARS, REFS_MAX_FILES } from "../config/limits.js";

/** 一条从文档正文抽出的引用。 */
export interface DocRef {
  /** 文档里写的原文（去掉包裹符与行号后缀）。 */
  raw: string;
  /** 解析后的绝对路径（相对路径按 cwd 解析；未做 realpath）。 */
  abs: string;
  /** 行号后缀解析结果（1 基闭区间）；无后缀则缺省。 */
  range?: { start: number; end: number };
}

/** 一份已附入、要扫引用的文档。 */
export interface DocRefSource {
  /** 绝对路径（已过 recon 的 jail）。 */
  abs: string;
  /** 调用方给的路径写法（用于 note / 块头的「被 X 引用」）。 */
  label: string;
  /** 实际附入模型的正文（全文或行范围切片；不带行号）——只扫这一段。 */
  body: string;
}

/** recon 注入的读取器产物（与 recon.ts 的 ReadOut 对齐的最小子集）。 */
export interface RefReadOut {
  ok: boolean;
  /** 带行号的附入文本。 */
  text: string;
  /** 截断/越界等说明（可为空）。 */
  note: string;
  /** 附入的裸正文（用于二进制探测）。 */
  raw: string;
  /** 实际附入的起止真实行号。 */
  start: number;
  end: number;
}

export interface DocRefsInput {
  sources: DocRefSource[];
  cwd: string;
  readRoots?: readonly string[];
  /** recon 总账剩余字符数；有效上限 = min(REFS_MAX_CHARS, 此值)。缺省只受 REFS_MAX_CHARS。 */
  reconRemaining?: number;
  /** 该绝对路径是否已在 files/files_ranges 中附入（路径级去重）。 */
  alreadyAttached?: (abs: string) => boolean;
  /** 整份读取（recon.readOne：jail + PER_FILE 截断 + 打行号）。 */
  readWhole: (path: string) => RefReadOut;
  /** 行范围读取（recon.readRange：jail + 切片 + 真实行号）。 */
  readRange: (path: string, start: number, end: number) => RefReadOut;
}

export interface DocRefsResult {
  /** 拼好的 refs 块（空串 = 没有可附内容）。 */
  text: string;
  /** 附入的文件数（整份文档 + 代码行范围文件各计 1）。 */
  filesIncluded: number;
  /** text.length。 */
  usedChars: number;
  notes: string[];
}

// ── 扫描器 ──────────────────────────────────────────────────────────────────

/** 被视为「文档」整份附入的扩展名。 */
const DOC_EXTS = new Set([".md", ".txt", ".yaml", ".yml", ".surql", ".toml"]);
/** 触发扫描的被审文档扩展名（只扫这两类的正文）。 */
const SCAN_EXTS = new Set([".md", ".txt"]);
/** 按扩展名判为二进制、不附体。 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz", ".pdf", ".docx", ".doc", ".xlsx", ".xls",
  ".pptx", ".ppt", ".dotx", ".dot", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".tar", ".bin", ".wasm", ".so",
  ".dylib", ".dll", ".exe", ".o", ".a", ".class", ".jar", ".mp3", ".mp4", ".mov", ".wav", ".sqlite", ".db",
]);

/** 相对路径允许的前缀（其它相对写法不抓：歧义太大）。 */
const REL_PREFIX_RE = /^(?:docs|internal|cmd|tools|\.claude)\//;
/** 路径终止字符：空白、反引号、引号、括号、尖括号、逗号分号、竖线、通配符、中文全角标点。 */
const TERMINATORS = "\\s`\"'()\\[\\]<>,;|*?{}，。；：、（）【】《》「」『』！？";
/** 裸写绝对路径：`/` 开头（排除 `//`——URL 的协议分隔）；前一字符不能是 \w . / -（避免从 URL / 标识符中间切出）。 */
const BARE_ABS_RE = new RegExp(`(?<![\\w./-])(/(?!/)[^${TERMINATORS}]+)`, "g");
/** 裸写相对路径：五个前缀之一开头。 */
const BARE_REL_RE = new RegExp(`(?<![\\w./-])((?:docs|internal|cmd|tools|\\.claude)/[^${TERMINATORS}]+)`, "g");
/** 包裹写法：反引号 / 双引号 / 单引号（内容可含空格，不跨行）。 */
const WRAPPED_RES: readonly RegExp[] = [/`([^`\n]+)`/g, /"([^"\n]+)"/g, /'([^'\n]+)'/g];
/**
 * 行号后缀：`:N`、`:N-M`、`:N–M`（en dash）、`:N:C`（列号忽略）、`#LN`、`#LN-LM`、`#LN-M`。
 * 只匹配字符串末尾（前面的整段是路径，文件名本身可含冒号）。
 */
const LINE_SUFFIX_RE = /(?::(\d+)(?:\s*[-–]\s*(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;
/** 路径须带扩展名（1–8 个字母数字）——目录 / 无扩展名文件名不抓。 */
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/** 把一段候选文本规整为 DocRef（去尾部标点、拆行号后缀、校前缀与扩展名）；不合格返回 null。 */
function normalizeCandidate(text: string, cwd: string): DocRef | null {
  let s = text.trim().replace(/[.,;:]+$/, ""); // 句末标点（`见 docs/a.md。`/`docs/a.md.`）
  if (s === "") return null;
  let range: DocRef["range"];
  const m = LINE_SUFFIX_RE.exec(s);
  if (m) {
    const a = Number(m[1] ?? m[3]);
    const b = m[2] ?? m[4];
    const end = b === undefined ? a : Number(b);
    if (Number.isInteger(a) && a >= 1 && Number.isInteger(end) && end >= a) {
      range = { start: a, end };
      s = s.slice(0, m.index);
    }
  }
  const isAbs = s.startsWith("/");
  if (!isAbs && !REL_PREFIX_RE.test(s)) return null;
  if (isAbs && s.startsWith("//")) return null;
  if (!EXT_RE.test(s)) return null;
  const abs = isAbs ? s : resolve(cwd, s);
  return range ? { raw: s, abs, range } : { raw: s, abs };
}

/**
 * 从文档正文抽出路径引用。先抓包裹写法并把它们抹掉（否则裸扫会把含空格路径从空格处截断，
 * 生成假的「不存在」），再对剩余正文裸扫绝对/相对路径。同一 (abs, range) 去重、保持首现顺序。
 */
export function extractDocRefs(body: string, cwd: string): DocRef[] {
  const out: DocRef[] = [];
  const seen = new Set<string>();
  const push = (r: DocRef | null): void => {
    if (!r) return;
    const key = `${r.abs}\u0000${r.range ? `${r.range.start}-${r.range.end}` : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  let rest = body;
  for (const re of WRAPPED_RES) {
    rest = rest.replace(re, (whole: string, inner: string) => {
      const r = normalizeCandidate(inner, cwd);
      if (!r) return whole; // 不是路径的包裹文本原样保留（里面可能还有裸写路径，如 `见 /a/b.md 与 c`）
      push(r);
      return " ".repeat(whole.length);
    });
  }
  for (const re of [BARE_ABS_RE, BARE_REL_RE]) {
    for (const m of rest.matchAll(re)) push(normalizeCandidate(m[1] as string, cwd));
  }
  return out;
}

/** 合并 1 基闭区间：排序后相邻（next.start ≤ cur.end + 1）或重叠的并成一段。 */
export function mergeRanges(ranges: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** 是否为要扫引用的被审文档（.md/.txt）。 */
export function isScannableDoc(abs: string): boolean {
  return SCAN_EXTS.has(extname(abs).toLowerCase());
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

interface Grouped {
  abs: string;
  /** 文档里的原写法（首现）。 */
  raw: string;
  /** 引用方 label（去重、首现顺序）。 */
  referrers: string[];
  /** 已按 ±REFS_CODE_CONTEXT_LINES 扩展并合并后的行范围（代码用）。 */
  ranges: Array<{ start: number; end: number }>;
  /** 是否至少有一处无行号引用。 */
  bare: boolean;
}

function displayPath(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
}

/**
 * 主入口：扫 sources 的正文 → 分组去重 → 逐项读取并在 cap 内拼块。绝不抛（fail-open）。
 */
export function collectDocRefs(input: DocRefsInput): DocRefsResult {
  const notes: string[] = [];
  const empty: DocRefsResult = { text: "", filesIncluded: 0, usedChars: 0, notes };
  try {
    const cwd = input.cwd;
    const readRoots = input.readRoots ?? [];
    const cap = Math.max(0, Math.min(REFS_MAX_CHARS, input.reconRemaining ?? REFS_MAX_CHARS));

    // ── 1. 抽引用并按 abs 分组 ──
    const groups = new Map<string, Grouped>();
    let refCount = 0;
    for (const src of input.sources) {
      if (!isScannableDoc(src.abs)) continue;
      for (const ref of extractDocRefs(src.body, cwd)) {
        if (ref.abs === src.abs) continue; // 被审文档自身：静默跳过（其它已附文档走下方 alreadyAttached 去重并留 note）
        refCount++;
        const g = groups.get(ref.abs) ?? { abs: ref.abs, raw: ref.raw, referrers: [], ranges: [], bare: false };
        if (!g.referrers.includes(src.label)) g.referrers.push(src.label);
        if (ref.range) {
          g.ranges.push({
            start: Math.max(1, ref.range.start - REFS_CODE_CONTEXT_LINES),
            end: ref.range.end + REFS_CODE_CONTEXT_LINES,
          });
        } else {
          g.bare = true;
        }
        groups.set(ref.abs, g);
      }
    }
    if (input.sources.some((s) => isScannableDoc(s.abs)) === false) {
      notes.push("refs 跳过：files/files_ranges 中没有成功附入的 .md/.txt 文档");
      return empty;
    }
    if (refCount === 0) {
      notes.push("refs：被附文档中未抽到可解析的路径引用（只认绝对路径与 docs/ internal/ cmd/ tools/ .claude/ 前缀的相对路径，且须带扩展名）");
      return empty;
    }

    // ── 2. 逐项判定 ──
    const attachedLines: string[] = [];
    const dup: string[] = [];
    const noLine: string[] = [];
    const missing: string[] = [];
    const jailed: string[] = [];
    const binary: string[] = [];
    const overFiles: string[] = [];
    const overChars: string[] = [];
    const readFail: string[] = [];
    const sections: string[] = [];

    const intro =
      "===== 文档引用附件（refs:auto，服务端机械抽取；左侧 `N| ` 为**所在文件**的真实行号）=====\n" +
      "以下材料是上方被审文档正文里引用的路径，由服务端正则抓取后附入，非模型产出：引用的文档整份附入；" +
      "引用的代码只附引用行号 ±" + String(REFS_CODE_CONTEXT_LINES) + " 行的范围；无行号的代码引用**未附**（见侦查说明，" +
      "对其代码事实的断言请标「材料外未核」或走 moa_verify）。不递归跟随被附文档里的再引用。\n";
    let used = intro.length;
    let filesIncluded = 0;
    const by = (g: Grouped): string => `${displayPath(g.abs, cwd)}（被 ${g.referrers.join("、")} 引用）`;

    for (const g of groups.values()) {
      const shown = displayPath(g.abs, cwd);
      // 跳过类（.bak* / node_modules/）：刻意排除，不留 note。
      if (/\.bak(?:[.\-_]|$)/i.test(g.abs) || g.abs.split(sep).includes("node_modules")) continue;
      if (input.alreadyAttached?.(g.abs)) {
        dup.push(shown);
        continue;
      }
      // jail 先于存在性检查：不对越界路径做 existsSync（否则 note 会泄露沙箱外文件是否存在）。
      const jail = checkPathJail(["read", g.abs], cwd, { readRoots });
      if (jail) {
        jailed.push(`${by(g)}：${jail}`);
        continue;
      }
      if (!existsSync(g.abs)) {
        missing.push(by(g));
        continue;
      }
      try {
        if (statSync(g.abs).isDirectory()) continue; // 目录不是可附材料（扫描器已要求扩展名，此处兜底）
      } catch {
        missing.push(by(g));
        continue;
      }
      const ext = extname(g.abs).toLowerCase();
      if (BINARY_EXTS.has(ext)) {
        binary.push(by(g));
        continue;
      }
      const isDoc = DOC_EXTS.has(ext);
      if (!isDoc && g.ranges.length === 0) {
        noLine.push(by(g));
        continue;
      }
      if (filesIncluded >= REFS_MAX_FILES) {
        overFiles.push(by(g));
        continue;
      }

      // ── 读取并拼块 ──
      const blocks: string[] = [];
      const desc: string[] = [];
      let failed = "";
      if (isDoc) {
        const r = input.readWhole(g.abs);
        if (!r.ok) {
          failed = r.note || "读取失败";
        } else if (r.raw.includes("\u0000")) {
          binary.push(by(g));
          continue;
        } else {
          if (r.note) notes.push(`refs：${r.note}`);
          blocks.push(
            `\n===== FILE ${shown}（refs:auto，被 ${g.referrers.join("、")} 引用；左侧 \`N| \` 为该文件的真实行号）=====\n${r.text}`,
          );
          desc.push(`整份 第 ${r.start}-${r.end} 行`);
        }
      } else {
        for (const rg of mergeRanges(g.ranges)) {
          const r = input.readRange(g.abs, rg.start, rg.end);
          if (!r.ok) {
            failed = r.note || "读取失败";
            break;
          }
          if (r.raw.includes("\u0000")) {
            failed = "二进制内容";
            break;
          }
          // ±20 扩展本就常越过文件末尾，readRange 的「终点越界」属预期，不进 note；其它 note（如截断）保留。
          if (r.note && !r.note.includes("终点越界")) notes.push(`refs：${r.note}`);
          blocks.push(
            `\n===== FILE ${shown} 第 ${r.start}-${r.end} 行（refs:auto 行范围，被 ${g.referrers.join("、")} 引用，` +
              `引用行号 ±${REFS_CODE_CONTEXT_LINES}；左侧 \`N| \` 为该文件的真实行号）=====\n${r.text}`,
          );
          desc.push(`第 ${r.start}-${r.end} 行`);
        }
      }
      if (failed !== "") {
        if (failed === "二进制内容") binary.push(by(g));
        else readFail.push(`${by(g)}：${failed}`);
        continue;
      }
      const chars = blocks.reduce((n, b) => n + b.length + 1, 0);
      if (used + chars > cap) {
        overChars.push(`${shown}（${desc.join("、")}，${chars} 字符）`);
        continue;
      }
      sections.push(...blocks);
      used += chars;
      filesIncluded++;
      attachedLines.push(`${shown}（${desc.join("、")}，${chars} 字符）`);
    }

    // ── 3. note ──
    if (attachedLines.length > 0) {
      notes.push(`refs：附入 ${filesIncluded} 个文件，共 ${used} 字符（上限 ${cap}）：${attachedLines.join("；")}`);
    }
    if (dup.length > 0) notes.push(`refs：已在 files/files_ranges 中，不重复附：${dup.join("；")}`);
    if (noLine.length > 0) {
      notes.push(`refs 未附（被引用代码未附：引用无行号，代码事实断言请走 moa_verify）：${noLine.join("；")}`);
    }
    if (missing.length > 0) notes.push(`refs 未附（引用路径不存在）：${missing.join("；")}`);
    if (jailed.length > 0) notes.push(`refs 未附（路径越界，被 jail 拒绝）：${jailed.join("；")}`);
    if (binary.length > 0) notes.push(`refs 未附（二进制）：${binary.join("；")}`);
    if (readFail.length > 0) notes.push(`refs 未附（读取失败）：${readFail.join("；")}`);
    if (overFiles.length > 0) {
      notes.push(`refs 未附（超文件数上限 REFS_MAX_FILES=${REFS_MAX_FILES}，只列路径）：${overFiles.join("；")}`);
    }
    if (overChars.length > 0) {
      const why = cap < REFS_MAX_CHARS ? `recon 剩余额度 ${cap}（< REFS_MAX_CHARS ${REFS_MAX_CHARS}）` : `REFS_MAX_CHARS ${REFS_MAX_CHARS}`;
      notes.push(`refs 未附（超字符上限 ${why}，已用 ${used}，只列路径）：${overChars.join("；")}`);
    }

    if (sections.length === 0) return empty;
    const text = intro + sections.join("\n");
    return { text, filesIncluded, usedChars: text.length, notes };
  } catch (err) {
    notes.push(`refs 跳过：${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}
