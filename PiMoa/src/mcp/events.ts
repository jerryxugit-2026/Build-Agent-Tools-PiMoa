/**
 * StageEvent · MoA 分阶段观测事件（DESIGN §4.6 A：运行中分阶段结构化进度）。
 *
 * 纯类型 + 纯函数模块，**零运行时依赖 moa/**（orchestrate.ts 以 `import type` 引用，
 * 不产生运行时环，也不违反「types.ts 不许改」——本类型定义在 src/mcp/ 内）。
 *
 * orchestrate.runMoa 在各阶段（proposer 开始/结束、quorum、aggregator 开始/结束）
 * 通过可选 `deps.onStageEvent(e)` 上报；MCP server 把每条转成 `notifications/message`。
 * 只观测、不参与 fail-closed 判决。
 */

/** 单条阶段事件（判别联合，按 stage 分派）。 */
export type StageEvent =
  | {
      stage: "proposer";
      /** started=起会话；done=完成且正文非空；timeout=per-call 超时；failed=报错/空正文/未完成。 */
      phase: "started" | "done" | "timeout" | "failed";
      /** `provider/model`。 */
      model: string;
      /** proposer 在 preset 中的下标（同 model 重复时用于区分）。 */
      index: number;
      total: number;
    }
  | {
      stage: "quorum";
      /**
       * gathered=达标放行；failed=fail-closed 整体失败；
       * degraded=`quorum:"tolerate-one"`（仅 synthesize）下少一份提议但仍放行——**告警级**，
       * 调用方应知悉本次综合只有 N-1 份提议参与（receipt.quorum 亦标 `(degraded)`）。
       */
      phase: "gathered" | "failed" | "degraded";
      ok: number;
      total: number;
    }
  | {
      stage: "aggregator";
      phase: "started" | "done";
      model: string;
    };

/** MCP 通知级别（对齐 pi-mcp：正常 info，失败/超时 warning）。 */
export type NotificationLevel = "info" | "warning";

/** 把 StageEvent 渲染成 MCP `notifications/message` 的 payload（level + 人读 data 文本）。 */
export function stageEventToNotification(e: StageEvent): {
  method: "notifications/message";
  params: { level: NotificationLevel; data: string };
} {
  let level: NotificationLevel = "info";
  let data: string;
  switch (e.stage) {
    case "proposer": {
      if (e.phase === "timeout" || e.phase === "failed") level = "warning";
      data = `[moa] proposer[${e.index + 1}/${e.total}] ${e.model} ${e.phase}`;
      break;
    }
    case "quorum": {
      // degraded 与 failed 同为 warning：调用方必须注意到「本次只有 N-1 份提议参与综合」。
      if (e.phase === "failed" || e.phase === "degraded") level = "warning";
      data =
        e.phase === "gathered"
          ? `[moa] quorum gathered ${e.ok}/${e.total}`
          : e.phase === "degraded"
            ? `[moa] quorum degraded ${e.ok}/${e.total} → 降级放行（tolerate-one，仅 synthesize）：本次综合少一份提议`
            : `[moa] fail-closed: quorum ${e.ok}/${e.total} → 整体失败`;
      break;
    }
    case "aggregator": {
      data = `[moa] aggregator ${e.model} ${e.phase}`;
      break;
    }
  }
  return { method: "notifications/message", params: { level, data } };
}
