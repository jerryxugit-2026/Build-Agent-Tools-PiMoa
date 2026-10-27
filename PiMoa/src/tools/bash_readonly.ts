/**
 * `bash_readonly` —— verify-worker 的**命令级只读取证工具**（安全关键）。
 *
 * 给一条 bash 命令串 → analyzeCommand（bash_readonly_policy.ts）判：
 *   - 只有全部 token ∈ 只读取证 allowlist 且无写/执行/重定向面才 { allowed:true, argv }；
 *   - 任何 file_redirect(`>`/`>>`)、pipe 写、wrapper(`bash -c`/`eval`/`sudo`/`xargs`/`find -exec`)、
 *     命令替换 `$()`/反引号、`;`/`&&`/`||` 串接、不可解析 → fail-closed 拒。
 * 放行后**在 macOS `sandbox-exec` OS 级沙箱内**用 **execFile(sandbox-exec, [-p profile, 绝对命令, …args], { shell:false })**
 * 执行（sandbox.ts）——沙箱是**主 containment**：无网络（断凭证外泄）、写限一次性 scratch、读限 target(=cwd)+scratch
 * （读不到 ~/.ssh、~/.aws、~/.hermes/config.yaml、config/auth.json）、env 从零构建剥掉所有 *_API_KEY/TOKEN/SECRET。
 * 命令层 allowlist/denylist + execFile shell:false + 路径 jail 是**纵深防御第二道**（即便词法漏判或触发 RCE，
 * 攻击代码也被沙箱围住：无网络、读不到密钥、写不出 scratch）。沙箱不可用（非 darwin/缺 sandbox-exec）⇒ fail-closed 拒执行。
 *
 * ★防孙 agent 不变量（DESIGN §5）：本工具经 createAgentSession 的 `customTools:[bashReadonlyTool]`
 * 直接注入，**不走 ResourceLoader 扩展系统**（isolated loader 仍 noExtensions），故不给扩展
 * registerTool 注入派生工具的机会；工具结果**从不设 addedToolNames**（不向会话引入任何新工具），
 * execute 只 execFile 只读命令（无 spawn agent CLI、无写、无 MCP）。详见汇报。
 */
import { TOOL_SLICE_CHARS } from "../config/limits.js";
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeCommand } from "./bash_readonly_policy.js";
import { PAPER_SYSTEM_ROOT } from "./devkb_search.js";
import { effectiveReadRoots, isWithinRoots, secretDenyReason } from "./access.js";
import { buildSandboxedInvocation, expandTildeForCheck } from "./sandbox.js";
import {
  budgetCrossedNotice,
  budgetMaxChars,
  createRetrievalBudget,
  releaseBudget,
  reserveBudget,
  settleBudget,
  type RetrievalBudget,
} from "./budget.js";

// 预算相关符号从 ./budget.js 统一导出（测试与 read 工具共用同一本账）。
export {
  createRetrievalBudget,
  SESSION_OUTPUT_CHAR_BUDGET,
  SESSION_TOKEN_BUDGET,
  type RetrievalBudget,
} from "./budget.js";

/** 单次执行硬上限：防大输出 / 挂起。 */
const EXEC_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_OUTPUT_CHARS = TOOL_SLICE_CHARS; // 统一单次取证输出上限(limits.ts,v4 §4.3;原 60_000)

interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted?: boolean;
  spawnError?: string;
}

/**
 * 在**沙箱内**执行已过策略闸的 argv：
 *  - buildSandboxedInvocation 把 argv[0] 解析成可信绝对路径、建一次性 scratch、拼 SBPL profile + 从零 env；
 *  - execFile(sandbox-exec, [-p profile, absCmd, ...args], { shell:false, timeout, maxBuffer, env })；
 *  - finally 清理 scratch。
 * 沙箱不可用（非 darwin / 缺 sandbox-exec）⇒ fail-closed，返回 spawnError（绝不无沙箱裸跑）。
 */
function runArgv(
  argv: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  readRoots: readonly string[] = [],
): Promise<ExecOutcome> {
  const built = buildSandboxedInvocation(argv, cwd, readRoots);
  if ("error" in built) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", spawnError: built.error });
  }
  const { file, args, env, cwd: runCwd, cleanup } = built;
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      {
        cwd: runCwd,
        shell: false, // ★绝不经 shell：无重定向/串接/展开解释（沙箱之外的第二道）
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        signal,
        env, // 从零构建：无任何 *_API_KEY/TOKEN/SECRET 继承（见 sandbox.ts）
      },
      (err, stdout, stderr) => {
        cleanup();
        const out = stdout ?? "";
        const errout = stderr ?? "";
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolvePromise({
            code: null,
            stdout: out,
            stderr: errout,
            spawnError: `沙箱或命令不存在：${file}`,
          });
          return;
        }
        // 非零退出（如 grep 无匹配 exit1）不是工具失败：照回 stdout/stderr。
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? null
              : 0;
        // abort（signal 触发，code='ABORT_ERR'）单独打标：别让中止伪装成"(无输出)"
        const aborted = (err as { code?: unknown } | null)?.code === "ABORT_ERR";
        resolvePromise({ code, stdout: out, stderr: errout, ...(aborted ? { aborted: true } : {}) });
      },
    );
  });
}

/**
 * ★路径 jail（审计 🟠#7 / 任务 C）——沙箱之外的**第二道**，两项检查：
 *
 * (A) **硬链接读逃逸**（★2026-07-26 起**默认关闭**，须显式 `{hardlinkGuard:true}` 才启用）：
 *     `realpath` 不解析硬链接，沙箱按**路径**放行——故 cwd 内一个硬链接指向 cwd 外/`$HOME` 下**同卷**
 *     秘密文件时，`cat hardlink` 能读出秘密并经 stdout 进 proposal 外泄。对**每个将被读取的路径参数
 *     （含裸文件名，如 `cat hl_secret` 的 `hl_secret`）** 做 `statSync`，若「常规文件且 `nlink > 1`」即拒。
 *
 *     ⚠️ **为何改为默认关（徐总 2026-07-26 定）**：原注释称「正常源码仓库文件 nlink 恒为 1，误伤面极小」，
 *     此前提在本机**不成立**。实测本卷（<volume>，APFS）：
 *       · Paper System 54,276 个、PiMoa 3,417 个常规文件 nlink=2——go.mod / package.json / DESIGN.md 无一幸免；
 *       · 同卷新建文件 nlink=1 ⇒ 非文件系统假象，是真实的第二条链接；
 *       · 全卷 inode 追踪定位到它：`<workspace>/workspace/.tmp.driveupload/<id>`
 *         ——**Google Drive 桌面版的上传暂存目录**（卷顶层的 GoogleSyncFolder/ 佐证）。
 *     即本机 `nlink>1` 的真实含义是「Google Drive 同步过此文件」，与逃逸无关。
 *     后果：本检查在此环境**误报率 100%**，proposer 经 read_budgeted / bash_readonly **读不到任何文件**
 *     （实证：两个 proposer 全程无法读取；聚合器改用目录级 `rg` 绕开后正常取证）。
 *
 *     ⚠️ **关闭的代价（如实记录，勿粉饰）**：test/bash_readonly_sandbox.test.ts 有可工作的 PoC，
 *     证明关闭后 `cat <cwd 内指向 cwd 外的硬链接>` 确实能读出秘密。接受该风险的依据：
 *       ① 子 agent 严格只读——ALLOWED_COMMANDS 无 `ln`、沙箱禁写，**它自己造不出这种硬链接**；
 *       ② PiMoa 仅在本机单用户环境运行，能预先埋链接者已具备远超此路径的权限；
 *       ③ 误伤代价是工具完全不可用，收益是防一个本环境不成立的威胁。
 *
 *     ⚠️ **另一个既有缺口（开关与否都存在）**：本检查仅对 `st.isFile()` 生效（目录 nlink 天然 ≥2，
 *     不加此判断会误伤全部目录参数），因此**任何目录级递归读取都能穿透**——`rg 模式 某目录/` 的参数是
 *     目录 → (A) 跳过 → ripgrep 递归读入目录内每个文件（含 nlink>1 的）。故 (A) 从来只挡
 *     「直接以文件为参数」这一种用法，不是完整防线。
 *
 * (B) **越界逃逸**：对**每个非 flag 位置参数**（含裸文件名，与 (A) nlink 检测同覆盖面）做 realpath
 *     解析，要求落在审计根内（target=cwd 及其子树）；越界（绝对路径逃逸 / `..` 穿越 / symlink 逃逸，
 *     含裸名 symlink `stat -L slink`）即拒。**不再限 looksPath**——旧实现只查含 `/`/`..`/`~` 的 token，
 *     裸名 symlink 逃逸（元数据侧信道）会漏。realpath 失败（不存在的 token）→ 上溯到 root → 不误拒非路径参数。
 *
 * flag（`-` 前缀）与解析后落在 root 内/不存在的参数不因此拒（交给命令自身处理），避免误拒取证用法。
 * 返回 null=通过；否则返回拒绝原因。
 */
/** checkPathJail 选项。`hardlinkGuard` 默认 **false**（见上方 (A) 的长注释）。 */
export interface PathJailOptions {
  /** 启用 (A) 硬链接读逃逸检测。默认 false——本机 Google Drive 暂存链接导致 100% 误报。 */
  hardlinkGuard?: boolean;
  /**
   * ★额外只读根（2026-08-04 跨仓核查）：来自 moa.yaml 的 `access.readRoots`（服务端配置真源）。
   * cwd 恒为根之一；不传即退化成改造前的**单根**行为，逐字节等价。
   * **绝不接受调用方入参或 agent 自调**——扩权决定权只在配置里。
   */
  readRoots?: readonly string[];
}

export function checkPathJail(
  argv: string[],
  cwd: string,
  opts: PathJailOptions = {},
): string | null {
  const hardlinkGuard = opts.hardlinkGuard === true; // 默认关：缺省/未传一律不启用
  // 根集合 = 会话 cwd ∪ 配置读根（均已 canonical）。不配 readRoots ⇒ 只有 cwd（旧行为）。
  const roots = effectiveReadRoots(cwd, opts.readRoots ?? []);
  const root = roots[0] as string; // cwd 根，仅用于拒绝理由里的人读提示
  const withinRoot = (p: string): boolean => isWithinRoots(p, roots);
  for (const token of argv.slice(1)) {
    // flag 不是读取目标：跳过（flag 的写/执行面已由 analyzeCommand 逐条 denylist 兜住）。
    if (token.startsWith("-")) continue;
    const candidate = expandTildeForCheck(token);
    const abs = resolve(cwd, candidate);

    // (A) 硬链接读逃逸检测——默认关闭；开启后覆盖裸文件名（realpath 不解硬链接，(B) 挡不住同卷硬链接）。
    if (hardlinkGuard) {
      try {
        const st = statSync(abs); // 跟随 symlink：判的是真正会被读到的那个 inode。
        if (st.isFile() && st.nlink > 1) {
          return `[bash_readonly] 拒绝：'${token}' 是硬链接（nlink=${st.nlink}），可能逃逸读取沙箱外文件`;
        }
      } catch {
        /* 不存在/非路径参数：可能是 grep 模式、revision 等，交给命令自身处理 */
      }
    }

    // (B) 越界逃逸检测：覆盖**所有**非 flag token（含裸名，与 (A) 同覆盖面，杜绝裸名 symlink 元数据侧信道）。
    // 取「最近存在祖先」的 realpath（解 symlink 逃逸），再判是否仍在 root 下。
    // 非路径参数（grep 模式、git revision 等）realpath 失败 → 上溯到 root（在 root 内）→ 不误拒。
    let probe = abs;
    let real = abs;
    // 逐级上溯到可解析的祖先。
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        real = realpathSync(probe);
        break;
      } catch {
        const parent = resolve(probe, "..");
        if (parent === probe) {
          real = abs; // 到根仍不可解析：用规范化绝对路径判。
          break;
        }
        probe = parent;
      }
    }
    // ★只判 canonical realpath 结果（root 已 realpath、real 已解 symlink）：
    //   旧实现 `!withinRoot(real) && !withinRoot(abs)` 因 abs 不解 symlink 恒在 cwd 内 → symlink 越界漏判。
    //   合法场景（cwd 前缀含 symlink）不误拒：canonical root vs canonical real 比较即正确。
    if (!withinRoot(real)) {
      return (
        `路径参数 '${token}' 越出审计根（禁读根之外，如 /etc/passwd、~/.ssh）。` +
        `当前允许的只读根：${roots.join(" | ")}（第一个是会话 cwd=${root}，其余来自 moa.yaml 的 access.readRoots）`
      );
    }

    // (C) ★密钥文件拒读（2026-08-04）：读根放大到整个工作区后，各项目的 .env / auth.json /
    //     *.pem / model_registry.yaml 都落进了可读面。此处按文件名减面（沙箱侧有同源的内核级 deny，
    //     两侧同源于 tools/access.ts）。判的是 realpath 结果 ⇒ 经 symlink 指向密钥文件同样被拒。
    const secret = secretDenyReason(real);
    if (secret) {
      return `路径参数 '${token}' 被拒：${secret}`;
    }
  }
  return null;
}

/**
 * ★对抗审 #8：ast-grep 会**自动发现**审计根/祖先里的 `sgconfig.yml`，其 `customLanguages.libraryPath`
 * 指向的 `.dylib` 会在 dlopen 时执行构造函数（攻击者原生代码）——且命令行从不引用该 dylib/配置，
 * 故 checkPathJail（只审 argv token）看不到它。ast-grep 只向**上**（cwd→祖先）发现配置，沙箱内祖先
 * 不可读，故实际可加载的只有审计根（=cwd）下的 `sgconfig.{yml,yaml}`。此处执行前扫描该文件，含
 * `customLanguages`/`libraryPath` 即拒（策略层补上沙箱之外的第二道；沙箱仍是主 containment）。
 * 返回 null=通过；否则返回拒绝原因。
 */
function astGrepConfigJail(cwd: string): string | null {
  for (const name of ["sgconfig.yml", "sgconfig.yaml"]) {
    const p = resolve(cwd, name);
    let content: string;
    try {
      if (!statSync(p).isFile()) continue;
      content = readFileSync(p, "utf8");
    } catch {
      continue; // 不存在/不可读：ast-grep 也加载不到 → 无需拒
    }
    if (/customLanguages|libraryPath/i.test(content)) {
      return `审计根存在 ${name} 且含 customLanguages/libraryPath —— ast-grep 会自动加载并经动态库执行代码（对抗审 #8）。移除该配置或改用 rg。`;
    }
  }
  return null;
}

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  // ★到上限即掐断，并给调用方明确、可执行的反馈（徐总 2026-07-25）：不能让模型误以为“看全了”。
  //   告知：已被截断、只显示前 N / 共 M、后续未返回、以及如何缩小范围重查。
  return (
    s.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n⚠️ [bash_readonly：输出达到上限 ${MAX_OUTPUT_CHARS} 字符已截断——仅返回前 ${MAX_OUTPUT_CHARS} / 共 ${s.length} 字符，` +
    "其余未返回。请勿据此判断“已看全”；用更精确的路径、更具体的 grep pattern、或缩小 find 范围后重新查询。]"
  );
}

/**
 * 供工具本体与（潜在的）编排层复用的运行入口：analyze → 拒/执行。
 * 绝不抛：拒绝与执行失败都折成结构化结果。
 */
/**
 * rg / ast-grep 的搜索根里落在 Paper System 内的那些（canonical 路径比较，带分隔符前缀防「Paper System-x」误伤）。
 * 路径参数 = argv 里能解析成现存路径的 token（跳过 argv[0]）；一个都没有时搜索根就是 cwd。
 * 非检索命令返回空数组。
 */
export function paperSystemSearchRoots(argv: readonly string[], cwd: string): string[] {
  if (argv[0] !== "rg" && argv[0] !== "ast-grep") return [];
  const candidates: string[] = [];
  for (const tok of argv.slice(1)) {
    if (tok.startsWith("-")) continue;
    const abs = resolve(cwd, tok);
    try {
      statSync(abs);
      candidates.push(abs);
    } catch {
      /* 不是现存路径（模式串 / 子命令 / glob）*/
    }
  }
  if (candidates.length === 0) candidates.push(resolve(cwd));
  const sep = "/";
  const hits: string[] = [];
  for (const c of candidates) {
    let real = c;
    try {
      real = realpathSync(c);
    } catch {
      /* 保持原样 */
    }
    if (real === PAPER_SYSTEM_ROOT || real.startsWith(PAPER_SYSTEM_ROOT + sep)) hits.push(c);
  }
  return hits;
}

export async function runBashReadonly(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  readRoots: readonly string[] = [],
): Promise<{ rejected: boolean; reason?: string; text: string }> {
  const verdict = analyzeCommand(command);
  if (!verdict.allowed) {
    return {
      rejected: true,
      reason: verdict.reason,
      text: `REJECTED（只读闸拦截）：${verdict.reason}\n命令：${command}`,
    };
  }
  // 路径 jail（沙箱外第二道）：任一路径参数逃出审计根、或命中密钥清单即拒（不执行）。
  const jailReason = checkPathJail(verdict.argv, cwd, { readRoots });
  if (jailReason) {
    return {
      rejected: true,
      reason: jailReason,
      text: `REJECTED（路径 jail）：${jailReason}\n命令：${command}`,
    };
  }
  // 检索分流铁律（徐总 2026-08-12 / 09-20 灰度第 3 轮重申）：Paper System 仓库的检索一律走 devkb_search，
  // 禁止对它做全文扫库。rg / ast-grep 的搜索根（路径参数，缺省 cwd）落在 Paper System 内即拒并指路；
  // 精确读文件（cat / rtk read / read 工具）不受影响。与 semble_search.ts 的执法同口径。
  const searchRoots = paperSystemSearchRoots(verdict.argv, cwd);
  if (searchRoots.length > 0) {
    const reason =
      `检索分流铁律：Paper System 仓库（${PAPER_SYSTEM_ROOT}）的检索一律走 devkb_search（语义+全文+调用图），` +
      `不要用 ${verdict.argv[0]} 扫库（命中根：${searchRoots.join(" | ")}）。先 devkb_search 定位到路径与行号，再用 read / rtk read 精确读。`;
    return { rejected: true, reason, text: `REJECTED（检索分流）：${reason}\n命令：${command}` };
  }
  // ast-grep 专属：审计根 sgconfig 动态库加载 jail（对抗审 #8，命令行不引用配置故 checkPathJail 覆盖不到）。
  if (verdict.argv[0] === "ast-grep") {
    const cfgReason = astGrepConfigJail(cwd);
    if (cfgReason) {
      return {
        rejected: true,
        reason: cfgReason,
        text: `REJECTED（ast-grep 配置 jail）：${cfgReason}\n命令：${command}`,
      };
    }
  }
  const r = await runArgv(verdict.argv, cwd, signal, readRoots);
  if (r.spawnError) {
    return { rejected: false, text: `执行错误：${r.spawnError}` };
  }
  if (r.aborted) {
    return { rejected: false, text: "执行已中止（会话取消）" };
  }
  const parts: string[] = [];
  if (r.stdout) parts.push(clip(r.stdout));
  if (r.stderr) parts.push(`--- stderr ---\n${clip(r.stderr)}`);
  if (r.code !== 0 && r.code !== null) parts.push(`[exit code ${r.code}]`);
  const text = parts.join("\n").trim();
  return { rejected: false, text: text.length > 0 ? text : "(无输出)" };
}

/**
 * pi 自定义工具**工厂**：每个会话建一份独立实例，绑定自己的预算账本
 * （模块级单例会让并行 proposer 互扣额度，故必须逐会话建）。
 * 预算与 `read` 工具**共用同一本账**（见 src/tools/budget.ts）。
 * 不传 budget ⇒ 建一个新的（等价于该实例独占预算）。
 */
export function createBashReadonlyTool(
  budget: RetrievalBudget = createRetrievalBudget(),
  readRoots: readonly string[] = [],
) {
  return defineTool({
  name: "bash_readonly",
  label: "Bash (read-only)",
  description:
    "在**OS 级沙箱内**运行一条**只读取证** bash 命令并返回 stdout（沙箱：无网络、写限临时目录、" +
    `读限审计根、env 无密钥；输出封顶 ${MAX_OUTPUT_CHARS} 字符（=TOOL_SLICE_CHARS），超了会明确提示截断）。\n` +
    "★可读范围 = 会话 cwd + 服务端配置的**跨仓只读根**：给绝对路径即可读到其它仓库（跨仓核查用），" +
    "越界路径与密钥类文件（.env / auth.json / *.pem / *.key / model_registry.yaml / .ssh 等）一律拒。\n" +
    "★检索三件套（各司其职，别混用）：\n" +
    "  · 找文本/正则/找文件 → `rg`（如 `rg -n 模式 路径`、`rg --files -g '*.ts'`）；\n" +
    "  · 找代码结构（某种函数/调用/写法，忽略注释与字符串）→ `ast-grep run -p '模式' -l ts 路径`" +
    "（★模式必须用**单引号**包裹，内含 $ 才不被拒）；\n" +
    "  · 紧凑地读文件/列目录（省 token）→ `rtk read 文件`、`rtk ls .`。\n" +
    "其余放行：git diff/status/log/show 等只读子命令、sha256sum/md5/shasum 哈希、stat/file/wc/readlink/" +
    "realpath/du/df、cat/head/tail/pwd/echo。**grep 与 find 已下线**（分别用 rg / ast-grep）。" +
    "写重定向(>/>>)、管道写、bash -c/eval/sudo/xargs、命令替换 $()/``、;/&&/|| 串接、越界路径、" +
    "rtk 的执行类子命令（docker/test/err…）、ast-grep 的写/rewrite 全拒。禁止用它修改被审对象。",
  promptSnippet:
    "bash_readonly: 沙箱内只读取证（★已知符号名/字面量/正则的精确定位用 rg；搜结构用 ast-grep；紧凑读用 rtk read；git diff/hash/stat；不知道代码在哪时先用 semble_search/devkb_search 语义定位；无网络·写限 scratch·路径 jail；grep/find 已下线，写/执行/串接一律拒）",
  parameters: Type.Object({
    command: Type.String({
      description:
        "单条只读 bash 命令（例：git diff、sha256sum path、stat path、grep -n foo path）。禁重定向/管道写/串接/命令替换。",
    }),
  }),
  execute: async (
    _toolCallId: string,
    params: { command: string },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) => {
    // ★会话级预算闸——原子预扣（提速方案 §4.2）：**同步** reserve 单次上限后才 await 执行，
    //   同一条消息里并行的其它工具调用在各自 reserve 时即看到在途额度，超额的在此被拒（不进沙箱）。
    //   旧的「检查 → await → 记账」在 pi 并行执行下 N 个调用全在 usedChars=0 时过闸，已废除。
    const reservation = reserveBudget(budget, MAX_OUTPUT_CHARS);
    if (!reservation.ok) {
      const reason = reservation.reason;
      return {
        content: [{ type: "text" as const, text: `REJECTED（取证预算耗尽）：${reason}` }],
        details: {
          command: params.command,
          rejected: true,
          reason,
          budgetUsedChars: budget.usedChars,
          budgetLimitChars: budgetMaxChars(budget),
        },
        isError: true,
      };
    }
    const ticket = reservation.ticket;

    const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
    let res: Awaited<ReturnType<typeof runBashReadonly>>;
    let text: string;
    try {
      res = await runBashReadonly(params.command, cwd, signal, readRoots);
      text = res.text;
      if (res.rejected) {
        // 被策略/jail 拒的调用不产出内容，不计入预算：退还预扣与轮数（与改造前"不记账"口径一致）。
        releaseBudget(budget, ticket);
      } else if (settleBudget(budget, ticket, text.length)) {
        // settle 后跨过阈值：本次结果照常返回，但**附加**收敛提示（下一次调用会在 reserve 阶段被拒）。
        text += budgetCrossedNotice(budget);
      }
    } finally {
      // 抛错兜底：预扣绝不悬挂（悬挂 = 后续永久少一片额度）。已 settle/release 的票据幂等跳过。
      settleBudget(budget, ticket, 0);
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        command: params.command,
        rejected: res.rejected,
        ...(res.reason ? { reason: res.reason } : {}),
        budgetUsedChars: budget.usedChars,
        budgetLimitChars: budgetMaxChars(budget),
      },
      ...(res.rejected ? { isError: true } : {}),
      // ★绝不设 addedToolNames：本工具不向会话引入任何新工具（防孙 agent）。
    };
  },
  });
}

/**
 * 向后兼容的模块级单例（测试与非会话场景用）。**会话请用 createBashReadonlyTool() 各建一份**，
 * 否则并行 proposer 会共享同一本账、互扣额度。
 */
export const bashReadonlyTool = createBashReadonlyTool();
