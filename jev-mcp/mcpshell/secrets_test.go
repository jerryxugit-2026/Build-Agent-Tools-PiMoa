package mcpshell

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// secrets.env 里放着全套生产密钥，薄壳只需要其中一个。这组测试钉住两件事：
// ①只取指定键；②其余内容绝不出现在返回值或日志里。
func TestSecretFromEnvFileTakesOnlyTheNamedKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secrets.env")
	content := strings.Join([]string{
		"# 注释行",
		"OPENAI_API_KEY=sk-OTHER-SECRET-1",
		"export TYPESAFE_API_KEY=ts-the-one",
		"ANTHROPIC_API_KEY=\"sk-OTHER-SECRET-2\"",
		"TYPESAFE_API_KEY_BACKUP=ts-should-not-match",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	var logBuf bytes.Buffer
	logger := log.New(&logBuf, "", 0)
	got := SecretFromEnvFile(path, "TYPESAFE_API_KEY", logger)
	if got != "ts-the-one" {
		t.Fatalf("取到 %q，want %q", got, "ts-the-one")
	}
	for _, leaked := range []string{"sk-OTHER-SECRET-1", "sk-OTHER-SECRET-2", "ts-should-not-match"} {
		if strings.Contains(logBuf.String(), leaked) {
			t.Errorf("日志里泄漏了其他密钥 %q：%s", leaked, logBuf.String())
		}
	}
}

func TestSecretFromEnvFileStripsPairedQuotesOnly(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		`K="quoted"`:    "quoted",
		`K='single'`:    "single",
		`K=bare`:        "bare",
		`K=  spaced  `:  "spaced",
		`K="unbalanced`: `"unbalanced`, // 单边引号是值的一部分
		`export K=exp`:  "exp",
	}
	for line, want := range cases {
		path := filepath.Join(dir, "s.env")
		if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := SecretFromEnvFile(path, "K", nil); got != want {
			t.Errorf("%q → %q, want %q", line, got, want)
		}
	}
}

// 前缀相同的键名不能误命中（TYPESAFE_API_KEY vs TYPESAFE_API_KEY_BACKUP）。
func TestSecretFromEnvFileDoesNotPrefixMatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.env")
	if err := os.WriteFile(path, []byte("KEY_LONGER=wrong\nKEY=right\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := SecretFromEnvFile(path, "KEY", nil); got != "right" {
		t.Errorf("got %q, want %q", got, "right")
	}
}

func TestSecretFromEnvFileMissingFileIsSilent(t *testing.T) {
	var logBuf bytes.Buffer
	logger := log.New(&logBuf, "", 0)
	if got := SecretFromEnvFile(filepath.Join(t.TempDir(), "nope.env"), "K", logger); got != "" {
		t.Errorf("got %q, want 空串", got)
	}
	if logBuf.Len() != 0 {
		t.Errorf("文件不存在不该刷日志（启动时的常态）：%s", logBuf.String())
	}
}

func TestSecretPrefersEnvVar(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.env")
	if err := os.WriteFile(path, []byte("MYKEY=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MYKEY", "from-env")
	if got := Secret("MYKEY", path, "MYKEY", nil); got != "from-env" {
		t.Errorf("环境变量没优先：%q", got)
	}
	t.Setenv("MYKEY", "   ") // 空白视作未设置
	if got := Secret("MYKEY", path, "MYKEY", nil); got != "from-file" {
		t.Errorf("空白环境变量该回落到文件：%q", got)
	}
}

// 长单行（JSON 型凭据）不能被默认 64KiB 行上限截断。
func TestSecretFromEnvFileHandlesLongLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.env")
	long := strings.Repeat("a", 200_000)
	if err := os.WriteFile(path, []byte("K="+long+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := SecretFromEnvFile(path, "K", nil); got != long {
		t.Errorf("长行被截断了：取到 %d 字节，want %d", len(got), len(long))
	}
}
