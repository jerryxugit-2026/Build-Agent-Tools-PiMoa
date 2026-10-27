/**
 * `mech.ts` —— B3 机械佐证层（设计稿 `<workspace>/artifacts/jevcheck-finding-truth-design-20260922/DESIGN-jevcheck-finding-truth.md` §B3 + §4.8 封闭形态原则，波2）。
 *
 * 语义真源 = 差分蓝本 `<workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs`
 * 的 `mechCheck` v2（OLD/NEW 差分探针 11/11 验证；探针脚本
 * `<workspace>/artifacts/jev-finding-truth-20260922/tools/diff-probe.mjs` 的 P1–P8 即单测蓝本）。
 * 本文件逐分支照搬该语义，**不为任何单个用例加识别分支**。
 * delta（`mech-rules/v1` 语义增强）：存在性命中改标识符边界感知匹配（FB-12）——差分蓝本 v1 实测 0 误杀，
 * 本加固为纵深防御（防长标识符吞短 probe 的假证伪）；蓝本文件不动。
 *
 * ## 封闭形态原则（§4.8 硬约束——只认下面两种形态，其余一律 `checkable:false` 拒核）
 * 1. **行文断言**：「第 N 行…[是为:：]…『q』」同一子句内的**行号-引号绑定**（谓词两侧各 ≤30 字绑定出现）；
 *    独立引号一律不用（防 R1-1 假机械证伪）；行号在 material 命中 0 段记「行缺失」、≥2 段判**歧义拒核**
 *    （防 R1-2 取错段）；单段命中时引文不在该行 ⇒ 证伪方向成立。
 * 2. **存在性断言**：`(不存在|没有|未|无)<主语>(判断|比较|校验|检查|保护|分支|Close|return|计数|串行化|跳过)`——
 *    从主语抽 identifier **最长** token（≥3 字、剥 "/" 路径、停用词表），限定引用行 ±20 内搜
 *    （防 R1-3 全文误命中）；作用域内含该 token ⇒ 证伪方向成立（"说不存在、其实存在"）。
 *
 * 输出 `{checkable, refuted, note}`，note 带 token 来源；**只在证伪方向使用，永不用于背书**
 * （实测 link 证成 1/9 vs 证伪 6/7 的不对称，设计 §5「无 certify 线」）。
 * 新形态只能走设计修订（改设计稿 + 过 doc-review），不能在现场打补丁——CJK 纯文字断言拒核维持。
 * 与 `checkFactRef` 分工：后者答「引用可定位吗」（提交期），mechCorroborate 答「材料是否反驳这一步」（判定期）。
 */

/** B3 机械佐证的输入：只要求 text（chain 步 / 事实文本均可）。 */
export interface MechStep {
  text: string;
}

/**
 * mechCorroborate 的结果：`checkable:false` 即拒核（不佐证也不证伪，交上层降级）。
 * `reason`（设计稿 §4 B3 输出形状 + 波3 裁决 2026-09-22 补齐到设计形状）：拒核时区分
 * `"locate-miss"`（行号缺失/多命中歧义——步定位失败，B4 归 INSUFFICIENT「依据不足」档）与
 * `"unform"`（形态闭集外/无 identifier token——B4 走 DOWNGRADE「因果存疑」无佐证路径）。
 * 正常完成形态①②核对（`checkable:true`）时**省略**该字段（沿「缺数据省略」纪律）；
 * `note` 保持人读文案不变（既有断言按蓝本文案逐字锁定）。
 */
export interface MechResult {
  checkable: boolean;
  refuted: boolean;
  reason?: "unform" | "locate-miss";
  note: string;
}

/** 形态②的停用词表（差分蓝本逐字）。 */
const MECH_STOPWORDS = /^(the|and|for|with|that|this|from|into|not|none|true|false|null)$/i;

/**
 * identifier token 抽取（差分蓝本形态②逐字）：`[A-Za-z_][A-Za-z0-9_.]{2,}`（≥3 字、允许 `.` 连接），
 * 剥路径（含 `/` 的一律不要）、剥停用词。B1 执法②（absence 步主语 token 卫生）与形态②共用这一套词表。
 */
export function mechTokens(text: string): string[] {
  return (text.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) ?? []).filter((tok) => !tok.includes("/") && !MECH_STOPWORDS.test(tok));
}

/**
 * absence 步的主语区（存在性形态 `(不存在|没有|未|无)<主语>(判断|比较|校验|检查|保护|分支|Close|return|计数|串行化|跳过)`）。
 * 抽不出该形态时返回整句——B1 执法②对**行文形态**的 absence 步（如「第 N 行是『…』」）按整句抽 token，
 * 避免把可核的行文步误登记成「无 token」。
 */
export function absenceSubject(text: string): string {
  // FB-13②：主语窗排除 \r\n（跨行不拼接主语；与 mechCorroborate 内同形正则同步改）。
  const m = text.match(/(不存在|没有|未|无)([^。；\r\n]{2,60}?)(判断|比较|校验|检查|保护|分支|Close|return|计数|串行化|跳过)/);
  return m ? ((m[2] as string) ?? "") : text;
}

/** 存在性断言的作用域 pad（设计 §5 `mech.scopePad`，差分蓝本 ±20）。 */
const MECH_SCOPE_PAD = 20;

/**
 * FB-12（`mech-rules/v1` 语义增强）：标识符边界感知的包含匹配——probe 前后字符不得是 `[A-Za-z0-9_]`，
 * probe 本体经 `mechTokens` 卫生（≥3 字、剥 "/" 路径、剥停用词）。防「长标识符吞短 probe」的假证伪
 * （`myapp` 不算命中 `app`）；差分蓝本 v1 用 `scope.includes(probe)`（实测 0 误杀），本加固为纵深防御。
 */
function mechHit(scope: string, probe: string): boolean {
  const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  for (let i = scope.indexOf(probe); i >= 0; i = scope.indexOf(probe, i + 1)) {
    const before = i > 0 ? scope.charAt(i - 1) : "";
    const after = scope.charAt(i + probe.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
  }
  return false;
}

/**
 * 机械佐证（B3 主入口）：语义 = 差分蓝本 `mechCheck` v2，逐分支照搬（正则、注释序、返回文案均对齐）。
 */
export function mechCorroborate(step: MechStep, material: string): MechResult {
  const t = step.text;
  // 形态① 行文断言：引号必须与「第 N 行」同一子句（谓词绑定 ≤30+30 字内出现），独立引号一律不用（R1-1）。
  // FB-13②：引文字符类排除 \r\n（多行引文不进形态①、走拒核）。
  const lineQuote = t.match(/第\s*(\d+)\s*行[^「“`]{0,30}[是为:：][^「“`]{0,30}(?:[「“]([^」”\r\n]{3,120})[」”]|`([^`\r\n]{3,120})`)/);
  // FB-14：bareLine 与 lineQuote 共用同一行号（以引号绑定到的行号为准），消「句中先出现的其它
  // 「第 N 行」否决较晚绑定」的误分流（如「第 7 行…，第 12 行是『…』」旧判不进形态①）。
  const bareLine = lineQuote ? t.match(new RegExp(`第\\s*${lineQuote[1] as string}\\s*行`)) : null;
  if (lineQuote && bareLine) {
    const ln = parseInt(lineQuote[1] as string);
    const q = lineQuote[2] ?? lineQuote[3] ?? "";
    // FB-13①：行号匹配放宽前导空白（行号仍精确带冒号）。
    const hits = material.match(new RegExp(`^\\s*${ln}: ?(.*)$`, "gm")) ?? [];
    if (hits.length === 0) return { checkable: false, refuted: false, reason: "locate-miss", note: `行缺失：第 ${ln} 行不在 material（token=行号断言）` };
    if (hits.length > 1) return { checkable: false, refuted: false, reason: "locate-miss", note: `行号歧义：第 ${ln} 行在 material 命中 ${hits.length} 段（token=行号断言）` };
    const matLine = (hits[0] as string).replace(new RegExp(`^\\s*${ln}: ?`), "");
    return {
      checkable: true,
      refuted: !matLine.includes(q),
      // FB-14：note 引文截断 24→120 字符（其余文案与差分蓝本逐字一致）。
      note: `行文核对: 第${ln}行含「${q.slice(0, 120)}」=${matLine.includes(q)}（token=行内引号，绑定抽取）`,
    };
  }
  // 形态② 存在性断言：从断言主语抽 identifier token（最长者），限定作用域搜（R1-3 + identifier token 卫生）。
  // FB-13②：主语窗排除 \r\n（与上方 absenceSubject 同形正则同步改）。
  const absM = t.match(/(不存在|没有|未|无)([^。；\r\n]{2,60}?)(判断|比较|校验|检查|保护|分支|Close|return|计数|串行化|跳过)/);
  if (absM) {
    const tokens = mechTokens((absM[2] as string) ?? "");
    const probe = tokens.sort((a, b) => b.length - a.length)[0];
    if (probe) {
      let scope = material;
      const lnM = t.match(/第\s*(\d+)\s*行/);
      if (lnM) {
        const ln = parseInt(lnM[1] as string);
        const a = Math.max(1, ln - MECH_SCOPE_PAD);
        const b = ln + MECH_SCOPE_PAD;
        scope =
          material
            .split("\n")
            .filter((l) => {
              const mm = l.match(/^(\d+):/);
              const n = mm ? parseInt(mm[1] as string) : Number.NaN;
              return n >= a && n <= b;
            })
            .join("\n") || material;
      }
      const hit = mechHit(scope, probe); // FB-12：标识符边界感知（防长标识符吞短 probe 的假证伪）
      return {
        checkable: true,
        refuted: hit,
        note: `存在性核对: 作用域内含「${probe}」=${hit}（token=identifier 最长片段${lnM ? "，域=引用行±20" : ""}）`,
      };
    }
    return { checkable: false, refuted: false, reason: "unform", note: "存在性断言无 identifier token（拒核，token 卫生）" };
  }
  return { checkable: false, refuted: false, reason: "unform", note: "不可机械核（非行文/存在性形态）" };
}
