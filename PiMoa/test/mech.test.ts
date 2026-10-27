/**
 * mech.ts（B3 机械佐证层）+ submit_findings chain（B1 载体与执法）单测 —— jevcheck「finding 真伪判定」波2 验收。
 *
 * 运行：npx tsx test/mech.test.ts
 *
 * 覆盖：
 *   · 差分探针 P1–P8 逐条移植（蓝本 <workspace>/artifacts/jev-finding-truth-20260922/tools/diff-probe.mjs；
 *     其中 P5–P7 断言的是 verdictOf 顺序、属 B4 波3 范围，本波不移植——本文件移植 mechCheck 相关的
 *     P1/P2/P3/P4/P8，语义真源 = <workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs 的 mechCheck v2（笔误修正：原写「同目录 judge-finding.mjs」，真源实为 artifacts 侧绝对路径））；
 *   · chain schema 正/反例（FindingSchema/AmendFactsParams 的 chain 形状 + validateChainSteps 行为）；
 *   · B1 执法①（claim 含因果连词而 chain 无对应 link 步 ⇒ REJECT，同推论词执法先例）；
 *   · B1 执法②（absence 步主语无 identifier token ⇒ 登记警示不 REJECT，与 anchor 执法同风格）；
 *   · kind=finding 必填 / kind=counter 可空；amend_facts 补 chain（增补步）；
 *   · 灰度缝：不带 chain 且未开 enforceChain ⇒ 与现行为逐字节等价（validateFinding 零错误、REJECT/接受文案不变）。
 * 脱网、脱 key、不读盘。
 */
import type { MaterialFile, MaterialMap } from "../src/moa/types.js";
import { absenceSubject, mechCorroborate, mechTokens } from "../src/moa/mech.js";
import {
  AmendFactsParams,
  CAUSAL_WORDS,
  CHAIN_LIMITS,
  FindingSchema,
  chainLinkNotes,
  chainSubjectNotes,
  createAmendFactsTool,
  createAmendState,
  createFindingsState,
  createSubmitFindingsTool,
  validateChainSteps,
  validateFinding,
  type AmendState,
  type ChainStep,
  type Finding,
} from "../src/tools/submit_findings.js";

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
  console.log("[mech-test]", ...a);
}

// ---------- 材料 fixture（不读盘；形状沿 test/submit_findings.test.ts）----------
const CWD = "/repo";
const ABS_GO = "/repo/internal/x/ratchet.go";
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
function seg(abs: string, rel: string, start: number, lines: string[]): MaterialFile {
  return { abs, rel, kind: "range", lines, start, end: start + lines.length - 1 };
}
const materials: MaterialMap = new Map([[ABS_GO, [seg(ABS_GO, "internal/x/ratchet.go", 880, GO_LINES_880)]]]);
const readRoots: string[] = [];

/** 基线 finding（与 test/submit_findings.test.ts 同形，无 chain——灰度关=现行为）。 */
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

async function run(tool: unknown, params: unknown): Promise<{ text: string; isError: boolean }> {
  const r = (await (tool as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("call-1", params)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

// ============================================================================
// 一、差分探针 P1–P8 移植（mechCheck 相关：P1/P2/P3/P4/P8；P5–P7 属 B4 波3）
// ============================================================================
{
  log("=== P1：无谓词绑定的行号 + 无关引号 —— 必须拒核（防 R1-1 假机械证伪）===");
  const p1 = { text: "第 20 行的调用把参数传给 src/a/b.ts（见「/src/a/b.ts」）" };
  const m1 = "19: _ = x\n20: out, err := resize(src, height, width)\n21: }";
  const n1 = mechCorroborate(p1, m1);
  assert(n1.checkable === false && n1.refuted === false, `P1 无关引号拒核（checkable=false）：${JSON.stringify(n1)}`);
  assert(n1.note.includes("不可机械核"), `P1 note 指明非闭集形态：${n1.note}`);
  assert(n1.reason === "unform", `P1 拒核 reason=unform（形态闭集外，B4 走 DOWNGRADE 无佐证路径）：${JSON.stringify(n1)}`);
}

{
  log("=== P2/P3：identifier 存在性步 —— token 在作用域内佐证证伪 / 未命中不佐证 ===");
  const p2 = { text: "buildCreateMemoryItemSurQL 中不存在按 emb.embedding 是否为空而跳过 embedding 字段的分支" };
  const m2 = '687: \tfields = append(fields, "embedding: "+emb.embedding, "embedding_model: "+emb.model)';
  const n2 = mechCorroborate(p2, m2);
  assert(n2.checkable === true && n2.refuted === true, `P2 token 命中→佐证证伪：${JSON.stringify(n2)}`);
  assert(n2.note.includes("emb.embedding") && n2.note.includes("token=identifier 最长片段"), `P2 note 带 token 来源：${n2.note}`);
  assert(n2.reason === undefined, `P2 可核结果省略 reason（缺数据省略纪律）：${JSON.stringify(n2)}`);
  const n3 = mechCorroborate(p2, "1: func unrelated() {}");
  assert(n3.checkable === true && n3.refuted === false, `P3 token 未命中→不佐证证伪：${JSON.stringify(n3)}`);
}

{
  log("=== P4：行号多段歧义 —— 拒核并注明（防 R1-2 取错段）===");
  const p4 = { text: "第 30 行是「total := a + b」的赋值语句" };
  const m4 = "30: total := a\n30: total := a + b";
  const n4 = mechCorroborate(p4, m4);
  assert(n4.checkable === false && n4.note.includes("歧义"), `P4 行号歧义拒核：${JSON.stringify(n4)}`);
  assert(n4.reason === "locate-miss", `P4 行号歧义拒核 reason=locate-miss（B4 归 INSUFFICIENT 档）：${JSON.stringify(n4)}`);
  // 同形态行缺失分支（蓝本同函数）：第 30 行不在 material ⇒ 拒核并注明「行缺失」。
  const n4b = mechCorroborate(p4, "31: total := a + b");
  assert(n4b.checkable === false && n4b.note.includes("行缺失"), `P4b 行缺失拒核：${JSON.stringify(n4b)}`);
  assert(n4b.reason === "locate-miss", `P4b 行缺失拒核 reason=locate-miss（步定位失败）：${JSON.stringify(n4b)}`);
}

{
  log("=== P8：行文引号含 ASCII 双引号 —— 可核；不符证伪 / 相符不证伪各半 ===");
  const p8 = {
    text: '第 657 行是「pending := memoryEmbeddingValues{status: strconv.Quote("pending"), embedding: "init"}」的构造语句',
  };
  const m8bad = '657: \tpending := memoryEmbeddingValues{status: strconv.Quote("pending")}';
  const m8good = '657: \tpending := memoryEmbeddingValues{status: strconv.Quote("pending"), embedding: "init"}';
  const n8a = mechCorroborate(p8, m8bad);
  const n8b = mechCorroborate(p8, m8good);
  assert(n8a.checkable === true && n8a.refuted === true, `P8a 双引号引文可核、不符→证伪佐证：${JSON.stringify(n8a)}`);
  assert(n8b.checkable === true && n8b.refuted === false, `P8b 双引号引文相符→不证伪：${JSON.stringify(n8b)}`);
}

{
  log("=== 封闭形态原则（§4.8）：CJK 纯文字断言拒核维持（H3 token 化明确不做）===");
  const n = mechCorroborate({ text: "文档中没有说明超时上限的保护" }, "1: // 任意材料");
  assert(n.checkable === false && n.note.includes("identifier token"), `CJK 纯文字存在性断言拒核：${JSON.stringify(n)}`);
  assert(n.reason === "unform", `CJK 拒核 reason=unform（无 identifier token，token 卫生）：${JSON.stringify(n)}`);
  const n2 = mechCorroborate({ text: "这段文字既无行号也无存在性谓词" }, "1: // 任意材料");
  assert(n2.checkable === false && n2.note.includes("不可机械核"), `非闭集形态一律拒核、不加识别分支：${JSON.stringify(n2)}`);
  assert(n2.reason === "unform", `非闭集拒核 reason=unform：${JSON.stringify(n2)}`);
}

// ============================================================================
// 二、chain schema 正/反例（B1 Type 定义照抄：2–6 步、kind=link|absence|runtime、text 8–480、from/to 可选）
// ============================================================================
{
  log("=== chain schema 形状（FindingSchema 照抄 §B1）与 validateChainSteps 正反例 ===");
  const chainJson = JSON.stringify((FindingSchema as unknown as { properties: { chain: unknown } }).properties.chain);
  assert(chainJson.includes('"minItems":2') && chainJson.includes('"maxItems":6'), `schema 步数边界 2–6：${chainJson.slice(0, 120)}…`);
  assert(chainJson.includes('"minLength":8') && chainJson.includes('"maxLength":480'), "schema text 8–480");
  assert(chainJson.includes('"link"') && chainJson.includes('"absence"') && chainJson.includes('"runtime"'), "schema kind 闭集 = link|absence|runtime");
  assert(chainJson.includes('"from"') && chainJson.includes('"to"'), "schema from/to 可选字段在");
  const amendJson = JSON.stringify((AmendFactsParams as unknown as { properties: { chain: unknown } }).properties.chain);
  assert(amendJson.includes('"minItems":1') && amendJson.includes('"maxItems":6'), "amend chain = 增补步 1–6（全链 2–6 由 submit 侧把关）");

  const step = (kind: ChainStep["kind"], text: string, id = "c1"): ChainStep => ({ id, kind, text });
  const ok2: ChainStep[] = [
    step("absence", "Check() 中不存在对 origin.Kind 为空的校验分支", "c1"),
    step("runtime", "运行时条件：origin.Command 取自无关进程的命令行", "c2"),
  ];
  assert(validateChainSteps("F1", ok2).length === 0, "正例：2 步合法 chain 零错误");
  assert(validateChainSteps("F1", ok2.slice(0, 1), 1).length === 0, "正例：amend 增补 1 步合法（minSteps=1）");
  const tooFew = validateChainSteps("F1", ok2.slice(0, 1));
  assert(tooFew.length === 1 && tooFew[0]!.includes("chain 须 2–6 步"), `反例：1 步被拒：${tooFew[0] ?? ""}`);
  const tooMany = validateChainSteps("F1", Array.from({ length: 7 }, (_, i) => step("runtime", "运行时条件：第若干条环境前提描述", `c${i + 1}`)));
  assert(tooMany.length === 1 && tooMany[0]!.includes("chain 须 2–6 步"), `反例：7 步被拒：${tooMany[0] ?? ""}`);
  const shortText = validateChainSteps("F1", [step("link", "短句不足", "c1"), ok2[1]!]);
  assert(shortText.some((e) => e.includes("text 须 8–480 字")), `反例：text 7 字被拒：${shortText.join("；")}`);
  const longText = validateChainSteps("F1", [step("link", "长".repeat(481), "c1"), ok2[1]!]);
  assert(longText.some((e) => e.includes("text 须 8–480 字")), "反例：text 481 字被拒");
  const badKind = validateChainSteps("F1", [step("value" as unknown as ChainStep["kind"], "运行时条件：一个足够长的合法文本", "c1"), ok2[1]!]);
  assert(badKind.some((e) => e.includes("kind 须为 link / absence / runtime")), `反例：kind 闭集外被拒：${badKind.join("；")}`);
  const badId = validateChainSteps("F1", [{ id: "", kind: "runtime", text: "运行时条件：一个足够长的合法文本" }, ok2[1]!]);
  assert(badId.some((e) => e.includes("缺 id")), `反例：空 id 被拒：${badId.join("；")}`);
  assert(CHAIN_LIMITS.minSteps === 2 && CHAIN_LIMITS.maxSteps === 6 && CHAIN_LIMITS.textMin === 8 && CHAIN_LIMITS.textMax === 480, "CHAIN_LIMITS 与 §B1 边界逐字一致");
}

// ============================================================================
// 三、B1 执法①（REJECT）/ ⓪（必填）/ 灰度缝（现行为逐字节等价）
// ============================================================================
{
  log("=== validateFinding：灰度关（无 chain、不传 opts）= 现行为逐字节等价 ===");
  assert(validateFinding(okFinding(), materials, CWD, readRoots).length === 0, "off：基线 finding 零错误（对照 test/submit_findings.test.ts:236 同判据）");
  const causalOff = okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统" });
  assert(validateFinding(causalOff, materials, CWD, readRoots).length === 0, "off：因果 claim 无 chain 也不拒（chain.enabled=false 等价，§7.3）");
  assert(validateFinding(okFinding({ kind: "counter", level: "COUNTER", claim: "该处不存在此问题，Kind 为空是合法输入" }), materials, CWD, readRoots).length === 0, "off：counter 照旧合格");
}

{
  log("=== validateFinding：chain 形态（enforceChain）—— ⓪必填 / ①因果连词 REJECT / counter 可空 ===");
  const ON = { enforceChain: true };
  const e0 = validateFinding(okFinding(), materials, CWD, readRoots, ON);
  assert(e0.some((e) => e.includes("kind=finding 必须给 chain（2–6 步")), `⓪ finding 缺 chain ⇒ REJECT：${e0.join("；")}`);

  const cleanChain: ChainStep[] = [
    { id: "c1", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" },
    { id: "c2", kind: "runtime", text: "运行时条件：origin.Command 取自无关进程的命令行" },
  ];
  const linkChain: ChainStep[] = [
    cleanChain[0]!,
    { id: "c2", kind: "link", text: "Kind 为空的 origin 因此绕过来源校验，会被当作合法进入", from: "c1", to: "c3" },
    // FB-11①② 触发的 fixture 同步（断言一字未改）：link 步 to:"c3" 指向本步，故 id 取 c3——
    // 原样复用 cleanChain[1]（id=c2）会撞 id 重复、并让 to:"c3" 悬空，恰是 FB-11 要 REJECT 的形状。
    { ...cleanChain[1]!, id: "c3" },
  ];
  assert(validateFinding(okFinding({ chain: cleanChain }), materials, CWD, readRoots, ON).length === 0, "正例：合法 2 步 chain + 干净 claim ⇒ 零错误");

  const causalNoLink = okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统", chain: cleanChain });
  const e1 = validateFinding(causalNoLink, materials, CWD, readRoots, ON);
  assert(
    e1.some((x) => x.includes("claim 含因果连词「因此」而 chain 没有对应 link 步")),
    `① 因果 claim 无 link 步 ⇒ REJECT（同推论词先例文案）：${e1.join("；")}`,
  );
  const causalWithLink = okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统", chain: linkChain });
  assert(validateFinding(causalWithLink, materials, CWD, readRoots, ON).length === 0, "① 正例：因果 claim 有对应 link 步 ⇒ 合格");

  const counterNoChain = okFinding({ kind: "counter", level: "COUNTER", claim: "该处不存在此问题，Kind 为空是合法输入" });
  assert(validateFinding(counterNoChain, materials, CWD, readRoots, ON).length === 0, "⓪ 反向：kind=counter 可空（不带 chain 合格）");

  // chain 形态按「带 chain 即生效」自选（灰度缝第二条腿）：带 chain 的提交即使不传 opts 也照新契约核。
  const oneStep = okFinding({ chain: [cleanChain[0]!] });
  const e2 = validateFinding(oneStep, materials, CWD, readRoots);
  assert(e2.some((e) => e.includes("chain 须 2–6 步")), `带 chain 即核形状（1 步被拒）：${e2.join("；")}`);
}

{
  log("=== CAUSAL_WORDS 因果连词表（沿推论词表扩展；INFERENCE_WORDS 本体不动）===");
  assert(
    CAUSAL_WORDS.test("因此") && CAUSAL_WORDS.test("所以") && CAUSAL_WORDS.test("从而") && CAUSAL_WORDS.test("会导致") && CAUSAL_WORDS.test("⇒") && CAUSAL_WORDS.test("因为") && CAUSAL_WORDS.test("导致"),
    "① 词表命中：因此/所以/从而/会导致/⇒/因为/导致（任务书点名 + 扩展）",
  );
  assert(
    !CAUSAL_WORDS.test("Kind 为空时直接放行，缺少来源校验的 origin 会被当作合法") &&
      !CAUSAL_WORDS.test("这是权限校验故障，第 5 行抛错") &&
      !CAUSAL_WORDS.test("按钮的可见性由第 8 行控制"),
    "① 词表不误伤基线 claim 与「故障」「可见性」（沿推论词表先例）",
  );
}

// ============================================================================
// 四、B1 执法②：absence 步主语 identifier token —— 登记警示不 REJECT（与 anchor 执法同风格）
// ============================================================================
{
  log("=== chainSubjectNotes：absence 步主语 token 卫生（≥3 字、剥路径）===");
  const noToken: ChainStep[] = [
    { id: "c1", kind: "absence", text: "文档中没有说明超时上限的保护" },
    { id: "c2", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
  ];
  const notes = chainSubjectNotes("F1", noToken);
  assert(notes.length === 1 && notes[0]!.includes("c1") && notes[0]!.includes("identifier token"), `② 无 token 的 absence 步登记：${notes.join("；")}`);
  assert(validateFinding(okFinding({ chain: noToken }), materials, CWD, readRoots).length === 0, "② 只登记不 REJECT（与 anchor 执法同风格）");

  const withToken: ChainStep[] = [
    { id: "c1", kind: "absence", text: "buildCreateMemoryItemSurQL 中不存在按 emb.embedding 是否为空而跳过 embedding 字段的分支" },
    { id: "c2", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
  ];
  assert(chainSubjectNotes("F1", withToken).length === 0, "② 带 token 的 absence 步不登记（P2 同形步）");

  const lineQuoteAbsence: ChainStep[] = [
    { id: "c1", kind: "absence", text: '第 657 行是「pending := memoryEmbeddingValues{status: strconv.Quote("pending"), embedding: "init"}」的构造语句' },
    withToken[1]!,
  ];
  assert(chainSubjectNotes("F1", lineQuoteAbsence).length === 0, "② 行文形 absence 步按整句抽 token，不误登记（P8 同形步）");

  const linkNoToken: ChainStep[] = [
    { id: "c1", kind: "link", text: "文档中没有说明超时上限的保护，因此该处不存在此问题的成因", from: "c0", to: "c2" },
    withToken[1]!,
  ];
  assert(chainSubjectNotes("F1", linkNoToken).length === 0, "② 只查 absence 步（link 步不查主语 token）");
  assert(chainSubjectNotes("F1", undefined).length === 0, "② 无 chain 零登记（灰度关逐字节等价）");
  // token 卫生：≥3 字、停用词表（与 mech.ts 形态② / 差分蓝本逐字同一套；剥路径在执法②调用侧做）。
  assert(JSON.stringify(mechTokens("the and for resolveIdentifier emb.model")) === JSON.stringify(["resolveIdentifier", "emb.model"]), `mechTokens 停用词/≥3 字（蓝本逐字）：${JSON.stringify(mechTokens("the and for resolveIdentifier emb.model"))}`);
  assert(JSON.stringify(mechTokens("ab abc")) === JSON.stringify(["abc"]), `mechTokens ≥3 字下限：${JSON.stringify(mechTokens("ab abc"))}`);
  // 剥路径（灰度第 6 轮：文件名 stem 不当标识符）：主语里只有 check.sh ⇒ 执法②登记（不剥则会误放行）。
  const pathOnly = chainSubjectNotes("F1", [{ id: "c1", kind: "absence", text: "x 中不存在 check.sh 对输出的判断" }, { id: "c2", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" }]);
  assert(pathOnly.length === 1 && pathOnly[0]!.includes("c1"), `② 剥路径后无 token ⇒ 登记：${pathOnly.join("；")}`);
  assert(absenceSubject("buildCreateMemoryItemSurQL 中不存在按 emb.embedding 是否为空而跳过 embedding 字段的分支").includes("emb.embedding"), "absenceSubject 抽存在性形态主语区");
  assert(absenceSubject("第 657 行是「x := 1」的构造语句") === "第 657 行是「x := 1」的构造语句", "absenceSubject 非存在性形态回退整句");
}

// ============================================================================
// 五、handler 集成：submit_findings 执法①②落地 + 灰度关文案不变；amend_facts 补 chain
// ============================================================================
{
  log("=== createSubmitFindingsTool：enforceChain 开/关两态 + 执法②登记进回执 ===");
  const on = createSubmitFindingsTool(createFindingsState(), materials, CWD, readRoots, { maxAttempts: 3, enforceChain: true });
  const r1 = await run(on, { findings: [okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统" })] });
  assert(r1.isError && r1.text.includes("kind=finding 必须给 chain"), `handler ⓪+① REJECT（enforceChain 开）：${r1.text}`);

  const noTokenChain: ChainStep[] = [
    { id: "c1", kind: "absence", text: "文档中没有说明超时上限的保护" },
    { id: "c2", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
  ];
  const r2 = await run(on, { findings: [okFinding({ chain: noTokenChain })] });
  assert(!r2.isError && r2.text.startsWith("已接受 1 条") && r2.text.includes("主语没有 identifier token"), `handler ② 接受 + 登记警示：${r2.text}`);

  const off = createSubmitFindingsTool(createFindingsState(), materials, CWD, readRoots, { maxAttempts: 3 });
  const r3 = await run(off, { findings: [okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统" })] });
  assert(!r3.isError && r3.text === "已接受 1 条：F1 MAJOR internal/x/ratchet.go:881-882", `灰度关逐字节等价（文案与现行为一致）：${r3.text}`);
}

{
  log("=== createAmendFactsTool：chain 增补步（1–6）+ 形状 REJECT + 执法②登记 ===");
  const s1: AmendState = createAmendState();
  const t1 = createAmendFactsTool(s1, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const amendChain: ChainStep[] = [{ id: "c9", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" }];
  const r1 = await run(t1, { id: "F3", facts: ["通用事实：空值必须显式拒绝"], chain: amendChain });
  assert(!r1.isError && r1.text === "已为 F3 补充 1 条前提", `amend 补 1 步 chain 合法（文案不变）：${r1.text}`);
  assert((s1.acceptedChain ?? []).length === 1 && s1.acceptedChain![0]!.id === "c9", `AmendState.acceptedChain 落账：${JSON.stringify(s1.acceptedChain)}`);

  const s2 = createAmendState();
  const t2 = createAmendFactsTool(s2, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const r2 = await run(t2, { id: "F3", facts: [], chain: [{ id: "c9", kind: "link", text: "短句不足" }] });
  assert(r2.isError && r2.text.includes("text 须 8–480 字"), `amend chain 形状不合格 ⇒ REJECT：${r2.text}`);

  const s3 = createAmendState();
  const t3 = createAmendFactsTool(s3, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const r3 = await run(t3, {
    id: "F3",
    facts: ["通用事实：空值必须显式拒绝"],
    chain: [
      { id: "c9", kind: "absence", text: "文档中没有说明超时上限的保护" },
      { id: "c10", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
    ],
  });
  assert(!r3.isError && r3.text.startsWith("已为 F3 补充 1 条前提") && r3.text.includes("主语没有 identifier token"), `amend 执法②登记：${r3.text}`);

  // 灰度关：不带 chain 的 amend 文案与现行为逐字节一致。
  const s4 = createAmendState();
  const t4 = createAmendFactsTool(s4, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots);
  const r4 = await run(t4, { id: "F3", facts: ["通用事实：空值必须显式拒绝", "通用事实：错误必须传播"] });
  assert(!r4.isError && r4.text === "已为 F3 补充 2 条前提" && s4.acceptedChain === undefined, `amend 灰度关逐字节等价：${r4.text}`);
}

// ============================================================================
// 六、FB-10 / FB-11 反例：执法①防空壳 link + chain 关系完整性（id 唯一 / from/to 引用 / amend 累计 ≤6）
// ============================================================================
{
  log("=== FB-10：空壳 link（text 无因果词）不算对应 link 步 ⇒ REJECT；带因果词才算 ⇒ 合格 ===");
  const c1: ChainStep = { id: "c1", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" };
  const c3: ChainStep = { id: "c3", kind: "runtime", text: "运行时条件：origin.Command 取自无关进程的命令行" };
  const causalClaim = "Kind 为空因此放行，会导致未授权 origin 进入系统";
  const hollow: ChainStep[] = [c1, { id: "c2", kind: "link", text: "Kind 为空的 origin 绕过来源校验进入系统", from: "c1", to: "c3" }, c3];
  const e = validateFinding(okFinding({ claim: causalClaim, chain: hollow }), materials, CWD, readRoots, { enforceChain: true });
  assert(e.some((x) => x.includes("claim 含因果连词「因此」而 chain 没有对应 link 步")), `FB-10 空壳 link ⇒ REJECT：${e.join("；")}`);
  const solid: ChainStep[] = [c1, { id: "c2", kind: "link", text: "Kind 为空的 origin 因此绕过来源校验进入系统", from: "c1", to: "c3" }, c3];
  assert(
    validateFinding(okFinding({ claim: causalClaim, chain: solid }), materials, CWD, readRoots, { enforceChain: true }).length === 0,
    "FB-10 正例：link 步 text 含因果连词 ⇒ 合格（防空壳收紧不误伤）",
  );
}

{
  log("=== FB-10：link 步 from/to 均缺失 ⇒ 登记警示进 refNotes（不 REJECT）===");
  const noEnds: ChainStep[] = [
    { id: "c1", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" },
    { id: "c2", kind: "link", text: "Kind 为空的 origin 因此绕过来源校验进入系统" },
    { id: "c3", kind: "runtime", text: "运行时条件：origin.Command 取自无关进程的命令行" },
  ];
  const notes = chainLinkNotes("F1", noEnds);
  assert(notes.length === 1 && notes[0]!.includes("c2") && notes[0]!.includes("from/to 均缺失"), `FB-10 均缺失登记：${notes.join("；")}`);
  assert(
    validateFinding(okFinding({ claim: "Kind 为空因此放行，会导致未授权 origin 进入系统", chain: noEnds }), materials, CWD, readRoots, { enforceChain: true }).length === 0,
    "FB-10 只登记不 REJECT（与执法②同风格）",
  );
  const halfEnds: ChainStep[] = [noEnds[0]!, { ...noEnds[1]!, from: "c1" }, noEnds[2]!];
  assert(chainLinkNotes("F1", halfEnds).length === 0, "FB-10 只查 from/to 均缺失（单端缺失不登记）");
  assert(chainLinkNotes("F1", undefined).length === 0, "FB-10 无 chain 零登记（灰度关逐字节等价）");
}

{
  log("=== FB-11①②：步 id 唯一 + from/to 指向存在步 id 且禁自指（违者 REJECT）===");
  const a: ChainStep = { id: "c1", kind: "absence", text: "Check() 中不存在对 origin.Kind 为空的校验分支" };
  const b: ChainStep = { id: "c2", kind: "runtime", text: "运行时条件：origin.Command 取自无关进程的命令行" };
  assert(validateChainSteps("F1", [a, b]).length === 0, "FB-11 正例：id 唯一、无 from/to ⇒ 零错误");
  const dup = validateChainSteps("F1", [a, { ...b, id: "c1" }]);
  assert(dup.length === 1 && dup[0]!.includes("id 重复"), `FB-11① 重复 id ⇒ REJECT：${dup.join("；")}`);
  const dangling = validateChainSteps("F1", [a, { ...b, kind: "link", from: "c9", to: "c1" }]);
  assert(dangling.some((x) => x.includes("from「c9」指向不存在的步 id")), `FB-11② 悬空 from ⇒ REJECT：${dangling.join("；")}`);
  const selfRef = validateChainSteps("F1", [a, { ...b, kind: "link", from: "c1", to: "c2" }]);
  assert(selfRef.some((x) => x.includes("to「c2」不得自指")), `FB-11② 自指 ⇒ REJECT：${selfRef.join("；")}`);
}

{
  log("=== FB-11③：amend 补链后累计全链 ≤6（REJECT 并说明当前累计）；单次增补 1–6 语义保留 ===");
  const baseChain: ChainStep[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i + 1}`, kind: "runtime" as const, text: "运行时条件：第若干条环境前提描述" }));
  const add2: ChainStep[] = [
    { id: "c9", kind: "runtime", text: "运行时条件：命令行可被篡改，攻击者可控输入" },
    { id: "c10", kind: "runtime", text: "运行时条件：环境变量可被攻击者替换" },
  ];
  const s1 = createAmendState();
  const t1 = createAmendFactsTool(s1, materials, { id: "F3", path: "internal/x/ratchet.go", baseChain }, CWD, readRoots);
  const r1 = await run(t1, { id: "F3", facts: [], chain: add2 });
  assert(r1.isError && r1.text.includes("补链后全链累计 7 步") && r1.text.includes("超过全链上限 6 步"), `FB-11③ 5+2 累计超限 ⇒ REJECT（含当前累计）：${r1.text}`);
  const s2 = createAmendState();
  const t2 = createAmendFactsTool(s2, materials, { id: "F3", path: "internal/x/ratchet.go", baseChain }, CWD, readRoots);
  const r2 = await run(t2, { id: "F3", facts: [], cannot_amend_reason: "探针", chain: [add2[0]!] });
  assert(!r2.isError && (s2.acceptedChain ?? []).length === 1, `FB-11③ 正例：5+1=6 累计不超 ⇒ 合法：${r2.text}`);
  const s3 = createAmendState();
  const t3 = createAmendFactsTool(s3, materials, { id: "F3", path: "internal/x/ratchet.go" }, CWD, readRoots); // 不传 baseChain 不核累计
  const r3 = await run(t3, { id: "F3", facts: ["通用事实：空值必须显式拒绝"], chain: add2 });
  assert(!r3.isError, `FB-11③ 缺省不核累计（向后兼容）：${r3.text}`);
}

// ============================================================================
// 七、FB-12/13/14 反例 + FB-15 测试加固（note 期望值取差分蓝本 judge-finding.mjs 文案，独立源）
// ============================================================================
// note 模板逐字取自差分蓝本 <workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs
// 第 55/56/58/74/76/78 行（独立源，不抄实现自身字符串）；唯一 delta = 行文核对引文截断 24→120（FB-14）。
const BP_NOTE_LINE = (ln: number, q: string, b: boolean): string => `行文核对: 第${ln}行含「${q.slice(0, 120)}」=${b}（token=行内引号，绑定抽取）`;
const BP_NOTE_MISSING = (ln: number): string => `行缺失：第 ${ln} 行不在 material（token=行号断言）`;
const BP_NOTE_AMBIG = (ln: number, n: number): string => `行号歧义：第 ${ln} 行在 material 命中 ${n} 段（token=行号断言）`;
const BP_NOTE_EXISTS = (probe: string, hit: boolean, scoped: boolean): string => `存在性核对: 作用域内含「${probe}」=${hit}（token=identifier 最长片段${scoped ? "，域=引用行±20" : ""}）`;
const BP_NOTE_NO_TOKEN = "存在性断言无 identifier token（拒核，token 卫生）";
const BP_NOTE_NOT_MECH = "不可机械核（非行文/存在性形态）";

{
  log("=== FB-12（FB-15⑤）：标识符边界感知 —— 长标识符含短 probe ⇒ 不证伪 ===");
  const p = { text: "loadConfig 中不存在 app 标志的校验" };
  const swallowed = mechCorroborate(p, "885: myapp := load()");
  assert(swallowed.checkable === true && swallowed.refuted === false, `FB-12 反例：myapp 不算命中 app ⇒ 不证伪：${JSON.stringify(swallowed)}`);
  assert(swallowed.note === BP_NOTE_EXISTS("app", false, false), `FB-12 note = 蓝本 :74 文案：${swallowed.note}`);
  const bare = mechCorroborate(p, "885: app := load()");
  assert(bare.checkable === true && bare.refuted === true && bare.note === BP_NOTE_EXISTS("app", true, false), `FB-12 正例：独立标识符仍证伪：${bare.note}`);
}

{
  log("=== FB-13①：行号匹配放宽前导空白（行号仍精确带冒号）===");
  const p = { text: "第 30 行是「total := a + b」的赋值语句" };
  const indented = mechCorroborate(p, "  30: total := a + b");
  assert(indented.checkable === true && indented.refuted === false && indented.note === BP_NOTE_LINE(30, "total := a + b", true), `FB-13① 前导空白行号可核：${JSON.stringify(indented)}`);
  const notExact = mechCorroborate(p, "300: total := a + b");
  assert(notExact.checkable === false && notExact.refuted === false && notExact.note === BP_NOTE_MISSING(30), `FB-13① 行号精确带冒号（300 不算 30）⇒ 行缺失拒核：${notExact.note}`);
}

{
  log("=== FB-13②（FB-15②多行引文）：引文/主语窗字符类排除 \\r\\n ===");
  const multiLineQuote = mechCorroborate({ text: "第 30 行是「total := a +\n b」的赋值语句" }, "30: total := a + b");
  assert(multiLineQuote.checkable === false && multiLineQuote.refuted === false && multiLineQuote.note === BP_NOTE_NOT_MECH, `多行引文不进形态①、拒核：${JSON.stringify(multiLineQuote)}`);
  const crossLineSubject = mechCorroborate({ text: "第 5 行没有说明\nfoo.bar 的校验" }, "5: any");
  assert(crossLineSubject.checkable === false && crossLineSubject.refuted === false, `主语窗跨行不拼接 ⇒ 拒核：${JSON.stringify(crossLineSubject)}`);
}

{
  log("=== FB-14：分流绑定（bareLine 与 lineQuote 共用同一行号）+ note 引文截断 24→120 ===");
  const filler = "把输入交给预处理与校对流程随后进入主处理逻辑并返回结果并且记录日志"; // >30 字且不含「“` 与 是为:：
  const r = mechCorroborate({ text: `第 7 行${filler}，第 12 行是「total := a + b」的赋值` }, "12: total := a + b");
  assert(r.checkable === true && r.refuted === false, `FB-14 首个行号（第 7 行）不再否决较晚绑定（第 12 行）⇒ 进形态①：${JSON.stringify(r)}`);
  assert(r.note === BP_NOTE_LINE(12, "total := a + b", true), `FB-14 归因到引号绑定的行号（第 12 行）：${r.note}`);
}

{
  log("=== FB-15①：±20 作用域裁剪（边界内 / 边界外 / 无行号 ⇒ || material 全文回退）===");
  const p = { text: "ratchet 第 890 行的 Check 中不存在 origin.Kind 校验分支" };
  const mat = (tokLine: number): string =>
    ["870: func (r *Ratchet) Check(origin Origin) error {", "871: \treturn nil", "872: }", `${tokLine}: if origin.Kind == nil {`].join("\n");
  const inWin = mechCorroborate(p, mat(910)); // 890+20=910 在窗内
  assert(inWin.checkable === true && inWin.refuted === true && inWin.note === BP_NOTE_EXISTS("origin.Kind", true, true), `边界内（910）⇒ 证伪：${inWin.note}`);
  const outWin = mechCorroborate(p, mat(911)); // 890+21=911 出窗
  assert(outWin.checkable === true && outWin.refuted === false && outWin.note === BP_NOTE_EXISTS("origin.Kind", false, true), `边界外（911）裁掉 ⇒ 不证伪：${outWin.note}`);
  const noLn = mechCorroborate({ text: "ratchet 的 Check 中不存在 origin.Kind 校验分支" }, mat(911));
  assert(noLn.checkable === true && noLn.refuted === true && noLn.note === BP_NOTE_EXISTS("origin.Kind", true, false), `无行号 ⇒ || material 全文回退 ⇒ 证伪：${noLn.note}`);
}

{
  log("=== FB-15②：引文长度边界 2/3/120/121 与绑定窗 30/31 ===");
  const q2 = "ab";
  const n2 = mechCorroborate({ text: `第 30 行是「${q2}」的赋值语句` }, "30: ab");
  assert(n2.checkable === false && n2.refuted === false && n2.note === BP_NOTE_NOT_MECH, `引文 2 字（下限外负例，与 121 对称）拒核：${JSON.stringify(n2)}`);
  const q3 = "abc";
  const n3 = mechCorroborate({ text: `第 30 行是「${q3}」的赋值语句` }, "30: abc");
  assert(n3.checkable === true && n3.refuted === false && n3.note === BP_NOTE_LINE(30, q3, true), `引文 3 字（下限）可核：${n3.note}`);
  const q120 = "x".repeat(120);
  const n120 = mechCorroborate({ text: `第 30 行是「${q120}」的赋值语句` }, `30: ${q120}`);
  assert(n120.checkable === true && n120.refuted === false && n120.note === BP_NOTE_LINE(30, q120, true), `引文 120 字（上限）可核且 note 不截断（FB-14：24→120）：${n120.note.slice(0, 36)}…`);
  const q121 = "x".repeat(121);
  const n121 = mechCorroborate({ text: `第 30 行是「${q121}」的赋值语句` }, `30: ${q121}`);
  assert(n121.checkable === false && n121.refuted === false && n121.note === BP_NOTE_NOT_MECH, `引文 121 字（超上限）拒核：${JSON.stringify(n121)}`);
  const fill30 = "甲乙丙丁戊己庚辛壬癸".repeat(3);
  const fill31 = `${fill30}甲`;
  const w30pre = mechCorroborate({ text: `第 30 行${fill30}是「abc」的赋值语句` }, "30: abc");
  assert(w30pre.checkable === true && w30pre.refuted === false, `绑定窗 30 字（谓词前）仍绑定：${JSON.stringify(w30pre)}`);
  const w31pre = mechCorroborate({ text: `第 30 行${fill31}是「abc」的赋值语句` }, "30: abc");
  assert(w31pre.checkable === false && w31pre.refuted === false, `绑定窗 31 字（谓词前）超窗 ⇒ 拒核：${JSON.stringify(w31pre)}`);
  const w30post = mechCorroborate({ text: `第 30 行是${fill30}「abc」的赋值语句` }, "30: abc");
  assert(w30post.checkable === true && w30post.refuted === false, `绑定窗 30 字（谓词后）仍绑定：${JSON.stringify(w30post)}`);
  const w31post = mechCorroborate({ text: `第 30 行是${fill31}「abc」的赋值语句` }, "30: abc");
  assert(w31post.checkable === false && w31post.refuted === false, `绑定窗 31 字（谓词后）超窗 ⇒ 拒核：${JSON.stringify(w31post)}`);
}

{
  log("=== FB-15③：停用词大小写与嵌入边界（mechTokens 卫生，蓝本词表逐字）===");
  assert(
    JSON.stringify(mechTokens("The And NOT resolveIdentifier")) === JSON.stringify(["resolveIdentifier"]),
    `停用词大小写不敏感（The/And/NOT 全剥）：${JSON.stringify(mechTokens("The And NOT resolveIdentifier"))}`,
  );
  assert(
    JSON.stringify(mechTokens("therein notable nothing")) === JSON.stringify(["therein", "notable", "nothing"]),
    `停用词只剥整词（嵌入边界：therein/notable/nothing 不剥）：${JSON.stringify(mechTokens("therein notable nothing"))}`,
  );
}

{
  log("=== FB-15④：全部拒核分支 refuted=false（拒核永不证伪）===");
  const cases: Array<[string, { text: string }, string]> = [
    ["行缺失", { text: "第 30 行是「abc」的赋值语句" }, "31: abc"],
    ["行号歧义", { text: "第 30 行是「abc」的赋值语句" }, "30: abc\n30: abc"],
    ["无 identifier token", { text: "文档中没有说明超时上限的保护" }, "1: // 任意材料"],
    ["非闭集形态", { text: "这段文字既无行号也无存在性谓词" }, "1: // 任意材料"],
    ["多行引文", { text: "第 30 行是「ab\ncd」的赋值语句" }, "30: ab cd"],
    ["超长引文 121 字", { text: `第 30 行是「${"x".repeat(121)}」的赋值语句` }, "30: x"],
    ["绑定窗 31 字", { text: `第 30 行${"甲乙丙丁戊己庚辛壬癸".repeat(3)}甲是「abc」的赋值语句` }, "30: abc"],
    ["主语窗跨行", { text: "第 5 行没有说明\nfoo.bar 的校验" }, "5: any"],
  ];
  for (const [name, step, material] of cases) {
    const r = mechCorroborate(step, material);
    assert(r.checkable === false && r.refuted === false, `FB-15④ ${name} 拒核且 refuted=false：${JSON.stringify(r)}`);
  }
}

{
  log("=== FB-15⑥：note 期望值 = 差分蓝本 judge-finding.mjs 文案（独立源，非实现自身字符串）===");
  const missing = mechCorroborate({ text: "第 30 行是「abc」的赋值语句" }, "31: abc");
  assert(missing.note === BP_NOTE_MISSING(30), `行缺失 note = 蓝本 :55 文案：${missing.note}`);
  const amb = mechCorroborate({ text: "第 30 行是「abc」的赋值语句" }, "30: abc\n30: abc");
  assert(amb.note === BP_NOTE_AMBIG(30, 2), `行号歧义 note = 蓝本 :56 文案：${amb.note}`);
  const noTok = mechCorroborate({ text: "文档中没有说明超时上限的保护" }, "1: // 任意材料");
  assert(noTok.note === BP_NOTE_NO_TOKEN, `无 token note = 蓝本 :76 文案：${noTok.note}`);
  const notMech = mechCorroborate({ text: "这段文字既无行号也无存在性谓词" }, "1: // 任意材料");
  assert(notMech.note === BP_NOTE_NOT_MECH, `非闭集 note = 蓝本 :78 文案：${notMech.note}`);
}

console.log(`\n[mech-test] 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
