package mcpshell

import (
	"bufio"
	"log"
	"os"
	"regexp"
	"strings"
)

// SecretFromEnvFile 从一个 KEY=VALUE 形态的 env 文件里**只取指定的一个键**。
//
// 纪律（jev-mcp Node 版同源，是本函数存在的全部理由）：secrets.env 里放着全套
// 生产密钥，薄壳只需要其中一个。所以这里逐行扫、命中即返回，**绝不**把整份文件
// 灌进 os.Setenv、绝不把其余行写进日志、命中的值也绝不出现在任何日志/错误文案里。
// 读文件失败只报「读取失败 + 错误原因」，不带文件内容。
//
// 语法容忍 `export KEY=value`、两侧空白、成对的单/双引号包裹（与 shell 的 env
// 文件惯例一致）。不做 shell 展开：`$OTHER` 原样返回，因为薄壳不是 shell。
func SecretFromEnvFile(path, key string, logger *log.Logger) string {
	f, err := os.Open(path)
	if err != nil {
		if !os.IsNotExist(err) {
			// 只报 err；os 的 PathError 只含路径，不含内容。
			warn(logger, "读取 %s 失败：%v", path, err)
		}
		return ""
	}
	defer f.Close()

	// 权限体检：这个文件装着全套生产密钥，本机多用户/多进程环境下 group/other 可读
	// 就等于敞开。只告警不拒读——拒读会把一次配置疏忽升级成服务起不来，而告警能让人
	// 看见并改掉。文案里只出现路径与八进制权限位，不含任何文件内容。
	// （PiMoa review 2026-09-19 指出缺这层纵深防御。）
	if st, serr := f.Stat(); serr == nil {
		if mode := st.Mode().Perm(); mode&0o077 != 0 {
			warn(logger, "⚠ %s 权限是 %#o，同机其他用户可读——密钥文件应为 0600。", path, mode)
		}
	}

	// 键名来自调用方常量，仍做转义：防止未来有人传进带元字符的键名。
	re := regexp.MustCompile(`^\s*(?:export\s+)?` + regexp.QuoteMeta(key) + `\s*=\s*(.*)$`)
	scanner := bufio.NewScanner(f)
	// secrets.env 里单行可能是很长的 JSON 型凭据，默认 64KiB 行上限不够。
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		m := re.FindStringSubmatch(scanner.Text())
		if m == nil {
			continue
		}
		return unquote(strings.TrimSpace(m[1]))
	}
	if err := scanner.Err(); err != nil {
		warn(logger, "扫描 %s 失败：%v", path, err)
	}
	return ""
}

// Secret 按「环境变量优先，其次 env 文件」取一个密钥。
// 环境变量优先是为了测试与临时覆盖（Node 版同款口径）。
func Secret(envName, filePath, fileKey string, logger *log.Logger) string {
	if v := strings.TrimSpace(os.Getenv(envName)); v != "" {
		return v
	}
	return SecretFromEnvFile(filePath, fileKey, logger)
}

// unquote 只摘**成对**的首尾引号。单边引号是值的一部分，不该被吃掉。
func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
