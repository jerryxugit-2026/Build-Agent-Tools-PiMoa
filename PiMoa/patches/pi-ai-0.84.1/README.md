# patches/pi-ai-0.84.1 — pi 基座本地补丁批（B3 + P1 + P2/P3 + P4）[v2.1]

施工依据：`<workspace>/workspace/artifacts/pi-base-patch-20260927/DESIGN-v2.1-FINAL.md`（2026-09-27 定稿）。
目标：`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/`（全树唯一 pi-ai 副本，0.84.1）。
载体：`bin/apply-pi-patches.mjs`（`apply | verify [--expect patched|pristine] [file] | rollback [--file <rel>]`），`package.json` postinstall 自动重放，`bin/pi-moa-mcp.mts` 启动守卫 `verify --expect patched`（fail-closed）。

## 来源表

| 文件 | 来源 | fix |
|---|---|---|
| `utils/event-stream.{js,js.map,d.ts,d.ts.map}` | `@earendil-works/pi-ai@0.87.1` npm release 逐字节 | P1：#9055 EventStream O(n²) 排空 → FifoQueue 双栈（`b2602be7`，0.86.0）；`.d.ts` 两版同哈希（identical 件） |
| `utils/overflow.{js,js.map,d.ts,d.ts.map}` | `@earendil-works/pi-ai@0.87.1` npm release 逐字节 | P2：#9482 bodyless 400/413 仅 Cerebras 判溢出（`661619e8`，0.86.0）；P3：#9805 z.ai「Prompt too long」（`0e283203`，0.86.1）；连带 `getOverflowPatterns` 25→24 |
| `utils/retry.{js,js.map,d.ts,d.ts.map}` | `@earendil-works/pi-ai@0.87.1` npm release 逐字节 | P4：`fe10558e` buffer 限流可重试（0.84.2）；连带 #9627 `520`、#9669 `currently experiencing high demand`、`retryDelayMs`/`DEFAULT_MAX_AGENT_RETRY_DELAY_MS` 导出、`RetryPolicy.maxAgentDelayMs` 新公共字段、aborted 删 `errorMessage` 键（`86bac52f`）、`Math.max(0, attempt-1)` |
| `utils/json-parse.js` | **本地自写**：0.84.1 pristine + B3 glue（DESIGN §3 生成器产物，锚 A/锚 B 唯一性校验） | B3：剥 markdown 头围栏后重走上游 `parseStreamingJson` 三级管线（上游 earendil-works/pi#8858 未修） |
| `pristine/utils/*`（13 件） | `@earendil-works/pi-ai@0.84.1` npm release 逐字节 | 唯一持久回滚源 |
| `MANIFEST.sha256` | `shasum -a 256` 全量实算（26 行：utils/ 13 + pristine/utils/ 13） | 载体启动前逐行核对，不符即 exit 4 |
| `probes.mjs` | DESIGN §6 修正版全套断言 | 运行：`node --experimental-import-meta-resolve patches/pi-ai-0.84.1/probes.mjs`（cd 仓根） |

## 登记事项

- **`json-parse.js.map` 删除**：补丁源不带 map（行号 + sourcesContent 双失步，登记不修；调试器走 .js 源）。目标 dist 的 0.84.1 旧 `utils/json-parse.js.map` 已于 2026-09-27 施工时备份为同目录 `json-parse.js.map.bak-<时间戳>` 后删除（DESIGN §5-4）。
  本条原定写入 MANIFEST 备注行；但 `apply-pi-patches.mjs` 的 `checkManifest()` 把每一行都当 `<hash>  <path>` 解析，备注行会被判「MANIFEST 不符」而 exit 4，故改登记于此。
  注意：`npm install` 重装 pi-ai 时旧 map 会回来；它不在 13 件校验面内、不影响 verify，只是调试器行号失步，可按上面同法再删。
- **`.last-apply.json` 是运行时标记，不得提交**：`apply` 每次执行后写入本目录 `.last-apply.json`（最近一次 apply 的结果与时间戳）。它**不在 `.gitignore` 覆盖范围内**（`git check-ignore` 未命中），会以未跟踪文件出现在 `git status` 里；Tx 提交本批时必须逐个显式路径 `git add`，**绝不能把它提交进库**（禁用 `git add -A` / `git add patches/` 这类整目录添加）。
- 4 反引号围栏（```` ````json ````）登记不修；`--file` 可 `../` 逃出登记不修；apply 与 `npm install` 并发登记不修（DESIGN §8）。
- 回滚：`node bin/apply-pi-patches.mjs rollback`（整批）或 `rollback --file utils/retry.js`（单件）→ `verify --expect pristine`（`utils/event-stream.d.ts` 按 identical 等价放行）。**整批停用必须同时**摘掉 `package.json` 的 `postinstall` 并移除 `bin/pi-moa-mcp.mts:99-113` 启动守卫块，或直接 `git revert` 本批补丁提交；两者缺一都会在后续安装或启动时把补丁重新打回/因 MISMATCH 拒启。施工期本地 `.bak-*` 仅作人工取证、未入版本库，不能作为入库后的回滚手段（DESIGN §7）。
