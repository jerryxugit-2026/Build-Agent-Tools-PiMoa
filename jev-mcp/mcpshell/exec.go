package mcpshell

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// ───────────────────────── 在飞熔断 ─────────────────────────

// ErrBusy 是唯一由 Runner.Run 返回的 error：在飞数已达上限，本次直接拒绝。
// 拒绝而不排队是有意的（与 Node 版一致）：排队会让客户端侧的超时先到，
// 结果是「既占了槽位又没人要答案」。
var ErrBusy = errors.New("在飞查询已达上限")

// Gate 是**进程级全局**的在飞熔断，不是每会话一个。
// 别误读成「仅 http 受限」（Node 版 MoA 评审专门修正过这句注释）：
// 同一个 Gate 实例被所有工具、所有会话共享，stdio 与 http 两种模式在单进程内
// 都是这一个上限，不随会话数放大。每次工具调用都要 spawn 一个子进程（各自吃
// CPU/内存/下游服务资源），几十个客户端线程共享单实例时这是唯一的保险丝。
type Gate struct {
	slots chan struct{}
	max   int
}

// NewGate 建一个上限为 max 的熔断器；max<=0 视作不限流。
func NewGate(max int) *Gate {
	if max <= 0 {
		return &Gate{max: 0}
	}
	return &Gate{slots: make(chan struct{}, max), max: max}
}

// TryAcquire 抢一个槽位，抢不到立刻返回 false（不阻塞、不排队）。
func (g *Gate) TryAcquire() bool {
	if g == nil || g.slots == nil {
		return true
	}
	select {
	case g.slots <- struct{}{}:
		return true
	default:
		return false
	}
}

// Release 归还槽位。必须与 TryAcquire 成功配对（用 defer）。
func (g *Gate) Release() {
	if g == nil || g.slots == nil {
		return
	}
	select {
	case <-g.slots:
	default:
	}
}

// Max 返回上限，供错误文案引用。
func (g *Gate) Max() int {
	if g == nil {
		return 0
	}
	return g.max
}

// InFlight 返回当前在飞数（可观测用，不参与判定）。
func (g *Gate) InFlight() int {
	if g == nil || g.slots == nil {
		return 0
	}
	return len(g.slots)
}

// ───────────────────────── 输出截断 ─────────────────────────

// Clip 把交给 agent 的正文按**字符数**截断（超长时附中文提示）。
//
// 按 rune 而不是 byte 截断有两个理由：①byte 切法会把一个中文字切成半截字节，
// 客户端渲染成乱码；②devkb/jev 的输出是中文为主，按 byte 算等于把上限悄悄缩到
// 三分之一。Node 版用的是 String.length（UTF-16 码元），对 BMP 文本与 rune 数一致。
func Clip(text string, maxChars int) string {
	if maxChars <= 0 {
		return text
	}
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text
	}
	return string(runes[:maxChars]) + fmt.Sprintf("\n[输出超长，已按 %d 字符截断]", maxChars)
}

// ───────────────────────── spawn 外部程序 ─────────────────────────

// Runner 封装「跑一个短命外部程序、把两路输出交回来」这件事：cwd、env、超时、
// 客户端取消传导到子进程 kill、每路输出捕获上限、在飞熔断，全在这里。
// 四个薄壳的业务差异只剩「拼什么 argv」和「怎么解释退出码」两件事。
type Runner struct {
	// Path 是被调用的可执行文件绝对路径。
	Path string
	// Dir 是子进程工作目录（空=继承本进程）。
	Dir string
	// Env 是**追加**在当前环境之后的 KEY=VALUE（同名后者生效）。
	// 不用整份替换是有意的：子进程通常需要 PATH/HOME 一类基础环境。
	Env []string
	// Timeout 是单次调用的硬兜底；<=0 表示不设超时（不建议）。
	Timeout time.Duration
	// MaxCaptureBytes 是**每一路**输出的捕获上限（对应 Node execFile 的 maxBuffer）。
	// 超出即停止追加并标记 truncated——注意这里与 Node 有意不同：Node 超 maxBuffer
	// 会直接把整次调用判成错误并丢掉已有输出，Go 侧选择「留住前面的、如实说被截断」。
	MaxCaptureBytes int
	// Gate 是进程级在飞熔断；nil 表示不限流。
	Gate *Gate
	// TerminateGrace >0 时，取消/超时走 **SIGTERM → 等这么久 → SIGKILL**（都发给整组）；
	// =0（默认）时直接 SIGKILL 整组。
	//
	// 为什么默认是直接 SIGKILL、而不是「先礼后兵」：devkb 是只读查询，没有任何需要
	// 清理的在途状态，给它一个宽限窗口只会把「取消」这件事平白拖慢。反过来
	// claude-dispatch / antigravity 调的 CLI 有自己的会话/日志要落盘（Python 版就是
	// terminate→等 2s→kill），那两个服务显式设 TerminateGrace=2s。
	// ⚠️ 改这个默认值等于改 devkb 的行为，别为了「统一」把它一起改掉。
	TerminateGrace time.Duration
	// Log 只用来喊**异常**（目前仅进程组收尾时的非 ESRCH 错误）；nil = 静默。
	// 不做成常规日志通道：正常路径每次调用都打日志，对一个每秒可能被调多次的壳
	// 只是噪声，真正的可观测性在各服务自己的 stats 里。
	Log *log.Logger
}

// RunOptions 是**单次调用**的覆盖项。
//
// 为什么需要它：devkb 的超时是服务级常量（查询都是秒级），而 claude-dispatch 与
// antigravity 的 timeout 是**工具入参**——同一个进程里，一次调用 300s、下一次 1200s。
// 把它塞回 Runner 字段会引入共享可变状态：http 模式下同一个 Runner 被并发调用，
// 谁最后写谁生效，两次调用互相改超时，这是教科书式的数据竞争。
type RunOptions struct {
	// Timeout >0 时覆盖 Runner.Timeout（<0 表示本次不设超时）。
	Timeout time.Duration
	// Dir 非空时覆盖 Runner.Dir。
	Dir string
	// ExtraEnv 在 Runner.Env 之后再追加（同名后者生效）。
	ExtraEnv []string
	// OnStdoutLine 非 nil 时，stdout 每收到一整行就回调一次（用于 NDJSON 流式解析）。
	// 回调在读取 goroutine 里同步执行，必须**快且不 panic**；行内容不含结尾换行。
	// 注意：设了它，stdout 仍然照常进 Result.Stdout（受 MaxCaptureBytes 约束）。
	OnStdoutLine func(line string)
}

func (r *Runner) timeoutFor(opt RunOptions) time.Duration {
	if opt.Timeout != 0 {
		return opt.Timeout
	}
	return r.Timeout
}

func (r *Runner) dirFor(opt RunOptions) string {
	if opt.Dir != "" {
		return opt.Dir
	}
	return r.Dir
}

func (r *Runner) envFor(opt RunOptions) []string {
	if len(r.Env) == 0 && len(opt.ExtraEnv) == 0 {
		return nil
	}
	out := make([]string, 0, len(r.Env)+len(opt.ExtraEnv))
	out = append(out, r.Env...)
	return append(out, opt.ExtraEnv...)
}

// Result 是一次外部调用的全部事实。判定策略（哪些退出码算错、错文案怎么写）
// 留给各服务自己——骨架只管机械事实，不替业务解释退出码。
type Result struct {
	Args            []string
	Stdout          string
	Stderr          string
	ExitCode        int   // 被信号杀死时为 -1
	StartErr        error // 起不来（ENOENT/权限等）；非 nil 时其余字段无意义
	TimedOut        bool  // 撞 Runner.Timeout
	Canceled        bool  // 调用方 context 被取消（MCP 客户端取消请求）
	StdoutTruncated bool
	StderrTruncated bool
	Duration        time.Duration
}

// Failed 报告「这次调用没能正常跑完」——起不来、超时、被取消、或退出码非 0。
// 退出码非 0 里哪些其实是可用结果（例如 devkb 的 2=DEGRADED），由各服务自己判。
func (r Result) Failed() bool {
	return r.StartErr != nil || r.TimedOut || r.Canceled || r.ExitCode != 0
}

// KilledReason 给「超时/取消被杀」这类情况一句现成文案，没有则返回空串。
func (r Result) KilledReason() string {
	switch {
	case r.TimedOut:
		return "超时被杀"
	case r.Canceled:
		return "客户端取消被杀"
	default:
		return ""
	}
}

// Run 跑一次外部程序（用 Runner 的实例级配置）。返回的 error 只可能是 ErrBusy
// （在飞熔断），其余一切情况都在 Result 里如实带回——包括起不来、超时、被取消。
func (r *Runner) Run(ctx context.Context, args ...string) (Result, error) {
	return r.RunWith(ctx, RunOptions{}, args...)
}

// RunWith 同 Run，但可对本次调用覆盖超时/cwd/env，并挂 stdout 行回调。
func (r *Runner) RunWith(ctx context.Context, opt RunOptions, args ...string) (Result, error) {
	p, err := r.Start(ctx, opt, args...)
	if err != nil {
		// 起不来进 Result（保持 Run 的老约定：只有 ErrBusy 以 error 形式冒出来）。
		if res, ok := r.resultFromStartError(err, args); ok {
			return res, nil
		}
		return Result{Args: args}, err
	}
	return p.Wait(), nil
}

// Pending 是一个**已经起来、还没收割**的子进程。
//
// 为什么骨架要暴露它：antigravity 的后台 job 路径必须「立刻返回 job_id、不 await
// 子进程」——MCP 调用几秒就结束，子进程继续跑到 1200s。同步的 Run 做不到这件事，
// 而让各服务自己 exec.Command 又会把进程组、宽限终止、捕获上限这些纪律复制四遍。
type Pending struct {
	// PID 是子进程 pid（Python 版会把它报进 job 记录）。
	PID int
	// pgid 是进程组号，在 Start 成功的那一刻定死（恒等于 PID，见那里的说明）。
	// 存快照而不是用时反查，是为了杜绝「pid 被复用后反查到无关进程组并把它杀掉」。
	pgid int

	runner *Runner
	cmd    *exec.Cmd
	stdout *cappedBuffer
	stderr *cappedBuffer
	args   []string
	start  time.Time
	// callerCtx 是调用方给的 ctx，runCtx 是叠了超时的派生 ctx。
	// 两个都要留：区分「客户端取消」与「本次超时」只能分两次问（见 classifyCtx）。
	callerCtx context.Context
	runCtx    context.Context
	cancel    context.CancelFunc
	// release 归还 Gate 槽位；supervise 收尾时调一次。
	release func()
	// done 在 supervise 填好 result 之后关闭；Wait 只是等它。
	done   chan struct{}
	result Result
}

// Start 起一个子进程就返回，不等它结束。调用方**必须**最终调 Wait（否则 Gate 槽位
// 和进程都不会被回收）；后台路径的做法是另起一个 goroutine 调 Wait。
//
// ⚠️ 后台场景下传进来的 ctx 不能是 MCP 请求的 ctx：请求一返回它就被取消，子进程
// 会立刻被杀。用 context.Background()（或带自己超时的派生 ctx）。
func (r *Runner) Start(ctx context.Context, opt RunOptions, args ...string) (*Pending, error) {
	if !r.Gate.TryAcquire() {
		return nil, fmt.Errorf("%w %d", ErrBusy, r.Gate.Max())
	}
	released := false
	release := func() {
		if !released {
			released = true
			r.Gate.Release()
		}
	}

	runCtx := ctx
	var cancel context.CancelFunc
	if t := r.timeoutFor(opt); t > 0 {
		runCtx, cancel = context.WithTimeout(ctx, t)
	}

	p := &Pending{
		runner:    r,
		stdout:    &cappedBuffer{max: r.MaxCaptureBytes, onLine: opt.OnStdoutLine},
		stderr:    &cappedBuffer{max: r.MaxCaptureBytes},
		args:      args,
		callerCtx: ctx,
		runCtx:    runCtx,
		cancel:    cancel,
		release:   release,
		done:      make(chan struct{}),
	}

	// ⚠️ 用 exec.Command 而不是 exec.CommandContext，是这一版的关键设计选择。
	//
	// CommandContext 会自带一个看门狗 goroutine：runCtx 一 Done 就调 cmd.Cancel，
	// 并在 cmd.Wait 里把错误改写成 ctx.Err()。那样一来「谁终止了这个进程」有两个
	// 主体（看门狗 + 我们），而我们只能从 Wait 的返回值**事后猜**是哪种情形：
	//   · 进程自己跑完、客户端随后取消  → waitErr = ctx.Err()
	//   · 进程被我们 SIGTERM、它 trap 后 exit 0 → waitErr 同样 = ctx.Err()
	// 两者的 waitErr、ExitCode、Signaled() 完全一致，事后无从分辨。猜错任一边都糟：
	// 前者会把成功报成「被取消」，后者会把被掐断的调用报成干净成功（假绿）。
	//
	// 所以改为：唯一的终止者是我们自己（见 supervise），并且**在进程退出的那一刻就
	// 记下它是自己退的**。顺序信息只有在事件发生时才拿得到，事后任何字段都没有它。
	// WaitDelay 仍然有效——它对「进程已退但管道被孙进程占着」的兜底不依赖 Context
	// （见 os/exec 的 awaitGoroutines：无 Context 时自己起 timer）。
	cmd := exec.Command(r.Path, args...)
	cmd.Dir = r.dirFor(opt)
	if env := r.envFor(opt); len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	cmd.Stdout = p.stdout
	cmd.Stderr = p.stderr
	// stdin 接 /dev/null：交互式 CLI（claude/agy）如果 stdin 是继承来的终端或管道，
	// 可能等输入等到超时。Python 版显式 DEVNULL，这里同款。
	cmd.Stdin = nil
	// 自成进程组：这样取消/超时时能 kill(-pgid) 一次带走**整棵子树**。
	// Node 的 child.kill() 只杀直接子进程，孙进程会变孤儿继续吃资源——
	// claude-dispatch / antigravity 那两个服务调的 CLI 本身就会再 fork，所以
	// 这条对复用方比对 devkb 更要紧。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// 即使进程已死，Wait 还要等两路管道关闭；孙进程继承了管道时会把 Wait 吊住。
	// WaitDelay 给它一个硬底：到点就放弃读剩余输出、让 Wait 返回。
	// 宽限终止时要把宽限窗口算进去，否则 WaitDelay 先到、SIGTERM 还没等够就被放弃。
	cmd.WaitDelay = 3*time.Second + r.TerminateGrace
	p.cmd = cmd

	p.start = time.Now()
	if err := cmd.Start(); err != nil {
		if cancel != nil {
			cancel()
		}
		release()
		// Start 失败也要带上取消/超时判定：ctx 已取消或已过期时 cmd.Start 会直接
		// 返回 context.Canceled / DeadlineExceeded，若这里只报 StartErr，调用方会把
		// 「客户端取消」误读成「程序起不来」（KilledReason() 会是空串）。
		return nil, &startError{
			err:      err,
			args:     args,
			dur:      time.Since(p.start),
			ctxState: classifyCtx(ctx, runCtx),
		}
	}
	if cmd.Process != nil {
		p.PID = cmd.Process.Pid
		// pgid 在**进程还活着的此刻**定死，之后一律用这份快照，绝不事后反查。
		// 为什么（PiMoa review 2026-09-19 抓出的 MAJOR）：原来 terminateGroup 与
		// sweepGroup 都在用时才 syscall.Getpgid(cmd.Process.Pid)。进程一旦被 Wait
		// 收割，它的 pid 就可能被系统复用给**别的进程**——此时 Getpgid 会成功返回那个
		// 无关进程的组号，紧接着的 kill(-pgid, SIGKILL) 就灭掉一整组无关进程。而且走
		// 裸 syscall.Kill 还绕过了 os.Process 在 Wait 之后返回 ErrProcessDone 的保护。
		// 取值不用查：SysProcAttr{Setpgid:true} 且 Pgid 留 0，等于子进程自己 setpgid(0,0)，
		// 新组的组号按定义就等于它自己的 pid，所以 pgid == PID 是构造上的恒等式。
		p.pgid = cmd.Process.Pid
	}
	// 监督 goroutine 在 Start 时就起，**不是**等到 Wait 才起。这一点是正确性所需：
	// 只有当 cmd.Wait 从进程退出那一刻就在等着，我们才知道「进程是自己退的」还是
	// 「ctx 先到、我们动手把它终止的」。若等到 Wait 被调用才开始观察，一个早已退出
	// 的进程与一个刚被取消的进程在那一刻看起来一模一样（两个 channel 都 ready，
	// select 随机挑一个），必然误判。
	go p.supervise()
	return p, nil
}

// supervise 是这个子进程唯一的终止者与收割者。
func (p *Pending) supervise() {
	waitCh := make(chan error, 1)
	go func() { waitCh <- p.cmd.Wait() }()

	var waitErr error
	terminated := ctxOK
	select {
	case waitErr = <-waitCh:
		// 进程在我们动手之前就结束了 → 无论此刻 ctx 是什么状态，都不算被掐断。
		// 这正是「成功的调用不能被误标成取消」那条不变量的落点。
	case <-p.runCtx.Done():
		// ⚠️ 两个 case 同一刻就绪时 Go 的 select 是**随机**选边的，所以走到这里
		// 并不等于「ctx 确实先到」——可能进程其实已经干净跑完了。不先探一下就
		// 直接记成取消，会把一次成功的调用标成 Canceled/TimedOut，finish 还会把
		// ExitCode 由 0 强改成 -1（对 antigravity 是会落进 job 记录的错误事实）。
		// 所以先做一次非阻塞探测，让「进程已退」这一侧恒定优先。
		// （PiMoa review 2026-09-19；上面那条不变量原来只在严格先后时才成立。）
		// ⚠️ 这道非阻塞探测无法用测试锁住：双就绪窗口是纳秒级的，挂钟采样落不进去
		// （2026-09-19 实测，1.2ms 步长扫 72ms、每轮 30+ 个干净退出样本，撤回本修复
		// 后仍然全绿）。所以它靠的是「把不变量写成无条件成立」而不是靠测试保护——
		// 改这里的人请照着这段推理判断，不要指望 CI 会拦住你。
		select {
		case waitErr = <-waitCh:
			break
		default:
			// ctx 确实先到 → 由我们终止它，并如实记下是取消还是超时。
			terminated = classifyCtx(p.callerCtx, p.runCtx)
			_ = terminateGroup(p.cmd.Process, p.pgid, p.runner.TerminateGrace)
			waitErr = <-waitCh
		}
	}
	p.finish(waitErr, terminated)
}

func (p *Pending) finish(waitErr error, terminated ctxState) {
	// 最后一段没有换行结尾的输出也要交给行回调，否则末条消息（往往正是 result）丢掉。
	p.stdout.flushLine()
	// 正常退出路径也要扫一次进程组。终止路径由 terminateGroup 负责，但进程**自己**
	// 正常退出时没人动过组：被调的 CLI 自己 fork 后先退出时（claude/agy 正是这一类），
	// 孙进程会变孤儿继续吃资源、跨多次调用累积。此刻直接子进程已被 reap，往组里发一次
	// SIGKILL 只会命中残留的孙进程；组里没人则 ESRCH，忽略即可。
	p.sweepGroup()
	if p.cancel != nil {
		p.cancel()
	}
	p.release()

	res := Result{Args: p.args, Duration: time.Since(p.start)}
	res.Stdout, res.StdoutTruncated = p.stdout.String(), p.stdout.Truncated()
	res.Stderr, res.StderrTruncated = p.stderr.String(), p.stderr.Truncated()
	res.ExitCode = -1
	if st := p.cmd.ProcessState; st != nil {
		res.ExitCode = st.ExitCode()
	}
	switch terminated {
	case ctxCanceled:
		res.Canceled = true
	case ctxTimedOut:
		res.TimedOut = true
	}
	// 被我们掐断的调用不许谎报成功退出码——子进程可以自己 trap SIGTERM 然后 exit 0
	// （claude/agy 这类要落盘会话的 CLI 正是这么写的），那时 ExitCode=0 且 Signaled()
	// 为 false，只看退出状态会把一次被截断的执行报成干净成功，即本仓最忌的假绿。
	if terminated != ctxOK && res.ExitCode == 0 {
		res.ExitCode = -1
	}
	if waitErr != nil && res.ExitCode == 0 {
		// 理论上只剩 ErrWaitDelay（进程已退但管道没关）这一类；别谎报成功。
		res.ExitCode = -1
	}
	p.result = res
	close(p.done)
}

// startError 让 Start 的「起不来」也能被 RunWith 翻回 Result（保持 Run 的老约定：
// 只有 ErrBusy 会以 error 形式冒出来，起不来进 Result.StartErr）。
type startError struct {
	err      error
	args     []string
	dur      time.Duration
	ctxState ctxState
}

func (e *startError) Error() string { return e.err.Error() }
func (e *startError) Unwrap() error { return e.err }

// ctxState 是「调用方取消 / 本次超时 / 都没有」三态。
type ctxState int

const (
	ctxOK ctxState = iota
	ctxCanceled
	ctxTimedOut
)

// classifyCtx 分辨「客户端取消」与「本次超时」。
//
// 顺序要紧：先看**调用方**的 ctx，再看派生的超时 ctx。反过来写会把「客户端取消」
// 误报成「超时」——父 ctx 取消时派生 ctx 也 Done，但它的 Err() 是 Canceled 而非
// DeadlineExceeded，所以只能分两次问。
func classifyCtx(callerCtx, runCtx context.Context) ctxState {
	switch {
	case callerCtx.Err() != nil:
		return ctxCanceled
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return ctxTimedOut
	default:
		return ctxOK
	}
}

// Wait 等子进程结束并收割结果。可重复调用（后续调用返回同一个 Result）。
// 真正的等待与判定在 supervise 里，这里只是等它填好。
func (p *Pending) Wait() Result {
	<-p.done
	return p.result
}

// sweepGroup 在子进程已被 reap 之后再往进程组补一刀，收残留的孙进程。
func (p *Pending) sweepGroup() {
	if p.PID <= 0 {
		return
	}
	pgid := p.pgid
	if pgid <= 1 {
		return // 见 terminateGroup 里的同款兜底说明
	}
	// 此刻直接子进程刚被 Wait 收割，打到组里的只可能是残留的孙进程。
	// ESRCH（组里已没人）是最常见的返回，属正常；EPERM/EINVAL 则意味着我们打到了
	// 不该打的地方或参数错了，那是真异常——两者不能一起吞掉（PiMoa review 2026-09-19）。
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		if p.runner != nil && p.runner.Log != nil {
			p.runner.Log.Printf("⚠ 收尾清理进程组 %d 失败：%v（非 ESRCH，可能打到了意外的目标）", pgid, err)
		}
	}
}

// Kill 立刻按 Runner.TerminateGrace 的策略终止整个进程组（不等 Wait）。
// 对已经收尾的 Pending 调用它是安全的空操作。
func (p *Pending) Kill() {
	if p == nil || p.cmd == nil {
		return
	}
	// 已收尾就什么都不做（PiMoa review 2026-09-19 抓出的 MAJOR 的另一半）：
	// 迟到的取消是完全正常的调用序列——后台 job 跑完了几分钟后服务才来收尾、
	// 或者客户端的取消请求晚到。此时进程早被 Wait 收割、pid 可能已被复用，
	// 再往那个号码发信号就是在赌别人的命。
	select {
	case <-p.done:
		return
	default:
	}
	_ = terminateGroup(p.cmd.Process, p.pgid, p.runner.TerminateGrace)
}

// RunWith 里把 startError 翻成 Result。
func (r *Runner) resultFromStartError(err error, args []string) (Result, bool) {
	var se *startError
	if errors.As(err, &se) {
		res := Result{Args: args, StartErr: se.err, Duration: se.dur, ExitCode: -1}
		res.Canceled = se.ctxState == ctxCanceled
		res.TimedOut = se.ctxState == ctxTimedOut
		return res, true
	}
	return Result{}, false
}

// terminateGroup 终止整个进程组。grace<=0 直接 SIGKILL；grace>0 先 SIGTERM、
// 等 grace 看进程是否自己走，没走再 SIGKILL（antigravity Python 版的 terminate→
// 等 2s→kill 同款语义，只是范围从「直接子进程」扩到「整组」）。
//
// pgid 必须是**调用方在进程还活着时拿到的快照**（见 Pending.pgid），这里绝不自己
// 反查：进程被 Wait 收割后 pid 可能已被复用，那时反查会拿到无关进程的组号。
//
// ⚠️ Unix-only：Setpgid / Kill(-pgid) 都是 POSIX 概念，GOOS=windows 编不过。
// 本骨架四个服务全部只在本机 macOS 常驻，不做跨平台抽象（要做就拆
// exec_unix.go + exec_windows.go，但那是为一个不存在的需求付复杂度）。
func terminateGroup(proc *os.Process, pgid int, grace time.Duration) error {
	if proc == nil {
		return nil
	}
	// pgid<=1 兜底。构造上不可达（pgid 恒等于子进程 pid），但这是全仓**唯一**
	// 「写错一个符号就杀掉自己整个进程组」的位置（pgid=0 时 kill(-0) = 杀调用者
	// 所在组），四个服务共用，所以宁可多一行也把它钉死。
	if pgid <= 1 {
		return proc.Kill()
	}
	killAll := func(sig syscall.Signal) error {
		return syscall.Kill(-pgid, sig)
	}
	if grace <= 0 {
		if err := killAll(syscall.SIGKILL); err != nil {
			return proc.Kill()
		}
		return nil
	}
	// 先礼：SIGTERM 给整组。
	if err := killAll(syscall.SIGTERM); err != nil {
		// 连 SIGTERM 都发不出去（进程已没了）：直接返回，Wait 会收尸。
		return err
	}
	// 后兵：轮询等它自己退，到点 SIGKILL。
	// ⚠️ 这里探的是**整个进程组**是否还有成员，不是「直接子进程走没走」。所以只要
	// 还有一个孙进程在跑，就会等满整个 grace。claude / agy 恰恰必定 fork，于是
	// 「乖乖退出的就不必白等」这条优化对真实使用方基本不生效，取消延迟就是 grace。
	// 如实写在这里，免得以后有人按注释去估取消的延迟。（PiMoa review 2026-09-19）
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		// signal 0 探活：ESRCH 表示组里已经没人了。
		if err := killAll(syscall.Signal(0)); err != nil {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := killAll(syscall.SIGKILL); err != nil {
		return proc.Kill()
	}
	return nil
}

// cappedBuffer 是带上限的 io.Writer：到顶后丢弃后续写入并记一笔，
// 绝不因为输出太大就让整次调用失败。
//
// onLine 非 nil 时同时做**按行切分**：claude CLI 的 stream-json 是 NDJSON，
// 一行一条消息，必须边跑边解析才能在中途失败时还留住 session_id 与已有产出。
// 行缓冲与捕获缓冲分开算：即使捕获已到上限、不再留正文，行回调仍要继续（否则
// 长任务跑到一半就再也拿不到 session_id 了）。
type cappedBuffer struct {
	mu        sync.Mutex
	buf       []byte
	max       int
	truncated bool

	onLine  func(string)
	lineBuf []byte
}

// maxLineBytes 是单行的硬上限。没有它，一个不带换行的巨型输出会让 lineBuf
// 无界增长——捕获缓冲有上限，行缓冲不能没有。
const maxLineBytes = 4 << 20

func (b *cappedBuffer) Write(p []byte) (int, error) {
	// 零长度写入不是「输出被截断」。io.Copy 本身不传空切片，但行回调路径会，
	// 落到下面的满缓冲分支就会把 truncated 置成假阳性。
	if len(p) == 0 {
		return 0, nil
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.onLine != nil {
		b.feedLines(p)
	}

	if b.max > 0 && len(b.buf) >= b.max {
		b.truncated = true
		return len(p), nil // 假装写下了：不能回报 short write，否则 io.Copy 报错
	}
	if b.max > 0 && len(b.buf)+len(p) > b.max {
		b.buf = append(b.buf, p[:b.max-len(b.buf)]...)
		b.truncated = true
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

// trimToRuneBoundary 返回 <=len(chunk) 的最大长度，使 chunk[:n] 不以**半截** UTF-8
// 序列结尾。
//
// 做法是从末尾往回找最近的 rune 起始字节（连续字节的高两位是 10，不是起始字节），
// 再看那个 rune 声称的长度是否装得下：装得下就整段保留，装不下就把它整个丢掉。
// chunk 本身可能以不完整序列**开头**（上一次写入切在中间），回看 utf8.UTFMax 个
// 字节仍找不到起始字节时原样返回——不制造新的破损，也不吃掉合法数据。
func trimToRuneBoundary(chunk []byte) int {
	n := len(chunk)
	if n == 0 {
		return 0
	}
	for i := 0; i < utf8.UTFMax && i < n; i++ {
		start := n - 1 - i
		if !utf8.RuneStart(chunk[start]) {
			continue
		}
		size := runeLenFromLead(chunk[start])
		switch {
		case size <= 0:
			return n // 非法前导字节：原样返回，不替它做决定
		case start+size <= n:
			return n // 末尾这个 rune 是完整的
		default:
			return start // 被切断了，丢掉它
		}
	}
	return n
}

// runeLenFromLead 由 UTF-8 前导字节推出整个序列的字节数；非前导/非法字节返回 0。
func runeLenFromLead(b byte) int {
	switch {
	case b < 0x80:
		return 1
	case b&0xE0 == 0xC0:
		return 2
	case b&0xF0 == 0xE0:
		return 3
	case b&0xF8 == 0xF0:
		return 4
	default:
		return 0
	}
}

// feedLines 在持锁状态下切行并回调。回调里若 panic 会打断读取 goroutine，
// 所以这里兜一层 recover：一条畸形消息不该让整次调用崩掉。
func (b *cappedBuffer) feedLines(p []byte) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			if len(b.lineBuf)+len(p) <= maxLineBytes {
				b.lineBuf = append(b.lineBuf, p...)
			} else if len(b.lineBuf) < maxLineBytes {
				b.lineBuf = append(b.lineBuf, p[:maxLineBytes-len(b.lineBuf)]...)
			}
			return
		}
		line := p[:i]
		if len(b.lineBuf) > 0 {
			b.lineBuf = append(b.lineBuf, line...)
			line = b.lineBuf
		}
		b.emit(string(bytes.TrimSuffix(line, []byte("\r"))))
		b.lineBuf = b.lineBuf[:0]
		p = p[i+1:]
	}
}

func (b *cappedBuffer) emit(line string) {
	defer func() { _ = recover() }()
	b.onLine(line)
}

// flushLine 把最后一段没有结尾换行的内容也交出去（进程结束时调）。
func (b *cappedBuffer) flushLine() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.onLine == nil || len(b.lineBuf) == 0 {
		return
	}
	b.emit(string(bytes.TrimSuffix(b.lineBuf, []byte("\r"))))
	b.lineBuf = b.lineBuf[:0]
}

func (b *cappedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.truncated {
		// 没截断就原样返回：子进程自己吐出的非法字节是它的事，我们不替它删。
		return string(b.buf)
	}
	// 截断点回退到 rune 边界：按字节硬切会把一个中文字切成半截，客户端渲染出 U+FFFD。
	// 这与 Clip 的 rune 语义、与「留住前面的、如实说被截断」的口径应当一致
	// （devkb/jev 的输出以中文为主，按字节切几乎必然踩到）。
	//
	// 在**读**的时候做而不是写的时候做，是因为破损可能来自「一次写入正好把缓冲填满、
	// 恰好停在多字节序列中间」——那一次写入本身没有溢出，写路径看不出问题，
	// 直到后续写入才把 truncated 置位。读路径是唯一能看到最终形态的地方。
	return string(b.buf[:trimToRuneBoundary(b.buf)])
}

func (b *cappedBuffer) Truncated() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
}
