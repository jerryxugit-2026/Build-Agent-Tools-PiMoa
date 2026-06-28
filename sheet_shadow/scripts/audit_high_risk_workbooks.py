#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOKS = sorted(
    path
    for path in ROOT.glob("*.xlsx")
    if not path.name.startswith("~$")
)


def ensure_repo_import_path() -> None:
    root_text = str(ROOT)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)


def workbook_paths(args: argparse.Namespace) -> list[Path]:
    if args.workbooks:
        return [Path(value).expanduser().resolve() for value in args.workbooks]
    return DEFAULT_WORKBOOKS


def candidate_gate(family: str, count: int, diagnostic_count: int) -> str:
    if count == 0:
        return "not_present"
    if diagnostic_count:
        return "hold_for_diagnostics"
    if family == "pivot_table":
        return "candidate_pivot_metadata_review"
    if family == "sparkline":
        return "candidate_narrow_write_review"
    if family == "ole_object":
        return "candidate_ole_replace_review"
    return "hold_unknown_family"


def write_supported_from_gates(gates: dict[str, str]) -> bool:
    return any(
        gates.get(family) == required_candidate_gate(family)
        for family in ("pivot_table", "sparkline", "ole_object")
    )


def mutation_status_from_gates(gates: dict[str, str]) -> str:
    statuses = []
    if gates.get("sparkline") == required_candidate_gate("sparkline"):
        statuses.append("update_source_only")
    if gates.get("pivot_table") == required_candidate_gate("pivot_table"):
        statuses.append("update_pivot_metadata_only")
    if gates.get("ole_object") == required_candidate_gate("ole_object"):
        statuses.append("replace_existing_package_only")
    if len(statuses) > 1:
        return "semantic_write_available"
    if statuses:
        return statuses[0]
    return "no_write_boundary"


def required_candidate_gate(family: str) -> str:
    if family == "pivot_table":
        return "candidate_pivot_metadata_review"
    if family == "sparkline":
        return "candidate_narrow_write_review"
    if family == "ole_object":
        return "candidate_ole_replace_review"
    return "candidate_narrow_write_review"


def family_counts(objects: list[dict[str, str]]) -> dict[str, int]:
    counts = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    for item in objects:
        object_type = item.get("object_type", "")
        if object_type in counts:
            counts[object_type] += 1
    return counts


def family_diagnostics(diagnostics: list[dict[str, str]]) -> dict[str, int]:
    counts = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    for item in diagnostics:
        object_type = item.get("object_type", "")
        if object_type in counts:
            counts[object_type] += 1
    return counts


def audit_workbook(path: Path) -> dict[str, Any]:
    import sheet_shadow_core

    engine = sheet_shadow_core.SheetShadowEngine()
    engine.ingest(str(path))
    sheets = sorted(engine.sqlite_table_names().keys())
    sheet_reports = []
    workbook_counts = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    workbook_diagnostics = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    object_count = 0
    diagnostic_count = 0

    for sheet in sheets:
        inventory = engine.high_risk_object_inventory(sheet)
        diagnostics = engine.high_risk_object_diagnostics(sheet)
        status = engine.high_risk_object_status(sheet)
        reads = [
            engine.read_high_risk_object(sheet, item["object_id"])
            for item in inventory
        ]
        counts = family_counts(inventory)
        diag_counts = family_diagnostics(diagnostics)
        for family, count in counts.items():
            workbook_counts[family] += count
        for family, count in diag_counts.items():
            workbook_diagnostics[family] += count
        object_count += len(inventory)
        diagnostic_count += len(diagnostics)
        sheet_reports.append(
            {
                "sheet": sheet,
                "status": status,
                "family_counts": counts,
                "diagnostic_counts": diag_counts,
                "objects": reads,
                "diagnostics": diagnostics,
            }
        )

    family_gates = {
        family: candidate_gate(
            family,
            workbook_counts[family],
            workbook_diagnostics[family],
        )
        for family in sorted(workbook_counts)
    }
    write_supported = write_supported_from_gates(family_gates)
    return {
        "workbook": str(path),
        "ok": True,
        "sheet_count": len(sheets),
        "object_count": object_count,
        "diagnostic_count": diagnostic_count,
        "family_counts": workbook_counts,
        "diagnostic_counts": workbook_diagnostics,
        "family_gates": family_gates,
        "write_supported": write_supported,
        "mutation_status": mutation_status_from_gates(family_gates),
        "sheets": sheet_reports,
    }


def summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    diagnostics = {"pivot_table": 0, "sparkline": 0, "ole_object": 0}
    failed = 0
    for report in reports:
        if not report.get("ok"):
            failed += 1
            continue
        for family in totals:
            totals[family] += int(report["family_counts"][family])
            diagnostics[family] += int(report["diagnostic_counts"][family])
    gates = {
        family: candidate_gate(family, totals[family], diagnostics[family])
        for family in sorted(totals)
    }
    write_supported = write_supported_from_gates(gates)
    return {
        "workbook_count": len(reports),
        "failed_workbook_count": failed,
        "family_counts": totals,
        "diagnostic_counts": diagnostics,
        "family_gates": gates,
        "write_supported": write_supported,
        "mutation_status": mutation_status_from_gates(gates),
    }


def run_audit(paths: list[Path]) -> dict[str, Any]:
    reports = []
    for path in paths:
        try:
            reports.append(audit_workbook(path))
        except Exception as exc:  # noqa: BLE001 - audit must continue across samples.
            reports.append(
                {
                    "workbook": str(path),
                    "ok": False,
                    "error": str(exc),
                    "write_supported": False,
                    "mutation_status": "no_write_boundary",
                }
            )
    return {
        "audit": "sheet_shadow_high_risk_workbook_audit",
        "schema_version": "1",
        "summary": summarize(reports),
        "workbooks": reports,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit Sheet Shadow high-risk Excel objects without mutating workbooks."
    )
    parser.add_argument("workbooks", nargs="*", help="Workbook paths to audit.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="Print only the top-level summary and workbook list.",
    )
    parser.add_argument(
        "--require-candidate",
        action="append",
        choices=["pivot_table", "sparkline", "ole_object"],
        default=[],
        help="Require a family to pass the write-candidate gate.",
    )
    args = parser.parse_args(argv)

    ensure_repo_import_path()
    result = run_audit(workbook_paths(args))
    required_failures = [
        {
            "family": family,
            "gate": result["summary"]["family_gates"].get(family, "missing"),
            "required_gate": required_candidate_gate(family),
        }
        for family in args.require_candidate
        if result["summary"]["family_gates"].get(family) != required_candidate_gate(family)
    ]
    result["summary"]["candidate_gate_ok"] = not required_failures
    result["summary"]["candidate_gate_failures"] = required_failures
    if args.summary_only:
        result = {
            "audit": result["audit"],
            "schema_version": result["schema_version"],
            "summary": result["summary"],
            "workbooks": [
                {
                    "workbook": item["workbook"],
                    "ok": item["ok"],
                    "sheet_count": item.get("sheet_count", 0),
                    "object_count": item.get("object_count", 0),
                    "diagnostic_count": item.get("diagnostic_count", 0),
                    "family_counts": item.get("family_counts", {}),
                    "diagnostic_counts": item.get("diagnostic_counts", {}),
                    "family_gates": item.get("family_gates", {}),
                    "write_supported": item.get("write_supported", False),
                    "mutation_status": item.get("mutation_status", "no_write_boundary"),
                    "error": item.get("error", ""),
                }
                for item in result["workbooks"]
            ],
        }
    indent = 2 if args.pretty else None
    print(json.dumps(result, ensure_ascii=False, indent=indent, sort_keys=True))
    if result["summary"]["failed_workbook_count"]:
        return 1
    if result["summary"]["candidate_gate_failures"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
