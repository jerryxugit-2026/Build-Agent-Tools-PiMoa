package mcpshell

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// ───────────── per-call 覆盖：同一个 Runner 并发用不同超时/cwd/env ─────────────

func TestRunWithPerCallTimeoutOverride(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 10 * time.Second

	// 本次覆盖成 300ms：实例级的 10s 不该生效。
	start := time.Now()
	res, err := r.RunWith(context.Background(), RunOptions{Timeout: 300 * time.Millisecond}, "-c", "sleep 30")
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	if !res.TimedOut {
		t.Errorf("per-call 超时没生效：%+v", res)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("耗时 %s：用的还是实例级 10s", elapsed)
	}

	// 不传 Timeout 时回落实例级（这里用一条秒退的命令证明实例级没被改坏）。
	if res2, err := r.RunWith(context.Background(), RunOptions{}, "-c", "echo ok"); err != nil ||
		strings.TrimSpace(res2.Stdout) != "ok" || res2.TimedOut {
		t.Errorf("回落实例级配置出错：%+v %v", res2, err)
	}
	if r.Timeout != 10*time.Second {
		t.Errorf("per-call 覆盖污染了实例字段：Runner.Timeout=%s", r.Timeout)
	}
}

// 关键并发不变量：两次调用各带自己的超时，互不干扰（这是不把 timeout 写回 Runner 字段的理由）。
func TestRunWithConcurrentDifferentTimeoutsDoNotInterfere(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 0
	var wg sync.WaitGroup
	results := make([]Result, 2)
	specs := []struct {
		timeout time.Duration
		script  string
	}{
		{200 * time.Millisecond, "sleep 30"}, // 该超时
		{5 * time.Second, "echo fine"},       // 该正常
	}
	for i, sp := range specs {
		wg.Add(1)
		go func(i int, timeout time.Duration, script string) {
			defer wg.Done()
			res, err := r.RunWith(context.Background(), RunOptions{Timeout: timeout}, "-c", script)
			if err != nil {
				t.Errorf("第 %d 路: %v", i, err)
			}
			results[i] = res
		}(i, sp.timeout, sp.script)
	}
	wg.Wait()
	if !results[0].TimedOut {
		t.Errorf("短超时那路没超时：%+v", results[0])
	}
	if results[1].TimedOut || strings.TrimSpace(results[1].Stdout) != "fine" {
		t.Errorf("长超时那路被短超时误伤：%+v", results[1])
	}
}

func TestRunWithPerCallDirAndExtraEnv(t *testing.T) {
	base := t.TempDir()
	over := t.TempDir()
	r := shRunner(t)
	r.Dir = base
	r.Env = []string{"MARK_BASE=b"}

	res, err := r.RunWith(context.Background(),
		RunOptions{Dir: over, ExtraEnv: []string{"MARK_CALL=c", "MARK_BASE=overridden"}},
		"-c", `pwd; printf %s "$MARK_CALL"; echo; printf %s "$MARK_BASE"; echo`)
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(res.Stdout), "\n")
	if !strings.HasSuffix(lines[0], strings.TrimPrefix(over, "/private")) {
		t.Errorf("per-call Dir 没生效：%q", lines[0])
	}
	if lines[1] != "c" {
		t.Errorf("ExtraEnv 没透传：%q", lines[1])
	}
	// 同名后者生效：ExtraEnv 应能覆盖 Runner.Env。
	if lines[2] != "overridden" {
		t.Errorf("ExtraEnv 没覆盖 Runner.Env：%q", lines[2])
	}
	if r.Dir != base {
		t.Errorf("per-call Dir 污染了实例字段：%q", r.Dir)
	}
}

// ───────────── stdout 行回调（NDJSON 流式解析） ─────────────

func TestRunWithOnStdoutLineDeliversEveryLine(t *testing.T) {
	var mu sync.Mutex
	var got []string
	r := shRunner(t)
	res, err := r.RunWith(context.Background(), RunOptions{
		OnStdoutLine: func(line string) {
			mu.Lock()
			got = append(got, line)
			mu.Unlock()
		},
	}, "-c", `printf 'a\nb\nc\n'`)
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(got, "|") != "a|b|c" {
		t.Errorf("行回调收到 %v，want [a b c]", got)
	}
	// 设了回调，正文照常进 Result（两者不互斥）。
	if res.Stdout != "a\nb\nc\n" {
		t.Errorf("Stdout=%q", res.Stdout)
	}
}

// 末行没有换行结尾时也要交出来——claude 的 result 消息往往正是最后一行。
func TestRunWithOnStdoutLineFlushesUnterminatedTail(t *testing.T) {
	var mu sync.Mutex
	var got []string
	r := shRunner(t)
	if _, err := r.RunWith(context.Background(), RunOptions{
		OnStdoutLine: func(line string) {
			mu.Lock()
			got = append(got, line)
			mu.Unlock()
		},
	}, "-c", `printf 'first\nlast-no-newline'`); err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[1] != "last-no-newline" {
		t.Errorf("末行没被 flush：%v", got)
	}
}

// 行回调不受捕获上限影响：捕获停了，回调还得继续（否则长任务中途就再也拿不到 session_id）。
func TestRunWithOnStdoutLineKeepsFiringAfterCaptureCap(t *testing.T) {
	var mu sync.Mutex
	count := 0
	last := ""
	r := shRunner(t)
	r.MaxCaptureBytes = 32 // 远小于总输出
	res, err := r.RunWith(context.Background(), RunOptions{
		OnStdoutLine: func(line string) {
			mu.Lock()
			count++
			last = line
			mu.Unlock()
		},
	}, "-c", `for i in $(seq 1 200); do echo "line-$i"; done`)
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	if !res.StdoutTruncated {
		t.Fatal("捕获上限没生效，测试前提不成立")
	}
	mu.Lock()
	defer mu.Unlock()
	if count != 200 {
		t.Errorf("只收到 %d 行回调，want 200（捕获截断不该掐断回调）", count)
	}
	if last != "line-200" {
		t.Errorf("最后一行是 %q，want line-200", last)
	}
}

// 回调 panic 不该把整次调用带崩（一条畸形消息不能毁掉全部产出）。
func TestRunWithOnStdoutLinePanicIsContained(t *testing.T) {
	r := shRunner(t)
	res, err := r.RunWith(context.Background(), RunOptions{
		OnStdoutLine: func(line string) {
			if line == "boom" {
				panic("畸形消息")
			}
		},
	}, "-c", `printf 'ok1\nboom\nok2\n'`)
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "ok2") {
		t.Errorf("回调 panic 影响了调用结果：%+v", res)
	}
}

// ───────────── TerminateGrace：先 SIGTERM 再 SIGKILL ─────────────

// grace>0 时子进程应能收到 SIGTERM 并自己做收尾（写一个文件证明它跑了 trap）。
func TestTerminateGraceSendsSIGTERMFirst(t *testing.T) {
	mark := filepath.Join(t.TempDir(), "term.mark")
	r := shRunner(t)
	r.TerminateGrace = 2 * time.Second
	r.Timeout = 400 * time.Millisecond

	res, err := r.Run(context.Background(), "-c",
		`trap 'echo terminated > `+mark+`; exit 0' TERM; sleep 30`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("没超时，测试前提不成立：%+v", res)
	}
	raw, rerr := os.ReadFile(mark)
	if rerr != nil {
		t.Fatalf("子进程没收到 SIGTERM（trap 没跑，标记文件不存在）：%v", rerr)
	}
	if strings.TrimSpace(string(raw)) != "terminated" {
		t.Errorf("标记文件内容不对：%q", raw)
	}
}

// grace=0（devkb 的默认档）必须**保持直接 SIGKILL**：SIGKILL 不可捕获，trap 不会跑。
// 这条测试就是防止有人为了「统一」把默认值改掉，从而悄悄拖慢 devkb 的取消。
func TestZeroGraceStillHardKillsWithoutSIGTERMHandling(t *testing.T) {
	mark := filepath.Join(t.TempDir(), "term.mark")
	r := shRunner(t)
	if r.TerminateGrace != 0 {
		t.Fatal("默认 TerminateGrace 应为 0（devkb 行为）")
	}
	r.Timeout = 400 * time.Millisecond

	res, err := r.Run(context.Background(), "-c",
		`trap 'echo terminated > `+mark+`' TERM; sleep 30`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("没超时：%+v", res)
	}
	if _, err := os.Stat(mark); err == nil {
		t.Error("grace=0 却发了 SIGTERM：devkb 档的行为被改了")
	}
}

// 宽限期内不肯走的进程最终必须被 SIGKILL（不能无限等）。
func TestTerminateGraceEscalatesToKill(t *testing.T) {
	r := shRunner(t)
	r.TerminateGrace = 300 * time.Millisecond
	r.Timeout = 300 * time.Millisecond

	start := time.Now()
	res, err := r.Run(context.Background(), "-c", `trap '' TERM; sleep 30`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut {
		t.Errorf("没标超时：%+v", res)
	}
	// 300ms 超时 + 300ms 宽限 + WaitDelay 余量；总不该拖到 30s。
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Errorf("忽略 SIGTERM 的进程没被升级 SIGKILL，耗时 %s", elapsed)
	}
}

// 宽限终止同样要带走整棵子树（孙进程不能变孤儿）。
func TestTerminateGraceKillsWholeGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "gc.pid")
	r := shRunner(t)
	r.TerminateGrace = 300 * time.Millisecond
	r.Timeout = 500 * time.Millisecond

	if _, err := r.Run(context.Background(), "-c",
		`sleep 30 & echo $! > `+pidFile+`; wait`); err != nil {
		t.Fatalf("Run: %v", err)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("没拿到孙进程 pid：%v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		t.Fatalf("孙进程 pid 不可用：%q", raw)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if syscall.Kill(pid, 0) != nil {
			return // 已死
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("孙进程 %d 还活着：宽限终止只杀了直接子进程", pid)
}

// ───────────── Start/Wait：后台路径 ─────────────

func TestStartReturnsBeforeChildFinishes(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 5 * time.Second
	start := time.Now()
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "sleep 1; echo done")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Errorf("Start 阻塞了 %s：后台路径不能等子进程", elapsed)
	}
	if p.PID <= 0 {
		t.Errorf("PID=%d：job 记录需要它", p.PID)
	}
	res := p.Wait()
	if strings.TrimSpace(res.Stdout) != "done" || res.ExitCode != 0 {
		t.Errorf("Wait 结果不对：%+v", res)
	}
	// 可重复 Wait，返回同一个结果。
	if p.Wait().Stdout != res.Stdout {
		t.Error("重复 Wait 结果不一致")
	}
}

// Gate 槽位必须在 Wait 里归还——后台 job 忘了归还会让熔断永久占满。
func TestStartWaitReleasesGateSlot(t *testing.T) {
	r := shRunner(t)
	r.Gate = NewGate(1)
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "true")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if r.Gate.InFlight() != 1 {
		t.Errorf("Start 没占槽位：InFlight=%d", r.Gate.InFlight())
	}
	if _, err := r.Run(context.Background(), "-c", "true"); !errors.Is(err, ErrBusy) {
		t.Errorf("槽位被占时应报 ErrBusy，得到 %v", err)
	}
	p.Wait()
	if r.Gate.InFlight() != 0 {
		t.Errorf("Wait 没归还槽位：InFlight=%d", r.Gate.InFlight())
	}
	if _, err := r.Run(context.Background(), "-c", "true"); err != nil {
		t.Errorf("归还后仍抢不到槽位：%v", err)
	}
}

func TestStartOnMissingBinaryReleasesSlotAndReportsError(t *testing.T) {
	r := shRunner(t)
	r.Gate = NewGate(1)
	r.Path = filepath.Join(t.TempDir(), "nope")
	if _, err := r.Start(context.Background(), RunOptions{}, "x"); err == nil {
		t.Fatal("起不来该报 error")
	}
	if r.Gate.InFlight() != 0 {
		t.Errorf("起不来时槽位泄漏了：InFlight=%d", r.Gate.InFlight())
	}
	// RunWith 则把它翻成 Result.StartErr（保持 Run 的老约定）。
	res, err := r.RunWith(context.Background(), RunOptions{}, "x")
	if err != nil {
		t.Fatalf("RunWith 不该返回 error：%v", err)
	}
	if res.StartErr == nil {
		t.Error("StartErr 被吞了")
	}
}

// 后台 job 的 ctx 不是 MCP 请求的 ctx，所以请求 ctx 取消时它不该被杀。
func TestStartWithBackgroundContextSurvivesRequestCancel(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 5 * time.Second
	reqCtx, cancelReq := context.WithCancel(context.Background())
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "sleep 1; echo survived")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	cancelReq() // 模拟 MCP 调用返回、请求 ctx 被取消
	_ = reqCtx
	res := p.Wait()
	if strings.TrimSpace(res.Stdout) != "survived" {
		t.Errorf("后台 job 被请求取消带走了：%+v", res)
	}
	if res.Canceled {
		t.Error("误标成被取消")
	}
}

func TestPendingKillStopsChild(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 30 * time.Second
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "sleep 30")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	start := time.Now()
	p.Kill()
	res := p.Wait()
	if elapsed := time.Since(start); elapsed > 6*time.Second {
		t.Errorf("Kill 没生效，Wait 花了 %s", elapsed)
	}
	if res.ExitCode == 0 {
		t.Errorf("被杀的进程退出码不该是 0：%+v", res)
	}
}
