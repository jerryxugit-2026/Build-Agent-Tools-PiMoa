#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_MARKER = "/tests/data/high_risk_fixtures/"


def normalize_path(path: Path) -> Path:
    return path.expanduser().resolve()


def iter_workbooks(inputs: list[str], include_fixtures: bool) -> list[Path]:
    if not inputs:
        inputs = [str(ROOT)]
    workbooks: set[Path] = set()
    for value in inputs:
        path = normalize_path(Path(value))
        if path.is_dir():
            candidates = path.rglob("*.xlsx")
        else:
            candidates = [path] if path.suffix.lower() == ".xlsx" else []
        for candidate in candidates:
            text = str(candidate)
            if candidate.name.startswith("~$"):
                continue
            if not include_fixtures and FIXTURE_MARKER in text:
                continue
            workbooks.add(candidate)
    return sorted(workbooks)


def read_zip_text(archive: zipfile.ZipFile, name: str) -> str:
    try:
        return archive.read(name).decode("utf-8", errors="ignore")
    except Exception:
        return ""


def inspect_workbook(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "workbook": str(path),
        "ok": True,
        "error": "",
        "families": {
            "pivot_table": False,
            "sparkline": False,
            "ole_object": False,
        },
        "evidence": {
            "pivot_table": [],
            "sparkline": [],
            "ole_object": [],
        },
        "external_real_candidate": FIXTURE_MARKER not in str(path),
    }
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            rel_names = [
                name
                for name in names
                if name.endswith(".rels")
            ]
            worksheet_names = [
                name
                for name in names
                if name.startswith("xl/worksheets/") and name.endswith(".xml")
            ]

            pivot_parts = [
                name
                for name in names
                if name.startswith("xl/pivotTables/") and name.endswith(".xml")
            ]
            if pivot_parts:
                result["families"]["pivot_table"] = True
                result["evidence"]["pivot_table"].extend(pivot_parts[:5])

            embedding_parts = [
                name
                for name in names
                if name.startswith("xl/embeddings/")
            ]
            if embedding_parts:
                result["families"]["ole_object"] = True
                result["evidence"]["ole_object"].extend(embedding_parts[:5])

            for rel_name in rel_names:
                rel_xml = read_zip_text(archive, rel_name)
                if "pivotTable" in rel_xml:
                    result["families"]["pivot_table"] = True
                    result["evidence"]["pivot_table"].append(rel_name)
                if "oleObject" in rel_xml or (
                    "relationships/package" in rel_xml and "embeddings/" in rel_xml
                ):
                    result["families"]["ole_object"] = True
                    result["evidence"]["ole_object"].append(rel_name)

            for worksheet_name in worksheet_names:
                worksheet_xml = read_zip_text(archive, worksheet_name)
                if "sparkline" in worksheet_xml:
                    result["families"]["sparkline"] = True
                    result["evidence"]["sparkline"].append(worksheet_name)
    except Exception as exc:  # noqa: BLE001 - scanner must continue across samples.
        result["ok"] = False
        result["error"] = str(exc)
    result["has_high_risk_candidate"] = any(result["families"].values())
    for family in result["evidence"]:
        result["evidence"][family] = sorted(set(result["evidence"][family]))
    return result


def summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    family_counts = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    candidate_count = 0
    failed_count = 0
    external_real_candidate_count = 0
    for report in reports:
        if not report["ok"]:
            failed_count += 1
            continue
        if report["has_high_risk_candidate"]:
            candidate_count += 1
            if report["external_real_candidate"]:
                external_real_candidate_count += 1
        for family, present in report["families"].items():
            if present:
                family_counts[family] += 1
    return {
        "workbook_count": len(reports),
        "failed_workbook_count": failed_count,
        "candidate_workbook_count": candidate_count,
        "external_real_candidate_workbook_count": external_real_candidate_count,
        "family_candidate_counts": family_counts,
    }


def payload_for(paths: list[Path]) -> dict[str, Any]:
    reports = [inspect_workbook(path) for path in paths]
    candidates = [
        report
        for report in reports
        if report.get("ok") and report.get("has_high_risk_candidate")
    ]
    return {
        "scan": "sheet_shadow_high_risk_workbook_candidate_locator",
        "schema_version": "1",
        "summary": summarize(reports),
        "candidates": candidates,
        "workbooks": reports,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Locate .xlsx files that contain high-risk OOXML object markers "
            "before running the heavier SheetShadowEngine audit."
        )
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="Workbook files or directories to scan recursively. Defaults to repo root.",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="Print summary and candidate list without per-workbook negatives.",
    )
    parser.add_argument(
        "--include-fixtures",
        action="store_true",
        help="Include deterministic high-risk fixture workbooks.",
    )
    args = parser.parse_args(argv)
    paths = iter_workbooks(args.paths, args.include_fixtures)
    payload = payload_for(paths)
    if args.summary_only:
        payload = {
            "scan": payload["scan"],
            "schema_version": payload["schema_version"],
            "summary": payload["summary"],
            "candidates": payload["candidates"],
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
