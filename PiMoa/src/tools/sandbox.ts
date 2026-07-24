/**
 * OS 级沙箱执行（verify 主 containment）—— macOS `sandbox-exec` + SBPL。
 *
 * ── 为什么是这里的「主」防线 ─────────────────────────────────────────────
 * verify 要**验证可利用性**（真跑取证命令、复现漏洞），不能只读代码；但它审的是
 * **不可信仓库**，而 MCP server 进程 env 里有真实 API key。故命令执行必须关进沙箱：
 *   1) **无网络** —— 断凭证外泄与外联（bsd.sb/system.sb 默认拒绝 network*）。
 *   2) **写只允许落 scratch** —— 每次调用新建一个临时目录，写面仅此 + /dev/null。
 *   3) **读只允许 target(=cwd) + scratch + 运行二进制所需系统只读路径** —— 默认拒绝，
 *      显式再 `(deny file-read* (subpath $HOME))` 兜底屏蔽 ~/.ssh /~/.aws /~/.hermes，
 *      并 deny /etc；**读不到任何用户秘密与 config/auth.json**（后者不在 target 下）。
 *   4) **env 从零构建** —— 子进程只拿到白名单变量（PATH/HOME/TMPDIR/LANG + git 硬化），
 *      **天然剥除所有 *_API_KEY / *TOKEN* / *SECRET* 继承变量**（沙箱本身不剥 env，必须父进程做）。
 * 沙箱对**子孙进程全生效**：即便命令层漏判触发 RCE（git filter-branch/敌意 .git/config 的
 * diff.external 等），被 exec 的攻击代码同样跑在此围栏内——无网络、读不到密钥、写不出 scratch。
 *
 * ── 选型：为何 `sandbox-exec` 而非 `@anthropic-ai/sandbox-runtime` ────────────
 *  - sandbox-runtime 的执行模型是 `spawn("bash","-c",wrapWithSandbox(cmd))`，**重新引入 shell**，
 *    与本工具「execFile shell:false + 已解析 argv」的安全模型冲突（会把词法层防线让出去）。
 *  - 它面向「**域名白名单 + 本地网络代理**」，需重型 async 全局 `SandboxManager.initialize()`
 *    （起代理 / 装证书）——而我们要的是**彻底无网络**，那套机制是额外失败面而非收益。
 *  - 它是 pi 的 devDep（0.0.26，npm 最新 0.0.67，跨版本 API 漂移），本项目未安装。
 *  - 原生 `sandbox-exec` 常驻 /usr/bin，稳定、可逐字符审计的 SBPL、无异步初始化、
 *    保住 execFile shell:false 不变量、可精确表达「无网络 + 读白名单 + 写限 scratch」。
 * 故主路径选原生 `sandbox-exec`。**非 darwin 或缺 sandbox-exec ⇒ fail-closed 拒绝执行**
 * （不降级为无沙箱裸跑；宁可误拒不可误放）。
 */
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 原生沙箱可执行文件（macOS）。 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * 解析命令二进制用的**可信 PATH**（固定绝对目录，绝不含 cwd / 用户可写目录）——
 * 命令名一律解析成这些目录下的绝对路径，杜绝 PATH 劫持（审计 🟡 / B5）。
 */
export const TRUSTED_BIN_DIRS: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/**
 * 运行/链接二进制所需的**系统只读子路径**（非秘密）。bsd.sb 已管 dyld/系统基础，
 * 这里补 Xcode 工具链（git 依赖）与 Homebrew（rg 等）。
 */
const SYSTEM_READ_SUBPATHS: readonly string[] = [
  "/Library/Developer",
  "/opt/homebrew",
  "/usr/local",
  "/Library/Apple",
];

/**
 * `git` 优先用的**真实 CLT 二进制**（绕开 /usr/bin/git 这个 xcode shim——
 * 后者要经 xcrun 往系统 TMPDIR 写 xcrun_db 缓存，与「只写 scratch」冲突且会失败）。
 */
const GIT_REAL_CANDIDATES: readonly string[] = [
  "/Library/Developer/CommandLineTools/usr/bin/git",
];

/** 平台与二进制就绪 ⇒ 沙箱可用。非 darwin / 缺 sandbox-exec ⇒ false（调用方 fail-closed）。 */
export function isSandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 命令名 → 可信绝对路径。只查固定 TRUSTED_BIN_DIRS（防 PATH 劫持）。
 * `git` 优先取真实 CLT 路径（绕 xcode shim 的 xcrun 写需求）。查不到返回 null。
 */
export function resolveCommandPath(name: string): string | null {
  if (name === "git") {
    for (const c of GIT_REAL_CANDIDATES) {
      if (isExecutable(c)) return c;
    }
    // 落空则退回可信 PATH（可能是 /usr/bin/git shim）——仍在下方通用查找里处理。
  }
  for (const d of TRUSTED_BIN_DIRS) {
    const p = join(d, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** SBPL 字符串字面量转义（路径可能含空格/引号/反斜杠）。 */
function sbplString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 SBPL profile：默认拒绝（继承 bsd.sb）+ 允许 exec/fork + 读白名单（系统只读 + target + scratch）
 * + 显式屏蔽 $HOME 与 /etc + 写白名单（仅 scratch 与 /dev/null）。
 * 排列讲究「后者覆盖」（last-match-wins）：先 deny $HOME，再 allow target/scratch ——
 * 即便 target 落在 $HOME 之下，也因 allow 在后而可读，而 $HOME 其余（含 ~/.ssh）仍被拒。
 */
export function buildSandboxProfile(targetDir: string, scratchDir: string): string {
  const target = realpathOrSelf(targetDir);
  const scratch = realpathOrSelf(scratchDir);
  const home = process.env.HOME ? realpathOrSelf(process.env.HOME) : "";

  const sysRead = SYSTEM_READ_SUBPATHS.map((p) => `(subpath ${sbplString(p)})`).join(" ");

  const lines = [
    "(version 1)",
    '(import "bsd.sb")',
    "(allow process-fork)",
    "(allow process-exec*)",
    `(allow file-read* ${sysRead})`,
  ];
  // 显式屏蔽（覆盖 bsd.sb 可能放行的元数据/宽读）：整棵 $HOME + /etc。
  if (home) lines.push(`(deny file-read* (subpath ${sbplString(home)}))`);
  lines.push('(deny file-read* (subpath "/private/etc") (literal "/etc"))');
  // 读白名单（放在 deny 之后 ⇒ target/scratch 即便在 $HOME 下也可读）。
  lines.push(`(allow file-read* (subpath ${sbplString(target)}) (subpath ${sbplString(scratch)}))`);
  // 写白名单：仅 scratch 与 /dev/null。
  lines.push(`(allow file-write* (subpath ${sbplString(scratch)}) (literal "/dev/null"))`);
  return lines.join("\n");
}

/**
 * 子进程 env **从零构建**（不继承父进程任何变量）——
 * 天然剥除所有 *_API_KEY / *TOKEN* / *SECRET* 等敏感继承变量。
 * 只注入运行取证命令所需的白名单变量 + git 硬化（闭合 RCE#4：禁 system/global 配置与外部 diff/textconv）。
 */
export function buildSandboxEnv(scratchDir: string): NodeJS.ProcessEnv {
  return {
    PATH: TRUSTED_BIN_DIRS.join(":"),
    HOME: scratchDir, // 空 HOME：git 找不到全局配置；也让 ~ 展开落到无害 scratch。
    TMPDIR: scratchDir,
    LANG: process.env.LANG ?? "C",
    // ── git 硬化（RCE#4 纵深防御第二/三道）──
    GIT_CONFIG_NOSYSTEM: "1", // 禁 /etc/gitconfig
    GIT_CONFIG_GLOBAL: "/dev/null", // 禁 ~/.gitconfig
    GIT_ATTR_NOSYSTEM: "1", // 禁 system gitattributes（textconv/filter 注入面）
    GIT_EXTERNAL_DIFF: "", // 清空外部 diff 驱动
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export interface SandboxedInvocation {
  /** execFile 的可执行文件（sandbox-exec）。 */
  file: string;
  /** execFile 的参数：-p <profile> <绝对命令> <原参数...>。 */
  args: string[];
  /** 子进程 env（从零构建，无密钥）。 */
  env: NodeJS.ProcessEnv;
  /** 沙箱执行的 cwd（= target；读白名单已含，getcwd 可用）。 */
  cwd: string;
  /** 用后清理临时 scratch 目录（务必在 finally 调用）。 */
  cleanup: () => void;
}

export interface SandboxBuildError {
  error: string;
}

/**
 * 把已解析、已过策略闸的 argv 包装成沙箱化调用：
 *  - 解析 argv[0] → 可信绝对路径（防 PATH 劫持）；查不到 ⇒ error。
 *  - 新建一次性 scratch 目录（写面）。
 *  - 生成 SBPL profile（读/写/网络围栏）与从零 env。
 * 返回 { file, args, env, cwd, cleanup } 或 { error }。
 */
export function buildSandboxedInvocation(
  argv: string[],
  cwd: string,
): SandboxedInvocation | SandboxBuildError {
  if (!isSandboxAvailable()) {
    return {
      error:
        "沙箱不可用（需 macOS 且 /usr/bin/sandbox-exec 存在）——fail-closed 拒绝执行，绝不无沙箱裸跑。",
    };
  }
  const [name, ...rest] = argv;
  const abs = resolveCommandPath(name);
  if (!abs) {
    return { error: `命令 '${name}' 无法在可信 PATH 中解析为绝对路径（防 PATH 劫持）。` };
  }

  const scratch = mkdtempSync(join(tmpdir(), "pimoa-verify-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  const profile = buildSandboxProfile(cwd, scratch);
  const env = buildSandboxEnv(scratch);
  return {
    file: SANDBOX_EXEC,
    args: ["-p", profile, abs, ...rest],
    env,
    cwd,
    cleanup,
  };
}

/** 供路径 jail 复用：把 `~` 展开成真实家目录（仅用于**检测**逃逸意图；执行时 ~ 仍原样字面传参）。 */
export function expandTildeForCheck(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith("~/")) return join(homedir(), token.slice(2));
  return token;
}
