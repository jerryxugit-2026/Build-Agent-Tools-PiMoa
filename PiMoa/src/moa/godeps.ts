/**
 * Go 依赖函数整体附入（recon `deps:"auto"`；提速方案 20260904 §4.5 改动 B / §4.10 硬顶）。
 *
 * ## 解决什么
 * review 材料只附被改文件时，被改文件里调用的 helper（往往在同包另一个文件里）对模型是黑盒，
 * 模型只好再花一轮取证去读——而每轮取证都把完整历史重发一遍。本模块在**进模型之前**由服务端
 * 机械补齐：抽出被附 .go 文件里调用的**未限定**标识符 → 在**被附文件所在仓根**用 rg 定位
 * `func Name(` 定义 → 把函数**整体**附入（±20 行给不出 89 行的函数体）并打真实行号。
 *
 * ## 纯 TS、不依赖 Go 工具链
 * 方案原拟 go/parser helper；此处用正则 + rg 实现，代价是下列**已知边界**（接受漏检/误附，
 * 只影响"多附/少附一段材料"，不影响正确性；note 里同样写明）：
 *  · 泛型函数 `func F[T any](` 的**定义**能匹配（`[\[(]`），但调用处 `F[int](x)` 的显式实例化
 *    不会被 `Name(` 抓到 → 漏检；
 *  · 方法表达式 `T.Method` / 方法值、接口方法：调用形如 `x.M(`（带点）一律不处理 → 漏检；
 *  · 同名跨包函数/方法：`rg` 在整个仓根搜，另一个包里恰好同名的 `func Name(` 会被当命中 → 误附
 *    （命中多处时全列签名、只附首个体，非 _test.go 优先）；
 *  · 字符串/注释里形如 `word(` 的文本也会成为候选（rg 无命中则静默丢弃，不产噪音）。
 *
 * ## 预算（§4.10，写死不放大）
 *  · 单函数 > DEPS_FUNC_MAX_CHARS ⇒ 只附签名；
 *  · 总量 > DEPS_MAX_CHARS ⇒ 其余候选只附签名；
 *  · 调用方（recon）把 deps 块计入 RECON_MAX_CHARS 总账，故本模块另收 `reconRemaining`，
 *    有效上限 = min(DEPS_MAX_CHARS, reconRemaining) —— 只能更小，不能更大。
 *
 * 失败绝不抛（fail-open，与 recon 一致）：无 rg / rg 超时 / 文件读失败 → 一条 note。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DEPS_FUNC_MAX_CHARS, DEPS_MAX_CHARS, RG_MAX_CHARS } from "../config/limits.js";

/** rg 执行超时（与 recon.ts 的 RG_TIMEOUT_MS 同值；超时/缓冲类限额按 limits.ts 约定留守各文件）。 */
const RG_TIMEOUT_MS = 15_000;

/** 一个已附入的 .go 来源（全文附入或行范围附入）。 */
export interface GoDepSource {
  /** 绝对路径（已过 recon 的路径 jail）。 */
  abs: string;
  /** 实际附入模型的正文（全文，或 files_ranges 切出的片段；不带行号）。候选标识符只从这里抽。 */
  body: string;
  /** 文件全文（用于排除"本文件已定义"的函数名——切片时定义可能在片段之外）。缺省 = body。 */
  fullText?: string;
}

export interface GoDepsInput {
  sources: GoDepSource[];
  /**
   * recon 总账剩余字符数（RECON_MAX_CHARS − 已用）。有效上限 = min(DEPS_MAX_CHARS, 此值)。
   * 缺省视为不额外收紧（仍受 DEPS_MAX_CHARS）。
   */
  reconRemaining?: number;
  /**
   * 判断某文件的某一行是否**已经在材料里**（全文附入的文件、或行范围覆盖到的行）——
   * 已在材料里的定义不重复附体，只写一条"已在附件中"的指针。
   */
  isAttached?: (abs: string, line: number) => boolean;
}

export interface GoDepsResult {
  /** 拼好的 deps 块（空串 = 没有可附内容）。 */
  text: string;
  /** 整体附入的函数数。 */
  funcsIncluded: number;
  /** 只附了签名的函数数（过长 / 总量到顶 / 无函数体 / 已在附件）。 */
  signaturesOnly: number;
  /** text.length。 */
  usedChars: number;
  notes: string[];
}

/** Go 关键字 + 预声明标识符（内建函数、内建类型、常量）：既不是"可定位的依赖函数"，也不该去 rg。 */
const GO_RESERVED = new Set<string>([
  // 关键字
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var",
  // 内建函数
  "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make", "max", "min",
  "new", "panic", "print", "println", "real", "recover",
  // 预声明类型（类型转换 `string(b)` / `int64(n)` 形同调用）与常量/零值
  "any", "bool", "byte", "comparable", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32",
  "uint64", "uintptr", "true", "false", "iota", "nil",
]);

/**
 * 与 recon.ts `withLineNumbers` 同规格（`  12| code`，宽度对齐到末行行号）。
 * 不从 recon.ts 导入：recon 依赖本模块，反向导入会成环。
 */
function withLineNumbers(body: string, startLine: number): string {
  const lines = body.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, " ")}| ${l}`).join("\n");
}

/** 正则元字符转义（候选名只含 \w，理论上无需转义，防御性保留）。 */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `^func\s+(\([^)]*\)\s*)?Name\s*[\[(]` —— 顶格函数/方法定义（gofmt 格式）。 */
function defRegex(names: readonly string[], flags = ""): RegExp {
  return new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?(${names.map(reEscape).join("|")})\\s*[\\[(]`, flags);
}

/**
 * 从正文抽出被调用的未限定标识符：`\b([A-Za-z_]\w*)\s*\(`，排除前面紧跟 `.` 的（`pkg.Name(` /
 * `x.Method(`）、Go 关键字与内建、以及 fullText 中已定义的函数名。返回去重、保持首现顺序。
 */
export function extractCallCandidates(body: string, fullText: string = body): string[] {
  const selfDefined = new Set<string>();
  const defRe = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/gm;
  for (const m of fullText.matchAll(defRe)) selfDefined.add(m[2] as string);

  const out: string[] = [];
  const seen = new Set<string>();
  // 负向后顾：前一字符不能是 `.`（限定名）或 \w（已被前一个标识符吞掉的尾部）。
  const callRe = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
  for (const m of body.matchAll(callRe)) {
    const name = m[1] as string;
    if (GO_RESERVED.has(name) || selfDefined.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 向上找最近的 go.mod 所在目录作为仓根；找不到则用文件所在目录。 */
export function findGoRoot(absFile: string): string {
  let dir = dirname(resolve(absFile));
  for (;;) {
    if (existsSync(join(dir, "go.mod"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(absFile));
    dir = parent;
  }
}

interface DefHit {
  /** 相对仓根的路径。 */
  rel: string;
  abs: string;
  line: number;
  /** 签名行原文。 */
  sig: string;
  name: string;
}

/**
 * 在仓根用 rg 定位一批候选名的定义行（一次进程、alternation 合并）。
 * 参照 recon.ts 的 rg 调用：固定参数、execFile shell:false、同超时/缓冲、fail-open。
 * `--null` 让路径后跟 NUL 而非冒号（文件名可含冒号，与 files_ranges 不用 `path:a-b` 同理）。
 */
function rgDefinitions(root: string, names: readonly string[]): Promise<{ hits: DefHit[]; note: string }> {
  return new Promise((res) => {
    const pattern = `^func\\s+(\\([^)]*\\)\\s*)?(${names.map(reEscape).join("|")})\\s*[\\[(]`;
    const args = ["-n", "--no-heading", "--color", "never", "--null", "--type", "go", "-e", pattern, "."];
    execFile(
      "rg",
      args,
      { cwd: root, shell: false, timeout: RG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let out = stdout ?? "";
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return res({ hits: [], note: "deps 跳过：未找到 rg" });
        }
        // rg 无匹配 exit 1 不是错误；其它错误（超时 killed / 非法目录）fail-open 成 note。
        if (err && out.trim() === "") {
          const e = err as Error & { killed?: boolean; code?: unknown };
          if (e.killed) return res({ hits: [], note: `deps 跳过：rg 超时（${RG_TIMEOUT_MS}ms）` });
          if (e.code !== 1) return res({ hits: [], note: `deps 跳过：rg 失败（${e.message}）` });
          return res({ hits: [], note: "" });
        }
        let note = "";
        if (out.length > RG_MAX_CHARS) {
          out = out.slice(0, RG_MAX_CHARS);
          const lastNl = out.lastIndexOf("\n");
          if (lastNl > 0) out = out.slice(0, lastNl);
          note = `deps：定义检索结果已截断至 ${RG_MAX_CHARS} 字符，部分候选可能漏检`;
        }
        const sigRe = defRegex(names);
        const hits: DefHit[] = [];
        for (const raw of out.split("\n")) {
          if (raw === "") continue;
          const nul = raw.indexOf("\0");
          if (nul < 0) continue;
          const relPath = raw.slice(0, nul).replace(/^\.\//, "");
          const rest = raw.slice(nul + 1);
          const colon = rest.indexOf(":");
          if (colon < 0) continue;
          const line = Number(rest.slice(0, colon));
          const sig = rest.slice(colon + 1);
          const m = sigRe.exec(sig);
          if (!Number.isFinite(line) || !m) continue;
          hits.push({ rel: relPath, abs: resolve(root, relPath), line, sig, name: m[2] as string });
        }
        res({ hits, note });
      },
    );
  });
}

/**
 * 从签名行起切出函数整体：到其后第一个顶格 `}` 行（gofmt 格式）为止。
 * 单行函数（`func f() int { return 1 }`）以签名行自身收尾；无函数体（汇编桩 / 无 `{`）或找不到
 * 顶格 `}` ⇒ 返回 null（调用方只附签名）。
 */
export function sliceFuncBody(
  lines: readonly string[],
  sigIndex: number,
): { text: string; endLine: number } | null {
  const sig = lines[sigIndex];
  if (sig === undefined) return null;
  // ★2026-09-20（DSH 会话实录 safeQuotedStringListAppends）：gofmt 多行签名的 `{` 不在签名首行，而在
  //   `) ([]*ast.CallExpr, bool) {` 那一行——此前这里直接 return null，下面向前扫顶格 `}` 的循环永远到不了，
  //   多行签名的函数一律只附签名（第 4–7 轮 notes 里「未找到 gofmt 顶格 } 收尾或无函数体」多半是它）。
  //   现在：签名首行没有 `{` 时，沿缩进续行（\t 开头）扫到以 `)` 开头且以 `{` 结尾的收尾行；中途遇到别的形状即无函数体。
  let openIndex = sigIndex;
  if (!sig.includes("{")) {
    openIndex = -1;
    for (let i = sigIndex + 1; i < lines.length; i++) {
      const l = lines[i] as string;
      if (l.startsWith(")") && l.trimEnd().endsWith("{")) {
        openIndex = i;
        break;
      }
      if (!l.startsWith("\t")) break; // 不是签名续行（空行 / 下一个顶格声明 / 注释）⇒ 无函数体
    }
    if (openIndex < 0) return null;
  }
  const opens = (sig.match(/{/g) ?? []).length;
  const closes = (sig.match(/}/g) ?? []).length;
  if (openIndex === sigIndex && opens === closes && sig.trimEnd().endsWith("}")) {
    return { text: sig, endLine: sigIndex + 1 };
  }
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      return { text: lines.slice(sigIndex, i + 1).join("\n"), endLine: i + 1 };
    }
  }
  return null;
}

/**
 * 本文件自身全文里某候选名的 `func` 定义行（1 起）。只扫顶格定义（gofmt 格式），与
 * `extractCallCandidates` 内部 `defRe` 同一模式；同名只取首次出现。
 */
function ownDefLines(fullText: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = fullText.split("\n");
  const defRe = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
  for (let i = 0; i < lines.length; i++) {
    const m = defRe.exec(lines[i] as string);
    if (m && !out.has(m[2] as string)) out.set(m[2] as string, i + 1);
  }
  return out;
}

/**
 * 主入口：对每个 .go 来源抽候选 → **同文件（被附文件自身全文，定义位于本次附入区间之外）优先** →
 * 其余去按仓根分组 rg → 逐候选附函数整体 / 签名。绝不抛。
 *
 * ★2026-09-20 §12.6 第 4 点（波四）：此前 `extractCallCandidates(body, fullText)` 一律排除
 * "fullText 里能找到定义"的候选名——包括定义**在本次附入区间之外**的情形（比如 files_ranges 只切
 * 了函数调用处、没切到同文件里稍远的辅助函数定义），这类候选从未成为"候选"，模型看不到、也不会被
 * rg 兜底（rg 只扫仓根另一份材料）。现改为：先按 `src.body`（不带 fullText 参）抽全部候选——只排除
 * **body 自身**内定义的名字（trivially 可见，无需附入）；对每个候选查 `src.fullText` 里的定义行：
 *   · 该行已在已附材料内（`isAttached`）⇒ 跳过（已可见，不占用 candidateTotal，不产生 note）；
 *   · 该行不在已附材料内 ⇒ 同文件直接切函数体整体附入（计入 cap），不必去 rg；
 *   · fullText 里也找不到 ⇒ 按候选名去仓根 rg（与此前逻辑一致）。
 * notes 从「只给计数」改为逐条「候选名 → 文件:行 / 只附签名（原因）/ 无定义」（第 4 轮「7 个候选
 * 无定义命中」无法排查的问题）；旧的汇总计数行仍保留在 notes 末尾（供既有消费方按 /整体附入 \d+ 个函数/
 * 之类的宽松匹配继续用，不构成新增依赖）。
 */
export async function collectGoDeps(input: GoDepsInput): Promise<GoDepsResult> {
  const notes: string[] = [];
  const empty: GoDepsResult = { text: "", funcsIncluded: 0, signaturesOnly: 0, usedChars: 0, notes };
  const sources = input.sources.filter((s) => s.abs.endsWith(".go"));
  if (sources.length === 0) return empty;

  // 有效上限只能比 DEPS_MAX_CHARS 更小（§4.10：不接受任何入参放大）。
  const cap = Math.max(
    0,
    Math.min(DEPS_MAX_CHARS, input.reconRemaining ?? DEPS_MAX_CHARS),
  );

  try {
    const perCandidateNotes: string[] = [];
    const sections: string[] = [];
    const intro =
      "===== 依赖函数（deps:auto，服务端机械抽取；左侧 `N| ` 为**所在文件**的真实行号）=====\n" +
      "以下函数是上方被附 .go 文件里调用、但定义在其它文件中（或同文件但本次附入区间之外）的 helper：由服务端定位 " +
      "`func Name(` 后**整体**附入，非模型产出。引用时请带文件路径 + 行号。\n" +
      "已知边界（接受漏检/误附）：泛型显式实例化调用、方法表达式/方法值、接口方法、`x.M(` 带点调用一律不处理；" +
      "同名跨包函数可能误附（多处命中时全列签名、只附首个体，非 _test.go 优先）。\n";
    let used = intro.length; // 引导语也计入 cap，保证 usedChars ≤ cap
    let funcsIncluded = 0;
    let signaturesOnly = 0;
    const push = (s: string): void => {
      sections.push(s);
      used += s.length + 1; // 拼接时的换行
    };

    // ── 0. 同文件优先（§12.6 第 4 点）：候选名先在被附文件自身全文里找定义，命中且不在已附区间内
    //    ⇒ 直接从 fullText 切函数体整体附入，不必去 rg；仍找不到才进入下方仓根 rg 候选池。──
    const byRoot = new Map<string, Map<string, Set<string>>>(); // root → name → callers(rel)
    let candidateTotal = 0;
    for (const src of sources) {
      const root = findGoRoot(src.abs);
      const fullText = src.fullText ?? src.body;
      const ownDefs = ownDefLines(fullText);
      const fullLines = fullText.split("\n");
      // 只排除 body 自身内定义的名字（trivially 可见）；fullText-但-body外的定义仍留作候选，
      // 由下方按 ownDefs 分流（同文件直附 / 已可见跳过），不再经 extractCallCandidates 的
      // fullText 参数一律排除。
      const names = extractCallCandidates(src.body);
      if (names.length === 0) continue;
      const callerRel = relative(root, src.abs) || src.abs;
      for (const name of names) {
        candidateTotal++;
        const ownLine = ownDefs.get(name);
        if (ownLine === undefined) {
          // fullText 里也没有这个名字的定义：留给下方仓根 rg。
          const m = byRoot.get(root) ?? new Map<string, Set<string>>();
          const callers = m.get(name) ?? new Set<string>();
          callers.add(callerRel);
          m.set(name, callers);
          byRoot.set(root, m);
          continue;
        }
        if (input.isAttached?.(src.abs, ownLine)) {
          // 定义已在已附材料区间内（trivially 可见）：不是真正的依赖，静默跳过（与此前行为一致——
          // body===fullText 的常见情形下，`extractCallCandidates` 单参调用本就已排除这类名字；
          // 这里额外覆盖"定义在已附的另一段 filesRanges 里"的情形）。
          candidateTotal--;
          continue;
        }
        const body = sliceFuncBody(fullLines, ownLine - 1);
        if (!body) {
          perCandidateNotes.push(`${name} → 无定义（同文件第 ${ownLine} 行找到疑似定义但未找到 gofmt 顶格 \`}\` 收尾）`);
          continue;
        }
        const header = `--- ${name} ← 定义于 ${callerRel}:${ownLine}-${body.endLine}（同文件，本次附入区间之外；函数整体）---\n`;
        const block = header + withLineNumbers(body.text, ownLine);
        if (block.length > DEPS_FUNC_MAX_CHARS) {
          push(
            `--- ${name} ← 定义于 ${callerRel}:${ownLine}（同文件；函数过长（${block.length} 字符 > ${DEPS_FUNC_MAX_CHARS}），仅附签名）---\n` +
              withLineNumbers(fullLines[ownLine - 1] ?? "", ownLine),
          );
          signaturesOnly++;
          perCandidateNotes.push(`${name} → 只附签名（函数过长 ${block.length} 字符 > ${DEPS_FUNC_MAX_CHARS}）`);
          continue;
        }
        if (used + block.length + 1 > cap) {
          push(
            `--- ${name} ← 定义于 ${callerRel}:${ownLine}（同文件；deps 总量已达上限 ${cap} 字符，仅附签名）---\n` +
              withLineNumbers(fullLines[ownLine - 1] ?? "", ownLine),
          );
          signaturesOnly++;
          perCandidateNotes.push(`${name} → 只附签名（deps 总量已达上限 ${cap} 字符）`);
          continue;
        }
        push(block);
        funcsIncluded++;
        perCandidateNotes.push(`${name} → ${callerRel}:${ownLine}-${body.endLine}`);
      }
    }
    if (candidateTotal === 0 && byRoot.size === 0) {
      notes.push("deps：被附 .go 文件中未抽到需定位的未限定调用");
      return empty;
    }

    // ── 仓根 rg：处理同文件未解出的剩余候选 ──
    let unresolved = 0;
    let capHit = false;
    const fileCache = new Map<string, string[] | null>();
    const readLines = (abs: string): string[] | null => {
      if (fileCache.has(abs)) return fileCache.get(abs) ?? null;
      let v: string[] | null = null;
      try {
        v = readFileSync(abs, "utf8").split("\n");
      } catch {
        v = null;
      }
      fileCache.set(abs, v);
      return v;
    };
    for (const [root, nameMap] of byRoot) {
      const names = [...nameMap.keys()];
      const { hits, note } = await rgDefinitions(root, names);
      if (note) notes.push(note);
      if (hits.length === 0) {
        for (const name of names) {
          unresolved++;
          perCandidateNotes.push(`${name} → 无定义`);
        }
        continue;
      }
      const hitsByName = new Map<string, DefHit[]>();
      for (const h of hits) {
        const arr = hitsByName.get(h.name) ?? [];
        arr.push(h);
        hitsByName.set(h.name, arr);
      }
      for (const name of names) {
        const list = hitsByName.get(name);
        if (!list || list.length === 0) {
          unresolved++;
          perCandidateNotes.push(`${name} → 无定义`);
          continue;
        }
        // 非 _test.go 优先（同名测试桩不该抢首位）；其余保持 rg 输出顺序。
        list.sort((a, b) => Number(a.rel.endsWith("_test.go")) - Number(b.rel.endsWith("_test.go")));
        const first = list[0] as DefHit;
        const callers = [...(nameMap.get(name) ?? [])].join(", ");
        const others = list.slice(1);
        const otherLine =
          others.length > 0
            ? `\n（另有 ${others.length} 处同名定义，只附首个；其余签名：${others
                .map((o) => `${o.rel}:${o.line} ${o.sig.trim()}`)
                .join(" ／ ")}）`
            : "";

        // 已在材料里（全文附入 / 行范围覆盖）⇒ 只给指针。
        if (input.isAttached?.(first.abs, first.line)) {
          push(
            `--- ${name} ← 定义于 ${first.rel}:${first.line}（被 ${callers} 调用；**已在上方附件中**，不重复附入）---` +
              otherLine,
          );
          signaturesOnly++;
          perCandidateNotes.push(`${name} → 只附签名（已在附件中，不重复附入）`);
          continue;
        }

        const lines = readLines(first.abs);
        const body = lines ? sliceFuncBody(lines, first.line - 1) : null;
        const sigOnly = (why: string): void => {
          push(
            `--- ${name} ← 定义于 ${first.rel}:${first.line}（被 ${callers} 调用；${why}）---\n` +
              withLineNumbers(first.sig, first.line) +
              otherLine,
          );
          signaturesOnly++;
          perCandidateNotes.push(`${name} → 只附签名（${why}）`);
        };
        if (!lines) {
          sigOnly("文件读取失败，仅附签名");
          continue;
        }
        if (!body) {
          sigOnly("未找到 gofmt 顶格 `}` 收尾或无函数体，仅附签名");
          continue;
        }
        const header = `--- ${name} ← 定义于 ${first.rel}:${first.line}-${body.endLine}（被 ${callers} 调用；函数整体）---\n`;
        const block = header + withLineNumbers(body.text, first.line) + otherLine;
        if (block.length > DEPS_FUNC_MAX_CHARS) {
          sigOnly(`函数过长（${block.length} 字符 > ${DEPS_FUNC_MAX_CHARS}），仅附签名`);
          continue;
        }
        if (used + block.length + 1 > cap) {
          capHit = true;
          sigOnly(`deps 总量已达上限 ${cap} 字符，仅附签名`);
          continue;
        }
        push(block);
        funcsIncluded++;
        perCandidateNotes.push(`${name} → ${first.rel}:${first.line}-${body.endLine}`);
      }
    }

    if (sections.length === 0) {
      notes.push(...perCandidateNotes);
      if (unresolved > 0) notes.push(`deps：${unresolved} 个候选在仓根内无 \`func Name(\` 定义命中（局部闭包/跨包/类型转换等），未附入`);
      return { ...empty, notes };
    }

    const text = intro + sections.join("\n");
    const summary =
      `deps：整体附入 ${funcsIncluded} 个函数，${signaturesOnly} 个只附签名` +
      (capHit ? `（总量触顶 ${cap} 字符）` : "") +
      (unresolved > 0 ? `，${unresolved} 个候选无定义命中` : "") +
      `，共 ${text.length} 字符`;
    // §12.6 第 4 点：notes 从「只给计数」改为逐条（第 4 轮「7 个候选无定义命中」无法排查）；
    // 汇总行仍保留在末尾，供既有消费方宽松匹配。
    notes.push(...perCandidateNotes, summary);
    return { text, funcsIncluded, signaturesOnly, usedChars: text.length, notes };
  } catch (err) {
    notes.push(`deps 跳过：${err instanceof Error ? err.message : String(err)}`);
    return { ...empty, notes };
  }
}
