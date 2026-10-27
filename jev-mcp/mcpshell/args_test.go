package mcpshell

import (
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func reqWith(args string) *mcp.CallToolRequest {
	return &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Arguments: json.RawMessage(args)},
	}
}

// 这条是本文件的存在理由：客户端给的嵌套键序必须原样取回，
// 不能是 go-sdk re-marshal 后的字母序。
func TestRawArgPreservesCallerKeyOrder(t *testing.T) {
	got := RawArg(reqWith(`{"state":"s","questions":{"zeta":1,"alpha":2,"mid":3}}`), "questions")
	if string(got) != `{"zeta":1,"alpha":2,"mid":3}` {
		t.Errorf("键序没保住：%s", got)
	}
}

func TestRawArgReturnsExactBytesIncludingWhitespace(t *testing.T) {
	got := RawArg(reqWith(`{"state":{"b": 1,  "a": 2}}`), "state")
	if string(got) != `{"b": 1,  "a": 2}` {
		t.Errorf("原文字节没保住：%q", got)
	}
}

func TestRawArgStringAndScalarFields(t *testing.T) {
	r := reqWith(`{"state":"材料","template":"t1","n":7,"flag":true,"nil":null}`)
	cases := map[string]string{
		"state":    `"材料"`,
		"template": `"t1"`,
		"n":        `7`,
		"flag":     `true`,
		"nil":      `null`,
	}
	for k, want := range cases {
		if got := string(RawArg(r, k)); got != want {
			t.Errorf("RawArg(%q)=%s, want %s", k, got, want)
		}
	}
}

func TestRawArgMissingOrMalformedReturnsNil(t *testing.T) {
	if RawArg(reqWith(`{"a":1}`), "b") != nil {
		t.Error("不存在的键该返回 nil")
	}
	if RawArg(reqWith(`[1,2]`), "a") != nil {
		t.Error("非对象 arguments 该返回 nil")
	}
	if RawArg(reqWith(``), "a") != nil {
		t.Error("空 arguments 该返回 nil")
	}
	if RawArg(nil, "a") != nil {
		t.Error("nil req 该返回 nil")
	}
	if RawArg(&mcp.CallToolRequest{}, "a") != nil {
		t.Error("nil Params 该返回 nil")
	}
}

func TestRawArgOrFallsBackToTypedValue(t *testing.T) {
	fallback := json.RawMessage(`{"alpha":1,"zeta":2}`)
	// 原文里有 → 用原文
	if got := RawArgOr(reqWith(`{"questions":{"zeta":2,"alpha":1}}`), "questions", fallback); string(got) != `{"zeta":2,"alpha":1}` {
		t.Errorf("有原文却用了兜底：%s", got)
	}
	// 原文里没有 → 用兜底
	if got := RawArgOr(reqWith(`{"other":1}`), "questions", fallback); string(got) != string(fallback) {
		t.Errorf("没走兜底：%s", got)
	}
	// arguments 整块拿不到 → 用兜底
	if got := RawArgOr(nil, "questions", fallback); string(got) != string(fallback) {
		t.Errorf("nil req 没走兜底：%s", got)
	}
}
