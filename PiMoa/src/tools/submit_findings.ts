/**
 * `submit_findings` / `amend_facts` —— verify 模式 proposer 的结构化提交工具
 * （Jev 辅助代码审查详细设计 v4 §2 / §3.2，2026-09-20；徐总 09-20 追加裁定「优化 6」：quote → anchor）。
 *
 * ## 做什么
 * proposer 写完审查正文后调用 `submit_findings` 提交结构化清单；服务端**机械核验**每条：
 *   · path 必须解析到本轮附入材料（req.materials，设计 §3.1）；
 *   · lines 必须落在该文件某一附入段内、a ≤ b、跨度 ≤ 200；
 *   · anchor（≤80 字的辨识片段，不是整行原文）必须能在材料里定位（见 anchorHit）——**不 REJECT**，
 *     只登记状态：在所写行号范围内命中 → OK；范围外但同 abs 唯一命中 → 自动校正 finding.lines 为该行、
 *     登记「行号已校正」；命中多行 → 「锚点不唯一」，不校正；哪里都找不到 → 「锚点未命中」；
 *   · facts 不得含推论词（运行时条件类除外）；代码事实必须带行号引用；
 *   · 「不成立」类断言必须用 kind:"counter"，counter 条目 level 必须为 COUNTER；id 不得重复。
 * 不合格（path 未附入 / 行号越界跨度超限 / facts 规则 / claim 规则 / id 重复 / 空清单无理由）→
 * `REJECT（第 n/max 次）` 逐条回贴原因，proposer 改后重提，最多 max 次。
 * 合格 → 写进会话内存 `FindingsState.accepted`，runSession 结束时折成 SessionRunResult.structured。
 *
 * `amend_facts` 是 jevcheck 阶段补前提短会话的唯一工具：只处理 target.id 这一条，facts 过同一套推论词 /
 * 行号规则，写入**独立的** `AmendState`（不共享 proposer 的 `FindingsState`，设计 v4 §3.2/§3.3）。
 *
 * ## 为什么不破坏「子 agent 不生成孙 agent」不变量
 * 两个工具只写**会话内存状态**（闭包持有的 FindingsState）：不读盘、不出网、不 spawn、不设 addedToolNames。
 * 它们能看到的材料是 recon 已附入 context 的同一份副本，没有任何新的读面。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isAbsolute, normalize, resolve } from "node:path";
import type { MaterialFile, MaterialMap } from "../moa/types.js";
// B1 执法②复用 B3 的 token 卫生（≥3 字、剥路径、停用词表）；mech.ts 自包含、无运行时环。
import { absenceSubject, mechTokens } from "../moa/mech.js";

/** 工具定义类型（pi customTools 的元素类型）。 */
export type ToolDef = ToolDefinition;

// ---- schema（设计 v4 §2，徐总 09-20 追加裁定：quote → anchor）----

/** B1 chain 步（设计稿 §B1 的 Type 定义照抄：2–6 条、kind=link|absence|runtime、text 8–480、from/to 可选）。 */
export const ChainStepSchema = Type.Object({
  id: Type.String(), // c1…
  kind: Type.Union([Type.Literal("link"), Type.Literal("absence"), Type.Literal("runtime")]),
  text: Type.String({ minLength: 8, maxLength: 480 }),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
});

/** chain 处理器层精确边界（与 schema 同值；handler 同样用人话拒并计次，沿 FINDING_LIMITS 惯例）。 */
export const CHAIN_LIMITS = { minSteps: 2, maxSteps: 6, textMin: 8, textMax: 480 } as const;

export type ChainStep = Static<typeof ChainStepSchema>;

export const FindingSchema = Type.Object({
  id: Type.String({ pattern: "^F[0-9]{1,2}$" }),
  kind: Type.Union([Type.Literal("finding"), Type.Literal("counter")], { default: "finding" }),
  level: Type.Union([Type.Literal("BLOCKER"), Type.Literal("MAJOR"), Type.Literal("MINOR"), Type.Literal("COUNTER")]),
  path: Type.String({ minLength: 1, maxLength: 400 }),
  lines: Type.String({ pattern: "^[0-9]{1,6}(-[0-9]{1,6})?$" }),
  // 引用行里一个有辨识度的片段（函数名/变量名/字符串常量/短语），不是整行原文；原文由服务端从材料取。
  // ★长度/条数类约束放宽到 schema 只兜底（×3），精确上限（anchor ≤160、fact ≤320、3–8 条、claim/fix_expect ≤500）
  //   在处理器里用人话拒并计次：typebox 层的拒绝不进处理器、不计 attempts、文案是英文 schema 错误——灰度第 3 轮
  //   MiniMax 把 anchor 写成 100 字描述句被 schema 拒了多次，一遍遍数字符缩句子，七分钟耗在这里。
  //   ★2026-09-20 §12.6 第 6 点：claim/fix_expect 500、单条事实 320（灰度第 4 轮两家首次提交都因
  //   claim 330–490 字 / 事实 250–275 字被拒）；anchor ≤160 不变；schema 兜底仍 ×3。
  anchor: Type.String({
    minLength: 3,
    maxLength: 300,
    description: "从 lines 那几行代码里逐字抄的一个短片段（函数名 / 变量名 / 字符串常量），必须在那几行里原样出现；不是对缺陷的描述句。例：`svcIdentityMatches(origin.Command)` 或 `\"management_proof_missing\"`",
    examples: ["svcIdentityMatches(origin.Command)", "if relationOnly && gotOperation != \"relate\""],
  }),
  facts: Type.Array(Type.String({ minLength: 6, maxLength: 960 }), { minItems: 1, maxItems: 20 }),
  claim: Type.String({ minLength: 10, maxLength: 1500 }),
  fix_expect: Type.String({ minLength: 10, maxLength: 1500 }),
  strength: Type.Union([Type.Literal("亲验"), Type.Literal("推理")]),
  // ---- B1 chain 载体（设计稿 §B1）：claim 的失败场景由 chain 显式串出 ----
  // kind=finding **必填**（2–6 步）；kind=counter **可空**（整个省略本键）。kind 条件必填 typebox
  // 表达不了，由处理器执法（validateFinding，chain 形态打开时），沿「schema 兜底 + 处理器用人话拒
  // 并计次」既有惯例（typebox 层拒绝不进处理器、不计 attempts、文案是英文）。
  // kind=link 的步把因果串成 from → to；kind=absence 的步主语必须带 identifier token（≥3 字、剥
  // 路径）——否则机械佐证只能拒核降级（B3，设计 §B1「灰度第 6 轮教训」）。
  chain: Type.Optional(
    Type.Array(ChainStepSchema, {
      minItems: 2,
      maxItems: 6,
      description:
        "因果链步骤（kind=finding 必填 2–6 步；kind=counter 不用给）：每步 id（c1、c2…）、kind（link=因果推断步，from→to 串出前因后果；absence=存在性断言，主语必须带 ≥3 字 identifier token；runtime=运行时条件）、text（8–480 字）。claim 含因果连词（因此/所以/导致/⇒…）时必须有对应的 link 步。例：[{id:\"c1\",kind:\"absence\",text:\"Check() 中不存在对 origin.Kind 为空的校验分支\"},{id:\"c2\",kind:\"link\",text:\"Kind 为空的 origin 因此绕过来源校验\",from:\"c1\",to:\"c3\"},{id:\"c3\",kind:\"runtime\",text:\"运行时条件：origin.Command 取自无关进程的命令行\"}]",
    }),
  ),
});

/** 处理器层精确上限（§12.6 第 6 点，2026-09-20；schema 只做 ×3 兜底）。 */
export const FINDING_LIMITS = { anchorMax: 160, factMax: 320, factsMin: 3, factsMax: 8, claimMax: 500, fixExpectMax: 500 } as const;

export const FINDING_CATEGORIES = ["fake-green", "wiring", "hardcode", "overdesign", "behavior"] as const;
export type FindingCategory = typeof FINDING_CATEGORIES[number];
// Widen only the schema-level fallback to string: a closed enum here would reject
// unknown strings BEFORE execute(), bypassing the required attempt-counted Chinese error.
const CategorySchema = Type.String({ description: `只允许 ${FINDING_CATEGORIES.join(" / ")}；非法值由处理器计次并用人话拒绝` });
const CategorizedFindingSchema = Type.Object({ ...FindingSchema.properties, category: Type.Optional(CategorySchema) });
// Deliberately allow malformed values through TypeBox: array/element/length errors must reach
// execute() so they consume an attempt and return a Chinese, actionable REJECT message.
const FactQuotesSchema = Type.Optional(Type.Any({ description: "factQuotes 可选：按 facts 下标对齐的整行原文数组；元素须为非空字符串、条数不超过 facts；逐字抄录材料裸行（去首尾空白）。形状错误由处理器计次拒绝。" }));
export function submitFindingsParams(categoryEnabled = false, quoteEnabled = false) {
  if (!quoteEnabled) return categoryEnabled ? CategorizedSubmitFindingsParams : SubmitFindingsParams;
  const props = { ...FindingSchema.properties, ...(categoryEnabled ? { category: Type.Optional(CategorySchema) } : {}), factQuotes: FactQuotesSchema };
  return Type.Object({ findings: Type.Array(Type.Object(props), { minItems: 0, maxItems: 40 }), no_findings_reason: Type.Optional(Type.String({ maxLength: 300 })) });
}
export const SubmitFindingsParams = Type.Object({
  findings: Type.Array(FindingSchema, { minItems: 0, maxItems: 40 }),
  no_findings_reason: Type.Optional(Type.String({ maxLength: 300 })),
});
/** Off returns the exact old schema object, including all nested descriptions. */
export const CategorizedSubmitFindingsParams = Type.Object({
  findings: Type.Array(CategorizedFindingSchema, { minItems: 0, maxItems: 40 }),
  no_findings_reason: Type.Optional(Type.String({ maxLength: 300 })),
});

export const AmendFactsParams = Type.Object({
  id: Type.String({ pattern: "^F[0-9]{1,2}$" }),
  facts: Type.Array(Type.String({ minLength: 6, maxLength: 960 }), { minItems: 0, maxItems: 4 }), // 兜底 ×3（处理器 factMax=320）
  // B1「amend_facts 同步扩 chain 增补」（设计 §B1 末条）：补的是**增补步**，1 步即合法（全链 2–6 的
  // 上下限由 submit 侧 FindingSchema 把关）；步的形状（kind 闭集 / text 8–480 / id 非空）同 FindingSchema。
  chain: Type.Optional(
    Type.Array(ChainStepSchema, {
      minItems: 1,
      maxItems: 6,
      description: "增补的因果链步骤（1–6 步；步形状同 submit_findings 的 chain）：补不出来就不写本键。",
    }),
  ),
  cannot_amend_reason: Type.Optional(Type.String({ maxLength: 200 })),
});

export type Finding = Static<typeof FindingSchema> & { category?: FindingCategory; factQuotes?: string[] };
export type SubmitFindingsInput = Omit<Static<typeof SubmitFindingsParams>, "findings"> & { findings: Finding[] };
export type AmendFactsInput = Static<typeof AmendFactsParams>;

/**
 * anchor 定位结果（徐总 09-20 裁定「优化 6」）：四种状态**都不是 REJECT 理由**，只登记供回执/核对表用。
 * `line` 仅 status="行号已校正" 时有值（命中的真实行号）。
 */
export interface AnchorCheck {
  status: "OK" | "行号已校正" | "锚点未命中" | "锚点不唯一";
  line?: number;
  /** 命中方式：缺省整串子串命中；"标识符" = 整串未命中、按 anchor 里的标识符 token 命中（token 记 token 字段）。 */
  via?: "标识符";
  token?: string;
}

/** 已接受 finding 的 anchor 登记（FindingsState.refs 的值）：status/line 同 AnchorCheck；
 * originalLines 仅 status="行号已校正" 时有值 —— 校正前 proposer 原写的 lines，供回执/核对表对照。
 * `refConsistency`/`anchorLine`/`factsRange`（徐总 09-20 追加裁定，覆盖任务书原「lines/anchor 可选」条，
 * 见设计 v4 §12.6 第 2 点改写版）：lines/anchor 照旧必填，新增事实引用行作第三路互验，见 `checkFactRef`
 * 与 `createSubmitFindingsTool` 里的三路互验逻辑。 */
export interface RefCheck extends AnchorCheck {
  originalLines?: string;
  /** anchor 命中的真实行号（= AnchorCheck.line；OK/行号已校正两态都有值，供三路互验读取）。 */
  anchorLine?: number;
  /** 相符/已校正事实引用行的 [min,max]（无可核事实时不设）。 */
  factsRange?: [number, number];
  /** 三路互验结果：一致 / 不一致（登记不 REJECT）/ 仅两路（无可核事实，只做 anchor+lines 两路）。 */
  refConsistency?: "一致" | "不一致" | "仅两路";
}

/** 每个 proposer 会话一份，服务端持有（闭包），模型无法直接改写。 */
export interface FindingsState {
  accepted: Finding[] | null;
  attempts: number;
  /** 每次 REJECT 的完整文案。 */
  rejects: string[];
  /** 每条已接受 finding 的 anchor 定位状态（设计 v4 §3.2 优化 6）；id → 状态。 */
  refs: Map<string, RefCheck>;
  /**
   * 事实级机械校验结果（设计 v4 §12.2 A，波四 2026-09-20）：id → 该 finding 里每条 **code 类**事实的
   * `checkFactRef` 结果（按原始事实文本，与 general/condition 类事实无关，故不与 `Finding.facts`
   * 索引对齐——下游按 `FactRef.text` 匹配回原 fact）。
   */
  factRefs: Map<string, FactRef[]>;
  /** 最后一次提交里因校验未过被丢弃的条目（徐总 2026-09-20 定：最后一次接受合格子集）。 */
  dropped?: { id: string; errors: string[] }[];
}

export function createFindingsState(): FindingsState {
  return { accepted: null, attempts: 0, rejects: [], refs: new Map(), factRefs: new Map() };
}

/**
 * 补前提短会话专用状态（设计 v4 §3.2/§3.3）：与 proposer 的 FindingsState **不共享**——
 * 补前提回合是 jevcheck 阶段起的独立短会话，只处理一个 finding 的一条 id，不进 aggregator。
 * `accepted` = 已接受的补充事实列表（未接受为 null）；`reason` = cannot_amend_reason（如有）。
 * `factRefs`（波四）：补充事实里每条 code 类事实的 `checkFactRef` 结果，同 FindingsState.factRefs 口径。
 */
export interface AmendState {
  accepted: string[] | null;
  attempts: number;
  rejects: string[];
  reason?: string;
  factRefs?: FactRef[];
  /** B1（设计 §B1 末条）：amend_facts 补进来的 chain 增补步（未补为 null）。 */
  acceptedChain?: ChainStep[] | null;
}

export function createAmendState(): AmendState {
  return { accepted: null, attempts: 0, rejects: [] };
}

// ---- 规则常量（设计 v4 §3.2 原文）----

// 不收单字「故」「可见」：会误伤「故障」「可见性」。改用「故而/故此/由此可见」等多字推论词。
export const INFERENCE_WORDS = /(因此|所以|从而|会导致|可能被|于是|意味着|导致了|这说明|故而|故此|因而|致使|由此可见)/;
/**
 * B1 执法①的 claim 侧因果连词（设计 §B1「claim 含因果连词『所以/导致/⇒』而无对应 link 步 ⇒ REJECT」）：
 * 沿现有推论词表（INFERENCE_WORDS）扩展因果连词/箭头（因为/由于/造成/⇒/→）。INFERENCE_WORDS 本体
 * **不动**——facts 推论词执法与派单提示词的 14 词清单是既有锁定面（test/moa.test.ts A5 逐字断言）。
 */
export const CAUSAL_WORDS = /(因此|所以|从而|会导致|导致了|导致|可能被|于是|意味着|这说明|故而|故此|因而|致使|由此可见|因为|由于|造成|⇒|→)/;
/**
 * ★2026-09-27 C 提示词预防（徐总裁定）：模型把工具参数包进 ``` 围栏 / 夹注释 → typebox schema 层直接拒、
 * 不进处理器、不计 attempts（重提链无上限，DEF-10 另在 session.ts 兜底）→ 在三个结构化工具
 * （submit_findings / amend_facts / submit_verdicts）的 description 末尾追加同一句约束，原文一字不动 →
 * 纯提示文本，不改 schema、不改任何校验逻辑。submit_verdicts.ts 复用本常量（单一真源）。
 */
export const RAW_JSON_ARGS_NOTE = "参数必须是纯 JSON 对象(raw JSON):禁止 ``` 围栏、注释、任何非 JSON 内容。";

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-11）：「第 N 行」的行号部分（单点 / 逗号枚举 / 区间，分隔符含 -–~.、,，/
 * 与「至/到」）抽成共用片段 → LINE_REF 与 submit_verdicts.ts 的 hasRebuttalAnchor（经 LINE_NO_REF）同源，
 * 不复制正则 → 边界：LINE_REF 的 source 与改前逐字节相同（test/submit_findings.test.ts 用例 11 钉住）。
 */
const LINE_NO_CORE = String.raw`第\s*\d+(?:\s*[-–~.、,，/]\s*\d+|\s*(?:至|到)\s*\d+)*\s*`;
// 「:数字」只在文件扩展名之后才算行号引用，避免把 127.0.0.1:8760 这类 IP:端口 误判为行号引用。
// 「第 74、78、89 行」「第 12-20 行」「第 5 至 9 行」这类枚举/区间写法都算有行号（灰度第 3 轮：DeepSeek 的
// 「决策记录第 74、78、89、100、111、122 行」被判无行号，三次重提整轮失败）。
export const LINE_REF = new RegExp(
  `(${LINE_NO_CORE}(?:行|节)|§\\s*\\d+(?:\\.\\d+)*|\\bL\\d+\\b|\\.(?:ts|mts|go|sh|md|yaml|yml|json|surql|py)[:#]L?\\d+(?:-\\d+)?)`,
);
/** DEF-11：只认「第…行」（不含 LINE_REF 的「节」/§/L\d/文件扩展名分支）——rebuttal 只扩行号写法。 */
export const LINE_NO_REF = new RegExp(`${LINE_NO_CORE}行`);
/** kind=finding 的 claim 若命中，须改用 counter 条目。 */
const NEGATED_CLAIM_RE = /(不成立|无缺陷|不存在此问题|属正常|不算缺陷|代码本身正确|本身没有问题)/;
/** 单条 finding 的行跨度上限（b − a）。 */
const MAX_LINE_SPAN = 200;
/** 一次 REJECT 最多回贴的条数。 */
const MAX_REJECT_ITEMS = 15;
/** amend_facts 的提交次数上限（与 submit 同档 3 次）。 */
const AMEND_MAX_ATTEMPTS = 3;

// ---- 纯函数（可单测）----

/**
 * ★2026-09-20 徐总批准：模型对**含空格的绝对路径**做 evidence 引用时会写成 URL 编码
 *（`Claude dev paper system` → `Claude%20dev%20paper%20system`），而本仓路径恰好含空格。
 * 原实现走 isAbsolute ⇒ normalize(p)（不做百分号解码）⇒ materials.get() 必 miss，
 * 退回 s.rel 字面比对的兜底也 miss ⇒ 判「路径解析不到本轮附入材料」并把整条裁决拒掉
 *（2026-09-20 对抗审 B 路真实失败轮 moa#da4c2f3d；同 payload 重跑一次即通过）。
 * 修法：候选里**追加**一个百分号解码后的变体；原路径的解析顺序与结果一律不变。
 * 仅在「含 %XX 转义」且「解码成功」且「与原文不同」时追加；非法转义（如孤立 %）会抛
 * URIError，静默跳过——绝不让解码失败影响原路径解析。
 * ★2026-09-27 徐总裁定（DEF-09）：改为 export，供 jevcheck.ts 的 findSegsForPath 复用同一解码口径。
 */
export function percentDecodedVariant(p: string): string | null {
  if (!/%[0-9A-Fa-f]{2}/.test(p)) return null;
  try {
    const d = decodeURIComponent(p);
    return d === p ? null : d;
  } catch {
    return null;
  }
}

/**
 * `resolveMaterialDetailed` 的三态结果：命中（`via` 区分精确解析 / 尾部兜底）、尾部兜底多候选且消不了歧、未命中。
 */
export type MaterialResolution =
  | { kind: "hit"; segs: MaterialFile[]; via: "exact" | "tail" }
  | { kind: "ambiguous"; candidates: MaterialFile[][] }
  | { kind: "miss" };

/**
 * 把 path 归一到 materials 的 key（abs）：相对 cwd、相对各 readRoot、绝对路径三种写法都试；
 * 再退一步按 MaterialFile.rel 精确匹配（材料段头里显示的就是 rel）。找不到返回 null。
 * `preferredPath`（★DEF-09 追加的可选尾参）：只在尾部兜底多候选时用来消歧；缺省 undefined ⇒ 与改前同一算法。
 */
export function resolveMaterial(
  path: string,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  preferredPath?: string | readonly string[],
): MaterialFile[] | null {
  const r = resolveMaterialDetailed(path, materials, cwd, readRoots, preferredPath);
  return r.kind === "hit" ? r.segs : null;
}

/**
 * ★2026-09-27 徐总裁定（PIMOA-DEF-09 路径形态兜底）：
 * 病理——evidence schema 禁空白（types.ts:124）⇒ 模型无法逐字写出含空格的 rel，只能自造「PiMoa/config/models.json」
 *   「config/models.json」「models.json」这类尾部相对 / 裸文件名；改前本函数只认 abs / cwd-rel / readRoot-rel / rel 字面全等，
 *   而 checkFactRef 与 jevcheck.findSegsForPath 都带尾部匹配——同一短路径在 finding 事实里能过、在 verdict evidence 里被拒，
 *   模型逐次缩短试错 3-5 连拒（REPRO-20PCT.md 第 9/10/11 行；verdicts.maxAttempts=5，有整轮 failed 风险）。
 * 修法——精确解析与 rel 字面兜底两层**原样保留、仍先跑**；两层都 miss 后才追加第三层「rel 尾部匹配」
 *   （`rel.endsWith('/' + 路径)`，即 checkFactRef 原有口径下沉；路径含 %XX 时解码变体殿后同样参与）。
 *   唯一候选 ⇒ 命中；多候选 ⇒ 按 `preferredPath`（与 rel 或 abs 全等）筛，筛剩恰好一个才命中，否则判 ambiguous。
 * ★2026-09-27 徐总裁定（DEF-09 F1 fix）：
 * 病理——初版唯一候选在 prefs 过滤**之前**直接 hit（fail-open）：materials={a.go, b/x/main.go}、preferredPath=["a.go"]、
 *   path="main.go" 会命中 b/x/main.go，而 DEF-09 前（无第三层）verdict 侧必 REJECT。
 * 修法——prefs 非空时唯一候选也须匹配 prefs，不匹配 ⇒ miss（拒方向）；prefs 为空唯一候选仍直 hit。
 *   `uniqueIgnoresPrefs`（可选尾参）=true 时唯一候选不核 prefs 直 hit——仅 checkFactRef 传：它的 findingPath 只用于
 *   多候选消歧，事实引用别的已附文件是正路（DEF-09 前即唯一候选直取），不传则跨文件事实会退成「文件未附」直判不符。
 * 边界——verdict 两消费点（validateVerdicts / computeEvidenceRef）与 resolveMaterial 包装不传，唯一候选受 prefs 约束；
 *   多候选消歧逻辑与本参无关、零变化；精确层与 rel 字面层先跑（%20 全 rel 仍走精确层，不受本收紧影响）。
 * 边界——绝对路径不走尾部兜底（保持精确）；只比 rel 不比 abs（与 checkFactRef 改前口径一致，不扩大候选面）；
 *   多候选消不了歧**绝不静默取首个**（verdict 侧据此拒并列出候选、checkFactRef 据此标「待核」）；
 *   %2520 双编码与「+」号不解码（本函数只做一层 decodeURIComponent）。
 */
export function resolveMaterialDetailed(
  path: string,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  preferredPath?: string | readonly string[],
  uniqueIgnoresPrefs?: boolean,
): MaterialResolution {
  const p = path.trim();
  if (p === "") return { kind: "miss" };
  const candidates: string[] = [];
  const pushCandidates = (v: string): void => {
    if (isAbsolute(v)) candidates.push(normalize(v));
    else {
      candidates.push(resolve(cwd, v));
      for (const root of readRoots) candidates.push(resolve(root, v));
    }
  };
  pushCandidates(p);
  // ★2026-09-20 徐总批准：追加百分号解码变体（排在原路径之后，先命中先返回；解码失败静默跳过）。
  const dp = percentDecodedVariant(p);
  if (dp !== null) pushCandidates(dp);
  for (const c of candidates) {
    const segs = materials.get(c);
    if (segs && segs.length > 0) return { kind: "hit", segs, via: "exact" };
  }
  const stripped = p.replace(/^\.\//, "");
  const literals = [stripped, p];
  if (dp !== null) literals.push(dp, dp.replace(/^\.\//, ""));
  for (const segs of materials.values()) {
    if (segs.length > 0 && segs.some((s) => literals.includes(s.rel))) return { kind: "hit", segs, via: "exact" };
  }
  // ★DEF-09 第三层：rel 尾部兜底（原路径形态在前、解码变体殿后；绝对路径不参与）。
  const tails = [stripped];
  if (dp !== null) tails.push(dp.replace(/^\.\//, ""));
  const tailForms = [...new Set(tails)].filter((t) => t !== "" && !isAbsolute(t));
  if (tailForms.length === 0) return { kind: "miss" };
  const cands = [...materials.values()].filter((arr) => {
    const rel = arr[0]?.rel;
    return rel !== undefined && tailForms.some((t) => rel.endsWith(`/${t}`));
  });
  if (cands.length === 0) return { kind: "miss" };
  const prefs = preferredPath === undefined ? [] : typeof preferredPath === "string" ? [preferredPath] : [...preferredPath];
  if (cands.length === 1 && (prefs.length === 0 || uniqueIgnoresPrefs === true)) return { kind: "hit", segs: cands[0]!, via: "tail" };
  const preferred = prefs.length === 0 ? [] : cands.filter((c) => c.some((s) => prefs.includes(s.rel) || prefs.includes(s.abs)));
  if (preferred.length === 1) return { kind: "hit", segs: preferred[0]!, via: "tail" };
  // ★DEF-09 F1：唯一候选不匹配 prefs ⇒ miss（拒方向）；多候选消不了歧 ⇒ ambiguous（改前口径不变）。
  if (cands.length === 1) return { kind: "miss" };
  return { kind: "ambiguous", candidates: cands };
}

/**
 * 一行材料文本的归一（用于 anchor 逐行 includes 判定）：先剥 `^\s*\d+\|\s?` 行号前缀（模型/材料渲染
 * 可能带；裸行本身不带，剥一次无副作用），再去 \r、去全部空白。
 */
function normalizeForAnchor(l: string): string {
  return l.replace(/^\s*\d+\|\s?/, "").replace(/\r/g, "").replace(/\s+/g, "");
}

/** 找出包含 [a,b] 的附入段（多段都含时取第一段）。 */
function segmentContaining(segs: readonly MaterialFile[], a: number, b: number): MaterialFile | undefined {
  return segs.find((s) => s.start <= a && b <= s.end);
}

/**
 * anchor 定位（设计 v4 §3.2「anchor 定位（不 REJECT）」行，徐总 09-20 裁定细化）：
 * 归一化（去空白、去 \r、剥行号前缀）后**先在 [a,b] 内逐行 includes** → 命中即 `status:"OK"`；
 * 未命中则**在同 abs 全部段逐行找**：恰好命中 1 行 → `status:"行号已校正"`、`line`=该行；
 * 命中 ≥2 行 → `status:"锚点不唯一"`（不校正，无法确定唯一位置）；0 行 → `status:"锚点未命中"`。
 * 这四种状态**都不 REJECT**。
 */
export function anchorHit(anchor: string, segs: readonly MaterialFile[], a: number, b: number): AnchorCheck {
  const needle = normalizeForAnchor(anchor);
  if (needle === "") return { status: "锚点未命中" };

  const seg = segmentContaining(segs, a, b);
  if (seg) {
    for (let line = a; line <= b; line++) {
      const raw = seg.lines[line - seg.start];
      if (raw !== undefined && normalizeForAnchor(raw).includes(needle)) {
        return { status: "OK", line };
      }
    }
  }

  const hits: number[] = [];
  for (const s of segs) {
    for (let i = 0; i < s.lines.length; i++) {
      if (normalizeForAnchor(s.lines[i] as string).includes(needle)) hits.push(s.start + i);
    }
  }
  if (hits.length === 1) return { status: "行号已校正", line: hits[0] };
  if (hits.length > 1) return { status: "锚点不唯一" };

  // ★整串未命中 → 按标识符匹配（徐总 09-20：不能只靠提示词约束 anchor 的写法）。模型把 anchor 写成描述句
  //   （"opaqueHoleRegistryAdjudicated does not enforce …"）时，句子里的标识符往往就在引用行里；
  //   抽出标识符类 token 逐个找，[a,b] 内命中 → OK（via 标识符），同文件唯一命中 → 行号已校正。
  //   只认「像标识符」的 token（含大写驼峰 / 下划线 / 数字，或长度 ≥12），排除 does/not/writers 这类英文词误命中注释。
  const tokens = identifierTokens(anchor);
  if (tokens.length === 0) return { status: "锚点未命中" };
  if (seg) {
    for (let line = a; line <= b; line++) {
      const raw = seg.lines[line - seg.start];
      if (raw === undefined) continue;
      const tok = tokens.find((t) => raw.includes(t));
      if (tok) return { status: "OK", line, via: "标识符", token: tok };
    }
  }
  // 同文件：按最长的标识符找唯一行（越长越不会撞）。
  const byLen = [...tokens].sort((x, y) => y.length - x.length);
  for (const tok of byLen) {
    const tokHits: number[] = [];
    for (const s of segs) {
      for (let i = 0; i < s.lines.length; i++) {
        if ((s.lines[i] as string).includes(tok)) tokHits.push(s.start + i);
      }
    }
    if (tokHits.length === 1) return { status: "行号已校正", line: tokHits[0], via: "标识符", token: tok };
    if (tokHits.length > 1) return { status: "锚点不唯一", via: "标识符", token: tok };
  }
  return { status: "锚点未命中" };
}

/** anchor 里像标识符的 token：含大写驼峰 / 下划线 / 数字，或长度 ≥12；长度 ≥4；去重、保持出现顺序。 */
export function identifierTokens(anchor: string): string[] {
  const out: string[] = [];
  for (const m of anchor.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const t = m[0];
    if (t.length < 4) continue;
    const looksIdent = /[A-Z]/.test(t.slice(1)) || t.includes("_") || /\d/.test(t) || t.length >= 12;
    if (looksIdent && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 事实分类：前缀「通用事实：」→ general，「运行时条件：」→ condition，其余 code。 */
export function factKind(x: string): "code" | "general" | "condition" {
  const s = x.trimStart();
  if (s.startsWith("通用事实：")) return "general";
  if (s.startsWith("运行时条件：")) return "condition";
  return "code";
}

// ---- 事实级机械校验 checkFactRef（设计 v4 §12.2 A，徐总 09-20 裁定「办法三」全部照做，波四）----

/**
 * 七态（设计 §12.2 A 的六态描述 + §12.2 C 分流表里单列的「未命中」——两处对不齐：A 段概述给六个
 * 标签，其后的算法与 C 段的 Jev 分流表都要求区分「同文件也找不到（未命中，直接判不符）」与
 * 「多处命中（待核，仍问 Jev）」两种不同结果，缺一不可；按算法与分流表的字面逻辑实现七态，
 * A 段六态列举视为示例未尽列全，据实施惯例选一种并在此登记。
 */
export type FactRefStatus = "相符" | "已校正" | "待核" | "未命中" | "无标识符" | "文件未附" | "行号越界";

/**
 * 单条 code 事实的机械校验结果（`checkFactRef` 的返回值，登记进 `FindingsState.factRefs`）。
 * `a`/`b` 是**最终引用区间**：相符=原窗口（±2 容差裁到段内）；已校正=单行（a===b=校正后行号）；
 * 其余（待核/未命中/无标识符/文件未附/行号越界）=原样解析出的区间（无法解析时为 0,0）。
 * `text` 保留事实原文（未改写；下游按此文本匹配回 `Finding.facts` 对应条）。
 */
export interface FactRef {
  text: string;
  /** 命中/尝试解析到的文件显示名（rel；未附入材料时为原样解析出的文件名/路径）。 */
  file: string;
  a: number;
  b: number;
  status: FactRefStatus;
  /** 命中的标识符 / 引号内字符串常量（status="相符"/"已校正" 时有值）。 */
  token?: string;
  /** status="已校正" 时：proposer 原写的行号区间（"881" 或 "881-883"），保留原文供回执/核对表对照。 */
  originalLine?: string;
  /** status="已校正" 时：行号已改写成校正后行的事实文本（jevcheck 问 Jev 用这个，`text` 仍是原文）。 */
  rewritten?: string;
}

/** 事实文本里出现某已附入文件的**带扩展名文件名**或**完整 rel 路径**子串（与 jevcheck.ts 的
 * matchesFileRef 同口径；本文件独立实现，避免反向导入 jevcheck.ts 产生运行时环）。 */
function factMatchesFileRef(rel: string, fact: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  if (base.includes(".") && fact.includes(base)) return true;
  return fact.includes(rel);
}

/** 事实里引号内的字符串常量（双引号或反引号，≥2 字），供与 identifierTokens 合并作可核 token。 */
function quotedConstants(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]{2,})"|`([^`\n]{2,})`/g)) {
    const t = (m[1] ?? m[2]) as string;
    // 灰度第 6 轮：事实里两个单字符引号常量（"⟨" 与 "⟩"）之间的整段中文被当成一个「常量」——引号配对串位。
    // 代码里的字符串常量不会长到 80 字以上、也不会含全角标点，这两条过滤掉串位产物。
    if (t.length > 80 || /[，。、「」（）；：！？]/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 事实文本里形如路径的片段（`cmd/papergo/devkb_writes_table.go`、`ratchet.go`）：抽 token 前先剥掉，
 * 否则文件名 stem（devkb_writes_table / contractratchet）被当成标识符去代码行里找、必然「未命中」——
 * 灰度第 6 轮 14 条事实因此被机械判「不符」（aggregator 备注「不符项为核验器把文件名当标识符匹配的噪声」）。 */
const FACT_PATH_LIKE = /(?:[\w.-]+\/)*[\w.-]+\.(?:ts|mts|go|sh|md|yaml|yml|json|surql|py)\b/g;

/** checkFactRef 用的可核 token：标识符（剥掉路径片段后）+ 引号内字符串常量。 */
export function factCheckTokens(fact: string): string[] {
  const stripped = fact.replace(FACT_PATH_LIKE, " ");
  return [...identifierTokens(stripped), ...quotedConstants(fact)];
}

// ★与 validateFacts 的 LINE_REF 同一口径（波四复审 2026-09-20）：此前 FACT_EXT_LINE 要求路径以 `.`/`/` 开头，
//   裸文件名「ratchet.go:884」过得了 LINE_REF 却解析不出；FACT_CN_LINE 只认「第 N-M 行」，灰度第 3 轮那种
//   「第 74、78、89 行」枚举与「第 5 至 9 行」区间被判「无标识符」退回 Jev——机械校验对合法事实系统性漏检。
const FACT_EXT_LINE = /((?:[\w.-]+\/)*[\w.-]+\.(?:ts|mts|go|sh|md|yaml|yml|json|surql|py))[:#]L?(\d+)(?:-(\d+))?/;
const FACT_CN_LINE = /第\s*(\d+(?:\s*(?:[-–~.、,，/]|至|到)\s*\d+)*)\s*行/;
const FACT_L_LINE = /\bL(\d+)\b/;

/** 事实行号引用的解析结果：`windows` 是逐个核对的窗口（枚举「第 74、78 行」= 两个单点窗口；区间「第 5 至 9 行」
 * = 一个 [5,9] 窗口；「第 74-78、90 行」混写 = 两个窗口）；a/b 是全部窗口的 [min,max]，只作展示与 factsRange 用。 */
export interface FactLineRef {
  filePath?: string;
  a: number;
  b: number;
  windows: Array<[number, number]>;
}

/** 从事实文本抽 (可选文件路径, 窗口列表)：优先「path.ext:N」形式（自带文件名），其次中文「第 N 行」（枚举/区间
 * 逐项成窗——PiMoa 复审 P1/F1+P2/F2：一律取 [min,max] 会把「第 4、900 行」变成近千行窗口任一命中即相符），
 * 最后「LN」。解析不到（如 §X.Y 节引用）返回 null。 */
export function parseFactLineRef(fact: string): FactLineRef | null {
  const ext = FACT_EXT_LINE.exec(fact);
  if (ext) {
    const a = Number(ext[2]);
    const b = ext[3] !== undefined ? Number(ext[3]) : a;
    return { filePath: ext[1] as string, a: Math.min(a, b), b: Math.max(a, b), windows: [[Math.min(a, b), Math.max(a, b)]] };
  }
  const cn = FACT_CN_LINE.exec(fact);
  if (cn) {
    // 先按枚举分隔符（、 , ， / .）拆项，每项是单点或区间（- – ~ 至 到）。
    const windows: Array<[number, number]> = [];
    for (const item of (cn[1] as string).split(/\s*[.、,，/]\s*/)) {
      const nums = (item.match(/\d+/g) ?? []).map(Number);
      if (nums.length === 0) continue;
      windows.push([Math.min(...nums), Math.max(...nums)]);
    }
    if (windows.length === 0) return null;
    return { a: Math.min(...windows.map((w) => w[0])), b: Math.max(...windows.map((w) => w[1])), windows };
  }
  const l = FACT_L_LINE.exec(fact);
  if (l) {
    const a = Number(l[1]);
    return { a, b: a, windows: [[a, a]] };
  }
  return null;
}

/** ±2 行容差常量（设计 v4 §12.2 A）。 */
const FACT_REF_TOLERANCE = 2;
/** 单个引用窗口的最大跨度（行）：区间再宽，「窗口里任一行含 token」就不再是有意义的机械核对，超过即记「待核」交 Jev。 */
export const FACT_REF_MAX_WINDOW_SPAN = 30;

/** 把事实文本里的行号引用改写成校正后的行（任务书第 1 点「已校正时改写事实里的行号」；原文留在
 * `FactRef.text`/`originalLine`，改写版放 `FactRef.rewritten` 供 jevcheck 问 Jev 用——否则 Jev 拿到的是
 * 「第 900 行…」的事实配第 884 行的切片，会因行号对不上判不符）。 */
export function rewriteFactLine(fact: string, newLine: number): string {
  const ext = FACT_EXT_LINE.exec(fact);
  if (ext) return fact.replace(ext[0], `${ext[1]}:${newLine}`);
  const cn = FACT_CN_LINE.exec(fact);
  if (cn) return fact.replace(cn[0], `第 ${newLine} 行`);
  const l = FACT_L_LINE.exec(fact);
  if (l) return fact.replace(l[0], `L${newLine}`);
  return fact;
}

/**
 * 事实级机械校验（设计 v4 §12.2 A）：抽事实引用的 (文件, N[-M])，取材料该区间（±2 行容差）核对
 * 事实里的标识符/字符串常量是否原样出现；未命中时在同文件其它段找唯一命中行做校正。
 * `findingPath`（设计原文签名 `(fact, materials, cwd, readRoots)` 无此参）：算法要求「文件名按
 * matchesFileRef 口径…多候选优先 finding.path」——不知道是哪个 finding 的事实就无法在多文件候选间
 * 消歧，也无法在事实里没有显式文件名时定出默认文件；据实施任务书「按设计选一种并说明」追加此参，
 * 在此登记。
 */
export function checkFactRef(
  fact: string,
  findingPath: string,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
): FactRef {
  const parsed = parseFactLineRef(fact);
  if (!parsed) {
    // 抽不出行号引用（如「§3.2」节引用）：code 事实已在 validateFacts 阶段过 LINE_REF 正则，
    // 这里出现说明命中的是 LINE_REF 支持但本函数解析不了的形式——按「无标识符」处理，退回 Jev 判。
    return { text: fact, file: findingPath, a: 0, b: 0, status: "无标识符" };
  }

  let segs: MaterialFile[] | null;
  let fileDisplay: string;
  if (parsed.filePath) {
    // 裸文件名 / 尾部相对路径（「ratchet.go:884」「x/ratchet.go:884」）：材料按完整 rel 登记，按 cwd 解析不到；
    // 改按 rel 尾部匹配（多候选优先 finding.path），与无显式路径时的 factMatchesFileRef 同一宽容度。
    // ★2026-09-27 徐总裁定（DEF-09）：病理=本处尾部兜底与 verdict evidence 的 resolveMaterial 口径不一 ⇒ 同一短路径
    // 事实能过、裁决被拒；修法=尾部兜底下沉进 resolveMaterialDetailed，本处委托；边界=精确命中仍显示原写法、
    // 尾部命中显示 rel、多候选且 finding.path 消不了歧仍标「待核」不静默取首个（改前 .find 取首个匹配者，
    // 现要求恰好一个候选与 finding.path 全等）。
    const r = resolveMaterialDetailed(parsed.filePath, materials, cwd, readRoots, findingPath, true);
    if (r.kind === "ambiguous") {
      // 多候选且 finding.path 消不了歧（PiMoa 复审 P1/F6+P2/F4）：不静默取首个，交 Jev。
      return { text: fact, file: r.candidates[0]![0]!.rel, a: parsed.a, b: parsed.b, status: "待核" };
    }
    segs = r.kind === "hit" ? r.segs : null;
    fileDisplay = r.kind === "hit" && r.via === "tail" ? r.segs[0]!.rel : parsed.filePath;
  } else {
    const candidates: MaterialFile[][] = [];
    for (const segArr of materials.values()) {
      const rel = segArr[0]?.rel;
      if (rel && factMatchesFileRef(rel, fact)) candidates.push(segArr);
    }
    if (candidates.length === 0) {
      segs = resolveMaterial(findingPath, materials, cwd, readRoots);
      fileDisplay = findingPath;
    } else if (candidates.length === 1) {
      segs = candidates[0] as MaterialFile[];
      fileDisplay = segs[0]!.rel;
    } else {
      const preferred = candidates.find((c) => c.some((s) => s.rel === findingPath || s.abs === findingPath));
      if (!preferred) {
        // 事实里点了多个已附文件名、finding.path 又不在其中：不猜，交 Jev（PiMoa 复审 P1/F6+P2/F4）。
        return { text: fact, file: candidates[0]![0]!.rel, a: parsed.a, b: parsed.b, status: "待核" };
      }
      segs = preferred;
      fileDisplay = segs[0]!.rel;
    }
  }
  if (!segs || segs.length === 0) {
    return { text: fact, file: fileDisplay, a: parsed.a, b: parsed.b, status: "文件未附" };
  }

  const lo = parsed.a;
  const hi = parsed.b;
  const tokens = factCheckTokens(fact);
  const byLen = [...tokens].sort((x, y) => y.length - x.length);

  // 逐窗核对（PiMoa 复审 P1/F1+P2/F2）：每个窗口各自 ±2 找 token；任一窗口落在全部附入段之外 → 行号越界；
  // 任一窗口跨度超过 FACT_REF_MAX_WINDOW_SPAN → 待核（区间太宽，机械核对无意义，交 Jev）。
  const windowHits: boolean[] = [];
  let hitToken: string | undefined;
  for (const [wa, wb] of parsed.windows) {
    const windowSeg = segs.find((s) => s.end >= wa - FACT_REF_TOLERANCE && s.start <= wb + FACT_REF_TOLERANCE);
    if (!windowSeg) {
      return { text: fact, file: fileDisplay, a: lo, b: hi, status: "行号越界" };
    }
    if (wb - wa > FACT_REF_MAX_WINDOW_SPAN) {
      return { text: fact, file: fileDisplay, a: lo, b: hi, status: "待核", ...(byLen[0] ? { token: byLen[0] } : {}) };
    }
    if (tokens.length === 0) continue;
    const winA = Math.max(windowSeg.start, wa - FACT_REF_TOLERANCE);
    const winB = Math.min(windowSeg.end, wb + FACT_REF_TOLERANCE);
    let hit = false;
    for (let line = winA; line <= winB && !hit; line++) {
      const raw = windowSeg.lines[line - windowSeg.start];
      if (raw === undefined) continue;
      const tok = tokens.find((t) => raw.includes(t));
      if (tok) {
        hit = true;
        hitToken ??= tok;
      }
    }
    windowHits.push(hit);
  }
  if (tokens.length === 0) {
    return { text: fact, file: fileDisplay, a: lo, b: hi, status: "无标识符" };
  }
  if (windowHits.every((h) => h)) {
    return { text: fact, file: fileDisplay, a: lo, b: hi, status: "相符", token: hitToken };
  }
  if (windowHits.some((h) => h)) {
    // 枚举里一部分行号命中、一部分没有：不机械判死，交 Jev。
    return { text: fact, file: fileDisplay, a: lo, b: hi, status: "待核", token: hitToken };
  }

  // 所有窗口都未命中：同文件全部段按最长 token 找唯一命中行（越长越不会撞）。只有**单窗口**引用才校正——
  // 枚举/多窗口整体错位没法用一个新行号改写（PiMoa 复审 P1/F2），唯一命中也只记待核交 Jev。
  for (const tok of byLen) {
    const hits: number[] = [];
    for (const s of segs) {
      for (let i = 0; i < s.lines.length; i++) {
        if ((s.lines[i] as string).includes(tok)) hits.push(s.start + i);
      }
    }
    if (hits.length === 1) {
      if (parsed.windows.length > 1) return { text: fact, file: fileDisplay, a: lo, b: hi, status: "待核", token: tok };
      const L = hits[0] as number;
      const originalLine = lo === hi ? `${lo}` : `${lo}-${hi}`;
      return { text: fact, file: fileDisplay, a: L, b: L, status: "已校正", token: tok, originalLine, rewritten: rewriteFactLine(fact, L) };
    }
    if (hits.length > 1) {
      return { text: fact, file: fileDisplay, a: lo, b: hi, status: "待核", token: tok };
    }
  }
  // 抽出的 token 在窗口与全文件都零命中：真正的引用错误，不问 Jev 也能判（§12.2 C）。
  return { text: fact, file: fileDisplay, a: lo, b: hi, status: "未命中", token: byLen[0] };
}

/** 相符/已校正事实引用行的 [min,max]（三路互验第三路；无可核事实时返回 undefined）。 */
export function computeFactsRange(factRefs: readonly FactRef[]): [number, number] | undefined {
  const q = factRefs.filter((fr) => fr.status === "相符" || fr.status === "已校正");
  if (q.length === 0) return undefined;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const fr of q) {
    lo = Math.min(lo, fr.a);
    hi = Math.max(hi, fr.b);
  }
  return [lo, hi];
}

function parseLines(lines: string): { a: number; b: number } | null {
  const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(lines.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { a, b };
}

/** 材料里前 5 个不同的 rel（REJECT 文案「可用：…」）。 */
function availableRels(materials: MaterialMap): string {
  const rels: string[] = [];
  for (const segs of materials.values()) {
    for (const s of segs) {
      if (!rels.includes(s.rel)) rels.push(s.rel);
      if (rels.length >= 5) break;
    }
    if (rels.length >= 5) break;
  }
  return rels.join("、");
}

/** facts 的推论词 / 行号规则（submit 与 amend 共用）。 */
function validateFacts(id: string, facts: readonly string[]): string[] {
  const errs: string[] = [];
  facts.forEach((fact, i) => {
    const k = i + 1;
    const kind = factKind(fact);
    // REJECT 文案带被拒事实原文（截 60 字）：模型改起来有靶子，人在 spool 里也能看出规则是否误伤。
    const excerpt = fact.length > 60 ? `${fact.slice(0, 60)}…` : fact;
    if (kind !== "condition") {
      const m = INFERENCE_WORDS.exec(fact);
      if (m) errs.push(`${id}：第 ${k} 条含推论词「${m[1]}」，事实只写代码怎么写的或通用规范，推论放进 claim（原文：${excerpt}）`);
    }
    if (kind === "code" && !LINE_REF.test(fact)) {
      errs.push(`${id}：第 ${k} 条代码事实没有行号；通用事实请以「通用事实：」开头，环境条件请以「运行时条件：」开头（原文：${excerpt}）`);
    }
  });
  return errs;
}

/**
 * chain 形状机械校验（B1：步数上下限、id 非空、kind 闭集、text 8–480 字；与 schema 同界）：
 * 返回 REJECT 文案（空数组 = 合格），submit 与 amend 共用。`minSteps`——submit 全链 2–6，
 * amend 只补增补步、1 步即合法（见 AmendFactsParams.chain 注）。
 * FB-11：① 步 id 在同一 finding 内唯一（重复 REJECT）；② from/to 提供时必须指向存在的步 id 且
 * 禁止自指（违者 REJECT；from/to 均缺失只登记警示，见 `chainLinkNotes`）；③ `baseSteps`——amend
 * 场景传入既有链长，补链后累计全链 ≤ maxSteps（与全链 2–6 不变量一致，超出 REJECT 并说明当前累计），
 * 缺省 0 不核累计（submit 侧全链本身已受 maxSteps 约束）。
 */
export function validateChainSteps(id: string, chain: readonly ChainStep[], minSteps: number = CHAIN_LIMITS.minSteps, baseSteps: number = 0): string[] {
  const errs: string[] = [];
  const L = CHAIN_LIMITS;
  if (chain.length < minSteps || chain.length > L.maxSteps) {
    errs.push(`${id}：chain 须 ${minSteps}–${L.maxSteps} 步（现 ${chain.length} 步）`);
  }
  // FB-11③：补链后累计全链 ≤ maxSteps（amend 单次增补 1–6 的语义不变，超限 REJECT 并说明当前累计）。
  if (baseSteps > 0 && baseSteps + chain.length > L.maxSteps) {
    errs.push(`${id}：补链后全链累计 ${baseSteps + chain.length} 步，超过全链上限 ${L.maxSteps} 步（原 ${baseSteps} 步 + 本次 ${chain.length} 步）`);
  }
  const seenIds = new Set<string>();
  chain.forEach((s, i) => {
    const k = i + 1;
    if (typeof s.id !== "string" || s.id.trim() === "") errs.push(`${id}：chain 第 ${k} 步缺 id（c1、c2…）`);
    // FB-11①：步 id 在同一 finding 内唯一。
    else if (seenIds.has(s.id)) errs.push(`${id}：chain 第 ${k} 步（${s.id}）id 重复，同一 chain 内 id 须唯一`);
    else seenIds.add(s.id);
    if (s.kind !== "link" && s.kind !== "absence" && s.kind !== "runtime") {
      errs.push(`${id}：chain 第 ${k} 步（${s.id || k}）kind 须为 link / absence / runtime`);
    }
    if (typeof s.text !== "string" || s.text.length < L.textMin || s.text.length > L.textMax) {
      errs.push(`${id}：chain 第 ${k} 步（${s.id || k}）text 须 ${L.textMin}–${L.textMax} 字（现 ${typeof s.text === "string" ? s.text.length : 0} 字）`);
    }
    // FB-11②：from/to 提供时必须指向存在的步 id，且禁止自指。
    for (const end of ["from", "to"] as const) {
      const v = s[end];
      if (typeof v !== "string" || v.trim() === "") continue;
      if (v === s.id) errs.push(`${id}：chain 第 ${k} 步（${s.id || k}）${end}「${v}」不得自指`);
      else if (!chain.some((o) => o.id === v)) errs.push(`${id}：chain 第 ${k} 步（${s.id || k}）${end}「${v}」指向不存在的步 id`);
    }
  });
  return errs;
}

/**
 * B1 执法②（**与 anchor 执法同风格：登记警示、不 REJECT**）：kind=absence 的 chain 步主语必须含
 * identifier token（≥3 字、剥路径）——这是机械佐证可核的前提（设计 §B1；实测无 token 的文档类
 * absence 步只能降级）。token 卫生与 mech.ts 形态②同一套（mechTokens）；路径片段先剥（灰度第 6 轮：
 * 文件名 stem 不当标识符）。返回登记文案（空数组 = 无不符）。
 */
export function chainSubjectNotes(id: string, chain: readonly ChainStep[] | undefined): string[] {
  const notes: string[] = [];
  for (const s of chain ?? []) {
    if (s.kind !== "absence") continue;
    const tokens = mechTokens(absenceSubject(s.text ?? "").replace(FACT_PATH_LIKE, " "));
    if (tokens.length === 0) {
      notes.push(`${id}：chain 步 ${s.id}（absence）主语没有 identifier token（≥3 字、剥路径），机械佐证只能拒核降级`);
    }
  }
  return notes;
}

/**
 * B1 执法①配套（FB-10，**与执法②同风格：登记警示、不 REJECT**）：kind=link 的 chain 步 **from/to
 * 均缺失**时登记——因果两端都没串出的 link 步归属不明，机械与人工都难复核（from/to 提供但指向
 * 非法时是 REJECT，见 `validateChainSteps` FB-11②）。返回登记文案（空数组 = 无）。
 */
export function chainLinkNotes(id: string, chain: readonly ChainStep[] | undefined): string[] {
  const notes: string[] = [];
  for (const s of chain ?? []) {
    if (s.kind !== "link") continue;
    const hasFrom = typeof s.from === "string" && s.from.trim() !== "";
    const hasTo = typeof s.to === "string" && s.to.trim() !== "";
    if (!hasFrom && !hasTo) {
      notes.push(`${id}：chain 步 ${s.id}（link）from/to 均缺失，因果两端未串出（from/to 请指向步 id）`);
    }
  }
  return notes;
}

/**
 * 单条 finding 的全部规则（设计 v4 §3.2 表；文案逐字）。返回该条的全部不合格原因（空数组 = 合格）。
 * id 重复、findings 为空数组无 no_findings_reason 属跨条/跨参规则，由处理器检查。
 * ★anchor 定位**不在此列**（设计 v4 §3.2「anchor 定位（不 REJECT）」行）：四种状态都不是 REJECT 理由，
 * 只登记状态，见 `anchorHit`——只有 path 未附入材料、行号越界/跨度超限才 REJECT。
 * ★B1 chain 执法（设计 §B1，波2）：**灰度缝**——仅当 `opts.enforceChain`（波4 C1 接 config
 * `jevcheck.chain.enabled`）打开、**或**该条自带 `chain` 字段（用了新载体就按新契约执法）时才进入
 * chain 形态；缺省路径一字不改（设计 §5/§7.3「chain.enabled=false ⇒ 与现行为逐字节等价」，
 * test/submit_findings.test.ts「基线 finding 合格（零错误）」等既有基线断言照旧成立）。
 */
export function validateFinding(
  f: Finding,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  opts?: { enforceChain?: boolean; categoryEnabled?: boolean; quoteEnabled?: boolean; quoteRequired?: boolean },
): string[] {
  const errs: string[] = [];
  const id = f.id;
  // The TypeBox layer rejects malformed enum before execute and does not count attempts.
  // Repeat this validation inside the handler for human-readable, attempt-counted rejection.
  if (opts?.categoryEnabled && f.category !== undefined && !FINDING_CATEGORIES.includes(f.category)) {
    errs.push(`${id}：category 值无效；只允许 ${FINDING_CATEGORIES.join(" / ")}`);
  }
  if (opts?.quoteEnabled) {
    const quotes: unknown = f.factQuotes;
    if (quotes === undefined) {
      if (opts.quoteRequired) errs.push(`${id}：缺少必填 factQuotes；请按 facts 下标提交逐字抄录的材料原文行`);
    } else if (!Array.isArray(quotes)) {
      errs.push(`${id}：factQuotes 须为字符串数组（按 facts 下标对齐）`);
    } else {
      if (quotes.length > f.facts.length) errs.push(`${id}：factQuotes 条数 ${quotes.length} 不得超过 facts 条数 ${f.facts.length}`);
      for (const [i, quote] of quotes.entries()) {
        if (typeof quote !== "string" || quote.trim().length === 0) errs.push(`${id}：factQuotes 第 ${i + 1} 项须为非空字符串材料原文行`);
      }
    }
  }
  const kind = f.kind ?? "finding";

  // 长度 / 条数上限（处理器层用人话拒并计次；schema 只兜底）。
  const L = FINDING_LIMITS;
  if (f.anchor.length > L.anchorMax) {
    errs.push(`${id}：anchor 超过 ${L.anchorMax} 字（${f.anchor.length} 字）。anchor 是从引用行里**逐字抄**的一个短片段（函数名、变量名、字符串常量），不是对缺陷的描述句（原文：${f.anchor.slice(0, 60)}…）`);
  }
  if (f.facts.length < L.factsMin || f.facts.length > L.factsMax) {
    errs.push(`${id}：facts 须 ${L.factsMin}–${L.factsMax} 条（现 ${f.facts.length} 条）`);
  }
  f.facts.forEach((fact, i) => {
    if (fact.length > L.factMax) errs.push(`${id}：第 ${i + 1} 条事实超过 ${L.factMax} 字（${fact.length} 字），拆成多条或去掉推演（原文：${fact.slice(0, 60)}…）`);
  });
  if (f.claim.length > L.claimMax) errs.push(`${id}：claim 超过 ${L.claimMax} 字（${f.claim.length} 字），一句话写缺陷是什么 + 失败场景是什么`);
  if (f.fix_expect.length > L.fixExpectMax) errs.push(`${id}：fix_expect 超过 ${L.fixExpectMax} 字（${f.fix_expect.length} 字），一句话写修好需要包含的处理`);

  const segs = resolveMaterial(f.path, materials, cwd, readRoots);
  if (!segs) {
    errs.push(`${id}：路径「${f.path}」不在本轮附入材料里；可用：${availableRels(materials)}`);
  } else {
    const ranges = segs.map((s) => `${s.start}-${s.end}`).join("、");
    const ab = parseLines(f.lines);
    if (!ab || ab.a > ab.b || ab.b - ab.a > MAX_LINE_SPAN || !segmentContaining(segs, ab.a, ab.b)) {
      const shown = ab ?? { a: f.lines, b: f.lines };
      errs.push(`${id}：行号 ${shown.a}-${shown.b} 越界或跨度超 ${MAX_LINE_SPAN}（该文件附入区间：${ranges}）`);
    }
  }

  errs.push(...validateFacts(id, f.facts));

  if (kind === "finding" && NEGATED_CLAIM_RE.test(f.claim)) {
    errs.push(`${id}：claim 写成了「不成立」；要声明某处不存在缺陷请用 kind:"counter"`);
  }
  if (kind === "counter" && f.level !== "COUNTER") {
    errs.push(`${id}：counter 条目的 level 须为 COUNTER`);
  }

  // ---- B1 chain 执法（设计稿 §B1；灰度缝见本函数头注）----
  const chain = f.chain;
  if (opts?.enforceChain === true || chain !== undefined) {
    // ⓪ kind=finding 必填（counter 可空）。
    if (kind === "finding" && (!chain || chain.length === 0)) {
      errs.push(`${id}：kind=finding 必须给 chain（2–6 步：kind=link|absence|runtime），失败场景由 chain 显式串出；kind=counter 不用给`);
    }
    if (chain && chain.length > 0) errs.push(...validateChainSteps(id, chain));
    // ①（同推论词执法先例，REJECT）：claim 含因果连词而 chain 没有对应 link 步。
    // FB-10：「对应 link 步」= kind:"link" **且其 text 里也有因果连词**——空壳 link（text 无因果词）不算数。
    if (kind === "finding") {
      const m = CAUSAL_WORDS.exec(f.claim);
      const hasCausalLink = (chain ?? []).some((s) => s.kind === "link" && CAUSAL_WORDS.test(s.text));
      if (m && !hasCausalLink) {
        const excerpt = f.claim.length > 60 ? `${f.claim.slice(0, 60)}…` : f.claim;
        errs.push(`${id}：claim 含因果连词「${m[1]}」而 chain 没有对应 link 步（link 步 text 里也要有因果连词才算对应）；把因果推断拆成 chain 的 kind:"link" 步（from→to 串出前因后果），claim 只写缺陷与失败场景（原文：${excerpt}）`);
      }
    }
  }
  return errs;
}

/**
 * anchor 定位（设计 v4 §3.2）：只在处理器确认 path/lines 均合法（validateFinding 对该条无 REJECT
 * 错误）后才有意义地调用；path 未附入或行号非法时返回 null（前置条件不满足）。
 */
export function checkAnchor(
  f: Finding,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
): AnchorCheck | null {
  const segs = resolveMaterial(f.path, materials, cwd, readRoots);
  if (!segs) return null;
  const ab = parseLines(f.lines);
  if (!ab || ab.a > ab.b || ab.b - ab.a > MAX_LINE_SPAN || !segmentContaining(segs, ab.a, ab.b)) return null;
  return anchorHit(f.anchor, segs, ab.a, ab.b);
}

// ---- 工具工厂 ----

function textResult(text: string, details: Record<string, unknown>, isError: boolean) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

/**
 * `submit_findings` 工厂：每个 proposer 会话一份 state（闭包持有）。
 * limits.maxAttempts = 提交次数上限；limits.required = 硬门（达到上限时文案「按失败处理」，缺省软档「按未结构化处理」）。
 */
export function createSubmitFindingsTool(
  state: FindingsState,
  materials: MaterialMap,
  cwd: string,
  readRoots: readonly string[],
  limits: { maxAttempts: number; required?: boolean; enforceChain?: boolean; categoryEnabled?: boolean; quoteEnabled?: boolean; quoteRequired?: boolean },
): ToolDef {
  const max = Math.max(1, Math.floor(limits.maxAttempts));
  return defineTool({
    name: "submit_findings",
    label: "Submit findings (structured)",
    description:
      "提交本次审查的结构化清单（verify 模式必须调用）。每条：id（F1、F2…）、kind（finding / counter）、level、" +
      "path + lines（只能引用本轮附入材料与真实行号）、anchor（该位置一个不超过 160 字的有辨识度片段，如函数名/" +
      "变量名/字符串常量，不是整行原文）、" +
      "facts（3–8 条事实：代码事实带「文件名 第 N 行」或「第 X 节」；通用规范以「通用事实：」开头；" +
      "环境条件以「运行时条件：」开头；不得写推论句）、claim、fix_expect、strength、" +
      "chain（kind=finding 必填 2–6 步：link=因果推断步 / absence=存在性断言 / runtime=运行时条件；" +
      "kind=counter 不用给；claim 含因果连词时必须有对应 link 步）。" +
      (limits.categoryEnabled ? "category 可选：fake-green / wiring / hardcode / overdesign / behavior，缺省 behavior；标注前四类才触发分类电池。" : "") +
      (limits.quoteEnabled ? `factQuotes ${limits.quoteRequired ? "必填" : "可选"}：按 facts 下标对齐，逐字抄录本轮材料裸行（去首尾空白），每项非空，条数不超过 facts；匹配不到或歧义只记待核，不作编造断言。` : "") +
      `不合格会被拒绝并逐条告知原因，按原因修改后再提交，最多 ${max} 次。确无发现时提交空数组并填 no_findings_reason。` +
      RAW_JSON_ARGS_NOTE,
    promptSnippet:
      "submit_findings: 提交结构化审查清单（path/lines/anchor 机械核验；不合格逐条回贴原因，最多重提 " + max + " 次）" +
      (limits.quoteEnabled ? `；factQuotes ${limits.quoteRequired ? "必填" : "可选"}，按 facts 下标抄录材料整行原文（trim 后逐字匹配）` : ""),
    parameters: submitFindingsParams(limits.categoryEnabled, limits.quoteEnabled),
    execute: async (_toolCallId: string, params: SubmitFindingsInput) => {
      state.attempts += 1;
      const n = state.attempts;
      if (n > max) {
        const text = `REJECT（第 ${n}/${max} 次）：\n- 已超过提交次数上限 ${max}，本次不再受理`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts: n, overLimit: true }, true);
      }
      // 空清单必须填 no_findings_reason（设计 v4 §3.2 表；独立于逐条 validateFinding，先查）。
      if (params.findings.length === 0 && !params.no_findings_reason) {
        const text = `REJECT（第 ${n}/${max} 次）：\n- 空清单必须填 no_findings_reason`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts: n, errors: 1 }, true);
      }
      const allFindings: Finding[] = params.findings.map((f) => {
        const copy = { ...f, kind: f.kind ?? "finding" };
        if (!limits.categoryEnabled) delete copy.category;
        if (!limits.quoteEnabled) delete copy.factQuotes;
        return copy;
      });
      const errs: string[] = [];
      const errsById = new Map<string, string[]>();
      const seen = new Set<string>();
      for (const f of allFindings) {
        const mine: string[] = [];
        if (seen.has(f.id)) mine.push(`发现 id 重复：${f.id}`);
        seen.add(f.id);
        mine.push(...validateFinding(f, materials, cwd, readRoots, { enforceChain: limits.enforceChain === true, categoryEnabled: limits.categoryEnabled === true, quoteEnabled: limits.quoteEnabled === true, quoteRequired: limits.quoteRequired === true }));
        if (mine.length > 0) errsById.set(f.id, [...(errsById.get(f.id) ?? []), ...mine]);
        errs.push(...mine);
      }
      // 最后一次提交只剩个别条目不合格时接受合格子集（徐总 2026-09-20 定）：硬门的目的是逼出合格清单，
      // 不是让一条格式错废掉整轮。丢弃的条目登记在 state.dropped 与回执文案里；全部不合格仍 REJECT。
      let findings = allFindings;
      const droppedNotes: string[] = [];
      if (errs.length > 0) {
        const valid = allFindings.filter((f) => !errsById.has(f.id));
        const finalAttempt = n >= max;
        if (!finalAttempt || valid.length === 0) {
          const shown = errs.slice(0, MAX_REJECT_ITEMS);
          let text = `REJECT（第 ${n}/${max} 次）：\n- ${shown.join("\n- ")}`;
          if (errs.length > shown.length) text += `\n（另有 ${errs.length - shown.length} 条未列出）`;
          if (finalAttempt) text += `\n已达上限，本次审查将按${limits.required ? "失败" : "未结构化"}处理`;
          state.rejects.push(text);
          return textResult(text, { accepted: false, attempts: n, errors: errs.length }, true);
        }
        findings = valid;
        const dropped = allFindings.filter((f) => errsById.has(f.id));
        state.dropped = dropped.map((f) => ({ id: f.id, errors: errsById.get(f.id) ?? [] }));
        for (const d of state.dropped) droppedNotes.push(`${d.id} 因校验未过被丢弃：${d.errors.join("；")}`);
        state.rejects.push(`PARTIAL（第 ${n}/${max} 次）：接受 ${valid.length} 条，丢弃 ${dropped.length} 条\n- ${droppedNotes.join("\n- ")}`);
      }

      // anchor 定位不 REJECT（设计 v4 §3.2 优化 6）：登记 refs 状态；「行号已校正」时把该条的 lines
      // 就地校正为命中行（保持原跨度），供下游（jevcheck）用正确位置；回执文案逐条附提示。
      // ★2026-09-20 徐总追加裁定（覆盖任务书原「lines/anchor 可选」条，见设计 v4 §12.6 第 2 点改写版）：
      //   lines/anchor 照旧必填，「行号已校正」的现行校正规则**不变**（无条件校正，不受 facts 门控——
      //   设计原文只列了三路互验的**登记**效果：refConsistency 字段 / FindingCheck.ref 归档 / 核对表
      //   标注，从未提"不一致就不校正"；门控校正会让本就存在的 anchor-only 单测集体失真，超出裁定范围）。
      //   新增事实引用行三路互验（lines / anchorLine / factsRange）：每条 code 事实先过 checkFactRef
      //   （§12.2 A），结果登记进 state.factRefs；再据此与 anchorHit 结果比对，算出 refConsistency
      //   作为**附加**登记信息（不改变 corrected/lines 的既有产出），供 aggregator 侧 table_handling 兜底。
      const refNotes: string[] = [];
      const corrected: Finding[] = [];
      for (const f of findings) {
        const segs = resolveMaterial(f.path, materials, cwd, readRoots) ?? [];
        const ab = parseLines(f.lines) as { a: number; b: number }; // 已过 validateFinding，必合法
        const rel = segs[0]?.rel ?? f.path;

        // ---- 事实级机械校验（§12.2 A）：仅 code 类事实过 checkFactRef ----
        const codeFacts = f.facts.filter((x) => factKind(x) === "code");
        const factRefsForFinding = codeFacts.map((fact) => checkFactRef(fact, f.path, materials, cwd, readRoots));
        state.factRefs.set(f.id, factRefsForFinding);
        const factsRange = computeFactsRange(factRefsForFinding);

        const hit = anchorHit(f.anchor, segs, ab.a, ab.b);

        // ---- 三路互验（徐总 09-20 追加裁定）：纯登记，不影响下方既有校正分支 ----
        let refConsistency: "一致" | "不一致" | "仅两路";
        if (!factsRange) {
          refConsistency = "仅两路";
        } else {
          const anchorInLines = hit.status === "OK";
          const linesOverlapFacts = factsRange[1] >= ab.a - FACT_REF_TOLERANCE && factsRange[0] <= ab.b + FACT_REF_TOLERANCE;
          const anchorLine = hit.line;
          const anchorMatchesFacts =
            anchorLine !== undefined &&
            anchorLine >= factsRange[0] - FACT_REF_TOLERANCE &&
            anchorLine <= factsRange[1] + FACT_REF_TOLERANCE;
          if (anchorInLines && linesOverlapFacts) {
            refConsistency = "一致";
          } else if (hit.status === "行号已校正" && anchorMatchesFacts) {
            refConsistency = "一致";
            refNotes.push(`${f.id}：lines 已按 anchor 与事实校正`);
          } else {
            refConsistency = "不一致";
            refNotes.push(
              `${f.id}：引用不一致（lines ${f.lines} / anchor ${anchorLine ?? "未命中"} / 事实 ${factsRange[0]}-${factsRange[1]}），请复核`,
            );
          }
        }

        if (hit.status === "OK") {
          state.refs.set(f.id, {
            status: "OK",
            ...(hit.line !== undefined ? { line: hit.line, anchorLine: hit.line } : {}),
            ...(hit.via ? { via: hit.via, token: hit.token } : {}),
            ...(factsRange ? { factsRange } : {}),
            refConsistency,
          });
          if (hit.via === "标识符") refNotes.push(`${f.id}：锚点整句未在第 ${ab.a}-${ab.b} 行原样出现，按其中的标识符「${hit.token}」命中；anchor 请直接抄代码片段`);
          corrected.push(f);
        } else if (hit.status === "行号已校正" && hit.line !== undefined) {
          const span = ab.b - ab.a;
          const newA = hit.line;
          // 保持原跨度外推；跨度越出命中行所在段的段末时截到段末（设计 v4 §3.2）——
          // 校正后的 lines 必须仍落在已附入材料内，否则下游 jevcheck 会按未附入的行号切片。
          const home = segs.find((s) => s.start <= newA && newA <= s.end);
          const newB = home && newA + span > home.end ? home.end : newA + span;
          state.refs.set(f.id, {
            status: "行号已校正",
            line: hit.line,
            anchorLine: hit.line,
            originalLines: f.lines,
            ...(factsRange ? { factsRange } : {}),
            refConsistency,
          });
          refNotes.push(`${f.id}：锚点在第 ${hit.line} 行而非第 ${ab.a}-${ab.b} 行，已校正`);
          corrected.push({ ...f, lines: newB === newA ? `${newA}` : `${newA}-${newB}` });
        } else if (hit.status === "锚点不唯一") {
          state.refs.set(f.id, {
            status: "锚点不唯一",
            ...(factsRange ? { factsRange } : {}),
            refConsistency,
          });
          refNotes.push(`${f.id}：锚点在文件里多处出现，未校正，请用更有辨识度的片段`);
          corrected.push(f);
        } else {
          state.refs.set(f.id, {
            status: "锚点未命中",
            ...(factsRange ? { factsRange } : {}),
            refConsistency,
          });
          refNotes.push(`${f.id}：锚点「${f.anchor}」在 ${rel} 里找不到，已登记`);
          corrected.push(f);
        }
        // ---- B1 执法②登记（不 REJECT，与 anchor 执法同风格）：absence 步主语 identifier token 卫生 ----
        refNotes.push(...chainSubjectNotes(f.id, f.chain));
        // FB-10：link 步 from/to 均缺失登记警示（不 REJECT，与执法②同风格）。
        refNotes.push(...chainLinkNotes(f.id, f.chain));
      }
      state.accepted = corrected;

      const items = corrected.map((f) => {
        const segs = resolveMaterial(f.path, materials, cwd, readRoots);
        const rel = segs?.[0]?.rel ?? f.path;
        return `${f.id} ${f.level} ${rel}:${f.lines}`;
      });
      let text =
        corrected.length === 0
          ? `已接受 0 条${params.no_findings_reason ? `（无发现：${params.no_findings_reason}）` : ""}`
          : `已接受 ${corrected.length} 条：${items.join("；")}`;
      if (droppedNotes.length > 0) text += `\n${droppedNotes.join("\n")}`;
      if (refNotes.length > 0) text += `\n${refNotes.join("\n")}`;
      return textResult(text, { accepted: true, attempts: n, count: corrected.length, dropped: droppedNotes.length }, false);
      // ★绝不设 addedToolNames（防孙 agent 不变量）。
    },
  });
}

/**
 * `amend_facts` 工厂：补前提短会话专用，只处理 target.id 这一条。
 * facts 过推论词 / 行号规则；合格写 **独立的** `AmendState.accepted`（不共享 proposer 的 FindingsState，
 * 设计 v4 §3.2/§3.3）；attempts / rejects 与 execute 的每次调用是**同一个 state 对象**（供编排层/测试核对
 * 一致性）；最多 AMEND_MAX_ATTEMPTS 次。
 * `target.path`（波四新增，设计原文签名只有 `{id}`）：补充事实同样要过 `checkFactRef`（任务书第 1 点
 * 「amend_facts 补的事实同样过一遍」），而 `checkFactRef` 消歧多候选文件时需要 finding 自己的 path——
 * 原签名没带，调用方（jevcheck.ts premiseRound）本就持有该 finding 的 `FindingRecord.path`，据实施任务书
 * 「按设计选一种并说明」追加此字段，在此登记。
 * `target.baseChain`（FB-11③）：该 finding 的既有 chain，供「补链后累计全链 ≤6」执法用（不传则不核累计）。
 */
export function createAmendFactsTool(
  state: AmendState,
  materials: MaterialMap,
  target: { id: string; path: string; baseChain?: readonly ChainStep[] },
  cwd: string,
  readRoots: readonly string[],
): ToolDef {
  return defineTool({
    name: "amend_facts",
    label: "Amend facts (premise round)",
    description:
      `补充 ${target.id} 缺失的事实前提（最多 4 条）：代码事实带行号；通用事实以「通用事实：」开头；` +
      "环境条件以「运行时条件：」开头且如实写成条件。也可给 chain 增补步（1–6 步，形状同 submit_findings）。" +
      "补不出来就 facts=[] 并填 cannot_amend_reason。只处理这一条。" +
      RAW_JSON_ARGS_NOTE,
    promptSnippet: `amend_facts: 只为 ${target.id} 补充事实前提（≤4 条；推论词 / 无行号会被拒）`,
    parameters: AmendFactsParams,
    execute: async (_toolCallId: string, params: AmendFactsInput) => {
      state.attempts += 1;
      const attempts = state.attempts;
      if (params.id !== target.id) {
        // ★2026-09-27 徐总裁定（批次 1 fix 批 F1）：错 target 原文案用全角冒号「REJECT：」，不命中会话层
        //   classifyStructuredToolEnd 的「REJECT（」前缀 → 被误记为 schema 拒、进 DEF-10 连续计次 → 改用「REJECT（」
        //   与判定前缀对齐 → 边界：只改前缀标点，业务语义（计 attempts、wrongTarget）不变。
        const text = `REJECT（本会话只处理 ${target.id}，收到 ${params.id}）`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts, wrongTarget: true }, true);
      }
      if (attempts > AMEND_MAX_ATTEMPTS) {
        const text = `REJECT（第 ${attempts}/${AMEND_MAX_ATTEMPTS} 次）：\n- 已超过提交次数上限 ${AMEND_MAX_ATTEMPTS}，本次不再受理`;
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts, overLimit: true }, true);
      }
      // B1（设计 §B1 末条）：chain 增补步同过形状机械校验（1–6 步），不合格同路 REJECT 并计次。
      // FB-11③：带 target.baseChain（既有链）时补链后累计全链 ≤6（超出 REJECT 并说明当前累计）。
      const errs = [
        ...validateFacts(params.id, params.facts),
        ...(params.chain && params.chain.length > 0 ? validateChainSteps(params.id, params.chain, 1, target.baseChain?.length ?? 0) : []),
      ];
      if (errs.length > 0) {
        let text = `REJECT（第 ${attempts}/${AMEND_MAX_ATTEMPTS} 次）：\n- ${errs.slice(0, MAX_REJECT_ITEMS).join("\n- ")}`;
        if (attempts >= AMEND_MAX_ATTEMPTS) text += "\n已达上限，该条按未补充处理";
        state.rejects.push(text);
        return textResult(text, { accepted: false, attempts, errors: errs.length }, true);
      }
      state.accepted = [...params.facts];
      if (params.chain && params.chain.length > 0) state.acceptedChain = [...params.chain];
      if (params.cannot_amend_reason) state.reason = params.cannot_amend_reason;
      // 波四任务书第 1 点：amend_facts 补的事实同样过 checkFactRef（只对 code 类；结果只登记不影响
      // 本工具自身的接受/拒绝判定——事实级校验从不 REJECT，见 checkFactRef 头注）。
      const amendedCode = params.facts.filter((x) => factKind(x) === "code");
      if (amendedCode.length > 0) {
        state.factRefs = amendedCode.map((fact) => checkFactRef(fact, target.path, materials, cwd, readRoots));
      }
      // B1 执法②登记（不 REJECT）：chain 增补步里 absence 步主语的 token 卫生，同 submit 口径。
      // FB-10：link 步 from/to 均缺失登记警示，同 submit 口径。
      const chainNotes = [...chainSubjectNotes(params.id, params.chain), ...chainLinkNotes(params.id, params.chain)];
      let text =
        params.facts.length === 0
          ? `已记录 ${params.id} 无法补充${params.cannot_amend_reason ? `：${params.cannot_amend_reason}` : ""}`
          : `已为 ${params.id} 补充 ${params.facts.length} 条前提`;
      if (chainNotes.length > 0) text += `\n${chainNotes.join("\n")}`;
      return textResult(text, { accepted: true, attempts, count: params.facts.length }, false);
      // ★绝不设 addedToolNames（防孙 agent 不变量）。
    },
  });
}
