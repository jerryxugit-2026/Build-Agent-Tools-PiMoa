package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 本文件钉住 PiMoa review 2026-09-19 对 jev 抓出的三条 MAJOR + 两条 MINOR。
// 共同点：它们全都属于**不报错、只是错**那一类——最贵的失败方式。

// MAJOR：远端 HTTP 200 但漏答，原来会以「成功」回给 agent，那道题在输出里静默消失。
func TestIncompleteAnswersAreFlaggedAsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		// 问了 q1/q2/q3，只答 q1 与 q3
		_, _ = w.Write([]byte(`{"answers":{"q1":{"type":"noul","noul":0.9},` +
			`"q3":{"type":"noul","noul":0.2}}}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"材料"`),
		json.RawMessage(`{"q1":{},"q2":{},"q3":{}}`))
	if !isErr {
		t.Fatal("漏答了一题却报成功——agent 会以为 q2 没拿到结果是「判定为否」")
	}
	if !strings.Contains(text, "q2") {
		t.Errorf("没点名缺的是哪一题：%s", text)
	}
	if !strings.Contains(text, "不要当作") {
		t.Errorf("没告诉 agent 缺题不等于否定：%s", text)
	}
	if s.stats.Served() != 0 {
		t.Errorf("served=%d，漏答不该计成一次成功服务", s.stats.Served())
	}
}

// MAJOR：answers 根本不是对象时，orderedFields 的 err 原来被 `_` 丢掉，
// 渲染成「没有 answers」后照样以成功返回。
func TestMalformedAnswersIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"answers":["不是对象"]}`))
	}))
	defer srv.Close()

	s := newTestServer(t)
	s.apiURL = srv.URL
	text, isErr := s.callJev(context.Background(), json.RawMessage(`"材料"`),
		json.RawMessage(`{"q":{}}`))
	if !isErr {
		t.Fatalf("畸形 answers 却报成功：%s", text)
	}
	if s.stats.Served() != 0 {
		t.Errorf("served=%d，畸形响应不该计成成功", s.stats.Served())
	}
	// ⚠️ 必须断言到「结构异常」这个具体归因，不能只断言 isErr。
	// 实测（2026-09-19）：光断言 isErr 时，即使把 orderedFields 的 err 传播撤掉，
	// 这条测试也照样绿——因为答案完整性校验会把它兜成「漏答」。两条修复覆盖面重叠，
	// 只断言结果就分不出是哪条在起作用，等于没锁住这一条。
	if !strings.Contains(text, "结构异常") {
		t.Errorf("归因错了：answers 不是对象应报「结构异常」，而不是笼统的漏答。实际：%s", text)
	}
}

// MAJOR：图像这条能力边界必须出现在 agent 看得见的地方（工具描述 + 每次判读提示），
// 因为它的失败方式是静默给假答案，没有任何监控能发现。
func TestImageLimitationIsVisibleToAgent(t *testing.T) {
	text, _, _, err := render(`{"answers":{"q":{"type":"noul","noul":0.9}}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(text, "图像") {
		t.Error("每次判读提示里没提图像——agent 不会知道喂图像会得到假答案")
	}
}

// MINOR：noul 缺失时不能拿零值渲染成「不成立（P=0.000）」这种毫无依据的确定性结论。
func TestMissingNoulIsNotRenderedAsDefiniteVerdict(t *testing.T) {
	text, _, _, err := render(`{"answers":{"q":{"type":"noul"}}}`)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(text, "P(成立)=0.000") {
		t.Errorf("noul 缺失被渲染成了确定的「不成立」：%s", text)
	}
	if !strings.Contains(text, "[异常]") {
		t.Errorf("noul 缺失没被标成异常：%s", text)
	}
}

// MINOR：空 state / null state 要在发请求之前就挡掉，别花一次远端调用
// 换一个基于空材料、却照样带着高置信度的判定。
func TestEmptyStateIsRejectedBeforeUpstream(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"answers":{"q":{"type":"noul","noul":0.9}}}`))
	}))
	defer srv.Close()

	for _, st := range []string{`null`, `""`, `   `} {
		s := newTestServer(t)
		s.apiURL = srv.URL
		_, isErr := s.callJev(context.Background(), json.RawMessage(st),
			json.RawMessage(`{"q":{}}`))
		if !isErr {
			t.Errorf("state=%s 被放行了", st)
		}
	}
	if hits != 0 {
		t.Errorf("空 state 竟然发了 %d 次请求到上游", hits)
	}
}

// MINOR：不同状态码要给出不同的下一步，否则 agent 没法决策。
func TestStatusCodeAdviceIsActionable(t *testing.T) {
	cases := map[int]string{
		401: "凭据",
		429: "限流",
		500: "服务端故障",
		400: "不合法",
	}
	for status, want := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"x"}`))
		}))
		s := newTestServer(t)
		s.apiURL = srv.URL
		text, isErr := s.callJev(context.Background(), json.RawMessage(`"材料"`),
			json.RawMessage(`{"q":{}}`))
		srv.Close()
		if !isErr {
			t.Errorf("HTTP %d 报成了成功", status)
		}
		if !strings.Contains(text, want) {
			t.Errorf("HTTP %d 的指引里没有 %q：%s", status, want, text)
		}
	}
}
