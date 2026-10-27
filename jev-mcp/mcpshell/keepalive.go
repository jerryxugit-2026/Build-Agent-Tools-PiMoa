package mcpshell

// 层②：传输层 SSE 保活——治「长响应在结果就绪前一个字节都不发」。
//
// 【病症】go-sdk 的 streamable POST 路径在结果就绪前**只 Set 响应头、不发头**
// （mcp/streamable.go:1240-1258 设头，:1320 的 hangResponse 把这条 HTTP 响应挂住），
// 全仓唯一的写字节处是 mcp/event.go:44-61 的 writeEvent，只在**消息就绪时**被调用。
// ⇒ 一次工具调用从请求进来到 handler 返回、客户端收到 0 字节；DSH 侧 undici 的
// headersTimeout/bodyTimeout（默认 300s）据此掐断调用，而服务端看起来一切正常
// （子进程还在跑、结果照常落盘），现场表现为**回包凭空消失**。
//
// 【方案】每 sseKeepaliveInterval 往 SSE 响应体补一行 `: keepalive` 注释。SSE 规范里以
// `:` 开头的行是注释，任何合规解析器一律忽略、不派发事件 ⇒ 对所有客户端安全；
// **绝不能改成 `data:` 形态**——那会被当成一条真实 MCP 消息交给客户端处理。
//
// 形态对齐 PiMoa 的 startSseKeepalive（PiMoa/src/mcp/http_util.ts:66-110），只在 Go 逼你
// 偏离的地方偏离，共四处，每处都在下面写明了理由。
//
// 【接线，两段】withSSEKeepalive 只做两件事——包一层 writer、把 writer 塞进请求 ctx；
// **它自己绝不起表**。起表点（StartKeepalive）在**长工具 handler 的闭包第一行**，
// 理由见 StartKeepalive 的注释。

import (
	"context"
	"log"
	"mime"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// 保活字节与间隔：与 PiMoa 同名同值（http_util.ts:32 / :25）。
//
// 间隔取 15s = undici bodyTimeout 默认值 300s 的 1/20，留 20 倍余量抗调度抖动。
// ⚠️ 它同时是**响应头**的送达上界：Go 在首次 body Write 之前一个字节都不上网卡，
// WriteHeader(200) 只翻状态、不发头块 ⇒ 真正把头送出去的是保活第一跳的 Write+Flush
// （≤ 15s）。因此**把本间隔调大到超过客户端的 headersTimeout，修复会静默失效**
// （客户端连响应头都等不到），不是「慢一点」而是「回到改前的病症」。V-const 断言锁这一点。
const (
	sseKeepaliveBytes    = ": keepalive\n\n"
	sseKeepaliveInterval = 15 * time.Second
)

// 客户端 HTTP 空闲界与设计稿 V-const 的余量系数：DSH 侧 undici 的 headersTimeout/bodyTimeout
// 默认 300s，15s 默认值恰好是 300s/20（V-const 断言的就是这条不等式）。
//
// 这两个常量只服务于下面 envKeepaliveInterval 的**上界告警**：env 把间隔调大到
// interval×20 > 300s 即违反同一条不等式 ⇒ 保活静默失效（见那里的注释）。
const (
	keepaliveClientIdleTimeout = 300 * time.Second
	keepaliveMarginFactor      = 20
)

// kwKey 是「把本请求的 writer 塞进 ctx」的键。私有空结构体，不可能与别的包的键相撞。
type kwKey struct{}

// keepaliveWriter 是**朴素包装体**：Write/WriteHeader 过同一把锁后转发。
//
// ⚠️ **不要覆写 Header()**。v2 一度上过「私有头 map 代理」（priv/snap/commit），v4 已废弃：
// 它把正确性押在「SDK 设完 Content-Type 之后还会再调一次 Header()」这个**未声明的语句
// 顺序**上（第二轮评审的 BLOCKER，成立）。定稿形态不押在任何语句顺序上——它押的是
// 「SDK 用 channel 分发请求」，而那条性质由本包的竞态测试持续验证。
type keepaliveWriter struct {
	http.ResponseWriter
	mu       sync.Mutex
	interval time.Duration
	started  bool // 幂等标记：由 StartKeepalive 在锁内读写（同一请求只武装一个 ticker）
}

// WriteHeader 与 Write 共用一把锁：Go 的 http.ResponseWriter 不允许并发写。
func (w *keepaliveWriter) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.ResponseWriter.WriteHeader(code)
}

func (w *keepaliveWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.ResponseWriter.Write(b)
}

// FlushError 让 SDK 的冲刷也落在同一把锁内。**这是承重结构，不是防御性装饰**：
// 层①（progress 心跳）真的在写时，go-sdk 的 writeEvent 是 `w.Write(...)` 紧接
// `rc.Flush()`（mcp/event.go:56-59），而这件事发生在**工具 handler 执行期间**——
// 不把 Flush 纳入同一把锁，它就会经下面的 Unwrap() 直达底层 bufio，与保活写并发。
// 实测（repro/combo_probe_test.go，层① ≈256 条 + 层② ≈300 条）：去掉它 **18 处**竞争，
// 有它 0 处。对照臂 d/g（工具全程只 sleep、SDK 一次都不写）测不出差别——只因为它们
// 的场景里压根没有第二个写者。
func (w *keepaliveWriter) FlushError() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return http.NewResponseController(w.ResponseWriter).Flush()
}

// Unwrap 让 http.ResponseController 能找到底层 Flush。漏了它，保活字节会卡在 Go 响应
// 写入器的 bufio 里 ⇒ 保活**静默失效**（PiMoa 那边 res.write 不经 bufio，无此问题）。
func (w *keepaliveWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// touch 补一行保活注释。已 stop / handler 已返回时不会被调用（ticker 已退出）。
//
// 【为什么可以直接读真实头】起表点在**工具 handler**，那条 goroutine 与 SDK 设头之间有
// 明确的 happens-before 链，四步全在 SDK 源码里：
//  1. HTTP goroutine：servePOST 先设头（mcp/streamable.go:1249-1258），再把消息投进 channel
//     （`:1307 case c.incoming <- msg:`）；
//  2. channel 接收：streamableServerConn.Read 的 `case msg, ok := <-c.incoming:`
//     （mcp/streamable.go:1356）——发送→接收这条边把「设头的一切效果」排到了接收之后的
//     代码之前；
//  3. 分发：c.acceptRequest 入队后 `go c.handleAsync()`（internal/jsonrpc2/conn.go:601），
//     go 语句起的 goroutine 继承这条边；
//  4. 到我们的 handler：c.handler.Handle(ctx, req.Request)（internal/jsonrpc2/conn.go:642）。
//
// ⇒ ticker 是从第 4 步的 goroutine 里起的，它对头 map 的一切访问（含 net/http 首次建头时
// 的 Clone）都被排在 SDK 的 Set 之后。**这条边是必要条件、只能被证伪**：哪天 SDK 换掉
// 「用 channel 分发」这个机制，本包的 -race 回归门会自己报红。
//
// 【为什么守卫要反过来写】PiMoa 的判据是「`!headersSent` ⇒ 跳过（响应还没开始，形态未知）」；
// 这条**照抄过来会让保活永不触发**——Go 的 SDK 只 `Header().Set`、全程不发头，`headersSent`
// 恒为假，于是每一跳都静默 no-op、连错误都没有。Go 侧的等价判据是「**真实头里的
// Content-Type 非空**即算形态已知」，然后由我们把头送出去（首次 Write 隐式 WriteHeader(200)
// + 显式 Flush）。
func (w *keepaliveWriter) touch() {
	w.mu.Lock()
	defer w.mu.Unlock()
	// 守卫★防回归（安全边界）：content-type 不是 SSE（JSON 形态回包 / 尚未声明）⇒
	// **一个字节都不写**。盲写会把 JSON 响应体插脏，客户端再也解析不出来。
	if !isSSE(w.ResponseWriter.Header().Get("Content-Type")) {
		return
	}
	_, _ = w.ResponseWriter.Write([]byte(sseKeepaliveBytes)) // fail-open：流已坏就静默吞掉
	// 必须显式 Flush：写完注释行不冲，13 个字节会躺在 bufio 里，保活静默失效。
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

// isSSE 判 content-type 是否是 SSE：按 media type 比较（容忍 `; charset=…` 一类参数），
// 解析不出来才退回子串包含（对齐 PiMoa 那边的 `.includes`）。
func isSSE(ct string) bool {
	if mt, _, err := mime.ParseMediaType(ct); err == nil {
		return mt == "text/event-stream"
	}
	return strings.Contains(strings.ToLower(ct), "text/event-stream")
}

// withSSEKeepalive 只对 POST 生效：包一层 keepaliveWriter，并把 writer 塞进请求 ctx。
//
// ⚠️ **它自己绝不起 ticker**——起表点在长工具 handler（见 StartKeepalive），依据是竞态探针：
// 中间件起表与 SDK 设头之间**没有 happens-before 边**（-race 在 1ms/30ms 两档分别报
// 17/10/3 处竞争），handler 起表有（0 处）。
//
// 为什么只对 POST：GET standalone 流由 SDK 自己 WriteHeader(200)+Flush
// （mcp/streamable.go:1056-1067），本来就即时出字节、不需要保活；包装它只会平添一个写者。
func withSSEKeepalive(next http.Handler, interval time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		kw := &keepaliveWriter{ResponseWriter: w, interval: interval}
		next.ServeHTTP(kw, r.WithContext(context.WithValue(r.Context(), kwKey{}, kw)))
	})
}

// StartKeepalive 起本请求的保活 ticker，返回的 stop 等 goroutine 真的退出后再返回。
// ctx 里没有 writer（未开启保活 / 非目标壳 / 非 POST）⇒ 返回**空函数**，一个 ticker 都不起。
//
// ⚠️⚠️ **起表点纪律（本设计唯一的已知 footgun，改代码前先读这一段）**：
// 它必须、且只能扣在**工具 handler 闭包的第一行**，消费 HTTP 栈送进来的那个**最外层具名
// ctx**：
//
//	func(ctx context.Context, req *mcp.CallToolRequest, in runInput) (…) {
//		defer mcpshell.StartKeepalive(ctx)()
//		…再调 runTask(ctx, in)／runForeground(ctx, in)…
//	}
//
// **严禁**把它下沉到 runTask / runForeground / 任何 `context.WithTimeout` 派生的子 ctx 或
// 子 goroutine 里：取不到 writer 时本函数是 **fail-open 静默返回空函数**，一旦下沉，保活会
// **无声失效**——没有日志、没有编译告警、没有任何测试会红，只有「长调用又被客户端掐断」
// 这个原始病症回来。
//
// 为什么起表点在 handler 才没有竞争：见 touch 注释里的四步 HB 链。中间件起表没有那条边。
//
// 【幂等】同一 writer 重复调用只武装一次，否则会派出多个 ticker 并发写同一个 writer。
func StartKeepalive(ctx context.Context) func() {
	kw, ok := ctx.Value(kwKey{}).(*keepaliveWriter)
	if !ok {
		return func() {}
	}
	kw.mu.Lock()
	if kw.started {
		kw.mu.Unlock()
		return func() {}
	}
	kw.started = true
	kw.mu.Unlock()

	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(kw.interval)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				kw.touch()
			}
		}
	}()

	// ⚠️ 等 goroutine 真的退出再返回。**理由要写对**：消竞争靠的是「起表点的 HB 边 + 那把
	// 锁」，**不是**这个等待——消融对照实测（`stop` 只 close 不等）同样 0 处竞争。
	// 等它的理由是**语义**：handler 返回后 net/http 认为这条响应已经结束，此时再去
	// Write/Flush 属于对已结束的响应动手（拿到错误、或产生尾随字节），等它退出能把这个窗口
	// 消成 0，并让「handler 返回后不再有保活写」成为确定性事实（V-abort 断言的就是它）。
	return func() { close(stop); <-done }
}

// envKeepaliveInterval 读保活间隔 env，**只对已经 opt-in 的壳生效**：fallback 就是调用方传进来的
// `Config.SSEKeepalive`，它 <= 0（零值 = 该壳没开保活）时**连 env 都不读**、直接返回 0。
//
// ⚠️ 为什么 env 不能点火：env 只该给**已 opt-in 的壳**做**调优**与**急停**。若 env 能点火，
// 「没开保活的壳行为与响应逐字节不变」（devkb / claude-dispatch 两个壳靠的就是这句）会从
// **绝对承诺**退化成**条件承诺**——取决于那台机器的环境里恰好有没有设那个变量。
//
// 在此前提下：`0` / `off` / `false`（大小写与首尾空白不敏感）= **显式关闭**（返回 0）；
// 其余一律委托 EnvDuration 的语法（纯数字按毫秒、带单位按 time.ParseDuration），
// 非法值才回落 fallback（并 warn）。
//
// ⚠️ 为什么不能直接用现成的 EnvDuration：它把 <=0 当**非法输入**并回落默认值
// （env.go:81-99），于是 "<PREFIX>_SSE_KEEPALIVE=0" 会被警告一句、然后回落到 15s——
// **关不掉**。Config.SSEKeepalive 的零值语义是「关闭」，env 侧必须能真的关掉它。
//
// ⚠️ 上界告警（把 V-const 那条不等式编码进运行时）：本间隔同时是**响应头**的送达上界（Go 在
// 首次 body Write 之前一个字节都不上网卡，真正把头送出去的是保活第一跳），所以运维把 env
// 调成 10m，首个保活字节就要等 10 分钟，而客户端 undici 的 headersTimeout/bodyTimeout 是
// 300s ⇒ 保活**静默失效**，现场表现与「没做保活」完全一样（无法区分「治好了」与「药没吃」）。
// 判据用设计稿 V-const 的同一条不等式：interval×20 > 300s（15s 默认值恰好 = 300/20，不告警）。
//
// 处置只告警：**不 clamp、不改写运维的取值**——clamp 会让运维看到的配置与运行行为不一致，
// 比失效更难查。上界**只针对从 env 读到的值**；Config.SSEKeepalive 是代码常量，不归本函数管
// （它由 V-const 常量断言直接锁）。
func envKeepaliveInterval(name string, fallback time.Duration, logger *log.Logger) time.Duration {
	if fallback <= 0 {
		return 0 // 未 opt-in：env 不得点火（见函数头注释）
	}
	raw := strings.TrimSpace(os.Getenv(name))
	switch strings.ToLower(raw) {
	case "":
		return fallback
	case "0", "off", "false":
		return 0
	}
	d := EnvDuration(name, fallback, logger)
	// ⚠️ 上界判据必须落在**从 env 解析出来的**值上，不能落在返回值 d 上：env 非法时 d 会等于
	// fallback（= Config.SSEKeepalive），而 Config 值完全可能与 env 值相等 ⇒ 用「d != fallback」
	// 一类判据会漏掉「env 与 Config 同值且都过大」这一格。这里用一个哨兵 fallback 再问一次
	// EnvDuration「env 到底解析得出来吗」：语法仍然只有 EnvDuration 一份（不复制解析规则），
	// 哨兵恒为负、合法时长恒为正，两集合不可能相撞；探针这次不传 logger，坏值告警仍只由上面那次发出。
	const envProbeSentinel = time.Duration(-1)
	if v := EnvDuration(name, envProbeSentinel, nil); v > 0 && v*keepaliveMarginFactor > keepaliveClientIdleTimeout {
		// 300s 用整数秒打印（`%s` 会把 300s 渲染成 "5m0s"，运维看不出它对应 undici 的哪个默认值）。
		warn(logger, "⚠ %s=%q (%s) 过大：首个保活字节要等这么久，而客户端 HTTP 空闲界约 %ds（undici headersTimeout/bodyTimeout）⇒ 保活会静默失效，表现与未开启完全一样；建议 ≤%s",
			name, raw, v, int(keepaliveClientIdleTimeout/time.Second), keepaliveClientIdleTimeout/keepaliveMarginFactor)
	}
	return d
}
