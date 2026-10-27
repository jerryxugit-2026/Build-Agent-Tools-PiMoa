package mcpshell

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件的核心职责：**证明 JobStore 有界**。
// Python 版 antigravity-mcp 的 active_jobs 只增不删（server.py:29 建、:278 写，全文无 del/pop），
// 每条还带完整 stdout。stdio 下被进程生命周期兜住，改成常驻 http 就是无界泄漏。

func fixedClock(t *testing.T, s *JobStore) func(time.Duration) {
	t.Helper()
	var mu sync.Mutex
	now := time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	return func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}
}

func mustCreate(t *testing.T, s *JobStore, pid int) string {
	t.Helper()
	id, err := s.Create(pid, "m", "a", "/w")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return id
}

// ───────────── 条数封顶 ─────────────

func TestJobStoreBoundedByCount(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	advance := fixedClock(t, s)

	// 塞 1000 条（Python 版这里会留下 1000 条，永不回落）。
	for i := 0; i < 1000; i++ {
		id := mustCreate(t, s, i)
		s.Finish(id, JobCompleted, 0, "out", "err", "")
		advance(time.Second) // 让完成时间严格递增，淘汰顺序可判定
	}
	if got := s.Len(); got != 10 {
		t.Fatalf("塞了 1000 条后表里有 %d 条，want 恒 <= 10（有界性被破坏 = 退回泄漏形态）", got)
	}
}

// 淘汰的必须是**最早完成的**，不能是随机的（否则刚跑完的结果可能先被扔掉）。
func TestJobStoreEvictsOldestFinishedFirst(t *testing.T) {
	s := NewJobStore(3, 0, 0, 0)
	advance := fixedClock(t, s)

	ids := make([]string, 0, 4)
	for i := 0; i < 3; i++ {
		id := mustCreate(t, s, i)
		s.Finish(id, JobCompleted, 0, fmt.Sprintf("out-%d", i), "", "")
		ids = append(ids, id)
		advance(time.Minute)
	}
	// 第 4 条把最早的挤掉。
	id4 := mustCreate(t, s, 4)
	s.Finish(id4, JobCompleted, 0, "out-4", "", "")
	ids = append(ids, id4)

	if _, ok := s.Get(ids[0]); ok {
		t.Error("最早完成的没被淘汰")
	}
	for _, id := range ids[1:] {
		if _, ok := s.Get(id); !ok {
			t.Errorf("较新的 job %s 被误淘汰了", id)
		}
	}
}

// ───────────── 字节总量封顶 ─────────────

// 光有条数上限不够：100 条 × 每条 10MB 仍然是 1GB。
func TestJobStoreBoundedByTotalBytes(t *testing.T) {
	const maxBytes = 10_000
	s := NewJobStore(1000, maxBytes, 0, 0)
	advance := fixedClock(t, s)

	big := strings.Repeat("x", 3_000)
	for i := 0; i < 200; i++ {
		id := mustCreate(t, s, i)
		s.Finish(id, JobCompleted, 0, big, big, "")
		advance(time.Second)
		if s.Bytes() > maxBytes {
			t.Fatalf("第 %d 条之后占用 %d 字节，超过上限 %d", i, s.Bytes(), maxBytes)
		}
	}
	if s.Len() == 0 {
		t.Error("全淘汰光了：至少要留得下最新的结果")
	}
	t.Logf("200 条 × 6KB 输出后：%d 条 / %d 字节（上限 %d）", s.Len(), s.Bytes(), maxBytes)
}

// 单条输出也要各自截断，一条巨型输出不能把总预算一口吃光。
func TestJobStoreClipsPerJobOutput(t *testing.T) {
	s := NewJobStore(10, 0, 100, 0)
	id := mustCreate(t, s, 1)
	s.Finish(id, JobCompleted, 0, strings.Repeat("中", 5_000), strings.Repeat("y", 5_000), "")
	job, ok := s.Get(id)
	if !ok {
		t.Fatal("job 不见了")
	}
	if !strings.Contains(job.Stdout, "已按 100 字符截断") {
		t.Errorf("stdout 没截断：%d 字符", len([]rune(job.Stdout)))
	}
	if !strings.Contains(job.Stderr, "已按 100 字符截断") {
		t.Error("stderr 没截断")
	}
}

// ───────────── 时效回收 ─────────────

func TestJobStoreRetainExpiresFinishedJobs(t *testing.T) {
	s := NewJobStore(100, 0, 0, 10*time.Minute)
	advance := fixedClock(t, s)

	id := mustCreate(t, s, 1)
	s.Finish(id, JobCompleted, 0, "out", "", "")
	if _, ok := s.Get(id); !ok {
		t.Fatal("刚完成就查不到")
	}
	advance(9 * time.Minute)
	if _, ok := s.Get(id); !ok {
		t.Error("没到保留期就被回收了（轮询会拿不到结果）")
	}
	advance(2 * time.Minute) // 累计 11 分钟 > 10 分钟
	if _, ok := s.Get(id); ok {
		t.Error("过了保留期还在：时效回收没生效")
	}
	if s.Len() != 0 || s.Bytes() != 0 {
		t.Errorf("回收后计数没清：len=%d bytes=%d", s.Len(), s.Bytes())
	}
}

// running 的 job 不受时效回收影响——它还在跑，回收了轮询就永远查不到。
func TestJobStoreNeverExpiresRunningJobs(t *testing.T) {
	s := NewJobStore(100, 0, 0, time.Minute)
	advance := fixedClock(t, s)

	id := mustCreate(t, s, 1)
	advance(24 * time.Hour)
	if _, ok := s.Get(id); !ok {
		t.Fatal("running 的 job 被时效回收了")
	}
	s.Finish(id, JobCompleted, 0, "done", "", "")
	if job, _ := s.Get(id); job.Stdout != "done" {
		t.Errorf("完成后的输出取不到：%+v", job)
	}
}

// ───────────── running 永不淘汰 + 表满时拒绝 ─────────────

func TestJobStoreNeverEvictsRunningAndRefusesWhenAllRunning(t *testing.T) {
	s := NewJobStore(3, 0, 0, 0)
	running := []string{mustCreate(t, s, 1), mustCreate(t, s, 2), mustCreate(t, s, 3)}

	// 全在跑且已达上限 → 必须**拒绝**新 job（拒绝优于悄悄超限）。
	if _, err := s.Create(4, "m", "a", "/w"); err != ErrJobStoreFull {
		t.Fatalf("表满时 err=%v，want ErrJobStoreFull", err)
	}
	if s.Len() != 3 {
		t.Errorf("拒绝后条数变了：%d", s.Len())
	}
	for _, id := range running {
		if _, ok := s.Get(id); !ok {
			t.Errorf("running 的 job %s 被淘汰了", id)
		}
	}
	// 有一条完成后就腾出位置了。
	s.Finish(running[0], JobCompleted, 0, "x", "", "")
	if _, err := s.Create(4, "m", "a", "/w"); err != nil {
		t.Errorf("腾出位置后仍拒绝：%v", err)
	}
}

// ───────────── 快照语义 ─────────────

func TestJobStoreRunningJobHidesPartialOutput(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	id := mustCreate(t, s, 7)
	job, ok := s.Get(id)
	if !ok {
		t.Fatal("查不到")
	}
	if job.Status != JobRunning || job.PID != 7 {
		t.Errorf("快照不对：%+v", job)
	}
	if job.Stdout != "" || job.Stderr != "" {
		t.Error("running 的 job 不该回传半截输出（与 Python 版一致）")
	}
	if job.ReturnCode != nil {
		t.Error("running 的 job 不该有 returncode")
	}
}

func TestJobStoreFinishRecordsConversationID(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	id := mustCreate(t, s, 1)
	s.Finish(id, JobCompleted, 0, "out", "", "0eccd3d4-d949-4ee5-8dfe-482354bd47b5")
	job, _ := s.Get(id)
	if job.ConversationID != "0eccd3d4-d949-4ee5-8dfe-482354bd47b5" {
		t.Errorf("conversation_id 没落库：%+v", job)
	}
	if job.ReturnCode == nil || *job.ReturnCode != 0 {
		t.Errorf("returncode 不对：%+v", job.ReturnCode)
	}
}

// job 已被淘汰之后，后台 goroutine 仍可能调 Finish——不能崩。
func TestJobStoreFinishOnEvictedJobIsSilent(t *testing.T) {
	s := NewJobStore(1, 0, 0, 0)
	advance := fixedClock(t, s)
	id1 := mustCreate(t, s, 1)
	s.Finish(id1, JobCompleted, 0, "a", "", "")
	advance(time.Second)
	_ = mustCreate(t, s, 2) // 把 id1 挤掉

	s.Finish(id1, JobCompleted, 0, "迟到的结果", "", "") // 不该 panic
	if _, ok := s.Get(id1); ok {
		t.Error("已淘汰的 job 被 Finish 复活了")
	}
}

func TestJobStoreGetUnknownID(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	if _, ok := s.Get("不存在"); ok {
		t.Error("不存在的 id 报了存在")
	}
}

// ───────────── 终态判定（2026-09-20 由「!= JobRunning 二分」改为显式 isTerminal） ─────────────

// ⚠️ 这条测试的**前提在 2026-09-20 变了**，注释必须跟着改，否则它是假的说明：
//
//	旧机制：保留期清扫与容量淘汰一律写 `!= JobRunning`，于是「任何非 running 的
//	新状态天然被当终态」。这条测试当时证明的就是那件事。
//	新机制：review 串行闸引入了 JobQueued —— 一个**非终态但不是 running** 的状态。
//	旧写法会把排队中的任务当终态：过了 Retain 被保留期清扫删掉、容量吃紧时被当
//	淘汰候选踢出去，**一个还在排队的任务凭空消失**，调用方轮询到「查无此 job」。
//	所以判定改成显式枚举的 JobStatus.isTerminal()，本测试也随之改为证明
//	「终态与非终态两边都按 isTerminal 走」。
//
// 覆盖关系（任务书 §五 要求单独说明）：本测试覆盖「终态仍被清扫/淘汰」，
// TestJobStoreQueuedIsNotSweptOrEvicted 覆盖「排队中的不被清扫、不被淘汰」。
func TestJobStoreTerminalStatusIsExplicit(t *testing.T) {
	t.Run("终态集合的登记本身", func(t *testing.T) {
		for _, st := range []JobStatus{JobCompleted, JobFailed, JobTimedOut, JobCanceled, JobCompletedWithWarnings} {
			if !st.isTerminal() {
				t.Errorf("%q 该是终态", st)
			}
		}
		// 这两个是**非终态**：running 在跑，queued 在排队。任何一个被判成终态，
		// 对应的任务就会被清扫/淘汰收走。
		for _, st := range []JobStatus{JobRunning, JobQueued} {
			if st.isTerminal() {
				t.Errorf("%q 不该是终态——它会被保留期清扫与容量淘汰收走", st)
			}
		}
		// 未登记的状态值一律当非终态（保守侧：多留一会儿，而不是凭空消失）。
		if JobStatus("未来新增的状态").isTerminal() {
			t.Error("未登记的状态该按非终态处理")
		}
	})

	t.Run("保留期清扫会回收它", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, time.Hour)
		advance := fixedClock(t, s)
		id := mustCreate(t, s, 1)
		s.Finish(id, JobCompletedWithWarnings, 0, "恢复后的正文", "", "conv-1")
		if job, ok := s.Get(id); !ok || job.Status != JobCompletedWithWarnings {
			t.Fatalf("Finish 后查不到或状态不对：ok=%v job=%+v", ok, job)
		}
		advance(2 * time.Hour) // 超过 Retain
		if _, ok := s.Get(id); ok {
			t.Error("completed_with_warnings 超过 Retain 后该被清扫，却仍查得到——说明它没被当终态")
		}
	})

	t.Run("容量淘汰会挑它当候选", func(t *testing.T) {
		s := NewJobStore(1, 0, 0, 0)
		advance := fixedClock(t, s)
		id1 := mustCreate(t, s, 1)
		s.Finish(id1, JobCompletedWithWarnings, 0, "a", "", "")
		advance(time.Second)
		id2 := mustCreate(t, s, 2) // 表满，该把 id1 挤掉
		if _, ok := s.Get(id1); ok {
			t.Error("completed_with_warnings 没被容量淘汰选中——说明淘汰逻辑把它当成了 running 一样不可淘汰")
		}
		if _, ok := s.Get(id2); !ok {
			t.Error("新 job 应该能正常入表")
		}
	})

	t.Run("running 状态不受影响，仍不可淘汰不可清扫", func(t *testing.T) {
		s := NewJobStore(1, 0, 0, time.Hour)
		advance := fixedClock(t, s)
		runningID := mustCreate(t, s, 9)
		advance(2 * time.Hour)
		if _, err := s.Create(10, "m", "a", "/w"); !errors.Is(err, ErrJobStoreFull) {
			t.Fatalf("running 的 job 不该被新建请求挤掉：err=%v", err)
		}
		if job, ok := s.Get(runningID); !ok || job.Status != JobRunning {
			t.Errorf("running 的 job 被误清扫/误淘汰了：ok=%v job=%+v", ok, job)
		}
	})
}

// TestJobStoreQueuedIsNotSweptOrEvicted 是上面那条的**对照面**，也是本批（review
// 串行闸）新增状态的安全网：排队中的任务绝不能被保留期清扫删掉、也绝不能被容量
// 淘汰当候选踢出去——否则「排队中的任务已是 job 表里的记录」这条不变量就断了，
// 调用方会轮询到「查无此 job」。
//
// 这条测试是**故意**在旧机制（`!= JobRunning` 二分）下会红的：旧写法把 queued 当
// 终态，两个子用例都会失败。所以它同时钉住了「机制已改成显式 isTerminal」。
func TestJobStoreQueuedIsNotSweptOrEvicted(t *testing.T) {
	t.Run("保留期清扫不收它", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, time.Hour)
		advance := fixedClock(t, s)
		id, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		advance(2 * time.Hour) // 远超 Retain
		if job, ok := s.Get(id); !ok || job.Status != JobQueued {
			t.Fatalf("排队中的 job 被保留期清扫删掉了——调用方会轮询到「查无此 job」：ok=%v job=%+v", ok, job)
		}
	})

	t.Run("容量淘汰不挑它当候选", func(t *testing.T) {
		s := NewJobStore(2, 0, 0, 0)
		advance := fixedClock(t, s)
		qID, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		advance(time.Second)
		doneID := mustCreate(t, s, 2)
		s.Finish(doneID, JobCompleted, 0, "out", "", "")
		advance(time.Second)
		// 表满（2 条）：新请求该挤掉**已完成**的 doneID，而不是排队中的 qID。
		newID, err := s.Create(3, "m", "a", "/w")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if _, ok := s.Get(qID); !ok {
			t.Error("排队中的 job 被容量淘汰踢出去了——还在排队的任务不该消失")
		}
		if _, ok := s.Get(doneID); ok {
			t.Error("该被淘汰的是最早完成的终态 job，它却还在")
		}
		if _, ok := s.Get(newID); !ok {
			t.Error("新 job 该能正常入表")
		}
	})

	t.Run("全表都是未落终态时仍拒绝新请求", func(t *testing.T) {
		// 有界性不能被新状态破坏：queued 也不可淘汰，所以「1 条 queued + 1 条 running」
		// 占满表之后，新请求必须被拒绝，而不是悄悄超限。
		s := NewJobStore(2, 0, 0, 0)
		if _, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w"); err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		mustCreate(t, s, 2)
		if _, err := s.Create(3, "m", "a", "/w"); !errors.Is(err, ErrJobStoreFull) {
			t.Fatalf("表里全是未落终态时该拒绝，却成功了：err=%v", err)
		}
	})

	t.Run("排队中的 job 不回传半截输出", func(t *testing.T) {
		// Get 的屏蔽判据同样从 `== JobRunning` 改成了 isTerminal：排队中的 job
		// 没有任何结果可给，回传半截 stdout 会被当成「已经在出结果了」。
		s := NewJobStore(10, 0, 0, 0)
		id, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		if job, _ := s.Get(id); job.Stdout != "" || job.Stderr != "" {
			t.Errorf("排队中的 job 不该有输出：%+v", job)
		}
	})
}

// TestJobStoreQueueAheadAndMarkRunning 钉住串行闸依赖的两个操作：
// 位次（读的时候现算，按登记全序）与「排队 → running」的迁移。
func TestJobStoreQueueAheadAndMarkRunning(t *testing.T) {
	t.Run("位次按登记顺序前进", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, 0)
		advance := fixedClock(t, s)
		first, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		advance(time.Second)
		second, _ := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		advance(time.Second)
		third, _ := s.CreateQueued(0, "m", "papergo-doc-review", "/w")

		for id, want := range map[string]int{first: 0, second: 1, third: 2} {
			if got, ok := s.QueueAhead(id); !ok || got != want {
				t.Errorf("QueueAhead(%s)=%d,%v want %d,true", id, got, ok, want)
			}
		}

		// 队首起跑（切 running）之后，后面两人的位次各前进一位。
		if !s.MarkRunning(first) {
			t.Fatal("MarkRunning 该成功")
		}
		if got, _ := s.QueueAhead(second); got != 0 {
			t.Errorf("队首起跑后 second 该在最前，got %d", got)
		}
		if got, _ := s.QueueAhead(third); got != 1 {
			t.Errorf("队首起跑后 third 该前面只剩 1 个，got %d", got)
		}
		// running 的不是排队状态，位次无意义但必须报「有这条 job」。
		if got, ok := s.QueueAhead(first); !ok || got != 0 {
			t.Errorf("running 的 job：ok 该为 true、位次 0，got %d,%v", got, ok)
		}
		if got, ok := s.QueueAhead("不存在"); ok || got != 0 {
			t.Errorf("不存在的 id 该报 ok=false，got %d,%v", got, ok)
		}
	})

	t.Run("同秒登记的位次仍然稳定", func(t *testing.T) {
		// CreatedAt 是 RFC3339 的秒级字符串，同一秒里创建的多条比不出先后——
		// 没有 id 次级键的话位次会在两次轮询之间无理由地跳。
		s := NewJobStore(10, 0, 0, 0)
		_ = fixedClock(t, s) // 时间不前进：全部同秒
		ids := make([]string, 0, 5)
		for i := 0; i < 5; i++ {
			id, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
			if err != nil {
				t.Fatalf("CreateQueued: %v", err)
			}
			ids = append(ids, id)
		}
		// 位次必须是 0..4 的一个排列（两两不同、全序可判定）。
		seen := map[int]string{}
		for _, id := range ids {
			got, ok := s.QueueAhead(id)
			if !ok {
				t.Fatalf("QueueAhead(%s) 报不存在", id)
			}
			if prev, dup := seen[got]; dup {
				t.Fatalf("%s 与 %s 位次相同（%d）——同秒登记时位次不可判定", id, prev, got)
			}
			seen[got] = id
		}
		for want := 0; want < 5; want++ {
			if _, ok := seen[want]; !ok {
				t.Errorf("位次 %d 缺失：%v", want, seen)
			}
		}
	})

	t.Run("MarkRunning 只对排队中的成功一次", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, 0)
		id, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		if !s.MarkRunning(id) {
			t.Fatal("第一次该成功")
		}
		if s.MarkRunning(id) {
			t.Error("已经是 running 了，第二次不该再成功（否则会重复 spawn）")
		}
		if job, _ := s.Get(id); job.Status != JobRunning {
			t.Errorf("状态该是 running：%+v", job)
		}
		// 已终态的 job 绝不能被改回 running：那会凭空多出一个串行槽位的持有者。
		s.Finish(id, JobTimedOut, -1, "", "超时", "")
		if s.MarkRunning(id) {
			t.Error("终态的 job 不该能被改回 running")
		}
		if job, _ := s.Get(id); job.Status != JobTimedOut {
			t.Errorf("终态被改动了：%+v", job)
		}
		if s.MarkRunning("不存在") {
			t.Error("不存在的 id 不该成功")
		}
	})

	t.Run("SetPID 补上排队时没有的 pid", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, 0)
		id, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		if job, _ := s.Get(id); job.PID != 0 {
			t.Errorf("排队时还没有进程，PID 该是 0：%+v", job)
		}
		s.SetPID(id, 4242)
		if job, _ := s.Get(id); job.PID != 4242 {
			t.Errorf("SetPID 没落上：%+v", job)
		}
		s.SetPID(id, 0) // 0 不覆盖已有值（与 SetPaths 的空串同款）
		if job, _ := s.Get(id); job.PID != 4242 {
			t.Errorf("PID=0 不该覆盖已有值：%+v", job)
		}
		s.SetPID("不存在", 1) // 不该 panic
	})

	t.Run("Running 与 Queued 分开计数", func(t *testing.T) {
		s := NewJobStore(10, 0, 0, 0)
		a, _ := s.CreateQueued(0, "m", "papergo-doc-review", "/w")
		if _, err := s.CreateQueued(0, "m", "papergo-doc-review", "/w"); err != nil {
			t.Fatalf("CreateQueued: %v", err)
		}
		mustCreate(t, s, 3)
		if got := s.Queued(); got != 2 {
			t.Errorf("Queued()=%d want 2", got)
		}
		if got := s.Running(); got != 1 {
			t.Errorf("Running()=%d want 1（排队中的不该被算成 running）", got)
		}
		s.MarkRunning(a)
		if got := s.Queued(); got != 1 {
			t.Errorf("起跑后 Queued()=%d want 1", got)
		}
		if got := s.Running(); got != 2 {
			t.Errorf("起跑后 Running()=%d want 2", got)
		}
	})
}

// ───────────── SetPaths（antigravity-mcp 正文全文落盘路径回填） ─────────────

func TestJobStoreSetPaths(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	id := mustCreate(t, s, 1)
	s.Finish(id, JobCompleted, 0, "out", "", "conv-1")

	s.SetPaths(id, "/tmp/antigravity-jobs/"+id+".md", "/tmp/transcript.jsonl")
	job, ok := s.Get(id)
	if !ok {
		t.Fatal("查不到")
	}
	if job.OutputPath != "/tmp/antigravity-jobs/"+id+".md" {
		t.Errorf("OutputPath 没落上：%+v", job)
	}
	if job.TranscriptPath != "/tmp/transcript.jsonl" {
		t.Errorf("TranscriptPath 没落上：%+v", job)
	}

	// 空字符串的那一路不覆盖已有值。
	s.SetPaths(id, "", "/tmp/transcript-v2.jsonl")
	job, _ = s.Get(id)
	if job.OutputPath != "/tmp/antigravity-jobs/"+id+".md" {
		t.Errorf("空 outputPath 不该覆盖已有值：%+v", job)
	}
	if job.TranscriptPath != "/tmp/transcript-v2.jsonl" {
		t.Errorf("transcriptPath 该被更新：%+v", job)
	}
}

// id 不存在（job 可能已被淘汰）时静默返回，不能 panic。
func TestJobStoreSetPathsUnknownIDIsSilent(t *testing.T) {
	s := NewJobStore(10, 0, 0, 0)
	s.SetPaths("不存在", "/tmp/x.md", "/tmp/y.jsonl") // 不该 panic
}

// ───────────── 并发安全 ─────────────

func TestJobStoreConcurrentAccessStaysBounded(t *testing.T) {
	const maxJobs = 20
	s := NewJobStore(maxJobs, 50_000, 1_000, 0)

	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				id, err := s.Create(w*1000+i, "m", "a", "/w")
				if err != nil {
					continue // 表满被拒是合法结果
				}
				s.Finish(id, JobCompleted, 0, strings.Repeat("o", 500), "", "")
				s.Get(id)
				s.Len()
				s.Bytes()
			}
		}(w)
	}
	wg.Wait()

	if got := s.Len(); got > maxJobs {
		t.Errorf("并发后 %d 条，超过上限 %d", got, maxJobs)
	}
	if got := s.Bytes(); got > 50_000 {
		t.Errorf("并发后 %d 字节，超过上限 50000", got)
	}
	t.Logf("8 路 × 100 次并发后：%d 条 / %d 字节", s.Len(), s.Bytes())
}

func TestNewJobIDIsUniqueAndHex(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		id := newJobID()
		if len(id) != 32 {
			t.Fatalf("id 长度 %d，want 32（与 Python 的 uuid4().hex 同形态）", len(id))
		}
		if seen[id] {
			t.Fatalf("id 重复：%s", id)
		}
		seen[id] = true
	}
}
