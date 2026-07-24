# verify 命令级只读方案评估（@gotgenes/pi-permission-system，2026-07-24）

> 子代理真读源码 + codegraph。结论：**自建 `bash_readonly`（复用 pi-permission-system 的 tree-sitter bash 解析）+ 官方 sandbox 兜底**；不整包吞 pi-permission-system。

## 下载
- 实为 monorepo `github.com/gotgenes/pi-packages` 子包 → clone 到 `refs/pi-permission-system/`，目标包 `packages/pi-permission-system/`（v20.10.0，peer `pi-coding-agent>=0.79.0`，本地 0.81.1 兼容）。
- codegraph：534 文件 / 5530 节点 / 22893 边。核心：`src/access-intent/bash/`、`src/handlers/gates/`、`src/authority/`。

## 权限机制真相：命令级、硬核
- pi 扩展 hook 模型：`src/index.ts` `piPermissionSystemExtension(pi)` 挂 `tool_call`/`before_agent_start`（后者 `setActiveTools` 提前隐藏禁用工具）。
- 命令级拆解：`src/access-intent/bash/command-enumeration.ts`（tree-sitter-bash，枚举 redirected_statement、descend subshell/command-substitution）；`program.ts` `BashProgram.commands()`。
- 逐条判定最严胜出：`handlers/gates/bash-command.ts` `resolveBashCommandCheck()` + `pickMostRestrictive`（deny>ask>allow）。
- wrapper 兜底：`bash -c`/`eval`/`sudo`/`xargs`/`find -exec` → floor 成 ask（WRAPPER_SENTINEL）。
- fail-closed：不可解析 → `ask`；`*` 通配不静默放行。
- 命令级 allowlist 可表达（config.example.json）：`"bash":{"*":"deny","git diff":"allow",...}` ✅

## ⚠️ 关键缺口（写进 DESIGN）：写重定向堵不干净
`>`/`>>` 目标在 command-enumeration 被 SKIP、不进命令文本，只作 path token 走 `bash-path-resolver.ts` → path surface(`access-path.ts`)。**path surface 无 read/write 语义**，只按路径命中 pattern 判，无法表达"允许读但拒绝写"。
- `echo x > f` → 命令是 `echo`（白名单外）→ deny ✅
- `git diff > /repo/backdoor.py` → 命令 `git diff`（白名单内）→ allow，写重定向漏过 ❌
→ "允许某命令 + 拦它的写重定向"用 pi-permission-system 的 bash 规则**表达不了**。

## 进程内 createAgentSession：能，无需改造
- `createAgentSession({resourceLoader})` + `DefaultResourceLoader` 的 `additionalExtensionPaths` 或 `extensionFactories`（sdk.md 581-620）。
- 本包 default export = 裸 `(pi:ExtensionAPI)=>void` 工厂，可直接进 `extensionFactories`。
- **Headless 注意**：默认策略含 `"*":"ask"`（要 ctx.ui），进程内无 TUI 会卡 → verify 策略**只用 allow/deny、不留 ask**（wrapper floor 出的 ask 无 authorizer 时 fail-closed=deny，方向正确）；或用 `authority/denying-authorizer.ts` 显式 ask→deny。

## 三路对比
| 方案 | 层级 | 进程内 | 写重定向 | 代价 |
|---|---|---|---|---|
| pi-permission-system | 命令级 allowlist | ✅ | ⚠️ 白名单命令带 `>` 漏 | 重(~60文件+authority/forwarding)；headless 要无 ask |
| 官方 sandbox | FS 级(sandbox-exec/bubblewrap) | ✅ | ✅ 内核拦 | 非命令级；Linux 需 bubblewrap |
| 官方 gondolin | 微VM(QEMU) | ✅ | ✅ | 过重、每 session 起 VM，不适合 MoA 多 session |
| **自建 bash_readonly** | 命令级+显式 reject `>` | ✅ 最省 | ✅ 自己 reject | 要解析 shell（借 pi-permission-system 的 tree-sitter 模块即可） |

## 推荐（已定）
**首选：自建 `bash_readonly` = 复用 pi-permission-system 的 `src/access-intent/bash/`（BashProgram.commands()+wrapper 识别）做解析 + 固定取证 allowlist（git diff/status/log、hash、stat/file/wc/readlink/realpath/du/df、只读 find）+ 显式 reject 任何 file_redirect/`>`/wrapper。** 完全进程内、无 authorizer/OS 依赖，且补上写重定向洞。
**纵深防御：叠官方 sandbox 扩展**（dev 在 macOS，sandbox-exec 可用）做 FS 只读兜底。
**不整包吞 pi-permission-system**：偏重 + 写重定向缺口；借其 bash 解析代码即可。
