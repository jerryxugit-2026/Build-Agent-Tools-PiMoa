package mcpshell

// modern-only（UG-8，台账 DEC-76）的 Serve 级与 SDK 行为测试。全部经 newServer / newHTTPHandler
// （或真实 Serve）构造，客户端侧用 go-sdk v1.8 真实 mcp.Client + StreamableClientTransport。
//
// go-sdk v1.8.0 行为依据（~/go/pkg/mod/github.com/modelcontextprotocol/go-sdk@v1.8.0/mcp/）：
//   - shared.go:76-98      negotiatedVersion：旧式 initialize 在列表里找不到 < 2026-07-28 的版本时
//     **兜底回 2025-11-25**（即便 server 不支持它）
//   - streamable.go:347-356 servePOST：只有**带** MCP-Protocol-Version 头且 < 2026-07-28、又不在列表内
//     时才回 400 纯文本；**不带头**的请求不在这一层拦
//   - server.go:1956-1966  handle：只对带 _meta.protocolVersion 的新协议请求做版本收窄（-32022）
//   - client.go:314-386    Connect：默认先发 server/discover(2026-07-28)；显式要旧版本时直接旧式 initialize

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// 启动日志恰好一行 `protocol mode=modern versions=2026-07-28`，且不含凭据样式字段。
func TestProtocolModern_ServeLogsModeLine(t *testing.T) {
	server, logs, err := pvServeViaServe(t)
	if err == nil || server == nil {
		t.Fatalf("Serve：err=%v server=%v，want 构造成功后因传输值返回 error", err, server)
	}
	const want = "protocol mode=modern versions=2026-07-28"
	var lines []string
	for _, l := range strings.Split(logs, "\n") {
		if strings.Contains(l, "protocol mode=") {
			lines = append(lines, l)
		}
	}
	if len(lines) != 1 || lines[0] != want {
		t.Fatalf("形态日志行 = %q，want 恰好一行 %q；全文=%q", lines, want, logs)
	}
	for _, bad := range []string{"key", "token", "secret", "bearer"} {
		if strings.Contains(strings.ToLower(lines[0]), bad) {
			t.Fatalf("形态日志行含凭据样式字段 %q: %q", bad, lines[0])
		}
	}
}

func pvDiscoverVersions(t *testing.T, r *pvRPCResp, raw string) []string {
	t.Helper()
	if r == nil || r.Error != nil {
		t.Fatalf("server/discover 未成功: %q", raw)
	}
	var disc struct {
		SupportedVersions []string `json:"supportedVersions"`
	}
	if err := json.Unmarshal(r.Result, &disc); err != nil {
		t.Fatalf("解析 discover 结果: %v (%s)", err, r.Result)
	}
	return disc.SupportedVersions
}

// pvGoClient 用 go-sdk 真实 client 连接；pv 为空 = SDK 默认（先 discover 2026-07-28）。
// 连接成功则顺带 ListTools + CallTool(pv_echo)，返回协商版本；连接失败返回 error。
func pvGoClient(t *testing.T, url string, client *http.Client, pv string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var opts *mcp.ClientSessionOptions
	if pv != "" {
		opts = &mcp.ClientSessionOptions{ProtocolVersion: pv}
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "pv-go-client", Version: "0.0.0"}, nil)
	cs, err := c.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: url, HTTPClient: client}, opts)
	if err != nil {
		return "", err
	}
	defer cs.Close()
	negotiated := cs.InitializeResult().ProtocolVersion
	lt, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("协商 %s 后 ListTools 失败: %v", negotiated, err)
	}
	if len(lt.Tools) != 1 || lt.Tools[0].Name != "pv_echo" {
		t.Fatalf("协商 %s 后 ListTools = %+v，want 仅 pv_echo", negotiated, lt.Tools)
	}
	cr, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "pv_echo", Arguments: map[string]any{"text": "go-" + negotiated}})
	if err != nil {
		t.Fatalf("协商 %s 后 CallTool 失败: %v", negotiated, err)
	}
	tc, ok := cr.Content[0].(*mcp.TextContent)
	if cr.IsError || len(cr.Content) != 1 || !ok || tc.Text != "go-"+negotiated {
		t.Fatalf("协商 %s 后 CallTool 结果 = %+v，want 回显 go-%s", negotiated, cr, negotiated)
	}
	if err := cs.Close(); err != nil && !errors.Is(err, context.Canceled) {
		t.Logf("Close: %v", err)
	}
	return negotiated, nil
}

// modern-only：新协议通；带任一旧版本头的旧式请求在传输层 400；显式要旧版本的 Go client 连不上。
func TestProtocolModern_ModernOnly(t *testing.T) {
	ts := pvServe(t)
	url := ts.URL + "/mcp"

	t.Run("raw_discover_2026_only", func(t *testing.T) {
		status, r, raw := pvPost(t, ts.Client(), url, pvModern, "server/discover", modernBody(t, "server/discover", nil))
		if status != http.StatusOK {
			t.Fatalf("HTTP %d，want 200；body=%q", status, raw)
		}
		if got := pvDiscoverVersions(t, r, raw); !slices.Equal(got, []string{pvModern}) {
			t.Fatalf("supportedVersions = %v，want 精确 [%s]", got, pvModern)
		}
	})
	for _, legacy := range pvLegacyVersions {
		for _, tc := range []struct{ name, body string }{
			{"initialize", pvInitializeBody(legacy)},
			{"tools_list", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`},
			{"tools_call", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pv_echo","arguments":{"text":"x"}}}`},
		} {
			t.Run("raw_"+tc.name+"_with_header_"+legacy+"_400", func(t *testing.T) {
				status, r, raw := pvPost(t, ts.Client(), url, legacy, "", tc.body)
				if status != http.StatusBadRequest {
					t.Fatalf("HTTP %d，want 400；body=%q", status, raw)
				}
				if r != nil {
					t.Fatalf("期望传输层纯文本 400（非 JSON-RPC），得 %+v", r)
				}
				if !strings.Contains(raw, "Unsupported protocol version") || !strings.Contains(raw, "supported versions: 2026-07-28)\n") {
					t.Fatalf("400 正文 = %q，want 指明只支持 2026-07-28", raw)
				}
			})
		}
	}
	t.Run("go_client_default_gets_2026", func(t *testing.T) {
		got, err := pvGoClient(t, url, ts.Client(), "")
		if err != nil || got != pvModern {
			t.Fatalf("Go client 默认协商 = (%q, %v)，want %s", got, err, pvModern)
		}
	})
	t.Run("go_client_legacy_cannot_connect", func(t *testing.T) {
		// 实测：initialize（不带版本头）先 200 回 2025-11-25，随后 notifications/initialized
		// 带 MCP-Protocol-Version: 2025-11-25 头 → 传输层 400，Connect 失败。
		got, err := pvGoClient(t, url, ts.Client(), "2025-11-25")
		if err == nil {
			t.Fatalf("Go client 显式 2025-11-25 对 modern-only 连接成功（协商 %q），want 失败", got)
		}
		if !strings.Contains(err.Error(), "notifications/initialized") || !strings.Contains(err.Error(), "Bad Request") {
			t.Fatalf("连接错误 = %v，want 在 notifications/initialized 处 Bad Request", err)
		}
	})
}

// ACT-24 实测钉：go-sdk v1.8 modern-only（SupportedProtocolVersions={2026-07-28}）**不拦截不带
// MCP-Protocol-Version 头、也不带 _meta.protocolVersion 的旧式请求**——
//   - 旧式 initialize 回 200，result.protocolVersion = "2025-11-25"（server 自己并不支持的版本，
//     shared.go:91-97 兜底分支），客户端请求任一旧版本或 2026-07-28 都被改写成 2025-11-25；
//   - stateless 下旧式 tools/list、tools/call 照常 200 并**真实执行工具**。
//
// 本测试不是期望行为，是 SDK 事实钉：SDK 语义一变就会失败，届时 ACT-24 结论需复核。
// 按任务合同不改 SDK、不自造拦截器。
func TestProtocolModern_ACT24_HeaderlessLegacyNotBlocked(t *testing.T) {
	ts := pvServe(t)
	url := ts.URL + "/mcp"

	for _, req := range append(slices.Clone(pvLegacyVersions), pvModern) {
		status, r, raw := pvPost(t, ts.Client(), url, "", "", pvInitializeBody(req))
		if status != http.StatusOK {
			t.Fatalf("modern-only 无头 initialize(%s)：HTTP %d，body=%q；SDK 现象变了（ACT-24 记为 200）", req, status, raw)
		}
		if got := pvResultProtocolVersion(t, r, raw); got != "2025-11-25" {
			t.Fatalf("modern-only 无头 initialize(%s) 协商 %q，ACT-24 实测为 2025-11-25", req, got)
		}
	}
	status, r, raw := pvPost(t, ts.Client(), url, "", "", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	if status != http.StatusOK || r == nil || r.Error != nil {
		t.Fatalf("modern-only 无头 tools/list：HTTP %d，body=%q；ACT-24 实测为 200 + result", status, raw)
	}
	status, r, raw = pvPost(t, ts.Client(), url, "", "", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pv_echo","arguments":{"text":"act24"}}}`)
	if status != http.StatusOK {
		t.Fatalf("modern-only 无头 tools/call：HTTP %d，body=%q", status, raw)
	}
	if got := pvEchoText(t, r, raw); got != "act24" {
		t.Fatalf("modern-only 无头 tools/call 回显 %q，ACT-24 实测为工具真实执行（回显 act24）", got)
	}
}
