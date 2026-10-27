package main

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/jerryxugit-2026/Build-Agent-Tools-PiMoa/jev-mcp/mcpshell"
)

// 对外 tools/list 里每个工具的 inputSchema 都**不得**出现数组形 type（递归检查）。
//
// 根因（2026-09-30 RCA，<workspace>/artifacts/mimo-toolcall-args-rca-20260930/REPORT.md）：
// 小米 MiMo 服务端流式 tool parser 遇到 `"type": [...]` 只下发 `{"<key>": ` 就中断，参数整体丢失。
// 断言对象是**经 go-sdk 真实 tools/list 下发**的 schema（不是本包的 schema 函数），
// 这样新增工具、健康工具、SDK 侧的序列化都一并覆盖。
func TestToolInputSchemasHaveNoTypeArrays(t *testing.T) {
	ctx := t.Context()
	srv := mcp.NewServer(&mcp.Implementation{Name: "typearray-test", Version: "0.0.0"}, nil)
	newTestServer(t).register(srv)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "typearray-client", Version: "0.0.0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(res.Tools) < 3 {
		t.Fatalf("tools/list 只回了 %d 个工具，want ≥3", len(res.Tools))
	}
	for _, tool := range res.Tools {
		if paths := mcpshell.TypeArrayPaths(tool.InputSchema); len(paths) > 0 {
			t.Errorf("工具 %s 的 inputSchema 含数组形 type（MiMo 会截断参数）：%v", tool.Name, paths)
		}
	}
}

// 接受集等价：state 旧写法 `type:["string","object"]`（+ RawMessage 残留 items）与新 anyOf 逐项同判；
// questions 旧写法 `type:["object"]` 与新单一 type 逐项同判。
func TestJudgeSchemaAcceptSetUnchanged(t *testing.T) {
	values := []string{`"x"`, `""`, `{}`, `{"fact":1}`, `null`, `[]`, `[1,2]`, `1`, `true`}
	residual := &jsonschema.Schema{Type: "integer", Minimum: mcpshell.Ptr(0.0), Maximum: mcpshell.Ptr(255.0)}
	oldState := &jsonschema.Schema{Types: []string{"string", "object"}, Items: residual}
	oldQuestions := &jsonschema.Schema{Types: []string{"object"}, Items: residual}
	equivAcceptSet(t, oldState, judgeSchema().Properties["state"], values)
	equivAcceptSet(t, oldState, judgeTemplateSchema().Properties["state"], values)
	equivAcceptSet(t, oldQuestions, judgeSchema().Properties["questions"], values)
}

// equivAcceptSet 对同一组取值，断言 oldS 与 newS 的接受/拒收结论逐项一致（接受集不变的机械证据）。
func equivAcceptSet(t *testing.T, oldS, newS *jsonschema.Schema, values []string) {
	t.Helper()
	ro, err := oldS.Resolve(nil)
	if err != nil {
		t.Fatalf("Resolve(old): %v", err)
	}
	rn, err := newS.Resolve(nil)
	if err != nil {
		t.Fatalf("Resolve(new): %v", err)
	}
	for _, raw := range values {
		var v any
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatalf("坏用例 %s：%v", raw, err)
		}
		okOld, okNew := ro.Validate(v) == nil, rn.Validate(v) == nil
		if okOld != okNew {
			t.Errorf("取值 %s：旧 schema 接受=%v，新 schema 接受=%v（接受集变了）", raw, okOld, okNew)
		}
	}
}
