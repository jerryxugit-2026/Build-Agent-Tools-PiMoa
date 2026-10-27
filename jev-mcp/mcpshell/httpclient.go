package mcpshell

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Outbound 是「出站调远端 HTTPS API」这件事的统一落点，给 jev 这类没有子进程、
// 重活在远端的薄壳用（对应 Runner 之于有子进程的薄壳）。
//
// 核心纪律（jev-mcp Node 版 agent:false 的 Go 对译）：**每次调用新建连接、用完即关，
// 不用连接池**。代价是每次约 100ms TLS 握手，换来的是零 socket 累积——薄壳常驻数周、
// 被四个客户端反复调用，任何「每次调用留下一点」的东西最终都会变成内存事故。
// Go 里默认的 http.DefaultTransport 恰恰是带 keep-alive 连接池的，所以这里必须
// 显式 DisableKeepAlives，并且在每次请求后 CloseIdleConnections。
type Outbound struct {
	client *http.Client
	// Timeout 是单次请求的硬超时（含连接+发送+读完响应体）。
	Timeout time.Duration
	// MaxRetries 是退避重试次数（总尝试次数 = MaxRetries+1）。
	MaxRetries int
	// RetryOn 判定某个 HTTP 状态码是否值得重试；nil 时只重试网络层错误。
	RetryOn func(status int) bool
	// Backoff 给第 attempt 次（从 0 起）失败后的等待时长；nil 时用 2^attempt 秒。
	Backoff func(attempt int) time.Duration
	// MaxResponseBytes 是响应体读取上限，0=不限。防一个失控的远端把壳撑爆。
	// NewOutbound 会给它一个默认值——注释说要防的事，不能靠调用方记得去开。
	MaxResponseBytes int64
	// RetryAmbiguousTransportErrors 放开「请求可能已被服务端处理」那一类错误的重试。
	//
	// 默认 false，因为 PostJSON 发的是 **POST，不是幂等请求**（PiMoa review 2026-09-19）。
	// 传输层错误分两种，后果天差地别：
	//   ①「从没送到」——拨号失败、DNS 解析失败。服务端根本没见过这个请求，重发绝对安全。
	//   ②「送到了但没读到回应」——连接已建立后超时/被重置。服务端很可能**已经执行过**，
	//      重发就是重复执行。jev 调的是计费判定 API，重发等于重复扣额度，而且判定结果
	//      本身也会被算两次。
	// 所以默认只重试第 ① 类（由 requestNeverSent 判定）。确认远端幂等的调用方可以把
	// 这个开关打开，换取对第 ② 类瞬断的韧性。
	RetryAmbiguousTransportErrors bool
}

// defaultMaxResponseBytes 是出站响应体的兜底上限。8MiB 对判定类 API 的 JSON 响应
// 绰绰有余，同时挡得住一个失控远端把整个壳撑爆。
const defaultMaxResponseBytes = 8 << 20

// errBodyChars 是嵌进 error 文本的远端响应体上限（按字符）。
const errBodyChars = 2_000

// ErrResponseTooLarge 表示远端响应体超过 MaxResponseBytes。
// 单列一个哨兵是为了让它**不要**走传输层错误那条重试判断：这不是网络故障，
// 请求确定已经成功往返过，重发只会再拿一次同样超大的响应。
var ErrResponseTooLarge = errors.New("远端响应体超过上限")

// requestNeverSent 判断这个传输层错误是否**证明**请求根本没到达服务端。
// 只认拨号与 DNS 两类：连接都没建立起来，服务端不可能见过这个请求。
// 其余一律当作「可能已执行」——宁可让调用方看到一次失败，也不能悄悄重复执行一次
// 计费操作。client.Do 会把错误包进 *url.Error，errors.As 能穿过去。
func requestNeverSent(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return opErr.Op == "dial"
	}
	return false
}

// NewOutbound 建一个「不复用连接」的出站客户端。
func NewOutbound(timeout time.Duration, maxRetries int) *Outbound {
	return &Outbound{
		client: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				// 这三行就是 Node 的 agent:false：不留空闲连接、池子容量为 0。
				DisableKeepAlives:   true,
				MaxIdleConns:        0,
				MaxIdleConnsPerHost: -1,
			},
		},
		Timeout:          timeout,
		MaxRetries:       maxRetries,
		MaxResponseBytes: defaultMaxResponseBytes,
	}
}

// Response 是一次出站调用的机械事实。状态码非 2xx 不算 error——
// 怎么解释状态码是各服务自己的事（与 Runner.Result 同款分工）。
type Response struct {
	Status   int
	Body     string
	Attempts int // 实际尝试次数（1=首发即成）
	Duration time.Duration
}

// PostJSON 发一次 JSON POST，按 RetryOn/Backoff 重试。
//
// 取消语义：ctx 取消（MCP 客户端取消请求）即刻中止在途请求，并且**退避窗口里也复查**——
// 这条是 Node 版踩过的坑：退避最长 8 秒，客户端很可能在这期间取消，不复查就会白发
// 一次远端请求（既烧配额又没人要答案）。
func (o *Outbound) PostJSON(ctx context.Context, url string, body []byte, headers map[string]string) (Response, error) {
	total := o.MaxRetries
	if total < 0 {
		total = 0
	}
	start := time.Now()
	var lastErr error
	for attempt := 0; attempt <= total; attempt++ {
		if err := ctx.Err(); err != nil {
			return Response{Attempts: attempt, Duration: time.Since(start)}, err
		}
		resp, err := o.once(ctx, url, body, headers)
		if err == nil {
			resp.Attempts = attempt + 1
			resp.Duration = time.Since(start)
			if attempt < total && o.RetryOn != nil && o.RetryOn(resp.Status) {
				// 错误文本里的 body 要截断：它是**远端**的响应体，未必短，也未必干净，
				// 而这串最终会一路回到 MCP 客户端。（PiMoa review 2026-09-19）
				lastErr = fmt.Errorf("HTTP %d: %s", resp.Status, Clip(resp.Body, errBodyChars))
				if werr := o.wait(ctx, attempt); werr != nil {
					// 退避期间被取消：如实返回取消，不再白发。
					return resp, werr
				}
				continue
			}
			return resp, nil
		}
		lastErr = err
		// ctx 已取消就别重试了（否则新请求立刻又失败，纯浪费）。
		if ctx.Err() != nil {
			return Response{Attempts: attempt + 1, Duration: time.Since(start)}, ctx.Err()
		}
		// 响应体超限不是网络故障：这一趟已经成功往返，重发只会再拿一次同样超大的
		// 响应。原样返回（含已读到的那截 body），别套「可能已被远端处理」的话术。
		if errors.Is(err, ErrResponseTooLarge) {
			resp.Attempts = attempt + 1
			resp.Duration = time.Since(start)
			return resp, err
		}
		// POST 不是幂等请求：只有在「证明请求从没送到服务端」时才敢重发。
		// 判据与理由见 RetryAmbiguousTransportErrors 的注释。
		if !o.RetryAmbiguousTransportErrors && !requestNeverSent(err) {
			return Response{Attempts: attempt + 1, Duration: time.Since(start)},
				fmt.Errorf("%w（请求可能已被远端处理，未重发；确认远端幂等可开 "+
					"RetryAmbiguousTransportErrors）", err)
		}
		if attempt < total {
			if werr := o.wait(ctx, attempt); werr != nil {
				return Response{Attempts: attempt + 1, Duration: time.Since(start)}, werr
			}
			continue
		}
	}
	return Response{Attempts: total + 1, Duration: time.Since(start)}, lastErr
}

func (o *Outbound) once(ctx context.Context, url string, body []byte, headers map[string]string) (Response, error) {
	// 每次请求自带超时上限：http.Client.Timeout 已覆盖，这里再叠一层 ctx 是为了让
	// 「客户端取消」与「本次超时」共用同一条取消链，request 能被立刻中断。
	reqCtx := ctx
	if o.Timeout > 0 {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(ctx, o.Timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	// 显式 Close：连同 DisableKeepAlives 一起确保这条连接随响应结束销毁。
	req.Close = true

	resp, err := o.client.Do(req)
	if err != nil {
		return Response{}, err
	}
	defer resp.Body.Close()
	defer o.client.CloseIdleConnections()

	var reader io.Reader = resp.Body
	if o.MaxResponseBytes > 0 {
		// 多读一个字节，用来区分「正好读完」与「还没读完就到上限」——
		// io.LimitReader 读满上限时给的是干净 EOF，调用方拿到的是一段被静默截断的
		// JSON，下游解析会以误导性的语法错误失败，而真因是响应超限。
		// （PiMoa review 2026-09-19）
		reader = io.LimitReader(resp.Body, o.MaxResponseBytes+1)
	}
	raw, err := io.ReadAll(reader)
	if err != nil {
		return Response{Status: resp.StatusCode, Body: string(raw)}, err
	}
	if o.MaxResponseBytes > 0 && int64(len(raw)) > o.MaxResponseBytes {
		return Response{Status: resp.StatusCode, Body: string(raw[:o.MaxResponseBytes])},
			fmt.Errorf("%w：上限 %d 字节（静默返回半截 JSON 更危险，所以这里报错）",
				ErrResponseTooLarge, o.MaxResponseBytes)
	}
	return Response{Status: resp.StatusCode, Body: string(raw)}, nil
}

// wait 退避 backoff(attempt)，期间若 ctx 取消则立刻返回取消错误。
func (o *Outbound) wait(ctx context.Context, attempt int) error {
	d := time.Duration(1<<attempt) * time.Second
	if o.Backoff != nil {
		d = o.Backoff(attempt)
	}
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// IsCanceled 报告 err 是否为「调用方取消 / 超时」这一类，供服务写文案时分流。
func IsCanceled(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
