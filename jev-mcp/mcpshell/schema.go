package mcpshell

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/google/jsonschema-go/jsonschema"
)

// MustSchema 从入参结构体推出工具的 inputSchema，再让调用方补 zod 式的取值约束
// （enum / 上下界 / minLength——这些没法只靠 Go 类型表达）。
//
// 推断规则（jsonschema-go）：`json:"x"` 决定字段名，没有 omitempty 的字段进
// required，`jsonschema:"…"` 标签的内容就是该字段的 description，结构体一律
// additionalProperties:false。这三条合起来正好等于 Node 版用 zod 写出来的形状。
//
// 注册期出错直接 panic：工具 schema 写错是编码缺陷，不该退化成一个运行时才暴露
// 的「工具在，但入参永远校验不过」的坏服务。
func MustSchema[T any](constrain func(props map[string]*jsonschema.Schema)) *jsonschema.Schema {
	schema, err := jsonschema.For[T](nil)
	if err != nil {
		panic(fmt.Sprintf("mcpshell.MustSchema: %v", err))
	}
	if constrain != nil {
		constrain(schema.Properties)
	}
	return schema
}

// Ptr 是给 jsonschema 那些 *float64/*int 约束字段用的取址助手。
func Ptr[T any](v T) *T { return &v }

// TypeArrayPaths 递归找出 schema（已序列化再解码的 JSON 值，或任何可 json.Marshal 的值）里
// 所有「"type" 写成数组」的位置，返回 JSON 路径（如 `$.properties.state.type`）；无则返回 nil。
//
// 为什么要钉（2026-09-30 RCA，<workspace>/artifacts/mimo-toolcall-args-rca-20260930/REPORT.md）：
// 小米 MiMo 服务端的流式 tool parser 遇到 `"type": [...]` 联合类型写法，只下发
// `{"<key>": ` 就中断，参数整体丢失；单一 type 或 anyOf 则正常。jsonschema-go 对
// slice / map / 指针 / json.RawMessage 会推出 `["null", X]`，而本仓各工具在 constrain 里
// 也手写过 Types，所以这条约束只能靠测试对**对外 tools/list 的真实 inputSchema** 递归断言。
func TypeArrayPaths(v any) []string {
	raw, err := json.Marshal(v)
	if err != nil {
		return []string{fmt.Sprintf("$<marshal error: %v>", err)}
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return []string{fmt.Sprintf("$<unmarshal error: %v>", err)}
	}
	var out []string
	var walk func(path string, node any)
	walk = func(path string, node any) {
		switch n := node.(type) {
		case map[string]any:
			keys := make([]string, 0, len(n))
			for k := range n {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if _, isArr := n[k].([]any); isArr && k == "type" {
					out = append(out, path+".type")
				}
				walk(path+"."+k, n[k])
			}
		case []any:
			for i, e := range n {
				walk(fmt.Sprintf("%s[%d]", path, i), e)
			}
		}
	}
	walk("$", doc)
	return out
}
