/**
 * MoA MCP 工具核心（transport 无关，便于单测直调）。
 *
 * 职责：zod inputSchema + 工具 description（DESIGN §4 P1-2 模式语义）
 *   + 入参 → MoaRequest 构造 + runMoa 调用 + MoaResult → MCP 工具返回（§4.6 B 自描述结果）。
 * server.ts 只负责起 McpServer/stdio 与把 sendNotification 接到 onStageEvent。
 */
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { Mode, MoaConfig, ProfileName, WorkerRef } from "../config/types.js";
import type { MoaRequest, MoaResult } from "../moa/types.js";
import { runMoa, type RunSessionImpl } from "../moa/orchestrate.js";
import { atomicWriteWithVerify, DONE_MARKER_RE } from "../deliver/write.js";
import type { StageEvent } from "./events.js";

/**
 * 临时覆盖用的 worker zod —— **只收 {provider, model}，不收 profile**（DESIGN §8.2 #5 提权修复）。
 * capability profile 一律由服务端按 preset/工具钉死（见 orchestrate.runMoa 的 profile 授权），
 * 绝不接受调用方指定，否则 moa_run 可把 proposer 提成 verify-worker 拿到 bash_readonly 命令面。
 */
const workerOverrideSchema = z
  .object({
    provider: z.string().min(1).describe("providers 里的 key（如 minimax / xiaomi / cliproxy）"),
    model: z.string().min(1).describe("模型 id（如 MiniMax-M3）"),
  })
  .describe(
    "worker 覆盖：仅 {provider, model}。profile 不接受调用方指定，由服务端按 preset/工具钉死（防提权）。",
  );

/** 两个工具共享的 inputSchema（ZodRawShape，直接喂 registerTool）。 */
export const moaToolInput = {
  prompt: z.string().min(1).describe("要交给 MoA 的问题或任务（必填）"),
  context: z
    .string()
    .optional()
    .describe("可选补充上下文（贴代码/文件片段/背景），与 prompt 拼接后下发"),
  preset: z
    .string()
    .optional()
    .describe(
      "命名 preset（moa_run 默认 default；moa_verify 默认 moa_verify）。preset 决定 mode/proposers/aggregator/quorum。",
    ),
  models: z
    .array(workerOverrideSchema)
    .optional()
    .describe("临时覆盖 proposers 的 provider/model（不改配置做 A/B）；profile 仍由服务端钉死"),
  aggregator: workerOverrideSchema
    .optional()
    .describe("临时覆盖聚合器的 provider/model；profile 仍由服务端钉死"),
  cwd: z
    .string()
    .optional()
    .describe("工作目录（worktree 根，会话发现根）；缺省为 server 进程 cwd"),
};

/** worker 覆盖入参（只有 provider/model；profile 由服务端补齐/钉死）。 */
export interface WorkerOverride {
  provider: string;
  model: string;
}

/** 工具入参类型（与 moaToolInput 的 zod 形状一致；models/aggregator 不含 profile）。 */
export interface MoaToolInput {
  prompt: string;
  context?: string;
  preset?: string;
  models?: WorkerOverride[];
  aggregator?: WorkerOverride;
  cwd?: string;
}

/**
 * 覆盖入参 → WorkerRef。profile 填最保守占位（delivery-readonly-worker）——
 * orchestrate.runMoa 会按 preset/forceProfile 重新钉死并忽略此值；此处占位仅为满足契约类型，
 * 万一某路径误读也只读，双保险。
 */
const OVERRIDE_PLACEHOLDER_PROFILE: ProfileName = "delivery-readonly-worker";
function toWorkerRef(o: WorkerOverride): WorkerRef {
  return { provider: o.provider, model: o.model, profile: OVERRIDE_PLACEHOLDER_PROFILE };
}

export const MOA_RUN_DESCRIPTION =
  "多模型综合（synthesize）：并行询问 N 个独立提议模型，再由聚合器综合成一份最终结论并返回。" +
  "适用：要一个经过多视角交叉、去错去冗后的高质量答案（方案设计、代码生成、疑难分析、写作）。" +
  "行为：fail-closed —— 任一提议者失败/超时/空正文则整体失败、不产出、不降级（status:failed）。" +
  "能力边界：提议者与聚合器仅带 read/grep/find/ls 只读工具，可读取 cwd 下文件；" +
  "**不执行代码、不跑测试、不写文件**（要执行/写盘的工作请在隔离区自行跑完，把产物/日志作为 context 传入）。" +
  "只支持 synthesize preset：传入 verify 模式的 preset 会被直接拒绝（status:failed, stage:config）——" +
  "需只读验真（含沙箱 bash_readonly）请改用 moa_verify 工具，本工具「只读不执行」恒真。" +
  "返回自描述结果：status / aggregated（最终答案）/ proposals（每提议者硬状态）/ receipt（模式·配额·成本·body_sha256）/ error。";

export const MOA_VERIFY_DESCRIPTION =
  "多模型验真取证（verify，只读）：并行让 N 个模型独立核验一个论断/交付物，再由只读聚合器汇总裁决。" +
  "适用：交付前把关、审代码是否真的通过、事实核查、找漏洞与反例。" +
  "硬约束：全程只读 —— 不能执行代码、不能写文件、不能改状态（聚合器也被限为只读 profile）。" +
  "因此不要用它跑测试或复现：要执行请改用 moa_run，或先在隔离区跑完、把产物/日志作为 context 再交给本工具审。" +
  "同样 fail-closed（任一验真者失败即整体失败）。返回结构同 moa_run（status/aggregated/proposals/receipt/error）。";

/**
 * MCP 工具返回体（content 文本摘要 + structuredContent 完整 MoaResult）。
 * 用 type 别名而非 interface：需可赋值给 SDK 带索引签名的 CallToolResult。
 */
export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** 入参 → MoaRequest。不设 req.mode：由 preset.mode 驱动（避免强设 mode 击穿 verify 只读不变量）。 */
export function buildRequest(input: MoaToolInput, defaultPreset: string): MoaRequest {
  return {
    prompt: input.prompt,
    ...(input.context !== undefined ? { context: input.context } : {}),
    preset: input.preset ?? defaultPreset,
    ...(input.models !== undefined ? { models: input.models.map(toWorkerRef) } : {}),
    ...(input.aggregator !== undefined ? { aggregator: toWorkerRef(input.aggregator) } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };
}

/** MoaResult → 人读文本摘要（LLM 主要读 content[].text）。 */
export function formatSummary(r: MoaResult): string {
  const rc = r.receipt;
  const lines: string[] = [];
  if (r.status === "ok") {
    // 成功：最终答案作正文（调用方直接可用），尾部附一行元信息。
    lines.push(r.aggregated.trim());
    lines.push("");
    lines.push(
      `[moa ok] mode=${rc.mode} preset=${rc.preset} quorum=${rc.quorum} ` +
        `models=${rc.models.join(",")} aggregator=${rc.aggregator.model} ` +
        `cost=$${rc.totalCostUsd.toFixed(4)} body_sha256=${rc.bodySha256.slice(0, 12)}…`,
    );
  } else {
    const e = r.error;
    lines.push(
      `[moa ${r.status}] ${e ? `stage=${e.stage} reason=${e.reason}` : "无 error 明细"}`,
    );
    if (e?.detail) lines.push(`detail: ${e.detail}`);
    const marks = Object.entries(rc.proposerMarks)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (marks) lines.push(`proposerMarks: ${marks}`);
  }
  return lines.join("\n");
}

/** MoaResult → MCP 工具返回。failed 置 isError（让调用 LLM 注意）；aborted 不算协议错误。 */
export function toToolResponse(r: MoaResult): ToolResponse {
  return {
    content: [{ type: "text", text: formatSummary(r) }],
    structuredContent: r as unknown as Record<string, unknown>,
    ...(r.status === "failed" ? { isError: true } : {}),
  };
}

/** 工具核心运行依赖（server 与单测共用；runSessionImpl 仅测试注入）。 */
export interface MoaToolDeps {
  config: MoaConfig;
  modelRuntime: unknown;
  signal?: AbortSignal;
  onStageEvent?: (e: StageEvent) => void;
  runSessionImpl?: RunSessionImpl;
  /**
   * moa_deliver 专用：确定性写盘的路径 jail 白名单根。**必填、无缺省**（DESIGN §8.3 修复：
   * 此前 fallback 到 req.cwd/process.cwd，而 cwd 来自用户入参 → jail 根被调用方决定）。
   * 由 server 用受信任工作区（req.cwd）显式传入；空/缺省 → 拒绝一切写入。
   */
  allowedRoots?: string[];
  /**
   * moa_deliver 专用：拒写根（安装目录 projectRoot 及其子路径一律拒，DESIGN §8.3）。
   * 防覆写自身源码/配置（config/、src/）。
   */
  denyRoots?: string[];
}

/** 目标父目录是否落在某个根下（root 本身或其子路径）。 */
function isUnderRoot(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * 交付路径预闸（写盘前）：
 *   - allowedRoots 必填（DESIGN §8.3 修复：不回退 cwd）；空则拒。
 *   - 目标父目录若落在任一 denyRoot（安装目录）内则拒（防覆写自身源码/配置）。
 * 通过返回 null；违反返回人读拒绝理由。realpath 解析父目录，抗 symlink 逃逸。
 */
function deliverPathGuard(
  path: string,
  allowedRoots: string[],
  denyRoots: string[],
): string | null {
  if (allowedRoots.length === 0) {
    return "确定性交付缺少 allowedRoots：受信任工作区根未提供（deliver 需显式传入 cwd/工作区），拒绝一切写入";
  }
  if (denyRoots.length === 0) return null;
  const absParent = dirname(resolve(path));
  let realParent: string;
  try {
    realParent = realpathSync(absParent);
  } catch {
    realParent = absParent; // 父目录不存在时也按 resolve 后路径判定（后续 atomicWrite 仍会拒）
  }
  for (const d of denyRoots) {
    let realDeny: string;
    try {
      realDeny = realpathSync(d);
    } catch {
      realDeny = resolve(d);
    }
    if (isUnderRoot(realParent, realDeny)) {
      return `确定性交付拒绝：目标父目录 ${realParent} 落在安装目录（denyRoot ${realDeny}）内，禁止覆写自身源码/配置`;
    }
  }
  return null;
}

/** 解析 preset.mode（hasOwnProperty 门禁防原型链）；未知 preset → undefined（交给 runMoa 报 config 错）。 */
function resolvePresetMode(config: MoaConfig, presetName: string): Mode | undefined {
  if (!Object.prototype.hasOwnProperty.call(config.presets, presetName)) return undefined;
  return config.presets[presetName]?.mode;
}

/** 构造 config 阶段的 failed 结果（越界拒绝用）。 */
function configFailed(mode: Mode, presetName: string, reason: string): MoaResult {
  return {
    status: "failed",
    aggregated: "",
    proposals: [],
    receipt: {
      mode,
      preset: presetName,
      models: [],
      quorum: "0/0",
      profile: "",
      proposerMarks: {},
      aggregator: { model: "", usage: null, costUsd: 0, durationMs: 0 },
      bodySha256: "",
      totalCostUsd: 0,
      delivery: null,
    },
    error: { stage: "config", reason },
  };
}

/**
 * 边界校验（fix #4 提权修复）：解析后的 preset.mode 必须与本工具默认 preset 的 mode 一致。
 * moa_run 默认 preset 是 synthesize → 调用方用 `preset` 覆盖成 verify 会被拒（否则拿到沙箱
 * bash_readonly，与 moa_run「只读不执行」描述不符，能力越界）。moa_verify 默认 preset 是 verify →
 * 同理锁死 verify。deliver 不走此路（forceProfile 已把 worker 一律降为只读，无越界风险）。
 * 一致或无法判定（未知 preset，交给 runMoa 报 config 错）→ 返回 null。
 */
function enforcePresetModeMatchesTool(
  config: MoaConfig,
  req: MoaRequest,
  defaultPreset: string,
): MoaResult | null {
  const expected = resolvePresetMode(config, defaultPreset);
  const requested = req.preset ?? defaultPreset;
  const actual = req.mode ?? resolvePresetMode(config, requested);
  if (expected === undefined || actual === undefined) return null; // 未知 preset → 交给 runMoa
  if (actual === expected) return null;
  return configFailed(
    actual,
    requested,
    `工具边界违反：本工具锁定 ${expected} 模式，但请求的 preset="${requested}" 是 ${actual} 模式，越界被拒。` +
      (expected === "synthesize"
        ? "moa_run 只读不执行代码，不接受 verify preset（含沙箱 bash_readonly）；如需只读验真请改用 moa_verify 工具。"
        : "moa_verify 强制只读验真，不接受 synthesize preset；如需综合请改用 moa_run 工具。"),
  );
}

/**
 * 工具核心：构造 MoaRequest → runMoa → MCP 返回。transport 无关，单测可直调。
 * 绝不抛：runMoa 自身 fail-closed 折成 MoaResult；这里只做形状转换。
 */
export async function runMoaTool(
  input: MoaToolInput,
  defaultPreset: string,
  deps: MoaToolDeps,
): Promise<ToolResponse> {
  const req = buildRequest(input, defaultPreset);
  // 越界拒绝：preset.mode 必须与本工具默认 preset 的 mode 一致（fix #4）。
  const boundaryErr = enforcePresetModeMatchesTool(deps.config, req, defaultPreset);
  if (boundaryErr) return toToolResponse(boundaryErr);
  const r = await runMoa(deps.config, req, {
    modelRuntime: deps.modelRuntime,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onStageEvent ? { onStageEvent: deps.onStageEvent } : {}),
    ...(deps.runSessionImpl ? { runSessionImpl: deps.runSessionImpl } : {}),
  });
  return toToolResponse(r);
}

// ============================================================================
// moa_deliver —— synthesize/verify + 确定性落盘交付（DESIGN §6）。
// ============================================================================

/** moa_deliver 入参 = 通用 moa 入参 + path（必）+ done_marker（必）。 */
export const moaDeliverToolInput = {
  ...moaToolInput,
  path: z
    .string()
    .min(1)
    .describe(
      "交付目标文件路径。父目录必须在受信任工作区根（cwd）之下、且不得落在安装目录内；" +
        "拒绝 symlink 逃逸与目录穿越。正文由本工具的代码原子写入，非 LLM 写。",
    ),
  done_marker: z
    .string()
    .regex(DONE_MARKER_RE)
    .describe(
      "完成标记，格式 DONE_[A-Z0-9_]+（如 DONE_REPORT）。" +
        "聚合正文的最后一非空行必须等于它；写盘后回读时二次核对。",
    ),
};

/** moa_deliver 入参类型（形状对齐 moaDeliverToolInput）。 */
export interface MoaDeliverToolInput extends MoaToolInput {
  path: string;
  done_marker: string;
}

export const MOA_DELIVER_DESCRIPTION =
  "多模型综合 + 确定性落盘交付（deliver）：先跑 MoA（proposers→aggregator）产出最终正文，" +
  "再由**系统代码**（非 LLM）把该正文原子写入指定文件并回读校验，最后在 receipt.delivery 记录取证。" +
  "适用：要一份「多模型交叉 + 可审计落盘」的交付物（报告 / 结论 / 评审意见）。" +
  "确定性交付：临时文件→fsync→rename 原子替换，回读核对 sha256 与末行 done_marker，全过才算 written。" +
  "交付阶段所有 worker 一律降为只读 profile（delivery-readonly-worker）：正文由代码写，模型不碰文件系统写。" +
  "硬约束：path 的父目录必须在允许根之下（拒 symlink 逃逸 / 目录穿越）；" +
  "done_marker 须匹配 DONE_[A-Z0-9_]+，且必须是正文最后一非空行（请让 prompt 要求模型以该标记结尾）。" +
  "fail-closed：MoA 失败则不写盘、透传 failed；写盘 / 回读任一不符则 status=failed（error.stage=delivery）。" +
  "返回结构同 moa_run（status/aggregated/proposals/receipt/error），成功时 receipt.delivery={written:true,path,sha256}。";

/**
 * moa_deliver 工具核心：跑 MoA（强制只读 profile）→ 确定性写盘 → 组装 receipt.delivery。
 * 绝不抛：runMoa 自身 fail-closed；写盘失败折成 status=failed(error.stage=delivery)。
 *
 * 交付阶段只读性由 orchestrate 的 forceProfile 在安全边界内钉死（覆盖 preset 与入参），
 * 防 verify preset 把 bash_readonly 泄进交付阶段——比在此处 coerce req.models 更牢固
 * （coerce 会被 orchestrate 的 profile 授权重新覆盖）。
 */
export async function runMoaDeliverTool(
  input: MoaDeliverToolInput,
  defaultPreset: string,
  deps: MoaToolDeps,
): Promise<ToolResponse> {
  // 1) 跑 MoA。forceProfile 把全部 worker 钉死为 delivery-readonly-worker（无论 preset）。
  //    覆盖入参 models/aggregator 只贡献 provider/model，profile 由 orchestrate 强制。
  const req = buildRequest(input, defaultPreset);
  const r = await runMoa(deps.config, req, {
    modelRuntime: deps.modelRuntime,
    forceProfile: "delivery-readonly-worker",
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.onStageEvent ? { onStageEvent: deps.onStageEvent } : {}),
    ...(deps.runSessionImpl ? { runSessionImpl: deps.runSessionImpl } : {}),
  });

  // 2) MoA 失败（fail-closed）→ 不写盘，透传 failed / aborted。
  if (r.status !== "ok") {
    return toToolResponse(r);
  }

  // 3) 写盘前路径预闸：allowedRoots 必填（不回退 cwd）+ 排除安装目录（DESIGN §8.3）。
  const allowedRoots = deps.allowedRoots ?? [];
  const denyRoots = deps.denyRoots ?? [];
  const guardErr = deliverPathGuard(input.path, allowedRoots, denyRoots);
  if (guardErr) {
    const failed: MoaResult = {
      ...r,
      status: "failed",
      error: { stage: "delivery", reason: guardErr },
      receipt: { ...r.receipt, delivery: { written: false, path: input.path, sha256: "" } },
    };
    return toToolResponse(failed);
  }

  // 4) 确定性写盘 + 回读校验。
  try {
    const w = atomicWriteWithVerify({
      path: input.path,
      body: r.aggregated,
      doneMarker: input.done_marker,
      allowedRoots,
    });
    // 写盘成功：在 receipt.delivery 记录取证（DESIGN §4.6 B）。
    // 注：delivery 阶段的 MCP 进度通知需扩 events.ts 的 StageEvent 联合（本轮不越界改 events.ts），
    //     故交付取证仅经 receipt.delivery 随返回体透出，暂不发独立 notification。
    r.receipt.delivery = { written: true, path: w.path, sha256: w.sha256 };
    return toToolResponse(r);
  } catch (err) {
    // 4) 写盘 / 回读失败 → status 反映交付失败（error.stage=delivery），不改动已生成正文。
    const detail = err instanceof Error ? err.message : String(err);
    const failed: MoaResult = {
      ...r,
      status: "failed",
      error: { stage: "delivery", reason: "确定性交付写盘失败", detail },
      receipt: { ...r.receipt, delivery: { written: false, path: input.path, sha256: "" } },
    };
    return toToolResponse(failed);
  }
}
