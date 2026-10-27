package mcpshell

// 层①（progress 心跳）回归：V-prog1 / V-prog2。
//
// 【⚠️ 本文件覆盖到哪、覆盖不到哪】
//   覆盖：StartProgressHeartbeat（及带间隔入参的内核 startProgressHeartbeat）的三条铁律——
//         用调用方 ctx、没 token 一条都不发、progress 从 1 单调递增且不传 total；以及
//         「结果事件仍完好」。
//   **不覆盖**：两个真壳（cmd/antigravity-mcp、cmd/jev-mcp）里那两行 defer 接线；
//         也不覆盖客户端是否真的会 opt-in（DSH 今天不传 `_meta.progressToken`，
//         故对本机 DSH 是结构性 no-op——这一条由设计稿 §4.3 记录，不是本文件的断言）。
//
// 【为什么表格里既有「内核」又有「导出包装」】生产间隔固定 20s（progressHeartbeatInterval），
// 而 20s 一跳的测试要么跑 20 秒、要么断言不出「没发」与「还没到点」的区别（那是假绿）。
// 故：行为断言走**带间隔入参的内核**（同一条代码路径，唯一变量是间隔），
// 生产包装另辟两行做守卫断言 + 一条「生产间隔确实是 20s 量级」的反向断言。

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// progTestInterval 只在单测里注入：生产间隔恒为 progressHeartbeatInterval（20s）。
const progTestInterval = 20 * time.Millisecond

type progWorkIn struct {
	Millis int    `json:"millis"`
	Tag    string `json:"tag"`
}

// heartbeatArmer 抽象「工具 handler 里怎么挂心跳」，让同一张表覆盖内核与生产包装两条路。
type heartbeatArmer func(ctx context.Context, req *mcp.CallToolRequest) func()

// progressTool 造一个「跑得够久、且挂了心跳」的工具体。
func progressTool(arm heartbeatArmer) func(*mcp.Server) {
	return func(s *mcp.Server) {
		mcp.AddTool(s, &mcp.Tool{Name: "work", Description: "work with progress heartbeat"},
			func(ctx context.Context, req *mcp.CallToolRequest, in progWorkIn) (*mcp.CallToolResult, any, error) {
				if arm != nil {
					defer arm(ctx, req)() // ★ 与两个真壳同形：handler 闭包第一行挂、返回即收尾
				}
				select {
				case <-time.After(time.Duration(in.Millis) * time.Millisecond):
				case <-ctx.Done():
					return nil, nil, ctx.Err()
				}
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "done-" + in.Tag}}}, nil, nil
			})
	}
}

// progCallBody 拼一次 tools/call；withToken=false 时**不带** `_meta`（= DSH 今天的形态）。
func progCallBody(tag string, millis int, withToken bool) string {
	meta := ""
	if withToken {
		meta = `,"_meta":{"progressToken":"tok-1"}`
	}
	return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"work","arguments":{"millis":` +
		itoaSmall(millis) + `,"tag":"` + tag + `"}` + meta + `}}`
}

func itoaSmall(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// progEvent 是响应体里一条 data 事件的判读结果。
type progEvent struct {
	method   string
	progress float64
	hasTotal bool
	message  string
	isResult bool
	text     string
	hasError bool
}

func parseProgEvents(t *testing.T, raw string) []progEvent {
	t.Helper()
	var events []progEvent
	for _, l := range dataLines(raw) {
		var m map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(l, "data:"))), &m); err != nil {
			t.Fatalf("data 行不是合法 JSON-RPC：%v；原文 %q", err, l)
		}
		var ev progEvent
		ev.method, _ = m["method"].(string)
		if p, ok := m["params"].(map[string]any); ok {
			ev.progress, _ = p["progress"].(float64)
			ev.message, _ = p["message"].(string)
			_, ev.hasTotal = p["total"]
		}
		if e, ok := m["error"]; ok && e != nil {
			ev.hasError = true
		}
		if res, ok := m["result"].(map[string]any); ok {
			ev.isResult = true
			if cs, ok := res["content"].([]any); ok && len(cs) > 0 {
				if c0, ok := cs[0].(map[string]any); ok {
					ev.text, _ = c0["text"].(string)
				}
			}
		}
		events = append(events, ev)
	}
	return events
}

func runProgCall(t *testing.T, arm heartbeatArmer, withToken bool) []progEvent {
	t.Helper()
	ts := newMCPTestServer(t, mcpTestServerOptions{
		stateless: true,
		register:  progressTool(arm),
	})
	defer ts.Close()
	status, raw, _ := postJSON(t, ts.URL, progCallBody("prog", 150, withToken))
	if status != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200；体 %q", status, raw)
	}
	return parseProgEvents(t, raw)
}

// V-prog1：给了 `_meta.progressToken` ⇒ **结果之前**收到 N 条 notifications/progress、
// 值从 1 起单调递增、不传 total、结果事件完好。
func TestProgressHeartbeat_VProg1_WithToken(t *testing.T) {
	// 前置：20s 是客户端 60s 协议超时的 1/3（对齐 PiMoa server.ts:134）。间隔一旦 ≥60s，
	// 心跳永远赶不上客户端超时 ⇒ 这一层整个失效。
	if progressHeartbeatInterval <= 0 || progressHeartbeatInterval >= 60*time.Second {
		t.Fatalf("progressHeartbeatInterval=%s：必须 ∈ (0, 60s)", progressHeartbeatInterval)
	}

	arm := func(ctx context.Context, req *mcp.CallToolRequest) func() {
		return startProgressHeartbeat(ctx, req, progTestInterval, func(d time.Duration) string {
			return "hb:" + d.Truncate(time.Millisecond).String()
		})
	}
	events := runProgCall(t, arm, true)

	var progress []float64
	msgs := make([]string, 0, 4)
	lastProgIdx, resultIdx := -1, -1
	hasTotal := false
	resultText := ""
	for i, ev := range events {
		switch {
		case ev.method == "notifications/progress":
			progress = append(progress, ev.progress)
			msgs = append(msgs, ev.message)
			lastProgIdx = i
			hasTotal = hasTotal || ev.hasTotal
		case ev.isResult:
			resultIdx = i
			resultText = ev.text
		}
	}
	// F3.2：判据是**性质**，不是**条数**——「至少 1 条」+「从 1 起严格单调递增」（下面的循环）
	// +「都在结果之前」。原先的 `>= 2 条` 是刚性计数：工具体 150ms / 间隔 20ms 只是**期望** 7 条，
	// 机器一卡（调度停顿、GC、CI 抢占）就可能只跑到 1 条，于是**偶发假红**——而调度停顿不是
	// 实现错误，计数不该当判据。真值上界已由「结果之前」+「单调递增」两条锁住。
	if len(progress) < 1 {
		t.Fatalf("结果之前一条 progress 都没收到（工具体 150ms / 间隔 %s）——心跳压根没起表", progTestInterval)
	}
	for i, v := range progress {
		if v != float64(i+1) {
			t.Fatalf("progress 必须从 1 起单调递增：第 %d 条是 %v，期望 %d；全部=%v", i, v, i+1, progress)
		}
	}
	// 正向证据的另一半（与 V-prog3 合起来锁死「包装 ⇒ 内核 ⇒ 真的发」）：通知文字**确实出自
	// message 回调** ⇒ 循环体真的走到了「算消息 + NotifyProgress」那一行，而不是空转递增计数。
	for i, m := range msgs {
		if !strings.HasPrefix(m, "hb:") {
			t.Errorf("第 %d 条 progress 的 message=%q 不是 message 回调产出（心跳循环体没走到发送那一行？）", i, m)
		}
	}
	if hasTotal {
		t.Errorf("progress 通知里不该出现 total（总量未知，规范要求递增即可）")
	}
	if resultIdx < 0 {
		t.Fatalf("结果事件丢了（事件数 %d）", len(events))
	}
	if lastProgIdx > resultIdx {
		t.Errorf("progress 必须在结果**之前**：最后一条 progress 在下标 %d，结果在下标 %d", lastProgIdx, resultIdx)
	}
	if resultText != "done-prog" {
		t.Errorf("结果内容 %q，期望 \"done-prog\"", resultText)
	}
	t.Logf("收到 %d 条 progress %v（都在结果之前，无 total），结果事件完好", len(progress), progress)
}

// V-prog2：没给 token ⇒ **一条都不许发**（层① 对 DSH 零影响的机械保证）。
func TestProgressHeartbeat_VProg2_NoTokenSendsNothing(t *testing.T) {
	cases := []struct {
		name      string
		arm       heartbeatArmer
		withToken bool
	}{
		{
			name: "内核（短间隔）：没给 token ⇒ 零通知、结果完好",
			arm: func(ctx context.Context, req *mcp.CallToolRequest) func() {
				return startProgressHeartbeat(ctx, req, progTestInterval, nil)
			},
			withToken: false,
		},
		{
			name: "生产包装（20s）：没给 token ⇒ 零通知、结果完好",
			arm: func(ctx context.Context, req *mcp.CallToolRequest) func() {
				return StartProgressHeartbeat(ctx, req, nil)
			},
			withToken: false,
		},
		{
			// 反向断言：生产包装在生产间隔下，测试窗口内不该有任何通知 ——
			// 证明生产间隔没被误改成毫秒级（否则这一层会在真机上每 20ms 刷一条通知）。
			// ⚠️ 这条是**单侧**的（永不启动心跳的包装也能过）⇒ 正向的另一半由 V-prog3 补：
			// 同一条导出包装路径在 token 在场时**确实起了**内核心跳 goroutine。
			name: "生产包装（20s）：给了 token 也不该在 150ms 窗口内发（间隔是 20s 量级）",
			arm: func(ctx context.Context, req *mcp.CallToolRequest) func() {
				return StartProgressHeartbeat(ctx, req, func(time.Duration) string { return "x" })
			},
			withToken: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			events := runProgCall(t, tc.arm, tc.withToken)
			nProg, nResult := 0, 0
			for _, ev := range events {
				if ev.method == "notifications/progress" {
					nProg++
				}
				if ev.isResult {
					nResult++
				}
			}
			if nProg != 0 {
				t.Errorf("期望一条 progress 都不发，实得 %d 条", nProg)
			}
			if nResult != 1 {
				t.Errorf("期望恰好 1 条结果事件，实得 %d 条", nResult)
			}
		})
	}
}

// gatedProgressTool 造一个「武装后先报到、再卡在闸门上」的工具体：让测试能在**心跳已起表、
// handler 仍在飞**的时刻抓一次 goroutine 栈快照——那是唯一能确定性观测到 ticker goroutine 的
// 窗口（不必 sleep 竞猜）。起表点与两个真壳同形：handler 闭包第一行 defer，用的是**导出包装**。
func gatedProgressTool(armed chan<- struct{}, release <-chan struct{}) func(*mcp.Server) {
	return func(s *mcp.Server) {
		mcp.AddTool(s, &mcp.Tool{Name: "work", Description: "gated work with progress heartbeat"},
			func(ctx context.Context, req *mcp.CallToolRequest, in progWorkIn) (*mcp.CallToolResult, any, error) {
				defer StartProgressHeartbeat(ctx, req, func(time.Duration) string { return "gate" })()
				select {
				case armed <- struct{}{}:
				default: // 只报到一次；万一同一次调用被重放也不会把 handler 卡死（否则 ts.Close 会挂住）
				}
				select {
				case <-release:
				case <-ctx.Done():
					return nil, nil, ctx.Err()
				}
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "done-" + in.Tag}}}, nil, nil
			})
	}
}

// countKernelHeartbeatFrames 数一次全量 goroutine 栈快照里命中**内核心跳源文件**的行数：
// 每条起表 goroutine 贡献 2 行（闭包帧 + "created by …" 行）⇒ ≥1 即「起了表」。
//
// 判据用源文件而不是函数名：万一内核被内联进导出包装，"created by" 行会换成包装的函数名，
// 但两行都仍然指回同一个源文件；用文件串比用函数名串抗改名/抗内联。
func countKernelHeartbeatFrames(frame string) int {
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	return strings.Count(string(buf[:n]), frame)
}

// V-prog3：**正向**证据——导出包装在收到 token 时，确实武装了内核那条真心跳 goroutine
// （V-prog2 第三个子例只有单侧断言：永不启动心跳的包装照样能过）。
//
// 【为什么不能直接等 20s】导出包装的间隔是编译期常量 progressHeartbeatInterval = 20s，包装与
// 内核之间**没有间隔注入点**（只有内核带 interval 入参），真等一跳要 20s+ 墙钟，而本包整套
// 用例才 20s——为一条断言把回归耗时翻倍不划算。⇒ 用**两步等价证据**拼出「包装 ⇒ 真的会发」：
//
//	① 本用例：在生产同一条导出入口上，趁 handler 还卡在闸门里抓 goroutine 栈快照，断言内核心跳
//	   goroutine **活着**；同一形状但没 token 的对照臂必须抓到 0 条 ⇒ 包装确实在 token 在场时
//	   起了表（若包装被改成永不启动心跳，这条立刻红）。
//	② V-prog1：内核在同一 message 契约下（可注入短间隔）确实在**结果之前**发出了递增的
//	   progress，且通知文字确实出自 message 回调 ⇒ 那条 goroutine 的循环体真的会发。
//
// 取舍：不覆盖「20s 真的到点」这个纯时间事实（那是 time.Ticker 的语义），覆盖的是本模块自己
// 写的那两件事——「包装会起表」+「起了表的循环体会发」。
func TestProgressHeartbeat_VProg3_ExportedWrapperArmsRealTicker(t *testing.T) {
	// 内核在 mcpshell/progress.go；注意 progress_test.go 的栈行不含本串（`_test` 挡在 `progress`
	// 与 `.go` 之间），所以本用例不会被自己的测试帧误命中。
	const kernelFrame = "mcpshell/progress.go:"

	run := func(t *testing.T, withToken bool) int {
		t.Helper()
		armed := make(chan struct{}, 1)
		release := make(chan struct{})
		ts := newMCPTestServer(t, mcpTestServerOptions{
			stateless: true, // 不套 withSSEKeepalive：本用例只看层①（progress）的起表
			register:  gatedProgressTool(armed, release),
		})
		defer ts.Close()

		type callRes struct {
			status int
			raw    string
			err    error
		}
		resCh := make(chan callRes, 1)
		// postJSONRaw 不接 *testing.T（t.Fatal 只能在测试 goroutine 里调），故可安全地在子
		// goroutine 里发这次请求：测试 goroutine 留在外面等 handler 报到。
		go func() {
			status, raw, _, err := postJSONRaw(http.DefaultClient, ts.URL, progCallBody("gate", 1, withToken))
			resCh <- callRes{status, raw, err}
		}()

		select {
		case <-armed:
		case <-time.After(10 * time.Second):
			t.Fatal("10s 内 handler 没报到：工具压根没被调用？")
		}
		// 此刻 handler 仍卡在闸门里 ⇒ 若心跳起了表，它的 goroutine 必然已存在（`go` 语句在 arm()
		// 返回前就已执行）⇒ 快照是确定性的，不需要 sleep 竞猜。
		n := countKernelHeartbeatFrames(kernelFrame)

		close(release)
		res := <-resCh
		if res.err != nil || res.status != http.StatusOK {
			t.Fatalf("调用失败：status=%d err=%v body=%q", res.status, res.err, res.raw)
		}
		if nKeep := countKeepalive(res.raw); nKeep != 0 {
			t.Errorf("本用例没套 withSSEKeepalive，响应里不该有保活注释行，实得 %d 条：%q", nKeep, res.raw)
		}
		return n
	}

	if got := run(t, false); got != 0 {
		t.Errorf("对照臂（没给 token）抓到 %d 行内核心跳栈帧，期望 0：没 token 一条都不许发、更不该起表", got)
	}
	if got := run(t, true); got < 1 {
		t.Errorf("导出包装（给了 token）在 handler 在飞期间没有任何内核心跳 goroutine ⇒ 包装没起表（被改成永不启动心跳？）")
	} else {
		t.Logf("导出包装（token 在场）：handler 在飞期间抓到 %d 行内核心跳栈帧（≥1 即已起表）", got)
	}
}
