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
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeCommand } from "./bash_readonly_policy.js";
import { buildSandboxedInvocation, expandTildeForCheck } from "./sandbox.js";
import {
  budgetCrossedNotice,
  budgetExhaustedReason,
  chargeBudget,
  createRetrievalBudget,
  isBudgetExhausted,
  SESSION_OUTPUT_CHAR_BUDGET,
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
const MAX_OUTPUT_CHARS = 60_000; // 回传给模型前截断，省 token

interface ExecOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
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
): Promise<ExecOutcome> {
  const built = buildSandboxedInvocation(argv, cwd);
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
        resolvePromise({ code, stdout: out, stderr: errout });
      },
    );
  });
}

/**
 * ★路径 jail（审计 🟠#7 / 任务 C）——沙箱之外的**第二道**，两项检查：
 *
 * (A) **硬链接读逃逸**（对抗审实证残余，一招清零）：`realpath` 不解析硬链接，沙箱按**路径**放行——
 *     故 cwd 内一个硬链接指向 cwd 外/`$HOME` 下**同卷**秘密文件时，`cat hardlink` 能读出秘密并经
 *     stdout 进 proposal 外泄。对**每个将被读取的路径参数（含裸文件名，如 `cat hl_secret` 的 `hl_secret`）**
 *     做 `statSync`，若「常规文件且 `nlink > 1`」即拒。正常源码仓库文件 nlink 恒为 1，误伤面极小。
 *
 * (B) **越界逃逸**：对**每个非 flag 位置参数**（含裸文件名，与 (A) nlink 检测同覆盖面）做 realpath
 *     解析，要求落在审计根内（target=cwd 及其子树）；越界（绝对路径逃逸 / `..` 穿越 / symlink 逃逸，
 *     含裸名 symlink `stat -L slink`）即拒。**不再限 looksPath**——旧实现只查含 `/`/`..`/`~` 的 token，
 *     裸名 symlink 逃逸（元数据侧信道）会漏。realpath 失败（不存在的 token）→ 上溯到 root → 不误拒非路径参数。
 *
 * flag（`-` 前缀）与解析后落在 root 内/不存在的参数不因此拒（交给命令自身处理），避免误拒取证用法。
 * 返回 null=通过；否则返回拒绝原因。
 */
export function checkPathJail(argv: string[], cwd: string): string | null {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = resolve(cwd);
  }
  const withinRoot = (p: string): boolean => p === root || p.startsWith(root + sep);
  for (const token of argv.slice(1)) {
    // flag 不是读取目标：跳过（flag 的写/执行面已由 analyzeCommand 逐条 denylist 兜住）。
    if (token.startsWith("-")) continue;
    const candidate = expandTildeForCheck(token);
    const abs = resolve(cwd, candidate);

    // (A) 硬链接读逃逸检测——**覆盖裸文件名**（realpath 不解硬链接，(B) 越界检测挡不住同卷硬链接）。
    try {
      const st = statSync(abs); // 跟随 symlink：判的是真正会被读到的那个 inode。
      if (st.isFile() && st.nlink > 1) {
        return `[bash_readonly] 拒绝：'${token}' 是硬链接（nlink=${st.nlink}），可能逃逸读取沙箱外文件`;
      }
    } catch {
      /* 不存在/非路径参数：可能是 grep 模式、revision 等，交给命令自身处理 */
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
      return `路径参数 '${token}' 越出审计根 ${root}（禁读 target 之外，如 /etc/passwd、~/.ssh、config/auth.json）`;
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
export async function runBashReadonly(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ rejected: boolean; reason?: string; text: string }> {
  const verdict = analyzeCommand(command);
  if (!verdict.allowed) {
    return {
      rejected: true,
      reason: verdict.reason,
      text: `REJECTED（只读闸拦截）：${verdict.reason}\n命令：${command}`,
    };
  }
  // 路径 jail（沙箱外第二道）：任一路径参数逃出审计根即拒（不执行）。
  const jailReason = checkPathJail(verdict.argv, cwd);
  if (jailReason) {
    return {
      rejected: true,
      reason: jailReason,
      text: `REJECTED（路径 jail）：${jailReason}\n命令：${command}`,
    };
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
  const r = await runArgv(verdict.argv, cwd, signal);
  if (r.spawnError) {
    return { rejected: false, text: `执行错误：${r.spawnError}` };
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
export function createBashReadonlyTool(budget: RetrievalBudget = createRetrievalBudget()) {
  return defineTool({
  name: "bash_readonly",
  label: "Bash (read-only)",
  description:
    "在**OS 级沙箱内**运行一条**只读取证** bash 命令并返回 stdout（沙箱：无网络、写限临时目录、" +
    "读限审计目标、env 无密钥；输出封顶 6 万字符，超了会明确提示截断）。\n" +
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
    "bash_readonly: 沙箱内只读取证（搜文本用 rg / 搜结构用 ast-grep / 紧凑读用 rtk read / git diff/hash/stat；无网络·写限 scratch·路径 jail；grep/find 已下线，写/执行/串接一律拒）",
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
    // ★会话级预算闸：已超顶即拒绝再检索（在执行**之前**判，省掉无谓的沙箱开销）。
    if (isBudgetExhausted(budget)) {
      const reason = budgetExhaustedReason(budget);
      return {
        content: [{ type: "text" as const, text: `REJECTED（取证预算耗尽）：${reason}` }],
        details: {
          command: params.command,
          rejected: true,
          reason,
          budgetUsedChars: budget.usedChars,
          budgetLimitChars: SESSION_OUTPUT_CHAR_BUDGET,
        },
        isError: true,
      };
    }

    const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
    const res = await runBashReadonly(params.command, cwd, signal);

    // 记账（被策略/jail 拒的调用不产出内容，不计入预算）。
    let text = res.text;
    if (!res.rejected) {
      // 跨过阈值：本次结果照常返回，但**附加**收敛提示（下一次调用会被上面的闸拒）。
      if (chargeBudget(budget, text.length)) text += budgetCrossedNotice(budget);
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        command: params.command,
        rejected: res.rejected,
        ...(res.reason ? { reason: res.reason } : {}),
        budgetUsedChars: budget.usedChars,
        budgetLimitChars: SESSION_OUTPUT_CHAR_BUDGET,
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
