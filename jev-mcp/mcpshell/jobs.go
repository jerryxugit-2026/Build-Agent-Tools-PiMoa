package mcpshell

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
	"time"
)

// JobStore 是后台任务的注册表，**有界**。
//
// ⚠️ 它存在的全部理由是 Python 版 antigravity-mcp 的一个真缺陷：
// server.py 第 29 行 `active_jobs: dict = {}`、第 278 行写入，**全文件没有任何 del 或 pop**
// ——只增不删。而 _collect_background_job 会把**完整 stdout** 写进 job 记录，review 类
// 任务的输出动辄几十 KB。stdio 型下这个泄漏被会话生命周期兜住了（客户端一退，进程就死，
// 内存 100% 还给 OS），所以从来没暴露过；**一旦改成常驻 http，它就变成无界泄漏**——
// 这正是本次迁移要做的事。
//
// 有界策略是**双封顶 + 时效**三条。注意它们各管一段，**不是**「任何一条都能独立
// 止血」（PiMoa review 2026-09-19 纠正了原来这句过大的话）：字节封顶只在 Finish
// 时触发、且只能淘汰终态 job，所有 job 都在跑时它什么也做不了（见下面 enforceBytes
// 的注释）。store 的真实空间上界是 MaxJobs × 2 × MaxOutputPerJob，MaxTotalBytes
// 是在这之下再收一道，不是替代品。时间维度的兜底另见 RunningTimeout。
//   - MaxJobs：条数上限。超了就淘汰「最早完成的已完成 job」。
//   - MaxTotalBytes：所有 job 的输出字节总和上限。同上淘汰。
//     光有条数上限不够：100 条 × 每条 10MB 仍然是 1GB。
//   - Retain：已完成 job 的保留时长。轮询拿走结果后它就没用了，留着只是占内存。
//
// 三条纪律：
//  1. **running 的 job 永不淘汰**——它还在跑，淘汰了轮询就永远查不到结果。
//     若表里全是 running 且已达上限，Create 直接**拒绝**新 job（返回 ErrJobStoreFull）。
//     拒绝优于悄悄超限：超限就是退回泄漏形态。
//  2. 单条 job 的输出也各自截断（MaxOutputPerJob），一条巨型输出不能把总预算吃光。
//  3. **不起后台清扫 goroutine / 定时器**。清扫在每次写操作里顺带做（惰性）。
//     Node 版就是被 setInterval + NaN 配置烧过 CPU（清扫定时器按 0ms 忙循环），
//     惰性清扫没有定时器就没有那一类故障；代价只是「最后一条 job 过期后若再无写入，
//     它会多留一会儿」——而 Get 会在返回前查时效，读到的永远不是过期数据。
type JobStore struct {
	mu   sync.Mutex
	jobs map[string]*Job
	// bytes 是当前所有 job 输出字节数之和（增量维护，避免每次遍历）。
	bytes int

	// MaxJobs 是条数上限；<=0 视作不限（不建议）。
	MaxJobs int
	// MaxTotalBytes 是全部 job 输出的字节总和上限；<=0 视作不限。
	MaxTotalBytes int
	// MaxOutputPerJob 是单条 job 每一路输出的字符上限；<=0 视作不截断。
	MaxOutputPerJob int
	// Retain 是已完成 job 的保留时长；<=0 视作永久保留（直到被容量淘汰）。
	Retain time.Duration
	// RunningTimeout 是一条 job 允许停在 running 的最长时间；<=0 视作不设限。
	//
	// 为什么需要它（PiMoa review 2026-09-19）：Finish 是离开 running 的**唯一**出口，
	// 而清扫与容量淘汰两条路径都显式跳过 running，全文又没有任何基于创建时间的老化。
	// 于是「有界」这件事在时间维度上是有缺口的：只要有一条 job 因为任何原因走不到
	// Finish，它就永久占一个槽；攒够 MaxJobs 条，Create 会对之后所有请求永远返回
	// ErrJobStoreFull，而且**再没有任何写入能触发自愈**。
	// 当前 antigravity 的后台 goroutine 从 Wait 到 Finish 是一路直线、没有提前返回，
	// 所以这条路目前不可达——但那是**调用方的自觉**，不是 store 的性质。一个存在理由
	// 就是「有界」的组件，不该把自己的核心不变量寄托在使用者记得收尾上。
	RunningTimeout time.Duration

	// now 可在测试里替换，用来验证时效淘汰而不必真等。
	now func() time.Time
}

// ErrJobStoreFull 表示条数已满且**没有可淘汰的已完成 job**（全在跑）。
var ErrJobStoreFull = fmt.Errorf("后台任务表已满且全部在跑")

// JobStatus 是 job 的生命周期状态，取值与 Python 版逐字一致。
type JobStatus string

const (
	// JobQueued 是 antigravity-mcp 新增的**非终态**（2026-09-20，review 类串行闸）：
	// 任务已被登记进任务表、拿到了 job_id，但还没轮到它起跑（前面有 review 类任务
	// 在跑）。它是「排队不占调用方连接」这条不变量的落点——调用方拿到 job_id 就返回，
	// 靠 get_antigravity_status(job_id) 轮询位次，而不是在 MCP 请求里干等。
	//
	// ⚠️ 它与 JobRunning 是**两个**非终态，所以「按是否等于 JobRunning 二分」那套
	// 写法（本文件旧版的全部判定）对它一律是错的——见下面 isTerminal 的注释。
	JobQueued    JobStatus = "queued"
	JobRunning   JobStatus = "running"
	JobCompleted JobStatus = "completed"
	JobFailed    JobStatus = "failed"
	JobTimedOut  JobStatus = "timed_out"
	JobCanceled  JobStatus = "cancelled" // 拼写照抄 Python 版（cancelled 双 l）
	// JobCompletedWithWarnings 是 antigravity-mcp 新增的终态（2026-09-20）：
	// agy 自报非 SUCCESS，但转录复核判定是「瞬时 429 已恢复并完整作答」——
	// 正文可用，不该落成 failed 让调用方误判废弃，但也不能悄悄合并进 completed
	// （那会把「agy 自己报过错」这个事实抹掉）。
	//
	// 它与下面几个具体值一样，**终态与否由 isTerminal 显式登记**（2026-09-20 起，
	// 见那里的注释：本条在 JobQueued 出现之前是靠「!= JobRunning」的二分天然成立的，
	// 那条写法对非终态的新状态是错的，已改掉）。
	// 这条由 mcpshell/jobs_test.go 的 TestJobStoreTerminalStatusIsExplicit 证明，
	// 不是靠约定。
	JobCompletedWithWarnings JobStatus = "completed_with_warnings"
)

// isTerminal 报告这个状态是不是**终态**（不会再变、且该被保留期清扫与容量淘汰当候选）。
//
// ⚠️ 这里是**显式白名单**，不是「不等于 JobRunning 就算终态」的二分——2026-09-20
// 加 review 串行闸时新增了 JobQueued 这个**非终态**，旧写法（sweepExpiredLocked 的
// 保留期清扫、evictOldestFinishedLocked 的淘汰候选、Get 的半截输出屏蔽都用
// `Status == JobRunning` / `!= JobRunning`）一旦撞上 queued 就会**把一个还在排队的
// 任务当终态**：过了 Retain 被清扫删掉、容量吃紧时被当淘汰候选踢出去，调用方轮询到
// 「查无此 job」。所以判定必须显式枚举。
//
// ⚠️ 这**不是编译期强制**的：switch 的 default 会把「新增但漏登记」的状态静默当非
// 终态。真正拦住它的是 jobs_test.go 的 TestJobStoreTerminalStatusIsExplicit
// （逐个状态值核对归属）与 TestJobStoreQueuedIsNotSweptOrEvicted（行为面）。
// 新增状态时请一并更新那两条，别只改这里。
//
// 未登记的状态值一律返回 false（当非终态处理）：保守侧的代价只是「多留一会儿」，
// 而漏判终态的代价是「正在排队的任务凭空消失」。
func (st JobStatus) isTerminal() bool {
	switch st {
	case JobQueued, JobRunning:
		return false
	case JobCompleted, JobFailed, JobTimedOut, JobCanceled, JobCompletedWithWarnings:
		return true
	default:
		return false
	}
}

// Job 是一条后台任务的公开快照。字段名与 Python 版 _public_job 对齐。
type Job struct {
	ID            string    `json:"job_id"`
	Status        JobStatus `json:"status"`
	PID           int       `json:"pid"`
	Model         string    `json:"model,omitempty"`
	Agent         string    `json:"agent,omitempty"`
	WorkspacePath string    `json:"workspace_path,omitempty"`
	CreatedAt     string    `json:"created_at"`
	CompletedAt   string    `json:"completed_at,omitempty"`
	ReturnCode    *int      `json:"returncode"`
	Stdout        string    `json:"stdout"`
	Stderr        string    `json:"stderr"`
	// ConversationID 是 agy 的会话 id（--output-format json 的返回里带），
	// 供后续追问用 --conversation 复用，省掉材料重读。
	ConversationID string `json:"conversation_id,omitempty"`
	// OutputPath 是本条 job 完整（未截断）正文的落盘路径（antigravity-mcp 新增，
	// 见 cmd/antigravity-mcp 的落盘设计）。job.Stdout 会被 Finish 按 MaxOutputPerJob
	// 截断、clipJobForDisplay 又会再截一轮给展示预算，这个路径指向截断之前的全文。
	// 由调用方在写完文件后用 SetPaths 补上；骨架本身不写文件、不知道落盘策略。
	OutputPath string `json:"output_path,omitempty"`
	// TranscriptPath 是本条 job 对应 agy 会话转录文件的路径（同上，antigravity-mcp
	// 新增，仅在触发过转录复核时才有值）。
	TranscriptPath string `json:"transcript_path,omitempty"`

	createdAt   time.Time // 内部用，判断 running 是否停太久（CreatedAt 是给外面看的字符串）
	completedAt time.Time // 内部用，淘汰排序的依据
	bytes       int       // 本条 job 占的输出字节数（增量维护总量用）
}

// NewJobStore 建一个有界的 job 表。
func NewJobStore(maxJobs, maxTotalBytes, maxOutputPerJob int, retain time.Duration) *JobStore {
	return &JobStore{
		jobs:            map[string]*Job{},
		MaxJobs:         maxJobs,
		MaxTotalBytes:   maxTotalBytes,
		MaxOutputPerJob: maxOutputPerJob,
		Retain:          retain,
		now:             time.Now,
	}
}

func (s *JobStore) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// Create 登记一条 running 的 job 并返回其 id。
// 表满且无可淘汰者时返回 ErrJobStoreFull（拒绝优于悄悄超限）。
func (s *JobStore) Create(pid int, model, agent, workspace string) (string, error) {
	return s.create(pid, model, agent, workspace, JobRunning)
}

// CreateQueued 登记一条 **JobQueued** 的 job：它已经进了任务表、拿到了 job_id，
// 但还没轮到起跑。返回后调用方可以立刻把 job_id 交给调用方轮询，自己在后台等位次
// ——这就是「排队不占调用方连接」的落点。
//
// 与 Create 共用同一套有界策略（同样会被叫 ErrJobStoreFull 拒绝），差别只有初始状态。
// 排队中的 job **受 isTerminal 保护**，不会被保留期清扫或容量淘汰收走。
func (s *JobStore) CreateQueued(pid int, model, agent, workspace string) (string, error) {
	return s.create(pid, model, agent, workspace, JobQueued)
}

func (s *JobStore) create(pid int, model, agent, workspace string, status JobStatus) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sweepExpiredLocked()
	if s.MaxJobs > 0 {
		for len(s.jobs) >= s.MaxJobs {
			if !s.evictOldestFinishedLocked() {
				return "", ErrJobStoreFull
			}
		}
	}

	id := newJobID()
	now := s.clock()
	s.jobs[id] = &Job{
		ID:            id,
		Status:        status,
		PID:           pid,
		Model:         model,
		Agent:         agent,
		WorkspacePath: workspace,
		CreatedAt:     now.UTC().Format(time.RFC3339),
		createdAt:     now,
	}
	return id, nil
}

// MarkRunning 把一条排队的 job 切成 running，**返回是否切成功**。
//
// ⚠️ **返回 false 的分支当前没有生产可达路径**（2026-09-21 复核 · 三路审核 B′-C 指出，
// 我原注释声称的「RunningTimeout 可能已把它改判」不成立）：
//   - RunningTimeout 的改判只针对 `JobRunning`，而本函数只接受 `JobQueued`；
//   - 保留期清扫与容量淘汰只收 `isTerminal()` 为真的状态，queued 不是终态，收不到它。
//
// 所以「排队的 job 在拿到槽位前变成终态」这件事在现有代码里构造不出来。
//
// 这个分支**保留为防御**（代价是一次状态比较），但它的价值是兜住一条**不变量**：
// 终态不可逆——任何原因让一条 job 不再是 queued，都**不该**被改回 running。
// 之所以值得兜：放行判据是「任务表里有没有 running 的 review job」，
// 把一条已改判的记录重新点亮会凭空多出一个「在跑」的假事实，把下一个 review 挡在
// 队列里。返回 false 时调用方必须**不 spawn**，直接归还槽位、让下一个候选起来。
//
// 顺带把老化计时的起点重置到这一刻：RunningTimeout 量的是「允许停在 running 上多久」，
// 排队等待的时间不该算进去（一个排了两小时的 job 一被放行就会被误判超时）。
func (s *JobStore) MarkRunning(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok := s.jobs[id]
	if !ok || job.Status != JobQueued {
		return false
	}
	now := s.clock()
	job.Status = JobRunning
	job.createdAt = now
	return true
}

// QueueAhead 返回一条排队中的 job「前面还有几个」（同状态、比它先登记的）。
// 第二个返回值为 false 表示**没有这条 job**；非排队状态返回 (0, true)
// （running/终态都不排队，位次无意义，由调用方按状态决定要不要展示）。
//
// 与其余观测方法一致，先做一次惰性清扫再答——否则会把早该消失的记录计进位次，
// 正好在最需要准数的地方给出偏高的读数。
func (s *JobStore) QueueAhead(id string) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.sweepExpiredLocked()
	self, ok := s.jobs[id]
	if !ok {
		return 0, false
	}
	if self.Status != JobQueued {
		return 0, true
	}
	ahead := 0
	for otherID, j := range s.jobs {
		if otherID == id || j.Status != JobQueued {
			continue
		}
		// 与 IDs() 同一口径的全序：CreatedAt 是秒级字符串，同秒创建的两条比不出
		// 先后，必须以 id 做次级键，否则位次在两次轮询之间会无理由地跳。
		if j.CreatedAt < self.CreatedAt ||
			(j.CreatedAt == self.CreatedAt && otherID < id) {
			ahead++
		}
	}
	return ahead, true
}

// Finish 把一条 job 标成终态并落下输出。id 不存在时静默返回
// （job 可能已被淘汰——后台 goroutine 还在跑是正常的，不该因此崩）。
func (s *JobStore) Finish(id string, status JobStatus, returnCode int, stdout, stderr, conversationID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok := s.jobs[id]
	if !ok {
		return
	}
	// 单条先截断，再计入总量：一条巨型输出不能把总预算一口吃光。
	stdout = Clip(stdout, s.MaxOutputPerJob)
	stderr = Clip(stderr, s.MaxOutputPerJob)

	s.bytes -= job.bytes
	job.Status = status
	rc := returnCode
	job.ReturnCode = &rc
	job.Stdout = stdout
	job.Stderr = stderr
	job.ConversationID = conversationID
	job.completedAt = s.clock()
	job.CompletedAt = job.completedAt.UTC().Format(time.RFC3339)
	job.bytes = len(stdout) + len(stderr)
	s.bytes += job.bytes

	s.sweepExpiredLocked()
	s.enforceBytesLocked()
}

// SetPID 给一条已存在的 job 补上子进程 pid。
//
// 为什么需要它：串行闸里 review 任务先以 JobQueued 入表（那一刻**还没有**进程），
// 拿到槽位、spawn 成功之后才拿到 pid。Create 时那个长度为 0 的 pid 参数就是这个
// 时间差的产物。语义与 SetPaths 一致：id 不存在静默返回，pid<=0 不覆盖已有值。
func (s *JobStore) SetPID(id string, pid int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return
	}
	if pid > 0 {
		job.PID = pid
	}
}

// SetPaths 给一条已存在的 job 补上落盘路径（正文全文/转录）。
//
// 为什么不在 Finish 里一起做：落盘是**调用方**（antigravity-mcp）的策略——写去哪个
// 目录、文件名怎么起、要不要写转录路径，骨架（mcpshell）不该替业务决定，也不该因为
// 一次磁盘写入失败就污染 Finish 的语义。调用方的顺序永远是「先 Finish 把结果落表，
// 再 SetPaths 补路径」，两步之间即使进程崩了，job 也已经是完整的终态记录。
//
// id 不存在（job 可能已被淘汰）时静默返回，语义与 Finish 一致：后台收尾晚到是正常的
// 调用序列，不该因此 panic 或报错。空字符串的那一路不覆盖已有值，方便调用方只补
// 其中一个字段而不必先 Get 出旧值。
func (s *JobStore) SetPaths(id, outputPath, transcriptPath string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return
	}
	if outputPath != "" {
		job.OutputPath = outputPath
	}
	if transcriptPath != "" {
		job.TranscriptPath = transcriptPath
	}
}

// Get 返回一条 job 的快照。过期的视作不存在（读到的永远不是过期数据）。
// 第二个返回值为 false 表示「没有这条 job」。
func (s *JobStore) Get(id string) (Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	job, ok := s.jobs[id]
	if !ok {
		return Job{}, false
	}
	snapshot := *job
	// 未落终态的 job 不回传半截输出（Python 版同款：status != running 才给）。
	// 判据用 isTerminal 而不是 `== JobRunning`：排队的 job 同样没有结果可给。
	if !snapshot.Status.isTerminal() {
		snapshot.Stdout, snapshot.Stderr = "", ""
	}
	return snapshot, true
}

// Len 返回当前登记的 job 条数（可观测/测试用）。
// 以下四个观测方法都先清扫一次再答：它们服务的是自检工具（health），
// 而自检要回答的恰恰是「有没有泄漏」。只读时段里不清扫，就会把早该消失的 job
// 计进占用数——正好在最需要准数的地方给出偏高的读数。（PiMoa review 2026-09-19）
func (s *JobStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	return len(s.jobs)
}

// Bytes 返回当前 job 输出占用的字节总数（可观测/测试用）。
func (s *JobStore) Bytes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	return s.bytes
}

// Running 返回当前 running 的条数。
//
// ⚠️ **排队中的 job 不计入**：它没在跑，占了进程槽位的不是它。这条数字被
// antigravity_health 与 status 当「在飞任务数」用，混进排队数会让调用方以为
// 资源已被占用。（2026-09-20 加 JobQueued 时同步收紧了这里。）
func (s *JobStore) Running() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	n := 0
	for _, j := range s.jobs {
		if j.Status == JobRunning {
			n++
		}
	}
	return n
}

// Queued 返回当前**排队中**（JobQueued）的条数，供自检输出「队列有多深」。
// 与 Running 分开报：排队中的任务没在跑，也没占进程槽位。
func (s *JobStore) Queued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	n := 0
	for _, j := range s.jobs {
		if j.Status == JobQueued {
			n++
		}
	}
	return n
}

// sweepExpiredLocked 惰性清扫：删掉所有已完成且超过 Retain 的 job。
func (s *JobStore) sweepExpiredLocked() {
	now := s.clock()

	// 先给停太久的 running 改判。不直接删：轮询方可能正等着这条 job 的结果，
	// 悄悄消失会让它收到「查无此 job」这种没法归因的答复；改判成 timed_out 并
	// 写明原因，既腾出了槽位，又把事实交代清楚。改判后它就是终态，
	// 下面的保留期清扫与容量淘汰都能正常处理它。
	if s.RunningTimeout > 0 {
		stale := now.Add(-s.RunningTimeout)
		for _, j := range s.jobs {
			if j.Status == JobRunning && !j.createdAt.IsZero() && j.createdAt.Before(stale) {
				j.Status = JobTimedOut
				j.completedAt = now
				j.CompletedAt = now.UTC().Format(time.RFC3339)
				before := len(j.Stderr)
				j.Stderr = appendLine(j.Stderr, fmt.Sprintf(
					"job 停在 running 超过 %s 未收尾，已由任务表改判为超时——"+
						"通常意味着收尾的那条路径没走到（进程仍可能在跑，PID %d）。",
					s.RunningTimeout, j.PID))
				// 只记增量：j.bytes 是这条 job 的累计占用，s.bytes 是全局累计，
				// 两边都加全长会把账记重（running 时 Stderr 恒为空，写成全长眼下也对，
				// 但那是巧合不是道理）。
				delta := len(j.Stderr) - before
				j.bytes += delta
				s.bytes += delta
			}
		}
	}

	if s.Retain <= 0 {
		return
	}
	deadline := now.Add(-s.Retain)
	for id, j := range s.jobs {
		// ⚠️ 判据是 isTerminal 而不是 `!= JobRunning`（2026-09-20 加 JobQueued 时改的）：
		// 排队中的 job 还没起跑，按保留期删掉等于「一个还在排队的任务凭空消失」，
		// 调用方轮询到「查无此 job」。见 isTerminal 的注释与 jobs_test.go 的
		// TestJobStoreQueuedIsNotSweptOrEvicted（修复批 #2 · IND-A 更正了这里的旧名
		// TestJobStoreQueuedIsNotSweptByRetain——那个名字的测试并不存在）。
		if j.Status.isTerminal() && j.completedAt.Before(deadline) {
			s.bytes -= j.bytes
			delete(s.jobs, id)
		}
	}
}

func appendLine(s, line string) string {
	if s == "" {
		return line
	}
	return s + "\n" + line
}

// enforceBytesLocked 按字节总量淘汰，直到降到上限之下或无可淘汰者。
func (s *JobStore) enforceBytesLocked() {
	if s.MaxTotalBytes <= 0 {
		return
	}
	for s.bytes > s.MaxTotalBytes {
		if !s.evictOldestFinishedLocked() {
			return // 全在跑：不能淘汰，只能等它们完成后再收
		}
	}
}

// evictOldestFinishedLocked 淘汰「最早完成的已完成 job」，成功返回 true。
// **未落终态的永不淘汰**：running 的还在跑、queued 的还在排队，淘汰了轮询就永远
// 查不到结果（2026-09-20 起判据是 isTerminal，见那里的注释）。
func (s *JobStore) evictOldestFinishedLocked() bool {
	var victim string
	var victimAt time.Time
	for id, j := range s.jobs {
		if !j.Status.isTerminal() {
			continue
		}
		if victim == "" || j.completedAt.Before(victimAt) {
			victim, victimAt = id, j.completedAt
		}
	}
	if victim == "" {
		return false
	}
	s.bytes -= s.jobs[victim].bytes
	delete(s.jobs, victim)
	return true
}

// IDs 返回全部 job id（按创建时间排序），供自检输出。
func (s *JobStore) IDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepExpiredLocked()
	ids := make([]string, 0, len(s.jobs))
	for id := range s.jobs {
		ids = append(ids, id)
	}
	// CreatedAt 是 RFC3339 的**秒级**字符串，同一秒里创建的多条 job 比不出先后，
	// 再配上非稳定的 sort.Slice，自检输出就不可复现、没法跨次比对。
	// 改成以 id 做次级键的全序。（PiMoa review 2026-09-19）
	sort.Slice(ids, func(i, j int) bool {
		a, b := s.jobs[ids[i]], s.jobs[ids[j]]
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return ids[i] < ids[j]
	})
	return ids
}

// newJobID 生成 32 位十六进制 id（与 Python 版 uuid4().hex 同形态）。
func newJobID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败在实践中等同于系统坏了；退回时间戳仍保证唯一性。
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
