package mcpshell

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fastOutbound(retries int) *Outbound {
	o := NewOutbound(5*time.Second, retries)
	o.RetryOn = func(status int) bool { return status == 429 || status == 529 }
	// 测试里把退避压到毫秒级，否则一次跑要等 7 秒。
	o.Backoff = func(attempt int) time.Duration { return time.Duration(5*(attempt+1)) * time.Millisecond }
	return o
}

func TestOutboundPostJSONSuccess(t *testing.T) {
	var gotBody atomic.Value
	var gotAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 256)
		n, _ := r.Body.Read(buf)
		gotBody.Store(string(buf[:n]))
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	resp, err := fastOutbound(3).PostJSON(context.Background(), srv.URL, []byte(`{"a":1}`),
		map[string]string{"Authorization": "Bearer x", "Content-Type": "application/json"})
	if err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if resp.Status != 200 || resp.Body != `{"ok":true}` {
		t.Errorf("resp=%+v", resp)
	}
	if resp.Attempts != 1 {
		t.Errorf("Attempts=%d, want 1", resp.Attempts)
	}
	if gotBody.Load() != `{"a":1}` {
		t.Errorf("body=%v", gotBody.Load())
	}
	if gotAuth.Load() != "Bearer x" {
		t.Errorf("header 没透传：%v", gotAuth.Load())
	}
}

func TestOutboundRetriesOn429ThenSucceeds(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(429)
			_, _ = w.Write([]byte("slow down"))
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	resp, err := fastOutbound(3).PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if resp.Status != 200 {
		t.Errorf("status=%d, want 200", resp.Status)
	}
	if resp.Attempts != 3 {
		t.Errorf("Attempts=%d, want 3（两次 429 + 一次成功）", resp.Attempts)
	}
}

// 不该重试的状态码（如 400）必须一次就返回——重试只是白烧配额。
func TestOutboundDoesNotRetryNonRetryableStatus(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(400)
		_, _ = w.Write([]byte("bad request"))
	}))
	defer srv.Close()

	resp, err := fastOutbound(3).PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if resp.Status != 400 || calls.Load() != 1 {
		t.Errorf("status=%d calls=%d，want 400 / 1 次", resp.Status, calls.Load())
	}
}

func TestOutboundGivesUpAfterMaxRetries(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(529)
	}))
	defer srv.Close()

	resp, err := fastOutbound(2).PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err != nil {
		t.Fatalf("PostJSON: %v", err)
	}
	if resp.Status != 529 {
		t.Errorf("status=%d, want 529", resp.Status)
	}
	if calls.Load() != 3 {
		t.Errorf("发了 %d 次，want 3（MaxRetries=2 → 总尝试 3）", calls.Load())
	}
}

// 关键回归（Node 版踩过的坑）：退避窗口里被取消，就不能再白发一次远端请求。
func TestOutboundCancelDuringBackoffDoesNotResend(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(429)
	}))
	defer srv.Close()

	o := NewOutbound(5*time.Second, 3)
	o.RetryOn = func(status int) bool { return status == 429 }
	o.Backoff = func(int) time.Duration { return 500 * time.Millisecond } // 足够长，够我们在窗口里取消

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	defer cancel()

	_, err := o.PostJSON(ctx, srv.URL, []byte(`{}`), nil)
	if !IsCanceled(err) {
		t.Fatalf("err=%v，want 取消类错误", err)
	}
	if got := calls.Load(); got != 1 {
		t.Errorf("退避期间被取消后还发了请求：共 %d 次，want 1", got)
	}
}

// 已取消的 ctx 进来就该立刻返回，一个请求都不发。
func TestOutboundPreCanceledContextSendsNothing(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fastOutbound(3).PostJSON(ctx, srv.URL, []byte(`{}`), nil); !IsCanceled(err) {
		t.Fatalf("err=%v，want 取消", err)
	}
	if calls.Load() != 0 {
		t.Errorf("已取消的 ctx 还发了 %d 次请求", calls.Load())
	}
}

// 不复用连接（Node 的 agent:false）：N 次调用必须来自 N 个不同的 TCP 连接。
func TestOutboundDoesNotReuseConnections(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.RemoteAddr] = true
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer srv.Close()

	o := fastOutbound(0)
	for i := 0; i < 4; i++ {
		if _, err := o.PostJSON(context.Background(), srv.URL, []byte(`{}`), nil); err != nil {
			t.Fatalf("第 %d 次: %v", i, err)
		}
	}
	mu.Lock()
	n := len(seen)
	mu.Unlock()
	if n != 4 {
		t.Errorf("4 次调用只用了 %d 个连接：连接被复用了（DisableKeepAlives 没生效）", n)
	}
}

func TestOutboundCapsResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(strings.Repeat("x", 100_000)))
	}))
	defer srv.Close()

	o := fastOutbound(0)
	o.MaxResponseBytes = 128
	resp, err := o.PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	// 语义在 2026-09-19 改过（PiMoa review）：超限不再静默截断后当成功返回。
	// 原来那样调用方拿到的是一段被切开的 JSON，与完整响应不可区分，下游解析会以
	// 「语法错误」失败，而真因是响应超限——错误指向完全错了地方。
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("超限时应返回 ErrResponseTooLarge，实际 err=%v", err)
	}
	// 已读到的那截仍然交还，便于排障（比如看看远端到底在吐什么）。
	if len(resp.Body) != 128 {
		t.Errorf("响应体读了 %d 字节，want 上限 128", len(resp.Body))
	}
	if resp.Status != 200 {
		t.Errorf("状态码 %d 丢了，want 200", resp.Status)
	}
}

func TestOutboundRequestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	o := NewOutbound(200*time.Millisecond, 0)
	start := time.Now()
	_, err := o.PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err == nil {
		t.Fatal("超时没报错")
	}
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Errorf("超时没真生效，耗时 %s", elapsed)
	}
}
