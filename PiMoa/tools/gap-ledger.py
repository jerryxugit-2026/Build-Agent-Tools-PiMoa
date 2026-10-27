#!/usr/bin/env python3
"""Read-only spool/consumption scanner; writes only the explicitly requested outputs."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import glob
import json
import os
from fnmatch import fnmatchcase
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[4]
PAPERGO = ROOT / "workspace" / "Claude dev paper system" / "Paper System"
DEFAULT_GLOBS = (
    str(PAPERGO / "docs" / "**" / "*.md"),
    str(ROOT / "artifacts" / "**" / "*PROBE*"),
    str(ROOT / "artifacts" / "**" / "PM-*"),
)
ID = re.compile(r"(?<![\w/:-])P\d+/F\d+:[\w-]+:[\w-]+(?![\w:-])")
ID_SHAPE = re.compile(r"(?<![\w/:-])P\d+/F\d+:[\w-]+:[\w-]+(?::[\w-]+)?")
FILENAME_TIME = re.compile(r"^(\d{8}T\d{6})-")
KEYWORDS = {
    "resolved": re.compile(r"已解决|已修复|已核实|已确认"),
    "still-missing": re.compile(r"仍缺材料|材料不足|无法核实"),
    "false-alarm": re.compile(r"误报|已驳回|不成立"),
}


def spool_time(path: Path) -> datetime:
    """Use the spool filename's UTC creation stamp; fixtures without it use mtime."""
    match = FILENAME_TIME.match(path.name)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)


def receipt_records(path: Path):
    text = path.read_text(encoding="utf-8")
    match = re.search(r"(?m)^## receipt[ \t]*\n[ \t\n]*```(?:json)?[ \t]*\n(.*?)\n```", text, re.DOTALL)
    if not match:
        return []
    receipt = json.loads(match.group(1))
    records = receipt.get("gaps", {}).get("records", [])
    if not isinstance(records, list):
        raise ValueError("receipt.gaps.records must be an array")
    return records


def source_paths(patterns):
    paths = set()
    if tuple(patterns) == DEFAULT_GLOBS:
        paths.update(p.resolve() for p in PAPERGO.joinpath("docs").glob("**/*.md") if p.is_file())
        artifacts = ROOT / "artifacts"
        # One walk for both artifact patterns; glob('**') follows symlink loops here.
        for directory, dirs, files in os.walk(artifacts, followlinks=False):
            dirs[:] = [d for d in dirs if d != ".git" and not (Path(directory) / d).is_symlink()]
            rel = Path(directory).relative_to(artifacts)
            matched_parent = any(fnmatchcase(part, "*PROBE*") or fnmatchcase(part, "PM-*")
                                 for part in rel.parts)
            for name in files:
                if matched_parent or fnmatchcase(name, "*PROBE*") or fnmatchcase(name, "PM-*"):
                    path = Path(directory) / name
                    if path.is_file():
                        paths.add(path.resolve())
    else:
        for pattern in patterns:
            for name in glob.iglob(str(Path(pattern).expanduser()), recursive=True):
                path = Path(name)
                if path.is_file():
                    paths.add(path.resolve())
                elif path.is_dir():
                    # A *PROBE* or PM-* directory is itself a matched artifact.
                    paths.update(p.resolve() for p in path.rglob("*") if p.is_file())
    return sorted(paths)


def consumption_index(patterns, excluded):
    index = defaultdict(list)
    errors = []
    skipped_non_text = 0
    for path in source_paths(patterns):
        if path in excluded:
            continue
        try:
            text = path.read_text(encoding="utf-8")
            if "\x00" in text:
                skipped_non_text += 1
                continue
            lines = text.splitlines()
        except UnicodeError:
            skipped_non_text += 1
            continue
        except OSError as exc:
            errors.append(f"{path}: {exc}")
            continue
        references = [(n, gap_id) for n, line in enumerate(lines) for gap_id in set(ID.findall(line))]
        for n, gap_id in references:
            found = set()
            for k in range(max(0, n - 3), min(len(lines), n + 4)):
                # A longer unrecognized ID must not donate its keyword to a nearby valid ID.
                if any(token not in ID.findall(lines[k]) for token in ID_SHAPE.findall(lines[k])):
                    continue
                # A disposition belongs to the nearest referenced ID, never a nearby other ID.
                distance = abs(k - n)
                if any(other != gap_id and abs(k - other_line) <= distance
                       for other_line, other in references if abs(k - other_line) <= 3):
                    continue
                found.update(status for status, pattern in KEYWORDS.items() if pattern.search(lines[k]))
            index[gap_id].append({"file": str(path), "line": n + 1,
                                  "disposition": next(iter(found)) if len(found) == 1 else None})
    return index, errors, skipped_non_text


def counts(rows):
    total = len(rows)
    read = sum(row["read"] for row in rows)
    resolved = sum(row["disposition"] == "resolved" for row in rows)
    missing = sum(row["disposition"] == "still-missing" for row in rows)
    alarms = sum(row["disposition"] == "false-alarm" for row in rows)
    return {"total": total, "read": read, "resolved": resolved,
            "still-missing": missing, "false-alarm": alarms, "unread": total - read}


def markdown(ledger):
    rows = ledger["records"]
    grouped = defaultdict(list)
    weekly = defaultdict(list)
    for row in rows:
        grouped[row["kind"]].append(row)
        stamp = datetime.fromisoformat(row["producedAt"])
        monday = stamp.date() - timedelta(days=stamp.weekday())
        weekly[monday.isoformat()].append(row)

    def table(buckets, heading):
        result = [f"## {heading}", "", "| 分桶 | 总数 | 已读率 | 已解决率 | 仍缺率 | 误报率 | 未读率 |",
                  "|---|---:|---:|---:|---:|---:|---:|"]
        for label, items in sorted(buckets.items()):
            c = counts(items)
            rate = lambda key: f"{c[key] / c['total']:.1%}" if c["total"] else "0.0%"
            result.append(f"| {label} | {c['total']} | {rate('read')} | {rate('resolved')} | "
                          f"{rate('still-missing')} | {rate('false-alarm')} | {rate('unread')} |")
        if not buckets:
            result.append("| （无记录） | 0 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |")
        return result

    return "\n".join(["# Gap 消费账本", "", "所有比率均以该分桶 gap 总数为分母；周起点为 UTC 周一。",
                      "冲突处置留空（已读未处置），每个原始 gap 按 spool 文件逐条计数。",
                      f"同一 gap id 跨 receipt 重用的记录数：{ledger['ambiguousIdRecords']}；"
                      "消费证据只有 id 时无法逐轮归属，相关已读/处置率仅是 ID 匹配口径，不代表逐轮核实。", "",
                      *table({"全部": rows}, "全量"), "", *table(grouped, "按 kind"), "",
                      *table(weekly, "按周（产出时间）"), ""])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spool-dir", type=Path, default=Path("~/.pimoa/spool").expanduser())
    parser.add_argument("--consumption-glob", action="append", help="repeatable; replaces default glob set")
    parser.add_argument("--out", type=Path, help="JSON output path (ledger mode)")
    parser.add_argument("--report", type=Path, help="Markdown output path (ledger mode)")
    parser.add_argument("--pending", action="store_true", help="print unread/undisposed gap needs as JSON; read-only")
    parser.add_argument("--last-rounds", type=int, default=None, help="latest K spool rounds in pending mode (default 5)")
    parser.add_argument("--since-days", type=int, help="include gaps produced in the most recent N days")
    args = parser.parse_args(argv)
    if args.since_days is not None and args.since_days < 0:
        parser.error("--since-days must be non-negative")
    if args.pending:
        if args.out is not None or args.report is not None:
            parser.error("--pending does not write --out or --report")
        if args.last_rounds is None:
            args.last_rounds = 5
        if args.last_rounds < 1:
            parser.error("--last-rounds must be positive")
    elif args.out is None or args.report is None or args.last_rounds is not None:
        parser.error("ledger mode requires --out and --report; --last-rounds requires --pending")
    if not args.spool_dir.is_dir():
        parser.error(f"spool directory does not exist: {args.spool_dir}")
    if not args.pending and args.out.resolve() == args.report.resolve():
        parser.error("--out and --report must be different paths")
    patterns = args.consumption_glob or list(DEFAULT_GLOBS)
    excluded = set() if args.pending else {args.out.resolve(), args.report.resolve()}
    index, errors, skipped_non_text = consumption_index(patterns, excluded)
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.since_days) if args.since_days is not None else None
    rows = []
    spool_files = sorted(args.spool_dir.glob("*.md"))
    if args.pending:
        spool_files = sorted(spool_files, key=lambda path: (spool_time(path), path.name), reverse=True)
        if cutoff is not None:
            spool_files = [path for path in spool_files if spool_time(path) >= cutoff]
        spool_files = spool_files[:args.last_rounds]
    for path in spool_files:
        try:
            produced = spool_time(path)
            if cutoff is not None and produced < cutoff:
                continue
            gaps = receipt_records(path)
            for gap in gaps:
                if not isinstance(gap, dict) or not all(isinstance(gap.get(k), str) for k in ("id", "kind", "path")):
                    errors.append(f"{path}: malformed GapRecord")
                    continue
                refs = index.get(gap["id"], [])
                dispositions = sorted({ref["disposition"] for ref in refs if ref["disposition"]})
                rows.append({"id": gap["id"], "kind": gap["kind"], "path": gap["path"],
                             "factIdx": gap.get("factIdx"), "need": gap.get("need", []),
                             "producedAt": produced.isoformat(), "spoolFile": str(path.resolve()),
                             "read": bool(refs), "referenceSources": sorted({ref["file"] for ref in refs}),
                             "references": refs, "disposition": dispositions[0] if len(dispositions) == 1 else None,
                             "dispositionCandidates": dispositions, "unread": not bool(refs)})
        except (OSError, UnicodeError, ValueError, TypeError, AttributeError) as exc:
            errors.append(f"{path}: {exc}")
    id_counts = Counter(row["id"] for row in rows)
    for row in rows:
        row["ambiguousId"] = id_counts[row["id"]] > 1
    ledger = {"spoolDir": str(args.spool_dir.resolve()), "consumptionGlobs": patterns,
              "sinceDays": args.since_days, "spoolFilesScanned": len(spool_files),
              "skippedNonText": skipped_non_text,
              "ambiguousIdRecords": sum(row["ambiguousId"] for row in rows),
              "summary": counts(rows), "errors": errors, "records": rows}
    if args.pending:
        pending = [dict(row, pendingStatus="unread" if row["unread"] else "undisposed")
                   for row in rows if row["unread"] or row["disposition"] is None]
        print(json.dumps({"lastRounds": args.last_rounds, "sinceDays": args.since_days,
                          "spoolFilesScanned": len(spool_files), "errors": errors,
                          "skippedNonText": skipped_non_text, "pending": pending}, ensure_ascii=False, indent=2))
        return 0
    args.out.write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.report.write_text(markdown(ledger), encoding="utf-8")
    print(json.dumps({"summary": ledger["summary"], "errors": len(errors), "skippedNonText": skipped_non_text,
                      "out": str(args.out), "report": str(args.report)}, ensure_ascii=False))
    if errors:
        print("warning: some source/receipt files were skipped; inspect JSON errors", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
