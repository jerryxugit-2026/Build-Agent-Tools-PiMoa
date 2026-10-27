package mcpshell

// UG-8 modern-only（DEC-76）OLD/NEW 判别用例：**只用 HEAD(56a7551a) 上也存在的符号**
// （Serve / Config / newHTTPHandler 与 protocol_version_test.go 的 pvConfig / pvRegister / pvPost /
// pvInitializeBody / modernBody），因此同一份文件在改动前后都能编译：HEAD 上 RED（不带 -X 的常规
// 构建是 dual：discover 报 5 个版本、带 2025 头的 initialize 回 200、日志 mode=dual），新代码 GREEN。
//
// 取生产 server 的办法：经真实 Serve 入口构造，cfg.Register 回调拿到 Serve 内部 newServer 造出的
// *mcp.Server；<PREFIX>_TRANSPORT 设成不认识的值，让 Serve 在构造 + 打日志之后、进入阻塞传输之前
// 返回 error——测的因此正是「常规构建（无任何 -ldflags）」在线上那条构造路径上的协议版本。

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// syncBuffer：log.Logger 本身串行写，但测试读与 Serve 写可能跨 goroutine，加锁免 -race 误报。
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// pvServeViaServe 走真实 Serve 构造路径，返回 Serve 造出的生产 server、日志全文与 Serve 的返回错误。
func pvServeViaServe(t *testing.T) (*mcp.Server, string, error) {
	t.Helper()
	t.Setenv("PVTEST_TRANSPORT", "pv-no-such-transport")
	var buf syncBuffer
	var captured *mcp.Server
	cfg := pvConfig()
	cfg.Log = log.New(&buf, "", 0)
	cfg.Register = func(s *mcp.Server) {
		captured = s
		pvRegister(s)
	}
	err := Serve(cfg)
	return captured, buf.String(), err
}

func TestProtocolModern_ServeBuildIsModernOnly(t *testing.T) {
	server, logs, serveErr := pvServeViaServe(t)
	if serveErr == nil || !strings.Contains(serveErr.Error(), "pv-no-such-transport") {
		t.Fatalf("Serve 应在构造之后因传输值不认识而返回 error，得 %v", serveErr)
	}
	if server == nil {
		t.Fatalf("Serve 未调用 Register（构造失败？）；err=%v logs=%q", serveErr, logs)
	}
	const wantLog = "protocol mode=modern versions=2026-07-28"
	if !strings.Contains(logs, wantLog+"\n") {
		t.Errorf("Serve 启动日志缺 %q；实得日志=%q", wantLog, logs)
	}

	cfg := pvConfig()
	ts := httptest.NewServer(newHTTPHandler(cfg, server, cfg.Log))
	t.Cleanup(ts.Close)
	url := ts.URL + "/mcp"

	// 新协议：server/discover 2026-07-28 必须 200，且 supportedVersions 精确等于 [2026-07-28]。
	status, r, raw := pvPost(t, ts.Client(), url, "2026-07-28", "server/discover", modernBody(t, "server/discover", nil))
	if status != http.StatusOK || r == nil || r.Error != nil {
		t.Fatalf("server/discover(2026-07-28)：HTTP %d，body=%q；want 200 + result", status, raw)
	}
	var disc struct {
		SupportedVersions []string `json:"supportedVersions"`
	}
	if err := json.Unmarshal(r.Result, &disc); err != nil {
		t.Fatalf("解析 discover 结果: %v (%s)", err, r.Result)
	}
	if !slices.Equal(disc.SupportedVersions, []string{"2026-07-28"}) {
		t.Errorf("discover.supportedVersions = %v，want 精确 [2026-07-28]（modern-only）", disc.SupportedVersions)
	}

	// 旧协议：带 MCP-Protocol-Version: 2025-11-25 头的 initialize 与 tools/list 必须在传输层 400。
	for _, tc := range []struct{ name, body string }{
		{"initialize", pvInitializeBody("2025-11-25")},
		{"tools/list", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`},
	} {
		status, _, raw = pvPost(t, ts.Client(), url, "2025-11-25", "", tc.body)
		if status != http.StatusBadRequest || !strings.Contains(raw, "supported versions: 2026-07-28)\n") {
			t.Errorf("带 2025-11-25 头的 %s：HTTP %d，body=%q；want 400 且只列 2026-07-28", tc.name, status, raw)
		}
	}
}
