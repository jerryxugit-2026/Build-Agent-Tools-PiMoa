#!/bin/bash
# 收割 pi-moa server 真孤儿(父进程已死、被 reparent 到 launchd 的 ppid=1 实例)。
#
# ★铁律:绝不按「启动时间早」清理 pi-moa 进程。
#   机理(2026-08-03 实锤):Codex(ChatGPT 桌面应用 app-server)给**每个(子)线程**
#   spawn 一个独立 pi-moa server 并全程攥着管道;应用整天开着 → 进程自然累积,
#   但它们是**在用连接**,不是泄漏。server 自身生命周期正确:stdin EOF / SIGTERM
#   都会干净退出(见 src/mcp/server.ts;冷启动 844ms、握手/退出均实测)。
#   误杀活连接的后果:host 线程的 MCP transport 永久死亡(Codex 不在线程内重生
#   server),该线程此后每次调用瞬间 "Transport closed",只能重开会话——
#   2026-08-03 检测工具专项线程被按启动时间误清、在途 moa_verify 23.5s 被拦腰
#   砍断,即此教训。
#
# ★铁律二(2026-08-13 加,血的教训):ppid=1 **不再等于**孤儿。
#   2026-08-12 起 pi-moa 已服务化为 url 型常驻单实例(端口 8758,操作手册 §3.3),
#   由启动器 nohup 拉起 → **天生 ppid=1**。旧判据眼里它是"教科书级真孤儿",
#   一跑必杀:2026-08-13 08:24 本脚本把常驻服务 SIGTERM 掉,四个客户端
#   (ChatGPT/Claude Code/桌面版/终端)的 pi-moa 工具集体失联。
#   → 现判据 = ppid=1 **且** 不属于 8758 监听进程的父子链。服务实例一律豁免。
#
# 判据:父进程死没死(ppid=1) + 非服务化实例。父进程活着=在用,不碰。
# 用法:bin/reap-pimoa-orphans.sh [--dry-run]
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# ---- 服务化实例豁免 ----
# 监听 8758 的进程(通常是 node loader 子进程)及其**祖先**(tsx 包装进程,ppid=1)
# 与**后代**全部豁免。端口可用 PIMOA_MCP_PORT 覆盖,与服务启动时同名 env 对齐。
PIMOA_HTTP_PORT="${PIMOA_MCP_PORT:-8758}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "⚠️ 无 lsof,无法识别服务化实例;拒绝收割(宁可不清,不可误杀常驻服务)。" >&2
  exit 0
fi
LISTEN_PIDS="$(lsof -t -iTCP:"${PIMOA_HTTP_PORT}" -sTCP:LISTEN 2>/dev/null || true)"

# pid 自身/其祖先链中是否出现 target
ancestor_chain_has() {
  local cur="$1" target="$2"
  while [ -n "${cur}" ] && [ "${cur}" != "0" ] && [ "${cur}" != "1" ]; do
    [ "${cur}" = "${target}" ] && return 0
    cur="$(ps -o ppid= -p "${cur}" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

# 候选 pid 是否与 8758 服务实例同族(自身/后代/祖先)
is_service_instance() {
  local pid="$1" lp
  [ -z "${LISTEN_PIDS}" ] && return 1
  for lp in ${LISTEN_PIDS}; do
    [ "${pid}" = "${lp}" ] && return 0        # 就是监听者
    ancestor_chain_has "${pid}" "${lp}" && return 0   # 候选是监听者的后代
    ancestor_chain_has "${lp}" "${pid}" && return 0   # 候选是监听者的祖先(tsx 包装)
  done
  return 1
}

found=0
skipped=0
# 顶层 tsx 包装进程与 node loader 子进程的命令行都含 bin/pi-moa-mcp.mts,
# 父死后子会各自 reparent 到 1,两类都按同一判据收。
while IFS= read -r line; do
  pid=$(echo "${line}" | awk '{print $1}')
  ppid=$(echo "${line}" | awk '{print $2}')
  [ "${ppid}" != "1" ] && continue
  if is_service_instance "${pid}"; then
    skipped=$((skipped + 1))
    echo "豁免服务化实例 pid=${pid}(8758 常驻服务族,ppid=1 属正常)"
    continue
  fi
  found=$((found + 1))
  if [ "${DRY}" = "1" ]; then
    echo "[dry-run] 真孤儿 pid=${pid}(ppid=1,非服务实例),将 SIGTERM"
  else
    echo "收割真孤儿 pid=${pid}(ppid=1,非服务实例)→ SIGTERM"
    kill -TERM "${pid}" 2>/dev/null || true
  fi
done < <(ps -eo pid,ppid,command | grep "bin/pi-moa-mcp.mts" | grep -v grep | grep -v "MacOS/claude")

if [ "${found}" = "0" ]; then
  echo "无真孤儿(服务化实例豁免 ${skipped} 个;其余 pi-moa 实例父进程都活着=在用连接)。"
  exit 0
fi

if [ "${DRY}" = "0" ]; then
  # 优雅关闭有 5s drain(server.ts shutdown);等 7s 后对赖着不走的升级 SIGKILL。
  sleep 7
  while IFS= read -r line; do
    pid=$(echo "${line}" | awk '{print $1}')
    ppid=$(echo "${line}" | awk '{print $2}')
    [ "${ppid}" != "1" ] && continue
    if is_service_instance "${pid}"; then
      continue  # 服务化实例同样豁免,绝不升级 SIGKILL
    fi
    echo "仍存活,升级 SIGKILL pid=${pid}"
    kill -9 "${pid}" 2>/dev/null || true
  done < <(ps -eo pid,ppid,command | grep "bin/pi-moa-mcp.mts" | grep -v grep | grep -v "MacOS/claude")
fi
echo "完成:处理 ${found} 个真孤儿。"
