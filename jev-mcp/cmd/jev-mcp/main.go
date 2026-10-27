// jev-mcp：TypeSafe Jev（System One 判定模型）的薄 MCP 前门（Go 版，行为对齐 Node 版 server.mjs）。
//
// 与另外三个薄壳的结构差别：**没有子进程**。devkb/claude-dispatch/antigravity 的重活在
// 本机子进程里，jev 的重活在远端 API，所以它用 mcpshell.Outbound 而不是 Runner。
// 共同点是同一条纪律：壳里不留驻任何随调用次数增长的东西。
//
// 必须原样保留的设计纪律（每条都有事故或实测背书）：
//  1. 模型钉死 PINNED_MODEL，禁用 jev-latest 别名——别名静默漂移会让校准阈值失效，
//     而且失效方式是「答案照样给、只是不准了」，没有任何报错。响应里模型号对不上
//     一律在输出顶部报警告。
//  2. state ≤ STATE_TOKEN_BUDGET（官方硬规格是 state+最长问题 ≤32k，且 state 越大
//     准确率越低 = context rot）。超限**直接拒绝**并要求先裁剪，不截断后硬送：
//     截断会悄悄改变判定材料，等于给一个基于残缺证据的高置信答案。
//  3. 每次调用新建连接、用完即关（Node 的 agent:false ↔ Go 的 DisableKeepAlives），
//     不用连接池。牺牲约 100ms 握手换零 socket 累积。
//  4. 429/529 指数退避最多 MAX_RETRIES 次；单请求 90s 超时；输出截断 30000 字符。
//  5. API key **只从 runtime/secrets.env 逐行取 TYPESAFE_API_KEY 这一个变量**，
//     绝不加载或回显其余内容，也绝不出现在任何日志/错误文案/审计记录里。
//  6. 审计直接 append 落盘，绝不在内存里累积数组。
//
// ⚠️ Node 版里那段「会话回收两道闸」（空闲清扫 + 会话数硬上限）**有意不迁移**。
// 那两道闸是 Node SDK 的 StreamableHTTPServerTransport「一实例只绑一个会话」导致的债：
// 服务端被迫自维护 sessionId→transport 表，客户端不发 DELETE 就泄漏（2026-09-18 压测
// 实测 100 个会话累积 4.9MB 堆且强制 GC 不回落），还为这两道闸打过两轮补丁（NaN 忙循环、
// Map 插入序误斩活跃会话）。Go SDK 走 stateless 传输：不校验 Mcp-Session-Id、每请求一个
// 临时会话用完即销毁——**没有会话表，就没有会话泄漏，也就没有什么需要清扫**。
// 不是漏迁移，是整个问题类别不存在。详见 mcpshell 包注释。
//
// 传输：默认 stdio（兼容），JEV_MCP_TRANSPORT=http 起共享单实例（8760）——生产用 http，
// 全机一份，不随 Claude 会话数放大（devkb 8759 同款口径）。
// 信任模型（徐总 2026-08-12 拍板）：本机开发环境，只绑 127.0.0.1，不加鉴权。
// 注意：stdout 是 MCP stdio 传输通道，任何日志只能走 stderr（见 mcpshell.NewLogger）。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/jerryxugit-2026/Build-Agent-Tools-PiMoa/jev-mcp/mcpshell"
)

// ───────────────────────── 官方硬规格（typesafe.ai 文档，2026-09-18 核）─────────────────────────

const (
	// pinnedModel 禁用 jev-latest：别名静默漂移 → 校准阈值失效。
	pinnedModel = "jev-1.13.0"
	apiURL      = "https://api.typesafe.ai/v1/systemone"
	// 官方：单请求 64k token；state + 最长问题 ≤ 32k，且 state 越大准确率越低（context rot）。
	// 留足余量取 24k，用**字符数 /2** 粗估 token（中英混合的保守值）。
	stateTokenBudget = 24_000
)

// ───────────────────────── 资源上限（devkb 同款三件套）─────────────────────────

const (
	// 官方限速 1200 req/min ≈ 20 req/s；8 路在飞足够跑满而不会打爆本机或触发 429 风暴。
	maxInflight    = 8
	requestTimeout = 90 * time.Second
	maxOutputChars = 30_000
	maxRetries     = 3 // 429/529 指数退避次数
	// 响应体读取上限：远端失控时不让它撑爆壳。
	maxResponseBytes = 8 << 20
)

const defaultSecretsEnv = "secrets.env"

func main() {
	logger := mcpshell.NewLogger("jev")

	secretsPath := mcpshell.Env("JEV_MCP_SECRETS_ENV", defaultSecretsEnv)
	srv := &jevServer{
		logger: logger,
		// ⚠️ apiURL 有意**没有** env 覆盖：它决定 API key 发给谁。
		// 一个能改目标地址的 env 旋钮等于「一行配置就能把生产密钥送到任意主机」，
		// 那种便利换不来任何东西（真要换端点就改代码重编）。测试用同包赋值即可。
		apiURL:      apiURL,
		secretsPath: secretsPath,
		// 只取 TYPESAFE_API_KEY 一个键；环境变量优先。
		apiKey:      mcpshell.Secret("TYPESAFE_API_KEY", secretsPath, "TYPESAFE_API_KEY", logger),
		templateDir: mcpshell.Env("JEV_MCP_TEMPLATE_DIR", defaultTemplateDir()),
		auditLog:    mcpshell.Env("JEV_MCP_AUDIT_LOG", "/tmp/jev-mcp-audit.jsonl"),
		gate:        mcpshell.NewGate(maxInflight),
		stats:       mcpshell.NewStats(),
		out:         newOutbound(),
	}
	srv.loadTemplates()
	// key 是否加载要喊出来（缺 key 时每次调用都会失败，启动即知比逐次踩坑好），
	// 但只报「ok / MISSING」——绝不回显任何一段密钥。
	keyState := "MISSING"
	if srv.apiKey != "" {
		keyState = "ok"
	}
	logger.Printf("model=%s  key=%s  模板 %d 个", pinnedModel, keyState, len(srv.templateIDs))

	if err := mcpshell.Serve(mcpshell.Config{
		Name:        "jev",
		Version:     "0.2.0",
		EnvPrefix:   "JEV_MCP",
		DefaultPort: 8760,
		// 层②（传输层 SSE 保活）按壳显式开启：jev_judge 单次出站最长 90s + 退避，今天
		// 撞不到 undici 的 300s 空闲上限，这一项是**保险**（日后调大 requestTimeout 就越线）。
		// 真正的起表点在 jev_judge 的 handler 闭包首行（见 mcpshell/keepalive.go 的起表点纪律）。
		SSEKeepalive: 15 * time.Second,
		Log:          logger,
		Register:     srv.register,
	}); err != nil {
		logger.Printf("退出：%v", err)
		os.Exit(1)
	}
}

func defaultTemplateDir() string {
	// 与 Node 版同位置：<repo>/servers/jev-mcp/templates。Go 二进制在 go-mcp/bin 下，
	// 但默认值按源码树的相对位置给不稳，所以用绝对路径常量式推导：优先 env 覆盖。
	return "templates"
}

func newOutbound() *mcpshell.Outbound {
	o := mcpshell.NewOutbound(requestTimeout, maxRetries)
	// 只有 429（限速）和 529（过载）值得重试；其余状态码重试只是白烧配额。
	o.RetryOn = func(status int) bool { return status == 429 || status == 529 }
	// 与 Node 版逐字一致：2^attempt 秒（1s / 2s / 4s）。
	o.Backoff = func(attempt int) time.Duration { return time.Duration(1<<attempt) * time.Second }
	o.MaxResponseBytes = maxResponseBytes
	return o
}

// ───────────────────────── 服务状态（全部为启动时一次性 + 几个 atomic 计数）─────────────────────────

type jevServer struct {
	logger *log.Logger
	// apiURL 是判定端点。main() 里钉成常量 apiURL，无 env 覆盖（见 main 里的理由）。
	apiURL      string
	secretsPath string
	apiKey      string
	templateDir string
	auditLog    string
	gate        *mcpshell.Gate
	stats       *mcpshell.Stats
	out         *mcpshell.Outbound

	// 模板：启动时一次性加载，大小固定，不随调用增长。加载后只读。
	templates   map[string]json.RawMessage // id → questions 原文（保留客户端/文件里的键序）
	templateIDs []string                   // 排序后的 id，供文案引用

	auditMu sync.Mutex // 只护 append 落盘的串行化，不缓存任何记录
}

// loadTemplates 启动时一次性加载模板。坏模板跳过，不拖垮启动。
func (s *jevServer) loadTemplates() {
	s.templates = map[string]json.RawMessage{}
	entries, err := os.ReadDir(s.templateDir)
	if err != nil {
		if !os.IsNotExist(err) {
			s.logger.Printf("模板目录 %s 读取失败：%v", s.templateDir, err)
		}
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		path := filepath.Join(s.templateDir, name)
		raw, err := os.ReadFile(path)
		if err != nil {
			s.logger.Printf("模板 %s 读取失败，跳过：%v", name, err)
			continue
		}
		var tpl struct {
			ID        string          `json:"id"`
			Questions json.RawMessage `json:"questions"`
		}
		if err := json.Unmarshal(raw, &tpl); err != nil {
			s.logger.Printf("模板 %s 解析失败，跳过：%v", name, err)
			continue
		}
		if len(tpl.Questions) == 0 {
			s.logger.Printf("模板 %s 缺 questions 字段，跳过", name)
			continue
		}
		id := tpl.ID
		if id == "" {
			id = strings.TrimSuffix(name, ".json")
		}
		s.templates[id] = tpl.Questions
		s.templateIDs = append(s.templateIDs, id)
	}
	sort.Strings(s.templateIDs)
}

// ───────────────────────── 工具入参 ─────────────────────────

// state 与 questions 都用 json.RawMessage：**原样转发客户端给的字节**。
// 理由有两条：①state 可以是 string 也可以是 object（Node 版的 z.union），先解成 Go 类型
// 再重新编码会改变形态；②Go 的 map 迭代序是随机的，而 questions/answers 的键序决定了
// 输出顺序——解成 map 再 marshal 会让同一次判定的输出每次排列不同，人没法逐轮比对。
type judgeInput struct {
	State     json.RawMessage `json:"state"`
	Questions json.RawMessage `json:"questions"`
}

type judgeTemplateInput struct {
	State    json.RawMessage `json:"state"`
	Template string          `json:"template" jsonschema:"模板 id（jev_health 列出可用值）"`
}

const stateDesc = "判定材料：已裁剪的代码片段/文档摘录/结构化事实。约 ≤24k token"

const questionsDesc = "问题字典：键=问题 id（自取，回答按同一键返回），值=问题定义。三种原语的真实格式：\n" +
	"  choice：{type:'choice', instructions:'问题正文', criteria:{选项键:'该选项的含义', …}}（选项 ≤255 个）\n" +
	"  noul：{type:'noul', instructions:'命题正文', criteria:{true:'成立的含义', false:'不成立的含义'}} → 返回 P(成立)\n" +
	"  score：{type:'score', instructions:'评什么', criteria:{…}} → 返回 0~1 的分\n" +
	"★选项集必须闭合且互斥：它只在给定选项里选，不会说「都不对」。"

// stringOrObject 把 state 收敛成 anyOf[string, object]（Node 版是 z.union([z.string(), z.record(z.any())])）。
//
// ⚠️ 不能写成 `Types = []string{"string","object"}`（2026-09-30 RCA：
// <workspace>/artifacts/mimo-toolcall-args-rca-20260930/REPORT.md）：小米 MiMo 服务端
// 流式 tool parser 遇到数组形 type 只下发 `{"state": ` 就中断，生产 jev_judge 在 MiMo 上 35/35 丢参；
// anyOf 实测参数完整。接受集不变：string / object 收，null / array / number / bool 拒。
// 同时清掉 json.RawMessage（=[]byte）推出的 `items:{integer 0..255}` 与 `["null","array"]` 残留——
// 原 schema 不收 array，items 本就不生效，清掉不改变接受集。
func stringOrObject(s *jsonschema.Schema, desc string) {
	s.Type = ""
	s.Types = nil
	s.Items = nil
	s.AnyOf = []*jsonschema.Schema{{Type: "string"}, {Type: "object"}}
	s.Description = desc
}

// singleObject 把 questions 收敛成单一 `type:"object"`（原写法 `Types=["object"]` 同样会被
// MiMo 截断，语义与单一 type 完全相同）。
func singleObject(s *jsonschema.Schema, desc string) {
	s.Types = nil
	s.Items = nil
	s.Type = "object"
	s.Description = desc
}

func judgeSchema() *jsonschema.Schema {
	return mcpshell.MustSchema[judgeInput](func(props map[string]*jsonschema.Schema) {
		stringOrObject(props["state"], stateDesc)
		singleObject(props["questions"], questionsDesc)
	})
}

func judgeTemplateSchema() *jsonschema.Schema {
	return mcpshell.MustSchema[judgeTemplateInput](func(props map[string]*jsonschema.Schema) {
		stringOrObject(props["state"], "判定材料，约 ≤24k token")
		props["template"].MinLength = mcpshell.Ptr(1)
	})
}

// ───────────────────────── 工具注册 ─────────────────────────

// progressMessage 是层①（progress 心跳）发给客户端的人类可读文案。
// 只在客户端给了 `_meta.progressToken` 时才会被调用（见 mcpshell.StartProgressHeartbeat）。
func progressMessage(elapsed time.Duration) string {
	return fmt.Sprintf("jev 判定进行中…已用 %s", elapsed.Truncate(time.Second))
}

func (s *jevServer) register(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:  "jev_judge",
		Title: "Jev 闭集判定（带校准概率）",
		Description: "把已裁剪好的材料（state）与闭集问题（questions）交给 TypeSafe Jev 判定模型，" +
			"返回类型安全的判定 + 校准概率。它不生成文本，只在给定选项里选。" +
			"★材料必须由调用方预先裁剪：state 上限约 24k token，越大越不准。" +
			"★弱项：日期先后、计数、多跳推理、结构不变量——这些须走机械路径，不要交给它。" +
			"★不支持图像：喂图像内容不会报错，会照样给出看似合理的假答案和高置信度。",
		InputSchema: judgeSchema(),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in judgeInput) (*mcp.CallToolResult, any, error) {
		// ★ 长响应保活两层：起表点**必须扣在本闭包第一行**，消费 HTTP 栈送进来的最外层 ctx。
		// 严禁下沉进 s.callJev / 任何 context.WithTimeout 派生的子 ctx 或子 goroutine——
		// StartKeepalive 取不到 writer 时 fail-open 静默返回空函数，一旦下沉保活就无声失效
		// （无日志、无编译告警）。详见 mcpshell/keepalive.go 的「起表点纪律」。
		// 两行的 LIFO 收尾顺序：先停层① 心跳，再停层② 并等它的 ticker 退出。
		defer mcpshell.StartKeepalive(ctx)()                               // 层②：传输层 SSE 保活
		defer mcpshell.StartProgressHeartbeat(ctx, req, progressMessage)() // 层①：progress 心跳（无 token 时空函数）
		// 走 RawArgOr 而不是直接用 in.State/in.Questions：go-sdk 会把 arguments
		// 过一遍 map[string]any 再 re-marshal，键序被排成字母序。问题顺序变了就等于
		// 换了问法，而本壳存在的理由就是同类判断问法恒定（详见 mcpshell.RawArg）。
		state := mcpshell.RawArgOr(req, "state", in.State)
		questions := mcpshell.RawArgOr(req, "questions", in.Questions)
		text, isErr := s.callJev(ctx, state, questions)
		return mcpshell.TextResult(text, isErr), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:  "jev_judge_with_template",
		Title: "Jev 判定（复用已备问题模板）",
		Description: "同 jev_judge，但 questions 取自启动时加载的模板，保证同类判断每次问法完全一致——" +
			"问法一变，校准概率就不可跨轮比较。模板目录见 jev_health 返回。",
		InputSchema: judgeTemplateSchema(),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in judgeTemplateInput) (*mcp.CallToolResult, any, error) {
		questions, ok := s.templates[in.Template]
		if !ok {
			avail := strings.Join(s.templateIDs, ", ")
			if avail == "" {
				avail = "(无)"
			}
			return mcpshell.TextResult(
				fmt.Sprintf("未知模板 %s。可用：%s", in.Template, avail), true), nil, nil
		}
		// questions 来自模板文件（键序本就保真），只有 state 需要绕开 SDK 的 re-marshal。
		text, isErr := s.callJev(ctx, mcpshell.RawArgOr(req, "state", in.State), questions)
		return mcpshell.TextResult(text, isErr), nil, nil
	})

	mcpshell.AddHealthTool(server, mcpshell.HealthOptions{
		Name:  "jev_health",
		Title: "自检：进程内存、已服务请求数、钉死的模型版本",
		Description: "返回本 MCP 进程的实时内存与累计请求数——用来验证「调用一次占一次内存」没有发生。" +
			"反复调用判定工具后再看 Go 堆活对象与 goroutine 数，持续爬升即为泄漏。",
		Gate:  s.gate,
		Stats: s.stats,
		Extra: func() []string {
			tpl := fmt.Sprintf("模板：%d 个", len(s.templateIDs))
			if len(s.templateIDs) > 0 {
				tpl += "（" + strings.Join(s.templateIDs, ", ") + "）"
			}
			key := "缺失"
			if s.apiKey != "" {
				key = "已加载"
			}
			return []string{
				fmt.Sprintf("钉死模型：%s（禁用 jev-latest 别名）", pinnedModel),
				tpl + "，目录 " + s.templateDir,
				// 只报状态不报值：密钥绝不进任何输出。
				fmt.Sprintf("API key：%s；审计落盘 %s", key, s.auditLog),
			}
		},
	})
}

// ───────────────────────── 判定主流程 ─────────────────────────

// callJev：入参硬校验 → 熔断 → 发请求（带退避重试）→ 审计 → 渲染。
// 返回 (正文, isError)。
func (s *jevServer) callJev(ctx context.Context, state, questions json.RawMessage) (string, bool) {
	if !s.gate.TryAcquire() {
		return fmt.Sprintf("jev 在飞请求已达上限 %d，请稍后重试。", s.gate.Max()), true
	}
	defer s.gate.Release()

	if s.apiKey == "" {
		return fmt.Sprintf("未取得 TYPESAFE_API_KEY（已查环境变量与 %s）。", s.secretsPath), true
	}
	if len(state) == 0 {
		return "缺 state：判定材料不能为空。", true
	}
	if len(questions) == 0 {
		return "缺 questions：至少要给一个问题。", true
	}

	// state 体积闸。**拒绝而不截断**：截断等于悄悄换掉判定材料，
	// 换来一个基于残缺证据的高置信答案——比报错危险得多。
	approxTokens, err := approxStateTokens(state)
	if err != nil {
		return fmt.Sprintf("state 不是合法 JSON（string 或 object）：%v", err), true
	}
	if approxTokens > stateTokenBudget {
		return fmt.Sprintf(
			"state 约 %d token，超过 %d 上限（官方 state+最长问题 ≤32k，"+
				"且 state 越大准确率越低）。请先由子代理裁剪出关键片段再送判。",
			approxTokens, stateTokenBudget), true
	}

	// 请求体字段序与 Node 版一致（model, state, questions），两边可逐字比对。
	body, err := buildRequestBody(state, questions)
	if err != nil {
		return fmt.Sprintf("组装请求体失败：%v", err), true
	}
	questionKeys := objectKeys(questions)

	t0 := time.Now()
	resp, err := s.out.PostJSON(ctx, s.apiURL, body, map[string]string{
		"Authorization": "Bearer " + s.apiKey,
		"Content-Type":  "application/json",
	})
	if err != nil {
		s.stats.MarkFailed()
		reason := err.Error()
		if mcpshell.IsCanceled(err) {
			reason = "客户端取消或超时（" + reason + "）"
		}
		s.audit(auditRecord{Model: pinnedModel, Questions: questionKeys, Error: reason})
		return mcpshell.Clip("Jev 调用失败："+reason, maxOutputChars), true
	}
	if resp.Status != 200 {
		s.stats.MarkFailed()
		// 只截前 800 字符（Node 版同口径）：远端的错误体可能很长。
		detail := fmt.Sprintf("HTTP %d: %s", resp.Status, clipRunes(resp.Body, 800))
		s.audit(auditRecord{Model: pinnedModel, Questions: questionKeys, Error: detail})
		// 不同状态码对 agent 意味着完全不同的下一步，压成同一句话等于让它没法决策。
		// （PiMoa review 2026-09-19）
		return mcpshell.Clip("Jev 调用失败："+detail+"\n"+advice(resp.Status), maxOutputChars), true
	}

	rendered, inputTokens, answered, perr := render(resp.Body)
	if perr != nil {
		s.stats.MarkFailed()
		detail := fmt.Sprintf("Jev 响应无法解析：%v\n原文前 500 字符：%s",
			perr, clipRunes(resp.Body, 500))
		s.audit(auditRecord{Model: pinnedModel, Questions: questionKeys, Error: detail})
		return mcpshell.Clip(detail, maxOutputChars), true
	}
	// 问出去几道、答回来几道，必须对上。对不上时**必须标错**（PiMoa review 2026-09-19）：
	// 原来这里无条件返回 isError=false 并 MarkServed，于是「HTTP 200 但漏答/没有
	// answers」会以一次成功的工具调用回给 agent，那道题就在输出里静默消失——
	// agent 拿不到它，也不知道自己没拿到。这正是最贵的那类失败：不报错，只是错。
	if missing := missingKeys(questionKeys, answered); len(missing) > 0 {
		s.stats.MarkFailed()
		head := fmt.Sprintf(
			"[答案不完整] 问了 %d 题，只答回 %d 题，缺：%s。缺的那几题不要当作「判定为否」——"+
				"它们根本没被判定。请重试，或把问题拆小后再问。\n\n",
			len(questionKeys), len(answered), strings.Join(missing, "、"))
		s.audit(auditRecord{
			Model: pinnedModel, Questions: questionKeys,
			Error: fmt.Sprintf("答案不完整：缺 %s", strings.Join(missing, "、")),
		})
		return mcpshell.Clip(head+rendered, maxOutputChars), true
	}
	s.stats.MarkServed()
	s.audit(auditRecord{
		Model:             pinnedModel,
		Questions:         questionKeys,
		StateTokensApprox: approxTokens,
		LatencyMS:         time.Since(t0).Milliseconds(),
		InputTokens:       inputTokens,
		Attempt:           resp.Attempts - 1, // Node 记的是 0 起的 attempt 序号
	})
	return mcpshell.Clip(rendered, maxOutputChars), false
}

// buildRequestBody 组 {model, state, questions}，原样嵌入客户端给的两段 JSON。
// 用手工拼接而不是 struct+Marshal 的唯一理由：json.Marshal 会对 RawMessage 做 compact
// 但不保证不改动，手工拼接则 100% 保住字节与键序，便于与 Node 版逐字比对。
func buildRequestBody(state, questions json.RawMessage) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(`{"model":`)
	modelJSON, err := json.Marshal(pinnedModel)
	if err != nil {
		return nil, err
	}
	buf.Write(modelJSON)
	buf.WriteString(`,"state":`)
	if err := json.Compact(&buf, state); err != nil {
		return nil, fmt.Errorf("state 不是合法 JSON: %w", err)
	}
	buf.WriteString(`,"questions":`)
	if err := json.Compact(&buf, questions); err != nil {
		return nil, fmt.Errorf("questions 不是合法 JSON: %w", err)
	}
	buf.WriteString(`}`)
	return buf.Bytes(), nil
}

// approxStateTokens 复刻 Node 的 `Math.ceil(stateText.length / 2)`。
//
// ⚠️ 两处容易迁错、且错了以后只会「悄悄放宽或收紧闸门」：
//  1. state 是 JSON 字符串时，Node 用的是**解码后**的原文（不含外层引号与转义），
//     不是 JSON 字面量；是 object 时用 JSON.stringify 的紧凑形式。
//  2. JS 的 String.length 是 **UTF-16 码元数**，不是字节数也不是 rune 数。
//     中文一字 = 1 码元但 3 字节：按字节算等于把闸门收到三分之一（好材料被误拒），
//     按 rune 算则 emoji 一类代理对会少算一半。这里按 UTF-16 码元算，与 JS 逐字一致。
func approxStateTokens(state json.RawMessage) (int, error) {
	trimmed := bytes.TrimSpace(state)
	// 空 state 与 null 都当作「没给材料」直接挡掉：它们会落进下面的 Compact 分支、
	// 被估成两三个 token 一路放行，白花一次远端调用换一个基于空材料的判定。
	// 而基于空材料的判定同样会带着高置信度回来。（PiMoa review 2026-09-19）
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return 0, fmt.Errorf("state 为空（收到 %q）——没有材料就没有可判定的东西",
			string(trimmed))
	}
	var text string
	if trimmed[0] == '"' {
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return 0, err
		}
	} else {
		var buf bytes.Buffer
		if err := json.Compact(&buf, trimmed); err != nil {
			return 0, err
		}
		text = buf.String()
	}
	// 解码后为空同样要挡：`""` 是合法 JSON、估出来 0 token、一路通过预算检查，
	// 但它和 null 一样是「没给材料」。空材料的判定照样会带着高置信度回来。
	if strings.TrimSpace(text) == "" {
		return 0, fmt.Errorf("state 解出来是空的（收到 %q）——没有材料就没有可判定的东西",
			clipRunes(string(trimmed), 80))
	}
	units := len(utf16.Encode([]rune(text)))
	return (units + 1) / 2, nil // ceil(units/2)
}

// ───────────────────────── 响应渲染 ─────────────────────────

// render 渲染三种原语的响应。真实响应形状（2026-09-18 实测）：
//
//	{model, answers:{key:{type:"choice", choice, confidence, probabilities}}, usage:{input_tokens}}
//
// noul 的概率**直接在 answers[k].noul**（P(命题为真)），没有独立 probability 字段。
// 末尾附固定判读提示（常量，不随调用增长）。
//
// 键序按响应文档序遍历（不是 Go map 的随机序）：同一次判定的输出必须可跨轮逐行比对，
// 键序一乱，人和 diff 工具都用不了。
// render 把响应渲染成给 agent 看的正文，并把**实际答到的问题键**一并回传。
// 回传键是为了让调用方核对「问出去几道、答回来几道」——少答一道在原来的写法里
// 会静默消失，而这个壳的全部价值就是判定结果可信。（PiMoa review 2026-09-19）
//
// 波1（A1/A2）：正文末尾**只追加**结构化回包块（"\n## structured\n" + jev-out/2 JSON，
// 见下方「结构化回包块」一节）。上面渲染出的正文是冻结文法，一字不动。
func render(raw string) (string, int64, []string, error) {
	var top struct {
		Model   string          `json:"model"`
		Answers json.RawMessage `json:"answers"`
		Usage   struct {
			InputTokens int64 `json:"input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(raw), &top); err != nil {
		return "", 0, nil, fmt.Errorf("不是合法 JSON：%w", err)
	}

	var lines []string
	// 模型号不符 → 顶部警告。阈值是按特定模型校准的，别名/版本一变就不可复用。
	// ⚠️ 这里**有意**对「响应里没有 model 字段」放行，不要改成一并告警。
	//
	// PiMoa review 2026-09-19 提过一条 MINOR：说 `top.Model != ""` 的短路等于
	// 「远端只要不回 model 就自动关掉漂移检测」。这条听着有理，但按它改会更糟——
	// 查证结果：Node 版（生产在跑的那版）**根本不检查响应里的 model**，它只在请求体里
	// 钉死模型号，审计记的也是请求值；也就是说我们没有任何证据表明该 API 会回这个字段。
	// 如果它本来就不回，「缺失即告警」会让**每一次**响应都挂一条假警告，很快把这条警告
	// 训练成噪声，真正漂移的那次反而没人看。
	//
	// 所以这个响应侧校验的定位是**捡便宜**：远端愿意回就核一下，不回就算了。
	// 真正防漂移的是请求侧的编译期常量（入参 schema 里没有 model 字段，agent 无从注入）。
	// 要把它升级成硬校验，得先拿一次真实响应确认该字段确实存在——那是个事实问题，
	// 不是判断问题，没有那个事实之前不要动这里。
	if top.Model != "" && top.Model != pinnedModel {
		lines = append(lines,
			fmt.Sprintf("[警告] 服务端返回的模型是 %s，与钉死的 %s 不符——阈值可能已失效。", top.Model, pinnedModel),
			"")
	}

	// ⚠️ 这个 err 以前被 `_` 丢掉了：answers 不是对象、键不是字符串这类畸形响应，
	// 会安静地渲染成「没有 answers」然后被当作一次**成功**回给 agent。
	// （PiMoa review 2026-09-19）
	fields, ferr := orderedFields(top.Answers)
	if ferr != nil {
		return "", top.Usage.InputTokens, nil,
			fmt.Errorf("answers 结构异常：%w（原文前 500 字符：%s）", ferr, clipRunes(raw, 500))
	}
	answered := make([]string, 0, len(fields))
	for _, f := range fields {
		lines = append(lines, renderAnswer(f.Key, f.Value))
		answered = append(answered, f.Key)
	}
	if len(fields) == 0 {
		lines = append(lines, fmt.Sprintf("[异常] 响应里没有 answers：%s", clipRunes(raw, 500)))
	}
	if top.Usage.InputTokens != 0 {
		lines = append(lines, "", fmt.Sprintf("[用量] 输入 %d token", top.Usage.InputTokens))
	}
	lines = append(lines,
		"",
		"[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。",
		"choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），",
		"两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。",
		// 图像这条必须出现在 agent 看得见的地方，不能只写在代码注释里：它的失败方式是
		// **静默给出看似合理的假答案**（不报错、不降置信度），没有任何监控能发现。
		// （PiMoa review 2026-09-19 指出纪律要求进 agent 可见面而实现没做。）
		"⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。",
		"任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。")
	// A1/A2：正文之后只追加结构化块。旧消费侧（按【key】刮 `P(成立)=` 的文本解析）
	// 零感知；新消费侧按 structuredSep 切块、structured 优先解析，失败再回退文本刮取。
	return strings.Join(lines, "\n") + structuredSep + buildStructured(fields, top.Usage.InputTokens),
		top.Usage.InputTokens, answered, nil
}

func renderAnswer(key string, raw json.RawMessage) string {
	var ans struct {
		Type       string          `json:"type"`
		Choice     string          `json:"choice"`
		Confidence *float64        `json:"confidence"`
		Probs      json.RawMessage `json:"probabilities"`
		Noul       *float64        `json:"noul"`
		Score      *float64        `json:"score"`
	}
	if err := json.Unmarshal(raw, &ans); err != nil {
		return fmt.Sprintf("【%s】%s", key, string(raw))
	}
	conf := ""
	if ans.Confidence != nil {
		conf = fmt.Sprintf("  置信度 %s", fixed3(*ans.Confidence))
	}
	switch ans.Type {
	case "choice":
		line := fmt.Sprintf("【%s】选项 → %s%s", key, ans.Choice, conf)
		if dist := renderProbs(ans.Probs); dist != "" {
			line += "\n  分布：" + dist
		}
		return line
	case "noul":
		// noul 的概率就在 .noul 字段上（没有独立 probability 字段）。
		// noul 缺失时不能拿零值当判定：那会渲染成「不成立（P=0.000）」这种
		// 看起来斩钉截铁、实际毫无依据的结论——正是最贵的那类错误。
		// （PiMoa review 2026-09-19；同函数里 Confidence 本来就有 nil 保护，这里漏了。）
		if ans.Noul == nil {
			return fmt.Sprintf("【%s】命题 → [异常] 响应里没有 noul 概率，无法判定（原始：%s）",
				key, clipRunes(string(raw), 200))
		}
		p := *ans.Noul
		verdict := "不成立"
		if p >= 0.5 {
			verdict = "成立"
		}
		return fmt.Sprintf("【%s】命题 → %s（P(成立)=%s）", key, verdict, fixed3(p))
	case "score":
		v := 0.0
		if ans.Score != nil {
			v = *ans.Score
		}
		return fmt.Sprintf("【%s】评分 → %s%s", key, fixed3(v), conf)
	default:
		return fmt.Sprintf("【%s】%s", key, string(raw))
	}
}

// renderProbs 把概率分布按**值降序**排出来；同值时保持响应里的原始键序
// （Node 的 Array.sort 是稳定排序，这里用 SliceStable 对齐）。
func renderProbs(raw json.RawMessage) string {
	fields, err := orderedFields(raw)
	if err != nil || len(fields) == 0 {
		return ""
	}
	type kv struct {
		k string
		v float64
	}
	items := make([]kv, 0, len(fields))
	for _, f := range fields {
		var v float64
		if err := json.Unmarshal(f.Value, &v); err != nil {
			// 非数字的值按 0 排（Node 的 Number(非数) = NaN，比较恒 false 等于留在原位；
			// 这里按 0 处理更可预测，并且这条分支在真实响应里不出现）。
			v = 0
		}
		items = append(items, kv{f.Key, v})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].v > items[j].v })
	parts := make([]string, 0, len(items))
	for _, it := range items {
		parts = append(parts, it.k+"="+fixed3(it.v))
	}
	return strings.Join(parts, "  ")
}

// fixed3 对应 JS 的 Number.toFixed(3)。
func fixed3(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

// ───────────────────────── 结构化回包块（jev-out/2）─────────────────────────

// structuredGrammar 是结构化回包块的文法版本戳（A2）：块的字段形状或语义一变就换版本号，
// 消费侧据此选解析器与阈值口径。正文文法（【key】→… 那套）另行冻结，两者分开版本化。
const structuredGrammar = "jev-out/2"

// structuredSep 是正文与结构化块之间的固定分隔，消费侧按它切块。
// 块恒在**末尾**：正文（含判读提示尾块）一字不动，只做追加。
const structuredSep = "\n## structured\n"

// buildStructured 编码结构化块 JSON：{grammar, answers:{key:{kind, choice?, p, dist?}}, usage?}。
// answers 按**响应文档序**逐条编码（不是 Go map 的随机序）——与正文同一理由：
// 键序一乱，人和 diff 工具都用不了，同一次判定就没法跨轮逐行比对。
//
// usage 与正文的 [用量] 行**同在同缺**（FB-7）：远端没报 usage/input_tokens（解析值为 0，
// 与正文侧 `!= 0` 同判据）就省略整个 usage 键，绝不写 input_tokens:0 冒充实测值——
// 与 structuredAnswer「数据缺失就省略字段，绝不补零值」是同一条纪律（:686-688）。
func buildStructured(fields []field, inputTokens int64) string {
	var buf bytes.Buffer
	buf.WriteString(`{"grammar":` + jsonQuote(structuredGrammar) + `,"answers":{`)
	for i, f := range fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(jsonQuote(f.Key) + ":" + structuredAnswer(f.Value))
	}
	buf.WriteByte('}')
	if inputTokens != 0 {
		buf.WriteString(`,"usage":{"input_tokens":` + strconv.FormatInt(inputTokens, 10) + `}`)
	}
	buf.WriteByte('}')
	return buf.String()
}

// structuredAnswer 编码单条答案 {kind, choice?, p, dist?}。
//
// 纪律：**数据缺失就省略字段，绝不补零值**——noul 缺概率补 0 会编码成斩钉截铁的
// 「P(成立)=0」，与 renderAnswer 里 noul 缺失不渲染成 P=0.000 是同一条防线
// （PiMoa review 2026-09-19）。
//
// p 的口径按 kind 分派（与正文的 fixed3 显示不同，这里给原始数值给机器用）：
// noul=P(命题成立)（证伪阈值直接比它）、score=分值、choice=选定选项在 dist 里的概率，
// dist 取不到（或不是合法 JSON number，FB-6）时退 confidence，两者都不可用就省略 p；
// 其余 kind（含 unknown）=confidence。
//
// p 写入前一律过 jsonNumberString 校验：非 JSON number（null/字符串/对象/1e400 溢出）
// 不算数，回退或省略，**绝不补零**（FB-6）。
//
// choice 为空串时 p 与 choice **同在同缺**（FB-8）：「kind:choice 无选项有概率」是悬空
// 条目——那个概率属于谁说不清，宁可省略。
//
// kind 缺失（type 没给/不是字符串）但字段可判时**推断**：有概率值（.noul）→ noul、
// 有 score → score、有 choice → choice；推不出才 unknown，unknown 也保留 confidence——
// 不得静默丢已有数据（FB-9）。
func structuredAnswer(raw json.RawMessage) string {
	fields, err := orderedFields(raw)
	if err != nil {
		// 连 JSON 对象都不是：只报存在性（键仍与正文一一对应），原文正文侧已原样展示。
		return `{"kind":"unknown"}`
	}
	at := func(key string) json.RawMessage {
		for _, f := range fields {
			if f.Key == key {
				return f.Value
			}
		}
		return nil
	}
	probs := at("probabilities")
	choice, _ := jsonString(at("choice"))
	kind, _ := jsonString(at("type"))
	if kind == "" {
		// FB-9：type 缺失但字段可判时推断 kind，别把已有数据静默丢掉。
		// 「可判」= 有**可用数值**（过得了 jsonNumberString），不是光看字段在不在——
		// score:"high" 这种垃圾值若被推成 kind=score，p 写不出、同行的 confidence 也丢了
		// （PiMoa verify 2026-09-22 确认的 MINOR）。推不出才 unknown，unknown 保留 confidence。
		_, noulNum := jsonNumberString(at("noul"))
		_, scoreNum := jsonNumberString(at("score"))
		switch {
		case noulNum:
			kind = "noul"
		case scoreNum:
			kind = "score"
		case choice != "":
			kind = "choice"
		default:
			kind = "unknown"
		}
	}
	var b strings.Builder
	b.WriteString(`{"kind":` + jsonQuote(kind))
	if kind == "choice" && choice != "" {
		b.WriteString(`,"choice":` + jsonQuote(choice))
	}
	switch kind {
	case "noul":
		if s, ok := jsonNumberString(at("noul")); ok {
			b.WriteString(`,"p":` + s)
		}
	case "score":
		if s, ok := jsonNumberString(at("score")); ok {
			b.WriteString(`,"p":` + s)
		}
	case "choice":
		// FB-8：choice 为空 → 连 p 也不写（与 choice 同在同缺）。
		if choice != "" {
			// FB-6：dist 里那个值先解析到 float64 校验，非 JSON number ⇒ 回退 confidence；
			// 两者都不可用 ⇒ 省略 p。
			if s, ok := jsonNumberString(distValue(probs, choice)); ok {
				b.WriteString(`,"p":` + s)
			} else if s, ok := jsonNumberString(at("confidence")); ok {
				b.WriteString(`,"p":` + s)
			}
		}
	default:
		// unknown 与其它未识别 kind：保留 confidence（FB-9「不得静默丢已有数据」）。
		if s, ok := jsonNumberString(at("confidence")); ok {
			b.WriteString(`,"p":` + s)
		}
	}
	if dist := structuredDist(probs); dist != "" {
		b.WriteString(`,"dist":` + dist)
	}
	b.WriteByte('}')
	return b.String()
}

// structuredDist 把概率分布按**响应文档序**原样搬进结构化块（值不改写、不重排——
// 文本侧的降序展示是给人看的，机器侧要保真）。没有分布或不是对象时返回空串=省略该字段。
func structuredDist(raw json.RawMessage) string {
	fields, err := orderedFields(raw)
	if err != nil || len(fields) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonQuote(f.Key) + ":" + string(f.Value))
	}
	b.WriteByte('}')
	return b.String()
}

// distValue 取分布里某个选项的**原始 JSON 值**。值是不是合法数值（FB-6）由调用方
// jsonNumberString 校验——这里只负责按 key 找到那一条，找到 ≠ 可用。
func distValue(raw json.RawMessage, key string) json.RawMessage {
	fields, err := orderedFields(raw)
	if err != nil {
		return nil
	}
	for _, f := range fields {
		if f.Key == key {
			return f.Value
		}
	}
	return nil
}

// jsonQuote 编码 JSON 字符串字面量（键名/选项名）。字符串在 encoding/json 里恒可编码；
// 真失败退 strconv.Quote——对本块出现的内容两者产物一致，绝不产出非法 JSON。
func jsonQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return strconv.Quote(s)
	}
	return string(b)
}

// jsonNum 编码 JSON 数值。入参都来自已解析的 JSON（不可能是 NaN/Inf）；
// 真编码失败就返回 ok=false、调用方省略字段——绝不补零值。
func jsonNum(v float64) (string, bool) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// jsonString 只认 JSON 字符串；number/对象/null 一律当「没给」——类型漂移不该把
// 整条答案打成 unknown（FB-9「不得静默丢已有数据」）。
func jsonString(raw json.RawMessage) (string, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// jsonNumberString 校验原始 JSON 是**合法 JSON number**（含 1e400 这类溢出伪数），
// 是就返回可直接写进块里的数值字面量，否则 ok=false（FB-6）：
// null/字符串/对象/true/溢出一律不算数——调用方回退 confidence 或省略字段，绝不补零。
func jsonNumberString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", false
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return "", false
	}
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return "", false
	}
	return jsonNum(v)
}

// ───────────────────────── 有序 JSON 对象遍历 ─────────────────────────

type field struct {
	Key   string
	Value json.RawMessage
}

// orderedFields 按**文档序**取一个 JSON 对象的键值对。
// Go 的 map[string]json.RawMessage 会把键序打乱，而 answers/probabilities 的键序
// 决定了输出顺序——必须自己走 token 流。
// advice 把 HTTP 状态码翻成一句「下一步该干什么」。
// 分类依据是「这次失败是谁的问题、等一等会不会好」——agent 要的是这个，不是状态码本身。
func advice(status int) string {
	switch {
	case status == 401 || status == 403:
		return "→ 凭据问题（key 失效/无权限）。重试没用，请检查 TYPESAFE_API_KEY，" +
			"改完要重启本服务才会重新读取。"
	case status == 429:
		return "→ 触发限流或配额耗尽。已按退避重试过仍失败，说明短期内不会恢复；" +
			"降低并发或改日再试，不要立刻重发。"
	case status == 400 || status == 422:
		return "→ 请求被判为不合法（多半是 state 或 questions 的形状问题）。" +
			"重试无用，先按上面的响应正文改请求。"
	case status >= 500:
		return "→ 远端服务端故障。与本次请求内容无关，稍后重试即可。"
	default:
		return "→ 未归类的状态码，请按上面的响应正文判断。"
	}
}

// missingKeys 返回 want 里没出现在 got 里的键，保持 want 的原序。
// 用集合比对而不是只比数量：数量相等但键对不上（远端答了别的题）同样是事故，
// 而且那种情形下光看数量会完全看不出来。
func missingKeys(want, got []string) []string {
	if len(want) == 0 {
		return nil
	}
	have := make(map[string]struct{}, len(got))
	for _, k := range got {
		have[k] = struct{}{}
	}
	var missing []string
	for _, k := range want {
		if _, ok := have[k]; !ok {
			missing = append(missing, k)
		}
	}
	return missing
}

func orderedFields(raw json.RawMessage) ([]field, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("不是 JSON 对象")
	}
	var out []field
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("对象键不是字符串")
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, err
		}
		out = append(out, field{Key: key, Value: val})
	}
	return out, nil
}

// objectKeys 取对象的键名（文档序），只用于审计记录。
func objectKeys(raw json.RawMessage) []string {
	fields, err := orderedFields(raw)
	if err != nil {
		return nil
	}
	keys := make([]string, 0, len(fields))
	for _, f := range fields {
		keys = append(keys, f.Key)
	}
	return keys
}

// clipRunes 按 rune 截断且**不加尾注**（用于嵌进更大的文案里）。
func clipRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// ───────────────────────── 审计 ─────────────────────────

// auditRecord 的字段名与 Node 版逐字一致，两边的 jsonl 可以合并分析。
// ⚠️ 这里**永远不记** state/questions 正文与 API key：审计文件是明文落盘的。
type auditRecord struct {
	TS                string   `json:"ts"`
	Model             string   `json:"model"`
	Questions         []string `json:"questions"`
	StateTokensApprox int      `json:"state_tokens_approx,omitempty"`
	LatencyMS         int64    `json:"latency_ms,omitempty"`
	InputTokens       int64    `json:"input_tokens,omitempty"`
	Attempt           int      `json:"attempt,omitempty"`
	Error             string   `json:"error,omitempty"`
}

// audit 直接 append 落盘，绝不在内存里累积数组。写失败不影响判定结果。
func (s *jevServer) audit(rec auditRecord) {
	rec.TS = time.Now().UTC().Format(time.RFC3339Nano)
	line, err := json.Marshal(rec)
	if err != nil {
		return
	}
	s.auditMu.Lock()
	defer s.auditMu.Unlock()
	f, err := os.OpenFile(s.auditLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return // 审计不可用不应阻断判定
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}
