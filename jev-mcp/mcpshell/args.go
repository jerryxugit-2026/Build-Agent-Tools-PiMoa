package mcpshell

import (
	"bytes"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// RawArg 从**客户端原始的 arguments 字节**里取一个顶层字段，保住它的键序与原文。
//
// 为什么需要它（2026-09-18 在 jev 的 Node/Go 对照里抓出来的真差异）：
// go-sdk 的 applySchema（mcp/tool.go）为了套用 schema 默认值与校验，会把 arguments
// 先 Unmarshal 成 map[string]any，再 json.Marshal 回去——而 encoding/json **对 map
// 的键按字母序排序**。于是 typed handler 收到的 In 结构体里，任何嵌套对象的键序都已
// 被重排成字母序，客户端给的原始顺序丢了。
//
// 对 jev 这类「把 questions 原样转发给判定模型」的壳，这是实质差异而非美观问题：
//   - 输出行序跟着 answers 键序走，与 Node 版不再一致，跨版本逐行比对失效；
//   - 更要紧的是送进模型的 prompt 里问题顺序变了。判定模型的输出对提示顺序不保证
//     不敏感，而本壳存在的全部理由就是「同类判断每次问法完全一致，概率才可跨轮比较」。
//
// 好在 applySchema 的结果只赋给局部变量，**req.Params.Arguments 本身没有被改写**，
// 所以原始字节仍然拿得到。校验与默认值仍由 SDK 正常完成（我们不绕过它），
// 这里只为需要字节保真的字段绕过那一次 re-marshal。
//
// 拿不到时返回 nil，由调用方回落到 typed 字段（见 RawArgOr）。
func RawArg(req *mcp.CallToolRequest, key string) json.RawMessage {
	if req == nil || req.Params == nil || len(req.Params.Arguments) == 0 {
		return nil
	}
	raw := bytes.TrimSpace(req.Params.Arguments)
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil { // 吃掉 '{'
		return nil
	}
	// ⚠️ 顶层同名键重复时必须取**最后一个**，不能命中即返回。
	// 原因（PiMoa review 2026-09-19）：SDK 那边走的是 map[string]any 反序列化，
	// 重复键的语义就是后者覆盖前者；这里若返回第一个，就会出现「schema 校验过的是
	// 后者、实际转发给远端的是前者」——一次输入校验绕过。JSON 规范对重复键未做规定，
	// 各家实现不一，所以唯一安全的做法是**和同进程里的另一个解析器保持一致**。
	// 代价是不能提前退出、每次都要扫完整个对象；MCP 工具入参本来就小，可以忽略。
	var found json.RawMessage
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil
		}
		name, ok := keyTok.(string)
		if !ok {
			return nil
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil
		}
		if name == key {
			found = val
		}
	}
	return found
}

// RawArgOr 取原始字节，取不到就用 typed handler 解出来的值兜底。
// 兜底路径下键序是字母序（SDK re-marshal 的结果），但语义仍然正确——
// 宁可键序被重排，也不能因为拿不到原文就让整次调用失败。
func RawArgOr(req *mcp.CallToolRequest, key string, fallback json.RawMessage) json.RawMessage {
	raw := RawArg(req, key)
	// 显式的 null 要当作「没给」走兜底，不能原样转发（PiMoa review 2026-09-19）：
	// `{"k":null}` 拿到的是 4 字节的 "null"，len>0 会让它绕过兜底、把字面 null 发给远端；
	// 而 SDK 那边 typed 字段解出来的是零值。两者不一致，且 null 几乎不会是调用方的本意。
	if len(raw) > 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return raw
	}
	return fallback
}
