/**
 * 并发闸(v4 §9,P3):进程级全局的 MoA 调用准入。
 *
 * 语义:10 路并行 = 6 在跑 + 4 有序排队,**零静默丢弃**——队满/超时/配额/关停一律 fail-loud,
 * 错误信息自带在途数、队列位与重试建议。排队超时 45s 保住客户端超时不变量
 * (45s + backstop 1350s = 1395s < 客户端 tool_timeout 1410s)。
 *
 * 公平性:按客户端会话(Mcp-Session-Id 粒度,由 server 每会话生成 key)设配额
 * (缺省 3 在跑 + 4 排队),FIFO 出队时跳过被会话配额挡住的队头(防队头阻塞全队)。
 *
 * 粒度声明(审查 F-10):**每进程独立**——http 单实例内全局生效;若另起 stdio 开发实例,
 * 两进程各有各的闸,跨进程闸(IPC)本期不做。
 *
 * SIGTERM:server 关停时调用 shutdown(),队列中请求全部立即 fail-loud 拒绝(计入优雅关闭),
 * 绝不让排队请求无响应地被丢弃(审查 C8:旧在途追踪只覆盖"已开跑")。
 */
import {
  GATE_MAX_INFLIGHT,
  GATE_QUEUE_MAX,
  GATE_QUEUE_TIMEOUT_MS,
  GATE_SESSION_MAX_INFLIGHT,
  GATE_SESSION_MAX_QUEUED,
} from "../config/limits.js";

export type GateRejectKind =
  | "queue_full"
  | "session_quota"
  | "queue_timeout"
  | "shutdown"
  | "client_aborted";

export class GateRejectError extends Error {
  readonly kind: GateRejectKind;
  constructor(kind: GateRejectKind, message: string) {
    super(message);
    this.name = "GateRejectError";
    this.kind = kind;
  }
}

export interface GateOptions {
  maxInflight?: number;
  queueMax?: number;
  queueTimeoutMs?: number;
  sessionMaxInflight?: number;
  sessionMaxQueued?: number;
  /**
   * 豁免会话配额的 key(P3 复审 F8,徐总方案 A):stdio 是单客户端 transport,
   * "防多客户端互饿"的公平动机对它不存在——若不豁免,3+4 的会话配额会把 stdio 用户
   * 自阉在 3 路,拿不到"10 路并行=6 在跑"的全局额度。豁免后仅受全局 6+10 约束。
   */
  quotaExemptKeys?: readonly string[];
}

interface QueueEntry {
  sessionKey: string;
  resolve: (release: () => void) => void;
  reject: (err: GateRejectError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  enqueuedAt: number;
  /** 终态闩(P3 复审 F3):granted/timedOut/aborted/rejected 四路径进入前必须 CAS 此标志,防双结算。 */
  settled: boolean;
}

interface SessionCount {
  running: number;
  queued: number;
}

export interface GateStats {
  running: number;
  queued: number;
}

export class ConcurrencyGate {
  private readonly maxInflight: number;
  private readonly queueMax: number;
  private readonly queueTimeoutMs: number;
  private readonly sessionMaxInflight: number;
  private readonly sessionMaxQueued: number;
  private running = 0;
  private readonly queue: QueueEntry[] = [];
  private readonly sessions = new Map<string, SessionCount>();
  private down = false;

  private readonly quotaExempt: ReadonlySet<string>;

  constructor(opts: GateOptions = {}) {
    this.maxInflight = opts.maxInflight ?? GATE_MAX_INFLIGHT;
    this.queueMax = opts.queueMax ?? GATE_QUEUE_MAX;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? GATE_QUEUE_TIMEOUT_MS;
    this.sessionMaxInflight = opts.sessionMaxInflight ?? GATE_SESSION_MAX_INFLIGHT;
    this.sessionMaxQueued = opts.sessionMaxQueued ?? GATE_SESSION_MAX_QUEUED;
    this.quotaExempt = new Set(opts.quotaExemptKeys ?? ["stdio"]);
  }

  /** 本会话是否受公平配额约束(stdio 等单客户端 transport 豁免,仅受全局上限,F8 方案 A)。 */
  private quotaBound(key: string): boolean {
    return !this.quotaExempt.has(key);
  }

  /**
   * 终态闩(F3):四条终结路径(grant/timeout/abort/shutdown)统一经此结算——
   * CAS settled、清 timer、摘 signal 监听器(F2)、出队。返回 false = 已被他路结算,调用方必须 no-op。
   */
  private settle(entry: QueueEntry): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    this.dequeue(entry);
    return true;
  }

  stats(): GateStats {
    return { running: this.running, queued: this.queue.length };
  }

  private session(key: string): SessionCount {
    let s = this.sessions.get(key);
    if (!s) {
      s = { running: 0, queued: 0 };
      this.sessions.set(key, s);
    }
    return s;
  }

  private gc(key: string): void {
    const s = this.sessions.get(key);
    if (s && s.running === 0 && s.queued === 0) this.sessions.delete(key);
  }

  private statLine(): string {
    return `在跑 ${this.running}/${this.maxInflight},排队 ${this.queue.length}/${this.queueMax}`;
  }

  /**
   * 准入。成功返回 release(必须在 finally 调用);失败以 GateRejectError reject(fail-loud)。
   * F1:本方法**绝不抛穿**——全部路径折成 resolve/reject,内部异常也折成 internal 拒绝并保证不占坑。
   */
  acquire(sessionKey: string, signal?: AbortSignal): Promise<() => void> {
    try {
      if (this.down) {
        return Promise.reject(
          new GateRejectError("shutdown", "服务正在关停,拒绝新调用;请稍后重试"),
        );
      }
      if (signal?.aborted) {
        return Promise.reject(new GateRejectError("client_aborted", "调用方已取消"));
      }
      const s = this.session(sessionKey);
      const bound = this.quotaBound(sessionKey);
      // 直接放行:全局有空位,且(受配额会话)会话在跑未达上限。
      if (this.running < this.maxInflight && (!bound || s.running < this.sessionMaxInflight)) {
        return Promise.resolve(this.grant(sessionKey));
      }
      // 排队准入检查(fail-loud,零静默丢弃)。
      if (this.queue.length >= this.queueMax) {
        return Promise.reject(
          new GateRejectError(
            "queue_full",
            `并发闸队列已满(${this.statLine()})。请稍后重试,或降低并行度;10 路并行的设计语义 = ` +
              `${this.maxInflight} 在跑 + ${this.queueMax} 排队,全部有交代。`,
          ),
        );
      }
      if (bound && s.queued >= this.sessionMaxQueued) {
        return Promise.reject(
          new GateRejectError(
            "session_quota",
            `本客户端会话已达公平配额(${s.running} 在跑 + ${s.queued} 排队;` +
              `上限 ${this.sessionMaxInflight}+${this.sessionMaxQueued})。请等待在途调用完成——` +
              "配额防单客户端突发饿死其他客户端。",
          ),
        );
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry: QueueEntry = {
          sessionKey,
          resolve,
          reject,
          enqueuedAt: Date.now(),
          settled: false,
          timer: setTimeout(() => {
            if (!this.settle(entry)) return; // F3:已被 grant/abort/shutdown 结算 → no-op
            reject(
              new GateRejectError(
                "queue_timeout",
                `排队超时(${this.queueTimeoutMs}ms;${this.statLine()})。上限对齐客户端超时不变量` +
                  "(排队+backstop ≤ tool_timeout),请稍后重试。",
              ),
            );
          }, this.queueTimeoutMs),
          ...(signal ? { signal } : {}),
        };
        // 注意:超时定时器**不 unref**——排队请求是真实待办,必须保证到点必触发
        // (unref 版在事件循环空转时进程会先退出,定时器根本不响)。
        if (signal) {
          entry.onAbort = (): void => {
            if (!this.settle(entry)) return;
            reject(new GateRejectError("client_aborted", "调用方在排队期间取消/断连,已移出队列"));
          };
          signal.addEventListener("abort", entry.onAbort, { once: true });
        }
        s.queued += 1;
        this.queue.push(entry);
      });
    } catch (err) {
      // F1 兜底:构造/入队期任何未预期异常折成拒绝——此时未 grant、未入队成功,不占任何坑。
      return Promise.reject(
        new GateRejectError("queue_full", `并发闸内部异常(fail-loud):${(err as Error)?.message ?? err}`),
      );
    }
  }

  private dequeue(entry: QueueEntry): void {
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      const s = this.sessions.get(entry.sessionKey);
      if (s) {
        s.queued -= 1;
        this.gc(entry.sessionKey);
      }
    }
  }

  private grant(sessionKey: string): () => void {
    this.running += 1;
    this.session(sessionKey).running += 1;
    let released = false;
    return (): void => {
      if (released) return; // release 幂等
      released = true;
      this.running -= 1;
      const s = this.sessions.get(sessionKey);
      if (s) {
        s.running -= 1;
        this.gc(sessionKey);
      }
      this.pump();
    };
  }

  /**
   * 出队:FIFO,但跳过被会话配额挡住的队头(防队头阻塞其他会话)。
   * 语义声明(复审 F4):**同会话内严格 FIFO,跨会话不保证 FIFO**——这正是公平配额的目的。
   * down 后短路(复审 F9:shutdown 之后 release 触发的 pump 绝不放行任何残留)。
   */
  private pump(): void {
    while (!this.down && this.running < this.maxInflight) {
      const idx = this.queue.findIndex(
        (e) =>
          !e.settled &&
          (!this.quotaBound(e.sessionKey) ||
            this.session(e.sessionKey).running < this.sessionMaxInflight),
      );
      if (idx === -1) return;
      const entry = this.queue[idx];
      if (!this.settle(entry)) continue; // F3:被并发路径抢先结算 → 换下一个
      entry.resolve(this.grant(entry.sessionKey));
    }
  }

  /** 关停:拒绝全部排队请求(fail-loud),此后 acquire/pump 一律拒。在途调用由 server 的 abort 路径处理。 */
  shutdown(): number {
    this.down = true;
    let n = 0;
    for (const entry of [...this.queue]) {
      if (!this.settle(entry)) continue;
      n += 1;
      entry.reject(
        new GateRejectError("shutdown", "服务关停:排队中的调用被拒绝(非静默丢弃),请重启后重试"),
      );
    }
    return n;
  }
}
