package mcpshell

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func shRunner(t *testing.T) *Runner {
	t.Helper()
	return &Runner{
		Path:            "/bin/sh",
		Timeout:         10 * time.Second,
		MaxCaptureBytes: 4 << 20,
		Gate:            NewGate(8),
	}
}

func TestRunnerCapturesBothStreamsAndExitCode(t *testing.T) {
	r := shRunner(t)
	res, err := r.Run(context.Background(), "-c", "echo out; echo err 1>&2; exit 2")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.TrimSpace(res.Stdout); got != "out" {
		t.Errorf("stdout=%q, want %q", got, "out")
	}
	if got := strings.TrimSpace(res.Stderr); got != "err" {
		t.Errorf("stderr=%q, want %q", got, "err")
	}
	if res.ExitCode != 2 {
		t.Errorf("exit=%d, want 2", res.ExitCode)
	}
	if res.TimedOut || res.Canceled || res.StartErr != nil {
		t.Errorf("误报失败模式: %+v", res)
	}
}

func TestRunnerRespectsDirAndEnv(t *testing.T) {
	dir := t.TempDir()
	r := shRunner(t)
	r.Dir = dir
	r.Env = []string{"DEVKB_TEST_MARK=1234"}
	res, err := r.Run(context.Background(), "-c", "pwd; printf %s \"$DEVKB_TEST_MARK\"; echo; printf %s \"$PATH\" | head -c 1")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(res.Stdout), "\n")
	// macOS 的 t.TempDir() 在 /var/folders/... 而 pwd 会给 /private/var/...，只比后缀。
	if !strings.HasSuffix(lines[0], strings.TrimPrefix(dir, "/private")) {
		t.Errorf("cwd=%q, want 以 %q 结尾", lines[0], dir)
	}
	if lines[1] != "1234" {
		t.Errorf("env 透传失败: %q", lines[1])
	}
	// Env 是追加语义：基础环境（PATH）必须还在，否则子进程连自己的依赖都找不到。
	if len(lines) < 3 || lines[2] == "" {
		t.Errorf("PATH 被整份替换掉了: %q", res.Stdout)
	}
}

func TestRunnerStartErrorOnMissingBinary(t *testing.T) {
	r := shRunner(t)
	r.Path = filepath.Join(t.TempDir(), "definitely-not-here")
	res, err := r.Run(context.Background(), "x")
	if err != nil {
		t.Fatalf("Run 不该返回 error（起不来要进 Result）: %v", err)
	}
	if res.StartErr == nil {
		t.Fatal("StartErr 为 nil：起不来被吞了")
	}
}

func TestRunnerTimeoutMarksTimedOutNotCanceled(t *testing.T) {
	r := shRunner(t)
	r.Timeout = 300 * time.Millisecond
	start := time.Now()
	res, err := r.Run(context.Background(), "-c", "sleep 30")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut {
		t.Errorf("TimedOut=false, want true: %+v", res)
	}
	if res.Canceled {
		t.Error("把超时误报成客户端取消")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("超时没真杀掉子进程，耗时 %s", elapsed)
	}
}

func TestRunnerClientCancelMarksCanceledNotTimedOut(t *testing.T) {
	r := shRunner(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	defer cancel()
	res, err := r.Run(ctx, "-c", "sleep 30")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Canceled {
		t.Errorf("Canceled=false, want true: %+v", res)
	}
	if res.TimedOut {
		t.Error("把客户端取消误报成超时")
	}
}

// 关键回归：取消必须带走**整棵子树**。Node 的 child.kill() 只杀直接子进程，
// 孙进程会变孤儿继续吃资源；Go 版靠 Setpgid + kill(-pgid) 覆盖。
func TestRunnerCancelKillsGrandchild(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	r := shRunner(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan Result, 1)
	go func() {
		res, err := r.Run(ctx, "-c", "sleep 30 & echo $! > "+pidFile+"; wait")
		if err != nil {
			t.Errorf("Run: %v", err)
		}
		done <- res
	}()

	grandchild := 0
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if raw, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 {
				grandchild = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if grandchild == 0 {
		t.Fatal("没拿到孙进程 pid")
	}
	if err := syscall.Kill(grandchild, 0); err != nil {
		t.Fatalf("孙进程一开始就不在（%v），测试前提不成立", err)
	}

	cancel()
	<-done

	var lastErr error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		lastErr = syscall.Kill(grandchild, 0)
		if lastErr != nil {
			return // 孙进程已死：整组被带走
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("孙进程 %d 还活着（kill -0 = %v）：取消只杀了直接子进程", grandchild, lastErr)
}

func TestGateRefusesOverLimitAndRecovers(t *testing.T) {
	g := NewGate(2)
	if !g.TryAcquire() || !g.TryAcquire() {
		t.Fatal("前两个槽位应该抢得到")
	}
	if g.TryAcquire() {
		t.Fatal("第三个槽位应该被拒")
	}
	if g.InFlight() != 2 {
		t.Errorf("InFlight=%d, want 2", g.InFlight())
	}
	g.Release()
	if !g.TryAcquire() {
		t.Fatal("归还后应能再抢到")
	}
}

func TestRunnerReturnsErrBusyWhenGateFull(t *testing.T) {
	r := shRunner(t)
	r.Gate = NewGate(1)
	if !r.Gate.TryAcquire() {
		t.Fatal("占位失败")
	}
	defer r.Gate.Release()
	_, err := r.Run(context.Background(), "-c", "echo hi")
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err=%v, want ErrBusy", err)
	}
}

func TestRunnerCapsCapturePerStream(t *testing.T) {
	r := shRunner(t)
	r.MaxCaptureBytes = 64
	res, err := r.Run(context.Background(), "-c", "yes abcdefghij | head -c 100000")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.StdoutTruncated {
		t.Error("StdoutTruncated=false：上限没生效")
	}
	if len(res.Stdout) > 64 {
		t.Errorf("捕获了 %d 字节，超过上限 64", len(res.Stdout))
	}
	// Node 的 maxBuffer 超限会把整次调用判错并丢掉输出；这里有意改成「留住前面的」。
	if res.ExitCode != 0 {
		t.Errorf("exit=%d：输出超限不该把调用判成失败", res.ExitCode)
	}
}

func TestClipCountsRunesNotBytes(t *testing.T) {
	text := strings.Repeat("中", 10)
	got := Clip(text, 4)
	if !strings.HasPrefix(got, "中中中中\n[输出超长") {
		t.Errorf("Clip 按字节切了或文案变了: %q", got)
	}
	if Clip(text, 10) != text {
		t.Error("刚好不超长的不该加尾注")
	}
	if Clip(text, 0) != text {
		t.Error("上限 0 视作不截断")
	}
}
