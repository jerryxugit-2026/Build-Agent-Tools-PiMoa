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
 * 两层都受约束：路径 jail（复用 bash_readonly 的越界/硬链接检测）+ 总量封顶（防侦查本身撑爆）。
 * 失败绝不抛：任何一项读失败/检索失败都降级成一条说明文字，不影响主流程（fail-open，因为
 * 侦查只是"帮忙缩小范围"，不该因它失败而毙掉整轮 MoA）。
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkPathJail } from "../tools/bash_readonly.js";

/** 侦查产出的总字符上限（防"侦查本身"把上下文撑爆）。约 60k token。 */
export const RECON_MAX_CHARS = 180_000;
/** 单个文件附入的字符上限（超出截断并提示）。 */
const PER_FILE_MAX_CHARS = 60_000;
/** rg 检索结果的字符上限。 */
const RG_MAX_CHARS = 20_000;
/** rg 执行超时。 */
const RG_TIMEOUT_MS = 15_000;

export interface ReconInput {
  /** 精确文件清单（层次二）。 */
  files?: string[];
  /** 机械检索词（层次三）：交给 rg，不经模型。 */
  reconQuery?: string;
  /** 审计根（路径 jail 与 rg 的根）。 */
  cwd: string;
}

export interface ReconResult {
  /** 拼好的上下文块（空串表示没有可附加内容）。 */
  text: string;
  /** 成功附入的文件数。 */
  filesIncluded: number;
  /** 逐项说明（含被拒/截断原因），便于回执与排查。 */
  notes: string[];
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

/** 读一个文件并做 jail + 截断；绝不抛。 */
function readOne(path: string, cwd: string): { ok: boolean; text: string; note: string } {
  const jail = checkPathJail(["read", path], cwd);
  if (jail) return { ok: false, text: "", note: `跳过 ${path}：${jail}` };
  const abs = resolve(cwd, path);
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      return { ok: false, text: "", note: `跳过 ${path}：是目录（请给具体文件，或改用 reconQuery 检索）` };
    }
    let body = readFileSync(abs, "utf8");
    const totalLines = body.split("\n").length;
    let note = "";
    if (body.length > PER_FILE_MAX_CHARS) {
      // 按**整行**截断（不截半行），保证行号与内容严格对齐。
      body = body.slice(0, PER_FILE_MAX_CHARS);
      const lastNl = body.lastIndexOf("\n");
      if (lastNl > 0) body = body.slice(0, lastNl);
      const shown = body.split("\n").length;
      note = `（已截断：显示第 1–${shown} 行，共 ${totalLines} 行）`;
    }
    // ★打行号：模型据此**照抄**行号而非自行计数（杜绝行号漂移）。
    return { ok: true, text: withLineNumbers(body), note: note ? `${path}${note}` : "" };
  } catch (err) {
    return { ok: false, text: "", note: `跳过 ${path}：${err instanceof Error ? err.message : String(err)}` };
  }
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
 * 无 files 也无 reconQuery ⇒ 返回空结果（零开销、零影响）。
 */
export async function runRecon(input: ReconInput): Promise<ReconResult> {
  const notes: string[] = [];
  const parts: string[] = [];
  let filesIncluded = 0;
  let used = 0;

  // ── 层次二：精确文件清单 ──
  for (const f of input.files ?? []) {
    if (used >= RECON_MAX_CHARS) {
      notes.push(`侦查总量已达上限 ${RECON_MAX_CHARS} 字符，其余文件未附入（请减少 files 数量）`);
      break;
    }
    const r = readOne(f, input.cwd);
    if (r.note) notes.push(r.note);
    if (!r.ok) continue;
    const block = `\n===== FILE ${f}（左侧 \`N| \` 为该文件的真实行号）=====\n${r.text}`;
    parts.push(block);
    used += block.length;
    filesIncluded += 1;
  }

  // ── 层次三：机械检索（rg，无模型参与）──
  if (input.reconQuery && input.reconQuery.trim() !== "" && used < RECON_MAX_CHARS) {
    const r = await ripgrep(input.reconQuery.trim(), input.cwd);
    if (r.note) notes.push(r.note);
    if (r.text) {
      parts.push(
        `\n===== 机械检索命中（rg -n -m5 -e ${JSON.stringify(input.reconQuery.trim())}）=====\n` +
          `（服务端预先检索，非模型产出；每文件最多 5 处命中）\n${r.text}`,
      );
    }
  }

  if (parts.length === 0) return { text: "", filesIncluded, notes };

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

  return { text: header + parts.join("\n"), filesIncluded, notes };
}
