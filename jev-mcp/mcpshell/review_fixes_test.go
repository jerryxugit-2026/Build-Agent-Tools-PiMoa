package mcpshell

// 这一组测试逐条钉住 2026-09-18 PiMoa 对抗审查提出的 1 MAJOR + 7 MINOR。
// 每个测试的注释先写「不修会怎样」，因为这些缺陷的共同特征是**不会报错、只会误报**。

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

// ───────────── MAJOR：BaseContext 让信号 ctx 传进 handler ─────────────

// 不修会怎样：http 模式下收到 SIGTERM 时，在飞工具调用的 ctx 不会被取消，
// Shutdown 宽限期满即 Close，已 spawn 的子进程（自成进程组、不随父死）
// 会一直残留到自己的超时才退——每次重启都可能留一批孤儿。
//
// 这里不起真 MCP 服务器（那要跑完整握手），而是直接验证 BaseContext 这条接线本身：
// 用同一套 http.Server 构造方式，让 handler 里起一个长命子进程并取用请求 ctx，
// 然后取消基础 ctx，断言子进程被杀、而不是活到自己的超时。
func TestHTTPBaseContextPropagatesShutdownToSpawnedChild(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	r := shRunner(t)
	r.Timeout = 60 * time.Second // 远大于本测试；被杀只可能来自 ctx 取消

	pidFile := filepath.Join(t.TempDir(), "child.pid")
	started := make(chan struct{})
	finished := make(chan Result, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, req *http.Request) {
		close(started)
		// 子进程把自己的 pid 写出来，随后长睡。
		res, err := r.Run(req.Context(), "-c", "echo $$ > "+pidFile+"; sleep 60")
		if err != nil {
			t.Errorf("Run: %v", err)
		}
		finished <- res
		w.WriteHeader(200)
	})

	srv := &http.Server{
		Handler:     mux,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	go func() {
		resp, err := http.Post("http://"+ln.Addr().String()+"/mcp", "application/json", strings.NewReader("{}"))
		if err == nil {
			_ = resp.Body.Close()
		}
	}()

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("handler 没被调用")
	}

	childPID := 0
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if raw, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && pid > 0 {
				childPID = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("没拿到子进程 pid")
	}

	start := time.Now()
	stop() // 模拟 SIGTERM：取消基础 ctx

	select {
	case res := <-finished:
		if elapsed := time.Since(start); elapsed > 10*time.Second {
			t.Errorf("子进程活到 %s 才退：BaseContext 没把取消传进去", elapsed)
		}
		if !res.Canceled {
			t.Errorf("没标成客户端取消：%+v", res)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("取消基础 ctx 后子进程仍在跑：BaseContext 没生效（注释承诺的行为等于没实现）")
	}

	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if syscall.Kill(childPID, 0) != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("子进程 %d 还活着", childPID)
}

// ───────────── MINOR 1：Start 失败分支要带上取消/超时标记 ─────────────

// 不修会怎样：ctx 已取消时 cmd.Start 直接返回 context.Canceled，函数在
// 「res.StartErr = err; return」处提前返回，跳过 ctx 判定 → Canceled/TimedOut 全 false、
// KilledReason() 空串。调用方会把「客户端取消」误读成「程序起不来」。
func TestStartFailureKeepsCancelFlag(t *testing.T) {
	r := shRunner(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 先取消，让 cmd.Start 直接失败

	res, err := r.RunWith(ctx, RunOptions{}, "-c", "echo hi")
	if err != nil {
		t.Fatalf("RunWith 不该返回 error：%v", err)
	}
	if !res.Canceled {
		t.Errorf("Canceled=false：起不来分支丢了取消标记，调用方会误读成「程序起不来」（%+v）", res)
	}
	if res.KilledReason() != "客户端取消被杀" {
		t.Errorf("KilledReason=%q，want 客户端取消被杀", res.KilledReason())
	}
}

func TestStartFailureKeepsTimeoutFlag(t *testing.T) {
	r := shRunner(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(5 * time.Millisecond) // 确保已过期

	res, err := r.RunWith(ctx, RunOptions{}, "-c", "echo hi")
	if err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	// 调用方 ctx 自己就过期了 → 归为「客户端取消」（不是我们的 per-call 超时）。
	if !res.Canceled && !res.TimedOut {
		t.Errorf("过期 ctx 下起不来，两个标记都没设：%+v", res)
	}
	if res.KilledReason() == "" {
		t.Error("KilledReason 是空串：调用方拿不到「为什么没跑」")
	}
}

// ───────────── MINOR 2：成功的调用不能被误标成取消 ─────────────

// 不修会怎样：子进程已 exit 0 之后才无条件看 ctx.Err()，客户端在收尾那一瞬取消
// 就会让一次**成功**的调用被标 Canceled=true / Failed()=true，可用结果被
// 「客户端取消被杀」的文案盖掉。
func TestCancelAfterSuccessfulExitIsNotMarkedCanceled(t *testing.T) {
	r := shRunner(t)
	for i := 0; i < 20; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		p, err := r.Start(ctx, RunOptions{}, "-c", "echo done")
		if err != nil {
			cancel()
			t.Fatalf("Start: %v", err)
		}
		// 等子进程自己跑完，再取消——模拟「收尾瞬间客户端取消」。
		time.Sleep(60 * time.Millisecond)
		cancel()
		res := p.Wait()
		if strings.TrimSpace(res.Stdout) != "done" {
			t.Fatalf("第 %d 轮：输出丢了 %+v", i, res)
		}
		if res.Canceled || res.TimedOut {
			t.Fatalf("第 %d 轮：成功的调用被误标成取消/超时，可用结果会被错误文案盖掉：%+v", i, res)
		}
		if res.Failed() {
			t.Fatalf("第 %d 轮：Failed()=true 但其实成功了：%+v", i, res)
		}
	}
}

// 反向不变量（同一处逻辑的另一半）：子进程自己 trap SIGTERM 后 exit 0 时，
// Signaled()=false、ExitCode=0——**只看信号就会把一次被我们掐断的调用报成干净成功**，
// 这是本仓库最忌的假绿。判据必须落在「取消看门狗是否开过火」上。
func TestTimeoutIsStillReportedWhenChildTrapsAndExitsZero(t *testing.T) {
	r := shRunner(t)
	r.TerminateGrace = 2 * time.Second
	r.Timeout = 400 * time.Millisecond

	res, err := r.Run(context.Background(), "-c", `trap 'exit 0' TERM; sleep 30`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("子进程 trap 后 exit 0，超时被漏报成干净成功（假绿）：%+v", res)
	}
	if res.ExitCode == 0 {
		t.Errorf("ExitCode=0：被掐断的调用不该谎报成功退出码（%+v）", res)
	}
}

// ───────────── MINOR 3：pgid<=1 兜底 ─────────────

// 现实中不可达（理由见 terminateGroup 注释），但这是全仓唯一「写错一个符号就杀掉
// 自己整个进程组」的位置，所以钉一个直接针对该函数的测试：pgid 合法时不许波及自己。
func TestTerminateGroupNeverTargetsOwnProcessGroup(t *testing.T) {
	ownPgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Skipf("拿不到自身进程组：%v", err)
	}
	r := shRunner(t)
	r.Timeout = 300 * time.Millisecond
	// 跑一个会被超时杀掉的子进程；若 terminateGroup 误把 -0/-1 当目标，
	// 测试进程本身会被 SIGKILL，这个测试就永远不会走到断言。
	if _, err := r.Run(context.Background(), "-c", "sleep 30"); err != nil {
		t.Fatalf("Run: %v", err)
	}
	// 还活着 + 进程组没变 = 没自伤。
	nowPgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Fatalf("Getpgid: %v", err)
	}
	if nowPgid != ownPgid {
		t.Fatalf("自身进程组变了：%d → %d", ownPgid, nowPgid)
	}
	// 子进程的组 id 必须与我们自己的不同（Setpgid 生效的直接证据）。
	p, err := r.Start(context.Background(), RunOptions{Timeout: 5 * time.Second}, "-c", "sleep 5")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	childPgid, err := syscall.Getpgid(p.PID)
	if err == nil && childPgid == ownPgid {
		t.Errorf("子进程与本进程同组（pgid=%d）：kill(-pgid) 会连自己一起杀", childPgid)
	}
	p.Kill()
	p.Wait()
}

// ───────────── MINOR 4：截断要落在 rune 边界 ─────────────

// 不修会怎样：按字节硬切会把一个中文字切成半截字节，客户端渲染出 U+FFFD，
// 与 Clip 的 rune 语义、与「留住前面的、如实说被截断」的口径都不齐。
func TestCappedBufferTruncatesAtRuneBoundary(t *testing.T) {
	// "中" 是 3 字节。上限设 7 → 只能完整装 2 个字（6 字节），第 3 个必须整个丢掉。
	b := &cappedBuffer{max: 7}
	if _, err := b.Write([]byte(strings.Repeat("中", 10))); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := b.String()
	if !utf8.ValidString(got) {
		t.Fatalf("截断产出了非法 UTF-8：%q", []byte(got))
	}
	if got != "中中" {
		t.Errorf("got %q，want %q", got, "中中")
	}
	if strings.ContainsRune(got, utf8.RuneError) {
		t.Error("出现了 U+FFFD：还是按字节硬切的")
	}
	if !b.Truncated() {
		t.Error("没标 truncated")
	}
}

// 跨 Write 的分片（上一次正好切在多字节序列中间）也不能产出破损。
func TestCappedBufferRuneBoundaryAcrossWrites(t *testing.T) {
	b := &cappedBuffer{max: 10}
	raw := []byte(strings.Repeat("中", 8)) // 24 字节
	// 故意按 5 字节一片地喂，制造「片头是半截序列」的情形。
	for i := 0; i < len(raw); i += 5 {
		end := i + 5
		if end > len(raw) {
			end = len(raw)
		}
		if _, err := b.Write(raw[i:end]); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if got := b.String(); !utf8.ValidString(got) {
		t.Errorf("分片写入后产出非法 UTF-8：%q", []byte(got))
	}
}

func TestTrimToRuneBoundary(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"中", 3},   // 完整
		{"中中", 6},  // 完整
		{"ab中", 5}, // 完整
		{"a", 1},
	}
	for _, c := range cases {
		if got := trimToRuneBoundary([]byte(c.in)); got != c.want {
			t.Errorf("trimToRuneBoundary(%q)=%d, want %d", c.in, got, c.want)
		}
	}
	// 末尾是半截的三字节序列 → 整个丢掉。
	half := []byte("ab" + "中")[:4] // "ab" + 前 2 字节的"中"
	if got := trimToRuneBoundary(half); got != 2 {
		t.Errorf("半截序列结尾应回退到 2，得到 %d", got)
	}
}

// ───────────── MINOR 5：正常退出路径也要收孙进程 ─────────────

// 不修会怎样：cmd.Cancel 只在超时/取消时触发，WaitDelay 只是放弃读管道、不杀任何人。
// 被调 CLI 自己 fork 后先退出时（claude/agy 正是这一类），孙进程成孤儿持续吃资源，
// 跨多次调用累积。
func TestNormalExitStillSweepsOrphanedGrandchild(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "gc.pid")
	r := shRunner(t)
	r.Timeout = 30 * time.Second // 绝不触发超时：这条路径必须靠 Wait 后的收尾

	// 父 shell 起一个长命孙进程后**立刻正常退出**（不 wait）。
	// 注意要把孙进程的 stdout/stderr 重定向掉，否则它继承管道会把 Wait 吊到 WaitDelay。
	res, err := r.Run(context.Background(), "-c",
		"(sleep 60 >/dev/null 2>&1 & echo $! > "+pidFile+"); exit 0")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("父进程应正常退出：%+v", res)
	}
	if res.TimedOut || res.Canceled {
		t.Fatalf("不该标成超时/取消：%+v", res)
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
			return // 已被收走
		}
		time.Sleep(20 * time.Millisecond)
	}
	// 收不掉就把它杀了，别把孤儿留给后续测试。
	_ = syscall.Kill(pid, syscall.SIGKILL)
	t.Fatalf("孙进程 %d 在父进程正常退出后仍活着：正常路径没做进程组收尾", pid)
}

// ───────────── MINOR 6：零长度写入不是「被截断」 ─────────────

// 不修会怎样：缓冲已满后收到空切片也会置 truncated → StdoutTruncated 假阳性，
// 报告里凭空多一句「输出已截断」。io.Copy 不传空切片，但行回调路径会。
func TestCappedBufferZeroLengthWriteIsNotTruncation(t *testing.T) {
	b := &cappedBuffer{max: 4}
	if _, err := b.Write([]byte("abcd")); err != nil { // 正好填满，未超
		t.Fatalf("Write: %v", err)
	}
	if b.Truncated() {
		t.Fatal("刚好填满不该算截断")
	}
	n, err := b.Write(nil)
	if err != nil || n != 0 {
		t.Errorf("空写入返回 (%d, %v)", n, err)
	}
	if _, err := b.Write([]byte{}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if b.Truncated() {
		t.Error("零长度写入被当成截断了（StdoutTruncated 假阳性）")
	}
	// 真的超了才该置位。
	if _, err := b.Write([]byte("e")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if !b.Truncated() {
		t.Error("真超限了却没置 truncated")
	}
}

// 行回调路径下的空写入同样不该造成假阳性。
func TestOnStdoutLineEmptyWritesDoNotFlagTruncation(t *testing.T) {
	var lines atomic.Int32
	b := &cappedBuffer{max: 1024, onLine: func(string) { lines.Add(1) }}
	for i := 0; i < 5; i++ {
		if _, err := b.Write(nil); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if _, err := b.Write([]byte("a\nb\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if b.Truncated() {
		t.Error("空写入造成了截断假阳性")
	}
	if got := lines.Load(); got != 2 {
		t.Errorf("行回调触发 %d 次，want 2", got)
	}
}

// ───────────── MINOR 7：Unix-only 已在注释里写明 ─────────────
// 不做跨平台抽象（四个服务只在本机 macOS 常驻），故无测试，仅在
// terminateGroup 的注释里登记约束。这条测试只是确保本机构建约束成立。
func TestUnixOnlyAssumptionHolds(t *testing.T) {
	if _, err := syscall.Getpgid(os.Getpid()); err != nil {
		t.Fatalf("本骨架假设 POSIX 进程组可用，但 Getpgid 失败：%v", err)
	}
	_ = fmt.Sprintf // 保持 import
}
