// Package mcpshell 是四个自建 MCP 薄壳（devkb / jev / claude-dispatch / antigravity）
// 共用的 Go 骨架。
//
// 背景（徐总 2026-09-18 裁决）：四个薄壳统一到 Go——单一静态二进制、无 node_modules/venv
// 依赖、内存降一个量级、与 PaperGo 主语言一致。devkb 尤其讽刺：bin/devkb 本身就是 Go
// 二进制，Node 壳的全部工作只是 spawn 它。
//
// 骨架封装四个服务共有的部分，让每个服务只写「工具定义 + 怎么调外部程序」两块：
//   - streamable HTTP（stateless）传输 + 只绑 127.0.0.1
//   - stdio 传输作为兼容回退（env 开关切换）
//   - 进程级在飞熔断（见 Gate：不随会话数放大）
//   - 统一输出截断（见 Clip）
//   - spawn 外部程序：cwd / env / 超时 / 客户端取消→kill 整个进程组（见 Runner）
//   - 日志一律走 stderr
//
// ⚠️ 为什么这里**没有**会话表、空闲清扫、会话数上限？
// Node 版有那三样东西（还为它们打过两轮补丁：NaN 忙循环、Map 插入序误斩活跃会话），
// 根因是 Node SDK 的 StreamableHTTPServerTransport 一个实例只能绑一个会话，
// 服务端不得不自己维护 sessionId→transport 的表，于是「客户端不发 DELETE 就泄漏」
// 成了服务端的债。Go SDK 支持 stateless 模式：不校验 Mcp-Session-Id，每个请求用
// 一个临时会话、请求结束即销毁，整个问题类别不存在，所以不是漏迁移，是不需要。
// stateless 已在 Claude（claude mcp list 报 ✔ Connected）与 Codex
// （codex-mcp-client/0.154.0 走完 initialize→notifications/initialized→tools/list，
// 请求不带 Mcp-Session-Id）两个客户端实测连通。
//
// 信任模型（徐总 2026-08-12 拍板，Go 版沿用）：本机开发环境，只绑 127.0.0.1，不加鉴权。
//
// ⚠️ stdio 模式下 stdout 是 MCP 传输通道，任何日志只能走 stderr。NewLogger 已经钉死
// 这一点，服务代码不要另外 fmt.Println。
package mcpshell

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// 请求体上限（Node 版 MoA 评审 P2-1 口径）：本机可信但不等于无界，
// 一个手误的巨型 payload 不该把壳撑爆。
const maxRequestBodyBytes = 2 << 20 // 2MiB

// httpReadHeaderTimeout 只管**读请求头**，不碰 body/响应：工具调用可以跑 120s，
// 所以绝不能设 ReadTimeout/WriteTimeout（会把长查询和 SSE 流掐断）。
const httpReadHeaderTimeout = 15 * time.Second

// shutdownGrace：SIGTERM 后给在飞请求的宽限。短是有意的——
// 子进程都是短命查询，最长的自己会撞超时退出，不值得为它拖住重启。
const shutdownGrace = 2 * time.Second

// firstModernProtocolVersion 是 SEP-2575 新协议（无会话、每请求带 _meta）的起始版本。
// 版本号是 ISO 日期，按字符串比较即按时间比较（SDK 内部同一口径）。
const firstModernProtocolVersion = "2026-07-28"

// modernProtocolVersions 是本服务唯一对外承诺的 MCP 协议版本集合（UG-8 modern-only，台账 DEC-76）：
// 只认 2026-07-28，喂给 mcp.ServerOptions.SupportedProtocolVersions。
// 旧协议（2025-11-25 及更早）一律不在列表内；协议版本**没有**任何构建期或运行期开关。
//
// ⚠️ 必须非空：SDK 把空列表当「不限制」，返回 nil/空切片等于静默放行全部版本。
// ⚠️ 只能写 SDK 认识的版本：未知字符串会让 mcp.NewServer 直接 panic。
// 两条都由 validateProtocolVersions 在 mcp.NewServer 之前拦成 error。
// 每次调用返回新切片，调用方改它不会污染下一次。
//
// 已知 SDK 行为（ACT-24，go-sdk v1.8.0 实测，见 protocol_modern_test.go）：带旧版本
// MCP-Protocol-Version 头的请求在传输层 400；**不带**版本头、也不带 _meta 的旧式请求不被拦截。
func modernProtocolVersions() []string {
	return []string{firstModernProtocolVersion}
}

// validateProtocolVersions 在交给 mcp.NewServer 之前把坏列表拦成 error：
// 空（SDK 当「不限制」→ 旧协议静默放行）、SDK 不认识的版本（SDK 直接 panic）、
// 任何 < 2026-07-28 的旧协议版本（modern-only 失效）。
func validateProtocolVersions(versions []string) error {
	if len(versions) == 0 {
		return errors.New("协议版本列表为空：go-sdk 会把空列表当「不限制」，拒绝构造")
	}
	sdkVersions := mcp.SupportedProtocolVersions()
	for _, v := range versions {
		if !slices.Contains(sdkVersions, v) {
			return fmt.Errorf("协议版本 %q 不在 go-sdk 支持列表 %v 内", v, sdkVersions)
		}
		if v < firstModernProtocolVersion {
			return fmt.Errorf("协议版本 %q 属于旧协议（< %s），modern-only 列表不得包含", v, firstModernProtocolVersion)
		}
	}
	return nil
}

// newServer 是生产 server 的唯一构造点：Serve 与协议版本测试走同一条路径。
// versions 先过 validateProtocolVersions，坏列表在 mcp.NewServer 之前返回 error
// （既不 panic，也不静默退化成不限制）；cfg.Register 只在校验通过后调用。
func newServer(cfg Config, versions []string) (*mcp.Server, error) {
	if err := validateProtocolVersions(versions); err != nil {
		return nil, err
	}
	server := mcp.NewServer(
		&mcp.Implementation{Name: cfg.Name, Version: cfg.Version},
		&mcp.ServerOptions{
			Instructions:              cfg.Instructions,
			SupportedProtocolVersions: versions,
		},
	)
	cfg.Register(server)
	return server, nil
}

// Config 描述一个薄壳。四个服务各填一份。
type Config struct {
	// Name 是 MCP 服务名，同时用作日志前缀（如 "devkb"→"[devkb-mcp] …"）。
	Name string
	// Version 是 MCP Implementation.Version。
	Version string
	// EnvPrefix 是 env 旋钮前缀（如 "DEVKB_MCP" → DEVKB_MCP_TRANSPORT / _PORT）。
	EnvPrefix string
	// DefaultPort 是 http 模式默认端口（devkb=8759 / claude-dispatch=8757 / jev=8760…）。
	DefaultPort int
	// Instructions 可选，透给客户端的服务级说明。
	Instructions string
	// SSEKeepalive 是长响应在 SSE 形态下的保活间隔（层②，见 keepalive.go）；
	// **0 表示关闭**（零值即旧行为）。
	//
	// 只该由「存在单次调用可能超过客户端传输层空闲上限」的壳显式开启——开了才有保活，
	// 没开的壳行为与响应**逐字节不变**。真正的起表点在长工具 handler 里
	// （`defer mcpshell.StartKeepalive(ctx)()`），本字段只决定要不要包那层 writer。
	SSEKeepalive time.Duration
	// Register 往 server 上挂工具。http 模式下**同一个 server 实例**服务所有请求
	// （Go SDK 一个 Server 可带多会话），所以这里注册的闭包会被并发调用：
	// 闭包捕获的状态必须自己保证并发安全（Runner/Gate 都是安全的）。
	Register func(*mcp.Server)
	// Log 可选；nil 时按 Name 建一个写 stderr 的。
	Log *log.Logger
}

// NewLogger 返回写 stderr 的日志器（stdout 在 stdio 模式下是 MCP 通道）。
func NewLogger(name string) *log.Logger {
	return log.New(os.Stderr, fmt.Sprintf("[%s-mcp] ", name), log.LstdFlags)
}

// Serve 按 env 选传输并阻塞运行，直到 stdin 关闭（stdio）或收到 SIGTERM/SIGINT。
func Serve(cfg Config) error {
	if cfg.Name == "" || cfg.Register == nil {
		return errors.New("mcpshell.Serve: Name 与 Register 必填")
	}
	logger := cfg.Log
	if logger == nil {
		logger = NewLogger(cfg.Name)
	}

	// modern-only（DEC-76）：版本列表固定，无构建期 / 运行期开关。
	versions := modernProtocolVersions()
	server, err := newServer(cfg, versions)
	if err != nil {
		return fmt.Errorf("mcpshell.Serve: %w", err)
	}
	// 一行核对用：运维据此确认二进制只认新协议（不含任何凭据）。
	logger.Printf("protocol mode=modern versions=%s", strings.Join(versions, ","))

	// SIGTERM/SIGINT → ctx 取消 → 有序退出（在飞子进程由 Runner 的 ctx 传导 kill）。
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	transport := Env(cfg.EnvPrefix+"_TRANSPORT", "stdio")
	switch transport {
	case "http":
		return serveHTTP(ctx, cfg, server, logger)
	case "stdio":
		return serveStdio(ctx, server, logger)
	default:
		return fmt.Errorf("%s_TRANSPORT=%q 不认识（只收 stdio|http）", cfg.EnvPrefix, transport)
	}
}

func serveHTTP(ctx context.Context, cfg Config, server *mcp.Server, logger *log.Logger) error {
	port := EnvPositiveInt(cfg.EnvPrefix+"_PORT", cfg.DefaultPort, logger)
	mux := newHTTPHandler(cfg, server, logger)

	httpServer := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: httpReadHeaderTimeout,
		// BaseContext 把**信号 ctx** 接成每个请求 ctx 的祖先。缺了它，上面第 100 行
		// 注释承诺的「SIGTERM → ctx 取消 → 在飞子进程被 kill」等于没实现：
		// Go 默认的基础 ctx 是 context.Background()，信号 ctx 到不了 handler；而
		// http.Server.Shutdown 只**等**在飞请求结束，从不取消它们的 ctx。
		// 后果是：重启时若有工具调用在飞，宽限期满 Close() 直接返回，已 spawn 的子进程
		// 因 Setpgid:true 自成进程组、不随父死，会一直残留到自己的超时（devkb 是 120s，
		// claude-dispatch 更长）。常驻服务频繁重启时每次都可能留一批孤儿。
		//
		// 这个取舍不必犹豫：宽限只有 shutdownGrace（2s），一个长查询无论如何都完不成，
		// 取消它换来子进程被确实杀掉，严格优于留孤儿。
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	// 显式 Listen 再喊 ready：启动器（start-papergo-deps.sh）用 TCP 监听判就绪，
	// 先打印后监听会让日志比事实早一步。
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return fmt.Errorf("绑定 127.0.0.1:%d 失败: %w", port, err)
	}
	logger.Printf("ready (http://127.0.0.1:%d/mcp)  transport=http stateless=true", port)

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(ln) }()

	// http 模式**绝不**监听 stdin：nohup 起服务时 stdin 立刻 close，
	// 挂了等于起来就自杀（Node 版同款纪律，语言无关）。
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		logger.Printf("收到退出信号，%s 内关闭 http 监听", shutdownGrace)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			// 宽限到点仍有在飞请求：强关。子进程已随 ctx 取消被杀。
			_ = httpServer.Close()
		}
		return nil
	}
}

// newHTTPHandler 组装 /mcp 的完整生产 handler 链（SDK handler → 可选 SSE 保活 → 2MiB body 上限），
// serveHTTP 与协议版本测试共用，保证测试测的就是线上那条链。
func newHTTPHandler(cfg Config, server *mcp.Server, logger *log.Logger) http.Handler {
	// stateless=true：不校验 Mcp-Session-Id、每请求一个临时会话。
	// 代价是服务端→客户端的主动请求不可用（elicitation/sampling/roots）——
	// 四个薄壳都不用这些能力，纯 request/response。
	handler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true},
	)

	mux := http.NewServeMux()
	// 层②（传输层 SSE 保活）在这里接线——**按壳显式开启**：SSEKeepalive 为零值（默认）
	// 就不武装中间件，行为与响应逐字节不变（devkb / claude-dispatch 两个壳走的正是这条）。
	//
	// ⚠️ 零值（未 opt-in）时 env **点不着火**：下面这行的 fallback 就是 Config.SSEKeepalive，
	// envKeepaliveInterval 见 fallback <= 0 直接返回 0、**连 env 都不读**。env 只能给已 opt-in
	// 的壳调优与急停（=0/off/false），否则上面那句「逐字节不变」会退化成「取决于环境里恰好
	// 有没有设那个变量」的条件承诺。
	//
	// ⚠️ 这里**不能**用现成的 EnvDuration 取值：它把 <=0 当非法输入并**回落默认值**
	// （env.go:81-99），于是 "<PREFIX>_SSE_KEEPALIVE=0" 会被警告一句、然后回落到 15s——
	// **关不掉**。用 keepalive.go 内专配的 envKeepaliveInterval：0 / off / false = 显式关闭，
	// 其余按 EnvDuration 的语法解析，非法值才回落默认；值越过 V-const 安全余量（interval×20 >
	// 300s）时**告警但不 clamp**（保活静默失效必须留下可观测信号）。
	h := http.Handler(handler)
	if interval := envKeepaliveInterval(cfg.EnvPrefix+"_SSE_KEEPALIVE", cfg.SSEKeepalive, logger); interval > 0 {
		h = withSSEKeepalive(h, interval) // 只包 writer + 把 writer 塞进请求 ctx，不起表
	}
	mux.Handle("/mcp", withBodyLimit(h))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found（MCP 端点是 /mcp）", http.StatusNotFound)
	})
	return mux
}

func serveStdio(ctx context.Context, server *mcp.Server, logger *log.Logger) error {
	logger.Printf("ready (stdio)")
	// 客户端死亡 → stdin 关闭 → Run 返回 → 退出（查询短命，无在途资产需要 drain）。
	err := server.Run(ctx, &mcp.StdioTransport{})
	if err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, os.ErrClosed)) {
		return nil
	}
	return err
}

// withBodyLimit 给 POST body 加硬上限；超限时 SDK 读 body 会拿到错误并回 4xx。
// SDK 自身默认 4MiB，外层 2MiB 更紧，所以实际上限仍是 2MiB；超限 SDK 回 413。
func withBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// TextResult 把一段正文包成 MCP 工具结果。isError=true 时客户端会把它当工具错误
// 展示给模型（而不是协议错误），模型因此能自我纠正——这是 MCP 规范的要求。
func TextResult(text string, isError bool) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: isError,
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}
}
