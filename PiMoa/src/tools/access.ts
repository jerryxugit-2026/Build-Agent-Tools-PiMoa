/**
 * 读访问策略（唯一真源）—— **只读根集合** + **密钥文件拒读清单**。
 *
 * ## 为什么有这个模块（徐总 2026-08-04）
 * 此前 PiMoa 的读权限是**单根**的：路径 jail、沙箱 SBPL 读白名单、semble 搜索根，三处各自
 * 用「会话 cwd」当唯一审计根。后果是**跨仓核查做不到**——要同时看 PaperGo 与
 * System/paper-system 的规格文档时，worker 只能看见 cwd 那一棵树，另一棵一律被 jail 拒。
 *
 * 修法不是把 cwd 抬到公共祖先——`cwd` 在 moa_deliver 里**同时是写盘的受信任根**
 * （见 mcp/server.ts 的 allowedRoots = del.cwd），抬 cwd 会把**写**权限一起放大。
 * 故这里把「读根」与「写根」**彻底解耦**：读根来自**配置**（moa.yaml 的 access.readRoots，
 * 服务端真源），写根仍旧只有调用方传的 cwd。本模块只管读，绝不被 deliver 引用。
 *
 * ## 谁能改读根（提权面分析）
 * 只有 moa.yaml。**不接受调用方入参、更不接受 agent 自调工具**（pi-add-dir 那种
 * `add_directory` 让 agent 自己扩权的做法，等于让被审对象自己发通行证，本项目明确不采用）。
 *
 * ## 放开读根的连带风险与对策（必须一起做，否则是安全倒退）
 * 沙箱与 jail 原本靠「读限 cwid 一棵树」顺带保证了「读不到密钥」（见 sandbox.ts 头注释）。
 * 读根一放大到整个工作区，工作区内各项目的密钥文件就都进入可读面了。故本模块同时提供
 * **密钥文件拒读清单**，在两侧同时执法：
 *   · JS 侧（read / recon / bash_readonly 的路径 jail）—— 这些读发生在 **server 进程内**，不过沙箱，
 *     JS 检查就是唯一防线；
 *   · SBPL 侧（沙箱 profile 末尾的 deny）—— bash_readonly 放行的命令在沙箱内跑，`rg 某目录/`
 *     这种**目录级递归**读不经过 argv 检查，只有内核级 deny 挡得住。
 * 两侧模式同源（本文件），避免两套清单漂移。
 *
 * ⚠️ **诚实标注边界**：这是**按文件名的减面**，不是完备防线。改名/复制过的密钥（`cp .env cfg.txt`）
 * 挡不住；它挡的是「密钥躺在原处被顺手读走」这一主要场景。真正的密钥保护仍是
 * ①沙箱 env 从零构建（子进程拿不到任何 *_API_KEY）②沙箱无网络（读到也发不出去）。
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * 密钥文件**整名**匹配（正则源串，匹配 basename 全体；大小写不敏感由下方 ci 展开保证）。
 * 收录依据：本机工作区实际存在或惯例存放凭证的文件名。
 */
export const SECRET_BASENAME_EXACT: readonly string[] = [
  "auth\\.json", // pi / PiMoa 的凭证存储（config/auth.json）
  "models-store\\.json", // pi ModelRuntime 的模型凭证存储
  "\\.env", // .env
  "\\.env\\..*", // .env.local / .env.production …
  "\\.netrc",
  "\\.npmrc",
  "\\.pgpass",
  "\\.git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials\\.(json|yaml|yml|ini)",
  "secrets?\\.(json|yaml|yml|toml|ini)",
  // PaperGo 的模型注册表：**故意**内含明文 key（徐总定，不入 gitignore、不上云），
  // 放开工作区读根后它就落在可读面内，故显式拒。
  "model_registry\\.ya?ml",
];

/** 密钥文件**后缀**匹配（私钥/证书/密钥库）。 */
export const SECRET_BASENAME_SUFFIXES: readonly string[] = [
  "pem",
  "key",
  "p12",
  "pfx",
  "jks",
  "keystore",
];

/** 只要路径中**任一分量**等于这些目录名即拒（整目录视为密钥区）。 */
export const SECRET_PATH_COMPONENTS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
];

/**
 * 把正则源串逐字符展开成**大小写不敏感**的等价源串（`auth` → `[aA][uU][tT][hH]`）。
 * 为什么不用 `(?i)`：SBPL 的 regex 字面量不支持内联标志，而 JS 侧与 SBPL 侧必须用**同一份**
 * 模式（否则两侧行为漂移）。逐字符展开是两边都认的最小公共子集。
 * 只展开 ASCII 字母；`\.`、`(`、`|`、`?`、`$` 等正则语法原样保留（本文件模式不含 \d/\w/\s 类转义）。
 */
export function ciSource(src: string): string {
  let out = "";
  for (const ch of src) {
    if (ch >= "a" && ch <= "z") out += `[${ch}${ch.toUpperCase()}]`;
    else if (ch >= "A" && ch <= "Z") out += `[${ch.toLowerCase()}${ch}]`;
    else out += ch;
  }
  return out;
}

/** 后缀组 → 正则分支源串（`pem|key|…`）。 */
function suffixAlternation(): string {
  return SECRET_BASENAME_SUFFIXES.join("|");
}

/** JS 侧：匹配 basename 的完整正则表（大小写不敏感）。 */
function jsBasenameMatchers(): RegExp[] {
  const pats = [
    ...SECRET_BASENAME_EXACT.map((p) => `^${p}$`),
    `^.*\\.(${suffixAlternation()})$`,
  ];
  return pats.map((p) => new RegExp(ciSource(p)));
}

const JS_BASENAME_MATCHERS = jsBasenameMatchers();

/**
 * 该绝对路径是否命中密钥拒读清单。命中返回人读理由，否则返回 null。
 * 判 basename 与全部路径分量（后者覆盖 `.ssh/config` 这类"目录即密钥区"）。
 */
export function secretDenyReason(abs: string): string | null {
  const parts = abs.split(sep).filter((s) => s !== "");
  for (const comp of parts) {
    const lower = comp.toLowerCase();
    if (SECRET_PATH_COMPONENTS.includes(lower)) {
      return `路径含密钥目录分量 '${comp}'（凭证区一律拒读）`;
    }
  }
  const base = parts[parts.length - 1] ?? "";
  for (const re of JS_BASENAME_MATCHERS) {
    if (re.test(base)) {
      return `'${base}' 命中密钥文件拒读清单（放开工作区读根后，密钥文件仍一律不可读；见 src/tools/access.ts）`;
    }
  }
  return null;
}

/**
 * SBPL 侧：生成沙箱 profile 用的 deny 行（必须放在全部 allow **之后**，last-match-wins 才生效）。
 * 与 JS 侧同源于上方三张表。
 */
export function sbplSecretDenyLines(): string[] {
  const lines: string[] = [];
  for (const comp of SECRET_PATH_COMPONENTS) {
    // 目录分量：`/.ssh/` 或以 `/.ssh` 结尾。
    const escaped = comp.replace(/\./g, "\\.");
    lines.push(`(deny file-read* (regex #"/${ciSource(escaped)}(/|$)"))`);
  }
  for (const p of SECRET_BASENAME_EXACT) {
    lines.push(`(deny file-read* (regex #"/${ciSource(p)}$"))`);
  }
  lines.push(
    `(deny file-read* (regex #"${ciSource(`\\.(${suffixAlternation()})`)}$"))`,
  );
  return lines;
}

/** 读根配置非法时的统一错误（加载期 fail-loud 用）。 */
export class ReadRootError extends Error {
  constructor(message: string) {
    super(`[access] ${message}`);
    this.name = "ReadRootError";
  }
}

/**
 * 校验并归一化配置里的只读根：
 *   · 必须是**绝对路径**（相对路径的含义随进程 cwd 漂移，禁）；
 *   · 必须**存在且是目录**（打错字不能静默变成"没这个根"）；
 *   · 归一到 realpath（后续与同样 realpath 过的目标路径比较，抗 symlink 逃逸）；
 *   · **禁止覆盖 $HOME 或文件系统根**——那等于把 ~/.ssh、~/.aws、~/.claude.json 全放进可读面，
 *     密钥清单只按文件名减面，挡不住这种量级的越权。
 * 任一项违反即 throw（加载期 fail-loud，绝不带病启动）。
 */
export function canonicalizeReadRoots(roots: readonly string[]): string[] {
  const home = (() => {
    try {
      return realpathSync(homedir());
    } catch {
      return homedir();
    }
  })();
  const out: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ReadRootError(`只读根必须是非空字符串，实际为 ${JSON.stringify(raw)}`);
    }
    if (!isAbsolute(raw)) {
      throw new ReadRootError(`只读根必须是绝对路径："${raw}"（相对路径随进程 cwd 漂移）`);
    }
    let real: string;
    try {
      real = realpathSync(raw);
    } catch (err) {
      throw new ReadRootError(
        `只读根不存在或无法解析："${raw}"：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      if (!statSync(real).isDirectory()) {
        throw new ReadRootError(`只读根不是目录："${raw}"（解析为 ${real}）`);
      }
    } catch (err) {
      if (err instanceof ReadRootError) throw err;
      throw new ReadRootError(
        `只读根无法 stat："${raw}"：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (real === sep) {
      throw new ReadRootError('只读根不得为文件系统根 "/"（等于取消一切读限制）');
    }
    if (home === real || home.startsWith(real + sep)) {
      throw new ReadRootError(
        `只读根 "${real}" 覆盖了用户主目录 ${home}——会把 ~/.ssh、~/.aws、~/.claude.json 等全部放进可读面，拒绝。` +
          "请把根收窄到具体工作区目录。",
      );
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * 运行期把「会话 cwd」与「配置读根」合成一份 canonical 根集合。
 * cwd 恒为根之一（保持既有单根行为不变：不配 readRoots 时行为与改造前完全一致）。
 * 运行期不再抛：配置根已在加载期校验过；cwd 解析失败退回 resolve（与旧 checkPathJail 一致）。
 */
export function effectiveReadRoots(cwd: string, configured: readonly string[] = []): string[] {
  const roots: string[] = [];
  let cwdReal: string;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    cwdReal = resolve(cwd);
  }
  roots.push(cwdReal);
  for (const r of configured) {
    let real: string;
    try {
      real = realpathSync(r);
    } catch {
      real = resolve(r);
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** canonical 路径是否落在任一 canonical 根内（根自身或其子树）。 */
export function isWithinRoots(abs: string, roots: readonly string[]): boolean {
  return roots.some((r) => abs === r || abs.startsWith(r + sep));
}
