# patches/pi-ai-0.99.2 — pi 基座本地补丁批（仅 B3）[v3]

依据：DEC-36（PiMoa 的 Pi 与 DSH 同窗升到 0.99.x）；补丁去留评估 `<workspace>/artifacts/pi-upgrade-eval-20261001/pimoa-patches/REPORT.md`；主代理独立核实 `<workspace>/artifacts/pi-upgrade-eval-20261001/main-verify/MAIN-VERIFY.md`。
目标：`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/`（全树唯一 pi-ai 副本，**必须是 0.99.2**，载体版本闸核 `pi-ai/package.json` 的 name+version）。
载体：`bin/apply-pi-patches.mjs` v3（`apply | verify [--expect patched|pristine] [file] | rollback [--file <rel>]`）；`package.json` postinstall 重放；`bin/pi-moa-mcp.mts` 启动守卫 `verify --expect patched`（fail-closed，另要求 `set=pi-ai-0.99.2`、`@version=ok`、至少 1 个补丁件）。

## 来源表

| 文件 | 来源 | sha256 | 说明 |
|---|---|---|---|
| `utils/json-parse.js` | 0.84.1 批 `patches/pi-ai-0.84.1/utils/json-parse.js` **原样复用** | `d4a37840…` | B3：剥 markdown 头围栏后重走上游 `parseStreamingJson` 三级管线（上游 [#8858](https://github.com/earendil-works/pi/issues/8858) closed/not_planned）。0.99.2 原件与 0.84.1 原件逐字节相同，故补丁件可原样重打 |
| `pristine/utils/json-parse.js` | `@earendil-works/pi-ai@0.99.2` npm tarball 逐字节（tarball sha512 = npm `dist.integrity`） | `824fa2bf…` | 唯一持久回滚源 |
| `pristine/utils/json-parse.js.map` | 同上 | `90331c5b…` | B3 改动后行号失步的 source map 原件；apply 时目标 dist 的同哈希 map 备份后删除，rollback 时从此还原 |
| `MANIFEST.sha256` | `shasum -a 256` 实算（3 行） | — | 载体启动前逐行核对；还要求覆盖上面 3 个必需件，缺行/不符即 exit 4 |
| `probes.mjs` | 由 0.84.1 批 probes.mjs 删减 | — | `node --experimental-import-meta-resolve patches/pi-ai-0.99.2/probes.mjs`（cd 仓根）；V0 版本 + W1 副本防伪 + I/O 契约 + B1–B7 + E2/E3 |

## 退役记录（P1–P4）

| 补丁 | 0.84.1 批文件 | 退役依据 |
|---|---|---|
| P1 EventStream O(n²)（#9055） | `utils/event-stream.*` | 0.99.2 `event-stream.js` 与补丁件逐字节相同（`29a6bb6b…`） |
| P2/P3 overflow（#9482/#9805） | `utils/overflow.*` | 0.99.2 是补丁件超集（只多 `/prompt exceeds max length/i`） |
| P4 retry（fe10558e 等） | `utils/retry.*` | 0.99.2 是补丁件超集（只多 3 个 ChatGPT 订阅错误码） |

## 载体 v3 行为（相对 v2.1 的变化）

- **版本闸**：目标 pi-ai 不是 `@earendil-works/pi-ai@0.99.2` ⇒ apply/rollback 不写盘、exit 5；verify 的 `result["@version"]` 记 `MISMATCH(installed=…, set=…)`、exit 5、`diagnosis` 含 `version-mismatch`。
- **rollback 不再盲覆盖**：只还原 `patched` 态；`pristine` 记 `already-pristine`；`foreign`/`missing` 记 `refused-*` 且不写盘（exit 2）。
- **verify 诊断**：`diagnosis` 列出 `version-mismatch` / `B3-missing:<file>`（目标是 pristine 原件）/ `foreign:<file>` / `missing:<file>`；`maps` 字段报告 json-parse.js.map 状态（`absent` / `pristine-map` / `foreign-map`，仅报告，不影响通过与否）。
- **scope 收紧**：`--file` 与位置参数只能取本批文件（`utils/json-parse.js`），否则用法错误 64。
- 退出码：0 成功 / 2 foreign·missing·拒绝回滚 / 3 verify MISMATCH / 4 清单·IO·基线 / 5 版本不符 / 64 用法。postinstall 环境仍 fail-open（只打横幅），由启动守卫收口。

## 登记事项

- **`.last-apply.json` 是运行时标记，不得提交**：apply 每次写入本目录；Tx 只按显式路径 `git add`。
- **`npm install <pkg>` 不触发根 postinstall**（npm 10.9.7 实测）；`npm install`（无参）与 `npm ci` 会触发。升级与回滚后都要显式跑一次 `node bin/apply-pi-patches.mjs verify --expect patched` 确认退出码 0。
- 4 反引号围栏登记不修；apply 与 `npm install` 并发登记不修（沿 0.84.1 批 DESIGN §8）。

## 回到 0.84.1 的路径

旧批 `patches/pi-ai-0.84.1/` 原样保留。v3 载体只认 0.99.2（版本闸），**不能**用 v3 载体去打 0.84.1。回退步骤（停服后）：

1. 把 `package.json`、`package-lock.json`、`bin/apply-pi-patches.mjs`、`bin/pi-moa-mcp.mts` 一起还原到升级前提交（`git revert <升级提交>`，或对这 4 个路径 `git checkout <升级前提交> -- …`，四个文件必须同批还原：只还原 lock 不还原载体 ⇒ v3 版本闸 exit 5、守卫拒启；只还原载体不还原 lock ⇒ v2.1 载体在 0.99.2 上判 foreign、守卫拒启）；
2. `npm ci`（会触发 postinstall，由 v2.1 载体重打 0.84.1 批 13 件）；
3. `node bin/apply-pi-patches.mjs verify --expect patched` 13 项 ok、退出码 0；
4. `node --experimental-import-meta-resolve patches/pi-ai-0.84.1/probes.mjs`。
