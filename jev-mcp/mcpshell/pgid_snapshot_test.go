package mcpshell

import (
	"context"
	"testing"
	"time"
)

// 本文件钉住 PiMoa review 2026-09-19 第二轮抓出的三条：
//   MAJOR  pgid 事后反查 → pid 被复用时会杀掉无关进程组
//   MINOR  Kill() 不看 p.done → 迟到的取消会往已回收的 pid 发信号
//   MINOR  supervise 的 select 同刻随机选边 → 跑完的调用被误标成取消

func shTestRunner(grace time.Duration) *Runner {
	return &Runner{
		Path:            "/bin/sh",
		Timeout:         10 * time.Second,
		MaxCaptureBytes: 1 << 16,
		Gate:            NewGate(4),
		TerminateGrace:  grace,
	}
}

// pgid 必须在 Start 的那一刻定死，且按 Setpgid:true 的构造恒等于子进程 pid。
// 这条是 MAJOR 修复的地基：只要 pgid 是快照，后面所有 kill 就都不会打到复用的 pid 上。
func TestPgidSnapshotTakenAtStart(t *testing.T) {
	r := shTestRunner(0)
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "exit 0")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if p.PID <= 1 {
		t.Fatalf("PID=%d 不合理", p.PID)
	}
	if p.pgid != p.PID {
		t.Errorf("pgid=%d 应恒等于 PID=%d（Setpgid:true 让子进程自成新组，组号即其 pid）",
			p.pgid, p.PID)
	}
	res := p.Wait()
	// 收割之后快照仍在：这正是「不再事后反查」所依赖的东西。
	if p.pgid != p.PID {
		t.Errorf("收割后 pgid 快照被改动了：%d != %d", p.pgid, p.PID)
	}
	if res.ExitCode != 0 {
		t.Errorf("退出码 %d，want 0", res.ExitCode)
	}
}

// 对已收尾的 Pending 调 Kill 必须是安全空操作。
// 判据用耗时：若没有 p.done 短路，带 grace 的路径会走进 terminateGroup 的轮询，
// 至少要花上一个探活周期；短路之后应当是立即返回。
func TestKillAfterFinishIsNoop(t *testing.T) {
	r := shTestRunner(2 * time.Second)
	p, err := r.Start(context.Background(), RunOptions{}, "-c", "exit 0")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	before := p.Wait()

	start := time.Now()
	p.Kill() // 迟到的取消：后台 job 早跑完了，服务才来收尾
	if el := time.Since(start); el > 200*time.Millisecond {
		t.Errorf("Kill 在已收尾的 Pending 上耗时 %v，说明没短路、真去发信号了", el)
	}
	// 再调一次也不能炸
	p.Kill()

	after := p.Wait() // Wait 可重入，读的是同一份 result
	if after.ExitCode != before.ExitCode || after.Canceled != before.Canceled {
		t.Errorf("迟到的 Kill 改写了已定的结果：before=%+v after=%+v",
			before.ExitCode, after.ExitCode)
	}
}

// 不变量：进程自己干净跑完（ExitCode==0）就绝不能被标成取消或超时。
// 这条原来只在「waitCh 严格早于 ctx.Done 就绪」时成立；两者同刻就绪时 Go 的 select
// 随机选边，选中 ctx 分支就会把成功写成 Canceled，finish 还会把 ExitCode 由 0 改成 -1。
// 用一批把「进程退出」与「ctx 取消」对齐到同一时刻的样本来压这个窗口。
// ⚠️ 这**不是**回归锁，是烟雾测试——如实写明，免得后人误以为有 CI 在保护这条不变量。
//
// 2026-09-19 实测过程：第一版让子进程直接 `exit 0`、1ms 后取消，结果 ctx 每次都合法
// 先到、进程被杀、退出码非 0，断言根本不触发（红的是自检卫兵，不是断言）。第二版把
// 取消对齐到 150ms、子进程 sleep 0.15，忘了算 fork/exec 约 10ms 的启动开销，仍然是
// 取消永远先到、干净退出零样本。第三版把扫描中心移到 165ms、以 1.2ms 步长跨 72ms，
// 终于稳定拿到每轮 30+ 个干净退出样本——**但撤回修复后它依然全绿**。
//
// 原因：select 双就绪的窗口是纳秒级的（要求 ctx.Done 恰好在「进程退出」到「supervise
// 求值 select」这几微秒之间关闭），挂钟采样落不进去。所以那条修复靠的是把不变量写成
// 无条件成立，不是靠这个测试。这里保留它的价值只剩一条：如果有人把 ctx 分支改成更
// 容易误触发的写法（比如去掉非阻塞探测又放宽判定），这个扫描能抓到粗粒度的回归。
func TestCleanExitNeverLabeledCanceled(t *testing.T) {
	r := shTestRunner(0)
	// 扫描窗口必须**跨过**进程真正退出的时刻，两种先后都要出现，否则测不到边界。
	// 第二版把取消固定在 150ms、子进程 sleep 0.15，看着「对齐」了，实际上子进程还要
	// 付 fork/exec 的启动开销（约 10ms），于是每一轮都是取消先到、进程被杀，
	// 干净退出一次都没有——测试红了，但红的是自检卫兵，不是断言。
	const (
		rounds    = 24                      // 只是烟雾测试，不值得让 CI 多等 10 秒
		procSleep = "0.15"                  // 子进程睡这么久后 exit 0（实际退出约在 160ms）
		baseDelay = 165 * time.Millisecond  // 扫描中心对准实际退出时刻
		step      = 3000 * time.Microsecond // 24 轮 × 3ms = 跨 72ms，两侧都覆盖得到
	)
	clean := 0
	for i := 0; i < rounds; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		p, err := r.Start(ctx, RunOptions{}, "-c", "sleep "+procSleep+"; exit 0")
		if err != nil {
			cancel()
			t.Fatalf("第 %d 轮 Start: %v", i, err)
		}
		// 以 baseDelay 为中心向两侧扫，让取消时刻逐点穿过进程退出时刻。
		jitter := time.Duration(i-rounds/2) * step
		go func() {
			time.Sleep(baseDelay + jitter)
			cancel()
		}()
		res := p.Wait()
		cancel()
		if res.ExitCode == 0 {
			clean++
			if res.Canceled || res.TimedOut {
				t.Fatalf("第 %d 轮（取消时刻 %v）：退出码 0 却被标成 Canceled=%v TimedOut=%v"+
					"——一次成功的调用被写成了失败", i, baseDelay+jitter, res.Canceled, res.TimedOut)
			}
			if res.Failed() {
				t.Fatalf("第 %d 轮：退出码 0 却 Failed()=true", i)
			}
		}
	}
	// 一次都没跑到「干净退出」的话，这个测试什么也没验到——那才是真正的假绿。
	if clean == 0 {
		t.Fatalf("%d 轮里没有一次干净退出，时序没对上，本测试未验到任何东西", rounds)
	}
	t.Logf("%d 轮中 %d 轮为干净退出（这些才是被检验的样本）", rounds, clean)
}

// 反向不变量：ctx 确实先到时，仍然要如实标成取消（别为了修上面那条把这条修坏）。
func TestGenuineCancelStillLabeled(t *testing.T) {
	r := shTestRunner(0)
	ctx, cancel := context.WithCancel(context.Background())
	p, err := r.Start(ctx, RunOptions{}, "-c", "sleep 30")
	if err != nil {
		cancel()
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(80 * time.Millisecond) // 确保进程真的在跑
	cancel()
	res := p.Wait()
	if !res.Canceled {
		t.Errorf("真取消没被标出来：%+v", res)
	}
	if res.ExitCode == 0 {
		t.Errorf("被掐断的进程退出码不该是 0：%d", res.ExitCode)
	}
}
