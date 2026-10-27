package mcpshell

// 协议版本 modern-only（UG-8，台账 DEC-76：只认 2026-07-28）的生产构造测试：
// 全部经 newServer(modernProtocolVersions()) / newHTTPHandler 起 httptest，测的就是 Serve 线上那条链。
// 例外只有两条，且都有意为之：
//   - UnknownServerVersionPanics 直接调 mcp.NewServer，钉住「SDK 遇未知版本 panic」这一事实，
//     它是 validateProtocolVersions 必须前置拦截的理由；
//   - LegacyHeaderUnrestrictedControl 自造一个**不收窄**的 server（仍挂同一个 newHTTPHandler），
//     作阴性对照：同一个带 2025-11-25 头的请求在 modern-only 时 400、不收窄时 200，证明拒绝来自收窄。
//
// Serve 级与 SDK 行为钉住测试（启动日志、discover、旧版本头 400、ACT-24）见 protocol_modern_test.go；
// OLD/NEW 判别用例见 protocol_modern_serve_test.go。
//
// go-sdk v1.8.0 源码依据（~/go/pkg/mod/github.com/modelcontextprotocol/go-sdk@v1.8.0/mcp/）：
//   - server.go:237-247  NewServer：非空列表逐项校验（未知版本 panic），空列表 = 不限制
//   - streamable.go:347-356 servePOST：带 MCP-Protocol-Version 头、< 2026-07-28 且不在列表内 → 400 纯文本
//   - streamable.go:1564-1571 servePOST：带 2026 头但缺 _meta.protocolVersion → 400 / -32602
//   - streamable.go:406-411 serveStateless：*http.MaxBytesError → 413
//   - client.go:314-386   Connect：默认先发 server/discover(2026-07-28)

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const pvModern = "2026-07-28"

// pvLegacyVersions 是 SDK 认识、但 modern-only 必须拒绝的全部旧协议版本（新→旧）。
var pvLegacyVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

type pvEchoIn struct {
	Text string `json:"text"`
}

// pvRegister 注册一个最小工具，让 tools/list 有东西可列、tools/call 走到真实方法。
func pvRegister(s *mcp.Server) {
	mcp.AddTool(s, &mcp.Tool{Name: "pv_echo", Description: "protocol version test echo"},
		func(_ context.Context, _ *mcp.CallToolRequest, in pvEchoIn) (*mcp.CallToolResult, any, error) {
			return TextResult(in.Text, false), nil, nil
		})
}

func pvConfig() Config {
	return Config{
		Name: "pvtest", Version: "0.0.0", EnvPrefix: "PVTEST",
		// SSEKeepalive 零值：不武装保活，envKeepaliveInterval 连 env 都不读（见 shell.go 注释）
		Register: pvRegister,
		Log:      log.New(io.Discard, "", 0),
	}
}

// pvServe 起一个与 Serve http 分支同构的测试服务：newServer(modernProtocolVersions()) + newHTTPHandler。
func pvServe(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := pvConfig()
	server, err := newServer(cfg, modernProtocolVersions())
	if err != nil {
		t.Fatalf("newServer(modernProtocolVersions()) 失败: %v", err)
	}
	ts := httptest.NewServer(newHTTPHandler(cfg, server, cfg.Log))
	t.Cleanup(ts.Close)
	return ts
}

type pvRPCError struct {
	Code    int64           `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type pvRPCResp struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *pvRPCError     `json:"error"`
}

// pvPost：POST <url>，Accept: application/json, text/event-stream；
// protoHeader 非空时带 MCP-Protocol-Version；mcpMethod 非空时带 Mcp-Method——
// 新协议客户端必带此头（v1.8 streamable_headers.go:359-371 validateMcpHeaders，缺了先回 -32020）。
// 返回 HTTP 状态码、解析出的 JSON-RPC 响应
// （JSON 与 SSE 两种响应体都解析；非 JSON-RPC 的纯文本错误体解析不出，resp 为 nil）与原始正文。
func pvPost(t *testing.T, client *http.Client, url, protoHeader, mcpMethod, body string) (int, *pvRPCResp, string) {
	t.Helper()
	return pvPostNamed(t, client, url, protoHeader, mcpMethod, "", body)
}

// pvPostNamed 同 pvPost，mcpName 非空时再带 Mcp-Name——tools/call、resources/read、prompts/get
// 在 2026 头下必带此头（v1.8 streamable_headers.go:374-388，缺失或与正文 name 不符 → -32020）。
func pvPostNamed(t *testing.T, client *http.Client, url, protoHeader, mcpMethod, mcpName, body string) (int, *pvRPCResp, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if protoHeader != "" {
		req.Header.Set("MCP-Protocol-Version", protoHeader)
	}
	if mcpMethod != "" {
		req.Header.Set("Mcp-Method", mcpMethod)
	}
	if mcpName != "" {
		req.Header.Set("Mcp-Name", mcpName)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST %s 失败: %v", url, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读响应体失败: %v", err)
	}
	return resp.StatusCode, pvParse(string(raw)), string(raw)
}

// pvParse 从 JSON 或 SSE 正文里取出第一条带 id 的 JSON-RPC 响应。
func pvParse(raw string) *pvRPCResp {
	candidates := []string{strings.TrimSpace(raw)}
	if lines := dataLines(raw); len(lines) > 0 {
		candidates = candidates[:0]
		for _, l := range lines {
			candidates = append(candidates, strings.TrimSpace(strings.TrimPrefix(l, "data:")))
		}
	}
	for _, c := range candidates {
		var r pvRPCResp
		if json.Unmarshal([]byte(c), &r) != nil {
			continue
		}
		if len(r.ID) > 0 && (r.Result != nil || r.Error != nil) {
			return &r
		}
	}
	return nil
}

// pvInitializeBody 构造旧式 initialize（无 _meta，协议版本放 params.protocolVersion）。
func pvInitializeBody(version string) string {
	return `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + version +
		`","capabilities":{},"clientInfo":{"name":"pv-client","version":"0.0.0"}}}`
}

// pvModernParams 是 SEP-2575 形态请求的 params（_meta 带 protocolVersion 与 clientCapabilities，
// 后者缺失会先被 -32602 拒，见 v1.8 shared.go:590-596 validateRequestMeta）。
func pvModernParams(extraParams map[string]any) map[string]any {
	params := map[string]any{
		"_meta": map[string]any{
			mcp.MetaKeyProtocolVersion:    pvModern,
			mcp.MetaKeyClientCapabilities: map[string]any{},
			mcp.MetaKeyClientInfo:         map[string]any{"name": "pv-client", "version": "0.0.0"},
		},
	}
	for k, v := range extraParams {
		params[k] = v
	}
	return params
}

// modernBody 构造 SEP-2575 形态请求（id 固定 7）。
func modernBody(t *testing.T, method string, extraParams map[string]any) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": method, "params": pvModernParams(extraParams)})
	if err != nil {
		t.Fatalf("marshal modern body: %v", err)
	}
	return string(b)
}

// pvResultProtocolVersion 取 initialize 结果里的 protocolVersion。
func pvResultProtocolVersion(t *testing.T, r *pvRPCResp, raw string) string {
	t.Helper()
	if r == nil {
		t.Fatalf("响应里解析不出 JSON-RPC 消息: %q", raw)
	}
	if r.Error != nil {
		t.Fatalf("initialize 返回错误 %d %q，期望成功", r.Error.Code, r.Error.Message)
	}
	var res struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(r.Result, &res); err != nil {
		t.Fatalf("解析 initialize 结果: %v (%s)", err, r.Result)
	}
	return res.ProtocolVersion
}

// pvToolsCallExtra 是 tools/call 的 params 业务字段（name 与 Mcp-Name 头一致，arguments 合 pvEchoIn）。
func pvToolsCallExtra() map[string]any {
	return map[string]any{"name": "pv_echo", "arguments": map[string]any{"text": "pv-hello"}}
}

// pvEchoText 从 tools/call 结果里取单条 text（非 isError）。
func pvEchoText(t *testing.T, r *pvRPCResp, raw string) string {
	t.Helper()
	if r == nil || r.Error != nil {
		t.Fatalf("tools/call 未成功: %q", raw)
	}
	var res struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(r.Result, &res); err != nil {
		t.Fatalf("解析 tools/call 结果: %v (%s)", err, r.Result)
	}
	if res.IsError || len(res.Content) != 1 || res.Content[0].Type != "text" {
		t.Fatalf("tools/call 结果形态不对: %s", r.Result)
	}
	return res.Content[0].Text
}

func TestProtocolVersion_ModernListExact(t *testing.T) {
	want := []string{pvModern}
	got := modernProtocolVersions()
	if !slices.Equal(got, want) {
		t.Fatalf("modernProtocolVersions() = %v，want 精确 %v", got, want)
	}
	sdk := mcp.SupportedProtocolVersions()
	if !slices.Contains(sdk, pvModern) {
		t.Fatalf("SDK 支持列表 %v 不含 %s：SDK 版本不对", sdk, pvModern)
	}
	for _, v := range pvLegacyVersions {
		if !slices.Contains(sdk, v) {
			t.Fatalf("SDK 支持列表 %v 不含旧版本 %s：下面「旧版本被拒」的用例会空转", sdk, v)
		}
		if slices.Contains(got, v) {
			t.Fatalf("modern-only 列表 %v 含旧版本 %s", got, v)
		}
	}
	if err := validateProtocolVersions(got); err != nil {
		t.Fatalf("生产列表未通过 validateProtocolVersions: %v", err)
	}
	// 两次调用返回独立底层数组：改第一次的结果不影响第二次。
	got[0] = "mutated"
	if again := modernProtocolVersions(); !slices.Equal(again, want) {
		t.Fatalf("改第一次返回值污染了第二次: %v", again)
	}
}

func TestProtocolVersion_ConstructorModernOK(t *testing.T) {
	var registered atomic.Int32
	cfg := pvConfig()
	cfg.Register = func(s *mcp.Server) { registered.Add(1); pvRegister(s) }
	var server *mcp.Server
	var err error
	func() {
		defer func() {
			if p := recover(); p != nil {
				t.Fatalf("newServer(modern) panic: %v", p)
			}
		}()
		server, err = newServer(cfg, modernProtocolVersions())
	}()
	if err != nil || server == nil {
		t.Fatalf("newServer(modern) = (%v, %v)，期望成功", server, err)
	}
	if n := registered.Load(); n != 1 {
		t.Fatalf("Register 调用 %d 次，期望 1 次", n)
	}
}

// 坏列表全表：每格都必须在 mcp.NewServer 之前返回 error（不 panic、不调 Register）。
func TestProtocolVersion_ConstructorRejectsBadLists(t *testing.T) {
	cases := []struct {
		name     string
		versions []string
	}{
		{"nil", nil},
		{"empty", []string{}},
		{"unknown", []string{"2099-01-01"}},
		{"modern_plus_unknown", []string{pvModern, "2099-01-01"}},
		{"legacy_only", slices.Clone(pvLegacyVersions)},
		{"modern_plus_all_legacy", append([]string{pvModern}, pvLegacyVersions...)},
		{"modern_plus_20251125", []string{pvModern, "2025-11-25"}},
		{"modern_plus_20241105", []string{pvModern, "2024-11-05"}},
		{"single_20251125", []string{"2025-11-25"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var registered atomic.Int32
			cfg := pvConfig()
			cfg.Register = func(*mcp.Server) { registered.Add(1) }
			var server *mcp.Server
			var err error
			func() {
				defer func() {
					if p := recover(); p != nil {
						t.Fatalf("newServer(%v) panic（应在 mcp.NewServer 之前返回 error）: %v", tc.versions, p)
					}
				}()
				server, err = newServer(cfg, tc.versions)
			}()
			if err == nil || server != nil {
				t.Fatalf("newServer(%v) = (%v, %v)，期望 (nil, error)", tc.versions, server, err)
			}
			if n := registered.Load(); n != 0 {
				t.Fatalf("坏列表下 Register 被调用 %d 次，期望 0", n)
			}
		})
	}
}

// 新协议请求在 modern-only 下全部照常成功（与 UG-7 之前 legacy 收窄的 ModernRejected 恰好相反）。
func TestProtocolVersion_ModernAccepted(t *testing.T) {
	cases := []struct {
		method string
		name   string // 非空时带 Mcp-Name 头
		extra  map[string]any
	}{
		{"tools/list", "", nil},
		{"server/discover", "", nil},
		{"tools/call", "pv_echo", pvToolsCallExtra()},
	}
	ts := pvServe(t)
	for _, tc := range cases {
		t.Run(strings.ReplaceAll(tc.method, "/", "_"), func(t *testing.T) {
			status, r, raw := pvPostNamed(t, ts.Client(), ts.URL+"/mcp", pvModern, tc.method, tc.name, modernBody(t, tc.method, tc.extra))
			if status != http.StatusOK || r == nil || r.Error != nil || len(r.Result) == 0 {
				t.Fatalf("HTTP %d，body=%q；want 200 + result", status, raw)
			}
			if string(r.ID) != "7" {
				t.Fatalf("id = %s，want 7", r.ID)
			}
			if tc.method == "tools/call" {
				if got := pvEchoText(t, r, raw); got != "pv-hello" {
					t.Fatalf("回显 %q，want pv-hello", got)
				}
			}
		})
	}
}

// v1.8 streamable.go:1564-1571：带 2026 头、请求是 call、但缺 _meta.protocolVersion →
// writeJSONRPCError(400, CodeInvalidParams=-32602, "missing or invalid _meta field ...")。
func TestProtocolVersion_ModernMissingMeta400(t *testing.T) {
	ts := pvServe(t)
	body := `{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}`
	status, r, raw := pvPost(t, ts.Client(), ts.URL+"/mcp", pvModern, "tools/list", body)
	if status != http.StatusBadRequest {
		t.Fatalf("HTTP %d，want 400；body=%q", status, raw)
	}
	if r == nil || r.Error == nil {
		t.Fatalf("期望 JSON-RPC error，body=%q", raw)
	}
	if r.Error.Code != -32602 {
		t.Fatalf("error.code = %d (%q)，want -32602", r.Error.Code, r.Error.Message)
	}
}

// 头校验：与 ModernAccepted/tools_call 完全相同的请求只去掉 Mcp-Name 头 → 400 / -32020（CodeHeaderMismatch）。
// 依据 v1.8 streamable.go servePOST：validateMcpHeaders（:1614-1629）在 transport 层直接写 400 返回。
func TestProtocolVersion_ModernToolsCallMissingMcpNameHeader(t *testing.T) {
	ts := pvServe(t)
	body := modernBody(t, "tools/call", pvToolsCallExtra())
	status, r, raw := pvPostNamed(t, ts.Client(), ts.URL+"/mcp", pvModern, "tools/call", "", body)
	if status != http.StatusBadRequest {
		t.Fatalf("HTTP %d，want 400；body=%q", status, raw)
	}
	if r == nil || r.Error == nil {
		t.Fatalf("期望 JSON-RPC error，body=%q", raw)
	}
	if mcp.CodeHeaderMismatch != -32020 {
		t.Fatalf("SDK CodeHeaderMismatch = %d，want -32020", mcp.CodeHeaderMismatch)
	}
	if r.Error.Code != -32020 {
		t.Fatalf("error.code = %d (%q)，want -32020", r.Error.Code, r.Error.Message)
	}
	if !strings.Contains(r.Error.Message, "Mcp-Name") {
		t.Fatalf("error.message = %q，want 指明缺 Mcp-Name", r.Error.Message)
	}
	if string(r.ID) != "7" {
		t.Fatalf("error.id = %s，want 回显请求 id 7", r.ID)
	}
}

func TestProtocolVersion_UnknownServerVersionPanics(t *testing.T) {
	panicked := func() (p any) {
		defer func() { p = recover() }()
		mcp.NewServer(&mcp.Implementation{Name: "x", Version: "0"},
			&mcp.ServerOptions{SupportedProtocolVersions: []string{"2099-01-01"}})
		return nil
	}()
	if panicked == nil {
		t.Fatal("mcp.NewServer 遇未知版本未 panic：SDK 语义变了，validateProtocolVersions 的前置理由需复核")
	}
}

// 阴性对照：同一个带 MCP-Protocol-Version: 2025-11-25 头的旧式请求，modern-only server 回 400，
// 不收窄 server（SupportedProtocolVersions 为空 = SDK 全集）回 200 + result。两侧只差版本列表，
// 拒绝因此只能归因于 modern-only 收窄。
func TestProtocolVersion_LegacyHeaderUnrestrictedControl(t *testing.T) {
	cases := []struct{ name, body string }{
		{"initialize", pvInitializeBody("2025-11-25")},
		{"tools_list", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`},
	}
	restricted := pvServe(t)

	cfg := pvConfig()
	srv := mcp.NewServer(&mcp.Implementation{Name: cfg.Name, Version: cfg.Version}, &mcp.ServerOptions{})
	pvRegister(srv)
	open := httptest.NewServer(newHTTPHandler(cfg, srv, cfg.Log))
	t.Cleanup(open.Close)

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rStatus, rr, rRaw := pvPost(t, restricted.Client(), restricted.URL+"/mcp", "2025-11-25", "", tc.body)
			if rStatus != http.StatusBadRequest || rr != nil {
				t.Fatalf("modern-only %s：HTTP %d，body=%q；期望传输层 400 纯文本", tc.name, rStatus, rRaw)
			}
			status, r, raw := pvPost(t, open.Client(), open.URL+"/mcp", "2025-11-25", "", tc.body)
			if status != http.StatusOK || r == nil || r.Error != nil || len(r.Result) == 0 {
				t.Fatalf("不收窄 %s：HTTP %d，body=%q；期望 200 + result（证明请求形态本身合法）", tc.name, status, raw)
			}
		})
	}
}

// pvPaddedModernBody 拼一个总长恰好 total 字节的**新协议** tools/list 请求（params.pad 填充）。
func pvPaddedModernBody(t *testing.T, total int) string {
	t.Helper()
	const marker = "\x00PAD\x00"
	b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 9, "method": "tools/list",
		"params": pvModernParams(map[string]any{"pad": marker})})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	enc, _ := json.Marshal(marker)
	encMarker := strings.Trim(string(enc), `"`)
	n := total - (len(s) - len(encMarker))
	if n < 0 {
		t.Fatalf("total %d 太小", total)
	}
	body := strings.Replace(s, encMarker, strings.Repeat("x", n), 1)
	if len(body) != total {
		t.Fatalf("body 长度 %d != %d", len(body), total)
	}
	return body
}

// pvHead 截取正文前 256 字节供失败信息使用（2MiB 正文整段打印无意义）。
func pvHead(raw string) string {
	if len(raw) > 256 {
		return raw[:256]
	}
	return raw
}

func TestProtocolVersion_BodyLimit2MiBPlus1Exact413(t *testing.T) {
	ts := pvServe(t)
	url := ts.URL + "/mcp"

	status, _, raw := pvPost(t, ts.Client(), url, pvModern, "tools/list", pvPaddedModernBody(t, maxRequestBodyBytes+1))
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("body = maxRequestBodyBytes+1 (%d)：HTTP %d，want 精确 413；body=%q", maxRequestBodyBytes+1, status, pvHead(raw))
	}

	// 恰好到上限：必须被完整读入并由 JSON-RPC 层作答（200 + id 回显）。
	status, r, raw := pvPost(t, ts.Client(), url, pvModern, "tools/list", pvPaddedModernBody(t, maxRequestBodyBytes))
	if status != http.StatusOK {
		t.Fatalf("body = maxRequestBodyBytes (%d)：HTTP %d，want 200；body 前 256 字节=%q", maxRequestBodyBytes, status, pvHead(raw))
	}
	if r == nil || string(r.ID) != "9" {
		t.Fatalf("body = maxRequestBodyBytes (%d)：解析不出 id=9 的 JSON-RPC 响应，resp=%+v；body 前 256 字节=%q", maxRequestBodyBytes, r, pvHead(raw))
	}
	if r.Error != nil || len(r.Result) == 0 {
		t.Fatalf("body = maxRequestBodyBytes (%d)：期望 tools/list 成功 result，得 error=%+v", maxRequestBodyBytes, r.Error)
	}
}

// go-sdk 真实客户端默认（先 server/discover 2026-07-28）对 modern-only 协商出 2026-07-28 并能列、调工具。
func TestProtocolVersion_GoClientNegotiatesModern(t *testing.T) {
	ts := pvServe(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client := mcp.NewClient(&mcp.Implementation{Name: "pv-go-client", Version: "0.0.0"}, nil)
	cs, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: ts.URL + "/mcp", HTTPClient: ts.Client()}, nil)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer cs.Close()
	if got := cs.InitializeResult().ProtocolVersion; got != pvModern {
		t.Fatalf("Go client 协商结果 %q，want %s", got, pvModern)
	}
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(res.Tools) != 1 || res.Tools[0].Name != "pv_echo" {
		t.Fatalf("ListTools = %+v，want 仅 pv_echo", res.Tools)
	}
	cr, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "pv_echo", Arguments: map[string]any{"text": "go-modern"}})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	tc, ok := cr.Content[0].(*mcp.TextContent)
	if cr.IsError || len(cr.Content) != 1 || !ok || tc.Text != "go-modern" {
		t.Fatalf("CallTool 结果 = %+v，want 回显 go-modern", cr)
	}
	if err := cs.Close(); err != nil && !errors.Is(err, context.Canceled) {
		t.Logf("Close: %v", err)
	}
}
