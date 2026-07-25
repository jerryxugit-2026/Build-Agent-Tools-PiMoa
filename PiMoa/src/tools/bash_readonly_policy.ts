/**
 * bash_readonly 的**安全内核**：把一条 bash 命令串判成「放行 + argv」或「拒绝 + 原因」。
 *
 * 纯函数、无 I/O、无 pi/typebox 依赖 —— 便于逐条单测（test/bash_readonly.test.ts）。
 * 判决被工具本体（bash_readonly.ts）复用：只有 analyze().allowed 才 execFile(argv, {shell:false})。
 *
 * ── 方案（详见汇报 + reviews/04_permission_eval.md）───────────────────────────
 * 采用「**保守严格的 quote-aware 结构拒绝** + 命令 allowlist + 每命令 flag denylist」，
 * 不引 web-tree-sitter(WASM)。理由（安全权衡）：
 *  1) refs/pi-permission-system 的 tree-sitter 路径**本身堵不干净写重定向**
 *     （`git diff > f` 的 `>` 目标被 command-enumeration SKIP 出命令文本，白名单命令带 `>` 会漏，
 *      见 04_permission_eval「关键缺口」）——用它仍必须自己再扫一遍 redirect 节点，
 *     tree-sitter 并不省掉安全关键的那一步。
 *  2) 一旦「任何未加引号的结构/重定向/展开元字符」在词法层就整串拒，
 *     到达 allowlist 的必是**单条、无操作符**的 simple command，此后 tree-sitter 不再增加安全，
 *     只增加 async WASM 初始化的失败面（headless 下 init 失败=回退，需保证回退 fail-closed）。
 *  3) 同步、确定、可逐字符审计，契合「宁可误拒不可误放」。
 * 纵深防御：判决产出 argv 后，工具本体用 `execFile(cmd, args, {shell:false})` **不经 shell** 执行，
 *  即使词法层漏了某元字符，也不会被 shell 解释成重定向/串接/展开（元字符只会当字面量传给程序）。
 */

// ── 取证只读命令 allowlist（Hermes §4.2 只读取证集）───────────────────────────
/** 首 token（basename）必须 ∈ 此集。allowlist 非 denylist：新命令默认拒。 */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // 版本控制取证（子命令再收窄，见 GIT_READONLY_SUBCOMMANDS）
  "git",
  // 哈希 / 校验
  "sha256sum",
  "sha1sum",
  "sha224sum",
  "sha384sum",
  "sha512sum",
  "md5",
  "md5sum",
  "shasum",
  "cksum",
  "b2sum",
  // 文件元数据 / 度量
  "stat",
  "file",
  "wc",
  "readlink",
  "realpath",
  "du",
  "df",
  // 目录 / 内容只读查看
  "ls",
  "cat",
  "head",
  "tail",
  "rg",
  "pwd",
  "echo",
  // ── 检索矩阵（2026-07-25 徐总，全量方案，见架构文档 §4.8）──
  // find/grep 已下线：文本/找文件→rg；代码结构→ast-grep；紧凑读→rtk。三者子命令/flag 再收窄（见下）。
  "ast-grep",
  "rtk",
]);

/** 已下线命令 → 引导替代（find/grep 归 rg/ast-grep/rtk，§4.8）。给可执行提示而非干拒。 */
const REMOVED_COMMAND_HINTS: Record<string, string> = {
  grep: "grep 已下线：文本搜索改用 `rg`（更快、跳 .gitignore、输出紧凑、已过安全审）",
  find: "find 已下线：找文件用 `rg --files -g '<glob>'`；找代码结构用 `ast-grep run -p '<模式>' -l <lang>`；紧凑列目录用 `rtk ls`",
};

/** `git` 只放行只读子命令（写子命令 commit/checkout/config/tag/... 一律拒）。 */
export const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "status",
  "log",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "show-ref",
  "for-each-ref",
  "symbolic-ref",
  "grep",
  "reflog",
]);

/**
 * `git` **子命令后**的危险选项（可绕成写/执行任意程序），逐条**大小写敏感**、覆盖粘连取值形态：
 *  -c core.pager=… / -c diff.external=… / --config-env=… → 借配置注入执行外部命令；
 *  -o<file> / --output[=…] → 写文件；-O<program>（git grep）/ --open-files-in-pager[=…] → 执行程序（RCE#3）；
 *  --exec-path → 改二进制搜索路径；--ext-diff → 跑外部 diff 工具；
 *  --upload-pack/--receive-pack → 指定执行程序；任何含 "pager" 的选项。
 * ★RCE#3：旧实现只拦精确小写 `-o` 且靠含 "pager" 子串 → `git grep -O<程序>` 漏。现改**选项级大小写敏感**、
 *   拦 `-o`/`-O` 前缀（粘连取值），并对 `-O<program>` 这类不含 "pager" 字样的短选项一并拦下。
 * 注：全局带值 flag（`-c`/`--git-dir` 等）现由 analyzeCommand 的**严格位置解析**在子命令前一律拒，
 *   本函数只审「子命令后」的选项（闭合 RCE#1）。
 */
function isDangerousGitArg(arg: string): boolean {
  // 配置注入（-c / --config-env）——即使我们已禁前置全局 flag，子命令后出现也拒。
  if (arg === "-c") return true;
  if (arg === "--config-env" || arg.startsWith("--config-env=")) return true;
  if (arg === "-C") return true;
  // 短选项 -o<file>（写）/ -O<program>（git grep 执行）：大小写敏感、含粘连取值。
  // 单破折号簇：`-o…` / `-O…`（`--oneline` 是双破折号，不匹配 startsWith("-o")）。
  if (arg.startsWith("-o") || arg.startsWith("-O")) return true;
  // 长选项写/执行面。
  if (arg === "--output" || arg.startsWith("--output")) return true;
  if (arg.startsWith("--open-files-in-pager")) return true;
  if (arg === "--exec-path" || arg.startsWith("--exec-path=")) return true;
  if (arg === "--ext-diff") return true;
  if (arg.startsWith("--upload-pack") || arg.startsWith("--receive-pack")) return true;
  // 任何 pager 相关（core.pager / --paginate 等残余面）。
  if (arg.toLowerCase().includes("pager")) return true;
  return false;
}

/**
 * `git` 渲染 diff 的只读子命令 —— 对它们注入 `--no-ext-diff --no-textconv`（RCE#4 命令级防御）：
 * 中和**敌意仓库本地 .git/config** 的 `diff.external` / textconv 驱动（GIT_CONFIG_NOSYSTEM/GLOBAL
 * 管不到 repo-local 配置，故必须命令级 --no-ext-diff）。
 */
const GIT_DIFF_RENDER_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "show", "log"]);

/**
 * 注入到**所有** git 命令（子命令前）的可信 `-c` 硬化配置：禁掉 repo-local 配置里其它 exec 向量
 * （fsmonitor / hooks / sshCommand / ext 协议）。这些是**我们**注入的可信全局 flag（在策略放行之后拼装），
 * 不与「禁用户前置全局 flag」冲突。纵深防御——即便触发，沙箱也已围住。
 */
const GIT_HARDENING_CONFIG: readonly string[] = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=false",
  "-c",
  "protocol.ext.allow=never",
];

/** `rg` 危险 flag：`--pre`/`--pre-glob` 执行外部预处理程序、`--hostname-bin` 执行程序、`--config` 加载任意配置（内含 --pre 等）。 */
const RG_DENY_FLAGS: readonly string[] = ["--pre", "--pre-glob", "--hostname-bin", "--config"];

/** `file` 写/自定义 magic 原语：`-C`/`--compile` 编译写 .mgc，`-m`/`--magic-file` 载入任意 magic。 */
const FILE_DENY_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "--compile",
  "-m",
  "--magic-file",
]);

/**
 * `rtk` 只放行**纯读**子命令。rtk 本质是命令代理——`err/test/summary/docker/kubectl/wget/aws/psql/
 * pnpm/dotnet/gh/env/deps/smart/init` 能任意执行命令/联网/写配置（等于 `bash -c`），`git` 在沙箱内因
 * xcrun 缓存写被拒（沙箱可行性实测 code=129），`grep/find` 归 rg/ast-grep —— 均**不列入**。
 */
export const RTK_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "tree",
  "json",
  "wc",
]);

/** `ast-grep` 唯一放行子命令（默认命令，裸 `-p` 起手亦走它）。scan/new/test/lsp/completions 写盘/加载规则/常驻 → 拒。 */
const ASTGREP_ALLOWED_SUBCOMMAND = "run";
/** `ast-grep run` 的写/交互/外部配置 flag：改代码 / 原地更新 / 交互式应用 / 加载外部 sgconfig，一律拒（保持纯只读搜索）。 */
const ASTGREP_DENY_FLAGS: readonly string[] = [
  "-U",
  "--update-all",
  "-r",
  "--rewrite",
  "-i",
  "--interactive",
  "--config",
];

/** `tail -f` 类会阻塞挂起（非安全但会吊死 headless 会话），一并拒。 */
const TAIL_DENY_FLAGS: ReadonlySet<string> = new Set(["-f", "-F", "--follow"]);

// ── 词法：quote-aware 结构拒绝 ────────────────────────────────────────────────
/**
 * 未加引号时即判为「制造第二条命令 / 写 / 执行 / 展开」的结构元字符 —— 命中即拒：
 *   >  <   重定向
 *   |      管道（管道右侧可写，如 tee）
 *   ;      串接
 *   &      后台 / && || 串接
 *   ( )    子 shell
 *   { }    brace group / brace 展开
 *   ` $    命令替换 / 变量展开（$( ) `…` ${ }）
 *   \      转义 / 续行
 *   换行/回车/其它控制字符
 * 单引号内一切字面（含 $ ` 均不展开）；双引号内仅 $ ` \ 仍活跃（命令替换/展开），故双引号内命中它们也拒。
 */
const STRUCTURAL_OUTSIDE = new Set([
  ">",
  "<",
  "|",
  ";",
  "&",
  "(",
  ")",
  "{",
  "}",
  "`",
  "$",
  "\\",
]);

export interface TokenizeOk {
  ok: true;
  tokens: string[];
}
export interface TokenizeReject {
  ok: false;
  reason: string;
}
export type TokenizeResult = TokenizeOk | TokenizeReject;

/**
 * quote-aware 分词：把命令串拆成 argv，同时对任何**未加引号的结构/重定向/展开元字符**
 * fail-closed 拒绝。不做任何 shell 展开（execFile shell:false 会原样传参）。
 */
export function tokenize(command: string): TokenizeResult {
  type State = "none" | "single" | "double";
  let state: State = "none";
  const tokens: string[] = [];
  let cur = "";
  let hasTok = false; // 当前是否已开一个 token（区分空 token 如 '' ）

  const push = () => {
    if (hasTok) {
      tokens.push(cur);
      cur = "";
      hasTok = false;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const code = command.charCodeAt(i);

    if (state === "single") {
      if (c === "'") {
        state = "none";
      } else {
        cur += c;
        hasTok = true;
      }
      continue;
    }

    if (state === "double") {
      if (c === '"') {
        state = "none";
      } else if (c === "$" || c === "`" || c === "\\") {
        // 双引号内命令替换/变量展开/转义仍活跃 → 拒。
        return {
          ok: false,
          reason: `双引号内活跃元字符 '${c}'（命令替换/展开）被拒`,
        };
      } else {
        cur += c;
        hasTok = true;
      }
      continue;
    }

    // state === "none"
    if (c === "'") {
      state = "single";
      hasTok = true; // '' 也算一个（空）token
      continue;
    }
    if (c === '"') {
      state = "double";
      hasTok = true;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === "\r") {
      return { ok: false, reason: "命令含换行（多命令行）被拒" };
    }
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, reason: "命令含控制字符被拒" };
    }
    if (STRUCTURAL_OUTSIDE.has(c)) {
      return {
        ok: false,
        reason: `未加引号的结构/重定向/展开元字符 '${c}' 被拒（重定向/管道/串接/子shell/命令替换）`,
      };
    }
    cur += c;
    hasTok = true;
  }

  if (state !== "none") {
    return { ok: false, reason: "引号未闭合（不可解析）被拒" };
  }
  push();

  if (tokens.length === 0) {
    return { ok: false, reason: "空命令被拒" };
  }
  return { ok: true, tokens };
}

// ── 命令名合法性：只允许裸 basename ──────────────────────────────────────────
/** 首 token 必须是裸命令名（无 `/`、无 `=`、无引号残留），杜绝 `/bin/sh`、`FOO=bar cmd`。 */
const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_.+-]*$/;

export interface AnalyzeAllow {
  allowed: true;
  /** 直接可交 execFile 的 argv（argv[0]=命令名）。 */
  argv: string[];
}
export interface AnalyzeReject {
  allowed: false;
  reason: string;
}
export type AnalyzeResult = AnalyzeAllow | AnalyzeReject;

/**
 * 判一条命令串：全部通过 → { allowed:true, argv }；任一不过 → { allowed:false, reason }。
 * fail-closed：不可解析 / 首 token 不在 allowlist / 命中任何写·执行面 → 拒。
 */
export function analyzeCommand(command: string): AnalyzeResult {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: false, reason: "空命令被拒" };
  }

  const tok = tokenize(command);
  if (!tok.ok) return { allowed: false, reason: tok.reason };

  const [name, ...args] = tok.tokens;

  if (!COMMAND_NAME_RE.test(name)) {
    return {
      allowed: false,
      reason: `命令名非法 '${name}'（须裸命令名，禁路径/赋值前缀/引号）`,
    };
  }
  if (!ALLOWED_COMMANDS.has(name)) {
    return {
      allowed: false,
      reason: REMOVED_COMMAND_HINTS[name] ?? `命令 '${name}' 不在只读取证 allowlist`,
    };
  }

  // ── 每命令收窄 ──
  if (name === "git") {
    // ★RCE#1 严格位置解析：`git` 后第一个 token 必须**直接**是只读子命令，
    // 任何前置全局 flag（`-c`/`--git-dir`/`--work-tree`/`--namespace`/`--attr-source` 等，
    // 无论是否带值）一律拒 —— 杜绝「全局带值选项吞掉假子命令」绕过。
    if (args.length === 0) {
      return { allowed: false, reason: "git 缺子命令被拒" };
    }
    const sub = args[0];
    if (sub.startsWith("-")) {
      return {
        allowed: false,
        reason: `git 前置全局 flag '${sub}' 被拒（子命令必须紧跟 git，禁一切前置全局选项）`,
      };
    }
    if (!GIT_READONLY_SUBCOMMANDS.has(sub)) {
      return { allowed: false, reason: `git 子命令 '${sub}' 非只读，被拒` };
    }
    // 子命令后的选项逐条审危险面（-o/-O/--output/--ext-diff/pager/--config-env/…）。
    for (const a of args.slice(1)) {
      if (isDangerousGitArg(a)) {
        return { allowed: false, reason: `git 危险参数 '${a}' 被拒` };
      }
    }
    // 放行 —— 拼装**硬化后的 argv**：注入可信 -c 硬化配置 + （diff 类）--no-ext-diff --no-textconv。
    const injected: string[] = [name, ...GIT_HARDENING_CONFIG, sub];
    if (GIT_DIFF_RENDER_SUBCOMMANDS.has(sub)) {
      injected.push("--no-ext-diff", "--no-textconv");
    }
    injected.push(...args.slice(1));
    return { allowed: true, argv: injected };
  } else if (name === "rtk") {
    // rtk 是命令代理（§4.8）：仿 git 严格子命令白名单——只放纯读 read/ls/tree/json/wc，
    // 拒一切前置全局 flag 与其余子命令（git 沙箱跑不了、grep/find 归 rg/ast-grep、err/test/
    // summary/docker/... 能任意执行）。子命令后仅路径参数（越界/硬链接由 bash_readonly.ts jail 兜）。
    if (args.length === 0) {
      return { allowed: false, reason: "rtk 缺子命令被拒" };
    }
    const sub = args[0];
    if (sub.startsWith("-")) {
      return {
        allowed: false,
        reason: `rtk 前置全局 flag '${sub}' 被拒（子命令必须紧跟 rtk）`,
      };
    }
    if (!RTK_READONLY_SUBCOMMANDS.has(sub)) {
      return {
        allowed: false,
        reason: `rtk 子命令 '${sub}' 非纯读或沙箱不可用，被拒（仅放 ${[...RTK_READONLY_SUBCOMMANDS].join("/")}；搜索用 rg/ast-grep、git 走 bash_readonly 的 git）`,
      };
    }
  } else if (name === "ast-grep") {
    // 只放只读搜索：默认 run（裸 -p 起手）或显式 `run`；scan/new/test/lsp/completions（写盘/加载
    // 规则/常驻）一律拒。写/交互/外部配置 flag 拒（保持纯只读搜索，不改代码、不载 sgconfig）。
    const first = args[0];
    if (first !== undefined && !first.startsWith("-") && first !== ASTGREP_ALLOWED_SUBCOMMAND) {
      return {
        allowed: false,
        reason: `ast-grep 子命令 '${first}' 被拒（仅放只读搜索 'run' 或裸 -p 起手；scan/new/test/lsp 会写盘/加载规则/常驻）`,
      };
    }
    for (const a of args) {
      // ★对抗审 #7：`--config` 的**短别名 `-c`**（全形态 `-c` / `-c=x` / `-cx` 粘连取值）——
      //   漏它即可 `ast-grep run -c evil.yml` 加载任意 sgconfig → customLanguages 动态库 RCE。
      //   ast-grep run 里小写 `-c` 唯一含义即 config（上下文是大写 -A/-B/-C），故 `-c` 起手一律拒。
      if (a.startsWith("-c")) {
        return {
          allowed: false,
          reason: `ast-grep 外部配置参数 '${a}'（-c=--config 短别名）被拒（可加载任意 sgconfig/动态库）`,
        };
      }
      for (const bad of ASTGREP_DENY_FLAGS) {
        if (a === bad || a.startsWith(bad + "=")) {
          return {
            allowed: false,
            reason: `ast-grep 写/交互/外部配置参数 '${a}' 被拒（保持纯只读搜索，不改代码/不载外部 sgconfig）`,
          };
        }
      }
    }
  } else if (name === "rg") {
    // ★RCE#2：rg 无 flag denylist → `rg --pre <程序>` 任意程序执行。补 denylist（含 `--flag=value` 形态）。
    for (const a of args) {
      for (const bad of RG_DENY_FLAGS) {
        if (a === bad || a.startsWith(bad + "=")) {
          return { allowed: false, reason: `rg 危险参数 '${a}' 被拒（可执行外部程序/加载任意配置）` };
        }
      }
    }
  } else if (name === "file") {
    for (const a of args) {
      if (FILE_DENY_FLAGS.has(a)) {
        return { allowed: false, reason: `file 写/自定义 magic 参数 '${a}' 被拒` };
      }
    }
  } else if (name === "tail") {
    for (const a of args) {
      // 长选项精确匹配；单破折号簇里含 f/F（如 `-qf`）也判 follow（会挂起）。
      // GNU 长式 `--follow` / `--follow=name` 短簇正则不匹配、需显式拦（否则 GNU tail 会挂起）。
      if (
        TAIL_DENY_FLAGS.has(a) ||
        a === "--follow" ||
        a.startsWith("--follow=") ||
        /^-[A-Za-z]*[fF]/.test(a)
      ) {
        return { allowed: false, reason: `tail follow 参数 '${a}' 被拒（会挂起）` };
      }
    }
  }

  return { allowed: true, argv: tok.tokens };
}
