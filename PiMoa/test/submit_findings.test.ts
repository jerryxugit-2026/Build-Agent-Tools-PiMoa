/**
 * submit_findings / amend_facts 结构化提交工具单测（Jev 辅助代码审查详细设计 v4 §3.2，第一波验收；
 * 含徐总 09-20 追加裁定：quote → anchor「优化 6」、AmendState 独立于 FindingsState）。
 *
 * 运行：npx tsx test/submit_findings.test.ts
 * 覆盖：§3.2 表每条规则各一用例（路径不在材料 / 行号越界 / 跨度超 200 / anchor 四态不 REJECT /
 *       推论词含「故障」「可见性」不误伤 / LINE_REF 不误判 IP:端口 / 代码事实无行号 / claim 写成不成立 /
 *       counter level 非 COUNTER / id 重复 / 空清单无理由）、anchorHit 四态 + 归一化、counter 条目合格、
 *       3 次上限、amend 目标不符、AmendState attempts/rejects 一致性、resolveMaterial 三种写法、factKind 三类。
 * 脱网、脱 key、不读盘。
 */
import type { MaterialFile, MaterialMap } from "../src/moa/types.js";
import { classifyStructuredToolEnd } from "../src/moa/session.js";
import {
  anchorHit,
  identifierTokens,
  checkFactRef,
  FACT_REF_MAX_WINDOW_SPAN,
  factCheckTokens,
  parseFactLineRef,
  rewriteFactLine,
  AmendFactsParams,
  computeFactsRange,
  createAmendFactsTool,
  createAmendState,
  createFindingsState,
  createSubmitFindingsTool,
  factKind,
  INFERENCE_WORDS,
  LINE_NO_REF,
  LINE_REF,
  RAW_JSON_ARGS_NOTE,
  percentDecodedVariant,
  resolveMaterial,
  resolveMaterialDetailed,
  validateFinding,
  type Finding,
} from "../src/tools/submit_findings.js";
// Local-fixture test: needs the author's private datasets. Set PIMOA_WORKSPACE (workspace root) to run it.
const WS = process.env.PIMOA_WORKSPACE as string;
if (!WS) { console.log("SKIP: set PIMOA_WORKSPACE to run this local-fixture test"); process.exit(0); }

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}
function log(...a: unknown[]): void {
  console.log("[submit-findings-test]", ...a);
}

// ---------- 材料 fixture（不读盘）----------
const CWD = "/repo";
const ROOT2 = "/other-repo";
const ABS_GO = "/repo/internal/x/ratchet.go";
const ABS_MD = "/other-repo/docs/spec.md";

function seg(abs: string, rel: string, kind: MaterialFile["kind"], start: number, lines: string[]): MaterialFile {
  return { abs, rel, kind, lines, start, end: start + lines.length - 1 };
}

/** ratchet.go 第 880-891 行（两段：880-891 与 900-905，中间 892-899 未附）。
 * "svcIdentityMatches" 只在第 884 行出现一次；"return" 在 882/889/901 三处出现（用于测 anchor 不唯一）。 */
const GO_LINES_880 = [
  "func (r *Ratchet) Check(origin Origin) error {",
  '\tif origin.Layer != "management_proof_missing" || origin.Kind == "" {',
  "\t\treturn nil",
  "\t}",
  "\tcmd := svcIdentityMatches(origin.Command)",
  "\tif cmd == nil {",
  '\t\treturn fmt.Errorf("no command")',
  "\t}",
  "\tr.count++",
  "\treturn r.apply(cmd)",
  "}",
  "",
];
const GO_LINES_900 = ["func helper() {", "\treturn", "}", "", "// tail", "var _ = 1"];
const MD_LINES = ["# 规格", "", "## 2. 事实", "系统必须在提交前核验行号。", "第二段。"];

function makeMaterials(): MaterialMap {
  const m: MaterialMap = new Map();
  m.set(ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", "range", 880, GO_LINES_880), seg(ABS_GO, "internal/x/ratchet.go", "range", 900, GO_LINES_900)]);
  m.set(ABS_MD, [seg(ABS_MD, ABS_MD, "file", 1, MD_LINES)]);
  return m;
}
const materials = makeMaterials();
const readRoots = [ROOT2];

/** 一条完全合格的 finding（基线）：anchor 在所写行号范围内命中（第 881 行）。 */
function okFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    kind: "finding",
    level: "MAJOR",
    path: "internal/x/ratchet.go",
    lines: "881-882",
    anchor: "management_proof_missing",
    facts: [
      "ratchet.go 第 881 行只在 Layer 等于 management_proof_missing 且 Kind 非空时继续",
      "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
      "运行时条件：origin.Command 取自无关进程的命令行",
    ],
    claim: "Kind 为空时直接放行，缺少来源校验的 origin 会被当作合法",
    fix_expect: "Kind 为空时应返回错误而不是 nil",
    strength: "亲验",
    ...over,
  };
}

function firstErr(f: Finding): string {
  return validateFinding(f, materials, CWD, readRoots)[0] ?? "";
}

// ---------- 用例 1：resolveMaterial 三种写法 ----------
{
  log("=== 用例 1：resolveMaterial 相对 cwd / 相对 readRoot / 绝对路径 / 不存在 ===");
  assert(resolveMaterial("internal/x/ratchet.go", materials, CWD, readRoots)?.[0]?.abs === ABS_GO, "相对 cwd 归一到 abs");
  assert(resolveMaterial("./internal/x/ratchet.go", materials, CWD, readRoots)?.[0]?.abs === ABS_GO, "./ 前缀相对 cwd 归一到 abs");
  assert(resolveMaterial("docs/spec.md", materials, CWD, readRoots)?.[0]?.abs === ABS_MD, "相对 readRoot 归一到 abs");
  assert(resolveMaterial(ABS_GO, materials, CWD, readRoots)?.length === 2, "绝对路径命中且回全部两段");
  assert(resolveMaterial("internal/x/nope.go", materials, CWD, readRoots) === null, "不存在 → null");
}

// ---------- 用例 1b：★evidence 路径的百分号解码变体（2026-09-20 徐总批准；moa#da4c2f3d）----------
{
  log("=== 用例 1b：%20 编码的绝对/相对路径命中材料（原路径优先、非法转义不抛、不存在仍 null） ===");
  // 真缺陷现场逐字：本仓路径含空格（`Claude dev paper system`），模型对含空格的绝对路径做 URL 编码
  // 是很自然的动作（对抗审 B 路真实失败轮 moa#da4c2f3d 的 REJECT 原文即含 Claude%20dev%20paper%20system）。
  // 夹具用真实绝对路径，材料表直接构造（不读盘），覆盖 isAbsolute / resolve(cwd) / resolve(readRoot) / rel 兜底四条路。
  const SP_CWD = WS + "/workspace";
  const SP_ABS = `${SP_CWD}/Claude dev paper system/PiMoa/src/moa/orchestrate.ts`;
  const SP_REL = "Claude dev paper system/PiMoa/src/moa/orchestrate.ts";
  const SP_LINES = ["    const ev = parseEvidence(evidence);", "    if (!ev) return null;", "  }"];
  const spMaterials: MaterialMap = new Map([[SP_ABS, [seg(SP_ABS, SP_REL, "range", 1263, SP_LINES)]]]);
  const enc = (s: string): string => s.replace(/ /g, "%20");

  assert(enc(SP_ABS) !== SP_ABS && enc(SP_ABS).includes("%20"), "夹具自查：编码串确实含 %20（与真实失败轮 evidence 同形）");
  // ① 编码的绝对路径（isAbsolute ⇒ normalize(p) 分支；修前必 miss ⇒ 整条裁决被 REJECT）
  assert(resolveMaterial(enc(SP_ABS), spMaterials, SP_CWD, [])?.[0]?.abs === SP_ABS, `%20 编码的绝对路径命中：${enc(SP_ABS)}`);
  // ② 编码的相对路径（resolve(cwd, v) 分支）
  assert(resolveMaterial(enc(SP_REL), spMaterials, SP_CWD, [])?.[0]?.abs === SP_ABS, `%20 编码的相对路径经 cwd 命中：${enc(SP_REL)}`);
  // ③ 编码的相对路径（resolve(root, v) 分支；cwd 故意不存在，只剩 readRoots 一条路）
  assert(resolveMaterial(enc(SP_REL), spMaterials, "/nonexistent-cwd", [SP_CWD])?.[0]?.abs === SP_ABS, "%20 编码的相对路径经 readRoots 命中");
  // ④ 编码的相对路径（rel 字面比对兜底；cwd / readRoots 两条 abs 路都解析不到）
  assert(resolveMaterial(enc(SP_REL), spMaterials, "/nonexistent-cwd", [])?.[0]?.abs === SP_ABS, "%20 编码的相对路径经 rel 字面比对（解码变体）命中");
  // ⑤ 原路径优先、结果一律不变：未编码的正常写法三种仍全部命中，不存在仍 null，空串仍 null
  assert(resolveMaterial(SP_ABS, spMaterials, SP_CWD, [])?.[0]?.abs === SP_ABS, "未编码绝对路径结果不变（命中）");
  assert(resolveMaterial(SP_REL, spMaterials, SP_CWD, [])?.[0]?.abs === SP_ABS, "未编码相对路径结果不变（命中）");
  assert(resolveMaterial("./" + SP_REL, spMaterials, SP_CWD, [])?.[0]?.abs === SP_ABS, "未编码 ./-前缀相对路径结果不变（命中）");
  assert(resolveMaterial("Claude dev paper system/PiMoa/nope.ts", spMaterials, SP_CWD, []) === null, "未编码的不存在路径仍 null");
  assert(resolveMaterial("", spMaterials, SP_CWD, []) === null && resolveMaterial("   ", spMaterials, SP_CWD, []) === null, "空串 / 纯空白仍 null");
  // ⑥ 非法 / 不完整转义：既不抛穿也不误命中。`/tmp/%C3.ts` 与 `%E4%B8` 是**能过 %XX 守卫但**
  //    decodeURIComponent 仍抛 URIError 的样本 ⇒ 命中的正是实现里那个 try/catch（修前它们走不到解码）。
  assert(
    (() => {
      try {
        decodeURIComponent("/tmp/%C3.ts");
        return false;
      } catch {
        return true;
      }
    })(),
    "夹具自查：/tmp/%C3.ts 确实让 decodeURIComponent 抛 URIError（⇒ 实现的 try/catch 是必需的）",
  );
  for (const bad of ["/tmp/a%b.ts:1", "/tmp/100%.ts:1", "/tmp/%C3.ts", "%E4%B8"]) {
    let r: MaterialFile[] | null = null;
    let threw = "";
    try {
      r = resolveMaterial(bad, spMaterials, SP_CWD, []);
    } catch (e) {
      threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    assert(threw === "" && r === null, `非法/不完整转义 ${JSON.stringify(bad)} → 不抛异常且 null（实际 ${threw === "" ? "null" : `抛 ${threw}`}）`);
  }
  // ⑦ 候选顺序不许被解码变体顶掉：字面路径与解码路径**都存在**于材料表时，原路径（字面）先命中先返回。
  const bothMaterials: MaterialMap = new Map([
    ["/repo/a%20b.ts", [seg("/repo/a%20b.ts", "a%20b.ts", "file", 1, ["literal-key"])]],
    ["/repo/a b.ts", [seg("/repo/a b.ts", "a b.ts", "file", 1, ["decoded-key"])]],
  ]);
  assert(resolveMaterial("a%20b.ts", bothMaterials, CWD, [])?.[0]?.abs === "/repo/a%20b.ts", "候选顺序：原路径（字面）排在解码变体之前，先命中先返回（文件真名含 %20 不被带偏）");
}

// ---------- 用例 2：factKind / INFERENCE_WORDS / LINE_REF ----------
{
  log("=== 用例 2：factKind 三类 + 推论词表 + LINE_REF ===");
  assert(factKind("通用事实：Go 的 map 迭代无序") === "general", "「通用事实：」→ general");
  assert(factKind("运行时条件：进程以 root 运行") === "condition", "「运行时条件：」→ condition");
  assert(factKind("ratchet.go 第 881 行判 Layer") === "code", "其余 → code");
  assert(INFERENCE_WORDS.test("这会导致空指针") && !INFERENCE_WORDS.test("第 3 行赋值为 nil"), "INFERENCE_WORDS 命中/不命中");
  assert(
    !INFERENCE_WORDS.test("这是权限校验故障，第 5 行抛错") && !INFERENCE_WORDS.test("按钮的可见性由第 8 行控制"),
    "INFERENCE_WORDS 不误伤「故障」「可见性」（设计 v4 §3.2 去掉单字「故」「可见」）",
  );
  assert(
    INFERENCE_WORDS.test("第 5 行判空，故而不会抛错") &&
      INFERENCE_WORDS.test("第 6 行同理，故此可省略校验") &&
      INFERENCE_WORDS.test("第 7 行为真，由此可见调用方未处理"),
    "INFERENCE_WORDS 命中多字推论词「故而/故此/由此可见」",
  );
  assert(LINE_REF.test("第 12 行") && LINE_REF.test("第 3.2 节") && LINE_REF.test("§4.1") && LINE_REF.test("见 L88") && LINE_REF.test("x.go:12-20") && !LINE_REF.test("没有引用"), "LINE_REF 五种写法");
  assert(
    !LINE_REF.test("见 http://127.0.0.1:8760") && !LINE_REF.test("端点是 127.0.0.1:8760") && !LINE_REF.test("8760"),
    "LINE_REF 不把 IP:端口 误判为行号引用（「:数字」只在文件扩展名之后才算）",
  );
}

// ---------- 用例 3：anchorHit 四态 + 归一化（徐总 09-20 追加裁定「优化 6」）----------
{
  log("=== 用例 3：anchorHit（OK / 行号已校正 / 锚点不唯一 / 锚点未命中 + 归一化）===");
  const segs = materials.get(ABS_GO)!;

  const ok = anchorHit("management_proof_missing", segs, 881, 882);
  assert(ok.status === "OK" && ok.line === 881, `范围内命中 → OK，line=881（实际 ${JSON.stringify(ok)}）`);

  const corrected = anchorHit("svcIdentityMatches", segs, 881, 882);
  assert(corrected.status === "行号已校正" && corrected.line === 884, `范围外唯一命中（884 行）→ 行号已校正（实际 ${JSON.stringify(corrected)}）`);

  const ambiguous = anchorHit("return", segs, 884, 885);
  assert(ambiguous.status === "锚点不唯一", `范围外多处命中（882/889/901）→ 锚点不唯一（实际 ${JSON.stringify(ambiguous)}）`);

  const miss = anchorHit("totally_absent_xyz", segs, 881, 882);
  assert(miss.status === "锚点未命中", `哪里都找不到 → 锚点未命中（实际 ${JSON.stringify(miss)}）`);

  // 归一化：剥行号前缀 / 去空白 / 去 \r 不影响命中。
  const withPrefix = anchorHit("881| management_proof_missing", segs, 881, 882);
  assert(withPrefix.status === "OK" && withPrefix.line === 881, `剥行号前缀后仍命中：${JSON.stringify(withPrefix)}`);
  const withWhitespace = anchorHit("  management _ proof_missing\r", segs, 881, 882);
  assert(withWhitespace.status === "OK", `多余空白/回车不影响命中：${JSON.stringify(withWhitespace)}`);

  const empty = anchorHit("", segs, 881, 882);
  assert(empty.status === "锚点未命中", "空 anchor 归一后为空串 → 锚点未命中（不误判为处处命中）");
}

// ---------- 用例 4：validateFinding 逐条规则 ----------
{
  log("=== 用例 4：§3.2 规则表逐条 ===");
  assert(validateFinding(okFinding(), materials, CWD, readRoots).length === 0, "基线 finding 合格（零错误）");

  const e1 = firstErr(okFinding({ path: "internal/x/nope.go" }));
  assert(e1 === "F1：路径「internal/x/nope.go」不在本轮附入材料里；可用：internal/x/ratchet.go、/other-repo/docs/spec.md", `路径不在材料：${e1}`);

  const e2 = firstErr(okFinding({ lines: "895-896" }));
  assert(e2 === "F1：行号 895-896 越界或跨度超 200（该文件附入区间：880-891、900-905）", `行号落在未附入缝隙：${e2}`);
  const e2b = firstErr(okFinding({ lines: "885-882" }));
  assert(e2b === "F1：行号 885-882 越界或跨度超 200（该文件附入区间：880-891、900-905）", `a>b：${e2b}`);
  const e2c = firstErr(okFinding({ lines: "880-1100" }));
  assert(e2c.startsWith("F1：行号 880-1100 越界或跨度超 200"), `跨度 >200：${e2c}`);
  const e2d = firstErr(okFinding({ lines: "885-900" }));
  assert(e2d.startsWith("F1：行号 885-900 越界"), `横跨两段（中间有缝）也算越界：${e2d}`);

  // anchor 定位不是 REJECT 理由（设计 v4 §3.2「anchor 定位（不 REJECT）」行）：validateFinding 对四态
  // 均不报错，无论范围内命中 / 范围外唯一 / 不唯一 / 未命中。
  for (const [label, anchor] of [
    ["范围内命中", "management_proof_missing"],
    ["范围外唯一（会被校正）", "svcIdentityMatches"],
    ["范围外多处（不唯一）", "return"],
    ["哪里都找不到", "totally_absent_xyz"],
  ] as const) {
    const errs = validateFinding(okFinding({ anchor }), materials, CWD, readRoots);
    assert(errs.length === 0, `anchor=${label} 不产生 REJECT 错误：${JSON.stringify(errs)}`);
  }

  const e4 = firstErr(okFinding({ facts: ["ratchet.go 第 881 行判 Layer，因此 Kind 为空会放行", "通用事实：x", "通用事实：y"] }));
  assert(e4?.startsWith("F1：第 1 条含推论词「因此」，事实只写代码怎么写的或通用规范，推论放进 claim（原文："), `推论词（带原文）：${e4}`);
  const e4b = firstErr(okFinding({ facts: ["ratchet.go 第 881 行判 Layer", "通用事实：Go 的 || 短路，所以右侧不算", "通用事实：y"] }));
  assert(e4b?.startsWith("F1：第 2 条含推论词「所以」，事实只写代码怎么写的或通用规范，推论放进 claim（原文："), `通用事实同样查推论词：${e4b}`);
  const noErr = validateFinding(okFinding({ facts: ["ratchet.go 第 881 行判 Layer", "运行时条件：命令行可被篡改，因此攻击者可控", "通用事实：y"] }), materials, CWD, readRoots);
  assert(noErr.length === 0, "运行时条件类不查推论词");

  // 长度 / 条数上限在处理器层用人话拒（schema 只兜底）：anchor >160、facts 不在 3–8、fact >320、claim >500
  // （§12.6 第 6 点，2026-09-20：claim/fix_expect 500、单条事实 320，灰度第 4 轮真实分布放宽）
  const eLenA = firstErr(okFinding({ anchor: `opaqueHoleRegistryAdjudicated does not enforce universal-RELATE writers before closing the edge ${"and more words ".repeat(6)}` }));
  assert(eLenA?.startsWith("F1：anchor 超过 160 字（") && eLenA.includes("逐字抄"), `anchor 超长用人话拒：${eLenA}`);
  const eLenB = firstErr(okFinding({ facts: ["ratchet.go 第 881 行判 Layer", "通用事实：x"] }));
  assert(eLenB === "F1：facts 须 3–8 条（现 2 条）", `facts 条数：${eLenB}`);
  const eLenC = firstErr(okFinding({ facts: [`ratchet.go 第 881 行 ${"很长".repeat(170)}`, "通用事实：x", "通用事实：y"] }));
  assert(eLenC?.startsWith("F1：第 1 条事实超过 320 字"), `fact 超长：${eLenC}`);
  const eLenD = firstErr(okFinding({ claim: "缺".repeat(501) }));
  assert(eLenD?.startsWith("F1：claim 超过 500 字"), `claim 超长：${eLenD}`);

  const e5 = firstErr(okFinding({ facts: ["ratchet.go 判 Layer 与 Kind", "通用事实：x", "通用事实：y"] }));
  assert(e5 === "F1：第 1 条代码事实没有行号；通用事实请以「通用事实：」开头，环境条件请以「运行时条件：」开头（原文：ratchet.go 判 Layer 与 Kind）", `代码事实无行号（带原文）：${e5}`);
  assert(
    LINE_REF.test("决策记录第 74、78、89、100、111、122 行") && LINE_REF.test("第 5 至 9 行") && LINE_REF.test("第 12-20 行") && LINE_REF.test("第 3, 4 行"),
    "LINE_REF 接受枚举/区间写法（灰度第 3 轮误拒）",
  );

  const e6 = firstErr(okFinding({ claim: "该处不存在此问题，Kind 为空是合法输入" }));
  assert(e6 === 'F1：claim 写成了「不成立」；要声明某处不存在缺陷请用 kind:"counter"', `claim 写成不成立：${e6}`);

  const e7 = firstErr(okFinding({ kind: "counter", level: "MINOR", claim: "该处不存在此问题，Kind 为空是合法输入" }));
  assert(e7 === "F1：counter 条目的 level 须为 COUNTER", `counter level 非 COUNTER：${e7}`);
  const okCounter = validateFinding(okFinding({ kind: "counter", level: "COUNTER", claim: "该处不存在此问题，Kind 为空是合法输入" }), materials, CWD, readRoots);
  assert(okCounter.length === 0, "counter 条目（level=COUNTER，claim 写不成立）合格");

  const multi = validateFinding(okFinding({ path: "nope.go", facts: ["无行号事实一", "无行号事实二", "无行号事实三"] }), materials, CWD, readRoots);
  assert(multi.length === 4 && multi[0]!.startsWith("F1：路径") && multi[1]!.startsWith("F1：第 1 条代码事实没有行号"), "路径不在材料时仍继续查 facts（多条错误并列）");
}

// ---------- 用例 5：submit_findings 工具处理器（REJECT / 接受 / id 重复 / 3 次上限 / 空清单 / anchor 四态）----------
async function run(tool: ReturnType<typeof createSubmitFindingsTool>, params: unknown): Promise<{ text: string; isError: boolean }> {
  const r = (await tool.execute("call-1", params as never, undefined, undefined, { cwd: CWD } as never)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: r.content[0]?.text ?? "", isError: r.isError === true };
}
{
  log("=== 用例 5：submit_findings 处理器 ===");
  const state = createFindingsState();
  const tool = createSubmitFindingsTool(state, materials, CWD, readRoots, { maxAttempts: 3 });
  assert(tool.name === "submit_findings", "工具名 submit_findings");

  const r1 = await run(tool, { findings: [okFinding(), okFinding({ id: "F1", lines: "882", anchor: "return nil" })] });
  assert(r1.isError && r1.text.startsWith("REJECT（第 1/3 次）：\n- 发现 id 重复：F1"), `id 重复 → REJECT 第 1/3 次：${r1.text.split("\n")[0]}`);
  assert(state.attempts === 1 && state.accepted === null && state.rejects.length === 1, "attempts=1、未接受、rejects 记 1 条");

  const r2 = await run(tool, {
    findings: [okFinding(), okFinding({ id: "F2", kind: "counter", level: "COUNTER", lines: "882", anchor: "return nil", claim: "该处不存在此问题，返回 nil 是设计意图" })],
  });
  assert(!r2.isError && r2.text === "已接受 2 条：F1 MAJOR internal/x/ratchet.go:881-882；F2 COUNTER internal/x/ratchet.go:882", `接受文案（两条 anchor 均在范围内命中，无校正提示）：${r2.text}`);
  assert(state.accepted?.length === 2 && state.attempts === 2, "accepted 写入 state（2 条）、attempts=2");
  assert(state.refs.get("F1")?.status === "OK" && state.refs.get("F2")?.status === "OK", "refs 对两条均登记 OK");

  const r3 = await run(tool, { findings: [okFinding({ lines: "895" })] });
  assert(r3.isError && r3.text.includes("REJECT（第 3/3 次）") && r3.text.endsWith("已达上限，本次审查将按未结构化处理"), `第 3 次不合格附「已达上限…未结构化」：${r3.text.split("\n").pop()}`);
  assert(state.accepted?.length === 2, "不合格的重提不覆盖此前已接受的清单");

  const r4 = await run(tool, { findings: [okFinding()] });
  assert(r4.isError && r4.text.includes("第 4/3 次") && r4.text.includes("已超过提交次数上限"), `第 4 次直接拒：${r4.text.split("\n")[0]}`);
  assert(state.attempts === 4 && state.rejects.length === 3, "attempts=4、rejects=3");

  // 硬门文案
  const hard = createFindingsState();
  const hardTool = createSubmitFindingsTool(hard, materials, CWD, readRoots, { maxAttempts: 1, required: true });
  const rh = await run(hardTool, { findings: [okFinding({ lines: "895" })] });
  assert(rh.text.endsWith("已达上限，本次审查将按失败处理"), "硬门（required）达到上限文案「按失败处理」");

  // 空数组 + no_findings_reason（接受）
  const empty = createFindingsState();
  const emptyTool = createSubmitFindingsTool(empty, materials, CWD, readRoots, { maxAttempts: 3 });
  const re = await run(emptyTool, { findings: [], no_findings_reason: "两段材料均无缺陷" });
  assert(!re.isError && re.text === "已接受 0 条（无发现：两段材料均无缺陷）" && empty.accepted?.length === 0, `空清单接受：${re.text}`);

  // 空数组 + 无理由 → REJECT
  const noReason = createFindingsState();
  const noReasonTool = createSubmitFindingsTool(noReason, materials, CWD, readRoots, { maxAttempts: 3 });
  const rnr = await run(noReasonTool, { findings: [] });
  assert(rnr.isError && rnr.text === "REJECT（第 1/3 次）：\n- 空清单必须填 no_findings_reason", `空清单无理由 → REJECT：${rnr.text}`);
  assert(noReason.accepted === null, "空清单无理由未被接受");

  // REJECT 最多 15 条
  const many = createFindingsState();
  const manyTool = createSubmitFindingsTool(many, materials, CWD, readRoots, { maxAttempts: 3 });
  const bad = Array.from({ length: 20 }, (_, i) => okFinding({ id: `F${i + 1}`, path: "nope.go" }));
  const rm = await run(manyTool, { findings: bad });
  assert(rm.text.split("\n- ").length - 1 === 15 && rm.text.includes("（另有 5 条未列出）"), "REJECT 最多回 15 条并注明其余条数");

  // 最后一次提交接受合格子集（徐总 2026-09-20 定）：第 3 次仍有 1 条不合格 → 接受其余 2 条、丢弃 1 条并登记；前两次照旧整单 REJECT
  const partState = createFindingsState();
  const partTool = createSubmitFindingsTool(partState, materials, CWD, readRoots, { maxAttempts: 3 });
  const mixed = () => [okFinding({ id: "F1" }), okFinding({ id: "F2", lines: "882", anchor: "return nil" }), okFinding({ id: "F3", path: "nope.go" })];
  const p1 = await run(partTool, { findings: mixed() });
  const p2 = await run(partTool, { findings: mixed() });
  assert(p1.isError && p2.isError && partState.accepted === null, "前两次仍整单 REJECT");
  const p3 = await run(partTool, { findings: mixed() });
  assert(!p3.isError && p3.text.startsWith("已接受 2 条：") && p3.text.includes("F3 因校验未过被丢弃"), `第 3 次接受合格子集并登记丢弃：${p3.text}`);
  assert(partState.accepted?.map((f) => f.id).join(",") === "F1,F2" && partState.dropped?.[0]?.id === "F3" && partState.dropped[0].errors.length > 0, "state.accepted 只含合格条、dropped 记不合格条与原因");
  assert(partState.rejects[2]?.startsWith("PARTIAL（第 3/3 次）：接受 2 条，丢弃 1 条"), `rejects 记 PARTIAL：${partState.rejects[2]}`);
  // 第 3 次全部不合格 → 仍 REJECT
  const allBad = createFindingsState();
  const allBadTool = createSubmitFindingsTool(allBad, materials, CWD, readRoots, { maxAttempts: 3 });
  for (let i = 0; i < 3; i++) await run(allBadTool, { findings: [okFinding({ path: "nope.go" })] });
  assert(allBad.accepted === null && allBad.rejects[2]?.includes("已达上限"), "第 3 次全部不合格仍 REJECT 并标已达上限");

  // kind 缺省 finding
  const dflt = createFindingsState();
  const dfltTool = createSubmitFindingsTool(dflt, materials, CWD, readRoots, { maxAttempts: 3 });
  const f = okFinding();
  delete (f as Partial<Finding>).kind;
  await run(dfltTool, { findings: [f] });
  assert(dflt.accepted?.[0]?.kind === "finding", "kind 缺省补为 finding");

  // ---- anchor 四态经工具端到端：不 REJECT，refs 登记，「行号已校正」时就地校正 lines ----
  const corrState = createFindingsState();
  const corrTool = createSubmitFindingsTool(corrState, materials, CWD, readRoots, { maxAttempts: 3 });
  const rCorr = await run(corrTool, { findings: [okFinding({ anchor: "svcIdentityMatches" })] }); // 默认 lines=881-882，anchor 只在 884 唯一
  assert(!rCorr.isError, `anchor 范围外唯一命中仍被接受（不 REJECT）：${rCorr.text}`);
  assert(rCorr.text.includes("F1：锚点在第 884 行而非第 881-882 行，已校正"), `接受文案附校正提示：${rCorr.text}`);
  assert(corrState.accepted?.[0]?.lines === "884-885", `finding.lines 就地校正为命中行、保持原跨度（1）：实际 ${corrState.accepted?.[0]?.lines}`);
  const corrRef = corrState.refs.get("F1");
  assert(corrRef?.status === "行号已校正" && corrRef.line === 884 && corrRef.originalLines === "881-882", `refs 登记校正状态：${JSON.stringify(corrRef)}`);

  // 跨段外推：anchor "helper" 只在第 900 行（第二段 900-905）唯一命中，原跨度 11 行外推到 911 越出段末 → 截到 905
  const clampState = createFindingsState();
  const clampTool = createSubmitFindingsTool(clampState, materials, CWD, readRoots, { maxAttempts: 3 });
  const rClamp = await run(clampTool, { findings: [okFinding({ lines: "880-891", anchor: "helper" })] });
  assert(!rClamp.isError && rClamp.text.includes("F1：锚点在第 900 行而非第 880-891 行，已校正"), `跨段校正被接受并提示：${rClamp.text}`);
  assert(clampState.accepted?.[0]?.lines === "900-905", `校正后跨度越出段末时截到段末（900-905）：实际 ${clampState.accepted?.[0]?.lines}`);
  assert(clampState.refs.get("F1")?.status === "行号已校正" && clampState.refs.get("F1")?.line === 900, "refs 登记校正到第 900 行");
  // 校正后跨度未越段：第 900 行外推 1 行 → 900-901 不截
  const clamp2 = createFindingsState();
  await run(createSubmitFindingsTool(clamp2, materials, CWD, readRoots, { maxAttempts: 3 }), { findings: [okFinding({ lines: "880-881", anchor: "helper" })] });
  assert(clamp2.accepted?.[0]?.lines === "900-901", `跨度未越段时保持原跨度（900-901）：实际 ${clamp2.accepted?.[0]?.lines}`);

  // 按标识符匹配（徐总 09-20：不能只靠提示词约束 anchor）：描述句里的标识符在引用行内 → OK（via 标识符）；
  // 在引用行外唯一 → 行号已校正；没有标识符类 token 的纯描述 → 锚点未命中；英文常用词不算标识符。
  assert(identifierTokens("svcIdentityMatches is called without nil check").join(",") === "svcIdentityMatches", "identifierTokens 只抽驼峰/下划线/数字/长词");
  assert(identifierTokens("return value ignored here").length === 0, "纯英文短词不算标识符");
  const viaOk = anchorHit("svcIdentityMatches is called without nil check", materials.get(ABS_GO)!, 884, 885);
  assert(viaOk.status === "OK" && viaOk.via === "标识符" && viaOk.token === "svcIdentityMatches" && viaOk.line === 884, `描述句含标识符、在引用行内 → OK（via 标识符）：${JSON.stringify(viaOk)}`);
  const viaFix = anchorHit("svcIdentityMatches is called without nil check", materials.get(ABS_GO)!, 881, 882);
  assert(viaFix.status === "行号已校正" && viaFix.line === 884 && viaFix.via === "标识符", `描述句标识符在引用行外唯一 → 行号已校正：${JSON.stringify(viaFix)}`);
  const viaMiss = anchorHit("return value ignored here", materials.get(ABS_GO)!, 881, 882);
  assert(viaMiss.status === "锚点未命中", `无标识符 token 的描述 → 未命中：${JSON.stringify(viaMiss)}`);
  const viaState = createFindingsState();
  const viaTool = createSubmitFindingsTool(viaState, materials, CWD, readRoots, { maxAttempts: 3 });
  const rVia = await run(viaTool, { findings: [okFinding({ lines: "884-885", anchor: "svcIdentityMatches is called without nil check" })] });
  assert(!rVia.isError && rVia.text.includes("按其中的标识符「svcIdentityMatches」命中") && viaState.refs.get("F1")?.via === "标识符", `工具端到端：via 标识符登记并提示：${rVia.text}`);

  const ambigState = createFindingsState();
  const ambigTool = createSubmitFindingsTool(ambigState, materials, CWD, readRoots, { maxAttempts: 3 });
  const rAmbig = await run(ambigTool, { findings: [okFinding({ lines: "884-885", anchor: "return" })] });
  assert(!rAmbig.isError, `anchor 不唯一仍被接受（不 REJECT）：${rAmbig.text}`);
  assert(rAmbig.text.includes("F1：锚点在文件里多处出现，未校正，请用更有辨识度的片段"), `接受文案附不唯一提示：${rAmbig.text}`);
  assert(ambigState.accepted?.[0]?.lines === "884-885", "锚点不唯一时 lines 不被改动");
  assert(ambigState.refs.get("F1")?.status === "锚点不唯一", "refs 登记「锚点不唯一」");

  const missState = createFindingsState();
  const missTool = createSubmitFindingsTool(missState, materials, CWD, readRoots, { maxAttempts: 3 });
  const rMiss = await run(missTool, { findings: [okFinding({ anchor: "totally_absent_xyz" })] });
  assert(!rMiss.isError, `anchor 未命中仍被接受（不 REJECT）：${rMiss.text}`);
  assert(rMiss.text.includes("F1：锚点「totally_absent_xyz」在 internal/x/ratchet.go 里找不到，已登记"), `接受文案附未命中提示：${rMiss.text}`);
  assert(missState.accepted?.[0]?.lines === "881-882", "锚点未命中时 lines 不被改动");
  assert(missState.refs.get("F1")?.status === "锚点未命中", "refs 登记「锚点未命中」");
}

// ---------- 用例 6：amend_facts（AmendState，与 FindingsState 不共享）----------
{
  log("=== 用例 6：amend_facts（目标不符 / 推论词 / 接受 / 无法补充 / 3 次上限 / AmendState 一致性）===");
  const state = createAmendState();
  const tool = createAmendFactsTool(state, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  assert(tool.name === "amend_facts", "工具名 amend_facts");

  const w = await run(tool, { id: "F4", facts: ["ratchet.go 第 881 行判 Layer"] });
  assert(w.isError && w.text === "REJECT（本会话只处理 F3，收到 F4）", `目标不符：${w.text}`);
  assert(state.accepted === null && state.attempts === 1 && state.rejects.length === 1, "目标不符：不写 accepted，attempts/rejects 与 execute 计数一致（同一对象）");

  const bad = await run(tool, { id: "F3", facts: ["ratchet.go 第 881 行判 Layer，从而放行"] });
  assert(bad.isError && bad.text.includes("F3：第 1 条含推论词「从而」"), `推论词被拒：${bad.text.split("\n")[1]}`);
  assert(state.attempts === 2 && state.rejects.length === 2, "第 2 次调用后 attempts=2、rejects=2（AmendState 累计）");

  const ok = await run(tool, {
    id: "F3",
    facts: ["ratchet.go 第 884 行把 origin.Command 传给 svcIdentityMatches", "运行时条件：命令行参数可由无关进程写入"],
  });
  assert(!ok.isError && ok.text === "已为 F3 补充 2 条前提", `第 3 次合格，接受文案：${ok.text}`);
  assert(state.accepted?.length === 2 && state.attempts === 3, "accepted 写入 AmendState.accepted（数组，非嵌套 Map）、attempts=3");

  const over = await run(tool, { id: "F3", facts: [], cannot_amend_reason: "材料里核不出来" });
  assert(over.isError && over.text.includes("已超过提交次数上限 3"), "第 4 次（含目标不符那次）超过 3 次上限");
  assert(state.accepted?.length === 2, "超限提交不覆盖已接受的补充");

  const s1 = createAmendState();
  const t1 = createAmendFactsTool(s1, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const bad2 = await run(t1, { id: "F3", facts: ["没有行号的代码事实"] });
  assert(bad2.isError && bad2.text.includes("F3：第 1 条代码事实没有行号"), "无行号被拒");
  for (let i = 0; i < 2; i++) await run(t1, { id: "F3", facts: ["没有行号的代码事实"] });
  assert(s1.rejects[s1.rejects.length - 1]?.endsWith("已达上限，该条按未补充处理"), "连续 3 次不合格附「已达上限，该条按未补充处理」");
  assert(s1.attempts === 3, "AmendState.attempts 与 execute 调用次数一致（3 次）");

  const s2 = createAmendState();
  const t2 = createAmendFactsTool(s2, materials, { id: "F9", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const cant = await run(t2, { id: "F9", facts: [], cannot_amend_reason: "材料里核不出来" });
  assert(
    !cant.isError && cant.text === "已记录 F9 无法补充：材料里核不出来" && s2.accepted?.length === 0 && s2.reason === "材料里核不出来",
    `无法补充：${cant.text}`,
  );
}

// ---------- 用例 7：checkFactRef 七态（设计 v4 §12.2 A，徐总 09-20 裁定「办法三」全部照做，波四）----------
// A 段概述给六态，但其算法与 §12.2 C 分流表都要区分「同文件也找不到（未命中，直接判不符）」与
// 「多处命中（待核，仍问 Jev）」——本实现按算法字面实现七态，见 submit_findings.ts FactRefStatus 头注。
{
  log("=== 用例 7：checkFactRef（相符含引号常量 / ±2 容差 / 已校正 / 待核 / 无标识符 / 文件未附 / 行号越界 / 未命中）===");

  // 相符：引号内字符串常量作 token——"no command" 是多词短语，identifierTokens 单独抓不出任一半个词
  // （"no" 长度 <4，"command" 无大写/下划线/数字且长度 <12），只有 quotedConstants 能把整个引号短语当 token。
  const quotedOk = checkFactRef('ratchet.go 第 886 行返回 "no command" 错误', "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(quotedOk.status === "相符" && quotedOk.token === "no command", `引号常量命中 → 相符：${JSON.stringify(quotedOk)}`);

  // ±2 容差：写的是 883 行（`}`），真正命中的 svcIdentityMatches 在 884 行（883+1，落在 883±2 窗口内）。
  const tolOk = checkFactRef("ratchet.go 第 883 行通过 svcIdentityMatches 校验", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(tolOk.status === "相符" && tolOk.token === "svcIdentityMatches", `±2 容差命中 → 相符：${JSON.stringify(tolOk)}`);

  // 已校正：写的是 900 行（func helper 所在行，无此 token），svcIdentityMatches 同文件唯一命中在 884。
  const corrected = checkFactRef("ratchet.go 第 900 行调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(
    corrected.status === "已校正" && corrected.a === 884 && corrected.b === 884 && corrected.originalLine === "900",
    `唯一命中同文件其它处 → 已校正：${JSON.stringify(corrected)}`,
  );

  // 待核：token「RatchetHelperName」在同文件两处出现（自建小材料，避免与共享 fixture 的 Ratchet 撞车）。
  const dupMaterials: MaterialMap = new Map();
  dupMaterials.set("/repo/dup.go", [
    seg("/repo/dup.go", "dup.go", "range", 1, ["func RatchetHelperName() {", "\treturn", "}", "", "// nothing here"]),
    seg("/repo/dup.go", "dup.go", "range", 10, ["// calls RatchetHelperName again", "var _ = 1"]),
  ]);
  const pending = checkFactRef("dup.go 第 5 行调用 RatchetHelperName", "dup.go", dupMaterials, CWD, readRoots);
  assert(pending.status === "待核", `多处命中（不校正）→ 待核：${JSON.stringify(pending)}`);

  // 无标识符：纯常用词描述，抽不出任何标识符/引号常量。
  const noIdent = checkFactRef("ratchet.go 第 881 行 the code does something ordinary", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(noIdent.status === "无标识符", `纯文字无可核 token → 无标识符：${JSON.stringify(noIdent)}`);

  // 文件未附：显式扩展名引用一个未附入的文件。
  const noFile = checkFactRef("./nope.go:5: something", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(noFile.status === "文件未附", `路径未附入材料 → 文件未附：${JSON.stringify(noFile)}`);

  // 行号越界：950 行离两段附入区间（880-891、900-905）都超过 ±2 容差。
  const outOfRange = checkFactRef("ratchet.go 第 950 行 something", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(outOfRange.status === "行号越界", `引用行不在任何附入段（含 ±2）→ 行号越界：${JSON.stringify(outOfRange)}`);

  // 未命中：抽得出标识符，但窗口内、同文件全部段都找不到——真正的引用错误。
  const miss = checkFactRef("ratchet.go 第 881 行使用 nonExistentTokenABC", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(miss.status === "未命中", `标识符全文件零命中 → 未命中：${JSON.stringify(miss)}`);

  // computeFactsRange：只取相符/已校正的区间并集，待核/未命中/无标识符/文件未附/行号越界不计入。
  const range = computeFactsRange([quotedOk, corrected, pending, noIdent, miss]);
  assert(range?.[0] === 884 && range[1] === 886, `computeFactsRange 只并相符/已校正的区间：${JSON.stringify(range)}`);
  assert(computeFactsRange([pending, miss, noIdent]) === undefined, "一条可核（相符/已校正）事实都没有 → undefined");
}

// ---------- 用例 8：三路互验 refConsistency（徐总 09-20 追加裁定，覆盖任务书原「lines/anchor 可选」条，
// 见设计 v4 §12.6 第 2 点改写版：anchor/lines 照旧必填，facts 引用行作第三路互验）----------
{
  log("=== 用例 8：refConsistency（三路一致 / anchor 外但与事实一致校正 / 三路不一致登记 / 无可核事实两路）===");

  // 一致：默认 okFinding()——anchor 在 lines(881-882) 内命中（OK），默认 facts[0] 引用第 881 行且相符，
  // factsRange=[881,881] 与 lines 有交集。
  const s8a = createFindingsState();
  const r8a = await run(createSubmitFindingsTool(s8a, materials, CWD, readRoots, { maxAttempts: 3 }), { findings: [okFinding()] });
  assert(!r8a.isError, `一致：不 REJECT：${r8a.text}`);
  assert(s8a.refs.get("F1")?.refConsistency === "一致", `三路一致 → refConsistency=一致：${JSON.stringify(s8a.refs.get("F1"))}`);

  // anchor 外但与事实一致：lines 仍写 881-882，anchor 只在 884 唯一命中（行号已校正），facts 也引用 884
  // 且相符（factsRange=[884,884]）——两路同向，按现行规则校正 lines 且判一致。
  const s8b = createFindingsState();
  const r8b = await run(createSubmitFindingsTool(s8b, materials, CWD, readRoots, { maxAttempts: 3 }), {
    findings: [
      okFinding({
        anchor: "svcIdentityMatches",
        facts: [
          "ratchet.go 第 884 行调用 svcIdentityMatches 生成 cmd",
          "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
          "运行时条件：origin.Command 取自无关进程的命令行",
        ],
      }),
    ],
  });
  assert(!r8b.isError && r8b.text.includes("lines 已按 anchor 与事实校正"), `anchor 外但与事实一致：${r8b.text}`);
  assert(s8b.accepted?.[0]?.lines === "884-885", `lines 按现行规则校正（不受门控）：实际 ${s8b.accepted?.[0]?.lines}`);
  assert(s8b.refs.get("F1")?.refConsistency === "一致", `两路同向 → refConsistency=一致：${JSON.stringify(s8b.refs.get("F1"))}`);

  // 不一致：anchor 仍只在 884 唯一命中（行号已校正），但 facts 改指向 900 行（"helper" 引号常量相符，
  // factsRange=[900,900]）——facts 与 anchor 各指一处，都不在原 lines(881-882) 内。
  const s8c = createFindingsState();
  const r8c = await run(createSubmitFindingsTool(s8c, materials, CWD, readRoots, { maxAttempts: 3 }), {
    findings: [
      okFinding({
        anchor: "svcIdentityMatches",
        facts: [
          'ratchet.go 第 900 行定义 "helper" 函数',
          "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
          "运行时条件：origin.Command 取自无关进程的命令行",
        ],
      }),
    ],
  });
  assert(!r8c.isError, `不一致仍不 REJECT：${r8c.text}`);
  assert(r8c.text.includes("引用不一致（lines 881-882 / anchor 884 / 事实 900-900），请复核"), `回执文案登记不一致：${r8c.text}`);
  const ref8c = s8c.refs.get("F1");
  assert(
    ref8c?.refConsistency === "不一致" && JSON.stringify(ref8c.factsRange) === "[900,900]" && ref8c.anchorLine === 884,
    `refs 登记三处位置：${JSON.stringify(ref8c)}`,
  );
  // 不 REJECT，且现行「行号已校正」规则不受门控——lines 仍按 anchor 校正（只是同时标了不一致供人工/aggregator 复核）。
  assert(s8c.accepted?.[0]?.lines === "884-885", `不一致不影响既有校正规则：实际 ${s8c.accepted?.[0]?.lines}`);

  // 仅两路：全是通用事实/运行时条件，没有可核 code 事实 → factsRange 算不出，退回 anchor+lines 两路互验。
  const s8d = createFindingsState();
  const r8d = await run(createSubmitFindingsTool(s8d, materials, CWD, readRoots, { maxAttempts: 3 }), {
    findings: [
      okFinding({
        facts: [
          "通用事实：Go 的 || 短路求值，左侧为真时不计算右侧",
          "通用事实：接口方法集在编译期确定",
          "运行时条件：origin.Command 取自无关进程的命令行",
        ],
      }),
    ],
  });
  assert(!r8d.isError, `仅两路不 REJECT：${r8d.text}`);
  assert(s8d.refs.get("F1")?.refConsistency === "仅两路", `无可核事实 → refConsistency=仅两路：${JSON.stringify(s8d.refs.get("F1"))}`);
  assert(s8d.factRefs.get("F1")?.length === 0, "factRefs 登记为空数组（没有 code 类事实）");
}

// ---------- 用例 9：amend_facts 补的事实同样过 checkFactRef（任务书第 1 点）----------
{
  log("=== 用例 9：amend_facts 补的事实过 checkFactRef，登记进 AmendState.factRefs ===");
  const s9 = createAmendState();
  const t9 = createAmendFactsTool(s9, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  await run(t9, {
    id: "F3",
    facts: ["ratchet.go 第 884 行把 origin.Command 传给 svcIdentityMatches", "运行时条件：命令行参数可由无关进程写入"],
  });
  assert(s9.factRefs?.length === 1, `factRefs 只含 code 类事实（1 条）：${JSON.stringify(s9.factRefs)}`);
  assert(s9.factRefs?.[0]?.status === "相符", `补充事实过 checkFactRef 判相符：${JSON.stringify(s9.factRefs?.[0])}`);
}


// ---------- 用例 10：行号解析与 LINE_REF 同口径 + 已校正改写事实文本 + amend schema 兜底（波四复审 2026-09-20，PiMoa P2/F2、P2/F7）----------
{
  log("=== 用例 10：parseFactLineRef 枚举/区间/裸文件名；rewriteFactLine；AmendFactsParams 兜底 ×3 ===");
  const en = parseFactLineRef("决策记录第 74、78、89 行都写了 foo");
  assert(
    en !== null && en.a === 74 && en.b === 89 && en.filePath === undefined && JSON.stringify(en.windows) === "[[74,74],[78,78],[89,89]]",
    `「第 74、78、89 行」枚举 → 三个单点窗口、[min,max]=[74,89]：${JSON.stringify(en)}`,
  );
  const zhi = parseFactLineRef("ratchet.go 第 5 至 9 行判断 Layer");
  assert(zhi !== null && zhi.a === 5 && zhi.b === 9 && JSON.stringify(zhi.windows) === "[[5,9]]", `「第 5 至 9 行」区间 → 一个 [5,9] 窗口：${JSON.stringify(zhi)}`);
  const mixed = parseFactLineRef("第 74-78、90 行");
  assert(mixed !== null && JSON.stringify(mixed.windows) === "[[74,78],[90,90]]", `混写「第 74-78、90 行」→ 两个窗口：${JSON.stringify(mixed)}`);
  const bare = parseFactLineRef("ratchet.go:884 调用 svcIdentityMatches");
  assert(bare !== null && bare.filePath === "ratchet.go" && bare.a === 884, `裸文件名「ratchet.go:884」可解析：${JSON.stringify(bare)}`);
  const rel = parseFactLineRef("见 internal/x/ratchet.go:884-886 的分支");
  assert(rel !== null && rel.filePath === "internal/x/ratchet.go" && rel.a === 884 && rel.b === 886, `相对路径「internal/x/ratchet.go:884-886」：${JSON.stringify(rel)}`);
  const ipPort = parseFactLineRef("服务监听 127.0.0.1:8760 端口");
  assert(ipPort === null, `IP:端口 不算行号引用：${JSON.stringify(ipPort)}`);

  // 枚举形态经 checkFactRef：窗口 [880-2, 884+2] 含 884 → 相符（此前判「无标识符」退回 Jev）
  const enumOk = checkFactRef("ratchet.go 第 882、884 行调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(enumOk.status === "相符" && enumOk.token === "svcIdentityMatches", `枚举形态过机械校验 → 相符：${JSON.stringify(enumOk)}`);
  const bareOk = checkFactRef("ratchet.go:884 调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(bareOk.status === "相符", `裸文件名形态过机械校验 → 相符：${JSON.stringify(bareOk)}`);

  // 逐窗核对（PiMoa 复审 P1/F1+P2/F2：不能取 [min,max] 当一个大窗口）
  const partial = checkFactRef("ratchet.go 第 884、901 行都调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(partial.status === "待核", `枚举里 884 命中、901（窗口 899-903）不命中 → 待核而非相符：${JSON.stringify(partial)}`);
  const wideEnum = checkFactRef("ratchet.go 第 880、905 行都有 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(wideEnum.status === "待核", `「第 880、905 行」两个单点窗口：880 窗(878-882)不含、905 窗不含 → 不是相符（此前 [880,905] 大窗口任一命中即相符）：${JSON.stringify(wideEnum)}`);
  const enumOut = checkFactRef("ratchet.go 第 884、950 行调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(enumOut.status === "行号越界", `枚举里任一行落在附入段外 → 行号越界：${JSON.stringify(enumOut)}`);
  const wideRange = checkFactRef("ratchet.go 第 850 至 905 行里调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(wideRange.status === "待核", `区间跨度 55 > ${FACT_REF_MAX_WINDOW_SPAN} → 待核（不做机械判定）：${JSON.stringify(wideRange)}`);
  const okRange = checkFactRef("ratchet.go 第 880 至 891 行里调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(okRange.status === "相符", `区间跨度 11 内命中 → 相符：${JSON.stringify(okRange)}`);
  const multiNoCorrect = checkFactRef("ratchet.go 第 900、902 行调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(multiNoCorrect.status === "待核" && multiNoCorrect.rewritten === undefined, `多窗口全未命中、同文件唯一命中 → 不校正（枚举没法改成单行）记待核：${JSON.stringify(multiNoCorrect)}`);

  // 多候选文件消不了歧 → 待核（PiMoa 复审 P1/F6+P2/F4）
  const twoFiles: MaterialMap = new Map();
  twoFiles.set("/repo/a/util.go", [seg("/repo/a/util.go", "a/util.go", "range", 1, ["func helperA() {}", "x"])]);
  twoFiles.set("/repo/b/util.go", [seg("/repo/b/util.go", "b/util.go", "range", 1, ["func helperB() {}", "y"])]);
  const ambiguous = checkFactRef("util.go:1 定义 helperA", "c/other.go", twoFiles, CWD, readRoots);
  assert(ambiguous.status === "待核", `裸文件名两候选、finding.path 不在其中 → 待核不猜：${JSON.stringify(ambiguous)}`);
  const disamb = checkFactRef("util.go:1 定义 helperA", "a/util.go", twoFiles, CWD, readRoots);
  assert(disamb.status === "相符" && disamb.file === "a/util.go", `finding.path 能消歧 → 选它并核对：${JSON.stringify(disamb)}`);

  // 已校正：rewritten 把事实里的行号改成校正后的行，text 仍是原文
  const corr = checkFactRef("ratchet.go 第 900 行调用 svcIdentityMatches", "internal/x/ratchet.go", materials, CWD, readRoots);
  assert(
    corr.status === "已校正" && corr.rewritten === "ratchet.go 第 884 行调用 svcIdentityMatches" && corr.text === "ratchet.go 第 900 行调用 svcIdentityMatches",
    `已校正 → rewritten 改行号、text 保留原文：${JSON.stringify(corr)}`,
  );
  assert(rewriteFactLine("internal/x/ratchet.go:900 调用 X", 884) === "internal/x/ratchet.go:884 调用 X", "rewriteFactLine：path:N 形态");
  assert(rewriteFactLine("见 L900 处", 884) === "见 L884 处", "rewriteFactLine：LN 形态");
  assert(rewriteFactLine("第 900-903 行调用", 884) === "第 884 行调用", "rewriteFactLine：区间整体替换为单行");

  // 灰度第 6 轮：文件名 stem 不是标识符（devkb_writes_table 被当 token 去代码里找 → 14 条事实误判不符）；
  // 引号配对串位产生的长「常量」不算 token。
  const wt: MaterialMap = new Map();
  wt.set("/repo/cmd/papergo/devkb_writes_table.go", [
    seg("/repo/cmd/papergo/devkb_writes_table.go", "cmd/papergo/devkb_writes_table.go", "range", 1690, ["\tcase *ast.Ident:", "\t\treturn resolveIdentifier(scope, e)", "\tdefault:", "\t\treturn opaqueHoleMarker", "\t}"]),
  ]);
  const stemOnly = checkFactRef("cmd/papergo/devkb_writes_table.go 第 1692 行 default 分支直接返回占位符", "cmd/papergo/devkb_writes_table.go", wt, CWD, readRoots);
  assert(stemOnly.status === "无标识符", `文件名 stem 不当标识符：抽不出别的 token → 无标识符（交 Jev）而非未命中：${JSON.stringify(stemOnly)}`);
  const stemPlus = checkFactRef("cmd/papergo/devkb_writes_table.go 第 1691 行调用 resolveIdentifier", "cmd/papergo/devkb_writes_table.go", wt, CWD, readRoots);
  assert(stemPlus.status === "相符" && stemPlus.token === "resolveIdentifier", `剥掉路径后仍抽得出真标识符 → 相符：${JSON.stringify(stemPlus)}`);
  assert(JSON.stringify(factCheckTokens('"⟨" 开头时单独成 string token，闭合符用 strings.Index(rest, "⟩")')) === "[]", `引号串位的长「常量」不算 token：${JSON.stringify(factCheckTokens('"⟨" 开头时单独成 string token，闭合符用 strings.Index(rest, "⟩")'))}`);
  assert(JSON.stringify(factCheckTokens('返回 "no command" 错误')) === JSON.stringify(["no command"]), "正常引号常量仍抽得出");

  const amendMax = (AmendFactsParams as unknown as { properties: { facts: { items: { maxLength: number } } } }).properties.facts.items.maxLength;
  assert(amendMax === 960, `AmendFactsParams.facts 兜底 = 960（=factMax 320 ×3），实际 ${amendMax}`);
}

// ---------- 用例 11:★PIMOA-DEF-11(2026-09-27)——LINE_REF 抽行号内核后逐字节不变；LINE_NO_REF 只认「第…行」 ----------
//    另含 ★2026-09-27 C 提示词预防：submit_findings / amend_facts 工具描述以原句收尾（不占 DEF 号）。
{
  log("=== 用例 11：★PIMOA-DEF-11 LINE_REF 不回退 + LINE_NO_REF 口径；C 提示词预防 ===");
  // 改前 LINE_REF 字面量（submit_findings.ts.bak-def10-20260927 第 199 行原样）
  const OLD_LINE_REF =
    /(第\s*\d+(?:\s*[-–~.、,，/]\s*\d+|\s*(?:至|到)\s*\d+)*\s*(?:行|节)|§\s*\d+(?:\.\d+)*|\bL\d+\b|\.(?:ts|mts|go|sh|md|yaml|yml|json|surql|py)[:#]L?\d+(?:-\d+)?)/;
  assert(LINE_REF.source === OLD_LINE_REF.source && LINE_REF.flags === OLD_LINE_REF.flags, "① LINE_REF 的 source/flags 与改前逐字节相同（不回退：facts 行号口径零变化）");
  for (const f of ["第 74 行", "第 74、78 行", "第 5 至 9 行", "第 12-20 行"]) assert(LINE_NO_REF.test(f), `② LINE_NO_REF 认「${f}」`);
  for (const f of ["第 3 节", "§4.2", "L57", "a.go:57", "第一行"]) assert(!LINE_NO_REF.test(f), `② LINE_NO_REF 不认「${f}」（只收「第…行」，节/§/L/位置引用归另两类或不算）`);

  const NOTE = "参数必须是纯 JSON 对象(raw JSON):禁止 ``` 围栏、注释、任何非 JSON 内容。";
  assert(RAW_JSON_ARGS_NOTE === NOTE, "③ C 提示词预防：追加句与派单原句一字不差");
  const sf = createSubmitFindingsTool(createFindingsState(), materials, CWD, readRoots, { maxAttempts: 3 });
  const af = createAmendFactsTool(createAmendState(), materials, { id: "F3", path: "internal/x/ratchet.go" } as never, CWD, readRoots);
  assert(sf.description.endsWith(NOTE), "③ submit_findings 描述以原句收尾");
  assert(af.description.endsWith(NOTE), "③ amend_facts 描述以原句收尾");
  assert(!JSON.stringify(sf.parameters).includes("raw JSON") && !JSON.stringify(af.parameters).includes("raw JSON"), "③ 只改描述，不落 schema（反向自证：参数 schema 里没有该句）");
}

// ---------- 用例 12:★2026-09-27 批次 1 fix 批 F1——amend 错 target 走「REJECT（」前缀，归 handler 不进 DEF-10 schema 拒计次 ----------
{
  log("=== 用例 12：★批次 1 fix 批 F1 错 target 文案与会话层归类对齐 ===");
  const state = createAmendState();
  const tool = createAmendFactsTool(state, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const w = await run(tool, { id: "F9", facts: ["ratchet.go 第 881 行判 Layer"] });
  assert(w.isError && w.text.startsWith("REJECT（"), `① 错 target 文案以「REJECT（」开头：${w.text}`);
  assert(!w.text.startsWith("REJECT："), "① 反向自证：不再是全角冒号「REJECT：」（改前会被误记为 schema 拒）");
  const kind = classifyStructuredToolEnd({ toolName: "amend_facts", isError: true, result: { content: [{ type: "text", text: w.text }] } });
  assert(kind === "handler", `② 错 target 归 handler（业务拒），不进 schema 拒计次（实际 ${kind}）`);
  const oldKind = classifyStructuredToolEnd({ toolName: "amend_facts", isError: true, result: { content: [{ type: "text", text: w.text.replace(/^REJECT（/, "REJECT：") }] } });
  assert(oldKind !== "schema_reject", `② 即便残留旧冒号文案，也只落 tool_error、不再误记 schema 拒（实际 ${oldKind}）`);
  assert(state.attempts === 1 && state.rejects.length === 1 && state.rejects[0] === w.text, "③ 业务计数不变：attempts=1、rejects 记同一原文");
}

// ---------- 用例 13：★PIMOA-DEF-09（2026-09-27）——路径形态兜底：%20 / 尾部相对 / 裸文件名 + 多候选消歧 ----------
{
  log("=== 用例 13：DEF-09 路径形态兜底（REPRO 四形态命中 / 三形态仍 miss / 多候选消歧 / checkFactRef 委托）===");
  // REPRO-20PCT fixture：cwd 与 rel 都含空格（evidence schema 禁空白 ⇒ 模型写不出 rel 原文）。
  const R_CWD = WS + "/workspace";
  const R_REL = "Claude dev paper system/PiMoa/config/models.json";
  const R_ABS = `${R_CWD}/${R_REL}`;
  const rLines = Array.from({ length: 48 }, (_, i) => (i === 1 ? '  "providers": {' : `  "k${i + 40}": ${i + 40},`));
  const rMaterials: MaterialMap = new Map([[R_ABS, [seg(R_ABS, R_REL, "range", 40, rLines)]]]);
  const hitForms = [
    WS + "/workspace/Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "./Claude%20dev%20paper%20system/PiMoa/config/models.json",
    "PiMoa/config/models.json",
    "config/models.json",
    "models.json",
  ];
  for (const form of hitForms) {
    const segs = resolveMaterial(form, rMaterials, R_CWD, []);
    assert(segs?.[0]?.abs === R_ABS, `REPRO 形态 ${JSON.stringify(form)} → 命中 models.json（实际 ${segs?.[0]?.abs ?? "null"}）`);
  }
  // 修前三种短形态被拒（REPRO 第 9/10/11 行）——这里对新旧两态做差分反证：旧算法（无尾部层）对它们必 miss。
  const detailedTail = resolveMaterialDetailed("config/models.json", rMaterials, R_CWD, []);
  assert(detailedTail.kind === "hit" && detailedTail.via === "tail", `尾部相对形态走第三层 via=tail（实际 ${JSON.stringify(detailedTail.kind === "hit" ? detailedTail.via : detailedTail.kind)}）`);
  const detailedExact = resolveMaterialDetailed(hitForms[1]!, rMaterials, R_CWD, []);
  assert(detailedExact.kind === "hit" && detailedExact.via === "exact", "%20 相对形态仍由精确层（解码变体）命中 via=exact，不落到尾部层");
  // 本次不修、仍 miss 的三形态：截断头（「system/…」前是空格，不是 / 边界）、%2520 双编码、+ 号。
  for (const form of [
    "system/PiMoa/config/models.json",
    "Claude%2520dev%2520paper%2520system/PiMoa/config/models.json",
    "Claude+dev+paper+system/PiMoa/config/models.json",
  ]) {
    assert(resolveMaterialDetailed(form, rMaterials, R_CWD, []).kind === "miss", `不修形态 ${JSON.stringify(form)} → 仍 miss（边界 4）`);
  }
  // 绝对路径不走尾部兜底：一个错的绝对路径哪怕尾部吻合也不命中。
  assert(resolveMaterial("/elsewhere/config/models.json", rMaterials, R_CWD, []) === null, "绝对路径不参与尾部兜底（/elsewhere/config/models.json → null）");

  // 多候选消歧：两份 x/main.go。
  const A1 = "/repo/a/x/main.go";
  const B1 = "/repo/b/x/main.go";
  const twoMain: MaterialMap = new Map([
    [A1, [seg(A1, "a/x/main.go", "range", 1, ["func AlphaEntry() {}", "", "", "", ""])]],
    [B1, [seg(B1, "b/x/main.go", "range", 1, ["func BetaEntry() {}", "", "", "", ""])]],
  ]);
  const amb = resolveMaterialDetailed("x/main.go", twoMain, CWD, []);
  assert(amb.kind === "ambiguous" && amb.candidates.length === 2, `两份 x/main.go、无 preferred → ambiguous（实际 ${amb.kind}）`);
  assert(resolveMaterial("x/main.go", twoMain, CWD, []) === null, "ambiguous 时 resolveMaterial 返回 null（不静默取第一个）");
  assert(resolveMaterial("x/main.go", twoMain, CWD, [], B1)?.[0]?.abs === B1, "preferred=abs 消歧 → 命中 b 份（不是第一个 a 份）");
  assert(resolveMaterial("main.go", twoMain, CWD, [], ["nope", "a/x/main.go"])?.[0]?.abs === A1, "preferred 数组、按 rel 全等消歧 → 命中 a 份");
  assert(resolveMaterial("x/main.go", twoMain, CWD, [], [A1, B1]) === null, "preferred 同时点中两份 → 仍消不了歧 → null");
  // 精确层不受多候选影响：写全 rel 就直接命中。
  assert(resolveMaterial("b/x/main.go", twoMain, CWD, [])?.[0]?.abs === B1, "写全 rel → 精确层命中，不进尾部层");

  // checkFactRef 委托：尾部命中 fileDisplay=rel；多候选消不了歧标「待核」且 file=首个候选 rel；精确命中 fileDisplay=原写法。
  const tailFact = checkFactRef('config/models.json:41 定义 "providers" 键', R_REL, rMaterials, R_CWD, []);
  assert(tailFact.status === "相符" && tailFact.file === R_REL, `事实写尾部相对 → 相符且 file 显示 rel：${JSON.stringify(tailFact)}`);
  const ambFact = checkFactRef("x/main.go:1 定义 BetaEntry", "somewhere/else.go", twoMain, CWD, []);
  assert(ambFact.status === "待核" && ambFact.file === "a/x/main.go", `多候选且 finding.path 消不了歧 → 待核、file=首个候选 rel：${JSON.stringify(ambFact)}`);
  const prefFact = checkFactRef("x/main.go:1 定义 BetaEntry", "b/x/main.go", twoMain, CWD, []);
  assert(prefFact.status === "相符" && prefFact.file === "b/x/main.go", `finding.path 消歧 → 取 b 份相符：${JSON.stringify(prefFact)}`);
  const exactFact = checkFactRef("./b/x/main.go:1 定义 BetaEntry", "b/x/main.go", twoMain, CWD, []);
  assert(exactFact.status === "相符" && exactFact.file === "./b/x/main.go", `精确命中 → file 显示原写法（语义不回归）：${JSON.stringify(exactFact)}`);
  const noFileFact = checkFactRef("./nope.go:5: something", "b/x/main.go", twoMain, CWD, []);
  assert(noFileFact.status === "文件未附" && noFileFact.file === "./nope.go", `解析不到 → 文件未附、file 显示原写法：${JSON.stringify(noFileFact)}`);

  // 原路径优先（边界 1）：字面 %20 文件与解码文件并存时，尾部层也不改变先命中者。
  const bothMaterials: MaterialMap = new Map([
    ["/repo/a%20b.ts", [seg("/repo/a%20b.ts", "a%20b.ts", "file", 1, ["literal-key"])]],
    ["/repo/a b.ts", [seg("/repo/a b.ts", "a b.ts", "file", 1, ["decoded-key"])]],
  ]);
  assert(resolveMaterial("a%20b.ts", bothMaterials, CWD, [])?.[0]?.abs === "/repo/a%20b.ts", "原路径（字面 %20）仍先于解码变体命中");
  // percentDecodedVariant 已 export 且口径不变。
  assert(percentDecodedVariant("a%20b") === "a b" && percentDecodedVariant("ab") === null && percentDecodedVariant("%E0%A4%A") === null, "percentDecodedVariant export：解码/无 % 返回 null/非法转义返回 null");
}

// ---------- 用例 14：★PIMOA-DEF-09 F1 fix（2026-09-27）——唯一尾部候选也受 preferredPath 约束；checkFactRef 传 uniqueIgnoresPrefs 保持改前直取 ----------
{
  log("=== 用例 14：DEF-09 F1 唯一候选 prefs 约束 / uniqueIgnoresPrefs / 多候选回归 / checkFactRef 跨文件事实不回归 ===");
  const AG = "/repo/a.go";
  const BM = "/repo/b/x/main.go";
  const f1: MaterialMap = new Map([
    [AG, [seg(AG, "a.go", "range", 1, ["package a", ""])]],
    [BM, [seg(BM, "b/x/main.go", "range", 1, ["func BetaEntry() {}", ""])]],
  ]);
  // 14.1 F1 反例：唯一尾部候选不匹配 prefs → miss（改前 fail-open 命中 b/x/main.go）。
  const r1 = resolveMaterialDetailed("main.go", f1, CWD, [], ["a.go"]);
  assert(r1.kind === "miss", `14.1 唯一候选不匹配 prefs → miss（实际 ${JSON.stringify(r1.kind === "hit" ? r1.segs[0]!.abs : r1.kind)}）`);
  assert(resolveMaterial("main.go", f1, CWD, [], ["a.go"]) === null, "14.1 resolveMaterial 包装同口径 → null");
  // 14.2 无 prefs → 唯一候选直 hit（现行为不变）。
  const r2 = resolveMaterialDetailed("main.go", f1, CWD, []);
  assert(r2.kind === "hit" && r2.via === "tail" && r2.segs[0]!.abs === BM, `14.2 无 prefs → hit via=tail abs=b/x/main.go：${JSON.stringify(r2.kind)}`);
  // 14.3 prefs（abs 形态）匹配唯一候选 → hit；rel 形态同理。
  const r3 = resolveMaterialDetailed("main.go", f1, CWD, [], [BM]);
  assert(r3.kind === "hit" && r3.via === "tail" && r3.segs[0]!.abs === BM, `14.3 prefs=abs 匹配唯一候选 → hit via=tail：${JSON.stringify(r3.kind)}`);
  const r3b = resolveMaterialDetailed("main.go", f1, CWD, [], "b/x/main.go");
  assert(r3b.kind === "hit" && r3b.via === "tail" && r3b.segs[0]!.abs === BM, "14.3b prefs=rel 字符串匹配唯一候选 → hit via=tail");
  // 14.4 uniqueIgnoresPrefs=true：唯一候选不核 prefs 直 hit（checkFactRef 语义锁定）。
  const r4 = resolveMaterialDetailed("main.go", f1, CWD, [], ["a.go"], true);
  assert(r4.kind === "hit" && r4.via === "tail" && r4.segs[0]!.abs === BM, `14.4 uniqueIgnoresPrefs=true → hit via=tail：${JSON.stringify(r4.kind)}`);
  // 14.5 多候选（两份 x/main.go）消歧逻辑回归，且与 uniqueIgnoresPrefs 无关。
  const A1 = "/repo/a/x/main.go";
  const B1 = "/repo/b/x/main.go";
  const twoMain: MaterialMap = new Map([
    [A1, [seg(A1, "a/x/main.go", "range", 1, ["func AlphaEntry() {}"])]],
    [B1, [seg(B1, "b/x/main.go", "range", 1, ["func BetaEntry() {}"])]],
  ]);
  for (const flag of [undefined, true]) {
    const h = resolveMaterialDetailed("x/main.go", twoMain, CWD, [], "b/x/main.go", flag);
    assert(h.kind === "hit" && h.via === "tail" && h.segs[0]!.abs === B1, `14.5a 多候选 prefs 消歧 → hit b 份（flag=${flag}）`);
    const a = resolveMaterialDetailed("x/main.go", twoMain, CWD, [], ["nope.go"], flag);
    assert(a.kind === "ambiguous" && a.candidates.length === 2, `14.5b 多候选 prefs 消不了歧 → ambiguous（flag=${flag}，实际 ${a.kind}）`);
    const n = resolveMaterialDetailed("x/main.go", twoMain, CWD, [], undefined, flag);
    assert(n.kind === "ambiguous" && n.candidates.length === 2, `14.5c 多候选无 prefs → ambiguous（flag=${flag}，实际 ${n.kind}）`);
  }
  // 14.6 %20 全 rel 仍走精确层：prefs 不匹配也不被 F1 收紧误伤。
  const SP = "/repo/dir x/main.go";
  const spM: MaterialMap = new Map([
    [AG, [seg(AG, "a.go", "range", 1, ["package a"])]],
    [SP, [seg(SP, "dir x/main.go", "range", 1, ["func Gamma() {}"])]],
  ]);
  const r6 = resolveMaterialDetailed("dir%20x/main.go", spM, CWD, [], ["a.go"]);
  assert(r6.kind === "hit" && r6.via === "exact" && r6.segs[0]!.abs === SP, `14.6 %20 全 rel → 精确层 hit，不受 prefs 收紧：${JSON.stringify(r6.kind)}`);
  // 14.7 checkFactRef 跨文件事实引用：finding 在 a.go、事实引用唯一附入的 helper.go → 相符（DEF-09 前唯一候选直取，pre/post 一致）。
  const HG = "/repo/b/helper.go";
  const xf: MaterialMap = new Map([
    [AG, [seg(AG, "a.go", "range", 1, ["package a", "func A() { CalcValue() }"])]],
    [HG, [seg(HG, "b/helper.go", "range", 1, ["package b", 'const CalcValue = "CalcValue"'])]],
  ]);
  const xFact = checkFactRef('helper.go:2 常量 "CalcValue"', "a.go", xf, CWD, []);
  assert(xFact.status === "相符" && xFact.file === "b/helper.go", `14.7 跨文件事实 → 相符、file=b/helper.go（不退成「文件未附」）：${JSON.stringify(xFact)}`);
}

console.log(`\n[submit-findings-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
