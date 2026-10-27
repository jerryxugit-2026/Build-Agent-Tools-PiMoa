package mcpshell

import (
	"bytes"
	"log"
	"testing"
)

// EnvBool 是本批（review 串行闸）新增的读取器。它必须与 EnvPositiveInt 分工明确：
// 开关类旋钮里 0 是**最常用的「关」**，而 EnvPositiveInt 把 0 当坏值 —— 拿它读开关
// 会让「置 0 关掉」被回落到默认的**开**，正好与调用方意图相反。这条测试钉住这点。
func TestEnvBool(t *testing.T) {
	cases := []struct {
		raw      string
		fallback bool
		want     bool
		warned   bool
	}{
		// 未设置/空串 → fallback（两个方向都要对，不能硬编码成某一侧）。
		{"", true, true, false},
		{"", false, false, false},
		{"   ", true, true, false},
		// 显式开。
		{"1", false, true, false},
		{"true", false, true, false},
		{"TRUE", false, true, false},
		{"on", false, true, false},
		{"yes", false, true, false},
		{" 1 ", false, true, false},
		// 显式关 —— 这是它存在的理由：EnvPositiveInt 在这里会回落到默认值。
		{"0", true, false, false},
		{"false", true, false, false},
		{"OFF", true, false, false},
		{"no", true, false, false},
		// 坏值：回落 fallback **并且喊出来**（静默回落等于把一次配置手误变成
		// 一个只能靠压测才发现的运行时缺陷，见 env.go 文件头）。
		{"maybe", true, true, true},
		{"2", false, false, true},
		{"-1", true, true, true},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			t.Setenv("TEST_ENVBOOL", c.raw)
			var buf bytes.Buffer
			got := EnvBool("TEST_ENVBOOL", c.fallback, log.New(&buf, "", 0))
			if got != c.want {
				t.Errorf("EnvBool(%q, fallback=%v)=%v want %v", c.raw, c.fallback, got, c.want)
			}
			if warned := buf.Len() > 0; warned != c.warned {
				t.Errorf("EnvBool(%q) 的 warn 行为不对：warned=%v want %v（输出 %q）",
					c.raw, warned, c.warned, buf.String())
			}
		})
	}

	// 名字没设过时也该回落，且不 warn。
	t.Run("env 不存在", func(t *testing.T) {
		var buf bytes.Buffer
		if got := EnvBool("TEST_ENVBOOL_NOT_SET_ANYWHERE", true, log.New(&buf, "", 0)); got != true {
			t.Errorf("未设置的 env 该回落 fallback，got %v", got)
		}
		if buf.Len() != 0 {
			t.Errorf("未设置不该 warn：%q", buf.String())
		}
	})
}
