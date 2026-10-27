package mcpshell

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// 本文件钉住 PiMoa review 2026-09-19 第二轮（新增骨架件）抓出的问题。
// 每条测试都实测过「撤回修复即变红」，不是跑通了就算。

// ───────── jobs.go：停在 running 的 job 不能永久占槽 ─────────

// Finish 是离开 running 的唯一出口，而清扫与容量淘汰两条路径都跳过 running。
// 于是只要有 job 走不到 Finish，它就永久占槽；攒满 MaxJobs 条之后 Create 会对
// 之后所有请求永远返回 ErrJobStoreFull，且再没有任何写入能触发自愈。
func TestStaleRunningJobsDoNotWedgeStoreForever(t *testing.T) {
	now := time.Now()
	s := NewJobStore(3, 1<<20, 1<<16, time.Hour)
	s.RunningTimeout = time.Minute
	s.now = func() time.Time { return now }

	// 塞满：三条都停在 running（模拟收尾路径全部没走到）
	for i := 0; i < 3; i++ {
		if _, err := s.Create(1000+i, "m", "a", "/tmp"); err != nil {
			t.Fatalf("第 %d 条 Create: %v", i, err)
		}
	}
	if _, err := s.Create(9999, "m", "a", "/tmp"); err == nil {
		t.Fatal("表满且全在跑时应拒绝（这一步本来就该成立）")
	}

	// 时间推过 RunningTimeout：僵住的 job 该被改判，槽位该回来
	now = now.Add(2 * time.Minute)
	id, err := s.Create(9999, "m", "a", "/tmp")
	if err != nil {
		t.Fatalf("超过 RunningTimeout 后仍然拒绝——任务表被永久卡死了：%v", err)
	}
	if id == "" {
		t.Fatal("Create 成功却没给 id")
	}

	// 改判要如实交代，而不是让 job 凭空消失（轮询方正等着它）
	var timedOut int
	for _, jid := range s.IDs() {
		j, ok := s.Get(jid)
		if !ok {
			continue
		}
		if j.Status == JobTimedOut && strings.Contains(j.Stderr, "停在 running") {
			timedOut++
		}
	}
	if timedOut == 0 {
		t.Error("僵住的 job 被静默处理掉了——轮询方会收到「查无此 job」这种没法归因的答复")
	}
}

// 反向：没超时的 running 绝不能被动（它还在正常跑）。
func TestFreshRunningJobsAreNeverReclassified(t *testing.T) {
	now := time.Now()
	s := NewJobStore(5, 1<<20, 1<<16, time.Hour)
	s.RunningTimeout = time.Hour
	s.now = func() time.Time { return now }

	id, err := s.Create(1234, "m", "a", "/tmp")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	now = now.Add(time.Minute) // 远未到 RunningTimeout
	j, ok := s.Get(id)
	if !ok {
		t.Fatal("正常在跑的 job 不见了")
	}
	if j.Status != JobRunning {
		t.Errorf("正常在跑的 job 被改判成了 %s", j.Status)
	}
}

// ───────── httpclient.go：POST 不是幂等请求 ─────────

// 「请求已送达、服务端已执行、读响应时断了」这一类错误绝不能重发——
// jev 调的是计费判定 API，重发等于重复扣额度。
func TestPostNotRetriedWhenServerMayHaveProcessed(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		// 收下请求（服务端视角=已执行），然后在回响应的中途掐断连接。
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("httptest 不支持 Hijack，无法构造「已送达但读不到回应」")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial"))
		_ = conn.Close()
	}))
	defer srv.Close()

	o := fastOutbound(3) // 允许重试 3 次
	_, err := o.PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err == nil {
		t.Fatal("连接被掐断却报成功了")
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Errorf("服务端被打了 %d 次，want 1——"+
			"「可能已被处理」的请求被重发了，对计费 API 就是重复扣额度", n)
	}
}

// 反向：拨号失败证明请求从没送到，这一类必须照常重试。
//
// ⚠️ 判据必须用**连接被拒**，不能用「不可路由地址 + 客户端超时」。实测三种失败的
// 错误类型（2026-09-19）：连接被拒与 DNS 失败都是 net.OpError{Op:"dial"}，能判；
// 而不可路由地址撞上 Client.Timeout 拿到的是裸的
// `context deadline exceeded (Client.Timeout exceeded while awaiting headers)`，
// 既不是 OpError 也不含 dial 字样——Go 这条消息分不出超时发生在拨号阶段还是等响应
// 阶段，所以对非幂等 POST 只能保守地不重试。第一版测试就是用错了后者，红得莫名。
func TestPostRetriedWhenRequestNeverReachedServer(t *testing.T) {
	// 起一个真服务器再立刻关掉：端口确定没人听，拨号必然被拒（ECONNREFUSED）。
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL
	srv.Close()

	o := fastOutbound(2)
	resp, err := o.PostJSON(context.Background(), deadURL, []byte(`{}`), nil)
	if err == nil {
		t.Fatal("拨不通却报成功了")
	}
	if resp.Attempts < 3 {
		t.Errorf("只尝试了 %d 次，want 3（1 次首发 + 2 次重试）——"+
			"连接被拒证明请求从没送到，本该重试", resp.Attempts)
	}
}

// 有歧义的超时（分不出拨号阶段还是等响应阶段）必须保守：不重发。
// 这条钉住的是那个取舍本身，免得以后有人为了「更有韧性」把它放开。
func TestAmbiguousTimeoutIsNotRetried(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		time.Sleep(2 * time.Second) // 比客户端超时长，制造「等响应时超时」
	}))
	defer srv.Close()

	o := fastOutbound(3)
	o.Timeout = 200 * time.Millisecond
	o.client.Timeout = 200 * time.Millisecond
	_, err := o.PostJSON(context.Background(), srv.URL, []byte(`{}`), nil)
	if err == nil {
		t.Fatal("超时却报成功了")
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Errorf("服务端被打了 %d 次，want 1——请求已经送达过，重发就是重复执行", n)
	}
}

// ───────── args.go：重复键必须与 SDK 同语义 ─────────

// SDK 走 map[string]any，重复键是后者覆盖前者。RawArg 若返回第一个，
// 就会出现「schema 校验过的是后者、实际转发给远端的是前者」。
func TestRawArgDuplicateKeyMatchesSDKSemantics(t *testing.T) {
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{
			Arguments: json.RawMessage(`{"q":"FIRST","other":1,"q":"LAST"}`),
		},
	}
	got := string(RawArg(req, "q"))
	if got != `"LAST"` {
		t.Errorf("RawArg 取到 %s，want \"LAST\"——"+
			"SDK 的 map 反序列化保留最后一个，这里取第一个就是「校验 A、发出 B」", got)
	}
}

// 显式 null 要当作「没给」走兜底，不能把字面 null 转发出去。
func TestRawArgOrTreatsExplicitNullAsAbsent(t *testing.T) {
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{
			Arguments: json.RawMessage(`{"q":null}`),
		},
	}
	fallback := json.RawMessage(`["兜底"]`)
	got := string(RawArgOr(req, "q", fallback))
	if got != `["兜底"]` {
		t.Errorf("显式 null 被原样转发了（得到 %s）——"+
			"SDK 那边 typed 字段解出来的是零值，两边不一致", got)
	}
}

// ───────── secrets.go：密钥文件权限体检 ─────────

func TestSecretFileWorldReadableWarns(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.env")
	if err := os.WriteFile(path, []byte("K=v\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var sb bytes.Buffer
	logger := log.New(&sb, "", 0)

	if got := SecretFromEnvFile(path, "K", logger); got != "v" {
		t.Errorf("取值错了：%q", got)
	}
	out := sb.String()
	if !strings.Contains(out, "权限") {
		t.Errorf("0644 的密钥文件没告警：%q", out)
	}
	// 告警里绝不能出现密钥值本身
	if strings.Contains(out, "v\n") || strings.Contains(out, "K=v") {
		t.Errorf("告警里回显了文件内容：%q", out)
	}

	// 0600 时不该有任何噪声
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	sb.Reset()
	_ = SecretFromEnvFile(path, "K", logger)
	if strings.Contains(sb.String(), "权限") {
		t.Errorf("0600 反而告警了：%q", sb.String())
	}
}
