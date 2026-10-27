package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jerryxugit-2026/Build-Agent-Tools-PiMoa/jev-mcp/mcpshell"
)

// ───────────── 模型钉死：响应模型号不符必须在顶部报警告 ─────────────
// 这是本壳最重要的一条不变量：别名漂移不会报错，只会让校准阈值悄悄失效。

func TestRenderWarnsOnModelMismatch(t *testing.T) {
	raw := `{"model":"jev-latest","answers":{"q1":{"type":"noul","noul":0.91}},"usage":{"input_tokens":1234}}`
	text, tokens, _, err := render(raw)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	first := strings.SplitN(text, "\n", 2)[0]
	if !strings.HasPrefix(first, "[警告]") {
		t.Fatalf("模型号不符没在**顶部**报警告，首行是：%q", first)
	}
	for _, want := range []string{"jev-latest", pinnedModel, "阈值可能已失效"} {
		if !strings.Contains(first, want) {
			t.Errorf("警告文案缺 %q：%s", want, first)
		}
	}
	if tokens != 1234 {
		t.Errorf("input_tokens=%d, want 1234", tokens)
	}
}

func TestRenderNoWarningWhenModelMatches(t *testing.T) {
	raw := `{"model":"` + pinnedModel + `","answers":{"q1":{"type":"noul","noul":0.91}}}`
	text, _, _, err := render(raw)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(text, "[警告]") {
		t.Errorf("模型号相符却报了警告：%s", text)
	}
}

// 响应里没有 model 字段时不该误报（Node 版同款条件：只在字段存在且不等时报）。
func TestRenderNoWarningWhenModelAbsent(t *testing.T) {
	text, _, _, err := render(`{"answers":{"q1":{"type":"score","score":0.5}}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(text, "[警告]") {
		t.Errorf("响应无 model 字段却报了警告：%s", text)
	}
}

// ───────────── 三种原语的渲染（对齐 2026-09-18 实测的响应形状） ─────────────

func TestRenderThreePrimitives(t *testing.T) {
	raw := `{"model":"` + pinnedModel + `","answers":{` +
		`"c":{"type":"choice","choice":"B","confidence":0.8123,"probabilities":{"A":0.1,"B":0.7,"C":0.2}},` +
		`"n":{"type":"noul","noul":0.4321},` +
		`"s":{"type":"score","score":0.6667,"confidence":0.5}` +
		`},"usage":{"input_tokens":99}}`
	text, _, _, err := render(raw)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		"【c】选项 → B  置信度 0.812",
		"分布：B=0.700  C=0.200  A=0.100", // 按值降序，不是键序
		"【n】命题 → 不成立（P(成立)=0.432）",     // 全角括号照抄 Node
		"【s】评分 → 0.667  置信度 0.500",
		"[用量] 输入 99 token",
		"[判读提示]",
		"两者阈值不可互借",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("渲染缺 %q\n实际：\n%s", want, text)
		}
	}
}

// noul 的概率在 answers[k].noul，**没有**独立 probability 字段——迁错这点会渲染成 0.000。
func TestRenderNoulReadsNoulFieldNotProbability(t *testing.T) {
	text, _, _, err := render(`{"answers":{"q":{"type":"noul","noul":0.87,"probability":0.01}}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(text, "P(成立)=0.870") || !strings.Contains(text, "成立") {
		t.Errorf("noul 没从 .noul 字段取概率：%s", text)
	}
}

// answers 的键序必须按**响应文档序**，不能是 Go map 的随机序（否则无法跨轮逐行比对）。
func TestRenderPreservesAnswerKeyOrder(t *testing.T) {
	raw := `{"answers":{"zeta":{"type":"score","score":0.1},"alpha":{"type":"score","score":0.2},` +
		`"mid":{"type":"score","score":0.3}}}`
	for i := 0; i < 20; i++ { // Go 的 map 随机序每次不同，跑多轮才抓得住
		text, _, _, err := render(raw)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		zi := strings.Index(text, "【zeta】")
		ai := strings.Index(text, "【alpha】")
		mi := strings.Index(text, "【mid】")
		if !(zi < ai && ai < mi) {
			t.Fatalf("第 %d 轮键序乱了（zeta→alpha→mid）：\n%s", i, text)
		}
	}
}

func TestRenderEmptyAnswersIsFlagged(t *testing.T) {
	text, _, _, err := render(`{"model":"` + pinnedModel + `"}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(text, "[异常] 响应里没有 answers") {
		t.Errorf("空 answers 没被标出来：%s", text)
	}
}

// ───────────── 波1（2026-09-22）A1/A2：结构化回包块（jev-out/2）─────────────
//
// 金样期望值的来源（独立性说明）：wave1Golden* 是**改前实现**（cmd/jev-mcp/main.go
// sha256 c9ce71f2d2df04d5b1f378983dcdeb9818844880bc89cba394602d7286c40ff6）render 的
// 真实输出，2026-09-22T080552 施工前一次性捕获固化（/tmp/jev-wave1-golden-PRECHANGE.json，
// sha256 8db34932434be32868cd4b765ef2ca9806507e47a1fdf8e560d874599bd1fe2f），
// 不是从改后被测实现回抄——期望值与被测代码不同源。

const wave1GoldenMixed = `【c】选项 → B  置信度 0.812
  分布：B=0.700  C=0.200  A=0.100
【n】命题 → 不成立（P(成立)=0.432）
【s】评分 → 0.667  置信度 0.500

[用量] 输入 99 token

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenProtocolF = `[警告] 服务端返回的模型是 jev-latest，与钉死的 jev-1.13.0 不符——阈值可能已失效。

【c1】命题 → 成立（P(成立)=0.970）
【c2】命题 → 不成立（P(成立)=0.030）
【c3】命题 → 成立（P(成立)=0.520）

[用量] 输入 1234 token

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenNoulMissing = `【q】命题 → [异常] 响应里没有 noul 概率，无法判定（原始：{"type":"noul"}）

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenEmptyAnswers = `[异常] 响应里没有 answers：{"model":"jev-1.13.0","answers":{}}

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

// FB-1③：4 个缺失形状 fixture 的金样前缀（同样来自**改前实现**的一次性捕获，
// /tmp/jev-wave1-golden-NEWFIXTURES-PRECHANGE-20260922T090052.json，
// sha256 dd7031bfb871fe4b8c7a27df64ea6f98c4a91741866ecfd06747787b10c151e9）：
// 未知 type 答案 / score 缺值 / 非数值概率分布 / 缺 usage 块。
// 注意 score 缺值那条正文渲染成 0.000 是**已知未修**观察（三判据不全，登记不修）——
// 金样照实固化，正文 render 输出一字不动。
const wave1GoldenUnknownType = `【q】{"type":"mystery","confidence":0.42}

[用量] 输入 5 token

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenScoreMissing = `【s】评分 → 0.000

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenNonNumericDist = `【q】选项 → A  置信度 0.550
  分布：A=0.000  B=0.000

[用量] 输入 7 token

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

const wave1GoldenMissingUsage = `【q】命题 → 成立（P(成立)=0.800）

[判读提示] 概率是校准过的置信度，不是正确率保证。置信度 <0.7 一律升人工复核。
choice 是「在给定选项里选最像的」（相对判断），noul 是「这条命题成不成立」（绝对判断），
两者阈值不可互借。日期先后、计数、多跳推理、结构不变量是官方已知弱项，须走机械路径。
⚠️ 不支持图像：把图像内容交给它不会报错，而是照样给出一个看似合理的判定和高置信度。
任何来自图像的结论都必须先由调用方转成文字并核对过，再交给它判定。`

// wave1RawFixtures 是波1 金样与结构化块测试共用的**真实响应形状**输入（形状依据 render
// 注释里 2026-09-18 的实测记录：三原语 + usage + model 漂移告警 + 边界件 + FB-1③ 缺失形状件）。
var wave1RawFixtures = []struct{ name, raw, golden string }{
	{"mixed", `{"model":"` + pinnedModel + `","answers":{"c":{"type":"choice","choice":"B","confidence":0.8123,"probabilities":{"A":0.1,"B":0.7,"C":0.2}},"n":{"type":"noul","noul":0.4321},"s":{"type":"score","score":0.6667,"confidence":0.5}},"usage":{"input_tokens":99}}`, wave1GoldenMixed},
	{"protocol_f_multi_noul", `{"model":"jev-latest","answers":{"c1":{"type":"noul","noul":0.97},"c2":{"type":"noul","noul":0.03},"c3":{"type":"noul","noul":0.52}},"usage":{"input_tokens":1234}}`, wave1GoldenProtocolF},
	{"noul_missing_prob", `{"answers":{"q":{"type":"noul"}}}`, wave1GoldenNoulMissing},
	{"empty_answers", `{"model":"jev-1.13.0","answers":{}}`, wave1GoldenEmptyAnswers},
	// FB-1③ 四个缺失形状件：未知 type 答案 / score 缺值 / 非数值概率分布 / 缺 usage 块。
	{"unknown_type_answer", `{"model":"` + pinnedModel + `","answers":{"q":{"type":"mystery","confidence":0.42}},"usage":{"input_tokens":5}}`, wave1GoldenUnknownType},
	{"score_missing_value", `{"answers":{"s":{"type":"score"}}}`, wave1GoldenScoreMissing},
	{"nonnumeric_prob_values", `{"answers":{"q":{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":"0.5","B":null}}},"usage":{"input_tokens":7}}`, wave1GoldenNonNumericDist},
	{"missing_usage_block", `{"answers":{"q":{"type":"noul","noul":0.8}}}`, wave1GoldenMissingUsage},
}

// structuredBlockOf 按固定分隔切出末尾的结构化块（消费侧「structured 优先解析」的测试镜像）。
// 分隔一律用**字面量** "\n## structured\n"，不引用实现常量 structuredSep——常量与 render
// 共用即同源自比：改了常量，输出与断言会同步变、测试照样绿（FB-1①）。
func structuredBlockOf(t *testing.T, text string) string {
	t.Helper()
	i := strings.LastIndex(text, "\n## structured\n")
	if i < 0 {
		t.Fatalf("回包里没有 structured 块：%q", text)
	}
	return text[i+len("\n## structured\n"):]
}

// 验收①：structured 块可 JSON 解析，且含 grammar / answers / usage（A2 的版本戳就在 grammar 里）。
func TestStructuredBlockParsesWithGrammarAnswersUsage(t *testing.T) {
	for _, f := range wave1RawFixtures {
		t.Run(f.name, func(t *testing.T) {
			text, tokens, _, err := render(f.raw)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			block := structuredBlockOf(t, text)
			t.Logf("structured 块（%s）：%s", f.name, block)
			var obj map[string]json.RawMessage
			if err := json.Unmarshal([]byte(block), &obj); err != nil {
				t.Fatalf("structured 块不是合法 JSON：%v\n块：%s", err, block)
			}
			// grammar / answers 恒在；usage 与正文 [用量] 行**同在同缺**（FB-7）：
			// 远端没报 usage/input_tokens（render 回传 0）时整个 usage 键省略，
			// 禁止 input_tokens:0 冒充实测值——所以这里按有无实测值分两向断言。
			for _, k := range []string{"grammar", "answers"} {
				if _, ok := obj[k]; !ok {
					t.Errorf("structured 块缺 %q：%s", k, block)
				}
			}
			if got := string(obj["grammar"]); got != `"jev-out/2"` {
				t.Errorf("文法版本戳 = %s，want \"jev-out/2\"（A2）", got)
			}
			if tokens == 0 {
				if raw, ok := obj["usage"]; ok {
					t.Errorf("远端没报 usage 却写了 usage 键（%s）——不得伪装实测值（FB-7），块：%s", raw, block)
				}
				if strings.Contains(block, "input_tokens") {
					t.Errorf("远端没报 usage，块里却出现 input_tokens（很可能是补了 0）：%s", block)
				}
				return
			}
			if _, ok := obj["usage"]; !ok {
				t.Errorf("远端报了 %d token，usage 键却被省略了（FB-7 只许缺时省略）：%s", tokens, block)
			}
			var usage struct {
				InputTokens int64 `json:"input_tokens"`
			}
			if err := json.Unmarshal(obj["usage"], &usage); err != nil {
				t.Fatalf("usage 解析失败：%v（块：%s）", err, block)
			}
			if usage.InputTokens != tokens {
				t.Errorf("usage.input_tokens=%d，render 回传 %d——两处必须同源", usage.InputTokens, tokens)
			}
		})
	}
}

// 验收②：choice 与 noul 两种回包都带块，且 kind / choice? / p / dist? 口径正确。
func TestStructuredBlockForChoiceAndNoul(t *testing.T) {
	type entry struct {
		Kind   string             `json:"kind"`
		Choice string             `json:"choice"`
		P      *float64           `json:"p"`
		Dist   map[string]float64 `json:"dist"`
	}
	cases := []struct {
		name string
		raw  string
		key  string
		want entry
		// absentFields：这些字段在数据缺失/不适用时必须**整个省略**（不补零值）。
		absentFields []string
	}{
		{
			name: "choice",
			raw:  `{"model":"jev-1.13.0","answers":{"q":{"type":"choice","choice":"B","confidence":0.8123,"probabilities":{"A":0.1,"B":0.7,"C":0.2}}},"usage":{"input_tokens":7}}`,
			key:  "q",
			want: entry{Kind: "choice", Choice: "B", P: floatPtr(0.7), Dist: map[string]float64{"A": 0.1, "B": 0.7, "C": 0.2}},
		},
		{
			name:         "noul",
			raw:          `{"model":"jev-1.13.0","answers":{"q":{"type":"noul","noul":0.91}},"usage":{"input_tokens":7}}`,
			key:          "q",
			want:         entry{Kind: "noul", P: floatPtr(0.91)},
			absentFields: []string{"choice", "dist"},
		},
		{
			// noul 缺概率：p 必须整个省略，绝不补 0（补 0 就是「P(成立)=0」的假确定性）。
			name:         "noul_missing_p",
			raw:          `{"answers":{"q":{"type":"noul"}}}`,
			key:          "q",
			want:         entry{Kind: "noul"},
			absentFields: []string{"choice", "p", "dist"},
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			text, _, _, err := render(tt.raw)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			block := structuredBlockOf(t, text) // 带块是本条验收的前提
			var obj struct {
				Answers map[string]json.RawMessage `json:"answers"`
			}
			if err := json.Unmarshal([]byte(block), &obj); err != nil {
				t.Fatalf("structured 块解析失败：%v（块：%s）", err, block)
			}
			raw, ok := obj.Answers[tt.key]
			if !ok {
				t.Fatalf("answers 缺 %q：%s", tt.key, block)
			}
			var got entry
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("答案条目解析失败：%v（条目：%s）", err, raw)
			}
			if got.Kind != tt.want.Kind || got.Choice != tt.want.Choice {
				t.Errorf("kind/choice = %q/%q，want %q/%q（条目：%s）",
					got.Kind, got.Choice, tt.want.Kind, tt.want.Choice, raw)
			}
			switch {
			case tt.want.P == nil && got.P != nil:
				t.Errorf("p 不该出现：%s", raw)
			case tt.want.P != nil && got.P == nil:
				t.Errorf("p 缺失：%s", raw)
			case tt.want.P != nil && *got.P != *tt.want.P:
				t.Errorf("p = %v，want %v（条目：%s）", *got.P, *tt.want.P, raw)
			}
			if tt.want.Dist == nil {
				if got.Dist != nil {
					t.Errorf("dist 不该出现：%s", raw)
				}
			} else if len(got.Dist) != len(tt.want.Dist) {
				t.Errorf("dist = %v，want %v（条目：%s）", got.Dist, tt.want.Dist, raw)
			} else {
				for k, v := range tt.want.Dist {
					if got.Dist[k] != v {
						t.Errorf("dist[%s] = %v，want %v（条目：%s）", k, got.Dist[k], v, raw)
					}
				}
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil {
				t.Fatalf("条目再解析失败：%v", err)
			}
			for _, name := range tt.absentFields {
				if _, ok := fields[name]; ok {
					t.Errorf("字段 %q 必须整个省略（数据缺失不补零值），实际条目：%s", name, raw)
				}
			}
		})
	}
}

func floatPtr(v float64) *float64 { return &v }

// 验收③（金样兼容）：对同一个 raw 模型输出，改动前后**文本前缀逐字节一致**。
// 基准 = 改前实现输出的固化件 wave1Golden*（来源见本段头部注释），改动只允许在其后追加。
func TestGoldenTextPrefixUnchanged(t *testing.T) {
	for _, f := range wave1RawFixtures {
		t.Run(f.name, func(t *testing.T) {
			if strings.Contains(f.golden, "## structured") {
				t.Fatal("金样自身含 structured 标记——基准被污染")
			}
			text, _, _, err := render(f.raw)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			if !strings.HasPrefix(text, f.golden) {
				t.Fatalf("文本前缀与改前金样不一致（非逐字节）\n--- 金样 ---\n%q\n--- 实际 ---\n%q",
					f.golden, text)
			}
			suffix := text[len(f.golden):]
			// 分隔用字面量而非实现常量 structuredSep（FB-1①：同源自比会让断言随实现一起漂）。
			if !strings.HasPrefix(suffix, "\n## structured\n") {
				t.Fatalf("金样之后不是 structured 分隔，追加越界了：%q", suffix)
			}
			block := suffix[len("\n## structured\n"):]
			var obj map[string]json.RawMessage
			if err := json.Unmarshal([]byte(block), &obj); err != nil {
				t.Fatalf("追加的块不是合法 JSON：%v（块：%s）", err, block)
			}
		})
	}
}

// ───────────── 金样 fixture sha256 钉扎（FB-1②）─────────────
//
// 金样字符串的哈希**硬编码**在这里：fixture 文本被改动哪怕一个字节，本用例当场红，
// 而不是等某天输出漂了才发现基准已经被人「顺手更新」。基准捕获件线索（勿删）：
//   - /tmp/jev-wave1-golden-PRECHANGE.json
//     sha256 8db34932434be32868cd4b765ef2ca9806507e47a1fdf8e560d874599bd1fe2f
//     （2026-09-22T080552 改前实现一次性捕获，wave1GoldenMixed/ProtocolF/NoulMissing/EmptyAnswers）
//   - /tmp/jev-wave1-golden-NEWFIXTURES-PRECHANGE-20260922T090052.json
//     sha256 dd7031bfb871fe4b8c7a27df64ea6f98c4a91741866ecfd06747787b10c151e9
//     （FB-1③ 四个缺失形状件的正文前缀，同样出自改前实现）
var goldenFixtureSHA256 = map[string]string{
	"mixed":                  "c82d6c36cbf9031ca79fec161c9b259fe815c96e44ea1e294ecf0f299af4243c",
	"protocol_f_multi_noul":  "2e4bab389eb8d85caf8c403096866a1c8225b88c2f1d824599e575fece46a9d0",
	"noul_missing_prob":      "58f1fa6072208d1f524f447d73ec4e36fbac616b2691de91df6cddcff3e42571",
	"empty_answers":          "9424ba386e40be3e1e1bf580d506cc7b9a2b986ed6bb975573b23ae6893a0ae2",
	"unknown_type_answer":    "19fba70ddfb6f21971537c9ecb79905bb96b0b62078236f36d0534c65d5f700c",
	"score_missing_value":    "d4a4f0f1d159fb5a67aa42ac390a3db4c053b9b26d847f40580c75e3d67beaab",
	"nonnumeric_prob_values": "c65b079ac7f3c39f59068e43903ec85ff07e1b17d1f0fbcd74b5affe995e1b08",
	"missing_usage_block":    "1246f448b7ab54d424e3f389af22bff835d01d4240c8aeb5664c2468e4202fdd",
}

func TestGoldenFixturesSHA256Pinned(t *testing.T) {
	// 双向钉扎：每个 fixture 都要有钉、每根钉都要有 fixture（只单向会漏「加了件没加钉」）。
	if len(goldenFixtureSHA256) != len(wave1RawFixtures) {
		t.Fatalf("sha256 钉扎 %d 根，fixture %d 个——数量对不上（新 fixture 必须补钉）",
			len(goldenFixtureSHA256), len(wave1RawFixtures))
	}
	for _, f := range wave1RawFixtures {
		want, ok := goldenFixtureSHA256[f.name]
		if !ok {
			t.Fatalf("fixture %s 没有 sha256 钉扎——金样基准不许无锚", f.name)
		}
		if got := sha256Hex(f.golden); got != want {
			t.Errorf("fixture %s 的金样 sha256 = %s，want %s——金样文本被改动了（金样基准不许动，"+
				"要更新基准必须走改前捕获件流程）", f.name, got, want)
		}
	}
	for name := range goldenFixtureSHA256 {
		found := false
		for _, f := range wave1RawFixtures {
			if f.name == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("钉扎 %s 没有对应 fixture", name)
		}
	}
}

// 最小反例（FB-1② 配套）：钉扎必须能红——篡改一个字节就要对不上，否则这根钉是装饰品。
func TestGoldenFixturesSHA256PinCatchesTamper(t *testing.T) {
	pin := goldenFixtureSHA256["mixed"]
	if sha256Hex(wave1GoldenMixed) == pin && sha256Hex(wave1GoldenMixed+" ") != pin {
		return // 双向都成立：原样对得上、篡改对不上
	}
	t.Errorf("sha256 钉扎没起到篡改即红的作用：原样=%s 篡改=%s 钉=%s",
		sha256Hex(wave1GoldenMixed), sha256Hex(wave1GoldenMixed+" "), pin)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// ───────────── state 体积闸：按 UTF-16 码元数算，不是字节数 ─────────────

func TestApproxStateTokensCountsUTF16UnitsNotBytes(t *testing.T) {
	// 100 个中文字：JS 的 length=100 → ceil(100/2)=50。
	// 若按字节算会得到 ceil(300/2)=150（闸门被悄悄收到三分之一）。
	state, _ := json.Marshal(strings.Repeat("中", 100))
	got, err := approxStateTokens(state)
	if err != nil {
		t.Fatalf("approxStateTokens: %v", err)
	}
	if got != 50 {
		t.Errorf("中文 100 字 → %d token，want 50（按 UTF-16 码元；150 说明按字节算了）", got)
	}
}

func TestApproxStateTokensSurrogatePairCountsTwo(t *testing.T) {
	// emoji 是 UTF-16 代理对：JS length=2/个。10 个 → ceil(20/2)=10。
	// 按 rune 算只会得到 5（闸门被悄悄放宽一倍）。
	state, _ := json.Marshal(strings.Repeat("🙂", 10))
	got, err := approxStateTokens(state)
	if err != nil {
		t.Fatalf("approxStateTokens: %v", err)
	}
	if got != 10 {
		t.Errorf("10 个 emoji → %d token，want 10（代理对各算 2 码元；5 说明按 rune 算了）", got)
	}
}

// string 型 state 用**解码后的原文**，不含外层引号与转义（Node 的 `typeof state === "string"` 分支）。
func TestApproxStateTokensStringUsesDecodedText(t *testing.T) {
	state := json.RawMessage(`"ab"`) // 解码后 2 个字符 → ceil(2/2)=1
	got, err := approxStateTokens(state)
	if err != nil {
		t.Fatalf("approxStateTokens: %v", err)
	}
	if got != 1 {
		t.Errorf("got %d, want 1（若把引号也算进去会得到 2）", got)
	}
}

func TestApproxStateTokensObjectUsesCompactJSON(t *testing.T) {
	// 带缩进的 object：JSON.stringify 是紧凑形式，所以空白不该计入。
	state := json.RawMessage("{\n  \"a\" : 1\n}") // 紧凑后 {"a":1} = 7 字符 → ceil(7/2)=4
	got, err := approxStateTokens(state)
	if err != nil {
		t.Fatalf("approxStateTokens: %v", err)
	}
	if got != 4 {
		t.Errorf("got %d, want 4（紧凑后 {\"a\":1} 共 7 字符）", got)
	}
}

// ───────────── state 超限必须**拒绝**（不是截断后硬送） ─────────────

func newTestServer(t *testing.T) *jevServer {
	t.Helper()
	return &jevServer{
		logger:      mcpshell.NewLogger("jev-test"),
		secretsPath: "/nonexistent/secrets.env",
		apiKey:      "test-key-never-sent", // 这些测试都在发请求之前就返回
		templates:   map[string]json.RawMessage{},
		auditLog:    filepath.Join(t.TempDir(), "audit.jsonl"),
		gate:        mcpshell.NewGate(maxInflight),
		stats:       mcpshell.NewStats(),
		out:         newOutbound(),
	}
}

func TestCallJevRejectsOversizedState(t *testing.T) {
	s := newTestServer(t)
	// 60k 个 ASCII 字符 → 30000 token > 24000 上限。
	big, _ := json.Marshal(strings.Repeat("x", 60_000))
	text, isErr := s.callJev(context.Background(), big, json.RawMessage(`{"q":{"type":"noul"}}`))
	if !isErr {
		t.Fatal("超限的 state 没被拒绝——会拿一个基于超长材料的不准判定当真")
	}
	for _, want := range []string{"30000 token", "超过 24000 上限", "请先由子代理裁剪"} {
		if !strings.Contains(text, want) {
			t.Errorf("拒绝文案缺 %q：%s", want, text)
		}
	}
	// 关键：拒绝路径不该发出任何远端请求，所以计数器不该动。
	if s.stats.Served() != 0 || s.stats.Failed() != 0 {
		t.Errorf("拒绝路径动了计数器：served=%d failed=%d", s.stats.Served(), s.stats.Failed())
	}
}

func TestCallJevAcceptsStateAtBudgetBoundary(t *testing.T) {
	s := newTestServer(t)
	s.apiKey = ""                                                       // 用「缺 key」这条更早的分支做断言：说明体积闸没拦住
	atLimit, _ := json.Marshal(strings.Repeat("x", stateTokenBudget*2)) // 正好 24000 token
	text, isErr := s.callJev(context.Background(), atLimit, json.RawMessage(`{"q":{"type":"noul"}}`))
	if !isErr {
		t.Fatal("缺 key 应当报错")
	}
	if strings.Contains(text, "超过") {
		t.Errorf("正好到上限被误拒（闸门应是 > 而非 >=）：%s", text)
	}
	if !strings.Contains(text, "未取得 TYPESAFE_API_KEY") {
		t.Errorf("没走到缺 key 分支：%s", text)
	}
}

func TestCallJevMissingKeyNamesSecretsPathButNotValue(t *testing.T) {
	s := newTestServer(t)
	s.apiKey = ""
	s.secretsPath = "/some/where/secrets.env"
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"tiny"`), json.RawMessage(`{"q":{}}`))
	if !isErr || !strings.Contains(text, "/some/where/secrets.env") {
		t.Errorf("缺 key 的文案要指出查过哪个文件：%s", text)
	}
}

func TestCallJevGateRefusesWhenFull(t *testing.T) {
	s := newTestServer(t)
	s.gate = mcpshell.NewGate(1)
	if !s.gate.TryAcquire() {
		t.Fatal("占位失败")
	}
	defer s.gate.Release()
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"x"`), json.RawMessage(`{"q":{}}`))
	if !isErr || !strings.Contains(text, "在飞请求已达上限 1") {
		t.Errorf("熔断没生效：%s", text)
	}
}

// ───────────── 走真 HTTP 路径的端到端分支（假上游） ─────────────
// apiURL 是 jevServer 的字段而不是 env 旋钮，所以这里能在同包里指向 httptest，
// 既验到了 HTTP 层（鉴权头、重试、状态码解释），又不给生产留一个「能把密钥
// 重定向到任意主机」的配置口子。

func TestCallJevEndToEndWarnsWhenUpstreamModelMismatches(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		// 上游谎报成别名版本：这正是「阈值静默失效」的现场。
		_, _ = w.Write([]byte(`{"model":"jev-latest","answers":{"q1":{"type":"choice","choice":"yes",` +
			`"confidence":0.93,"probabilities":{"yes":0.93,"no":0.07}}},"usage":{"input_tokens":42}}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	s.out.Backoff = func(int) time.Duration { return time.Millisecond }

	text, isErr := s.callJev(context.Background(),
		json.RawMessage(`"这段材料很短"`), json.RawMessage(`{"q1":{"type":"choice"}}`))
	if isErr {
		t.Fatalf("200 + 可解析响应不该标错：%s", text)
	}
	if !strings.HasPrefix(text, "[警告] 服务端返回的模型是 jev-latest") {
		t.Fatalf("模型号不符没在顶部报警告：\n%s", text)
	}
	if !strings.Contains(text, "【q1】选项 → yes  置信度 0.930") {
		t.Errorf("警告之外的正文丢了：\n%s", text)
	}
	// 请求侧不变量：钉死模型、鉴权头带上了。
	if gotAuth != "Bearer test-key-never-sent" {
		t.Errorf("鉴权头不对：%q", gotAuth)
	}
	if !strings.HasPrefix(gotBody, `{"model":"jev-1.13.0",`) {
		t.Errorf("请求里没钉死模型：%s", gotBody)
	}
	if s.stats.Served() != 1 {
		t.Errorf("served=%d, want 1（带警告的结果仍是一次成功服务）", s.stats.Served())
	}
}

// 超限的 state 必须在**发请求之前**就被拒：一个字节都不该到上游。
func TestCallJevEndToEndOversizedStateNeverReachesUpstream(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(200)
		// 夹具必须真的答上那道题：2026-09-19 起 callJev 会核对「问了几道、答回几道」，
		// 空 answers 现在（正确地）算失败。这条测试要验的是「限内 state 能到上游」，
		// 不该顺带依赖一个不现实的响应。
		_, _ = w.Write([]byte(`{"model":"` + pinnedModel +
			`","answers":{"q":{"type":"noul","noul":0.9}}}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	big, _ := json.Marshal(strings.Repeat("材", 30_000)) // 30000 码元 → 15000 token，仍在限内
	if _, isErr := s.callJev(context.Background(), big, json.RawMessage(`{"q":{}}`)); isErr {
		t.Fatal("限内的 state 被误拒了")
	}
	if hits != 1 {
		t.Fatalf("限内请求发了 %d 次，want 1", hits)
	}

	over, _ := json.Marshal(strings.Repeat("材", 60_000)) // 30000 token > 24000 上限
	text, isErr := s.callJev(context.Background(), over, json.RawMessage(`{"q":{}}`))
	if !isErr || !strings.Contains(text, "超过 24000 上限") {
		t.Fatalf("超限没被拒：%s", text)
	}
	if hits != 1 {
		t.Errorf("超限的 state 还是发到上游了（hits=%d）——等于拿残缺材料换了个高置信答案", hits)
	}
}

// 429 退避重试 + 最终成功；以及不可重试状态码一次即返回。
func TestCallJevEndToEndRetriesOn429(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits == 1 {
			w.WriteHeader(429)
			_, _ = w.Write([]byte("rate limited"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"` + pinnedModel + `","answers":{"q":{"type":"noul","noul":0.6}}}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	s.out.Backoff = func(int) time.Duration { return time.Millisecond }
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"x"`), json.RawMessage(`{"q":{}}`))
	if isErr {
		t.Fatalf("429 后重试成功却标错了：%s", text)
	}
	if hits != 2 {
		t.Errorf("hits=%d, want 2（一次 429 + 一次成功）", hits)
	}
	if !strings.Contains(text, "P(成立)=0.600") {
		t.Errorf("正文不对：%s", text)
	}
}

func TestCallJevEndToEndNon200IsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"bad key"}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"x"`), json.RawMessage(`{"q":{}}`))
	if !isErr {
		t.Fatal("401 没标错")
	}
	if !strings.Contains(text, "HTTP 401") || !strings.Contains(text, "bad key") {
		t.Errorf("错误文案缺状态码或上游正文：%s", text)
	}
	if s.stats.Failed() != 1 {
		t.Errorf("failed=%d, want 1", s.stats.Failed())
	}
	// 失败也要留审计，且审计里不能有 key。
	raw, err := os.ReadFile(s.auditLog)
	if err != nil {
		t.Fatalf("读审计: %v", err)
	}
	if !strings.Contains(string(raw), "HTTP 401") {
		t.Errorf("失败没进审计：%s", raw)
	}
	if strings.Contains(string(raw), "test-key-never-sent") {
		t.Fatal("审计里出现了 API key")
	}
}

func TestCallJevEndToEndBadJSONFromUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not json at all`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"x"`), json.RawMessage(`{"q":{}}`))
	if !isErr || !strings.Contains(text, "不是合法 JSON") {
		t.Errorf("坏响应没被识别：%s", text)
	}
}

// ───────────── 请求体：字段序与内容逐字对齐 Node 版 ─────────────

func TestBuildRequestBodyPinsModelAndPreservesInput(t *testing.T) {
	body, err := buildRequestBody(json.RawMessage(`{ "b" : 2, "a" : 1 }`), json.RawMessage(`{"q1":{"type":"noul"}}`))
	if err != nil {
		t.Fatalf("buildRequestBody: %v", err)
	}
	got := string(body)
	want := `{"model":"jev-1.13.0","state":{"b":2,"a":1},"questions":{"q1":{"type":"noul"}}}`
	if got != want {
		t.Errorf("请求体不符\n got: %s\nwant: %s", got, want)
	}
	if strings.Contains(got, "jev-latest") {
		t.Error("请求体里出现了 jev-latest")
	}
}

func TestBuildRequestBodyAlwaysUsesPinnedModel(t *testing.T) {
	// 客户端就算在 state 里塞 model 也影响不到顶层的钉死值。
	body, err := buildRequestBody(json.RawMessage(`{"model":"jev-latest"}`), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("buildRequestBody: %v", err)
	}
	if !strings.HasPrefix(string(body), `{"model":"jev-1.13.0",`) {
		t.Errorf("顶层 model 不是钉死值：%s", body)
	}
}

// ───────────── schema 形状 ─────────────

func TestJudgeSchemaShape(t *testing.T) {
	raw, err := json.Marshal(judgeSchema())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(raw)
	for _, want := range []string{
		// Node 的 z.union([string, record])。2026-09-30 由 `"type":["string","object"]` 改为 anyOf：
		// 数组形 type 会让 MiMo 服务端截断参数（见 schema_typearray_test.go）。
		`"anyOf":[{"type":"string"},{"type":"object"}]`,
		`"additionalProperties":false`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("schema 缺 %s：%s", want, got)
		}
	}
	if !strings.Contains(got, `"state"`) || !strings.Contains(got, `"questions"`) {
		t.Errorf("schema 缺字段：%s", got)
	}
	// required 两项都在（Node 版两个都是必填）。
	if !strings.Contains(got, `"required":`) ||
		!(strings.Contains(got, `"state","questions"`) || strings.Contains(got, `"questions","state"`)) {
		t.Errorf("state/questions 不是都必填：%s", got)
	}
}

func TestJudgeTemplateSchemaShape(t *testing.T) {
	raw, _ := json.Marshal(judgeTemplateSchema())
	if !strings.Contains(string(raw), `"minLength":1`) {
		t.Errorf("template 缺 minLength:1：%s", raw)
	}
}

// ───────────── 模板加载 ─────────────

func TestLoadTemplatesSkipsBadFilesAndPreservesQuestionOrder(t *testing.T) {
	dir := t.TempDir()
	must := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	must("good.json", `{"id":"good","questions":{"z":{"type":"noul"},"a":{"type":"noul"}}}`)
	must("noid.json", `{"questions":{"q":{"type":"noul"}}}`) // id 回落成文件名
	must("noq.json", `{"id":"noq"}`)                         // 缺 questions → 跳过
	must("broken.json", `{not json`)                         // 坏 JSON → 跳过
	must("ignored.txt", `{"id":"x","questions":{"q":{}}}`)   // 非 .json → 忽略

	s := &jevServer{logger: mcpshell.NewLogger("t"), templateDir: dir}
	s.loadTemplates()

	if len(s.templates) != 2 {
		t.Fatalf("加载了 %d 个模板，want 2（good + noid）：%v", len(s.templates), s.templateIDs)
	}
	if _, ok := s.templates["noid"]; !ok {
		t.Error("缺 id 的模板没回落成文件名 noid")
	}
	// questions 原文必须保序（模板问法一变，校准概率就不可跨轮比较）。
	if got := string(s.templates["good"]); !strings.HasPrefix(got, `{"z"`) {
		t.Errorf("模板 questions 键序被打乱：%s", got)
	}
}

func TestLoadTemplatesMissingDirIsNotFatal(t *testing.T) {
	s := &jevServer{logger: mcpshell.NewLogger("t"), templateDir: filepath.Join(t.TempDir(), "nope")}
	s.loadTemplates()
	if len(s.templates) != 0 {
		t.Error("不存在的目录不该产出模板")
	}
}

// ───────────── 验收④（波1 A3 + FB-2 真三方）：随附模板 ↔ 真源文件逐字比对 ─────────────
//
// 三方 = ① 被测模板文件（templates/*.json）② 本文件的 fixture（want 表）
// ③ 真源文件（下列两个绝对路径常量，**运行时读取**，不手抄、不从被测模板回抄）。
// 真源分工：jevcheck.ts = 六条问法的逐字真源（fact/link 共用 FACT_LINK_SPEC——link 自
// FB-5 同文化后不再取 judge-finding.mjs 的拼装文本）；judge-finding.mjs = criteria
// **键集**真源（CRIT）+ 消费侧拼装形态（tplStep 含 ${text} 槽位；模板侧一律静态无占位符，
// FB-4/5），其 tplStep/CRIT 原文另与本文件字面量逐字比对（第二真源本体不许漂）。
// 真源文件不可读 → t.Skipf 标明环境缺失，**不静默跳过比对逻辑**（FB-2）。
const (
	jevcheckTruthPath     = "../../../PiMoa/src/moa/jevcheck.ts"
	judgeFindingTruthPath = "<workspace>/artifacts/jev-finding-truth-20260922/judge-finding.mjs"
)

// truthSpec = 真源里一条问法（instructions/criteria 原文 + criteria 键集）。
type truthSpec struct {
	instructions   string
	criteria       map[string]string
	criteriaKeySet map[string]struct{}
}

// judgeTruth = judge-finding.mjs 的 tplStep 模板**源码原文**（\n 仍是两个字符、${text} 原样）
// 与 CRIT 键值。
type judgeTruth struct {
	tplStep string
	crit    map[string]string
}

func readTruthSource(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("环境缺失：真源文件 %s 不可读（%v）——本用例的三方逐字比对未执行", path, err)
	}
	return string(b)
}

func isIdentChar(c byte) bool {
	return c == '_' || c == '$' || (c >= '0' && c <= '9') ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// skipSpace 跳过空白与 // 、/* */ 注释（jevcheck.ts 的条目之间夹着注释行）。
func skipSpace(src string, i int) int {
	for i < len(src) {
		switch {
		case src[i] == ' ' || src[i] == '\t' || src[i] == '\n' || src[i] == '\r':
			i++
		case strings.HasPrefix(src[i:], "//"):
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case strings.HasPrefix(src[i:], "/*"):
			i += 2
			for i < len(src) && !strings.HasPrefix(src[i:], "*/") {
				i++
			}
			if i < len(src) {
				i += 2
			}
		default:
			return i
		}
	}
	return i
}

// tsString 解析一个双引号字符串字面量，返回解码值与字面量后位置。
func tsString(src string, i int) (string, int, error) {
	i = skipSpace(src, i)
	if i >= len(src) || src[i] != '"' {
		return "", i, fmt.Errorf("位置 %d 不是字符串字面量（附近：%q）", i, clipRunes(src[i:], 40))
	}
	j := i + 1
	for j < len(src) {
		switch src[j] {
		case '\\':
			j += 2
			continue
		case '"':
			s, err := strconv.Unquote(src[i : j+1])
			if err != nil {
				return "", j, fmt.Errorf("字符串字面量解码失败：%v（%q）", err, src[i:j+1])
			}
			return s, j + 1, nil
		}
		j++
	}
	return "", j, fmt.Errorf("字符串字面量未闭合")
}

// matchBrace 返回与 src[open]=='{' 配对的 '}' 位置（跳过字符串字面量与行注释，防串味）。
func matchBrace(src string, open int) (int, error) {
	if open >= len(src) || src[open] != '{' {
		return 0, fmt.Errorf("位置 %d 不是 '{'", open)
	}
	depth, i := 0, open
	for i < len(src) {
		switch {
		case src[i] == '"':
			_, next, err := tsString(src, i)
			if err != nil {
				return 0, err
			}
			i = next
		case strings.HasPrefix(src[i:], "//"):
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case src[i] == '{':
			depth++
			i++
		case src[i] == '}':
			depth--
			if depth == 0 {
				return i, nil
			}
			i++
		default:
			i++
		}
	}
	return 0, fmt.Errorf("括号未闭合（从 %d 起）", open)
}

// parseKeyValues 解析 `{ k: "v", "k2": "v2" }` 形状的键值块（键可为标识符或字符串字面量）。
// 键**全部**收进结果——多出来的键必须能被上层键集合全等比对看见，不许静默丢。
func parseKeyValues(src string, start, end int) (map[string]string, error) {
	out := map[string]string{}
	i := start
	for {
		i = skipSpace(src, i)
		if i >= end {
			return out, nil
		}
		if src[i] == ',' {
			i++
			continue
		}
		var key string
		if src[i] == '"' {
			k, next, err := tsString(src, i)
			if err != nil {
				return nil, err
			}
			key, i = k, next
		} else {
			j := i
			for j < end && isIdentChar(src[j]) {
				j++
			}
			if j == i {
				return nil, fmt.Errorf("位置 %d 不是键名（附近：%q）", i, clipRunes(src[i:], 40))
			}
			key, i = src[i:j], j
		}
		i = skipSpace(src, i)
		if i >= end || src[i] != ':' {
			return nil, fmt.Errorf("键 %q 后没有 ':'", key)
		}
		v, next, err := tsString(src, i+1)
		if err != nil {
			return nil, fmt.Errorf("键 %q 取值失败：%w", key, err)
		}
		out[key] = v
		i = next
	}
}

// parseQuestionSpec 解析一条 TS QuestionSpec：`instructions: "…" , criteria: { … }`。
func parseQuestionSpec(src string, start, end int) (truthSpec, error) {
	var spec truthSpec
	region := src[start:end]
	insAt := strings.Index(region, "instructions:")
	if insAt < 0 {
		return spec, fmt.Errorf("区间内没有 instructions")
	}
	ins, _, err := tsString(src, start+insAt+len("instructions:"))
	if err != nil {
		return spec, fmt.Errorf("instructions 取值失败：%w", err)
	}
	spec.instructions = ins
	criAt := strings.Index(region, "criteria:")
	if criAt < 0 {
		return spec, fmt.Errorf("区间内没有 criteria")
	}
	criVal := skipSpace(src, start+criAt+len("criteria:"))
	if criVal >= end || src[criVal] != '{' {
		return spec, fmt.Errorf("criteria 后不是对象")
	}
	criEnd, err := matchBrace(src, criVal)
	if err != nil {
		return spec, fmt.Errorf("criteria：%w", err)
	}
	vals, err := parseKeyValues(src, criVal+1, criEnd)
	if err != nil {
		return spec, fmt.Errorf("criteria 取值失败：%w", err)
	}
	spec.criteria = vals
	spec.criteriaKeySet = map[string]struct{}{}
	for k := range vals {
		spec.criteriaKeySet[k] = struct{}{}
	}
	return spec, nil
}

// parseJevcheckTruth 抽出 FACT_LINK_SPEC 与 QUESTIONS 各条目（`name: { … }` 内联与
// `name: IDENT` 引用两种形状，引用在解析时展开）。抽不出就报错——比对器不许静默变空。
func parseJevcheckTruth(src string) (map[string]truthSpec, error) {
	out := map[string]truthSpec{}

	specAt := strings.Index(src, "const FACT_LINK_SPEC")
	if specAt < 0 {
		return nil, fmt.Errorf("没找到 FACT_LINK_SPEC")
	}
	brace := strings.Index(src[specAt:], "{")
	if brace < 0 {
		return nil, fmt.Errorf("FACT_LINK_SPEC 后没有对象")
	}
	open := specAt + brace
	clos, err := matchBrace(src, open)
	if err != nil {
		return nil, fmt.Errorf("FACT_LINK_SPEC：%w", err)
	}
	base, err := parseQuestionSpec(src, open+1, clos)
	if err != nil {
		return nil, fmt.Errorf("FACT_LINK_SPEC：%w", err)
	}
	out["FACT_LINK_SPEC"] = base

	qAt := strings.Index(src, "export const QUESTIONS")
	if qAt < 0 {
		return nil, fmt.Errorf("没找到 QUESTIONS")
	}
	qBrace := strings.Index(src[qAt:], "{")
	if qBrace < 0 {
		return nil, fmt.Errorf("QUESTIONS 后没有对象")
	}
	qOpen := qAt + qBrace
	qClose, err := matchBrace(src, qOpen)
	if err != nil {
		return nil, fmt.Errorf("QUESTIONS：%w", err)
	}
	i := qOpen + 1
	for {
		i = skipSpace(src, i)
		if i >= qClose {
			break
		}
		if src[i] == ',' {
			i++
			continue
		}
		j := i
		for j < qClose && isIdentChar(src[j]) {
			j++
		}
		if j == i {
			return nil, fmt.Errorf("QUESTIONS 条目名解析失败（位置 %d，附近：%q）", i, clipRunes(src[i:], 40))
		}
		name := src[i:j]
		i = skipSpace(src, j)
		if i >= qClose || src[i] != ':' {
			return nil, fmt.Errorf("条目 %q 后没有 ':'", name)
		}
		i = skipSpace(src, i+1)
		if i < qClose && src[i] == '{' {
			end, err := matchBrace(src, i)
			if err != nil {
				return nil, fmt.Errorf("条目 %q：%w", name, err)
			}
			spec, err := parseQuestionSpec(src, i+1, end)
			if err != nil {
				return nil, fmt.Errorf("条目 %q：%w", name, err)
			}
			out[name] = spec
			i = end + 1
			continue
		}
		j = i
		for j < qClose && isIdentChar(src[j]) {
			j++
		}
		ref := src[i:j]
		spec, ok := out[ref]
		if !ok {
			return nil, fmt.Errorf("条目 %q 引用了未解析的 %q（引用必须先定义）", name, ref)
		}
		out[name] = spec
		i = j
	}
	delete(out, "FACT_LINK_SPEC") // 它不是 QUESTIONS 的 id，别混进键集合比对
	return out, nil
}

// parseJudgeFinding 抽出 `const tplStep = … \`…\“ 的模板源码原文与 `const CRIT = { … }`。
func parseJudgeFinding(src string) (judgeTruth, error) {
	var out judgeTruth
	tAt := strings.Index(src, "const tplStep")
	if tAt < 0 {
		return out, fmt.Errorf("没找到 tplStep")
	}
	q := strings.Index(src[tAt:], "`")
	if q < 0 {
		return out, fmt.Errorf("tplStep 后没有模板字面量")
	}
	open := tAt + q
	clos := open + 1
	for clos < len(src) && src[clos] != '`' {
		if src[clos] == '\\' {
			clos++
		}
		clos++
	}
	if clos >= len(src) {
		return out, fmt.Errorf("tplStep 模板字面量未闭合")
	}
	out.tplStep = src[open+1 : clos]

	cAt := strings.Index(src, "const CRIT")
	if cAt < 0 {
		return out, fmt.Errorf("没找到 CRIT")
	}
	brace := strings.Index(src[cAt:], "{")
	if brace < 0 {
		return out, fmt.Errorf("CRIT 后没有对象")
	}
	open = cAt + brace
	end, err := matchBrace(src, open)
	if err != nil {
		return out, fmt.Errorf("CRIT：%w", err)
	}
	if out.crit, err = parseKeyValues(src, open+1, end); err != nil {
		return out, fmt.Errorf("CRIT：%w", err)
	}
	return out, nil
}

// sameKeySet：两组键**集合全等**（FB-2 加严——只比「包含」会漏掉多余键）。
func sameKeySet(a, b map[string]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestBundledTemplatesLoadAndMatchSourceVerbatim(t *testing.T) {
	jevSrc := readTruthSource(t, jevcheckTruthPath)
	mjsSrc := readTruthSource(t, judgeFindingTruthPath)

	truth, err := parseJevcheckTruth(jevSrc)
	if err != nil {
		t.Fatalf("jevcheck.ts 解析失败（真源形状变了？）：%v", err)
	}
	judge, err := parseJudgeFinding(mjsSrc)
	if err != nil {
		t.Fatalf("judge-finding.mjs 解析失败（真源形状变了？）：%v", err)
	}

	// judge-finding.mjs 原文逐字比对（第二真源本体不许漂）；tplStep 的 ${text} 槽位证明
	// 「拼装」发生在消费侧——模板侧是静态问法（FB-4/5）。
	const wantTplStep = `以下是被审代码或文档材料。判断下面这条命题是否成立。\n命题：${text}`
	if judge.tplStep != wantTplStep {
		t.Errorf("judge-finding.mjs 的 tplStep 与记录不一致\n got: %q\nwant: %q", judge.tplStep, wantTplStep)
	}
	wantCrit := map[string]string{"true": "命题成立", "false": "命题不成立"}
	if len(judge.crit) != len(wantCrit) ||
		judge.crit["true"] != wantCrit["true"] || judge.crit["false"] != wantCrit["false"] {
		t.Errorf("judge-finding.mjs 的 CRIT 与记录不一致\n got: %v\nwant: %v", judge.crit, wantCrit)
	}

	s := &jevServer{logger: mcpshell.NewLogger("t"), templateDir: defaultTemplateDir()}
	s.loadTemplates()

	// fixture（三方之一，与被测 templates/*.json 不同源）。link 自 FB-5 起与 fact 同文化：
	// 取 jevcheck.ts FACT_LINK_SPEC 的静态问法（不含 {text}），不再取 judge-finding.mjs 的拼装文本。
	want := map[string]struct{ instructions, isTrue, isFalse string }{
		"fact":     {"这条事实与所给材料（或所述通用规范）相符。", "相符", "不相符：引用位置/内容与代码不一致，或所述通用行为不成立"},
		"fixed":    {"所给代码已经包含「待核对的处理」所述的那种处理。", "已包含：代码中已有等价的处理", "未包含：代码中没有这种处理，或处理不等价"},
		"entail":   {"仅凭上述前提即可推出「待判断的结论」（前提足以推出结论，没有缺失的必要条件，也没有与前提相反）。", "可以推出", "不能推出：缺少必要条件、结论与前提相反、或结论超出前提所述"},
		"same":     {"下面两条代码审查发现（finding A 与 finding B）指向的是同一个问题。", "两条指向同一个问题：描述的是代码中同一处缺陷，只是措辞不同，应当合并去重", "两条指向不同问题：描述的是代码中两处互相独立的缺陷，不应合并"},
		"opposite": {"两条发现针对同一处代码得出了相反或明显不一致的结论（一方认为有缺陷/更严重，另一方认为不成立/更轻）。", "相反或不一致", "一致或只是措辞不同"},
		"link":     {"这条事实与所给材料（或所述通用规范）相符。", "相符", "不相符：引用位置/内容与代码不一致，或所述通用行为不成立"},
	}

	if len(s.templates) != len(want) {
		t.Fatalf("加载了 %d 个模板，want %d：%v", len(s.templates), len(want), s.templateIDs)
	}

	// 键集合全等（FB-2）①：questions 各 id 的键集——fixture / 加载结果 / 真源 QUESTIONS 三侧。
	wantIDs := map[string]struct{}{}
	for id := range want {
		wantIDs[id] = struct{}{}
	}
	// 真源 QUESTIONS 里**不随附模板**的条目：显式排除集，固定为 {recheck}。
	// recheck = jevcheck.ts 波4 §4.8 独立复核闸的 choice 三值闭集问法（非 noul），不属于
	// templates/*.json 的 noul 模板族。排除项自身被钉住：必须真实存在于真源、且 criteria 恰为
	// 三值 choice 闭集（不是 true/false）；除此之外真源新增的任何键仍让下方键集全等比对变红。
	truthNonTemplate := map[string]struct{}{"recheck": {}}
	for id := range truthNonTemplate {
		tr, ok := truth[id]
		if !ok {
			t.Errorf("显式排除项 %q 不在真源 QUESTIONS 里——排除集过期，须同步收紧", id)
			continue
		}
		_, hasTrue := tr.criteriaKeySet["true"]
		_, hasFalse := tr.criteriaKeySet["false"]
		if len(tr.criteriaKeySet) != 3 || hasTrue || hasFalse {
			t.Errorf("显式排除项 %q 已不是三值 choice 闭集（criteria 键集=%v）——不能再按非模板条目排除",
				id, sortedKeys(tr.criteriaKeySet))
		}
	}
	truthIDs := map[string]struct{}{}
	for id := range truth {
		if _, skip := truthNonTemplate[id]; skip {
			continue
		}
		truthIDs[id] = struct{}{}
	}
	loadedIDs := map[string]struct{}{}
	for id := range s.templates {
		loadedIDs[id] = struct{}{}
	}
	for _, other := range []struct {
		name string
		ids  map[string]struct{}
	}{{"真源 QUESTIONS", truthIDs}, {"加载结果", loadedIDs}} {
		if !sameKeySet(wantIDs, other.ids) {
			t.Errorf("questions id 键集不全等（FB-2）：fixture=%v %s=%v",
				sortedKeys(wantIDs), other.name, sortedKeys(other.ids))
		}
	}

	fixtureCritKeys := map[string]struct{}{"true": {}, "false": {}}
	judgeCritKeys := map[string]struct{}{}
	for k := range judge.crit {
		judgeCritKeys[k] = struct{}{}
	}

	for id, w := range want {
		raw, ok := s.templates[id]
		if !ok {
			t.Errorf("缺模板 %s（%s/）", id, defaultTemplateDir())
			continue
		}
		var qs map[string]struct {
			Type         string            `json:"type"`
			Instructions string            `json:"instructions"`
			Criteria     map[string]string `json:"criteria"`
		}
		if err := json.Unmarshal(raw, &qs); err != nil {
			t.Fatalf("%s.questions 解析失败：%v（原文：%s）", id, err, raw)
		}
		qKeys := map[string]struct{}{}
		for k := range qs {
			qKeys[k] = struct{}{}
		}
		if !sameKeySet(qKeys, map[string]struct{}{id: {}}) {
			t.Errorf("%s.questions 的键集 = %v，want [%s]（键集合全等，不多不少）", id, sortedKeys(qKeys), id)
		}
		q, ok := qs[id]
		if !ok {
			t.Errorf("%s.questions 里没有同名问题键 %q：%s", id, id, raw)
			continue
		}
		if q.Type != "noul" {
			t.Errorf("%s 的 type = %q，want noul", id, q.Type)
		}
		// FB-5：模板是静态问法——占位符只允许出现在消费侧拼装形态（judge.tplStep）里。
		if strings.Contains(q.Instructions, "{text}") {
			t.Errorf("%s 的 instructions 含 {text} 槽位——静态问法不带占位符：%q", id, q.Instructions)
		}
		tr, ok := truth[id]
		if !ok {
			t.Errorf("真源 QUESTIONS 里没有 %q——questions id 键集不全等", id)
			continue
		}
		// 逐字三方比对（FB-2 真三方）：模板 == fixture == 运行时读到的真源。
		if q.Instructions != w.instructions || w.instructions != tr.instructions {
			t.Errorf("%s instructions 三方不一致\n   模板: %q\nfixture: %q\n   真源: %q",
				id, q.Instructions, w.instructions, tr.instructions)
		}
		for _, k := range []string{"true", "false"} {
			wantVal := w.isTrue
			if k == "false" {
				wantVal = w.isFalse
			}
			if q.Criteria[k] != wantVal || wantVal != tr.criteria[k] {
				t.Errorf("%s criteria[%q] 三方不一致\n   模板: %q\nfixture: %q\n   真源: %q",
					id, k, q.Criteria[k], wantVal, tr.criteria[k])
			}
		}
		// 键集合全等（FB-2）②：criteria 键集——模板 == 真源条目 == judge-finding.mjs CRIT == fixture 形状。
		tplCritKeys := map[string]struct{}{}
		for k := range q.Criteria {
			tplCritKeys[k] = struct{}{}
		}
		for _, other := range []struct {
			name string
			keys map[string]struct{}
		}{
			{"真源 " + id, tr.criteriaKeySet},
			{"judge-finding.mjs CRIT", judgeCritKeys},
			{"fixture 形状", fixtureCritKeys},
		} {
			if !sameKeySet(tplCritKeys, other.keys) {
				t.Errorf("%s 的 criteria 键集 = %v 与 %s 的 %v 不全等（FB-2）",
					id, sortedKeys(tplCritKeys), other.name, sortedKeys(other.keys))
			}
		}
	}
}

// 最小反例（FB-2 配套）：键集合全等比较器**两个方向都要能红**——少键、多键都必须判不等。
// 只比「包含」的守护会漏掉多余键，等于装饰品。
func TestSameKeySetBothDirections(t *testing.T) {
	base := map[string]struct{}{"true": {}, "false": {}}
	if !sameKeySet(base, map[string]struct{}{"true": {}, "false": {}}) {
		t.Error("相同键集被判不等")
	}
	if sameKeySet(base, map[string]struct{}{"true": {}}) {
		t.Error("少一个键却被判相等——只比了包含方向？")
	}
	if sameKeySet(base, map[string]struct{}{"true": {}, "false": {}, "maybe": {}}) {
		t.Error("多一个键却被判相等——多余键必须让比对变红")
	}
}

// 最小反例（FB-2 配套）：真源解析器要被证明「抽得出、抽得全」——合成一条多 criteria 键的
// spec，多余键必须原样抽出来（否则真源里长出新键会被静默丢掉、比对恒真）。
func TestParseQuestionSpecExtractsAllCriteriaKeys(t *testing.T) {
	src := `x = { instructions: "问法甲", criteria: { true: "真", false: "假", maybe: "存疑" } };`
	open := strings.Index(src, "{")
	end, err := matchBrace(src, open)
	if err != nil {
		t.Fatalf("matchBrace: %v", err)
	}
	spec, err := parseQuestionSpec(src, open+1, end)
	if err != nil {
		t.Fatalf("parseQuestionSpec: %v", err)
	}
	if spec.instructions != "问法甲" {
		t.Errorf("instructions = %q，want 问法甲", spec.instructions)
	}
	if !sameKeySet(spec.criteriaKeySet, map[string]struct{}{"true": {}, "false": {}, "maybe": {}}) {
		t.Errorf("criteria 键集 = %v，want [false maybe true]——多余键被静默丢了？", sortedKeys(spec.criteriaKeySet))
	}
	if spec.criteria["maybe"] != "存疑" {
		t.Errorf("criteria[maybe] = %q，want 存疑", spec.criteria["maybe"])
	}
}

// ───────────── 审计：不含 state/questions 正文，不含 key ─────────────

func TestAuditNeverWritesSecretsOrPayload(t *testing.T) {
	s := newTestServer(t)
	s.audit(auditRecord{Model: pinnedModel, Questions: []string{"q1"}, StateTokensApprox: 7, LatencyMS: 12})
	raw, err := os.ReadFile(s.auditLog)
	if err != nil {
		t.Fatalf("读审计文件: %v", err)
	}
	line := string(raw)
	if strings.Contains(line, "test-key-never-sent") {
		t.Fatal("审计里出现了 API key")
	}
	for _, want := range []string{`"model":"jev-1.13.0"`, `"questions":["q1"]`, `"state_tokens_approx":7`, `"ts":`} {
		if !strings.Contains(line, want) {
			t.Errorf("审计行缺 %s：%s", want, line)
		}
	}
}

// ───────────── 有序对象遍历 ─────────────

func TestOrderedFields(t *testing.T) {
	fields, err := orderedFields(json.RawMessage(`{"b":1,"a":{"nested":true},"c":"x"}`))
	if err != nil {
		t.Fatalf("orderedFields: %v", err)
	}
	if len(fields) != 3 || fields[0].Key != "b" || fields[1].Key != "a" || fields[2].Key != "c" {
		t.Fatalf("键序不对：%+v", fields)
	}
	if string(fields[1].Value) != `{"nested":true}` {
		t.Errorf("嵌套值没原样保留：%s", fields[1].Value)
	}
	if f, err := orderedFields(json.RawMessage(`null`)); err != nil || f != nil {
		t.Errorf("null 该得到空结果：%v %v", f, err)
	}
	if _, err := orderedFields(json.RawMessage(`[1,2]`)); err == nil {
		t.Error("数组该报错")
	}
}

// ───────────── 结构化块字段纪律最小反例（FB-6/7/8/9）─────────────

// FB-6：choice 的 p 写入前，dist 里那个值必须先解析到 float64 校验成**合法 JSON number**——
// 非数值（字符串/null/对象/1e400 溢出）⇒ 回退 confidence；两者都不可用 ⇒ 省略 p（不补零）。
func TestStructuredPFallsBackToConfidenceWhenDistValueNotJSONNumber(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"dist 值是字符串 \"0.5\" → 回退 confidence",
			`{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":"0.5"}}`,
			`{"kind":"choice","choice":"A","p":0.55,"dist":{"A":"0.5"}}`},
		{"dist 值是 null → 回退 confidence",
			`{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":null}}`,
			`{"kind":"choice","choice":"A","p":0.55,"dist":{"A":null}}`},
		{"dist 值是对象 → 回退 confidence",
			`{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":{"x":1}}}`,
			`{"kind":"choice","choice":"A","p":0.55,"dist":{"A":{"x":1}}}`},
		{"dist 值 1e400 溢出 → 回退 confidence",
			`{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":1e400}}`,
			`{"kind":"choice","choice":"A","p":0.55,"dist":{"A":1e400}}`},
		{"dist 与 confidence 都不可用 → p 整个省略（不补零）",
			`{"type":"choice","choice":"A","probabilities":{"A":"0.5"}}`,
			`{"kind":"choice","choice":"A","dist":{"A":"0.5"}}`},
		{"dist 值是合法 number → 直接用它",
			`{"type":"choice","choice":"A","confidence":0.55,"probabilities":{"A":0.7}}`,
			`{"kind":"choice","choice":"A","p":0.7,"dist":{"A":0.7}}`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := structuredAnswer(json.RawMessage(tt.raw)); got != tt.want {
				t.Errorf("条目不符\n got: %s\nwant: %s", got, tt.want)
			}
		})
	}
}

// FB-7：远端没报 usage/input_tokens ⇒ 整个 usage 键省略，禁止 input_tokens:0 伪装实测值；
// 报了就照实写（两向断言，缺/不缺都必须能红）。
func TestStructuredUsageOmittedWhenRemoteDidNotReport(t *testing.T) {
	text, _, _, err := render(`{"answers":{"q":{"type":"noul","noul":0.8}}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	block := structuredBlockOf(t, text)
	if strings.Contains(block, "usage") || strings.Contains(block, "input_tokens") {
		t.Errorf("远端没报 usage，块里却出现 usage/input_tokens（补 0 伪装实测值）：%s", block)
	}

	text, _, _, err = render(`{"answers":{"q":{"type":"noul","noul":0.8}},"usage":{"input_tokens":7}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	block = structuredBlockOf(t, text)
	if !strings.Contains(block, `"usage":{"input_tokens":7}`) {
		t.Errorf("远端报了 7 token，块里却没有 usage（FB-7 只许缺时省略）：%s", block)
	}
}

// FB-8：choice 为空串 ⇒ choice 与 p **同在同缺**——「kind:choice 无选项有概率」的悬空条目
// 不许出现（那个概率属于谁说不清）。
func TestStructuredChoiceEmptyOmitsPWithChoice(t *testing.T) {
	got := structuredAnswer(json.RawMessage(`{"type":"choice","confidence":0.9,"probabilities":{"A":0.6,"B":0.4}}`))
	want := `{"kind":"choice","dist":{"A":0.6,"B":0.4}}`
	if got != want {
		t.Errorf("choice 为空却写了 p（悬空条目）\n got: %s\nwant: %s", got, want)
	}
	// 反向：choice 有值时两者同在。
	got = structuredAnswer(json.RawMessage(`{"type":"choice","choice":"A","probabilities":{"A":0.6}}`))
	want = `{"kind":"choice","choice":"A","p":0.6,"dist":{"A":0.6}}`
	if got != want {
		t.Errorf("choice 有值时 p/choice 该同在\n got: %s\nwant: %s", got, want)
	}
}

// FB-9：type 缺失但字段可判时**推断** kind（有概率值→noul、有 score→score、有 choice→choice），
// 推不出才 unknown 且 unknown 保留 confidence；已有数据不许静默丢。
func TestStructuredInfersKindWhenTypeMissing(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"有概率值（.noul）→ noul", `{"noul":0.31}`, `{"kind":"noul","p":0.31}`},
		{"有 score → score", `{"score":0.75}`, `{"kind":"score","p":0.75}`},
		{"有 choice → choice", `{"choice":"B","probabilities":{"B":0.2}}`, `{"kind":"choice","choice":"B","p":0.2,"dist":{"B":0.2}}`},
		{"推不出但有 confidence → unknown 保留 confidence", `{"confidence":0.42}`, `{"kind":"unknown","p":0.42}`},
		{"什么都没有 → unknown 不补零", `{}`, `{"kind":"unknown"}`},
		{"type 不是字符串也按缺失推断（不丢已有数据）", `{"type":123,"noul":0.5}`, `{"kind":"noul","p":0.5}`},
		{"显式未知 type 也保留 confidence（不丢已有数据）", `{"type":"mystery","confidence":0.42}`, `{"kind":"mystery","p":0.42}`},
		{"type 不是对象 → 只报存在性", `[1,2]`, `{"kind":"unknown"}`},
		// PiMoa verify 2026-09-22 确认的 MINOR 反例：推断看「数值可用」而不是「字段存在」——
		// 垃圾值不许被推成 kind=score/noul（那会既写不出 p、又把同行 confidence 丢掉）。
		{"score 是垃圾值 → 不推 score，退 unknown 保留 confidence", `{"score":"high","confidence":0.4}`, `{"kind":"unknown","p":0.4}`},
		{"noul 是垃圾值 → 不推 noul，退 unknown 保留 confidence", `{"noul":"0.5","confidence":0.4}`, `{"kind":"unknown","p":0.4}`},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := structuredAnswer(json.RawMessage(tt.raw)); got != tt.want {
				t.Errorf("条目不符\n got: %s\nwant: %s", got, tt.want)
			}
		})
	}
}

// ───────────── 模板 source 锚点与 description 尾注（FB-3/4/5 最小配套）─────────────
//
// FB-3：source 的 #…:A-B 锚点必须真的指向真源里**含该文案**的行——真源一改版、锚点没跟，
// 这里当场红，别留一个查不到的地址（对应「改后逐一 read 核对锚点行确含该文案」的机械版）。
// FB-4：description 尾注六份统一换新版；旧尾注（六份都无占位符，已误导）不许再出现。
// FB-5：六份一律锚 jevcheck.ts（link 已从 judge-finding.mjs 重锚到 FACT_LINK_SPEC）。
var anchorRangeRE = regexp.MustCompile(`:(\d+)-(\d+)`)

func TestTemplateSourceAnchorsAndDescriptionTail(t *testing.T) {
	srcLines := strings.Split(readTruthSource(t, jevcheckTruthPath), "\n")
	const wantTail = "静态问法：判定材料/命题置于 state；可直接经 jev_judge_with_template 调用。带占位符的未来模板才需消费侧拼装或 A4 槽位替换。"
	const oldTail = "需消费侧拼装走 jev_judge，或待 A4 槽位替换。"

	for _, id := range []string{"fact", "link", "fixed", "entail", "same", "opposite"} {
		raw, err := os.ReadFile(filepath.Join(defaultTemplateDir(), id+".json"))
		if err != nil {
			t.Fatalf("读模板 %s：%v", id, err)
		}
		var tpl struct {
			Source      string `json:"source"`
			Description string `json:"description"`
			Questions   map[string]struct {
				Instructions string            `json:"instructions"`
				Criteria     map[string]string `json:"criteria"`
			} `json:"questions"`
		}
		if err := json.Unmarshal(raw, &tpl); err != nil {
			t.Fatalf("%s 解析失败：%v", id, err)
		}
		if !strings.HasSuffix(tpl.Description, wantTail) {
			t.Errorf("%s.description 尾注不是统一新尾注（FB-4）：%q", id, tpl.Description)
		}
		if strings.Contains(tpl.Description, oldTail) {
			t.Errorf("%s.description 还留着旧尾注（FB-4）：%q", id, tpl.Description)
		}
		if !strings.HasPrefix(tpl.Source, jevcheckTruthPath+"#") {
			t.Errorf("%s.source 没锚在 jevcheck.ts（FB-3/5）：%s", id, tpl.Source)
		}
		q := tpl.Questions[id]
		texts := []string{q.Instructions, q.Criteria["true"], q.Criteria["false"]}
		m := anchorRangeRE.FindStringSubmatch(tpl.Source)
		if m == nil {
			t.Errorf("%s.source 没有 :A-B 形锚点：%s", id, tpl.Source)
			continue
		}
		lo, _ := strconv.Atoi(m[1])
		hi, _ := strconv.Atoi(m[2])
		if lo < 1 || hi > len(srcLines) || lo > hi {
			t.Errorf("%s.source 锚点 %d-%d 越界（真源共 %d 行）", id, lo, hi, len(srcLines))
			continue
		}
		region := strings.Join(srcLines[lo-1:hi], "\n")
		for _, want := range texts {
			if want == "" {
				t.Errorf("%s 的问法有空值，无法核锚点", id)
				continue
			}
			if !strings.Contains(region, want) {
				t.Errorf("%s.source 锚点 %d-%d 行不含文案 %q——锚点漂了，需按真源实测行重锚", id, lo, hi, want)
			}
		}
	}
}
