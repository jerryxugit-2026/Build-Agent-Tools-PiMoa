package mcpshell

// SSE 保活（层②）回归：V-neg / V-neg2 / V-neg3 / V-pos / V-loop / V-leak / V-const /
// V-mount / V-env / V-body413 / V-abort / V-goroutine-path / V-race。
//
// 用例形态移植自 PiMoa 的 test/sse_keepalive.test.ts（真 HTTP 环回、脱网脱 key，不碰任何
// 常驻服务），并按 Go 侧事实改写：Go 只有一条写头路径（故 PiMoa ①b 那条「两条 setHeader
// 路径」的反例退化成 V-neg2 的 http.Error 反例）；Go 的 SDK 只 Set 头、不发头（故守卫反过来写）。
//
// 【⚠️ 本文件覆盖到哪、覆盖不到哪 —— 别把它读成比实际更强的保证】
//   覆盖：保活守卫本身（withSSEKeepalive / keepaliveWriter / StartKeepalive）的写入条件、
//         起表点语义、并发与清理。
//   **不覆盖**：mcpshell/shell.go 的 serveHTTP 里那两行接线（Config.SSEKeepalive →
//         envKeepaliveInterval → withSSEKeepalive）。本文件按测试需要自行拼装
//         withSSEKeepalive ⇒ **把 serveHTTP 里那段接线整段删掉，本文件一条都不会红**。
//         接线点只能靠真跑覆盖（重编真二进制 + 真客户端打真请求，由主代理在真机验收里做）。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ───────────────────────── 公共夹具 ─────────────────────────

// countKeepalive 只数**保活注释行**（SSE 注释 = 行首 `:`），不与正文里可能出现的冒号混淆。
func countKeepalive(raw string) int { return strings.Count(raw, ": keepalive") }

// dataLines 取出所有 `data:` 行（真实事件行；保活注释行不是 data 行）。
func dataLines(raw string) []string {
	var out []string
	for _, l := range strings.Split(raw, "\n") {
		if strings.HasPrefix(l, "data:") {
			out = append(out, l)
		}
	}
	return out
}

// postJSONRaw 发一次 MCP 形态的 POST（Accept 同时给 json 与 event-stream ⇒ 走 SSE 回包），
// 返回状态码与完整响应体。**不接 *testing.T**：V-goroutine-path 的并发臂要在子 goroutine 里调它，
// 而 t.Fatal 只能在测试 goroutine 里调。
func postJSONRaw(client *http.Client, url, body string) (int, string, http.Header, error) {
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, "", resp.Header, err
	}
	return resp.StatusCode, string(raw), resp.Header, nil
}

func postJSON(t *testing.T, url, body string) (int, string, http.Header) {
	t.Helper()
	status, raw, hdr, err := postJSONRaw(http.DefaultClient, url, body)
	if err != nil {
		t.Fatalf("POST %s 失败: %v", url, err)
	}
	return status, raw, hdr
}

// mcpTestServerOptions 描述一个测试用的壳：真 mcp.Server + 真 StreamableHTTPHandler + httptest。
type mcpTestServerOptions struct {
	stateless bool
	interval  time.Duration // >0 ⇒ 套 withSSEKeepalive（= serveHTTP 的接线形态，但**不是**那段接线本身）
	bodyLimit bool          // 额外套 withBodyLimit（与 serveHTTP 同序：limit 在外、keepalive 在内）
	register  func(*mcp.Server)
}

func newMCPTestServer(t *testing.T, o mcpTestServerOptions) *httptest.Server {
	t.Helper()
	srv := mcp.NewServer(&mcp.Implementation{Name: "keepalive-test", Version: "0.0.0"}, nil)
	if o.register != nil {
		o.register(srv)
	}
	h := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{Stateless: o.stateless},
	)
	var inner http.Handler = h
	if o.interval > 0 {
		inner = withSSEKeepalive(h, o.interval)
	}
	if o.bodyLimit {
		inner = withBodyLimit(inner)
	}
	return httptest.NewServer(inner)
}

type kaSleepIn struct {
	Millis int    `json:"millis"`
	Tag    string `json:"tag"`
}

type kaSleepOut struct {
	SleptSeconds float64 `json:"slept_seconds"`
	Tag          string  `json:"tag"`
}

// sleepTool 造一个「慢工具」。armed 决定 handler 里挂不挂起表点——
// V-race 的阴性对照就是同一个 handler 去掉那一行。
func sleepTool(armed bool) func(*mcp.Server) {
	return func(s *mcp.Server) {
		mcp.AddTool(s, &mcp.Tool{Name: "sleep", Description: "sleep then return"},
			func(ctx context.Context, _ *mcp.CallToolRequest, in kaSleepIn) (*mcp.CallToolResult, kaSleepOut, error) {
				if armed {
					defer StartKeepalive(ctx)() // ★ 起表点：handler 闭包第一行（与两个真壳同形）
				}
				start := time.Now()
				select {
				case <-time.After(time.Duration(in.Millis) * time.Millisecond):
				case <-ctx.Done():
					return nil, kaSleepOut{}, ctx.Err()
				}
				return &mcp.CallToolResult{
						Content: []mcp.Content{&mcp.TextContent{Text: "slept-" + in.Tag}},
					},
					kaSleepOut{SleptSeconds: time.Since(start).Seconds(), Tag: in.Tag}, nil
			})
	}
}

// toolCallBody 拼一次 tools/call 的请求体；progressToken 非空时带上 `_meta.progressToken`。
func toolCallBody(id int, tag string, millis int, progressToken string) string {
	meta := ""
	if progressToken != "" {
		meta = `,"_meta":{"progressToken":"` + progressToken + `"}`
	}
	return fmt.Sprintf(
		`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"sleep","arguments":{"millis":%d,"tag":%q}%s}}`,
		id, millis, tag, meta)
}

// readTrackingFirstData 读到首个 `data:` 出现为止，返回「首个 data: 之前的前缀」与完整正文。
// 事后读全量正文是看不出先后顺序的——「保活期间零 data:」只能这样断言。
func readTrackingFirstData(t *testing.T, body io.Reader) (prefix, full string) {
	t.Helper()
	var sb strings.Builder
	buf := make([]byte, 512)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if i := strings.Index(sb.String(), "data:"); i >= 0 {
			rest, _ := io.ReadAll(body)
			sb.Write(rest)
			return sb.String()[:i], sb.String()
		}
		if err != nil {
			return sb.String(), sb.String()
		}
	}
}

// ───────────────────────── V-neg / V-neg2 / V-neg3 ─────────────────────────

// V-neg：JSON 形态响应**零保活字节**。两阶段：① Content-Type 尚未声明时烧穿若干 tick；
// ② 声明为 application/json 后再烧穿。
// 第二个 case 是**阳性对照**（同序声明 SSE ⇒ 保活确实发生），用来证明「零字节」不是
// 「ticker 压根没跑」的假绿。
func TestKeepalive_VNeg_JSONNeverDirtied(t *testing.T) {
	const tick = 20 * time.Millisecond
	const burn = 3 // 每阶段烧穿的 tick 数
	payload := `{"jsonrpc":"2.0","id":1,"result":{"ok":true,"nested":{"a":[1,2,3]}}}`

	newHandler := func(declare string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer StartKeepalive(r.Context())()
			kw, ok := w.(*keepaliveWriter)
			if !ok {
				t.Errorf("中间件没把 *keepaliveWriter 交给下游 handler")
				return
			}
			// 阶段 A：形态尚未声明，烧穿若干 tick —— 一个字节都不该写。
			time.Sleep(burn * tick)
			// 阶段 B：声明形态，再烧穿若干 tick。设头走包装体**同一把锁**（白盒）：
			// ticker 正是持这把锁读头 map，不加锁地中途设头会让**测试自己**造出一处竞争，
			// 那不是被测代码的问题。
			kw.mu.Lock()
			kw.ResponseWriter.Header().Set("Content-Type", declare)
			kw.mu.Unlock()
			time.Sleep(burn * tick)
			_, _ = io.WriteString(w, payload)
		})
	}

	cases := []struct {
		name      string
		declare   string
		wantExact bool // true ⇒ 断言「零保活 + 体逐字节不变」；false ⇒ 断言「保活确实出现」
	}{
		{"声明 application/json：零保活字节、体逐字节不变", "application/json", true},
		{"阳性对照：同序声明 text/event-stream ⇒ 保活确实发生", "text/event-stream", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(withSSEKeepalive(newHandler(tc.declare), tick))
			defer ts.Close()
			status, raw, hdr := postJSON(t, ts.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
			if status != http.StatusOK {
				t.Fatalf("状态码 %d，期望 200", status)
			}
			if got := hdr.Get("Content-Type"); !strings.HasPrefix(got, tc.declare) {
				t.Errorf("响应 content-type=%q，期望 %q（前缀）", got, tc.declare)
			}
			n := countKeepalive(raw)
			if tc.wantExact {
				if n != 0 {
					t.Errorf("JSON 形态被插入 %d 条保活注释：%q", n, raw)
				}
				if raw != payload {
					t.Errorf("响应体被插脏：实收 %d 字节 / 期望 %d 字节；原文 %q", len(raw), len(payload), raw)
				}
				if !json.Valid([]byte(raw)) {
					t.Errorf("响应体不再是合法 JSON：%q", raw)
				}
			} else if n == 0 {
				t.Errorf("阳性对照失守：SSE 形态下一条保活都没写（说明这轮测试的 ticker 压根没跑，" +
					"上面那条「零字节」是假绿）")
			}
		})
	}
}

// V-neg2：用 http.Error 直出 4xx。判据 = 与**不经中间件**的同 handler 逐字节相同 + 零保活字节。
// 同 shape 的阳性对照是 V-neg3（声明 SSE 后走同一段 http.Error —— 那时保活已写出）。
//
// ⚠️ 顺序纪律：**先 stop 再 http.Error**。keepaliveWriter 有意不覆写 Header()（设计稿 §3.2），
// 所以「ticker 还活着时又有人写头 map」这种形状本身就会与 touch() 的 `Header().Get` 竞争。
// 生产路径上它是不可达的：4xx（含 withBodyLimit 的读体失败）都发生在工具 handler 起表**之前**，
// 而工具 handler 之后的 SDK 写发生在 stop() 之后。mock 必须守同一顺序，否则是**测试自己**
// 造出一处生产不可能有的竞争（本单第一版就是这么错的，-race 当场报红）。
func TestKeepalive_VNeg2_HTTPErrorUnchanged(t *testing.T) {
	const tick = 20 * time.Millisecond
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stop := StartKeepalive(r.Context())
		time.Sleep(3 * tick) // 烧穿若干 tick：证明「零字节」不是「来不及写」
		stop()               // 停表后再写错误响应（见上方顺序纪律）
		http.Error(w, "boom", http.StatusBadRequest)
	})
	bare := httptest.NewServer(handler)
	defer bare.Close()
	wrapped := httptest.NewServer(withSSEKeepalive(handler, tick))
	defer wrapped.Close()

	s1, b1, h1 := postJSON(t, bare.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	s2, b2, h2 := postJSON(t, wrapped.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)

	if s1 != http.StatusBadRequest || s2 != http.StatusBadRequest {
		t.Errorf("状态码 裸=%d 保活=%d，都期望 400", s1, s2)
	}
	if b1 != b2 {
		t.Errorf("响应体被改动：裸=%q 保活=%q", b1, b2)
	}
	if b2 != "boom\n" {
		t.Errorf("响应体 %q，期望 %q", b2, "boom\n")
	}
	if h1.Get("Content-Type") != h2.Get("Content-Type") {
		t.Errorf("content-type 被改动：裸=%q 保活=%q", h1.Get("Content-Type"), h2.Get("Content-Type"))
	}
	if n := countKeepalive(b2); n != 0 {
		t.Errorf("4xx 响应被插入 %d 条保活注释：%q", n, b2)
	}
}

// V-neg3：「先声明 SSE、起表、等 2 个 tick、再试图 http.Error(500)」这条残余风险路径。
// 判据（2026-09-22 由探针 repro/neg3_probe_test.go 钉死）：① 状态码锁死 200；② 保活注释行已写出；
// ③ 错误文本被追加进 SSE 体；④ 体里没有合法 JSON-RPC 结果 ⇒ 客户端不会误判成业务成功。
func TestKeepalive_VNeg3_ErrorAfterKeepalive(t *testing.T) {
	const tick = 40 * time.Millisecond
	ts := httptest.NewServer(withSSEKeepalive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ⚠️ 先设头、后起表：真壳里 SDK 是在 handler 之前设好头的；
		// 这里若把起表放前面，ticker 会和这行 Set 争头 map —— 那是测试自己造的竞争。
		w.Header().Set("Content-Type", "text/event-stream") // 模拟 SDK 的「只 Set、不发头」
		stop := StartKeepalive(r.Context())
		time.Sleep(2*tick + tick/2) // 业务在第 2 个 tick 之后才失败
		// 同上一条的顺序纪律：http.Error 会改头 map，必须在 ticker 停掉之后再调，
		// 否则 mock 自己就与 touch() 争头 map（生产上这条路径同样是「先无 ticker、后有错误」）。
		stop()
		http.Error(w, "boom: 业务在第 2 个 tick 之后才失败", http.StatusInternalServerError)
	}), tick))
	defer ts.Close()

	status, raw, _ := postJSON(t, ts.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	n := countKeepalive(raw)
	t.Logf("状态码=%d 保活行=%d 体=%q", status, n, raw)

	if status != http.StatusOK {
		t.Errorf("期望状态码被锁死在 200（头已被保活第一跳送出去，之后改不了），实得 %d", status)
	}
	if n == 0 {
		t.Errorf("期望保活注释行已写出——这是本场景与「无保活版本」唯一的可观测差别")
	}
	if !strings.Contains(raw, "boom") {
		t.Errorf("期望错误文本被追加进 SSE 体，实得 %q", raw)
	}
	if strings.Contains(raw, `"jsonrpc"`) {
		t.Errorf("体里不该出现合法 JSON-RPC 结果（否则客户端会误判为业务成功）：%q", raw)
	}
}

// ───────────────────────── V-pos / V-loop ─────────────────────────

// V-pos：SSE 形态下注释行**周期**出现、真实事件不被破坏。
func TestKeepalive_VPos_SSECommentCadence(t *testing.T) {
	const tick = 20 * time.Millisecond
	const ticks = 6
	ev := func(phase string) string {
		return "event: message\ndata: " +
			`{"jsonrpc":"2.0","id":1,"result":{"phase":"` + phase + `"}}` + "\n\n"
	}
	ts := httptest.NewServer(withSSEKeepalive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream") // 先声明形态，再起表（见 V-neg3 注释）
		defer StartKeepalive(r.Context())()
		_, _ = io.WriteString(w, ev("first"))
		time.Sleep(ticks * tick) // 静默窗口：保活应当补进来
		_, _ = io.WriteString(w, ev("second"))
	}), tick))
	defer ts.Close()

	status, raw, hdr := postJSON(t, ts.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if status != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200", status)
	}
	if got := hdr.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Errorf("content-type=%q，期望 text/event-stream", got)
	}
	n := countKeepalive(raw)
	if n < 2 {
		t.Errorf("保活注释行只收到 %d 条，期望 ≥2（静默窗口 %s / 间隔 %s）", n, ticks*tick, tick)
	}
	if !strings.Contains(raw, ": keepalive\n\n") {
		t.Errorf("保活字节不是标准 SSE 注释行形态 `: keepalive` + 空行：%q", raw)
	}
	dl := dataLines(raw)
	if len(dl) != 2 {
		t.Fatalf("期望恰好 2 条真实 data 事件，实得 %d：%q", len(dl), raw)
	}
	for i, l := range dl {
		if !json.Valid([]byte(strings.TrimSpace(strings.TrimPrefix(l, "data:")))) {
			t.Errorf("第 %d 条 data 事件不是合法 JSON（保活把它切碎了）：%q", i+1, l)
		}
	}
	if !strings.Contains(raw, `"phase":"first"`) || !strings.Contains(raw, `"phase":"second"`) {
		t.Errorf("首/末两条事件内容不完整：%q", raw)
	}
}

// V-loop：真 mcp.Server + 真 StreamableHTTPHandler + 慢工具。断言保活期间**零 `data:`**、
// 结束后恰好 1 条结果且 `structuredContent` 完好。
func TestKeepalive_VLoop_RealTransport(t *testing.T) {
	const interval = 20 * time.Millisecond
	ts := newMCPTestServer(t, mcpTestServerOptions{
		stateless: true,
		interval:  interval,
		register:  sleepTool(true),
	})
	defer ts.Close()

	req, err := http.NewRequest(http.MethodPost, ts.URL, strings.NewReader(toolCallBody(1, "loop", 120, "")))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200", resp.StatusCode)
	}
	prefix, full := readTrackingFirstData(t, resp.Body)

	if !strings.Contains(prefix, "data:") && strings.TrimSpace(prefix) == "" {
		t.Errorf("首个 data: 之前一个字节都没有 —— 保活没生效（prefix=%q）", prefix)
	}
	if !strings.Contains(prefix, ": keepalive") {
		t.Errorf("保活期间（首个 data: 之前）没有保活注释行：prefix=%q", prefix)
	}
	if c := strings.Count(prefix, "data:"); c != 0 {
		t.Errorf("保活期间出现了 %d 条 data:（结果事件必须在工具结束后才到）：prefix=%q", c, prefix)
	}
	dl := dataLines(full)
	if len(dl) != 1 {
		t.Fatalf("期望恰好 1 条结果事件，实得 %d：%q", len(dl), full)
	}
	var msg struct {
		ID     any `json:"id"`
		Result *struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			StructuredContent *kaSleepOut `json:"structuredContent"`
		} `json:"result"`
		Error any `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(dl[0], "data:"))), &msg); err != nil {
		t.Fatalf("结果事件不是合法 JSON-RPC：%v；原文 %q", err, dl[0])
	}
	if msg.Error != nil {
		t.Errorf("结果里带了 error：%v", msg.Error)
	}
	if msg.Result == nil || msg.Result.StructuredContent == nil {
		t.Fatalf("structuredContent 丢了：%q", dl[0])
	}
	if msg.Result.StructuredContent.Tag != "loop" {
		t.Errorf("structuredContent.tag=%q，期望 \"loop\"", msg.Result.StructuredContent.Tag)
	}
	if len(msg.Result.Content) != 1 || msg.Result.Content[0].Text != "slept-loop" {
		t.Errorf("content 不完整：%+v", msg.Result.Content)
	}
	t.Logf("保活 %d 条（首个 data: 之前），结果事件 1 条，structuredContent=%+v",
		countKeepalive(prefix), *msg.Result.StructuredContent)
}

// ───────────────────────── V-leak / V-const / V-mount / V-env ─────────────────────────

// V-leak：连打 200 次快调用，goroutine 数回基线。
// （不引 goleak：本模块「不引入新依赖」，用 runtime.NumGoroutine + 有界等待。）
func TestKeepalive_VLeak_FastCallsReturnToBaseline(t *testing.T) {
	const interval = 5 * time.Millisecond
	ts := newMCPTestServer(t, mcpTestServerOptions{
		stateless: true,
		interval:  interval,
		register:  sleepTool(true),
	})
	defer ts.Close()

	call := func(i int) {
		t.Helper()
		status, raw, _ := postJSON(t, ts.URL, toolCallBody(i, "leak", 1, ""))
		if status != http.StatusOK || !strings.Contains(raw, `"text":"slept-leak"`) {
			t.Fatalf("第 %d 次调用没拿到结果：status=%d body=%q", i, status, raw)
		}
	}
	// 预热：让 http 连接池与 httptest 的服务 goroutine 先起来，基线才稳。
	for i := 0; i < 5; i++ {
		call(i)
	}
	baseline := runtime.NumGoroutine()
	for i := 0; i < 200; i++ {
		call(i)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		got := runtime.NumGoroutine()
		if got <= baseline {
			t.Logf("200 次快调用后 goroutine 回基线：%d → %d", baseline, got)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("goroutine 未回基线：baseline=%d 现在=%d（疑似保活 ticker 泄漏）", baseline, got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// V-const：保活间隔与 undici（DSH 的 MCP 客户端传输栈）300s 空闲上限的量级关系。
func TestKeepalive_VConst_IntervalVsClientTimeout(t *testing.T) {
	const undiciTimeout = 300 * time.Second
	if sseKeepaliveInterval <= 0 {
		t.Fatalf("sseKeepaliveInterval=%s，必须是正的", sseKeepaliveInterval)
	}
	if sseKeepaliveInterval*20 > undiciTimeout {
		t.Errorf("sseKeepaliveInterval=%s：×20 = %s 超过 undici 的 %s —— 余量不足",
			sseKeepaliveInterval, sseKeepaliveInterval*20, undiciTimeout)
	}
	// ⚠️ 「调大即静默失效」：Go 在首次 body Write 之前**一个字节都不上网卡**——
	// WriteHeader(200) 只翻状态、不发头块，真正把响应头送出去的是保活第一跳的 Write+Flush。
	// 所以本间隔同时受 headersTimeout 约束：一旦 ≥ 客户端的 headersTimeout，客户端连响应头都
	// 等不到，修复不是「慢一点」而是**回到改前的病症**（长调用中途回包凭空消失）。
	if sseKeepaliveInterval >= undiciTimeout {
		t.Errorf("sseKeepaliveInterval=%s ≥ 客户端 headersTimeout %s ⇒ 连响应头都送不出去，修复静默失效",
			sseKeepaliveInterval, undiciTimeout)
	}
	t.Logf("sseKeepaliveInterval=%s；undici headersTimeout/bodyTimeout 默认 %s ⇒ 余量 %d 倍",
		sseKeepaliveInterval, undiciTimeout, int(undiciTimeout/sseKeepaliveInterval))
}

// V-mount：Go 侧有意不做 PiMoa 那条 isToolsCallBody 挂载判据（安全边界在 content-type 守卫）。
// 这里断言等价性质：非 tools/call 的 POST（initialize / tools/list / 通知）一个字节都不会被写脏。
func TestKeepalive_VMount_NonToolCallPostsNotDirtied(t *testing.T) {
	const interval = 5 * time.Millisecond
	ts := newMCPTestServer(t, mcpTestServerOptions{
		stateless: true,
		interval:  interval,
		register:  sleepTool(true),
	})
	defer ts.Close()

	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ka-test","version":"0"}}}`
	status, raw, _ := postJSON(t, ts.URL, initBody)
	if status != http.StatusOK || !strings.Contains(raw, "serverInfo") {
		t.Errorf("initialize 应答异常：status=%d body=%q", status, raw)
	}
	if n := countKeepalive(raw); n != 0 {
		t.Errorf("initialize 响应被插入 %d 条保活：%q", n, raw)
	}

	status, raw, _ = postJSON(t, ts.URL, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if status != http.StatusOK || !strings.Contains(raw, `"tools"`) {
		t.Errorf("tools/list 应答异常：status=%d body=%q", status, raw)
	}
	if n := countKeepalive(raw); n != 0 {
		t.Errorf("tools/list 响应被插入 %d 条保活：%q", n, raw)
	}

	status, raw, _ = postJSON(t, ts.URL, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if status != http.StatusAccepted {
		t.Errorf("通知的应答状态 %d，期望 202", status)
	}
	if raw != "" {
		t.Errorf("通知的应答体应当为空，实得 %q", raw)
	}
}

// V-env：`=0` / `=off` / `=false` 都真的不武装；非法值才回落默认；**未 opt-in 的壳 env 点不着火**；
// env 调大到越过 V-const 余量时**仍然生效（不 clamp）但必须告警**。
// 专锁设计稿 §3.2 那个「EnvDuration 把 0 当坏值 ⇒ 关不掉」的缺陷，外加对抗审抓到的两条：
//
//	F2（接线审）：env 能给**没 opt-in 的壳**点火 ⇒「devkb / claude-dispatch 逐字节不变」从
//	   绝对承诺降级成条件承诺。判据：fallback（= Config.SSEKeepalive）<= 0 ⇒ 恒返回 0。
//	F1（并发核心审）：env 间隔**没有上界**，调大即静默失效（首个保活字节要等这么久，而客户端
//	   undici 的空闲界只有 300s）。判据 = V-const 的同一条不等式 interval×20 > 300s ⇒ 必须告警。
//
// ⚠️ 本用例锁的是**决策函数**（env → 间隔），不是 serveHTTP 里那两行接线本身：接线是
// `if interval > 0 { withSSEKeepalive(...) }`，interval 恒为 0 时不可能被武装，F2 的语义因此
// 在这里可被完整判定；接线点本身仍要靠真跑验收（见本文件头部说明）。
func TestKeepalive_VEnv_DisableAndFallback(t *testing.T) {
	const fallback = 15 * time.Second
	cases := []struct {
		name string
		raw  string
		want time.Duration
	}{
		{"未设置 ⇒ 回落 Config 值", "", fallback},
		{"=0 ⇒ 显式关闭", "0", 0},
		{"=off ⇒ 显式关闭", "off", 0},
		{"=false ⇒ 显式关闭", "false", 0},
		{"大小写与首尾空白不敏感", "  OFF  ", 0},
		{"=90s ⇒ 90s", "90s", 90 * time.Second},
		{"纯数字按毫秒", "1500", 1500 * time.Millisecond},
		{"非法值回落默认（不是关）", "abc", fallback},
		{"=0s 不是关闭语法 ⇒ 回落默认（EnvDuration 语法的零是坏值）", "0s", fallback},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KA_TEST_SSE_KEEPALIVE", tc.raw)
			if got := envKeepaliveInterval("KA_TEST_SSE_KEEPALIVE", fallback, nil); got != tc.want {
				t.Errorf("envKeepaliveInterval(%q)=%s，期望 %s", tc.raw, got, tc.want)
			}
		})
	}

	// —— F2：env 只能给**已 opt-in 的壳**调优 / 急停，不能给没 opt-in 的壳点火 ——
	// fallback 就是 Config.SSEKeepalive；0 的含义是「这个壳压根没开保活」。
	notOptedIn := []struct {
		name string
		raw  string
	}{
		{"未 opt-in + env 未设置 ⇒ 零保活", ""},
		{"未 opt-in + env=90s（正时长）⇒ 仍然零保活", "90s"},
		{"未 opt-in + env=10m（大到越界也不点火）⇒ 零保活", "10m"},
		{"未 opt-in + env=1（纯数字毫秒，最小正时长）⇒ 零保活", "1"},
		{"未 opt-in + env=off ⇒ 零保活（急停语义在未 opt-in 时同样是零）", "off"},
		{"未 opt-in + env=abc（非法值也不许回流成「默认开」）⇒ 零保活", "abc"},
	}
	for _, tc := range notOptedIn {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KA_TEST_SSE_KEEPALIVE", tc.raw)
			if got := envKeepaliveInterval("KA_TEST_SSE_KEEPALIVE", 0, nil); got != 0 {
				t.Errorf("Config.SSEKeepalive=0（未 opt-in）+ env=%q ⇒ 得到 %s，期望 0：env 不得点火", tc.raw, got)
			}
		})
	}

	// —— F1：env 调大越过 V-const 余量 ⇒ **仍然生效（不 clamp）**，但必须把后果喊出来 ——
	for _, tc := range []struct {
		name     string
		raw      string
		want     time.Duration
		wantWarn bool
	}{
		{"env=10m：×20=200m ≫ 300s ⇒ 生效且告警", "10m", 10 * time.Minute, true},
		{"边界 16s：×20=320s 刚越界 ⇒ 生效且告警", "16s", 16 * time.Second, true},
		{"边界 15s：×20=300s 恰好打平（= V-const 的默认值）⇒ 不告警", "15s", 15 * time.Second, false},
		{"14s：余量更足 ⇒ 不告警", "14s", 14 * time.Second, false},
		{"非法值回落默认 ⇒ 无上界告警（EnvDuration 另有坏值告警，与余量无关）", "abc", fallback, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KA_TEST_SSE_KEEPALIVE", tc.raw)
			var buf bytes.Buffer
			got := envKeepaliveInterval("KA_TEST_SSE_KEEPALIVE", fallback, log.New(&buf, "", 0))
			if got != tc.want {
				t.Errorf("env=%q ⇒ %s，期望 %s（越界值必须原样生效，不得 clamp / 改写运维取值）", tc.raw, got, tc.want)
			}
			out := buf.String()
			if !tc.wantWarn {
				// 只禁止**上界**告警：坏值那一路 EnvDuration 自己会警告（合法且必要），
				// 与本用例判的「余量越界」是两件事。
				if strings.Contains(out, "过大") {
					t.Errorf("env=%q 没越过 V-const 余量，不该有上界告警；实际=%q", tc.raw, out)
				}
				return
			}
			if out == "" {
				t.Fatalf("env=%q 越过 V-const 余量却零告警：运维无从发现「保活静默失效」", tc.raw)
			}
			// 告警必须**点出后果**（不是只报一个数）：关键词缺任一 ⇒ 运维读不出该改什么。
			for _, kw := range []string{"KA_TEST_SSE_KEEPALIVE", "过大", "静默失效", "300s", "建议 ≤15s"} {
				if !strings.Contains(out, kw) {
					t.Errorf("告警缺关键字 %q；实际告警=%q", kw, out)
				}
			}
			t.Logf("告警原文：%s", strings.TrimSpace(out))
		})
	}

	// —— F1 的另一半：上界**只针对从 env 读到的值** ——
	// Config.SSEKeepalive 是代码常量，由 V-const 直接锁；env 未设置时本函数连告警都不该有。
	t.Run("env 未设置时即使 Config 值很大也不告警（上界只管 env）", func(t *testing.T) {
		t.Setenv("KA_TEST_SSE_KEEPALIVE", "")
		var buf bytes.Buffer
		got := envKeepaliveInterval("KA_TEST_SSE_KEEPALIVE", 10*time.Minute, log.New(&buf, "", 0))
		if got != 10*time.Minute {
			t.Errorf("env 未设置 ⇒ 回落 Config 值 10m，实得 %s", got)
		}
		if buf.Len() != 0 {
			t.Errorf("上界告警只针对 env 读到的值，Config 常量（由 V-const 管）不该在这里告警：%q", buf.String())
		}
	})

	// 边角（特意堵的一格）：env 值**恰好等于** Config 值时必须照样告警——判据一旦退化成
	// 「返回值与 fallback 不同」，这一格就会静默失效。
	t.Run("env 与 Config 同值（都 10m）⇒ 仍然告警（判据落在 env 解析值上）", func(t *testing.T) {
		t.Setenv("KA_TEST_SSE_KEEPALIVE", "10m")
		var buf bytes.Buffer
		got := envKeepaliveInterval("KA_TEST_SSE_KEEPALIVE", 10*time.Minute, log.New(&buf, "", 0))
		if got != 10*time.Minute {
			t.Errorf("env=10m / Config=10m ⇒ 得 %s，期望 10m", got)
		}
		if !strings.Contains(buf.String(), "过大") {
			t.Errorf("env 与 Config 同值且越界时也必须告警，否则这一格静默失效；实际=%q", buf.String())
		}
	})
}

// ───────────────────────── V-body413 ─────────────────────────

// V-body413：超大 body（>2MiB）走 withBodyLimit 的 413/4xx 路径，
// 断言「不因保活中间件而改变」：状态码仍 4xx、响应体逐字节同改前、零保活字节。
func TestKeepalive_VBody413_OversizeUnchanged(t *testing.T) {
	const interval = 5 * time.Millisecond
	register := sleepTool(true)
	bare := newMCPTestServer(t, mcpTestServerOptions{stateless: true, bodyLimit: true, register: register})
	defer bare.Close()
	wrapped := newMCPTestServer(t, mcpTestServerOptions{stateless: true, bodyLimit: true, interval: interval, register: register})
	defer wrapped.Close()

	big := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sleep","arguments":{"millis":1,"tag":"` +
		strings.Repeat("x", maxRequestBodyBytes+1) + `"}}}`
	if len(big) <= maxRequestBodyBytes {
		t.Fatalf("测试体 %d 字节没有超过上限 %d", len(big), maxRequestBodyBytes)
	}

	s1, b1, _ := postJSON(t, bare.URL, big)
	s2, b2, _ := postJSON(t, wrapped.URL, big)
	t.Logf("body=%d 字节：裸 status=%d body=%q / 保活 status=%d body=%q", len(big), s1, b1, s2, b2)

	if s1 != s2 {
		t.Errorf("状态码被改动：裸=%d 保活=%d", s1, s2)
	}
	if s2 < 400 || s2 >= 500 {
		t.Errorf("状态码 %d，期望 4xx（超大 body 走 withBodyLimit 路径）", s2)
	}
	if b1 != b2 {
		t.Errorf("响应体被改动：裸=%q 保活=%q", b1, b2)
	}
	if n := countKeepalive(b2); n != 0 {
		t.Errorf("413/4xx 响应被插入 %d 条保活：%q", n, b2)
	}
}

// ───────────────────────── V-abort ─────────────────────────

// abortProbeWriter 记账：① ServeHTTP 返回之后还有没有写；② 有没有写到「已断开的连接」上。
// ⚠️ 它必须实现 Unwrap（让 ResponseController 找得到底层 Flush）与 FlushError（照实现把冲刷
// 错误记下来）——否则本臂的 Flush 会拿到 ErrNotSupported，保活字节卡在 bufio 里，
// 连「客户端收到过头」都验不到，fail-open 那条断言就成了空跑。
type abortProbeWriter struct {
	http.ResponseWriter
	mu          sync.Mutex
	handlerDone bool
	afterReturn int
	writeErrs   int
	flushErrs   int
}

func (w *abortProbeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *abortProbeWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.mu.Lock()
		w.flushErrs++
		w.mu.Unlock()
	}
	return err
}

func (w *abortProbeWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	done := w.handlerDone
	w.mu.Unlock()
	n, err := w.ResponseWriter.Write(b)
	w.mu.Lock()
	if err != nil {
		w.writeErrs++
	}
	if done {
		w.afterReturn++
	}
	w.mu.Unlock()
	return n, err
}

func (w *abortProbeWriter) markDone() {
	w.mu.Lock()
	w.handlerDone = true
	w.mu.Unlock()
}

func (w *abortProbeWriter) snapshot() (afterReturn, writeErrs, flushErrs int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.afterReturn, w.writeErrs, w.flushErrs
}

// V-abort：客户端中途断开 ⇒ touch() 的 Write/Flush 出错，必须 **fail-open**
// （不 panic、不刷屏、不改变 handler 返回），且 ticker 随 handler 返回即停。
// 子进程整组被杀不在本单测范围（那要拉真外部进程），由真机验收覆盖。
//
// ⚠️ 与设计稿 §4.3 的一处**事实更正**（2026-09-22 探针实证，详见交付报告的反证栏）：
// 客户端断开时 **HTTP 请求 ctx 确实被取消**，但**工具 handler 的 ctx 不会被取消**——
// go-sdk 的 `jsonrpc2.NewConnection` 把连接 ctx 包成 `notDone{}`（`internal/jsonrpc2/conn.go:198`
// 与 `:759-767`，`Done()` 恒返回 nil），请求 ctx 由它派生 ⇒ 取消传不进来。
// 所以本测试**不**断言「客户端断开 ⇒ handler 提前返回」，那是做不到的：工具体会照常跑完，
// 保活在这段时间里持续写、持续失败、被静默吞掉（这正是 fail-open 要覆盖的形状）。
func TestKeepalive_VAbort_ClientDisconnectFailOpen(t *testing.T) {
	const interval = 5 * time.Millisecond
	returned := make(chan struct{}, 8) // 工具 handler 返回的信号（带缓冲，避免测试没收时阻塞）

	srv := mcp.NewServer(&mcp.Implementation{Name: "abort-test", Version: "0.0.0"}, nil)
	mcp.AddTool(srv, &mcp.Tool{Name: "sleep", Description: "long sleep"},
		func(ctx context.Context, _ *mcp.CallToolRequest, in kaSleepIn) (*mcp.CallToolResult, any, error) {
			defer StartKeepalive(ctx)()
			select {
			case <-time.After(time.Duration(in.Millis) * time.Millisecond):
			case <-ctx.Done(): // 客户端断开 ⇒ 请求 ctx 取消 ⇒ 这里返回
			}
			select {
			case returned <- struct{}{}:
			default:
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "late"}}}, nil, nil
		})
	h := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{Stateless: true},
	)
	probes := make(chan *abortProbeWriter, 8)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aw := &abortProbeWriter{ResponseWriter: w}
		withSSEKeepalive(h, interval).ServeHTTP(aw, r)
		aw.markDone() // ServeHTTP 返回 = 这条响应在 net/http 眼里已经结束
		probes <- aw
	}))
	defer ts.Close()

	// 预热：连接池与 httptest 的服务 goroutine 先起来，基线才稳；顺便清掉探针通道里的残留。
	if status, raw, _ := postJSON(t, ts.URL, toolCallBody(1, "warm", 1, "")); status != http.StatusOK ||
		!strings.Contains(raw, `"text":"late"`) {
		t.Fatalf("预热调用异常：status=%d body=%q", status, raw)
	}
	for len(probes) > 0 {
		<-probes
	}
	for len(returned) > 0 {
		<-returned
	}
	baseline := runtime.NumGoroutine()

	// 长调用：60ms 后掐断客户端，工具体还要再跑 340ms（见函数头的事实更正）。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		time.Sleep(60 * time.Millisecond)
		cancel()
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL, strings.NewReader(toolCallBody(2, "abort", 400, "")))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		_, rerr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if rerr == nil {
			t.Errorf("期望客户端读到中途失败（连接已被自己掐断），实得无错")
		}
	}
	// 头都还没到就被取消也算数——此处不把 err 当失败。

	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatalf("工具 handler 在客户端断开后没有返回（工具体 400ms，早该跑完了）")
	}

	var aw *abortProbeWriter
	select {
	case aw = <-probes:
	case <-time.After(5 * time.Second):
		t.Fatalf("ServeHTTP 没有返回")
	}
	after, writeErrs, flushErrs := aw.snapshot()
	if after != 0 {
		t.Errorf("ServeHTTP 返回之后还有 %d 次保活写 —— stop 没等 ticker 退出", after)
	}
	if writeErrs+flushErrs == 0 {
		t.Errorf("Write/Flush 一次错误都没有 —— 这条断言是空的：说明保活压根没写到那条断开的连接上" +
			"（测试没覆盖到 fail-open）")
	}
	// 泄漏面：ticker 随 handler 返回即停，goroutine 应回基线。
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseline {
		if time.Now().After(deadline) {
			t.Fatalf("goroutine 未回基线：baseline=%d 现在=%d", baseline, runtime.NumGoroutine())
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("客户端断开：保活写错误 %d 次 / 冲刷错误 %d 次（fail-open 静默吞掉），ServeHTTP 返回后保活写 0 次，goroutine 回基线 %d",
		writeErrs, flushErrs, baseline)
}

// ───────────────────────── V-goroutine-path ─────────────────────────

// readForWindow 在固定时间窗内读一点响应体（用于「长挂的流」——不能等 EOF）。
func readForWindow(body io.Reader, d time.Duration) string {
	type res struct{ b []byte }
	ch := make(chan res, 1)
	go func() {
		b, _ := io.ReadAll(io.LimitReader(body, 4096))
		ch <- res{b}
	}()
	select {
	case r := <-ch:
		return string(r.b)
	case <-time.After(d):
		return ""
	}
}

// V-goroutine-path ①：GET 路径。保活中间件只对 POST 生效，GET 响应必须与改前逐字节相同、零保活字节。
//
// ⚠️ 事实更正（与设计稿 §6 的措辞不同，据实记录）：两个真壳都是 **stateless**，而 go-sdk 在
// stateless 下**不提供 GET standalone 流**——`streamable.go:330-336` 按 MCP 规范直接回 405 +
// `Allow: POST`。所以「GET standalone 流直连」在本部署形态里不存在；这里断言的是它的等价物：
// ① stateless（本壳实际形态）：GET 405，与不经中间件逐字节同 + 零保活；
// ② stateful 对照：真 GET standalone 流（SDK 自己 WriteHeader(200)+Flush 那条路）不被碰、零保活。
func TestKeepalive_VGoroutinePath_GETStream(t *testing.T) {
	doGET := func(t *testing.T, url, sessionID string, accept string, window time.Duration) (int, string, http.Header) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Accept", accept)
		if sessionID != "" {
			req.Header.Set("Mcp-Session-Id", sessionID)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode, readForWindow(resp.Body, window), resp.Header
	}

	t.Run("stateless（本壳实际形态）：GET 405，与改前逐字节同、零保活字节", func(t *testing.T) {
		const interval = time.Millisecond
		bare := newMCPTestServer(t, mcpTestServerOptions{stateless: true, register: sleepTool(true)})
		defer bare.Close()
		wrapped := newMCPTestServer(t, mcpTestServerOptions{stateless: true, interval: interval, register: sleepTool(true)})
		defer wrapped.Close()

		s1, b1, h1 := doGET(t, bare.URL, "", "text/event-stream", 50*time.Millisecond)
		s2, b2, h2 := doGET(t, wrapped.URL, "", "text/event-stream", 50*time.Millisecond)
		if s1 != http.StatusMethodNotAllowed || s2 != http.StatusMethodNotAllowed {
			t.Errorf("状态码 裸=%d 保活=%d，都期望 405（stateless 不提供 GET 流）", s1, s2)
		}
		if b1 != b2 {
			t.Errorf("GET 响应体被改动：裸=%q 保活=%q", b1, b2)
		}
		if h1.Get("Allow") != h2.Get("Allow") {
			t.Errorf("Allow 头被改动：裸=%q 保活=%q", h1.Get("Allow"), h2.Get("Allow"))
		}
		if n := countKeepalive(b2); n != 0 {
			t.Errorf("GET 405 响应被插入 %d 条保活：%q", n, b2)
		}
	})

	t.Run("stateful 对照：真 GET standalone 流不被碰、零保活字节", func(t *testing.T) {
		const interval = time.Millisecond
		bare := newMCPTestServer(t, mcpTestServerOptions{stateless: false, register: sleepTool(true)})
		defer bare.Close()
		wrapped := newMCPTestServer(t, mcpTestServerOptions{stateless: false, interval: interval, register: sleepTool(true)})
		defer wrapped.Close()

		initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ka-test","version":"0"}}}`
		_, _, hdr1 := postJSON(t, bare.URL, initBody)
		_, _, hdr2 := postJSON(t, wrapped.URL, initBody)
		sid1, sid2 := hdr1.Get("Mcp-Session-Id"), hdr2.Get("Mcp-Session-Id")
		if sid1 == "" || sid2 == "" {
			t.Fatalf("initialize 没拿到 Mcp-Session-Id（裸=%q 保活=%q）", sid1, sid2)
		}

		s1, b1, ch1 := doGET(t, bare.URL, sid1, "text/event-stream", 80*time.Millisecond)
		s2, b2, ch2 := doGET(t, wrapped.URL, sid2, "text/event-stream", 80*time.Millisecond)
		if s1 != http.StatusOK || s2 != http.StatusOK {
			t.Errorf("状态码 裸=%d 保活=%d，都期望 200", s1, s2)
		}
		if ch1.Get("Content-Type") != ch2.Get("Content-Type") {
			t.Errorf("content-type 被改动：裸=%q 保活=%q", ch1.Get("Content-Type"), ch2.Get("Content-Type"))
		}
		if b1 != b2 {
			t.Errorf("GET standalone 流窗口内字节不同：裸=%q 保活=%q", b1, b2)
		}
		if n := countKeepalive(b2); n != 0 {
			t.Errorf("GET standalone 流被插入 %d 条保活：%q", n, b2)
		}
		t.Logf("stateful GET 流：status=%d ct=%q 窗口内 %d 字节", s2, ch2.Get("Content-Type"), len(b2))
	})
}

// V-goroutine-path ②：四路并发长调用。各自保活条数与时长成比例、每路恰好 1 条属于自己的结果、无串扰。
func TestKeepalive_VGoroutinePath_ConcurrentLongCalls(t *testing.T) {
	const interval = 10 * time.Millisecond
	ts := newMCPTestServer(t, mcpTestServerOptions{
		stateless: true,
		interval:  interval,
		register:  sleepTool(true),
	})
	defer ts.Close()

	type job struct {
		tag    string
		millis int
	}
	jobs := []job{{"A", 120}, {"B", 60}, {"C", 90}, {"D", 45}}

	var wg sync.WaitGroup
	statuses := make([]int, len(jobs))
	bodies := make([]string, len(jobs))
	errs := make([]error, len(jobs))
	for i, jb := range jobs {
		wg.Add(1)
		go func(i int, jb job) {
			defer wg.Done()
			statuses[i], bodies[i], _, errs[i] = postJSONRaw(
				http.DefaultClient, ts.URL, toolCallBody(i+1, jb.tag, jb.millis, ""))
		}(i, jb)
	}
	wg.Wait()

	for i, jb := range jobs {
		if errs[i] != nil {
			t.Errorf("请求 %s 失败：%v", jb.tag, errs[i])
			continue
		}
		raw := bodies[i]
		if statuses[i] != http.StatusOK {
			t.Errorf("请求 %s 状态码 %d", jb.tag, statuses[i])
		}
		ka := countKeepalive(raw)
		wantMin := jb.millis/int(interval/time.Millisecond) - 2 // 允许调度抖动
		if ka < wantMin {
			t.Errorf("请求 %s 保活 %d 条，期望 ≥%d", jb.tag, ka, wantMin)
		}
		if !strings.Contains(raw, `"text":"slept-`+jb.tag+`"`) {
			t.Errorf("请求 %s 没拿到属于自己的结果：%q", jb.tag, raw)
		}
		if n := strings.Count(raw, "slept-"); n != 1 {
			t.Errorf("请求 %s 拿到 %d 条结果（串扰）：%q", jb.tag, n, raw)
		}
		if n := len(dataLines(raw)); n != 1 {
			t.Errorf("请求 %s 的 data 事件 %d 条，期望 1：%q", jb.tag, n, raw)
		}
		t.Logf("请求 %s（%dms）：保活 %d 条（期望 ≥%d）", jb.tag, jb.millis, ka, wantMin)
	}
}

// 幂等（任务书 §1 对 StartKeepalive 的实现要求，V-list 未单列）：同一 writer 重复调用
// 只武装一个 ticker。判据用**区间**：窗口内 N 个 tick 就该补 ~N 条；若第二次也派了 ticker
// （相位不同）会翻倍到 ~2N 条，落在区间外。
func TestKeepalive_IdempotentArming(t *testing.T) {
	const tick = 5 * time.Millisecond
	const ticks = 10
	secondStop := make(chan func(), 1)
	ts := httptest.NewServer(withSSEKeepalive(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream") // 先声明形态，再起表
		first := StartKeepalive(r.Context())
		secondStop <- StartKeepalive(r.Context()) // 第二次调用
		time.Sleep(ticks * tick)
		first()
	}), tick))
	defer ts.Close()

	status, raw, _ := postJSON(t, ts.URL, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if status != http.StatusOK {
		t.Fatalf("状态码 %d，期望 200", status)
	}
	second := <-secondStop
	if second == nil {
		t.Fatalf("StartKeepalive 第二次调用返回了 nil（必须是可直接 defer 的空函数）")
	}
	second() // 空函数：调用它必须无副作用、不 panic（若它是真 stop，会去关别人的 channel）

	ka := countKeepalive(raw)
	if ka < ticks-2 || ka > ticks+2 {
		t.Errorf("窗口 %d 个 tick 补了 %d 条保活，期望 ∈[%d,%d] —— 落在区间外说明武装了不止一个 ticker",
			ticks, ka, ticks-2, ticks+2)
	}
	t.Logf("重复调用只武装一次：%d 个 tick 窗口补 %d 条", ticks, ka)
}

// ───────────────────────── V-race（本单核心回归门） ─────────────────────────

// V-race 只有**一条**竞态测试（任务书 §V-race 定稿口径）：真的 withSSEKeepalive + 真 mcp.Server +
// 真 StreamableHTTPHandler + httptest，间隔 1ms / 工具体 30ms / 25 轮，`-race` 必须 0 处。
// **不**把任何已知有缺陷的 ResponseWriter 变体搬进模块——缺陷变体的报红记录留在证据目录
// （repro/race_probe_test.go 与 race3-arm*.txt）。
//
// 三个子场景：
//  1. 起表点在工具 handler：必须真的补过行（防「race-free 其实是压根没写」的假绿）；
//  2. **阴性对照（不可省）**：同一个 handler 去掉 `defer StartKeepalive(ctx)()` ⇒ 一条保活都没有
//     （证明起表点真的在起作用，而不是别处在偷偷写）；
//  3. **复合场景**：层① 真发 progress（经 SDK 的 write+flush）+ 层② 在跑 ⇒ 仍须 0 处。
//     这是 `FlushError` 唯一的实测必要性来源（探针：去掉它 18 处竞争，有它 0 处）。
func TestKeepalive_VRace(t *testing.T) {
	const (
		interval = time.Millisecond
		toolMS   = 30
		rounds   = 25
	)

	t.Run("起表点在工具 handler：25 轮真补行且 -race 干净", func(t *testing.T) {
		ts := newMCPTestServer(t, mcpTestServerOptions{
			stateless: true,
			interval:  interval,
			register:  sleepTool(true),
		})
		defer ts.Close()

		total := 0
		for i := 0; i < rounds; i++ {
			status, raw, _ := postJSON(t, ts.URL, toolCallBody(i+1, "race", toolMS, ""))
			if status != http.StatusOK {
				t.Fatalf("round %d: 状态码 %d", i, status)
			}
			if !strings.Contains(raw, "data:") {
				t.Fatalf("round %d: 没拿到结果事件：%q", i, raw)
			}
			ka := countKeepalive(raw)
			if ka == 0 {
				// ★ 防假绿：race-free 不能是「压根没写」
				t.Fatalf("round %d: 保活一条都没写（race-free 是假绿）：%q", i, raw)
			}
			total += ka
		}
		if total <= 0 {
			t.Fatalf("25 轮累计补行 %d 条 —— 必须 > 0", total)
		}
		t.Logf("间隔=%s 工具体=%dms 轮数=%d：累计补行 %d 条（防假绿断言：> 0）", interval, toolMS, rounds, total)
	})

	t.Run("阴性对照：未挂起表点 ⇒ 一条保活都没有", func(t *testing.T) {
		ts := newMCPTestServer(t, mcpTestServerOptions{
			stateless: true,
			interval:  interval,
			register:  sleepTool(false), // ← 唯一变量：handler 里没有 defer StartKeepalive(ctx)()
		})
		defer ts.Close()

		for i := 0; i < rounds; i++ {
			status, raw, _ := postJSON(t, ts.URL, toolCallBody(i+1, "race", toolMS, ""))
			if status != http.StatusOK {
				t.Fatalf("round %d: 状态码 %d", i, status)
			}
			if ka := countKeepalive(raw); ka != 0 {
				t.Fatalf("round %d: 未挂起表点却补了 %d 条保活（别处在偷偷写）：%q", i, ka, raw)
			}
		}
		t.Logf("阴性对照：%d 轮全部零保活（起表点确实在起作用）", rounds)
	})

	t.Run("复合场景：层① 真发 progress + 层② 在跑", func(t *testing.T) {
		const (
			comboRounds = 12
			comboMS     = 25
		)
		register := func(s *mcp.Server) {
			mcp.AddTool(s, &mcp.Tool{Name: "sleep", Description: "sleep + progress"},
				func(ctx context.Context, req *mcp.CallToolRequest, in kaSleepIn) (*mcp.CallToolResult, kaSleepOut, error) {
					defer StartKeepalive(ctx)() // 层② 起表点
					// 层①：调用**中途**真的发 progress 通知 —— SDK 因此会在 handler 执行期间
					// write+flush（mcp/event.go:56-59），这才是 FlushError 的用武之地。
					tok := req.Params.GetProgressToken()
					deadline := time.Now().Add(time.Duration(in.Millis) * time.Millisecond)
					n := 0
					for time.Now().Before(deadline) {
						if tok != nil {
							n++
							_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
								ProgressToken: tok,
								Progress:      float64(n),
								Message:       fmt.Sprintf("tick %d", n),
							})
						}
						time.Sleep(time.Millisecond)
					}
					return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "done"}}},
						kaSleepOut{SleptSeconds: time.Duration(in.Millis).Seconds(), Tag: "combo"}, nil
				})
		}
		ts := newMCPTestServer(t, mcpTestServerOptions{stateless: true, interval: interval, register: register})
		defer ts.Close()

		totalKA, totalProg := 0, 0
		for i := 0; i < comboRounds; i++ {
			status, raw, _ := postJSON(t, ts.URL, toolCallBody(i+1, "combo", comboMS, fmt.Sprintf("tok-%d", i+1)))
			if status != http.StatusOK {
				t.Fatalf("round %d: 状态码 %d", i, status)
			}
			ka, prog := countKeepalive(raw), strings.Count(raw, "notifications/progress")
			if ka == 0 || prog == 0 {
				// 两侧都必须真的在写，否则这一轮不叫复合场景
				t.Fatalf("round %d: 层②补行=%d 层①通知=%d —— 两侧都得真的在写", i, ka, prog)
			}
			totalKA += ka
			totalProg += prog
		}
		t.Logf("复合场景 %d 轮：层② 累计补行 %d 条，层① 累计通知 %d 条（-race 必须 0 处）",
			comboRounds, totalKA, totalProg)
	})
}
