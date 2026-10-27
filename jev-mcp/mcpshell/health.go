package mcpshell

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Stats 是三个薄壳共用的调用计数器（served/failed/在飞由 Gate 报）。
// 报它是因为「计数只增不减的东西」比 RSS 爬升更早暴露泄漏。全部 atomic，可并发。
type Stats struct {
	served    atomic.Int64
	failed    atomic.Int64
	startedAt time.Time
}

// NewStats 建一个以此刻为起点的计数器。
func NewStats() *Stats { return &Stats{startedAt: time.Now()} }

func (s *Stats) MarkServed() { s.served.Add(1) }
func (s *Stats) MarkFailed() { s.failed.Add(1) }
func (s *Stats) Served() int64 {
	if s == nil {
		return 0
	}
	return s.served.Load()
}
func (s *Stats) Failed() int64 {
	if s == nil {
		return 0
	}
	return s.failed.Load()
}
func (s *Stats) Uptime() time.Duration {
	if s == nil {
		return 0
	}
	return time.Since(s.startedAt)
}

// HealthOptions 描述一个自检工具。
type HealthOptions struct {
	// Name 是 MCP 工具名（如 "jev_health"）。
	Name string
	// Title/Description 给客户端看。留空时用通用文案。
	Title       string
	Description string
	// Gate 可选：报在飞数与上限。
	Gate *Gate
	// Stats 可选：报累计服务/失败数与运行时长。
	Stats *Stats
	// Extra 可选：服务自己的行（钉死的模型版本、模板数、key 是否加载、job 表占用…）。
	// 每次调用时求值，所以报的是实时状态。
	Extra func() []string
}

// AddHealthTool 给 server 挂一个通用自检工具。
//
// 为什么 Go 版**不需要** Node 版那个 `--expose-gc` 启动开关：Node 侧读 heapUsed 拿到的是
// GC 周期里的瞬时值，噪声能淹没「是否泄漏」这个信号，所以那边得先 global.gc() 再采样，
// 而 global.gc 只在带 --expose-gc 启动时存在。Go 侧不必，但理由**不是**「HeapAlloc 与
// GC 时相无关」——那句原话是错的（PiMoa review 2026-09-19 纠正）：HeapAlloc 含已分配
// 但尚未被清扫的垃圾对象，同样随 GC 周期锯齿波动。真正的理由是 runtime.ReadMemStats
// 会 stop the world 取一致快照（不会读到撕裂的中间态），以及 Go 有 NumGoroutine——
// goroutine 只增不减是比任何内存读数都直接的泄漏证据。
// 所以单次内存读数不足以判泄漏，要看多次采样的走势，这一点下面也写了。
//
// RSS 的说明：Go 标准库拿不到「当前 RSS」，只能经 getrusage 拿**峰值** RSS。所以这里把
// 它明确标成峰值，不冒充当前值（谎标一个数比不报更糟）。判泄漏看 HeapAlloc/HeapSys/
// NumGoroutine 三个随时间的走势，RSS 峰值只作上界参考。
func AddHealthTool(server *mcp.Server, opt HealthOptions) {
	title := opt.Title
	if title == "" {
		title = "自检：进程内存、goroutine 数、累计请求数"
	}
	desc := opt.Description
	if desc == "" {
		desc = "返回本 MCP 进程的实时内存与累计请求数——用来验证「调用一次占一次内存」没有发生。" +
			"反复调用业务工具后再看 HeapAlloc / goroutine 数，持续爬升即为泄漏。"
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        opt.Name,
		Title:       title,
		Description: desc,
		// 无入参：显式给一个空 object schema，避免客户端按「未声明」处理。
		InputSchema: &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{}},
	}, func(_ context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		return TextResult(HealthReport(opt), false), nil, nil
	})
}

// HealthReport 生成自检正文（独立导出，便于测试与非 MCP 场景复用）。
func HealthReport(opt HealthOptions) string {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	lines := []string{
		fmt.Sprintf("Go 堆：活对象 %s / 堆保留 %s / 向 OS 申请总计 %s",
			mib(mem.HeapAlloc), mib(mem.HeapSys), mib(mem.Sys)),
		fmt.Sprintf("goroutine %d 个（只增不减即为泄漏）；累计 GC %d 次", runtime.NumGoroutine(), mem.NumGC),
		fmt.Sprintf("峰值 RSS：%s（getrusage 报的是**峰值**，不是当前值）", mib(peakRSSBytes())),
	}
	if opt.Stats != nil {
		lines = append(lines, fmt.Sprintf("已服务 %d 次 / 失败 %d 次", opt.Stats.Served(), opt.Stats.Failed()))
		lines = append(lines, fmt.Sprintf("运行时长：%.1f 分钟", opt.Stats.Uptime().Minutes()))
	}
	if opt.Gate != nil {
		max := "不限"
		if opt.Gate.Max() > 0 {
			max = fmt.Sprintf("%d", opt.Gate.Max())
		}
		lines = append(lines, fmt.Sprintf("在飞 %d（上限 %s）", opt.Gate.InFlight(), max))
	}
	// 会话表这一项 Go 版**恒为 n/a**：stateless 传输不维护 sessionId→transport 表，
	// 「会话只增不减」这个泄漏形态在 Go 侧不存在（见 mcpshell 包注释）。
	lines = append(lines, "活跃会话：n/a（stateless 传输，无会话表——这正是 Go 版不需要空闲清扫的原因）")
	if opt.Extra != nil {
		lines = append(lines, opt.Extra()...)
	}
	return strings.Join(lines, "\n")
}

func mib(b uint64) string { return fmt.Sprintf("%.1f MB", float64(b)/1024/1024) }

// peakRSSBytes 经 getrusage 读峰值 RSS。darwin 的 ru_maxrss 单位是**字节**，
// linux 是 **KiB**——单位差 1024 倍，弄错会让报告差三个量级。
func peakRSSBytes() uint64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return uint64(ru.Maxrss)
	}
	return uint64(ru.Maxrss) * 1024
}
