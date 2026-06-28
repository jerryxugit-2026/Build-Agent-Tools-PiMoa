#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ("pivot_table", "sparkline", "ole_object")


def ensure_repo_import_path() -> None:
    root_text = str(ROOT)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)


def load_engine(path: Path):
    import sheet_shadow_core

    engine = sheet_shadow_core.SheetShadowEngine()
    engine.ingest(str(path))
    return engine


def sheet_names(engine) -> list[str]:
    return sorted(engine.sqlite_table_names().keys())


def object_diagnostics(engine, sheet: str, object_id: str) -> list[dict[str, str]]:
    return [
        item
        for item in engine.high_risk_object_diagnostics(sheet)
        if item.get("object_id") == object_id
    ]


def first_clean_object(engine, family: str) -> tuple[str, dict[str, str]] | None:
    for sheet in sheet_names(engine):
        for item in engine.high_risk_object_inventory(sheet):
            if item.get("object_type") != family:
                continue
            if item.get("write_supported") != "true":
                continue
            if object_diagnostics(engine, sheet, item["object_id"]):
                continue
            return sheet, item
    return None


def output_path_for(output_dir: Path, workbook: Path, family: str) -> Path:
    return output_dir / f"{workbook.stem}.{family}.smoke.xlsx"


def event_types(events: list[dict[str, Any]]) -> list[str]:
    return sorted({str(event.get("event_type", "")) for event in events})


def save_and_reingest(engine, output_path: Path, sheet: str, object_id: str) -> dict[str, str]:
    engine.save(str(output_path))
    reingested = load_engine(output_path)
    return reingested.read_high_risk_object(sheet, object_id)


def smoke_pivot(workbook: Path, output_dir: Path) -> dict[str, Any]:
    engine = load_engine(workbook)
    found = first_clean_object(engine, "pivot_table")
    if found is None:
        return {"family": "pivot_table", "ok": False, "error": "no_clean_pivot_table_candidate"}
    sheet, item = found
    object_id = item["object_id"]
    before = engine.read_high_risk_object(sheet, object_id)
    new_name = f"{before.get('name') or 'Pivot'}_SS_SMOKE"
    new_caption = f"{before.get('pivot_data_caption') or 'Values'}_SS_SMOKE"
    preview = engine.preview_update_pivot_metadata(sheet, object_id, new_name, new_caption)
    update = engine.update_pivot_metadata(sheet, object_id, new_name, new_caption)
    output_path = output_path_for(output_dir, workbook, "pivot_table")
    after = save_and_reingest(engine, output_path, sheet, object_id)
    return {
        "family": "pivot_table",
        "ok": after.get("name") == new_name
        and after.get("pivot_data_caption") == new_caption,
        "workbook": str(workbook),
        "output_path": str(output_path),
        "sheet": sheet,
        "object_id": object_id,
        "preview_events": event_types(preview),
        "update_events": event_types(update),
        "after": after,
    }


def smoke_sparkline(
    workbook: Path,
    output_dir: Path,
    source_formula: str | None,
    include_structure_follow: bool,
) -> dict[str, Any]:
    engine = load_engine(workbook)
    found = first_clean_object(engine, "sparkline")
    if found is None:
        return {"family": "sparkline", "ok": False, "error": "no_clean_sparkline_candidate"}
    sheet, item = found
    object_id = item["object_id"]
    before = engine.read_high_risk_object(sheet, object_id)
    replacement = source_formula or before.get("source_formula", "")
    if not replacement.strip():
        return {"family": "sparkline", "ok": False, "error": "missing_source_formula"}
    preview = engine.preview_update_sparkline_source(sheet, object_id, replacement)
    update = engine.update_sparkline_source(sheet, object_id, replacement)
    structure_events: list[str] = []
    if include_structure_follow:
        structure_events = event_types(engine.insert_rows(sheet, 10, 1))
    output_path = output_path_for(output_dir, workbook, "sparkline")
    after = save_and_reingest(engine, output_path, sheet, object_id)
    expected_source = replacement
    if include_structure_follow and expected_source:
        expected_source = after.get("source_formula", expected_source)
    return {
        "family": "sparkline",
        "ok": after.get("source_formula") == expected_source,
        "workbook": str(workbook),
        "output_path": str(output_path),
        "sheet": sheet,
        "object_id": object_id,
        "preview_events": event_types(preview),
        "update_events": event_types(update),
        "structure_events": structure_events,
        "before": before,
        "after": after,
    }


def replacement_path_for(
    output_dir: Path,
    workbook: Path,
    object_info: dict[str, str],
    explicit_replacement: Path | None,
) -> Path:
    if explicit_replacement is not None:
        return explicit_replacement
    extension = object_info.get("ole_extension") or "bin"
    replacement = output_dir / f"{workbook.stem}.replacement.{extension}"
    replacement.write_bytes(b"sheet-shadow-v3-ole-smoke-payload")
    return replacement


def smoke_ole(
    workbook: Path,
    output_dir: Path,
    explicit_replacement: Path | None,
) -> dict[str, Any]:
    engine = load_engine(workbook)
    found = first_clean_object(engine, "ole_object")
    if found is None:
        return {"family": "ole_object", "ok": False, "error": "no_clean_ole_object_candidate"}
    sheet, item = found
    object_id = item["object_id"]
    before = engine.read_high_risk_object(sheet, object_id)
    replacement = replacement_path_for(output_dir, workbook, before, explicit_replacement)
    preview = engine.preview_replace_ole_object(sheet, object_id, str(replacement))
    update = engine.replace_ole_object(sheet, object_id, str(replacement))
    output_path = output_path_for(output_dir, workbook, "ole_object")
    after = save_and_reingest(engine, output_path, sheet, object_id)
    return {
        "family": "ole_object",
        "ok": after.get("target_size") == str(replacement.stat().st_size),
        "workbook": str(workbook),
        "output_path": str(output_path),
        "replacement_path": str(replacement),
        "sheet": sheet,
        "object_id": object_id,
        "preview_events": event_types(preview),
        "update_events": event_types(update),
        "before": before,
        "after": after,
    }


def run_smokes(args: argparse.Namespace) -> dict[str, Any]:
    workbook = Path(args.workbook).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    families = FAMILIES if args.family == "all" else (args.family,)
    results = []
    for family in families:
        if family == "pivot_table":
            results.append(smoke_pivot(workbook, output_dir))
        elif family == "sparkline":
            results.append(
                smoke_sparkline(
                    workbook,
                    output_dir,
                    args.sparkline_source,
                    args.include_structure_follow,
                )
            )
        elif family == "ole_object":
            replacement = (
                Path(args.ole_replacement).expanduser().resolve()
                if args.ole_replacement
                else None
            )
            results.append(smoke_ole(workbook, output_dir, replacement))
    return {
        "smoke": "sheet_shadow_high_risk_candidate_smoke",
        "schema_version": "1",
        "workbook": str(workbook),
        "output_dir": str(output_dir),
        "ok": all(item.get("ok") for item in results),
        "results": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run V3 high-risk semantic smoke tests on a copied output workbook."
    )
    parser.add_argument("workbook", help="High-risk candidate workbook.")
    parser.add_argument(
        "--family",
        choices=("all", *FAMILIES),
        default="all",
        help="Family smoke to run.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory for generated output copies and temporary payloads.",
    )
    parser.add_argument(
        "--sparkline-source",
        help="Replacement sparkline source formula. Defaults to the existing source formula.",
    )
    parser.add_argument(
        "--include-structure-follow",
        action="store_true",
        help="Also run a row insert to verify sparkline structure follow on the output copy.",
    )
    parser.add_argument(
        "--ole-replacement",
        help="Replacement OLE payload path. Defaults to a generated same-extension payload.",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = parser.parse_args(argv)
    ensure_repo_import_path()
    payload = run_smokes(args)
    print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if payload["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
