package mcpshell

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// 配置读取的统一纪律：坏配置**宁可回落默认值并喊出来**，绝不静默生效。
//
// 这条是 2026-09-18 在 jev-mcp 压测里换来的（Node 版同源注释）：那边用裸 Number()
// 读 env，非数字得到 NaN，而 NaN 让 setInterval 按 0ms 忙循环烧 CPU、又让两处
// 比较恒为 false——清扫与硬上限双双静默失效，退回泄漏形态。Go 的 strconv 会给
// error 而不是 NaN，但「坏值必须喊出来」这条纪律与语言无关：静默回落等于把一次
// 配置手误变成一个只能靠压测才发现的运行时缺陷。

// Env 读字符串型 env；空串视作未设置。
func Env(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// EnvPositiveInt 读正整数 env（端口、上限一类）。非正数/非数字一律回落并 warn。
func EnvPositiveInt(name string, fallback int, logger *log.Logger) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		warn(logger, "⚠ %s=%q 不是正整数，已忽略并回落默认值 %d", name, raw, fallback)
		return fallback
	}
	return n
}

// EnvNonNegativeInt 同上，但允许 0——某些旋钮里 0 是「禁用」而不是坏值。
func EnvNonNegativeInt(name string, fallback int, logger *log.Logger) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		warn(logger, "⚠ %s=%q 不是非负整数，已忽略并回落默认值 %d", name, raw, fallback)
		return fallback
	}
	return n
}

// EnvBool 读开关型 env。**空串/未设置视作 fallback**；"0"/"false"/"off"/"no"
// 是显式的「关」，"1"/"true"/"on"/"yes" 是显式的「开」；其余坏值一律回落 fallback
// 并 warn（同本文件顶部那条「坏配置宁可回落默认值并喊出来」的纪律）。
//
// 与 EnvPositiveInt 的分工：那个函数把 0 当**坏值**（端口、上限里 0 无意义），
// 而开关类旋钮里 0 恰恰是最常用的「关」——用 EnvPositiveInt 读开关会导致
// 「置 0 关掉」被当成坏值而**回落到默认的开**，正好与调用方意图相反。
func EnvBool(name string, fallback bool, logger *log.Logger) bool {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "1", "true", "on", "yes":
		return true
	case "0", "false", "off", "no":
		return false
	default:
		warn(logger, "⚠ %s=%q 不是开关值（0/1/true/false/on/off/yes/no），已忽略并回落默认值 %v", name, raw, fallback)
		return fallback
	}
}

// EnvDuration 读时长 env：纯数字按毫秒解（与 Node 版 *_MS 口径一致），
// 带单位则按 Go 的 time.ParseDuration（"90s"/"20m"）。claude-dispatch /
// antigravity 那两个长任务服务的超时旋钮要用它。
func EnvDuration(name string, fallback time.Duration, logger *log.Logger) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	if ms, err := strconv.Atoi(raw); err == nil {
		if ms <= 0 {
			warn(logger, "⚠ %s=%q 不是正数毫秒，已忽略并回落默认值 %s", name, raw, fallback)
			return fallback
		}
		return time.Duration(ms) * time.Millisecond
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		warn(logger, "⚠ %s=%q 不是合法时长（毫秒数或 90s/20m），已忽略并回落默认值 %s", name, raw, fallback)
		return fallback
	}
	return d
}

func warn(logger *log.Logger, format string, args ...any) {
	if logger == nil {
		return
	}
	logger.Printf(format, args...)
}
