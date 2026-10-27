package mcpshell

// 层①：progress 心跳——给「按 progress 重置请求超时」的客户端续命。
//
// 与层②（keepalive.go）的关系：两层**并行**，不互斥、不互相替代。层② 在传输层补 SSE
// 注释行，治的是客户端传输栈的空闲超时（undici 300s），不依赖客户端任何声明；层① 在协议层
// 发 `notifications/progress`，只有客户端给了 `_meta.progressToken` 才生效。
//
// 【为什么必须是「有条件生效」】不发 token 的客户端（今天的 DSH：dsh-mcp-client 调
// callTool 时不传 onprogress，SDK 因而不注入 _meta.progressToken）拿不到也读不懂心跳，
// 发了纯属噪音；而 MCP 规范明确：服务端**只能**对请求里给过 token 的调用回发 progress。
// ⇒ 没 token 就返回空函数，这是「对 DSH 零影响」的**机械保证**（V-prog2 断言它）。
//
// 【它治不了什么，照实写】Claude Code 这一版单次调用有 60s fetch 硬墙钟，其自带文档原文
// 写明 progress 不延长它；DSH 对 jev 的 180s 是墙钟，也不是空闲超时。这两件由客户端配置
// 或后台 job 处置，不属本模块。

import (
	"context"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// progressHeartbeatInterval 对齐 PiMoa server.ts:134 的 PROGRESS_HEARTBEAT_MS = 20_000：
// 20s 是客户端 60s 协议超时的 1/3，留三倍余量抗调度抖动。
const progressHeartbeatInterval = 20 * time.Second

// StartProgressHeartbeat 起一个周期性发 `notifications/progress` 的心跳，返回 stop。
// 三条铁律（都由真机探针实测确认过，见 repro/progress_probe_test.go）：
//
//  1. **必须用调用方传进来的 ctx**（工具 handler 收到的那个、携带路由信息），
//     **不得**改用 context.Background()——通知要经该请求的会话/流送回去，换了 ctx 就送不出去。
//  2. `req.Params.GetProgressToken()` 为 nil ⇒ **直接返回空函数，一条都不发**。
//  3. `progress` 从 1 开始**单调递增**，**不传 total**（总量未知，进度条不可估算，MCP 规范要求递增）。
//
// 发送失败（客户端已断开、流已坏）**静默吞掉**：那是正常情形，把错误抛进请求路径或刷日志
// 只会污染日志。定时器随 stop() 停，handler 返回即收尾。
//
// ⚠️ 名字是**导出**的：它住在 mcpshell 包、调用点在 cmd/antigravity-mcp 与 cmd/jev-mcp
// 两个 `package main`，非导出标识符跨包不可见（任务书与设计稿正文都写作
// `startProgressHeartbeat`，但按那个字面写会直接编译不过）。签名与语义未变。
//
// 生产间隔钉死为 progressHeartbeatInterval（20s）；单测要验「结果之前真的收到 N 条」
// 只能注入短间隔，走下面的内核（设计稿 §4.2 给的原签名就带 interval 入参）。
func StartProgressHeartbeat(ctx context.Context, req *mcp.CallToolRequest, message func(time.Duration) string) (stop func()) {
	return startProgressHeartbeat(ctx, req, progressHeartbeatInterval, message)
}

// startProgressHeartbeat 是带间隔入参的内核（单测注入短间隔用；生产走上面的包装）。
func startProgressHeartbeat(ctx context.Context, req *mcp.CallToolRequest, interval time.Duration, message func(time.Duration) string) (stop func()) {
	if req == nil || req.Params == nil || req.Session == nil {
		return func() {}
	}
	tok := req.Params.GetProgressToken()
	if tok == nil {
		return func() {} // 铁律 2：没给 token ⇒ 一条都不发
	}

	stopCh, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		tk := time.NewTicker(interval)
		defer tk.Stop()
		started := time.Now()
		n := 0
		for {
			select {
			case <-stopCh:
				return
			case <-tk.C:
				n++ // 铁律 3：从 1 开始单调递增
				msg := ""
				if message != nil { // nil-safe：这里在 goroutine 里，panic 会带走整个进程
					msg = message(time.Since(started))
				}
				// 铁律 1：用调用方给的 ctx。失败静默吞掉。
				_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
					ProgressToken: tok,
					Progress:      float64(n),
					Message:       msg,
				})
			}
		}
	}()
	return func() { close(stopCh); <-done }
}
