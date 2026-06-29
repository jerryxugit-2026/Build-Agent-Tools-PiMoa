from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, BinaryIO
from xml.etree import ElementTree as ET

import sheet_shadow_core


SERVER_NAME = "sheet-shadow-mcp"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2024-11-05"


@dataclass
class WorkbookSession:
    workbook_id: str
    file_path: str
    engine: Any
    created_at: float
    last_accessed_at: float


class SheetShadowMcpServer:
    def __init__(self) -> None:
        self.sessions: dict[str, WorkbookSession] = {}

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        method = message.get("method")
        request_id = message.get("id")
        if request_id is None:
            return None

        try:
            if method == "initialize":
                result = self.initialize()
            elif method == "tools/list":
                result = {"tools": tool_specs()}
            elif method == "tools/call":
                result = self.call_tool(message.get("params") or {})
            else:
                return error_response(request_id, -32601, f"method not found: {method}")
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except ValueError as exc:
            return error_response(request_id, -32602, str(exc))
        except Exception as exc:  # noqa: BLE001 - tool failures must return JSON-RPC.
            return error_response(request_id, -32000, str(exc))

    def initialize(self) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "capabilities": {"tools": {"listChanged": False}},
        }

    def call_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = require_str(params, "name")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise ValueError("tools/call arguments must be an object")

        try:
            if name == "sheet_shadow_ingest":
                payload = self.tool_ingest(arguments)
            elif name == "sheet_shadow_table_names":
                payload = self.tool_table_names(arguments)
            elif name == "sheet_shadow_query":
                payload = self.tool_query(arguments)
            elif name == "sheet_shadow_update":
                payload = self.tool_update(arguments)
            elif name == "sheet_shadow_batch_update":
                payload = self.tool_batch_update(arguments)
            elif name == "sheet_shadow_preview_update":
                payload = self.tool_preview_update(arguments)
            elif name == "sheet_shadow_set_formula":
                payload = self.tool_set_formula(arguments)
            elif name == "sheet_shadow_preview_set_formula":
                payload = self.tool_preview_set_formula(arguments)
            elif name == "sheet_shadow_set_cell_format":
                payload = self.tool_set_cell_format(arguments)
            elif name == "sheet_shadow_preview_set_cell_format":
                payload = self.tool_preview_set_cell_format(arguments)
            elif name == "sheet_shadow_merge_cells":
                payload = self.tool_merge_cells(arguments)
            elif name == "sheet_shadow_unmerge_cells":
                payload = self.tool_unmerge_cells(arguments)
            elif name == "sheet_shadow_preview_merge_cells":
                payload = self.tool_preview_merge_cells(arguments)
            elif name == "sheet_shadow_preview_unmerge_cells":
                payload = self.tool_preview_unmerge_cells(arguments)
            elif name == "sheet_shadow_rename_sheet":
                payload = self.tool_rename_sheet(arguments)
            elif name == "sheet_shadow_set_sheet_visibility":
                payload = self.tool_set_sheet_visibility(arguments)
            elif name == "sheet_shadow_edit_structure":
                payload = self.tool_edit_structure(arguments)
            elif name == "sheet_shadow_preview_edit_structure":
                payload = self.tool_preview_edit_structure(arguments)
            elif name == "sheet_shadow_edit_object_rule":
                payload = self.tool_edit_object_rule(arguments)
            elif name == "sheet_shadow_preview_edit_object_rule":
                payload = self.tool_preview_edit_object_rule(arguments)
            elif name == "sheet_shadow_object_inventory":
                payload = self.tool_object_inventory(arguments)
            elif name == "sheet_shadow_drawing_inventory":
                payload = self.tool_drawing_inventory(arguments)
            elif name == "sheet_shadow_drawing_diagnostics":
                payload = self.tool_drawing_diagnostics(arguments)
            elif name == "sheet_shadow_high_risk_inventory":
                payload = self.tool_high_risk_inventory(arguments)
            elif name == "sheet_shadow_high_risk_diagnostics":
                payload = self.tool_high_risk_diagnostics(arguments)
            elif name == "sheet_shadow_high_risk_status":
                payload = self.tool_high_risk_status(arguments)
            elif name == "sheet_shadow_read_high_risk_object":
                payload = self.tool_read_high_risk_object(arguments)
            elif name == "sheet_shadow_edit_high_risk_object":
                payload = self.tool_edit_high_risk_object(arguments)
            elif name == "sheet_shadow_preview_edit_high_risk_object":
                payload = self.tool_preview_edit_high_risk_object(arguments)
            elif name == "sheet_shadow_edit_visual_object":
                payload = self.tool_edit_visual_object(arguments)
            elif name == "sheet_shadow_preview_edit_visual_object":
                payload = self.tool_preview_edit_visual_object(arguments)
            elif name == "sheet_shadow_get_cell":
                payload = self.tool_get_cell(arguments)
            elif name == "sheet_shadow_get_cell_typed":
                payload = self.tool_get_cell_typed(arguments)
            elif name == "sheet_shadow_get_cell_meta":
                payload = self.tool_get_cell_meta(arguments)
            elif name == "sheet_shadow_formula_diagnostics":
                payload = self.tool_formula_diagnostics(arguments)
            elif name == "sheet_shadow_persist_audit_snapshot":
                payload = self.tool_persist_audit_snapshot(arguments)
            elif name == "sheet_shadow_store_status":
                payload = self.tool_store_status(arguments)
            elif name == "sheet_shadow_save":
                payload = self.tool_save(arguments)
            elif name == "sheet_shadow_delivery_gate":
                payload = self.tool_delivery_gate(arguments)
            elif name == "sheet_shadow_diff_report":
                payload = self.tool_diff_report(arguments)
            elif name == "sheet_shadow_status":
                payload = self.tool_status(arguments)
            elif name == "sheet_shadow_close":
                payload = self.tool_close(arguments)
            else:
                raise ValueError(f"unknown tool: {name}")
            return tool_result(payload)
        except Exception as exc:  # noqa: BLE001 - tool calls report isError content.
            return tool_result(error_payload(exc), is_error=True)

    def tool_ingest(self, arguments: dict[str, Any]) -> dict[str, Any]:
        file_path = require_str(arguments, "file_path")
        workbook_id = arguments.get("workbook_id") or f"workbook-{uuid.uuid4().hex[:12]}"
        if not isinstance(workbook_id, str) or not workbook_id.strip():
            raise ValueError("workbook_id must be a non-empty string")

        engine = sheet_shadow_core.SheetShadowEngine()
        engine.ingest(file_path)
        now = time.time()
        self.sessions[workbook_id] = WorkbookSession(workbook_id, file_path, engine, now, now)
        return operation_payload(
            {
                "workbook_id": workbook_id,
                "file_path": file_path,
                "tables": engine.sqlite_table_names(),
                "meta_count": engine.shadow_meta_count(),
                "workbook_status": engine.workbook_status(),
            },
            completed=[
                "workbook_ingested",
                "source_snapshot_recorded",
                "sqlite_projection_ready",
                "formula_dependencies_built",
            ],
        )

    def tool_table_names(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        return operation_payload(
            {"workbook_id": session.workbook_id, "tables": session.engine.sqlite_table_names()},
            completed=["sqlite_table_names_returned"],
        )

    def tool_query(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sql = require_str(arguments, "sql")
        sqlite_path = arguments.get("sqlite_path")
        if sqlite_path is not None:
            sqlite_path = require_store_path(arguments)
            return operation_payload(
                {
                    "workbook_id": session.workbook_id,
                    "sqlite_path": sqlite_path,
                    "rows": session.engine.sqlite_store_query(sqlite_path, sql),
                },
                completed=["store_backed_select_query"],
            )
        return operation_payload(
            {"workbook_id": session.workbook_id, "rows": session.engine.sqlite_query(sql)},
            completed=["sqlite_select_query"],
        )

    def tool_update(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sql = require_str(arguments, "sql")
        sqlite_path = arguments.get("sqlite_path")
        if sqlite_path is not None:
            sqlite_path = require_store_path(arguments)
            impacted = session.engine.sqlite_store_update(sqlite_path, sql)
            completed_base = "store_backed_sqlite_update"
            extra_payload = {"sqlite_path": sqlite_path}
            extra_completed = ["store_snapshot_refreshed"]
        else:
            impacted = session.engine.sqlite_update(sql)
            completed_base = "sqlite_update"
            extra_payload = {}
            extra_completed = []
        diff_report = session.engine.diff_report()
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        completed = completed_from_events(diff_report, completed_base)
        completed.extend(extra_completed)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                **extra_payload,
                "impacted_cells": [cell_coord_to_dict(cell) for cell in impacted],
                "diff_report": diff_report,
            },
            completed=completed,
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_batch_update(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        updates = arguments.get("updates")
        if not isinstance(updates, list) or not updates:
            raise ValueError("unsafe_update: updates must be a non-empty list")
        normalized = []
        for item in updates:
            if not isinstance(item, dict):
                raise ValueError("unsafe_update: each update must be an object")
            normalized.append(
                (
                    require_str(item, "sheet"),
                    require_int(item, "row"),
                    require_int(item, "col"),
                    require_str(item, "value"),
                )
            )
        diff_report = session.engine.batch_update_cells(normalized)
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "batch_update"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_preview_update(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        preview = session.engine.preview_update_cell(
            require_str(arguments, "sheet"),
            require_int(arguments, "row"),
            require_int(arguments, "col"),
            require_str(arguments, "value"),
        )
        diagnostics = dependency_diagnostics_for_events(session, preview)
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_update"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_set_formula(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        row = require_int(arguments, "row")
        col = require_int(arguments, "col")
        impacted = session.engine.set_formula(
            sheet,
            row,
            col,
            require_str(arguments, "formula"),
        )
        diff_report = session.engine.diff_report()
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        diagnostics.extend(session.engine.formula_dependency_diagnostics(sheet, row, col))
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "impacted_cells": [cell_coord_to_dict(cell) for cell in impacted],
                "diff_report": diff_report,
            },
            completed=completed_from_events(diff_report, "set_formula"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_preview_set_formula(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        row = require_int(arguments, "row")
        col = require_int(arguments, "col")
        preview = session.engine.preview_set_formula(
            sheet,
            row,
            col,
            require_str(arguments, "formula"),
        )
        diagnostics = dependency_diagnostics_for_events(session, preview)
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_set_formula"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_set_cell_format(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.set_cell_format(
            require_str(arguments, "sheet"),
            require_int(arguments, "row"),
            require_int(arguments, "col"),
            require_format_intent(arguments),
        )
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "set_cell_format"),
        )

    def tool_preview_set_cell_format(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        preview = session.engine.preview_set_cell_format(
            require_str(arguments, "sheet"),
            require_int(arguments, "row"),
            require_int(arguments, "col"),
            require_format_intent(arguments),
        )
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_set_cell_format"),
        )

    def tool_merge_cells(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.merge_cells(*merge_args(arguments))
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "merge_cells"),
        )

    def tool_unmerge_cells(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.unmerge_cells(*merge_args(arguments))
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "unmerge_cells"),
        )

    def tool_preview_merge_cells(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        preview = session.engine.preview_merge_cells(*merge_args(arguments))
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_merge_cells"),
        )

    def tool_preview_unmerge_cells(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        preview = session.engine.preview_unmerge_cells(*merge_args(arguments))
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_unmerge_cells"),
        )

    def tool_rename_sheet(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.rename_sheet(
            require_str(arguments, "sheet"),
            require_str(arguments, "new_name"),
        )
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "rename_sheet"),
        )

    def tool_set_sheet_visibility(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.set_sheet_visibility(
            require_str(arguments, "sheet"),
            require_str(arguments, "visibility"),
        )
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "set_sheet_visibility"),
        )

    def tool_edit_structure(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diff_report = apply_structure_tool(session.engine, arguments, preview=False)
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        diagnostics.extend(session.engine.drawing_relationship_diagnostics(sheet))
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "edit_structure"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_preview_edit_structure(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        preview = apply_structure_tool(session.engine, arguments, preview=True)
        diagnostics = dependency_diagnostics_for_events(session, preview)
        diagnostics.extend(session.engine.drawing_relationship_diagnostics(sheet))
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_edit_structure"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_edit_object_rule(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = apply_object_rule_tool(session.engine, arguments, preview=False)
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "edit_object_rule"),
        )

    def tool_preview_edit_object_rule(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        preview = apply_object_rule_tool(session.engine, arguments, preview=True)
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_edit_object_rule"),
        )

    def tool_object_inventory(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "objects": session.engine.object_inventory(sheet),
            },
            completed=["object_inventory_returned"],
        )

    def tool_drawing_inventory(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diagnostics = session.engine.drawing_relationship_diagnostics(sheet)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "objects": session.engine.drawing_object_inventory(sheet),
            },
            completed=["drawing_inventory_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_drawing_diagnostics(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diagnostics = session.engine.drawing_relationship_diagnostics(sheet)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "diagnostic_count": len(diagnostics),
            },
            completed=["drawing_diagnostics_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_high_risk_inventory(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diagnostics = session.engine.high_risk_object_diagnostics(sheet)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "objects": session.engine.high_risk_object_inventory(sheet),
            },
            completed=["high_risk_inventory_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_high_risk_diagnostics(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diagnostics = session.engine.high_risk_object_diagnostics(sheet)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "diagnostic_count": len(diagnostics),
            },
            completed=["high_risk_diagnostics_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_high_risk_status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diagnostics = session.engine.high_risk_object_diagnostics(sheet)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "status": session.engine.high_risk_object_status(sheet),
            },
            completed=["high_risk_status_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_read_high_risk_object(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        object_id = require_str(arguments, "object_id")
        diagnostics = [
            item
            for item in session.engine.high_risk_object_diagnostics(sheet)
            if item.get("object_id") == object_id
        ]
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "object_id": object_id,
                "object": session.engine.read_high_risk_object(sheet, object_id),
            },
            completed=["high_risk_object_read"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_edit_high_risk_object(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diff_report = apply_high_risk_object_tool(session.engine, arguments, preview=False)
        diagnostics = [
            item
            for item in session.engine.high_risk_object_diagnostics(sheet)
            if item.get("object_id") == require_str(arguments, "object_id")
        ]
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "edit_high_risk_object"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_preview_edit_high_risk_object(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        preview = apply_high_risk_object_tool(session.engine, arguments, preview=True)
        diagnostics = [
            item
            for item in session.engine.high_risk_object_diagnostics(sheet)
            if item.get("object_id") == require_str(arguments, "object_id")
        ]
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_edit_high_risk_object"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_edit_visual_object(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        diff_report = apply_visual_object_tool(session.engine, arguments, preview=False)
        diagnostics = session.engine.drawing_relationship_diagnostics(sheet)
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=completed_from_events(diff_report, "edit_visual_object"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_preview_edit_visual_object(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        preview = apply_visual_object_tool(session.engine, arguments, preview=True)
        diagnostics = session.engine.drawing_relationship_diagnostics(sheet)
        return operation_payload(
            {"workbook_id": session.workbook_id, "preview": preview},
            completed=completed_from_events(preview, "preview_edit_visual_object"),
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_get_cell(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        row = require_int(arguments, "row")
        col = require_int(arguments, "col")
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "row": row,
                "col": col,
                "value": session.engine.get_cell_value(sheet, row, col),
            },
            completed=["cell_value_returned"],
        )

    def tool_get_cell_typed(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "cell": session.engine.get_cell_typed_value(
                    require_str(arguments, "sheet"),
                    require_int(arguments, "row"),
                    require_int(arguments, "col"),
                ),
            },
            completed=["typed_cell_value_returned"],
        )

    def tool_get_cell_meta(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sheet = require_str(arguments, "sheet")
        row = require_int(arguments, "row")
        col = require_int(arguments, "col")
        meta = session.engine.get_cell_meta(sheet, row, col)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sheet": sheet,
                "row": row,
                "col": col,
                "meta": meta_record_to_dict(meta) if meta is not None else None,
            },
            completed=["cell_meta_returned"],
        )

    def tool_formula_diagnostics(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diagnostics = session.engine.formula_dependency_diagnostics(
            require_str(arguments, "sheet"),
            require_int(arguments, "row"),
            require_int(arguments, "col"),
        )
        return operation_payload(
            {"workbook_id": session.workbook_id, "diagnostics": diagnostics},
            completed=["formula_dependency_diagnostics_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_persist_audit_snapshot(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sqlite_path = require_store_path(arguments)
        allow_overwrite = bool(arguments.get("allow_overwrite", False))
        store_existed_before_persist = os.path.exists(sqlite_path)
        if store_existed_before_persist and not allow_overwrite:
            raise ValueError(f"store_path_error: output already exists: {sqlite_path}")
        summary = session.engine.persist_audit_snapshot(sqlite_path)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "source_path": session.file_path,
                "persisted": True,
                "sqlite_path": sqlite_path,
                "allow_overwrite": allow_overwrite,
                "store_existed_before_persist": store_existed_before_persist,
                "overwrite_intent": (
                    "explicit_overwrite"
                    if store_existed_before_persist and allow_overwrite
                    else "new_store_path"
                ),
                "summary": summary,
            },
            completed=[
                "audit_snapshot_persisted",
                "production_store_snapshot_written",
                "graph_projection_persisted",
            ],
        )

    def tool_store_status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        sqlite_path = require_store_path(arguments)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "sqlite_path": sqlite_path,
                "store_status": session.engine.sqlite_store_status(sqlite_path),
            },
            completed=["store_status_returned"],
        )

    def tool_save(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        output_path = require_save_path(arguments)
        allow_overwrite = bool(arguments.get("allow_overwrite", False))
        shared_string_policy = arguments.get("shared_string_policy", "preserve")
        if shared_string_policy not in {"preserve", "update_unique", "auto"}:
            raise ValueError(f"shared_string_policy: unsupported policy: {shared_string_policy}")
        if same_existing_path(output_path, session.file_path):
            raise ValueError(
                f"save_path_error: output_path must not equal active workbook source path: {output_path}"
            )
        output_existed_before_save = os.path.exists(output_path)
        if output_existed_before_save and not allow_overwrite:
            raise ValueError(f"save_path_error: output already exists: {output_path}")
        session.engine.save(output_path, shared_string_policy)
        return operation_payload(
            {
                "workbook_id": session.workbook_id,
                "source_path": session.file_path,
                "saved": True,
                "output_path": output_path,
                "allow_overwrite": allow_overwrite,
                "output_existed_before_save": output_existed_before_save,
                "overwrite_intent": (
                    "explicit_overwrite"
                    if output_existed_before_save and allow_overwrite
                    else "new_output_path"
                ),
                "shared_string_policy": shared_string_policy,
            },
            completed=["workbook_saved"],
        )

    def tool_delivery_gate(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        output_path = require_save_path(arguments)
        run_external_recalc = bool(arguments.get("run_external_recalc", False))
        if same_existing_path(output_path, session.file_path):
            raise ValueError(
                f"save_path_error: output_path must not equal active workbook source path: {output_path}"
            )
        if not os.path.exists(output_path):
            raise ValueError(f"delivery_gate_error: output workbook does not exist: {output_path}")

        status = session.engine.workbook_status()
        source_session_fresh = status.get("source_snapshot_state") == "fresh"
        diff_report = session.engine.diff_report()
        formula_scan = scan_xlsx_formula_errors(output_path)
        package_drift = (
            package_drift_report(session.file_path, output_path, diff_report)
            if source_session_fresh
            else empty_package_drift_report("skipped_stale_source")
        )
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        not_completed = not_completed_from_diagnostics(diagnostics)
        warnings: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        completed = [
            "delivery_gate_ran",
            "output_path_verified",
            "formula_error_scan_completed",
            "diff_manifest_collected",
            "workbook_status_collected",
        ]
        if source_session_fresh:
            completed.append("package_drift_checked")
        else:
            errors.append(
                {
                    "code": "stale_session",
                    "message": status.get(
                        "source_snapshot_detail",
                        "Source workbook changed after ingest; re-ingest before delivery",
                    ),
                    "source_snapshot_state": status.get("source_snapshot_state", "unknown"),
                }
            )
            not_completed.extend(["source_session_fresh", "package_drift_check"])

        recalc_status = external_recalc_report(output_path, run_external_recalc)
        if run_external_recalc:
            if recalc_status["status"] == "completed":
                completed.append("external_recalc_completed")
                formula_scan = recalc_status["formula_scan"]
            else:
                warnings.append(
                    {
                        "code": f"external_recalc_{recalc_status['status']}",
                        "severity": "warning",
                        "message": recalc_status["message"],
                        "not_completed": "external_recalc",
                    }
                )
                not_completed.append("external_recalc")

        if formula_scan["total_errors"]:
            errors.append(
                {
                    "code": "formula_errors_found",
                    "message": "Formula or cell error values were found in the saved workbook",
                    "error_summary": formula_scan["error_summary"],
                    "locations": formula_scan["error_locations"],
                }
            )
            not_completed.append("zero_formula_errors")
        else:
            completed.append("zero_formula_errors")

        if not diff_report:
            warnings.append(
                {
                    "code": "empty_diff_manifest",
                    "severity": "warning",
                    "message": "No current Sheet Shadow diff/audit events were found for this session",
                    "not_completed": "changed_manifest_review",
                }
            )
            not_completed.append("changed_manifest_review")

        if package_drift["unexpected_changed_entries"]:
            warnings.append(
                {
                    "code": "unexpected_package_drift",
                    "severity": "warning",
                    "message": "Saved workbook contains package entry changes outside the expected diff surface",
                    "not_completed": "unexpected_package_drift_review",
                    "entries": package_drift["unexpected_changed_entries"],
                }
            )
            not_completed.append("unexpected_package_drift_review")
        else:
            completed.append("no_unexpected_package_drift")

        if package_drift["macro_drift_entries"]:
            errors.append(
                {
                    "code": "macro_drift_detected",
                    "message": "Macro/VBA package entries changed or disappeared during delivery",
                    "entries": package_drift["macro_drift_entries"],
                }
            )
            not_completed.append("macro_preservation")
        else:
            completed.append("macro_parts_preserved")

        delivery_report = {
            "status": delivery_status(errors, warnings, not_completed),
            "source_path": session.file_path,
            "output_path": output_path,
            "output_exists": True,
            "output_size_bytes": os.path.getsize(output_path),
            "workbook_status": status,
            "diff_event_count": len(diff_report),
            "diff_event_types": sorted({str(event.get("event_type", "")) for event in diff_report}),
            "formula_scan": formula_scan,
            "recalc": recalc_status,
            "package_drift": package_drift,
            "policy_checks": {
                "source_not_overwritten": True,
                "existing_workbook_fidelity_save_path": True,
                "openpyxl_pandas_core_save_path": False,
                "source_session_fresh": source_session_fresh,
                "no_unexpected_package_drift": not package_drift["unexpected_changed_entries"],
                "macro_parts_preserved": not package_drift["macro_drift_entries"],
            },
        }
        return operation_payload(
            {"workbook_id": session.workbook_id, "delivery_report": delivery_report},
            completed=completed,
            not_completed=not_completed,
            diagnostics=[*diagnostics, *warnings],
            errors=errors,
        )

    def tool_diff_report(self, arguments: dict[str, Any]) -> dict[str, Any]:
        session = self.require_session(arguments)
        diff_report = session.engine.diff_report()
        diagnostics = dependency_diagnostics_for_events(session, diff_report)
        return operation_payload(
            {"workbook_id": session.workbook_id, "diff_report": diff_report},
            completed=["diff_report_returned"],
            not_completed=not_completed_from_diagnostics(diagnostics),
            diagnostics=diagnostics,
        )

    def tool_status(self, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        arguments = arguments or {}
        workbook_id = arguments.get("workbook_id")
        if workbook_id:
            session = self.require_session(arguments)
            status = session.engine.workbook_status()
            status.update(
                {
                    "workbook_id": session.workbook_id,
                    "file_path": session.file_path,
                    "created_at": str(session.created_at),
                    "last_accessed_at": str(session.last_accessed_at),
                }
            )
            return operation_payload(status, completed=["workbook_status_returned"])
        return operation_payload(
            {
                "server": SERVER_NAME,
                "active_workbook_ids": sorted(self.sessions),
                "session_count": len(self.sessions),
            },
            completed=["server_status_returned"],
        )

    def tool_close(self, arguments: dict[str, Any]) -> dict[str, Any]:
        workbook_id = require_str(arguments, "workbook_id")
        existed = self.sessions.pop(workbook_id, None) is not None
        return operation_payload(
            {"workbook_id": workbook_id, "closed": existed},
            completed=["workbook_session_closed"] if existed else [],
            not_completed=[] if existed else ["workbook_session_not_found"],
        )

    def require_session(self, arguments: dict[str, Any]) -> WorkbookSession:
        workbook_id = require_str(arguments, "workbook_id")
        try:
            session = self.sessions[workbook_id]
        except KeyError as exc:
            raise ValueError(f"unknown workbook_id: {workbook_id}") from exc
        session.last_accessed_at = time.time()
        return session

def tool_specs() -> list[dict[str, Any]]:
    return [
        tool_spec(
            "sheet_shadow_ingest",
            "Load an .xlsx workbook into an in-memory sheet-shadow session.",
            {"file_path": string_schema(), "workbook_id": string_schema()},
            ["file_path"],
        ),
        tool_spec(
            "sheet_shadow_table_names",
            "Return the SQLite virtual table names for a workbook session.",
            {"workbook_id": string_schema()},
            ["workbook_id"],
        ),
        tool_spec(
            "sheet_shadow_query",
            "Run a SELECT query against workbook-backed SQLite tables; optionally use a persisted store snapshot.",
            {
                "workbook_id": string_schema(),
                "sql": string_schema(),
                "sqlite_path": string_schema(),
            },
            ["workbook_id", "sql"],
        ),
        tool_spec(
            "sheet_shadow_update",
            "Run a safe single-cell UPDATE through the workbook shadow engine; optionally refresh a persisted store snapshot.",
            {
                "workbook_id": string_schema(),
                "sql": string_schema(),
                "sqlite_path": string_schema(),
            },
            ["workbook_id", "sql"],
        ),
        tool_spec(
            "sheet_shadow_batch_update",
            "Run an explicit batch of cell updates through the workbook shadow engine.",
            {
                "workbook_id": string_schema(),
                "updates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "sheet": string_schema(),
                            "row": integer_schema(),
                            "col": integer_schema(),
                            "value": string_schema(),
                        },
                        "required": ["sheet", "row", "col", "value"],
                        "additionalProperties": False,
                    },
                },
            },
            ["workbook_id", "updates"],
        ),
        tool_spec(
            "sheet_shadow_preview_update",
            "Preview one update and impacted cells without mutating the active workbook session.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
                "value": string_schema(),
            },
            ["workbook_id", "sheet", "row", "col", "value"],
        ),
        tool_spec(
            "sheet_shadow_set_formula",
            "Set one cell formula through the workbook shadow engine and recalculate impacted formulas.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
                "formula": string_schema(),
            },
            ["workbook_id", "sheet", "row", "col", "formula"],
        ),
        tool_spec(
            "sheet_shadow_preview_set_formula",
            "Preview setting one cell formula without mutating the active workbook session.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
                "formula": string_schema(),
            },
            ["workbook_id", "sheet", "row", "col", "formula"],
        ),
        tool_spec(
            "sheet_shadow_set_cell_format",
            "Apply controlled cell format intents such as number format, font, fill, alignment, and wrap.",
            cell_format_schema(),
            ["workbook_id", "sheet", "row", "col", "format"],
        ),
        tool_spec(
            "sheet_shadow_preview_set_cell_format",
            "Preview controlled cell format intents without mutating the active workbook session.",
            cell_format_schema(),
            ["workbook_id", "sheet", "row", "col", "format"],
        ),
        tool_spec(
            "sheet_shadow_merge_cells",
            "Merge a rectangular cell range through the workbook shadow engine.",
            merge_schema(),
            ["workbook_id", "sheet", "start_row", "start_col", "end_row", "end_col"],
        ),
        tool_spec(
            "sheet_shadow_unmerge_cells",
            "Unmerge a rectangular cell range through the workbook shadow engine.",
            merge_schema(),
            ["workbook_id", "sheet", "start_row", "start_col", "end_row", "end_col"],
        ),
        tool_spec(
            "sheet_shadow_preview_merge_cells",
            "Preview merging a rectangular cell range without mutating the active workbook session.",
            merge_schema(),
            ["workbook_id", "sheet", "start_row", "start_col", "end_row", "end_col"],
        ),
        tool_spec(
            "sheet_shadow_preview_unmerge_cells",
            "Preview unmerging a rectangular cell range without mutating the active workbook session.",
            merge_schema(),
            ["workbook_id", "sheet", "start_row", "start_col", "end_row", "end_col"],
        ),
        tool_spec(
            "sheet_shadow_rename_sheet",
            "Rename one worksheet and update Sheet Shadow runtime references.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "new_name": string_schema(),
            },
            ["workbook_id", "sheet", "new_name"],
        ),
        tool_spec(
            "sheet_shadow_set_sheet_visibility",
            "Set worksheet visibility to visible, hidden, or veryHidden.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "visibility": {"type": "string", "enum": ["visible", "hidden", "veryHidden"]},
            },
            ["workbook_id", "sheet", "visibility"],
        ),
        tool_spec(
            "sheet_shadow_edit_structure",
            "Edit worksheet structure with row/column insert, delete, or move; formulas, tables, and defined names follow.",
            structure_edit_schema(),
            ["workbook_id", "sheet", "axis", "operation", "start"],
        ),
        tool_spec(
            "sheet_shadow_preview_edit_structure",
            "Preview row/column insert, delete, or move without mutating the active workbook session.",
            structure_edit_schema(),
            ["workbook_id", "sheet", "axis", "operation", "start"],
        ),
        tool_spec(
            "sheet_shadow_edit_object_rule",
            "Apply controlled comment, data validation, autofilter, or conditional-format object rules.",
            object_rule_schema(),
            ["workbook_id", "sheet", "object_type", "operation"],
        ),
        tool_spec(
            "sheet_shadow_preview_edit_object_rule",
            "Preview controlled object-rule edits without mutating the active workbook session.",
            object_rule_schema(),
            ["workbook_id", "sheet", "object_type", "operation"],
        ),
        tool_spec(
            "sheet_shadow_object_inventory",
            "Return Sheet Shadow's runtime object inventory for one worksheet.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_drawing_inventory",
            "Return chart, image, and shape drawing anchors for one worksheet without exposing raw OOXML mutation.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_drawing_diagnostics",
            "Validate drawing relationship ids and target package parts for one worksheet.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_high_risk_inventory",
            "Return pivot, sparkline, and OLE high-risk object inventory for one worksheet.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_high_risk_diagnostics",
            "Validate pivot cache, sparkline source, and OLE target boundaries for one worksheet.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_high_risk_status",
            "Return a high-risk object read/status summary for pivot, sparkline, and OLE objects.",
            {"workbook_id": string_schema(), "sheet": string_schema()},
            ["workbook_id", "sheet"],
        ),
        tool_spec(
            "sheet_shadow_read_high_risk_object",
            "Return one high-risk object's safe read summary without enabling mutation.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "object_id": string_schema(),
            },
            ["workbook_id", "sheet", "object_id"],
        ),
        tool_spec(
            "sheet_shadow_edit_high_risk_object",
            "Apply a narrow high-risk object edit. Currently only sparkline update_source is supported.",
            high_risk_object_edit_schema(),
            ["workbook_id", "sheet", "object_id", "object_type", "operation"],
        ),
        tool_spec(
            "sheet_shadow_preview_edit_high_risk_object",
            "Preview a narrow high-risk object edit without mutating the active workbook session.",
            high_risk_object_edit_schema(),
            ["workbook_id", "sheet", "object_id", "object_type", "operation"],
        ),
        tool_spec(
            "sheet_shadow_edit_visual_object",
            "Apply controlled chart, image, and shape/textbox edits by drawing object id.",
            visual_object_schema(),
            ["workbook_id", "sheet", "object_id", "operation"],
        ),
        tool_spec(
            "sheet_shadow_preview_edit_visual_object",
            "Preview controlled chart, image, and shape/textbox edits without mutating the active workbook session.",
            visual_object_schema(),
            ["workbook_id", "sheet", "object_id", "operation"],
        ),
        tool_spec(
            "sheet_shadow_get_cell",
            "Read one cell value from the workbook shadow model.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
            },
            ["workbook_id", "sheet", "row", "col"],
        ),
        tool_spec(
            "sheet_shadow_get_cell_typed",
            "Read one cell value plus type metadata from the workbook shadow model.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
            },
            ["workbook_id", "sheet", "row", "col"],
        ),
        tool_spec(
            "sheet_shadow_get_cell_meta",
            "Read one _shadow_meta record from the workbook shadow model.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
            },
            ["workbook_id", "sheet", "row", "col"],
        ),
        tool_spec(
            "sheet_shadow_formula_diagnostics",
            "Return machine-readable formula dependency diagnostics for one formula cell.",
            {
                "workbook_id": string_schema(),
                "sheet": string_schema(),
                "row": integer_schema(),
                "col": integer_schema(),
            },
            ["workbook_id", "sheet", "row", "col"],
        ),
        tool_spec(
            "sheet_shadow_persist_audit_snapshot",
            "Persist runtime audit, metadata, formula-edge, and graph snapshot tables to a Sheet Shadow SQLite store.",
            {
                "workbook_id": string_schema(),
                "sqlite_path": string_schema(),
                "allow_overwrite": {"type": "boolean"},
            },
            ["workbook_id", "sqlite_path"],
        ),
        tool_spec(
            "sheet_shadow_store_status",
            "Read status counters and sheet view names from a persisted Sheet Shadow SQLite store.",
            {"workbook_id": string_schema(), "sqlite_path": string_schema()},
            ["workbook_id", "sqlite_path"],
        ),
        tool_spec(
            "sheet_shadow_save",
            "Save the workbook to a caller-provided .xlsx output path.",
            {
                "workbook_id": string_schema(),
                "output_path": string_schema(),
                "allow_overwrite": {"type": "boolean"},
                "shared_string_policy": {
                    "type": "string",
                    "enum": ["preserve", "update_unique", "auto"],
                },
            },
            ["workbook_id", "output_path"],
        ),
        tool_spec(
            "sheet_shadow_delivery_gate",
            "Validate a saved output workbook with agent policy and delivery checks.",
            {
                "workbook_id": string_schema(),
                "output_path": string_schema(),
                "run_external_recalc": {"type": "boolean"},
            },
            ["workbook_id", "output_path"],
        ),
        tool_spec(
            "sheet_shadow_diff_report",
            "Return the current workbook session audit/diff report.",
            {"workbook_id": string_schema()},
            ["workbook_id"],
        ),
        tool_spec(
            "sheet_shadow_status",
            "Return active workbook ids and basic server diagnostics.",
            {"workbook_id": string_schema()},
            [],
        ),
        tool_spec(
            "sheet_shadow_close",
            "Close and remove an active workbook session.",
            {"workbook_id": string_schema()},
            ["workbook_id"],
        ),
    ]


def tool_spec(
    name: str, description: str, properties: dict[str, Any], required: list[str]
) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


def string_schema() -> dict[str, str]:
    return {"type": "string"}


def integer_schema() -> dict[str, str]:
    return {"type": "integer"}


def cell_format_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "row": integer_schema(),
        "col": integer_schema(),
        "format": {
            "type": "object",
            "properties": {
                "number_format": string_schema(),
                "bold": {"type": "boolean"},
                "italic": {"type": "boolean"},
                "font_color": string_schema(),
                "fill_color": string_schema(),
                "horizontal": {"type": "string", "enum": ["left", "center", "right"]},
                "vertical": {"type": "string", "enum": ["top", "center", "bottom"]},
                "wrap_text": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    }


def merge_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "start_row": integer_schema(),
        "start_col": integer_schema(),
        "end_row": integer_schema(),
        "end_col": integer_schema(),
    }


def operation_payload(
    payload: dict[str, Any],
    *,
    completed: list[str] | None = None,
    not_completed: list[str] | None = None,
    diagnostics: list[dict[str, Any]] | None = None,
    errors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    diagnostics = diagnostics or []
    errors = errors or []
    payload.update(
        {
            "ok": not errors,
            "completed": unique_strings(completed or []),
            "not_completed": unique_strings(not_completed or []),
            "diagnostics": diagnostics,
            "warnings": [item for item in diagnostics if item.get("severity") == "warning"],
            "errors": errors,
        }
    )
    return payload


def dependency_diagnostics_for_events(
    session: WorkbookSession, events: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    diagnostics: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int]] = set()
    for event in events:
        if event.get("event_type") != "formula_recalc":
            continue
        try:
            sheet = str(event["sheet"])
            row = int(event["row"])
            col = int(event["col"])
        except (KeyError, TypeError, ValueError):
            continue
        key = (sheet, row, col)
        if key in seen:
            continue
        seen.add(key)
        diagnostics.extend(session.engine.formula_dependency_diagnostics(sheet, row, col))
    return diagnostics


def completed_from_events(events: list[dict[str, Any]], base: str) -> list[str]:
    completed = [base]
    event_types = {event.get("event_type") for event in events}
    if "input_update" in event_types:
        completed.append("input_cells_updated")
    if "formula_update" in event_types:
        completed.append("formula_cells_updated")
    if "formula_recalc" in event_types:
        completed.append("dependent_formula_cells_recalculated")
    if "style_update" in event_types:
        completed.append("cell_formats_updated")
    if "merge_update" in event_types:
        completed.append("cell_ranges_merged")
    if "unmerge_update" in event_types:
        completed.append("cell_ranges_unmerged")
    if "sheet_rename" in event_types:
        completed.append("sheets_renamed")
    if "sheet_visibility_update" in event_types:
        completed.append("sheet_visibility_updated")
    if "structure_update" in event_types:
        completed.append("worksheet_structure_updated")
    if "table_range_update" in event_types:
        completed.append("table_ranges_followed")
    if "defined_name_update" in event_types:
        completed.append("defined_name_ranges_followed")
    if "comment_update" in event_types:
        completed.append("comments_updated")
    if "data_validation_update" in event_types:
        completed.append("data_validation_rules_updated")
    if "autofilter_update" in event_types:
        completed.append("autofilter_updated")
    if "conditional_format_update" in event_types:
        completed.append("conditional_format_rules_updated")
    if "object_range_update" in event_types:
        completed.append("object_ranges_followed")
    if "drawing_anchor_update" in event_types:
        completed.append("drawing_anchors_followed")
    if "drawing_object_update" in event_types:
        completed.append("drawing_objects_updated")
    if "drawing_image_replace" in event_types:
        completed.append("drawing_images_replaced")
    if "drawing_text_update" in event_types:
        completed.append("drawing_text_updated")
    if "chart_title_update" in event_types:
        completed.append("chart_titles_updated")
    if "chart_source_update" in event_types:
        completed.append("chart_sources_updated")
    if "sparkline_source_update" in event_types:
        completed.append("sparkline_sources_updated")
    if "sparkline_ref_update" in event_types:
        completed.append("sparkline_refs_updated")
    if "pivot_metadata_update" in event_types:
        completed.append("pivot_metadata_updated")
    if "ole_object_replace" in event_types:
        completed.append("ole_objects_replaced")
    if events:
        completed.append("audit_report_returned")
    return completed


def not_completed_from_diagnostics(diagnostics: list[dict[str, Any]]) -> list[str]:
    return unique_strings(
        str(item["not_completed"])
        for item in diagnostics
        if item.get("severity") == "warning" and item.get("not_completed")
    )


def unique_strings(values) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = str(value)
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def require_str(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value


def require_store_path(arguments: dict[str, Any]) -> str:
    value = arguments.get("sqlite_path")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("store_path_error: sqlite_path must be a non-empty string")
    return value


def require_save_path(arguments: dict[str, Any]) -> str:
    value = arguments.get("output_path")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("save_path_error: output_path must be a non-empty string")
    return value


def same_existing_path(left: str, right: str) -> bool:
    return os.path.exists(left) and os.path.exists(right) and os.path.samefile(left, right)


def require_int(arguments: dict[str, Any], key: str) -> int:
    value = arguments.get(key)
    if not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    if value < 1:
        raise ValueError(f"{key} must be positive")
    return value


def require_format_intent(arguments: dict[str, Any]) -> dict[str, str]:
    value = arguments.get("format")
    if not isinstance(value, dict) or not value:
        raise ValueError("unsafe_update: format must be a non-empty object")
    out: dict[str, str] = {}
    for key, item in value.items():
        if isinstance(item, bool):
            out[str(key)] = "true" if item else "false"
        elif isinstance(item, (str, int, float)):
            out[str(key)] = str(item)
        else:
            raise ValueError(f"unsafe_update: unsupported format value for {key}")
    return out


def merge_args(arguments: dict[str, Any]) -> tuple[str, int, int, int, int]:
    return (
        require_str(arguments, "sheet"),
        require_int(arguments, "start_row"),
        require_int(arguments, "start_col"),
        require_int(arguments, "end_row"),
        require_int(arguments, "end_col"),
    )


def structure_edit_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "axis": {"type": "string", "enum": ["row", "col"]},
        "operation": {"type": "string", "enum": ["insert", "delete", "move"]},
        "start": integer_schema(),
        "count": integer_schema(),
        "end": integer_schema(),
        "target": integer_schema(),
    }


def object_rule_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "object_type": {
            "type": "string",
            "enum": ["comment", "data_validation", "autofilter", "conditional_format"],
        },
        "operation": {"type": "string", "enum": ["set", "add", "remove", "clear"]},
        "row": integer_schema(),
        "col": integer_schema(),
        "start_row": integer_schema(),
        "start_col": integer_schema(),
        "end_row": integer_schema(),
        "end_col": integer_schema(),
        "text": string_schema(),
        "rule": {
            "type": "object",
            "properties": {
                "type": string_schema(),
                "operator": string_schema(),
                "formula": string_schema(),
                "formula1": string_schema(),
                "formula2": string_schema(),
                "allow_blank": {"type": "boolean"},
            },
            "additionalProperties": False,
        },
    }


def visual_object_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "object_id": string_schema(),
        "operation": {
            "type": "string",
            "enum": [
                "move",
                "resize",
                "replace_image",
                "update_text",
                "update_chart_title",
                "update_chart_source",
            ],
        },
        "start_row": integer_schema(),
        "start_col": integer_schema(),
        "end_row": integer_schema(),
        "end_col": integer_schema(),
        "image_path": string_schema(),
        "text": string_schema(),
        "title": string_schema(),
        "source_range": string_schema(),
    }


def high_risk_object_edit_schema() -> dict[str, Any]:
    return {
        "workbook_id": string_schema(),
        "sheet": string_schema(),
        "object_id": string_schema(),
        "object_type": {"type": "string", "enum": ["sparkline", "pivot_table", "ole_object"]},
        "operation": {
            "type": "string",
            "enum": ["update_source", "update_pivot_metadata", "replace_ole_object"],
        },
        "source_formula": string_schema(),
        "name": string_schema(),
        "data_caption": string_schema(),
        "ole_path": string_schema(),
    }


def apply_object_rule_tool(engine: Any, arguments: dict[str, Any], *, preview: bool) -> list[dict[str, Any]]:
    sheet = require_str(arguments, "sheet")
    object_type = require_str(arguments, "object_type")
    operation = require_str(arguments, "operation")
    prefix = "preview_" if preview else ""

    if object_type == "comment":
        row = require_int(arguments, "row")
        col = require_int(arguments, "col")
        if operation == "remove":
            if preview:
                raise ValueError("unsafe_update: preview remove comment is not implemented")
            return engine.remove_comment(sheet, row, col)
        if operation != "set":
            raise ValueError("unsafe_update: comment operation must be set or remove")
        return getattr(engine, f"{prefix}set_comment")(sheet, row, col, require_str(arguments, "text"))

    if object_type == "data_validation":
        if operation == "clear":
            if preview:
                raise ValueError("unsafe_update: preview clear data validations is not implemented")
            return engine.clear_data_validations(sheet)
        if operation != "set":
            raise ValueError("unsafe_update: data_validation operation must be set or clear")
        start_row, start_col, end_row, end_col = object_range_args(arguments)
        return getattr(engine, f"{prefix}set_data_validation")(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            require_rule(arguments),
        )

    if object_type == "autofilter":
        if operation == "clear":
            if preview:
                raise ValueError("unsafe_update: preview clear autofilter is not implemented")
            return engine.clear_autofilter(sheet)
        if operation != "set":
            raise ValueError("unsafe_update: autofilter operation must be set or clear")
        start_row, start_col, end_row, end_col = object_range_args(arguments)
        return getattr(engine, f"{prefix}set_autofilter")(
            sheet, start_row, start_col, end_row, end_col
        )

    if object_type == "conditional_format":
        if operation == "clear":
            if preview:
                raise ValueError("unsafe_update: preview clear conditional formats is not implemented")
            return engine.clear_conditional_formats(sheet)
        if operation not in {"add", "set"}:
            raise ValueError("unsafe_update: conditional_format operation must be add, set, or clear")
        start_row, start_col, end_row, end_col = object_range_args(arguments)
        return getattr(engine, f"{prefix}add_conditional_format")(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            require_rule(arguments),
        )

    raise ValueError("unsafe_update: unsupported object_type")


def apply_visual_object_tool(engine: Any, arguments: dict[str, Any], *, preview: bool) -> list[dict[str, Any]]:
    sheet = require_str(arguments, "sheet")
    object_id = require_str(arguments, "object_id")
    operation = require_str(arguments, "operation")
    prefix = "preview_" if preview else ""

    if operation == "move":
        return getattr(engine, f"{prefix}move_drawing_object")(
            sheet,
            object_id,
            require_int(arguments, "start_row"),
            require_int(arguments, "start_col"),
        )
    if operation == "resize":
        return getattr(engine, f"{prefix}resize_drawing_object")(
            sheet,
            object_id,
            require_int(arguments, "end_row"),
            require_int(arguments, "end_col"),
        )
    if operation == "replace_image":
        return getattr(engine, f"{prefix}replace_image")(
            sheet,
            object_id,
            require_str(arguments, "image_path"),
        )
    if operation == "update_text":
        return getattr(engine, f"{prefix}update_drawing_text")(
            sheet,
            object_id,
            require_str(arguments, "text"),
        )
    if operation == "update_chart_title":
        return getattr(engine, f"{prefix}update_chart_title")(
            sheet,
            object_id,
            require_str(arguments, "title"),
        )
    if operation == "update_chart_source":
        return getattr(engine, f"{prefix}update_chart_source")(
            sheet,
            object_id,
            require_str(arguments, "source_range"),
        )
    raise ValueError("unsafe_update: unsupported visual object operation")


def apply_high_risk_object_tool(engine: Any, arguments: dict[str, Any], *, preview: bool) -> list[dict[str, Any]]:
    sheet = require_str(arguments, "sheet")
    object_id = require_str(arguments, "object_id")
    object_type = require_str(arguments, "object_type")
    operation = require_str(arguments, "operation")
    if object_type == "sparkline" and operation == "update_source":
        method_name = "preview_update_sparkline_source" if preview else "update_sparkline_source"
        return getattr(engine, method_name)(
            sheet,
            object_id,
            require_str(arguments, "source_formula"),
        )
    if object_type == "pivot_table" and operation == "update_pivot_metadata":
        method_name = "preview_update_pivot_metadata" if preview else "update_pivot_metadata"
        return getattr(engine, method_name)(
            sheet,
            object_id,
            arguments.get("name"),
            arguments.get("data_caption"),
        )
    if object_type == "ole_object" and operation == "replace_ole_object":
        method_name = "preview_replace_ole_object" if preview else "replace_ole_object"
        return getattr(engine, method_name)(
            sheet,
            object_id,
            require_str(arguments, "ole_path"),
        )
    if object_type == "ole_object":
        raise ValueError("unsafe_update: ole_object operation must be replace_ole_object")
    if object_type == "pivot_table":
        raise ValueError(
            "unsafe_update: pivot_table operation must be update_pivot_metadata"
        )
    raise ValueError("unsafe_update: high-risk edit only supports sparkline and pivot metadata")


def object_range_args(arguments: dict[str, Any]) -> tuple[int, int, int, int]:
    return (
        require_int(arguments, "start_row"),
        require_int(arguments, "start_col"),
        require_int(arguments, "end_row"),
        require_int(arguments, "end_col"),
    )


def require_rule(arguments: dict[str, Any]) -> dict[str, str]:
    value = arguments.get("rule")
    if not isinstance(value, dict):
        raise ValueError("unsafe_update: rule must be an object")
    out: dict[str, str] = {}
    for key, item in value.items():
        if isinstance(item, bool):
            out[str(key)] = "true" if item else "false"
        elif isinstance(item, (str, int, float)):
            out[str(key)] = str(item)
        else:
            raise ValueError(f"unsafe_update: unsupported rule value for {key}")
    return out


def apply_structure_tool(engine: Any, arguments: dict[str, Any], *, preview: bool) -> list[dict[str, Any]]:
    sheet = require_str(arguments, "sheet")
    axis = require_str(arguments, "axis")
    operation = require_str(arguments, "operation")
    start = require_int(arguments, "start")
    prefix = "preview_" if preview else ""
    if axis not in {"row", "col"}:
        raise ValueError("unsafe_update: axis must be row or col")
    if operation not in {"insert", "delete", "move"}:
        raise ValueError("unsafe_update: operation must be insert, delete, or move")
    suffix = "rows" if axis == "row" else "cols"

    if operation == "insert":
        count = require_int(arguments, "count")
        method = getattr(engine, f"{prefix}insert_{suffix}")
        return method(sheet, start, count)
    if operation == "delete":
        count = require_int(arguments, "count")
        method = getattr(engine, f"{prefix}delete_{suffix}")
        return method(sheet, start, count)

    end = require_int(arguments, "end")
    target = require_int(arguments, "target")
    method = getattr(engine, f"{prefix}move_{suffix}")
    return method(sheet, start, end, target)


def tool_result(payload: dict[str, Any], is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False, sort_keys=True),
            }
        ],
        "isError": is_error,
    }


def cell_coord_to_dict(cell: Any) -> dict[str, Any]:
    return {"sheet": cell.sheet, "row": cell.row, "col": cell.col}


def meta_record_to_dict(meta: Any) -> dict[str, Any]:
    return {
        "sheet_name": meta.sheet_name,
        "row_idx": meta.row_idx,
        "col_idx": meta.col_idx,
        "cell_type": meta.cell_type,
        "style_id": meta.style_id,
        "number_format": meta.number_format,
        "original_formula": meta.original_formula,
        "cached_value_before": meta.cached_value_before,
        "cached_value_after": meta.cached_value_after,
        "merge_range": meta.merge_range,
        "is_modified": meta.is_modified,
        "is_dirty": meta.is_dirty,
    }


EXCEL_ERROR_VALUES = {"#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NULL!", "#NUM!"}
MACRO_PACKAGE_PATTERNS = (
    "xl/vbaProject.bin",
    "xl/_rels/vbaProject.bin.rels",
    "xl/vbaData.xml",
)


def scan_xlsx_formula_errors(output_path: str) -> dict[str, Any]:
    sheet_names = workbook_sheet_names_by_path(output_path)
    total_formulas = 0
    error_summary: dict[str, dict[str, Any]] = {}
    error_locations: list[dict[str, str]] = []

    with zipfile.ZipFile(output_path) as archive:
        worksheet_paths = sorted(
            name
            for name in archive.namelist()
            if name.startswith("xl/worksheets/") and name.endswith(".xml")
        )
        for worksheet_path in worksheet_paths:
            root = ET.fromstring(archive.read(worksheet_path))
            sheet_name = sheet_names.get(worksheet_path, worksheet_path)
            for cell in iter_elements_named(root, "c"):
                formula = first_child_text(cell, "f")
                value = first_child_text(cell, "v")
                cell_type = cell.attrib.get("t", "")
                if formula is not None:
                    total_formulas += 1
                error_value = None
                if value in EXCEL_ERROR_VALUES:
                    error_value = value
                elif cell_type == "e":
                    error_value = value or "#ERROR"
                if error_value is None:
                    continue
                location = f"{sheet_name}!{cell.attrib.get('r', '')}"
                item = error_summary.setdefault(error_value, {"count": 0, "locations": []})
                item["count"] += 1
                item["locations"].append(location)
                error_locations.append(
                    {
                        "sheet": sheet_name,
                        "cell": cell.attrib.get("r", ""),
                        "error": error_value,
                        "formula": formula or "",
                    }
                )

    return {
        "status": "success" if not error_locations else "errors_found",
        "total_errors": len(error_locations),
        "total_formulas": total_formulas,
        "error_summary": error_summary,
        "error_locations": error_locations,
    }


def delivery_status(
    errors: list[dict[str, Any]],
    warnings: list[dict[str, Any]],
    not_completed: list[str],
) -> str:
    if errors:
        return "failed"
    if warnings or not_completed:
        return "needs_review"
    return "passed"


def package_drift_report(source_path: str, output_path: str, diff_report: list[dict[str, Any]]) -> dict[str, Any]:
    source_hashes = package_entry_hashes(source_path)
    output_hashes = package_entry_hashes(output_path)
    source_entries = set(source_hashes)
    output_entries = set(output_hashes)
    changed_entries = sorted(
        entry
        for entry in source_entries & output_entries
        if source_hashes[entry] != output_hashes[entry]
    )
    missing_entries = sorted(source_entries - output_entries)
    added_entries = sorted(output_entries - source_entries)
    expected = expected_package_changes(source_path, diff_report)
    unexpected_changed_entries = sorted(
        entry
        for entry in [*changed_entries, *missing_entries, *added_entries]
        if not entry_change_expected(entry, expected)
    )
    macro_drift_entries = sorted(
        entry
        for entry in [*changed_entries, *missing_entries]
        if is_macro_package_entry(entry)
    )
    return {
        "changed_entries": changed_entries,
        "missing_entries": missing_entries,
        "added_entries": added_entries,
        "expected_changed_entries": sorted(expected["entries"]),
        "expected_changed_prefixes": sorted(expected["prefixes"]),
        "unexpected_changed_entries": unexpected_changed_entries,
        "macro_drift_entries": macro_drift_entries,
    }


def empty_package_drift_report(status: str) -> dict[str, Any]:
    return {
        "status": status,
        "changed_entries": [],
        "missing_entries": [],
        "added_entries": [],
        "expected_changed_entries": [],
        "expected_changed_prefixes": [],
        "unexpected_changed_entries": [],
        "macro_drift_entries": [],
    }


def package_entry_hashes(path: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            hashes[name] = sha256(archive.read(name)).hexdigest()
    return hashes


def expected_package_changes(source_path: str, diff_report: list[dict[str, Any]]) -> dict[str, set[str]]:
    sheet_paths = workbook_sheet_paths_by_name(source_path)
    entries: set[str] = set()
    prefixes: set[str] = set()
    for event in diff_report:
        event_type = str(event.get("event_type", ""))
        sheet = event.get("sheet")
        if isinstance(sheet, str) and sheet in sheet_paths:
            entries.add(sheet_paths[sheet])
            rel_path = worksheet_rels_path(sheet_paths[sheet])
            if rel_path:
                entries.add(rel_path)

        if event_type in {"sheet_rename", "sheet_visibility_update", "defined_name_update"}:
            entries.add("xl/workbook.xml")
        if event_type == "style_update":
            entries.add("xl/styles.xml")
        if event_type in {"table_range_update"}:
            prefixes.add("xl/tables/")
        if event_type in {"comment_update"}:
            prefixes.add("xl/comments")
            prefixes.add("xl/threadedComments")
            prefixes.add("xl/persons/")
        if event_type in {
            "drawing_anchor_update",
            "drawing_object_update",
            "drawing_image_replace",
            "drawing_text_update",
        }:
            prefixes.add("xl/drawings/")
            prefixes.add("xl/media/")
        if event_type in {"chart_title_update", "chart_source_update"}:
            prefixes.add("xl/charts/")
            prefixes.add("xl/drawings/")
        if event_type in {"sparkline_source_update", "sparkline_ref_update"}:
            prefixes.add("xl/worksheets/")
        if event_type == "pivot_metadata_update":
            prefixes.add("xl/pivotTables/")
        if event_type == "ole_object_replace":
            prefixes.add("xl/embeddings/")
    return {"entries": entries, "prefixes": prefixes}


def workbook_sheet_paths_by_name(path: str) -> dict[str, str]:
    return {name: sheet_path for sheet_path, name in workbook_sheet_names_by_path(path).items()}


def worksheet_rels_path(sheet_path: str) -> str:
    if not sheet_path.startswith("xl/worksheets/"):
        return ""
    return sheet_path.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels"


def entry_change_expected(entry: str, expected: dict[str, set[str]]) -> bool:
    if entry in expected["entries"]:
        return True
    return any(entry.startswith(prefix) for prefix in expected["prefixes"])


def is_macro_package_entry(entry: str) -> bool:
    return entry in MACRO_PACKAGE_PATTERNS or entry.startswith("xl/vba")


def external_recalc_report(output_path: str, requested: bool) -> dict[str, Any]:
    report: dict[str, Any] = {
        "requested": requested,
        "status": "skipped",
        "oracle": "libreoffice_headless",
        "message": "",
    }
    if not requested:
        return report

    soffice = find_soffice()
    if soffice is None:
        report.update(
            {
                "status": "unavailable",
                "message": "LibreOffice soffice binary was not found",
            }
        )
        return report

    version = get_libreoffice_version(soffice)
    with tempfile.TemporaryDirectory(prefix="sheet_shadow_recalc_") as tmpdir:
        input_dir = os.path.join(tmpdir, "input")
        output_dir = os.path.join(tmpdir, "output")
        profile_dir = os.path.join(tmpdir, "profile")
        os.makedirs(input_dir, exist_ok=True)
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(profile_dir, exist_ok=True)
        temp_input = os.path.join(input_dir, os.path.basename(output_path))
        shutil.copy2(output_path, temp_input)
        cmd = [
            soffice,
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--nodefault",
            "--nofirststartwizard",
            f"-env:UserInstallation=file://{profile_dir}",
            "--infilter=Calc MS Excel 2007 XML",
            "--convert-to",
            "xlsx",
            "--outdir",
            output_dir,
            temp_input,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=60)
        except subprocess.TimeoutExpired:
            report.update(
                {
                    "status": "timeout",
                    "message": "LibreOffice timed out after 60s",
                    "soffice": soffice,
                    "version": version,
                }
            )
            return report
        except OSError as exc:
            report.update(
                {
                    "status": "failed",
                    "message": str(exc),
                    "soffice": soffice,
                    "version": version,
                }
            )
            return report

        stdout = result.stdout.decode(errors="replace").strip()
        stderr = result.stderr.decode(errors="replace").strip()
        if result.returncode != 0:
            report.update(
                {
                    "status": "failed",
                    "message": f"LibreOffice exited with code {result.returncode}",
                    "soffice": soffice,
                    "version": version,
                    "stdout": stdout,
                    "stderr": stderr,
                }
            )
            return report

        recalc_path = os.path.join(output_dir, os.path.basename(output_path))
        if not os.path.exists(recalc_path):
            xlsx_files = [
                os.path.join(output_dir, name)
                for name in os.listdir(output_dir)
                if name.endswith(".xlsx")
            ]
            if xlsx_files:
                recalc_path = xlsx_files[0]
        if not os.path.exists(recalc_path):
            report.update(
                {
                    "status": "failed",
                    "message": "LibreOffice completed but no recalculated .xlsx output was found",
                    "soffice": soffice,
                    "version": version,
                    "stdout": stdout,
                    "stderr": stderr,
                    "output_dir_files": sorted(os.listdir(output_dir)),
                }
            )
            return report

        report.update(
            {
                "status": "completed",
                "message": "LibreOffice recalculation completed on a temporary output copy",
                "soffice": soffice,
                "version": version,
                "stdout": stdout,
                "stderr": stderr,
                "formula_scan": scan_xlsx_formula_errors(recalc_path),
            }
        )
        return report


def find_soffice() -> str | None:
    candidates = [
        "soffice",
        "libreoffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def get_libreoffice_version(soffice: str) -> str:
    try:
        result = subprocess.run([soffice, "--version"], capture_output=True, timeout=10)
    except Exception:
        return "unknown"
    return result.stdout.decode(errors="replace").strip() or "unknown"


def workbook_sheet_names_by_path(output_path: str) -> dict[str, str]:
    with zipfile.ZipFile(output_path) as archive:
        if "xl/workbook.xml" not in archive.namelist():
            return {}
        workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
        rels_by_id: dict[str, str] = {}
        if "xl/_rels/workbook.xml.rels" in archive.namelist():
            rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            for rel in rels_root:
                rel_id = rel.attrib.get("Id")
                target = rel.attrib.get("Target")
                if rel_id and target:
                    rels_by_id[rel_id] = normalize_workbook_target(target)

    names: dict[str, str] = {}
    for sheet in iter_elements_named(workbook_root, "sheet"):
        rel_id = attr_by_local_name(sheet, "id")
        name = sheet.attrib.get("name")
        if rel_id and name and rel_id in rels_by_id:
            names[rels_by_id[rel_id]] = name
    return names


def normalize_workbook_target(target: str) -> str:
    if target.startswith("/"):
        normalized = target.lstrip("/")
    else:
        normalized = os.path.normpath(os.path.join("xl", target))
    return normalized.replace(os.sep, "/")


def iter_elements_named(root: ET.Element, name: str):
    for element in root.iter():
        if local_name(element.tag) == name:
            yield element


def first_child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if local_name(child.tag) == name:
            return child.text or ""
    return None


def attr_by_local_name(element: ET.Element, name: str) -> str | None:
    for key, value in element.attrib.items():
        if local_name(key) == name:
            return value
    return None


def local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def error_payload(exc: Exception) -> dict[str, Any]:
    message = str(exc)
    code = "tool_error"
    if message.startswith("unknown workbook_id"):
        code = "unknown_workbook"
    elif ":" in message:
        prefix = message.split(":", 1)[0].strip()
        if prefix in {
            "unsupported_formula",
            "unsafe_update",
            "unknown_sheet",
            "invalid_cell_ref",
            "delivery_gate_error",
            "stale_session",
            "save_path_error",
            "store_path_error",
            "store_schema_error",
            "xml_patch_miss",
            "shared_string_policy",
        }:
            code = prefix
    error = {"code": code, "message": message}
    payload = operation_payload(
        {"error": error},
        completed=[],
        not_completed=not_completed_for_error_code(code),
        errors=[error],
    )
    payload["ok"] = False
    return payload


def not_completed_for_error_code(code: str) -> list[str]:
    return {
        "unsupported_formula": ["formula_evaluation"],
        "unsafe_update": ["requested_update"],
        "unknown_sheet": ["requested_operation"],
        "invalid_cell_ref": ["requested_operation"],
        "delivery_gate_error": ["delivery_gate"],
        "stale_session": ["stale_session_reingest_required"],
        "save_path_error": ["workbook_save"],
        "store_path_error": ["store_access"],
        "store_schema_error": ["store_schema_read"],
        "xml_patch_miss": ["workbook_save"],
        "shared_string_policy": ["workbook_save"],
        "unknown_workbook": ["workbook_session_lookup"],
    }.get(code, ["tool_call"])


def read_message(stream: BinaryIO) -> tuple[dict[str, Any], str] | None:
    while True:
        line = stream.readline()
        if not line:
            return None
        if line.strip():
            break

    if line.lower().startswith(b"content-length:"):
        length = int(line.split(b":", 1)[1].strip())
        while True:
            header = stream.readline()
            if header in (b"\r\n", b"\n", b""):
                break
        body = stream.read(length)
        return json.loads(body.decode("utf-8")), "headers"

    return json.loads(line.decode("utf-8")), "lines"


def write_message(stream: BinaryIO, message: dict[str, Any], framing: str) -> None:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if framing == "headers":
        stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
        stream.write(body)
    else:
        stream.write(body + b"\n")
    stream.flush()


def serve(stdin: BinaryIO | None = None, stdout: BinaryIO | None = None) -> None:
    input_stream = stdin or sys.stdin.buffer
    output_stream = stdout or sys.stdout.buffer
    server = SheetShadowMcpServer()

    while True:
        item = read_message(input_stream)
        if item is None:
            return
        message, framing = item
        response = server.handle(message)
        if response is not None:
            write_message(output_stream, response, framing)


if __name__ == "__main__":
    serve()
