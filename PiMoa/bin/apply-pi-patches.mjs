#!/usr/bin/env node
// apply-pi-patches.mjs — pi-ai 本地补丁批载体 [v3：pi-ai 0.99.2，仅 B3]
// 用法: apply | verify [--expect patched|pristine] [file] | rollback [--file <rel>]
// 退出码: 0=成功/already-applied/skipped; 2=foreign|missing（rollback 拒绝降级同此码）;
//         3=verify MISMATCH; 4=清单/IO/基线缺失; 5=版本不符（目标 pi-ai 版本 ≠ 本补丁批版本，一律不写盘）;
//         64=用法错误
// v3 变更（2026-10-01，DEC-36 升 0.99.x）：
//   · 补丁批 = patches/pi-ai-0.99.2（P1–P4 已被上游 0.99.2 吸收而退役，只剩 B3 json-parse.js）；
//     旧批 patches/pi-ai-0.84.1 原样保留，供回到 0.84.1 时由 v2.1 载体（git 历史）使用。
//   · 版本闸：apply / verify / rollback 先核目标 dist 所属 pi-ai 的 package.json（name+version）；
//     不符 ⇒ 不写盘、exit 5，verify 结果里 "@version" 记 MISMATCH（启动守卫据此拒启）。
//   · rollback 只还原 patched 态文件；foreign/missing 拒绝（不再把基线盲目覆盖到别的版本上）。
//   · scope（--file / 位置参数）只能取 FILES 内的文件，否则用法错误。
//   · verify 附 diagnosis：version-mismatch / B3-missing / foreign / missing，便于定位。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SET = { dir: "pi-ai-0.99.2", pkg: "@earendil-works/pi-ai", version: "0.99.2" };
const FILES = ["utils/json-parse.js"];
// 随 B3 行号失步的 source map：apply 时若与 pristine 同哈希则备份后删除（沿 0.84.1 批 DESIGN §5-4 口径）；
// rollback 时从 pristine 还原。map 不进 result、不影响通过与否（无运行语义），只在 maps 字段如实报告。
const STALE_MAPS = { "utils/json-parse.js": "utils/json-parse.js.map" };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_SRC = join(REPO_ROOT, "patches", SET.dir);
const PRISTINE = join(PATCH_SRC, "pristine");
const PI_AI_ROOT = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent",
  "node_modules", "@earendil-works", "pi-ai");
const PI_AI_DIST = join(PI_AI_ROOT, "dist");
const MANIFEST = join(PATCH_SRC, "MANIFEST.sha256");
const MARKER = join(PATCH_SRC, ".last-apply.json");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stamp = () => new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);

// MANIFEST 必须逐行与实物相符，且覆盖本批全部必需件（补丁源 + pristine + pristine map）。
function checkManifest() {
  if (!existsSync(MANIFEST)) { console.error("[pi-patch] MANIFEST 缺失"); return false; }
  const listed = new Set();
  for (const line of readFileSync(MANIFEST, "utf8").trim().split("\n")) {
    const [h, p] = line.trim().split(/\s+/);
    const full = join(PATCH_SRC, p ?? "");
    if (!p || !existsSync(full) || sha(full) !== h) { console.error(`[pi-patch] MANIFEST 不符: ${p}`); return false; }
    listed.add(p);
  }
  const required = [
    ...FILES,
    ...FILES.map((f) => `pristine/${f}`),
    ...Object.values(STALE_MAPS).map((m) => `pristine/${m}`),
  ];
  const absent = required.filter((p) => !listed.has(p));
  if (absent.length) { console.error(`[pi-patch] MANIFEST 未覆盖必需件: ${absent.join(", ")}`); return false; }
  return true;
}

// 版本闸：目标 dist 必须属于本补丁批对应的 pi-ai 版本。
function versionState() {
  const pj = join(PI_AI_ROOT, "package.json");
  if (!existsSync(pj)) return { ok: false, label: "MISMATCH(missing-package.json)" };
  let meta;
  try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { return { ok: false, label: "MISMATCH(unreadable-package.json)" }; }
  if (meta.name !== SET.pkg || meta.version !== SET.version) {
    return { ok: false, label: `MISMATCH(installed=${meta.name}@${meta.version}, set=${SET.pkg}@${SET.version})` };
  }
  return { ok: true, label: "ok" };
}

// 状态：identical(补丁源==基线) | patched | pristine | foreign | missing
function stateOf(rel) {
  const target = join(PI_AI_DIST, rel), src = join(PATCH_SRC, rel), pr = join(PRISTINE, rel);
  if (!existsSync(target)) return "missing";
  const t = sha(target);
  const srcH = existsSync(src) ? sha(src) : null, prH = existsSync(pr) ? sha(pr) : null;
  if (srcH && t === srcH) return prH && srcH === prH ? "identical" : "patched";
  if (prH && t === prH) return "pristine";
  return "foreign";
}

// map 状态：absent | pristine-map（与 pristine 同哈希，即 B3 后失步的上游原件）| foreign-map
function mapStateOf(mapRel) {
  const target = join(PI_AI_DIST, mapRel), pr = join(PRISTINE, mapRel);
  if (!existsSync(target)) return "absent";
  return existsSync(pr) && sha(target) === sha(pr) ? "pristine-map" : "foreign-map";
}

function diagnose(version, result) {
  const d = [];
  if (!version.ok) d.push("version-mismatch");
  for (const [rel, v] of Object.entries(result)) {
    if (rel === "@version") continue;
    if (/pristine/.test(v) && FILES.includes(rel)) d.push(`B3-missing:${rel}`);
    if (/foreign/.test(v)) d.push(`foreign:${rel}`);
    if (/missing/.test(v)) d.push(`missing:${rel}`);
  }
  return d;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!["apply", "verify", "rollback"].includes(cmd)) {
    console.error("用法: apply | verify [--expect patched|pristine] [file] | rollback [--file <rel>]");
    return 64;
  }
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const hasFlag = (name) => argv.includes(name);
  const expect = opt("--expect"), fileArg = opt("--file");
  if (hasFlag("--file") && (fileArg === undefined || fileArg.startsWith("--"))) { console.error("用法: --file <dist 相对路径>"); return 64; }
  if (hasFlag("--expect") && (expect === undefined || expect.startsWith("--"))) { console.error("用法: --expect patched|pristine"); return 64; }
  const taken = new Set();
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--expect" || argv[i] === "--file") { taken.add(i); taken.add(i + 1); }
  const positionals = argv.slice(1).filter((_, i) => !taken.has(i + 1) && !argv[i + 1].startsWith("--"));
  if (cmd === "verify" && expect && !["patched", "pristine"].includes(expect)) {
    console.error("--expect 仅支持 patched|pristine"); return 64;
  }
  const scope = fileArg !== undefined ? [fileArg] : positionals.length ? positionals : FILES;
  const outside = scope.filter((f) => !FILES.includes(f));
  if (outside.length) { console.error(`用法: 文件须属于本补丁批 [${FILES.join(", ")}]，收到 ${outside.join(", ")}`); return 64; }
  if (cmd === "apply" && process.env.PIMOA_SKIP_PI_PATCHES === "1") {
    console.log(JSON.stringify({ cmd, set: SET.dir, result: { skipped: "PIMOA_SKIP_PI_PATCHES=1" }, at: new Date().toISOString() }));
    return 0;
  }
  if (!checkManifest()) return 4;

  const version = versionState();
  const result = { "@version": version.label };
  const maps = {};

  if (!version.ok && cmd !== "verify") {
    // apply / rollback 在错误版本上一律不写盘（防把本批基线覆盖到别的版本、造成新旧混装）。
    for (const rel of scope) result[rel] = "skipped-version-mismatch";
  } else {
    for (const rel of scope) {
      const target = join(PI_AI_DIST, rel), src = join(PATCH_SRC, rel), pr = join(PRISTINE, rel);
      const st = stateOf(rel);
      if (cmd === "apply") {
        if (st === "patched" || st === "identical") { result[rel] = "already-applied"; }
        else if (st === "foreign" || st === "missing") { result[rel] = st; continue; }
        else {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(target, `${target}.bak-${stamp()}`);   // 改前物理备份（仅供人工核对；持久回滚源=pristine/）
          copyFileSync(src, target);
          result[rel] = sha(target) === sha(src) ? "applied" : "VERIFY-FAILED";
        }
        const mapRel = STALE_MAPS[rel];
        if (mapRel && result[rel] !== "VERIFY-FAILED") {
          const ms = mapStateOf(mapRel);
          if (ms === "pristine-map") {
            const mt = join(PI_AI_DIST, mapRel);
            copyFileSync(mt, `${mt}.bak-${stamp()}`);
            unlinkSync(mt);
            maps[mapRel] = "removed-stale-map";
          } else maps[mapRel] = ms;
        }
      } else if (cmd === "verify") {
        const ok = st === expect ||
          (st === "identical" && (expect === "patched" || expect === "pristine")) ||
          (expect === undefined && ["patched", "identical", "pristine"].includes(st));
        result[rel] = ok ? (expect ? "ok" : st) : `MISMATCH(${st})`;
        const mapRel = STALE_MAPS[rel];
        if (mapRel) maps[mapRel] = mapStateOf(mapRel);
      } else {
        // rollback：只还原 patched 态；pristine/identical 视为已还原；foreign/missing 拒绝写盘。
        if (st === "pristine" || st === "identical") result[rel] = "already-pristine";
        else if (st === "foreign" || st === "missing") { result[rel] = `refused-${st}`; continue; }
        else if (!existsSync(pr)) { result[rel] = "no-pristine-baseline"; continue; }
        else {
          copyFileSync(pr, target);
          result[rel] = sha(target) === sha(pr) ? "rolled-back" : "VERIFY-FAILED";
        }
        const mapRel = STALE_MAPS[rel];
        if (mapRel) {
          const ms = mapStateOf(mapRel);
          if (ms === "absent" && existsSync(join(PRISTINE, mapRel))) {
            copyFileSync(join(PRISTINE, mapRel), join(PI_AI_DIST, mapRel));
            maps[mapRel] = "restored-map";
          } else maps[mapRel] = ms;
        }
      }
    }
  }

  const out = { cmd, set: SET.dir, result, maps, at: new Date().toISOString() };
  if (cmd === "verify") out.diagnosis = diagnose(version, result);
  const line = JSON.stringify(out);
  console.log(line);                                  // 机器可读一行（启动守卫解析最后一行）
  if (cmd === "apply") {                              // verify 只读
    try { writeFileSync(MARKER, line + "\n"); } catch { console.error("[pi-patch] marker 写入失败（不影响校验）"); }
  }
  const okSet = new Set(["already-applied", "applied", "ok", "rolled-back", "already-pristine", "patched", "identical", "pristine"]);
  const bad = Object.entries(result).filter(([, v]) => !okSet.has(v));
  if (bad.length === 0) return 0;
  if (process.env.npm_lifecycle_event === "postinstall") {     // fail-open（启动器入口 verify 将拦）
    console.error(`[pi-patch] FAILED（fail-open；启动器入口 verify 将拦）: ${JSON.stringify(bad)}`);
    return 0;
  }
  if (!version.ok) return 5;
  if (bad.some(([, v]) => /^(foreign|missing|refused-)/.test(v))) return 2;
  if (bad.some(([, v]) => v === "no-pristine-baseline" || v === "VERIFY-FAILED")) return 4;
  return 3;
}
process.exit(main());
