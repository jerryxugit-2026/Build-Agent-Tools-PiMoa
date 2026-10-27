package mcpshell

import (
	"encoding/json"
	"slices"
	"testing"
)

// TypeArrayPaths 自身的判定口径：只认 "type" 键的值是数组；单一 type、anyOf 分支、
// 名为 type 的属性（其值是子 schema 对象）都不算。
func TestTypeArrayPaths(t *testing.T) {
	cases := map[string]struct {
		schema string
		want   []string
	}{
		"单一 type":     {`{"type":"object","properties":{"a":{"type":"string"}}}`, nil},
		"anyOf 分支":    {`{"type":"object","properties":{"a":{"anyOf":[{"type":"string"},{"type":"object"}]}}}`, nil},
		"名为 type 的属性": {`{"type":"object","properties":{"type":{"type":"string"}},"required":["type"]}`, nil},
		"顶层属性数组 type": {`{"type":"object","properties":{"s":{"type":["string","object"]}}}`,
			[]string{"$.properties.s.type"}},
		"单元素数组也算": {`{"type":"object","properties":{"q":{"type":["object"]}}}`,
			[]string{"$.properties.q.type"}},
		"嵌套 items / anyOf 内": {`{"type":"object","properties":{"w":{"anyOf":[{"type":"null"},` +
			`{"type":"array","items":{"type":"object","properties":{"p":{"type":["null","string"]}}}}]}}}`,
			[]string{"$.properties.w.anyOf[1].items.properties.p.type"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := TypeArrayPaths(json.RawMessage(tc.schema))
			if !slices.Equal(got, tc.want) {
				t.Errorf("TypeArrayPaths=%v，want %v", got, tc.want)
			}
		})
	}
}

// 钉住生成器的现状（取舍依据）：jsonschema-go 对 slice / json.RawMessage 推出的就是
// `["null","array"]` 数组 type。MustSchema 不在生成器层统一改写——各工具在 constrain 里
// 显式写成单一 type 或 anyOf，由各服务的「对外 tools/list 无数组 type」测试兜底。
// 本断言若变红，说明 jsonschema-go 升级改了推断口径，需重新评估上述取舍。
func TestMustSchemaGeneratorEmitsTypeArraysForSlices(t *testing.T) {
	type in struct {
		Raw json.RawMessage `json:"raw"`
		Xs  []string        `json:"xs"`
		S   string          `json:"s"`
	}
	s := MustSchema[in](nil)
	got := TypeArrayPaths(s)
	want := []string{"$.properties.raw.type", "$.properties.xs.type"}
	if !slices.Equal(got, want) {
		t.Errorf("生成器数组 type 位置=%v，want %v", got, want)
	}
}
