use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use regex::Regex;
use roxmltree::Document;
use rusqlite::types::ValueRef;
use rusqlite::vtab::{
    sqlite3_vtab, sqlite3_vtab_cursor, update_module, Context as VTabContext, IndexInfo,
    UpdateVTab, VTab, VTabConnection, VTabCursor, VTabKind, Values,
};
use rusqlite::{params, Connection};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::marker::PhantomData;
use std::os::raw::c_int;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    sheet: String,
    row: usize,
    col: usize,
}

#[pyclass]
#[derive(Clone)]
struct CellCoord {
    #[pyo3(get)]
    sheet: String,
    #[pyo3(get)]
    row: usize,
    #[pyo3(get)]
    col: usize,
}

#[pymethods]
impl CellCoord {
    fn __repr__(&self) -> String {
        format!(
            "CellCoord(sheet='{}', row={}, col={})",
            self.sheet, self.row, self.col
        )
    }
}

#[derive(Clone, Debug)]
struct FormulaCell {
    formula: String,
    deps: HashSet<Key>,
}

#[derive(Clone, Debug)]
struct DefinedName {
    name: String,
    target: String,
    scope_sheet: Option<String>,
}

#[derive(Clone, Debug)]
struct TableInfo {
    name: String,
    path: String,
    sheet: String,
    start_row: usize,
    end_row: usize,
    start_col: usize,
    end_col: usize,
    totals_row: Option<usize>,
    columns: Vec<String>,
}

impl TableInfo {
    fn data_start_row(&self) -> usize {
        self.start_row.saturating_add(1)
    }

    fn data_end_row(&self) -> usize {
        self.totals_row
            .map(|row| row.saturating_sub(1))
            .unwrap_or(self.end_row)
    }

    fn column_span(&self, start_column: &str, end_column: &str) -> Option<(usize, usize)> {
        let start_offset = self.column_offset(start_column)?;
        let end_offset = self.column_offset(end_column)?;
        let start_col = self.start_col + start_offset.min(end_offset);
        let end_col = self.start_col + start_offset.max(end_offset);
        if end_col > self.end_col {
            return None;
        }
        Some((start_col, end_col))
    }

    fn column_offset(&self, column_name: &str) -> Option<usize> {
        self.columns
            .iter()
            .position(|column| column.eq_ignore_ascii_case(column_name.trim()))
    }

    fn has_column(&self, column_name: &str) -> bool {
        self.column_offset(column_name).is_some()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StructureAxis {
    Row,
    Col,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StructureOpKind {
    Insert,
    Delete,
    Move,
}

#[derive(Clone, Debug)]
struct StructureEdit {
    sheet: String,
    axis: StructureAxis,
    kind: StructureOpKind,
    start: usize,
    end: usize,
    target: usize,
}

#[derive(Clone, Debug)]
struct ObjectRange {
    sheet: String,
    start_row: usize,
    start_col: usize,
    end_row: usize,
    end_col: usize,
}

impl ObjectRange {
    fn ref_text(&self) -> String {
        format!(
            "{}{}:{}{}",
            col_to_name(self.start_col),
            self.start_row,
            col_to_name(self.end_col),
            self.end_row
        )
    }
}

#[derive(Clone, Debug)]
struct CellComment {
    key: Key,
    text: String,
}

#[derive(Clone, Debug)]
struct DataValidationRule {
    range: ObjectRange,
    validation_type: String,
    operator: String,
    formula1: String,
    formula2: String,
    allow_blank: bool,
}

#[derive(Clone, Debug)]
struct AutoFilterRule {
    range: ObjectRange,
}

#[derive(Clone, Debug)]
struct ConditionalFormatRule {
    range: ObjectRange,
    rule_type: String,
    operator: String,
    formula: String,
    priority: usize,
}

#[derive(Clone, Debug)]
struct DrawingObject {
    sheet: String,
    object_id: String,
    object_type: String,
    drawing_path: String,
    anchor_ordinal: usize,
    anchor_kind: String,
    from_row: Option<usize>,
    from_col: Option<usize>,
    to_row: Option<usize>,
    to_col: Option<usize>,
    rel_id: String,
    target_path: String,
    target_exists: bool,
    relationship_valid: bool,
    invalid_reason: String,
}

impl DrawingObject {
    fn ref_text(&self) -> String {
        match (
            self.from_row,
            self.from_col,
            self.to_row,
            self.to_col,
            self.anchor_kind.as_str(),
        ) {
            (Some(row), Some(col), Some(end_row), Some(end_col), "twoCellAnchor") => format!(
                "{}{}:{}{}",
                col_to_name(col),
                row,
                col_to_name(end_col),
                end_row
            ),
            (Some(row), Some(col), _, _, "oneCellAnchor") => {
                format!("{}{}", col_to_name(col), row)
            }
            _ => String::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct PackageRelationship {
    id: String,
    rel_type: String,
    target: String,
    target_mode: String,
}

#[derive(Clone, Debug)]
struct HighRiskObject {
    sheet: String,
    object_id: String,
    object_type: String,
    source_path: String,
    rel_id: String,
    rel_type: String,
    target_path: String,
    target_mode: String,
    target_exists: bool,
    target_size: u64,
    relationship_valid: bool,
    name: String,
    ref_text: String,
    source_formula: String,
    cache_path: String,
    cache_rel_id: String,
    cache_target_mode: String,
    cache_exists: bool,
    cache_size: u64,
    pivot_cache_id: String,
    pivot_data_caption: String,
    pivot_updated_version: String,
    sparkline_group_type: String,
    sparkline_display_empty_cells_as: String,
    sparkline_markers: String,
    ole_extension: String,
    invalid_reason: String,
}

#[derive(Clone, Debug)]
struct AuditEvent {
    event_type: String,
    sheet: String,
    row: usize,
    col: usize,
    old_value: String,
    new_value: String,
    formula: String,
    reason: String,
}

impl AuditEvent {
    fn to_map(&self) -> HashMap<String, String> {
        HashMap::from([
            ("event_type".to_string(), self.event_type.clone()),
            ("sheet".to_string(), self.sheet.clone()),
            ("row".to_string(), self.row.to_string()),
            ("col".to_string(), self.col.to_string()),
            ("old_value".to_string(), self.old_value.clone()),
            ("new_value".to_string(), self.new_value.clone()),
            ("formula".to_string(), self.formula.clone()),
            ("reason".to_string(), self.reason.clone()),
        ])
    }
}

impl CellFormatIntent {
    fn from_map(intent: HashMap<String, String>) -> PyResult<Self> {
        let number_format = optional_nonempty(&intent, "number_format");
        let bold = optional_bool(&intent, "bold")?;
        let italic = optional_bool(&intent, "italic")?;
        let font_color = optional_color(&intent, "font_color")?;
        let fill_color = optional_color(&intent, "fill_color")?;
        let horizontal = optional_enum(&intent, "horizontal", &["left", "center", "right"])?;
        let vertical = optional_enum(&intent, "vertical", &["top", "center", "bottom"])?;
        let wrap_text = optional_bool(&intent, "wrap_text")?;

        Ok(Self {
            number_format,
            bold,
            italic,
            font_color,
            fill_color,
            horizontal,
            vertical,
            wrap_text,
        })
    }

    fn has_changes(&self) -> bool {
        self.number_format.is_some()
            || self.bold.is_some()
            || self.italic.is_some()
            || self.font_color.is_some()
            || self.fill_color.is_some()
            || self.horizontal.is_some()
            || self.vertical.is_some()
            || self.wrap_text.is_some()
    }

    fn has_font_changes(&self) -> bool {
        self.bold.is_some() || self.italic.is_some() || self.font_color.is_some()
    }

    fn has_fill_changes(&self) -> bool {
        self.fill_color.is_some()
    }

    fn has_alignment_changes(&self) -> bool {
        self.horizontal.is_some() || self.vertical.is_some() || self.wrap_text.is_some()
    }

    fn to_audit_string(&self, style_id: u32, base_style_id: u32) -> String {
        let mut parts = vec![
            format!("style_id={style_id}"),
            format!("base_style_id={base_style_id}"),
        ];
        if let Some(value) = &self.number_format {
            parts.push(format!("number_format={value}"));
        }
        if let Some(value) = self.bold {
            parts.push(format!("bold={value}"));
        }
        if let Some(value) = self.italic {
            parts.push(format!("italic={value}"));
        }
        if let Some(value) = &self.font_color {
            parts.push(format!("font_color={value}"));
        }
        if let Some(value) = &self.fill_color {
            parts.push(format!("fill_color={value}"));
        }
        if let Some(value) = &self.horizontal {
            parts.push(format!("horizontal={value}"));
        }
        if let Some(value) = &self.vertical {
            parts.push(format!("vertical={value}"));
        }
        if let Some(value) = self.wrap_text {
            parts.push(format!("wrap_text={value}"));
        }
        parts.join(";")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SharedStringPolicy {
    Preserve,
    UpdateUnique,
    Auto,
}

#[derive(Clone, Debug)]
struct SharedStringPatchPlan {
    updates: HashMap<usize, String>,
    cell_indices: HashMap<Key, usize>,
}

#[derive(Clone, Debug)]
struct CellFormatIntent {
    number_format: Option<String>,
    bold: Option<bool>,
    italic: Option<bool>,
    font_color: Option<String>,
    fill_color: Option<String>,
    horizontal: Option<String>,
    vertical: Option<String>,
    wrap_text: Option<bool>,
}

#[derive(Clone, Debug)]
struct StylePatch {
    key: Key,
    base_style_id: u32,
    intent: CellFormatIntent,
}

#[pyclass]
#[derive(Clone, Debug)]
struct ShadowMetaRecord {
    #[pyo3(get)]
    sheet_name: String,
    #[pyo3(get)]
    row_idx: usize,
    #[pyo3(get)]
    col_idx: usize,
    #[pyo3(get)]
    cell_type: String,
    #[pyo3(get)]
    style_id: Option<u32>,
    #[pyo3(get)]
    number_format: String,
    #[pyo3(get)]
    original_formula: String,
    #[pyo3(get)]
    cached_value_before: String,
    #[pyo3(get)]
    cached_value_after: String,
    #[pyo3(get)]
    merge_range: String,
    #[pyo3(get)]
    is_modified: bool,
    #[pyo3(get)]
    is_dirty: bool,
}

#[pymethods]
impl ShadowMetaRecord {
    fn __repr__(&self) -> String {
        format!(
            "ShadowMetaRecord(sheet='{}', row={}, col={}, type='{}', style_id={:?}, modified={}, dirty={})",
            self.sheet_name,
            self.row_idx,
            self.col_idx,
            self.cell_type,
            self.style_id,
            self.is_modified,
            self.is_dirty
        )
    }
}

#[derive(Clone, Debug)]
struct SheetInfo {
    name: String,
    path: String,
    sheet_id: String,
    rel_id: String,
    visibility: String,
}

#[derive(Clone, Debug)]
struct SheetRowsVTabData {
    sheet_name: String,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    pending_updates: Rc<RefCell<Vec<PendingSqliteUpdate>>>,
}

#[derive(Clone, Debug)]
struct PendingSqliteUpdate {
    sheet: String,
    row: usize,
    col: usize,
    value: String,
}

#[repr(C)]
struct SheetRowsVTab {
    base: sqlite3_vtab,
    data: SheetRowsVTabData,
}

#[repr(C)]
struct SheetRowsCursor<'vtab> {
    base: sqlite3_vtab_cursor,
    row_idx: usize,
    data: SheetRowsVTabData,
    phantom: PhantomData<&'vtab SheetRowsVTab>,
}

unsafe impl<'vtab> VTab<'vtab> for SheetRowsVTab {
    type Aux = SheetRowsVTabData;
    type Cursor = SheetRowsCursor<'vtab>;

    fn connect(
        _: &mut VTabConnection,
        aux: Option<&Self::Aux>,
        _args: &[&[u8]],
    ) -> rusqlite::Result<(String, Self)> {
        let data = aux
            .cloned()
            .ok_or_else(|| rusqlite::Error::ModuleError("missing sheet vtab data".to_string()))?;
        let mut columns = vec!["row_id INTEGER PRIMARY KEY".to_string()];
        for column in &data.columns {
            columns.push(format!("{} TEXT", sqlite_quote_ident(column)));
        }
        let vtab = SheetRowsVTab {
            base: sqlite3_vtab::default(),
            data,
        };
        Ok((format!("CREATE TABLE x({})", columns.join(", ")), vtab))
    }

    fn best_index(&self, info: &mut IndexInfo) -> rusqlite::Result<()> {
        info.set_estimated_cost(self.data.rows.len().max(1) as f64);
        Ok(())
    }

    fn open(&'vtab mut self) -> rusqlite::Result<Self::Cursor> {
        Ok(SheetRowsCursor {
            base: sqlite3_vtab_cursor::default(),
            row_idx: 0,
            data: self.data.clone(),
            phantom: PhantomData,
        })
    }
}

impl<'vtab> rusqlite::vtab::CreateVTab<'vtab> for SheetRowsVTab {
    const KIND: VTabKind = VTabKind::Default;
}

impl<'vtab> UpdateVTab<'vtab> for SheetRowsVTab {
    fn delete(&mut self, _arg: ValueRef<'_>) -> rusqlite::Result<()> {
        Err(rusqlite::Error::ModuleError(
            "sheet-shadow SQLite vtab does not allow DELETE".to_string(),
        ))
    }

    fn insert(&mut self, _args: &Values<'_>) -> rusqlite::Result<i64> {
        Err(rusqlite::Error::ModuleError(
            "sheet-shadow SQLite vtab does not allow INSERT".to_string(),
        ))
    }

    fn update(&mut self, args: &Values<'_>) -> rusqlite::Result<()> {
        if args.len() != self.data.columns.len() + 3 {
            return Err(rusqlite::Error::ModuleError(
                "unexpected sheet-shadow SQLite vtab update shape".to_string(),
            ));
        }

        let old_rowid = args.get::<i64>(0)?;
        let new_rowid = args.get::<i64>(1)?;
        let row_id_value = args
            .iter()
            .nth(2)
            .map(sqlite_value_to_string)
            .unwrap_or_default();
        if old_rowid != new_rowid || row_id_value != old_rowid.to_string() {
            return Err(rusqlite::Error::ModuleError(
                "sheet-shadow SQLite vtab does not allow row_id changes".to_string(),
            ));
        }
        if old_rowid < 1 {
            return Err(rusqlite::Error::ModuleError(
                "sheet-shadow SQLite vtab row_id must be positive".to_string(),
            ));
        }

        let row_idx = old_rowid as usize - 1;
        let old_row = self.data.rows.get(row_idx).ok_or_else(|| {
            rusqlite::Error::ModuleError("sheet-shadow SQLite vtab row not found".to_string())
        })?;
        let mut changes = Vec::new();

        for col_idx in 0..self.data.columns.len() {
            let new_value = args
                .iter()
                .nth(col_idx + 3)
                .map(sqlite_value_to_string)
                .unwrap_or_default();
            let old_value = old_row.get(col_idx).cloned().unwrap_or_default();
            if old_value != new_value {
                changes.push(PendingSqliteUpdate {
                    sheet: self.data.sheet_name.clone(),
                    row: old_rowid as usize,
                    col: col_idx + 1,
                    value: new_value,
                });
            }
        }

        if changes.len() != 1 {
            return Err(rusqlite::Error::ModuleError(
                "sheet-shadow SQLite vtab requires exactly one changed cell per UPDATE".to_string(),
            ));
        }

        self.data.pending_updates.borrow_mut().extend(changes);
        Ok(())
    }
}

unsafe impl VTabCursor for SheetRowsCursor<'_> {
    fn filter(
        &mut self,
        _idx_num: c_int,
        _idx_str: Option<&str>,
        _args: &Values<'_>,
    ) -> rusqlite::Result<()> {
        self.row_idx = 0;
        Ok(())
    }

    fn next(&mut self) -> rusqlite::Result<()> {
        self.row_idx += 1;
        Ok(())
    }

    fn eof(&self) -> bool {
        self.row_idx >= self.data.rows.len()
    }

    fn column(&self, ctx: &mut VTabContext, col: c_int) -> rusqlite::Result<()> {
        if col == 0 {
            return ctx.set_result(&((self.row_idx + 1) as i64));
        }
        let value = self
            .data
            .rows
            .get(self.row_idx)
            .and_then(|row| row.get(col as usize - 1))
            .map(String::as_str)
            .unwrap_or("");
        ctx.set_result(&value)
    }

    fn rowid(&self) -> rusqlite::Result<i64> {
        Ok((self.row_idx + 1) as i64)
    }
}

trait FormulaBackend {
    fn evaluate_formula(
        &self,
        formula: &str,
        default_sheet: &str,
        cells: &HashMap<Key, String>,
    ) -> PyResult<String>;
}

struct RustMvpFormulaBackend;

impl FormulaBackend for RustMvpFormulaBackend {
    fn evaluate_formula(
        &self,
        formula: &str,
        default_sheet: &str,
        cells: &HashMap<Key, String>,
    ) -> PyResult<String> {
        evaluate_formula_mvp(formula, default_sheet, cells)
    }
}

#[pyclass]
#[derive(Clone)]
struct SheetShadowEngine {
    source_path: Option<PathBuf>,
    sheets: Vec<SheetInfo>,
    defined_names: Vec<DefinedName>,
    tables: Vec<TableInfo>,
    style_count: u32,
    style_patches: Vec<StylePatch>,
    merges: HashMap<String, HashSet<String>>,
    merge_dirty_sheets: HashSet<String>,
    structural_edits: Vec<StructureEdit>,
    structural_dirty_sheets: HashSet<String>,
    table_dirty_paths: HashSet<String>,
    comments: Vec<CellComment>,
    data_validations: Vec<DataValidationRule>,
    auto_filters: Vec<AutoFilterRule>,
    conditional_formats: Vec<ConditionalFormatRule>,
    drawing_objects: Vec<DrawingObject>,
    high_risk_objects: Vec<HighRiskObject>,
    object_dirty_sheets: HashSet<String>,
    comment_dirty_sheets: HashSet<String>,
    drawing_dirty_paths: HashSet<String>,
    drawing_text_updates: HashMap<String, String>,
    image_replacements: HashMap<String, Vec<u8>>,
    ole_replacements: HashMap<String, Vec<u8>>,
    chart_title_updates: HashMap<String, String>,
    chart_source_updates: HashMap<String, String>,
    sparkline_source_updates: HashMap<String, String>,
    sparkline_dirty_sheets: HashSet<String>,
    sparkline_dirty_objects: HashSet<String>,
    pivot_dirty_paths: HashSet<String>,
    workbook_dirty: bool,
    cells: HashMap<Key, String>,
    formulas: HashMap<Key, FormulaCell>,
    meta: HashMap<Key, ShadowMetaRecord>,
    dependents: HashMap<Key, HashSet<Key>>,
    dirty: HashSet<Key>,
    modified: HashSet<Key>,
    audit_events: Vec<AuditEvent>,
}

#[pymethods]
impl SheetShadowEngine {
    #[new]
    fn new() -> Self {
        Self {
            source_path: None,
            sheets: Vec::new(),
            defined_names: Vec::new(),
            tables: Vec::new(),
            style_count: 0,
            style_patches: Vec::new(),
            merges: HashMap::new(),
            merge_dirty_sheets: HashSet::new(),
            structural_edits: Vec::new(),
            structural_dirty_sheets: HashSet::new(),
            table_dirty_paths: HashSet::new(),
            comments: Vec::new(),
            data_validations: Vec::new(),
            auto_filters: Vec::new(),
            conditional_formats: Vec::new(),
            drawing_objects: Vec::new(),
            high_risk_objects: Vec::new(),
            object_dirty_sheets: HashSet::new(),
            comment_dirty_sheets: HashSet::new(),
            drawing_dirty_paths: HashSet::new(),
            drawing_text_updates: HashMap::new(),
            image_replacements: HashMap::new(),
            ole_replacements: HashMap::new(),
            chart_title_updates: HashMap::new(),
            chart_source_updates: HashMap::new(),
            sparkline_source_updates: HashMap::new(),
            sparkline_dirty_sheets: HashSet::new(),
            sparkline_dirty_objects: HashSet::new(),
            pivot_dirty_paths: HashSet::new(),
            workbook_dirty: false,
            cells: HashMap::new(),
            formulas: HashMap::new(),
            meta: HashMap::new(),
            dependents: HashMap::new(),
            dirty: HashSet::new(),
            modified: HashSet::new(),
            audit_events: Vec::new(),
        }
    }

    fn ingest(&mut self, file_path: &str) -> PyResult<()> {
        self.source_path = Some(PathBuf::from(file_path));
        self.sheets.clear();
        self.defined_names.clear();
        self.tables.clear();
        self.style_count = 0;
        self.style_patches.clear();
        self.merges.clear();
        self.merge_dirty_sheets.clear();
        self.structural_edits.clear();
        self.structural_dirty_sheets.clear();
        self.table_dirty_paths.clear();
        self.comments.clear();
        self.data_validations.clear();
        self.auto_filters.clear();
        self.conditional_formats.clear();
        self.drawing_objects.clear();
        self.high_risk_objects.clear();
        self.object_dirty_sheets.clear();
        self.comment_dirty_sheets.clear();
        self.drawing_dirty_paths.clear();
        self.drawing_text_updates.clear();
        self.image_replacements.clear();
        self.ole_replacements.clear();
        self.chart_title_updates.clear();
        self.chart_source_updates.clear();
        self.sparkline_source_updates.clear();
        self.sparkline_dirty_sheets.clear();
        self.sparkline_dirty_objects.clear();
        self.pivot_dirty_paths.clear();
        self.workbook_dirty = false;
        self.cells.clear();
        self.formulas.clear();
        self.meta.clear();
        self.dependents.clear();
        self.dirty.clear();
        self.modified.clear();
        self.audit_events.clear();

        let mut archive = open_zip(file_path)?;
        let package_entries = zip_entry_names(&mut archive)?;
        let package_sizes = zip_entry_sizes(&mut archive)?;
        let shared_strings = read_shared_strings(&mut archive)?;
        let style_info = read_style_info(&mut archive)?;
        self.style_count = style_info.len() as u32;
        let sheets = read_workbook_sheets(&mut archive)?;
        let defined_names = read_defined_names(&mut archive, &sheets)?;
        let tables = read_table_info(&mut archive, &sheets)?;
        let comments = read_comments(&mut archive, &sheets)?;
        let drawing_objects = read_drawing_objects(&mut archive, &sheets, &package_entries)?;
        let high_risk_objects =
            read_high_risk_objects(&mut archive, &sheets, &package_entries, &package_sizes)?;

        for sheet in &sheets {
            let xml = read_zip_text(&mut archive, &sheet.path)?;
            parse_sheet_objects(
                &sheet.name,
                &xml,
                &mut self.data_validations,
                &mut self.auto_filters,
                &mut self.conditional_formats,
            )?;
            parse_sheet_xml(
                &sheet.name,
                &xml,
                &shared_strings,
                &style_info,
                &mut self.merges,
                &mut self.cells,
                &mut self.formulas,
                &mut self.meta,
            )?;
        }

        self.sheets = sheets;
        self.defined_names = defined_names;
        self.tables = tables;
        self.comments = comments;
        self.drawing_objects = drawing_objects;
        self.high_risk_objects = high_risk_objects;
        self.rebuild_formula_deps();
        self.rebuild_dependents();
        Ok(())
    }

    #[pyo3(signature = (sheet, row, col, val))]
    fn update_cell(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        val: &str,
    ) -> PyResult<Vec<CellCoord>> {
        self.update_cell_with_reason(sheet, row, col, val, "direct_update")
    }

    fn preview_update_cell(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
        val: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.update_cell_with_reason(sheet, row, col, val, "preview_update")?;
        Ok(preview.audit_report())
    }

    fn set_formula(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        formula: &str,
    ) -> PyResult<Vec<CellCoord>> {
        self.set_formula_with_reason(sheet, row, col, formula, "set_formula")
    }

    fn preview_set_formula(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
        formula: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_formula_with_reason(sheet, row, col, formula, "preview_set_formula")?;
        Ok(preview.audit_report())
    }

    fn set_cell_format(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        intent: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_cell_format_with_reason(sheet, row, col, intent, "set_cell_format")?;
        Ok(self.audit_report())
    }

    fn preview_set_cell_format(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
        intent: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_cell_format_with_reason(
            sheet,
            row,
            col,
            intent,
            "preview_set_cell_format",
        )?;
        Ok(preview.audit_report())
    }

    fn merge_cells(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_merge_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            true,
            "merge_cells",
        )?;
        Ok(self.audit_report())
    }

    fn unmerge_cells(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_merge_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            false,
            "unmerge_cells",
        )?;
        Ok(self.audit_report())
    }

    fn preview_merge_cells(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_merge_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            true,
            "preview_merge_cells",
        )?;
        Ok(preview.audit_report())
    }

    fn preview_unmerge_cells(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_merge_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            false,
            "preview_unmerge_cells",
        )?;
        Ok(preview.audit_report())
    }

    fn rename_sheet(
        &mut self,
        sheet: &str,
        new_name: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_sheet_rename(sheet, new_name, "rename_sheet")?;
        Ok(self.audit_report())
    }

    fn set_sheet_visibility(
        &mut self,
        sheet: &str,
        visibility: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_sheet_visibility(sheet, visibility, "set_sheet_visibility")?;
        Ok(self.audit_report())
    }

    fn insert_rows(
        &mut self,
        sheet: &str,
        at_row: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Insert,
            at_row,
            at_row,
            count,
            "insert_rows",
        )?;
        Ok(self.audit_report())
    }

    fn preview_insert_rows(
        &self,
        sheet: &str,
        at_row: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Insert,
            at_row,
            at_row,
            count,
            "preview_insert_rows",
        )?;
        Ok(preview.audit_report())
    }

    fn delete_rows(
        &mut self,
        sheet: &str,
        start_row: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let end_row = checked_range_end(start_row, count)?;
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Delete,
            start_row,
            end_row,
            0,
            "delete_rows",
        )?;
        Ok(self.audit_report())
    }

    fn preview_delete_rows(
        &self,
        sheet: &str,
        start_row: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let end_row = checked_range_end(start_row, count)?;
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Delete,
            start_row,
            end_row,
            0,
            "preview_delete_rows",
        )?;
        Ok(preview.audit_report())
    }

    fn move_rows(
        &mut self,
        sheet: &str,
        start_row: usize,
        end_row: usize,
        target_row: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Move,
            start_row,
            end_row,
            target_row,
            "move_rows",
        )?;
        Ok(self.audit_report())
    }

    fn preview_move_rows(
        &self,
        sheet: &str,
        start_row: usize,
        end_row: usize,
        target_row: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Row,
            StructureOpKind::Move,
            start_row,
            end_row,
            target_row,
            "preview_move_rows",
        )?;
        Ok(preview.audit_report())
    }

    fn insert_cols(
        &mut self,
        sheet: &str,
        at_col: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Insert,
            at_col,
            at_col,
            count,
            "insert_cols",
        )?;
        Ok(self.audit_report())
    }

    fn preview_insert_cols(
        &self,
        sheet: &str,
        at_col: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Insert,
            at_col,
            at_col,
            count,
            "preview_insert_cols",
        )?;
        Ok(preview.audit_report())
    }

    fn delete_cols(
        &mut self,
        sheet: &str,
        start_col: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let end_col = checked_range_end(start_col, count)?;
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Delete,
            start_col,
            end_col,
            0,
            "delete_cols",
        )?;
        Ok(self.audit_report())
    }

    fn preview_delete_cols(
        &self,
        sheet: &str,
        start_col: usize,
        count: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let end_col = checked_range_end(start_col, count)?;
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Delete,
            start_col,
            end_col,
            0,
            "preview_delete_cols",
        )?;
        Ok(preview.audit_report())
    }

    fn move_cols(
        &mut self,
        sheet: &str,
        start_col: usize,
        end_col: usize,
        target_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Move,
            start_col,
            end_col,
            target_col,
            "move_cols",
        )?;
        Ok(self.audit_report())
    }

    fn preview_move_cols(
        &self,
        sheet: &str,
        start_col: usize,
        end_col: usize,
        target_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_structure_edit_with_reason(
            sheet,
            StructureAxis::Col,
            StructureOpKind::Move,
            start_col,
            end_col,
            target_col,
            "preview_move_cols",
        )?;
        Ok(preview.audit_report())
    }

    fn set_comment(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        text: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_comment_with_reason(sheet, row, col, text, false, "set_comment")?;
        Ok(self.audit_report())
    }

    fn remove_comment(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_comment_with_reason(sheet, row, col, "", true, "remove_comment")?;
        Ok(self.audit_report())
    }

    fn preview_set_comment(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
        text: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_comment_with_reason(sheet, row, col, text, false, "preview_set_comment")?;
        Ok(preview.audit_report())
    }

    fn set_data_validation(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_data_validation_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            rule,
            "set_data_validation",
        )?;
        Ok(self.audit_report())
    }

    fn preview_set_data_validation(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_data_validation_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            rule,
            "preview_set_data_validation",
        )?;
        Ok(preview.audit_report())
    }

    fn clear_data_validations(&mut self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        let old_count = self.data_validations.len();
        self.data_validations
            .retain(|rule| rule.range.sheet != sheet);
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "data_validation_update",
            sheet,
            0,
            0,
            &old_count.to_string(),
            "0",
            "clear_data_validations",
        ));
        Ok(self.audit_report())
    }

    fn set_autofilter(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_autofilter_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            "set_autofilter",
        )?;
        Ok(self.audit_report())
    }

    fn preview_set_autofilter(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_autofilter_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            "preview_set_autofilter",
        )?;
        Ok(preview.audit_report())
    }

    fn clear_autofilter(&mut self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        self.auto_filters.retain(|rule| rule.range.sheet != sheet);
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "autofilter_update",
            sheet,
            0,
            0,
            "",
            "",
            "clear_autofilter",
        ));
        Ok(self.audit_report())
    }

    fn add_conditional_format(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_conditional_format_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            rule,
            "add_conditional_format",
        )?;
        Ok(self.audit_report())
    }

    fn preview_add_conditional_format(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_conditional_format_with_reason(
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            rule,
            "preview_add_conditional_format",
        )?;
        Ok(preview.audit_report())
    }

    fn clear_conditional_formats(&mut self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        let old_count = self.conditional_formats.len();
        self.conditional_formats
            .retain(|rule| rule.range.sheet != sheet);
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "conditional_format_update",
            sheet,
            0,
            0,
            &old_count.to_string(),
            "0",
            "clear_conditional_formats",
        ));
        Ok(self.audit_report())
    }

    fn object_inventory(&self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.object_inventory_for_sheet(sheet))
    }

    fn drawing_object_inventory(&self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.drawing_inventory_for_sheet(sheet))
    }

    fn drawing_relationship_diagnostics(
        &self,
        sheet: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.drawing_diagnostics_for_sheet(sheet))
    }

    fn high_risk_object_inventory(&self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.high_risk_inventory_for_sheet(sheet))
    }

    fn high_risk_object_diagnostics(&self, sheet: &str) -> PyResult<Vec<HashMap<String, String>>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.high_risk_diagnostics_for_sheet(sheet))
    }

    fn high_risk_object_status(&self, sheet: &str) -> PyResult<HashMap<String, String>> {
        self.validate_cell_target(sheet, 1, 1)?;
        Ok(self.high_risk_status_for_sheet(sheet))
    }

    fn read_high_risk_object(
        &self,
        sheet: &str,
        object_id: &str,
    ) -> PyResult<HashMap<String, String>> {
        self.validate_cell_target(sheet, 1, 1)?;
        self.high_risk_read_for_object(sheet, object_id)
    }

    fn update_sparkline_source(
        &mut self,
        sheet: &str,
        object_id: &str,
        source_formula: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_update_sparkline_source(
            sheet,
            object_id,
            source_formula,
            "update_sparkline_source",
        )?;
        Ok(self.audit_report())
    }

    fn preview_update_sparkline_source(
        &self,
        sheet: &str,
        object_id: &str,
        source_formula: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_update_sparkline_source(
            sheet,
            object_id,
            source_formula,
            "preview_update_sparkline_source",
        )?;
        Ok(preview.audit_report())
    }

    fn update_pivot_metadata(
        &mut self,
        sheet: &str,
        object_id: &str,
        name: Option<String>,
        data_caption: Option<String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_update_pivot_metadata(
            sheet,
            object_id,
            name.as_deref(),
            data_caption.as_deref(),
            "update_pivot_metadata",
        )?;
        Ok(self.audit_report())
    }

    fn preview_update_pivot_metadata(
        &self,
        sheet: &str,
        object_id: &str,
        name: Option<String>,
        data_caption: Option<String>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_update_pivot_metadata(
            sheet,
            object_id,
            name.as_deref(),
            data_caption.as_deref(),
            "preview_update_pivot_metadata",
        )?;
        Ok(preview.audit_report())
    }

    fn replace_ole_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        ole_path: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_replace_ole_object(sheet, object_id, ole_path, "replace_ole_object")?;
        Ok(self.audit_report())
    }

    fn preview_replace_ole_object(
        &self,
        sheet: &str,
        object_id: &str,
        ole_path: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_replace_ole_object(
            sheet,
            object_id,
            ole_path,
            "preview_replace_ole_object",
        )?;
        Ok(preview.audit_report())
    }

    fn move_drawing_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        start_row: usize,
        start_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_move_drawing_object(
            sheet,
            object_id,
            start_row,
            start_col,
            "move_drawing_object",
        )?;
        Ok(self.audit_report())
    }

    fn preview_move_drawing_object(
        &self,
        sheet: &str,
        object_id: &str,
        start_row: usize,
        start_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_move_drawing_object(
            sheet,
            object_id,
            start_row,
            start_col,
            "preview_move_drawing_object",
        )?;
        Ok(preview.audit_report())
    }

    fn resize_drawing_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_resize_drawing_object(
            sheet,
            object_id,
            end_row,
            end_col,
            "resize_drawing_object",
        )?;
        Ok(self.audit_report())
    }

    fn preview_resize_drawing_object(
        &self,
        sheet: &str,
        object_id: &str,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_resize_drawing_object(
            sheet,
            object_id,
            end_row,
            end_col,
            "preview_resize_drawing_object",
        )?;
        Ok(preview.audit_report())
    }

    fn replace_image(
        &mut self,
        sheet: &str,
        object_id: &str,
        image_path: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_replace_image(sheet, object_id, image_path, "replace_image")?;
        Ok(self.audit_report())
    }

    fn preview_replace_image(
        &self,
        sheet: &str,
        object_id: &str,
        image_path: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_replace_image(sheet, object_id, image_path, "preview_replace_image")?;
        Ok(preview.audit_report())
    }

    fn update_drawing_text(
        &mut self,
        sheet: &str,
        object_id: &str,
        text: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_update_drawing_text(sheet, object_id, text, "update_drawing_text")?;
        Ok(self.audit_report())
    }

    fn preview_update_drawing_text(
        &self,
        sheet: &str,
        object_id: &str,
        text: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_update_drawing_text(sheet, object_id, text, "preview_update_drawing_text")?;
        Ok(preview.audit_report())
    }

    fn update_chart_title(
        &mut self,
        sheet: &str,
        object_id: &str,
        title: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_update_chart_title(sheet, object_id, title, "update_chart_title")?;
        Ok(self.audit_report())
    }

    fn preview_update_chart_title(
        &self,
        sheet: &str,
        object_id: &str,
        title: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_update_chart_title(sheet, object_id, title, "preview_update_chart_title")?;
        Ok(preview.audit_report())
    }

    fn update_chart_source(
        &mut self,
        sheet: &str,
        object_id: &str,
        source_range: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        self.apply_update_chart_source(sheet, object_id, source_range, "update_chart_source")?;
        Ok(self.audit_report())
    }

    fn preview_update_chart_source(
        &self,
        sheet: &str,
        object_id: &str,
        source_range: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let mut preview = self.clone();
        preview.audit_events.clear();
        preview.apply_update_chart_source(
            sheet,
            object_id,
            source_range,
            "preview_update_chart_source",
        )?;
        Ok(preview.audit_report())
    }

    fn batch_update_cells(
        &mut self,
        updates: Vec<(String, usize, usize, String)>,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        if updates.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: batch must not be empty",
            ));
        }
        for (sheet, row, col, value) in updates {
            self.update_cell_with_reason(&sheet, row, col, &value, "batch_update")?;
        }
        Ok(self.audit_report())
    }

    fn audit_report(&self) -> Vec<HashMap<String, String>> {
        self.audit_events
            .iter()
            .map(|event| event.to_map())
            .collect()
    }

    fn clear_audit_log(&mut self) {
        self.audit_events.clear();
    }

    fn diff_report(&self) -> Vec<HashMap<String, String>> {
        self.audit_report()
    }

    fn workbook_status(&self) -> HashMap<String, String> {
        HashMap::from([
            (
                "source_path".to_string(),
                self.source_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ),
            ("sheet_count".to_string(), self.sheets.len().to_string()),
            ("meta_count".to_string(), self.meta.len().to_string()),
            (
                "modified_count".to_string(),
                self.modified.len().to_string(),
            ),
            ("dirty_count".to_string(), self.dirty.len().to_string()),
        ])
    }

    fn get_cell_typed_value(&self, sheet: &str, row: usize, col: usize) -> HashMap<String, String> {
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let meta = self.meta.get(&key);
        let raw_value = self.cells.get(&key).cloned().unwrap_or_default();
        let semantic_type = meta
            .map(infer_semantic_type)
            .unwrap_or_else(|| "blank".to_string());
        let canonical_value = canonical_cell_value(&raw_value, &semantic_type);
        let display_value = display_cell_value(&canonical_value, &semantic_type);
        HashMap::from([
            ("sheet".to_string(), sheet.to_string()),
            ("row".to_string(), row.to_string()),
            ("col".to_string(), col.to_string()),
            ("value".to_string(), raw_value.clone()),
            ("raw_value".to_string(), raw_value),
            ("canonical_value".to_string(), canonical_value),
            ("display_value".to_string(), display_value),
            (
                "cell_type".to_string(),
                meta.map(|item| item.cell_type.clone())
                    .unwrap_or_else(|| "blank".to_string()),
            ),
            (
                "number_format".to_string(),
                meta.map(|item| item.number_format.clone())
                    .unwrap_or_default(),
            ),
            (
                "original_formula".to_string(),
                meta.map(|item| item.original_formula.clone())
                    .unwrap_or_default(),
            ),
            ("semantic_type".to_string(), semantic_type),
            (
                "style_id".to_string(),
                meta.and_then(|item| item.style_id.map(|id| id.to_string()))
                    .unwrap_or_default(),
            ),
        ])
    }

    fn update_cell_with_reason(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        val: &str,
        reason: &str,
    ) -> PyResult<Vec<CellCoord>> {
        self.validate_cell_target(sheet, row, col)?;
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let old_input_value = self.cells.get(&key).cloned().unwrap_or_default();
        self.cells.insert(key.clone(), val.to_string());
        self.modified.insert(key.clone());
        self.ensure_meta_record(&key).is_modified = true;
        self.ensure_meta_record(&key).cached_value_after = val.to_string();
        self.audit_events.push(AuditEvent {
            event_type: "input_update".to_string(),
            sheet: key.sheet.clone(),
            row: key.row,
            col: key.col,
            old_value: old_input_value,
            new_value: val.to_string(),
            formula: String::new(),
            reason: reason.to_string(),
        });

        self.recalculate_dependents_from(&key.sheet, key.row, key.col)
    }

    fn set_formula_with_reason(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        formula: &str,
        reason: &str,
    ) -> PyResult<Vec<CellCoord>> {
        let mut next = self.clone();
        let impacted = next.apply_formula_with_reason(sheet, row, col, formula, reason)?;
        *self = next;
        Ok(impacted)
    }

    fn apply_formula_with_reason(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        formula: &str,
        reason: &str,
    ) -> PyResult<Vec<CellCoord>> {
        self.validate_cell_target(sheet, row, col)?;
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let normalized_formula = normalize_formula_text(formula)?;
        let old_value = self.cells.get(&key).cloned().unwrap_or_default();

        self.formulas.insert(
            key.clone(),
            FormulaCell {
                formula: normalized_formula.clone(),
                deps: HashSet::new(),
            },
        );
        self.rebuild_formula_deps();
        if self
            .formulas
            .get(&key)
            .map(|formula| formula.deps.contains(&key))
            .unwrap_or(false)
        {
            return Err(PyValueError::new_err(
                "unsupported_formula: circular formula references are not supported",
            ));
        }
        self.rebuild_dependents();

        let new_value = self.evaluate_formula_cell(&key)?;
        self.cells.insert(key.clone(), new_value.clone());
        self.modified.insert(key.clone());

        let meta = self.ensure_meta_record(&key);
        meta.cell_type = "formula".to_string();
        meta.original_formula = normalized_formula.clone();
        meta.cached_value_before = old_value.clone();
        meta.cached_value_after = new_value.clone();
        meta.is_modified = true;

        self.audit_events.push(AuditEvent {
            event_type: "formula_update".to_string(),
            sheet: key.sheet.clone(),
            row: key.row,
            col: key.col,
            old_value,
            new_value,
            formula: normalized_formula,
            reason: reason.to_string(),
        });

        let mut impacted = vec![CellCoord {
            sheet: key.sheet.clone(),
            row: key.row,
            col: key.col,
        }];
        impacted.extend(self.recalculate_dependents_from(&key.sheet, key.row, key.col)?);
        Ok(impacted)
    }

    fn apply_cell_format_with_reason(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        intent: HashMap<String, String>,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, row, col)?;
        let intent = CellFormatIntent::from_map(intent)?;
        if !intent.has_changes() {
            return Err(PyValueError::new_err(
                "unsafe_update: set_cell_format requires at least one supported format intent",
            ));
        }
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let old_style = self
            .meta
            .get(&key)
            .and_then(|meta| meta.style_id)
            .unwrap_or(0);
        let style_id = self.style_count + self.style_patches.len() as u32;
        self.style_patches.push(StylePatch {
            key: key.clone(),
            base_style_id: old_style,
            intent: intent.clone(),
        });
        self.modified.insert(key.clone());
        let meta = self.ensure_meta_record(&key);
        let old_value = format!(
            "style_id={};number_format={}",
            meta.style_id.map(|id| id.to_string()).unwrap_or_default(),
            meta.number_format
        );
        meta.style_id = Some(style_id);
        if let Some(number_format) = &intent.number_format {
            meta.number_format = number_format.clone();
        }
        meta.is_modified = true;
        self.audit_events.push(AuditEvent {
            event_type: "style_update".to_string(),
            sheet: key.sheet.clone(),
            row: key.row,
            col: key.col,
            old_value,
            new_value: intent.to_audit_string(style_id, old_style),
            formula: String::new(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_merge_with_reason(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        merge: bool,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, start_row, start_col)?;
        self.validate_cell_target(sheet, end_row, end_col)?;
        let top = start_row.min(end_row);
        let bottom = start_row.max(end_row);
        let left = start_col.min(end_col);
        let right = start_col.max(end_col);
        if top == bottom && left == right {
            return Err(PyValueError::new_err(
                "unsafe_update: merge range must cover more than one cell",
            ));
        }
        let range = format!(
            "{}{}:{}{}",
            col_to_name(left),
            top,
            col_to_name(right),
            bottom
        );
        let ranges = self.merges.entry(sheet.to_string()).or_default();
        let changed = if merge {
            ranges.insert(range.clone())
        } else {
            ranges.remove(&range)
        };
        if !changed {
            return Err(PyValueError::new_err(format!(
                "unsafe_update: merge range {range} was not changed"
            )));
        }
        self.merge_dirty_sheets.insert(sheet.to_string());
        for row in top..=bottom {
            for col in left..=right {
                let key = Key {
                    sheet: sheet.to_string(),
                    row,
                    col,
                };
                self.ensure_meta_record(&key).merge_range =
                    if merge { range.clone() } else { String::new() };
            }
        }
        self.audit_events.push(AuditEvent {
            event_type: if merge {
                "merge_update"
            } else {
                "unmerge_update"
            }
            .to_string(),
            sheet: sheet.to_string(),
            row: top,
            col: left,
            old_value: if merge { String::new() } else { range.clone() },
            new_value: if merge { range.clone() } else { String::new() },
            formula: String::new(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_sheet_rename(&mut self, sheet: &str, new_name: &str, reason: &str) -> PyResult<()> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: new sheet name must not be empty",
            ));
        }
        if self.sheets.iter().any(|item| item.name == new_name) {
            return Err(PyValueError::new_err(format!(
                "unsafe_update: sheet name already exists: {new_name}"
            )));
        }
        let Some(sheet_info) = self.sheets.iter_mut().find(|item| item.name == sheet) else {
            return Err(PyValueError::new_err(format!("unknown_sheet: {sheet}")));
        };
        sheet_info.name = new_name.to_string();
        self.workbook_dirty = true;
        self.rename_keyed_state(sheet, new_name);
        self.rewrite_formula_sheet_refs(sheet, new_name);
        self.rebuild_formula_deps();
        self.rebuild_dependents();
        self.audit_events.push(AuditEvent {
            event_type: "sheet_rename".to_string(),
            sheet: new_name.to_string(),
            row: 0,
            col: 0,
            old_value: sheet.to_string(),
            new_value: new_name.to_string(),
            formula: String::new(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_sheet_visibility(
        &mut self,
        sheet: &str,
        visibility: &str,
        reason: &str,
    ) -> PyResult<()> {
        let visibility = match visibility {
            "visible" | "" => "visible",
            "hidden" => "hidden",
            "veryHidden" => "veryHidden",
            _ => {
                return Err(PyValueError::new_err(
                    "unsafe_update: visibility must be visible, hidden, or veryHidden",
                ))
            }
        };
        let Some(sheet_info) = self.sheets.iter_mut().find(|item| item.name == sheet) else {
            return Err(PyValueError::new_err(format!("unknown_sheet: {sheet}")));
        };
        let old_visibility = sheet_info.visibility.clone();
        sheet_info.visibility = visibility.to_string();
        self.workbook_dirty = true;
        self.audit_events.push(AuditEvent {
            event_type: "sheet_visibility_update".to_string(),
            sheet: sheet.to_string(),
            row: 0,
            col: 0,
            old_value: old_visibility,
            new_value: visibility.to_string(),
            formula: String::new(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn recalculate_dependents_from(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
    ) -> PyResult<Vec<CellCoord>> {
        let source_key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let mut changed = Vec::new();
        let mut queue = VecDeque::new();
        let mut seen = HashSet::new();

        if let Some(next) = self.dependents.get(&source_key) {
            for dep in next {
                queue.push_back(dep.clone());
            }
        }

        while let Some(formula_key) = queue.pop_front() {
            if !seen.insert(formula_key.clone()) {
                continue;
            }

            let old_value = self.cells.get(&formula_key).cloned().unwrap_or_default();
            let new_value = self.evaluate_formula_cell(&formula_key)?;
            if normalized_number(&old_value) != normalized_number(&new_value) {
                self.cells.insert(formula_key.clone(), new_value);
                self.dirty.insert(formula_key.clone());
                let cached_after = self.cells.get(&formula_key).cloned().unwrap_or_default();
                let formula = self
                    .formulas
                    .get(&formula_key)
                    .map(|cell| cell.formula.clone())
                    .unwrap_or_default();
                let meta = self.ensure_meta_record(&formula_key);
                meta.cached_value_after = cached_after;
                meta.is_dirty = true;
                self.audit_events.push(AuditEvent {
                    event_type: "formula_recalc".to_string(),
                    sheet: formula_key.sheet.clone(),
                    row: formula_key.row,
                    col: formula_key.col,
                    old_value,
                    new_value: self.cells.get(&formula_key).cloned().unwrap_or_default(),
                    formula,
                    reason: format!(
                        "dependent_on:{}!{}{}",
                        source_key.sheet,
                        col_to_name(source_key.col),
                        source_key.row
                    ),
                });
                changed.push(CellCoord {
                    sheet: formula_key.sheet.clone(),
                    row: formula_key.row,
                    col: formula_key.col,
                });

                if let Some(next) = self.dependents.get(&formula_key) {
                    let downstream: Vec<Key> = next.iter().cloned().collect();
                    for dep in downstream {
                        seen.remove(&dep);
                        queue.push_back(dep);
                    }
                }
            }
        }

        Ok(changed)
    }

    fn get_cell_value(&self, sheet: &str, row: usize, col: usize) -> String {
        self.cells
            .get(&Key {
                sheet: sheet.to_string(),
                row,
                col,
            })
            .cloned()
            .unwrap_or_default()
    }

    fn get_cell_meta(&self, sheet: &str, row: usize, col: usize) -> Option<ShadowMetaRecord> {
        self.meta
            .get(&Key {
                sheet: sheet.to_string(),
                row,
                col,
            })
            .cloned()
    }

    fn formula_dependencies(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
    ) -> PyResult<Vec<CellCoord>> {
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let formula = self
            .formulas
            .get(&key)
            .ok_or_else(|| PyValueError::new_err("formula cell not found"))?;
        let mut deps: Vec<CellCoord> = formula
            .deps
            .iter()
            .map(|dep| CellCoord {
                sheet: dep.sheet.clone(),
                row: dep.row,
                col: dep.col,
            })
            .collect();
        deps.sort_by_key(|dep| (dep.sheet.clone(), dep.row, dep.col));
        Ok(deps)
    }

    fn formula_dependency_diagnostics(
        &self,
        sheet: &str,
        row: usize,
        col: usize,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let formula = self
            .formulas
            .get(&key)
            .ok_or_else(|| PyValueError::new_err("formula cell not found"))?;
        let formula_keys: HashSet<Key> = self.formulas.keys().cloned().collect();
        let sheet_order: Vec<String> = self.sheets.iter().map(|sheet| sheet.name.clone()).collect();
        Ok(formula_dependency_diagnostics(
            &key,
            &formula.formula,
            &self.cells,
            &formula_keys,
            &self.tables,
            &self.defined_names,
            &sheet_order,
        ))
    }

    fn shadow_meta_count(&self) -> usize {
        self.meta.len()
    }

    fn sqlite_table_names(&self) -> HashMap<String, String> {
        self.sheet_table_map()
    }

    fn sqlite_query(&self, sql: &str) -> PyResult<Vec<HashMap<String, String>>> {
        if !sql.trim_start().to_ascii_uppercase().starts_with("SELECT ") {
            return Err(PyValueError::new_err(
                "sqlite_query only accepts SELECT statements",
            ));
        }

        let (conn, _, _) = self.build_sqlite_projection()?;
        query_sqlite_connection(&conn, sql)
    }

    fn sqlite_store_query(
        &self,
        sqlite_path: &str,
        sql: &str,
    ) -> PyResult<Vec<HashMap<String, String>>> {
        if !sql.trim_start().to_ascii_uppercase().starts_with("SELECT ") {
            return Err(PyValueError::new_err(
                "sqlite_store_query only accepts SELECT statements",
            ));
        }
        let conn = open_existing_store(sqlite_path)?;
        query_sqlite_connection(&conn, sql)
    }

    fn sqlite_store_update(&mut self, sqlite_path: &str, sql: &str) -> PyResult<Vec<CellCoord>> {
        if !sql.trim_start().to_ascii_uppercase().starts_with("UPDATE ") {
            return Err(PyValueError::new_err(
                "unsafe_update: sqlite_store_update only accepts UPDATE statements",
            ));
        }

        let conn = open_existing_store(sqlite_path)?;
        install_store_update_triggers(&conn)?;
        let execute_result = conn.execute(sql, []).map_err(to_py_store_update);
        let cleanup_result = drop_store_update_triggers(&conn);
        execute_result?;
        cleanup_result?;
        let updates = read_pending_store_updates(&conn)?;
        if updates.len() != 1 {
            return Err(PyValueError::new_err(
                "unsafe_update: sqlite_store_update requires exactly one changed cell",
            ));
        }

        let update = updates.into_iter().next().unwrap();
        let impacted = self.update_cell(&update.sheet, update.row, update.col, &update.value)?;
        self.persist_sqlite_snapshot(sqlite_path)?;
        Ok(impacted)
    }

    fn sqlite_store_status(&self, sqlite_path: &str) -> PyResult<HashMap<String, String>> {
        let conn = open_existing_store(sqlite_path)?;
        let mut status = HashMap::new();
        for table in [
            "ss_workbook",
            "ss_session",
            "ss_sheet",
            "ss_cell_snapshot",
            "ss_shadow_meta",
            "ss_audit_event",
            "ss_formula_edge",
            "ss_graph_node",
            "ss_graph_edge",
            "ss_migration",
        ] {
            status.insert(
                format!("{}_count", table.trim_start_matches("ss_")),
                sqlite_count(&conn, table)?.to_string(),
            );
        }
        let view_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'view' AND name IN (SELECT table_name FROM ss_sheet)",
                [],
                |row| row.get(0),
            )
            .map_err(to_py_runtime)?;
        let table_names = query_sqlite_connection(
            &conn,
            "SELECT name, table_name FROM ss_sheet ORDER BY sheet_index",
        )?
        .into_iter()
        .map(|row| {
            format!(
                "{}={}",
                row.get("name").cloned().unwrap_or_default(),
                row.get("table_name").cloned().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
        status.insert("sheet_view_count".to_string(), view_count.to_string());
        status.insert("sheet_tables".to_string(), table_names);
        status.insert("sqlite_path".to_string(), sqlite_path.to_string());
        let source_path: String = conn
            .query_row(
                "SELECT source_path FROM ss_workbook WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .map_err(to_py_runtime)?;
        let session_state: String = conn
            .query_row(
                "SELECT state FROM ss_session WHERE id = 'active'",
                [],
                |row| row.get(0),
            )
            .map_err(to_py_runtime)?;
        let snapshot_fresh = store_snapshot_matches_runtime(&conn, self)?;
        status.insert("source_path".to_string(), source_path);
        status.insert("session_state".to_string(), session_state);
        status.insert(
            "snapshot_fresh".to_string(),
            if snapshot_fresh { "true" } else { "false" }.to_string(),
        );
        status.insert(
            "snapshot_state".to_string(),
            if snapshot_fresh { "fresh" } else { "stale" }.to_string(),
        );
        Ok(status)
    }

    fn sqlite_update(&mut self, sql: &str) -> PyResult<Vec<CellCoord>> {
        if !sql.trim_start().to_ascii_uppercase().starts_with("UPDATE ") {
            return Err(PyValueError::new_err(
                "sqlite_update only accepts UPDATE statements",
            ));
        }

        let (conn, _, pending_updates) = self.build_sqlite_projection()?;
        conn.execute(sql, []).map_err(to_py_runtime)?;
        let updates = pending_updates.borrow().clone();
        if updates.len() != 1 {
            return Err(PyValueError::new_err(
                "sqlite_update requires exactly one changed cell",
            ));
        }

        let update = updates.into_iter().next().unwrap();
        self.update_cell(&update.sheet, update.row, update.col, &update.value)
    }

    fn persist_audit_snapshot(&self, sqlite_path: &str) -> PyResult<HashMap<String, String>> {
        self.persist_sqlite_snapshot(sqlite_path)
    }

    #[pyo3(signature = (output_path, shared_string_policy = "preserve"))]
    fn save(&self, output_path: &str, shared_string_policy: &str) -> PyResult<()> {
        let source_path = self
            .source_path
            .as_ref()
            .ok_or_else(|| PyValueError::new_err("ingest() must be called before save()"))?;
        let shared_string_policy = parse_shared_string_policy(shared_string_policy)?;
        let shared_string_plan =
            self.build_shared_string_patch_plan(source_path, shared_string_policy)?;

        let source_file = File::open(source_path).map_err(to_py_runtime)?;
        let mut input = ZipArchive::new(source_file).map_err(to_py_runtime)?;
        let output_file = File::create(output_path).map_err(to_py_runtime)?;
        let mut output = ZipWriter::new(output_file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let sheet_paths: HashMap<String, String> = self
            .sheets
            .iter()
            .map(|sheet| (sheet.path.clone(), sheet.name.clone()))
            .collect();
        let comment_parts = self.comment_part_paths();
        let rels_paths: HashMap<String, String> = self
            .sheets
            .iter()
            .filter(|sheet| self.comment_dirty_sheets.contains(&sheet.name))
            .map(|sheet| (rels_path_for_part(&sheet.path), sheet.name.clone()))
            .collect();
        let mut copied_entries = HashSet::new();

        for i in 0..input.len() {
            let mut entry = input.by_index(i).map_err(to_py_runtime)?;
            let name = entry.name().to_string();
            copied_entries.insert(name.clone());
            output
                .start_file(name.clone(), options)
                .map_err(to_py_runtime)?;

            if name == "[Content_Types].xml" && !self.comment_dirty_sheets.is_empty() {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_content_types_for_comments(&xml, &comment_parts)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if name == "xl/workbook.xml" && self.workbook_dirty {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_workbook_xml(&xml, &self.sheets, &self.defined_names)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if name == "xl/styles.xml" && !self.style_patches.is_empty() {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_styles_xml(&xml, &self.style_patches)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if let Some(sheet_name) = sheet_paths.get(&name) {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = self.patch_sheet_xml(sheet_name, &xml, &shared_string_plan)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if self.table_dirty_paths.contains(&name) {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let table = self
                    .tables
                    .iter()
                    .find(|table| table.path == name)
                    .ok_or_else(|| PyValueError::new_err("table_patch: dirty table not found"))?;
                let patched = patch_table_xml(&xml, table)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if self.drawing_dirty_paths.contains(&name) {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_drawing_xml(
                    &xml,
                    &name,
                    &self.drawing_objects,
                    &self.drawing_text_updates,
                )?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if self.chart_title_updates.contains_key(&name)
                || self.chart_source_updates.contains_key(&name)
            {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_chart_xml(
                    &xml,
                    self.chart_title_updates.get(&name).map(String::as_str),
                    self.chart_source_updates.get(&name).map(String::as_str),
                )?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if self.pivot_dirty_paths.contains(&name) {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let object = self
                    .high_risk_objects
                    .iter()
                    .find(|object| {
                        object.object_type == "pivot_table" && object.target_path == name
                    })
                    .ok_or_else(|| {
                        PyValueError::new_err("pivot_patch: dirty pivot object not found")
                    })?;
                let patched = patch_pivot_table_xml(&xml, object)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if let Some(bytes) = self.image_replacements.get(&name) {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(to_py_runtime)?;
                output.write_all(bytes).map_err(to_py_runtime)?;
            } else if let Some(bytes) = self.ole_replacements.get(&name) {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(to_py_runtime)?;
                output.write_all(bytes).map_err(to_py_runtime)?;
            } else if let Some(sheet_name) = rels_paths.get(&name) {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let comment_part = comment_parts.get(sheet_name).ok_or_else(|| {
                    PyValueError::new_err("comment_patch: missing comments part path")
                })?;
                let patched = patch_sheet_rels_for_comments(&xml, comment_part)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else if let Some((sheet_name, _)) =
                comment_parts.iter().find(|(_, path)| *path == &name)
            {
                let xml = build_comments_xml(
                    self.comments
                        .iter()
                        .filter(|comment| comment.key.sheet == **sheet_name)
                        .collect(),
                );
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(to_py_runtime)?;
                output.write_all(xml.as_bytes()).map_err(to_py_runtime)?;
            } else if name == "xl/sharedStrings.xml" && !shared_string_plan.updates.is_empty() {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).map_err(to_py_runtime)?;
                let patched = patch_shared_strings_xml(&xml, &shared_string_plan.updates)?;
                output
                    .write_all(patched.as_bytes())
                    .map_err(to_py_runtime)?;
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(to_py_runtime)?;
                output.write_all(&data).map_err(to_py_runtime)?;
            }
        }

        for sheet in self
            .sheets
            .iter()
            .filter(|sheet| self.comment_dirty_sheets.contains(&sheet.name))
        {
            let rels_path = rels_path_for_part(&sheet.path);
            let comment_part = comment_parts.get(&sheet.name).ok_or_else(|| {
                PyValueError::new_err("comment_patch: missing comments part path")
            })?;
            if !copied_entries.contains(&rels_path) {
                output
                    .start_file(rels_path.clone(), options)
                    .map_err(to_py_runtime)?;
                let rels_xml = patch_sheet_rels_for_comments("", comment_part)?;
                output
                    .write_all(rels_xml.as_bytes())
                    .map_err(to_py_runtime)?;
            }
            if !copied_entries.contains(comment_part) {
                output
                    .start_file(comment_part.clone(), options)
                    .map_err(to_py_runtime)?;
                let comments_xml = build_comments_xml(
                    self.comments
                        .iter()
                        .filter(|comment| comment.key.sheet == sheet.name)
                        .collect(),
                );
                output
                    .write_all(comments_xml.as_bytes())
                    .map_err(to_py_runtime)?;
            }
        }

        output.finish().map_err(to_py_runtime)?;
        Ok(())
    }
}

impl SheetShadowEngine {
    fn apply_structure_edit_with_reason(
        &mut self,
        sheet: &str,
        axis: StructureAxis,
        kind: StructureOpKind,
        start: usize,
        end: usize,
        target_or_count: usize,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, 1, 1)?;
        if start == 0 || end == 0 || end < start {
            return Err(PyValueError::new_err(
                "unsafe_update: structure range must be positive and ordered",
            ));
        }
        let edit = match kind {
            StructureOpKind::Insert => {
                if target_or_count == 0 {
                    return Err(PyValueError::new_err(
                        "unsafe_update: insert count must be positive",
                    ));
                }
                StructureEdit {
                    sheet: sheet.to_string(),
                    axis,
                    kind,
                    start,
                    end: start + target_or_count - 1,
                    target: start,
                }
            }
            StructureOpKind::Delete => {
                if target_or_count != 0 {
                    return Err(PyValueError::new_err(
                        "unsafe_update: delete does not accept a target",
                    ));
                }
                StructureEdit {
                    sheet: sheet.to_string(),
                    axis,
                    kind,
                    start,
                    end,
                    target: 0,
                }
            }
            StructureOpKind::Move => {
                let target = target_or_count;
                if target == 0 {
                    return Err(PyValueError::new_err(
                        "unsafe_update: move target must be positive",
                    ));
                }
                if (start..=end).contains(&target) {
                    return Err(PyValueError::new_err(
                        "unsafe_update: move target must be outside the moved range",
                    ));
                }
                StructureEdit {
                    sheet: sheet.to_string(),
                    axis,
                    kind,
                    start,
                    end,
                    target,
                }
            }
        };

        self.shift_keyed_state(&edit);
        self.shift_merges(&edit);
        self.shift_tables(&edit);
        self.shift_defined_names(&edit);
        self.shift_sheet_objects(&edit);
        self.shift_drawing_objects(&edit);
        self.shift_high_risk_objects(&edit);
        self.rewrite_formulas_for_structure(&edit);
        self.rebuild_formula_deps();
        self.rebuild_dependents();
        self.recalculate_all_formulas(reason)?;
        self.structural_edits.push(edit.clone());
        self.structural_dirty_sheets.insert(sheet.to_string());

        let axis_text = match axis {
            StructureAxis::Row => "row",
            StructureAxis::Col => "col",
        };
        let kind_text = match kind {
            StructureOpKind::Insert => "insert",
            StructureOpKind::Delete => "delete",
            StructureOpKind::Move => "move",
        };
        self.audit_events.push(AuditEvent {
            event_type: "structure_update".to_string(),
            sheet: sheet.to_string(),
            row: if axis == StructureAxis::Row { start } else { 0 },
            col: if axis == StructureAxis::Col { start } else { 0 },
            old_value: format!("{axis_text}:{start}:{end}"),
            new_value: format!("{kind_text}:target={}:end={}", edit.target, edit.end),
            formula: String::new(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn shift_keyed_state(&mut self, edit: &StructureEdit) {
        self.cells = shift_key_map(std::mem::take(&mut self.cells), edit);
        self.formulas = shift_key_map(std::mem::take(&mut self.formulas), edit);
        self.meta = shift_key_map(std::mem::take(&mut self.meta), edit);
        self.modified = shift_key_set(std::mem::take(&mut self.modified), edit);
        self.dirty = shift_key_set(std::mem::take(&mut self.dirty), edit);
        for (key, meta) in self.meta.iter_mut() {
            meta.sheet_name = key.sheet.clone();
            meta.row_idx = key.row;
            meta.col_idx = key.col;
        }
        for patch in &mut self.style_patches {
            if let Some(next) = transform_key(&patch.key, edit) {
                patch.key = next;
            }
        }
    }

    fn shift_merges(&mut self, edit: &StructureEdit) {
        let Some(ranges) = self.merges.get(&edit.sheet).cloned() else {
            return;
        };
        let shifted = ranges
            .into_iter()
            .filter_map(|range| transform_range_ref(&range, &edit.sheet, edit))
            .collect::<HashSet<_>>();
        self.merges.insert(edit.sheet.clone(), shifted);
        self.merge_dirty_sheets.insert(edit.sheet.clone());
        for meta in self
            .meta
            .values_mut()
            .filter(|meta| meta.sheet_name == edit.sheet)
        {
            if !meta.merge_range.is_empty() {
                meta.merge_range =
                    transform_range_ref(&meta.merge_range, &edit.sheet, edit).unwrap_or_default();
            }
        }
    }

    fn shift_tables(&mut self, edit: &StructureEdit) {
        for table in &mut self.tables {
            if table.sheet != edit.sheet {
                continue;
            }
            let old_ref = table_ref(table);
            apply_table_shift(table, edit);
            let new_ref = table_ref(table);
            if old_ref != new_ref {
                self.table_dirty_paths.insert(table.path.clone());
                self.audit_events.push(AuditEvent {
                    event_type: "table_range_update".to_string(),
                    sheet: table.sheet.clone(),
                    row: table.start_row,
                    col: table.start_col,
                    old_value: old_ref,
                    new_value: new_ref,
                    formula: table.name.clone(),
                    reason: "structure_range_follow".to_string(),
                });
            }
        }
    }

    fn shift_defined_names(&mut self, edit: &StructureEdit) {
        for defined_name in &mut self.defined_names {
            let rewritten = rewrite_formula_structure_refs(&defined_name.target, "", edit);
            if rewritten != defined_name.target {
                let old = std::mem::replace(&mut defined_name.target, rewritten);
                self.workbook_dirty = true;
                self.audit_events.push(AuditEvent {
                    event_type: "defined_name_update".to_string(),
                    sheet: edit.sheet.clone(),
                    row: 0,
                    col: 0,
                    old_value: old,
                    new_value: defined_name.target.clone(),
                    formula: defined_name.name.clone(),
                    reason: "structure_range_follow".to_string(),
                });
            }
        }
    }

    fn shift_sheet_objects(&mut self, edit: &StructureEdit) {
        let mut comment_changed = false;
        self.comments = self
            .comments
            .drain(..)
            .filter_map(|mut comment| {
                if comment.key.sheet != edit.sheet {
                    return Some(comment);
                }
                let old_ref = format!("{}{}", col_to_name(comment.key.col), comment.key.row);
                let Some(next) = transform_key(&comment.key, edit) else {
                    comment_changed = true;
                    self.audit_events.push(object_audit_event(
                        "comment_update",
                        &edit.sheet,
                        comment.key.row,
                        comment.key.col,
                        &old_ref,
                        "",
                        "structure_object_follow",
                    ));
                    return None;
                };
                if next != comment.key {
                    let new_ref = format!("{}{}", col_to_name(next.col), next.row);
                    comment.key = next;
                    comment_changed = true;
                    self.audit_events.push(object_audit_event(
                        "comment_update",
                        &edit.sheet,
                        comment.key.row,
                        comment.key.col,
                        &old_ref,
                        &new_ref,
                        "structure_object_follow",
                    ));
                }
                Some(comment)
            })
            .collect();
        if comment_changed {
            self.comment_dirty_sheets.insert(edit.sheet.clone());
        }

        let mut object_changed = false;
        for rule in &mut self.data_validations {
            if rule.range.sheet == edit.sheet {
                object_changed |= shift_object_range(&mut rule.range, edit);
            }
        }
        self.data_validations
            .retain(|rule| valid_object_range(&rule.range));
        for rule in &mut self.auto_filters {
            if rule.range.sheet == edit.sheet {
                object_changed |= shift_object_range(&mut rule.range, edit);
            }
        }
        self.auto_filters
            .retain(|rule| valid_object_range(&rule.range));
        for rule in &mut self.conditional_formats {
            if rule.range.sheet == edit.sheet {
                object_changed |= shift_object_range(&mut rule.range, edit);
            }
        }
        self.conditional_formats
            .retain(|rule| valid_object_range(&rule.range));
        if object_changed {
            self.object_dirty_sheets.insert(edit.sheet.clone());
            self.audit_events.push(object_audit_event(
                "object_range_update",
                &edit.sheet,
                0,
                0,
                "",
                "ranges_followed",
                "structure_object_follow",
            ));
        }
    }

    fn shift_drawing_objects(&mut self, edit: &StructureEdit) {
        let mut changed = false;
        let mut invalidated = false;
        for object in &mut self.drawing_objects {
            if object.sheet != edit.sheet {
                continue;
            }
            if object.anchor_kind == "absoluteAnchor" {
                continue;
            }
            let old_ref = object.ref_text();
            let mut object_changed = false;
            let mut object_invalidated = false;
            match edit.axis {
                StructureAxis::Row => {
                    object_invalidated |= drawing_marker_deleted(object.from_row, edit);
                    object_invalidated |= drawing_marker_deleted(object.to_row, edit);
                    object_changed |= shift_drawing_marker(&mut object.from_row, edit);
                    object_changed |= shift_drawing_marker(&mut object.to_row, edit);
                }
                StructureAxis::Col => {
                    object_invalidated |= drawing_marker_deleted(object.from_col, edit);
                    object_invalidated |= drawing_marker_deleted(object.to_col, edit);
                    object_changed |= shift_drawing_marker(&mut object.from_col, edit);
                    object_changed |= shift_drawing_marker(&mut object.to_col, edit);
                }
            }
            if object_invalidated {
                object.invalid_reason = "anchor_cell_deleted_by_structure_edit".to_string();
                invalidated = true;
            }
            if object_changed {
                let new_ref = object.ref_text();
                self.drawing_dirty_paths.insert(object.drawing_path.clone());
                self.audit_events.push(AuditEvent {
                    event_type: "drawing_anchor_update".to_string(),
                    sheet: object.sheet.clone(),
                    row: object.from_row.unwrap_or(0),
                    col: object.from_col.unwrap_or(0),
                    old_value: old_ref,
                    new_value: new_ref,
                    formula: object.object_id.clone(),
                    reason: "structure_drawing_anchor_follow".to_string(),
                });
                changed = true;
            }
        }
        if changed {
            self.audit_events.push(object_audit_event(
                "drawing_object_update",
                &edit.sheet,
                0,
                0,
                "",
                "anchors_followed",
                "structure_drawing_anchor_follow",
            ));
        }
        if invalidated {
            self.audit_events.push(object_audit_event(
                "drawing_object_warning",
                &edit.sheet,
                0,
                0,
                "",
                "anchor_cell_deleted_by_structure_edit",
                "structure_drawing_anchor_follow",
            ));
        }
    }

    fn shift_high_risk_objects(&mut self, edit: &StructureEdit) {
        let mut changed = false;
        let mut invalidated = false;
        for object in &mut self.high_risk_objects {
            if object.sheet != edit.sheet || object.object_type != "sparkline" {
                continue;
            }
            let old_formula = object.source_formula.clone();
            let old_ref = object.ref_text.clone();
            let rewritten_formula =
                rewrite_formula_structure_refs(&object.source_formula, &object.sheet, edit);
            let rewritten_ref = transform_sqref_ref(&object.ref_text, &object.sheet, edit);

            if rewritten_formula.contains("#REF!") || rewritten_ref.is_none() {
                object.invalid_reason = "sparkline_ref_deleted_by_structure_edit".to_string();
                invalidated = true;
                self.audit_events.push(AuditEvent {
                    event_type: "sparkline_ref_warning".to_string(),
                    sheet: object.sheet.clone(),
                    row: 0,
                    col: 0,
                    old_value: old_ref,
                    new_value: "sparkline_ref_deleted_by_structure_edit".to_string(),
                    formula: object.object_id.clone(),
                    reason: "structure_sparkline_follow".to_string(),
                });
                continue;
            }

            let rewritten_ref = rewritten_ref.unwrap_or_default();
            if rewritten_formula != object.source_formula {
                object.source_formula = rewritten_formula;
                self.sparkline_source_updates
                    .insert(object.object_id.clone(), object.source_formula.clone());
                self.sparkline_dirty_objects
                    .insert(object.object_id.clone());
                self.audit_events.push(AuditEvent {
                    event_type: "sparkline_source_update".to_string(),
                    sheet: object.sheet.clone(),
                    row: 0,
                    col: 0,
                    old_value: old_formula,
                    new_value: object.source_formula.clone(),
                    formula: object.object_id.clone(),
                    reason: "structure_sparkline_source_follow".to_string(),
                });
                changed = true;
            }
            if rewritten_ref != object.ref_text {
                object.ref_text = rewritten_ref;
                self.sparkline_dirty_objects
                    .insert(object.object_id.clone());
                self.audit_events.push(AuditEvent {
                    event_type: "sparkline_ref_update".to_string(),
                    sheet: object.sheet.clone(),
                    row: 0,
                    col: 0,
                    old_value: old_ref,
                    new_value: object.ref_text.clone(),
                    formula: object.object_id.clone(),
                    reason: "structure_sparkline_sqref_follow".to_string(),
                });
                changed = true;
            }
        }
        if changed {
            self.sparkline_dirty_sheets.insert(edit.sheet.clone());
        }
        if invalidated {
            self.audit_events.push(object_audit_event(
                "sparkline_object_warning",
                &edit.sheet,
                0,
                0,
                "",
                "sparkline_ref_deleted_by_structure_edit",
                "structure_sparkline_follow",
            ));
        }
    }

    fn apply_move_drawing_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        start_row: usize,
        start_col: usize,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, start_row, start_col)?;
        let object = self.drawing_object_mut(sheet, object_id)?;
        if object.anchor_kind == "absoluteAnchor" {
            return Err(PyValueError::new_err(
                "unsafe_update: absoluteAnchor drawing objects cannot be moved by cell coordinates",
            ));
        }
        let old_ref = object.ref_text();
        let old_row = object
            .from_row
            .ok_or_else(|| PyValueError::new_err("drawing_object: missing from row marker"))?;
        let old_col = object
            .from_col
            .ok_or_else(|| PyValueError::new_err("drawing_object: missing from col marker"))?;
        if let Some(to_row) = object.to_row {
            object.to_row = Some(start_row + to_row.saturating_sub(old_row));
        }
        if let Some(to_col) = object.to_col {
            object.to_col = Some(start_col + to_col.saturating_sub(old_col));
        }
        object.from_row = Some(start_row);
        object.from_col = Some(start_col);
        let drawing_path = object.drawing_path.clone();
        let new_ref = object.ref_text();
        self.drawing_dirty_paths.insert(drawing_path);
        self.audit_events.push(AuditEvent {
            event_type: "drawing_anchor_update".to_string(),
            sheet: sheet.to_string(),
            row: start_row,
            col: start_col,
            old_value: old_ref,
            new_value: new_ref,
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_resize_drawing_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        end_row: usize,
        end_col: usize,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, end_row, end_col)?;
        let object = self.drawing_object_mut(sheet, object_id)?;
        if object.anchor_kind != "twoCellAnchor" {
            return Err(PyValueError::new_err(
                "unsafe_update: resize currently requires a twoCellAnchor drawing object",
            ));
        }
        let from_row = object
            .from_row
            .ok_or_else(|| PyValueError::new_err("drawing_object: missing from row marker"))?;
        let from_col = object
            .from_col
            .ok_or_else(|| PyValueError::new_err("drawing_object: missing from col marker"))?;
        if end_row < from_row || end_col < from_col {
            return Err(PyValueError::new_err(
                "unsafe_update: resized drawing end marker must be at or after the start marker",
            ));
        }
        let old_ref = object.ref_text();
        object.to_row = Some(end_row);
        object.to_col = Some(end_col);
        let drawing_path = object.drawing_path.clone();
        let new_ref = object.ref_text();
        self.drawing_dirty_paths.insert(drawing_path);
        self.audit_events.push(AuditEvent {
            event_type: "drawing_anchor_update".to_string(),
            sheet: sheet.to_string(),
            row: from_row,
            col: from_col,
            old_value: old_ref,
            new_value: new_ref,
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_replace_image(
        &mut self,
        sheet: &str,
        object_id: &str,
        image_path: &str,
        reason: &str,
    ) -> PyResult<()> {
        let object = self.drawing_object_for_edit(sheet, object_id)?.clone();
        if object.object_type != "image" {
            return Err(PyValueError::new_err(
                "unsafe_update: replace_image requires an image drawing object",
            ));
        }
        if object.target_path.is_empty() || !object.target_exists {
            return Err(PyValueError::new_err(
                "drawing_relationship_resolution: image target part is missing",
            ));
        }
        let bytes = std::fs::read(image_path).map_err(to_py_runtime)?;
        if bytes.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: replacement image must not be empty",
            ));
        }
        self.image_replacements
            .insert(object.target_path.clone(), bytes);
        self.audit_events.push(AuditEvent {
            event_type: "drawing_image_replace".to_string(),
            sheet: sheet.to_string(),
            row: object.from_row.unwrap_or(0),
            col: object.from_col.unwrap_or(0),
            old_value: object.target_path.clone(),
            new_value: image_path.to_string(),
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_update_drawing_text(
        &mut self,
        sheet: &str,
        object_id: &str,
        text: &str,
        reason: &str,
    ) -> PyResult<()> {
        if text.trim().is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: drawing text must not be empty",
            ));
        }
        let object = self.drawing_object_for_edit(sheet, object_id)?.clone();
        if !matches!(object.object_type.as_str(), "shape" | "drawing") {
            return Err(PyValueError::new_err(
                "unsafe_update: update_drawing_text requires a shape/textbox drawing object",
            ));
        }
        self.drawing_text_updates
            .insert(object.object_id.clone(), text.to_string());
        self.drawing_dirty_paths.insert(object.drawing_path.clone());
        self.audit_events.push(AuditEvent {
            event_type: "drawing_text_update".to_string(),
            sheet: sheet.to_string(),
            row: object.from_row.unwrap_or(0),
            col: object.from_col.unwrap_or(0),
            old_value: object.object_type,
            new_value: text.to_string(),
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_update_chart_title(
        &mut self,
        sheet: &str,
        object_id: &str,
        title: &str,
        reason: &str,
    ) -> PyResult<()> {
        if title.trim().is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: chart title must not be empty",
            ));
        }
        let object = self.chart_object_for_edit(sheet, object_id)?.clone();
        self.chart_title_updates
            .insert(object.target_path.clone(), title.to_string());
        self.audit_events.push(AuditEvent {
            event_type: "chart_title_update".to_string(),
            sheet: sheet.to_string(),
            row: object.from_row.unwrap_or(0),
            col: object.from_col.unwrap_or(0),
            old_value: object.target_path,
            new_value: title.to_string(),
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_update_chart_source(
        &mut self,
        sheet: &str,
        object_id: &str,
        source_range: &str,
        reason: &str,
    ) -> PyResult<()> {
        let normalized = normalize_chart_source_range(source_range)?;
        let object = self.chart_object_for_edit(sheet, object_id)?.clone();
        self.chart_source_updates
            .insert(object.target_path.clone(), normalized.clone());
        self.audit_events.push(AuditEvent {
            event_type: "chart_source_update".to_string(),
            sheet: sheet.to_string(),
            row: object.from_row.unwrap_or(0),
            col: object.from_col.unwrap_or(0),
            old_value: object.target_path,
            new_value: normalized,
            formula: object_id.to_string(),
            reason: reason.to_string(),
        });
        Ok(())
    }

    fn apply_update_sparkline_source(
        &mut self,
        sheet: &str,
        object_id: &str,
        source_formula: &str,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, 1, 1)?;
        let normalized = source_formula.trim();
        if normalized.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: sparkline source_formula must not be empty",
            ));
        }
        let (old_formula, ref_text) = {
            let object = self.high_risk_object_mut(sheet, object_id)?;
            if object.object_type != "sparkline" {
                return Err(PyValueError::new_err(
                    "unsafe_update: high-risk edit only supports sparkline update_source",
                ));
            }
            if object.source_formula.is_empty() {
                return Err(PyValueError::new_err(
                    "unsafe_update: sparkline source formula could not be read safely",
                ));
            }
            let old_formula = object.source_formula.clone();
            let ref_text = object.ref_text.clone();
            object.source_formula = normalized.to_string();
            (old_formula, ref_text)
        };
        self.sparkline_source_updates
            .insert(object_id.to_string(), normalized.to_string());
        self.sparkline_dirty_sheets.insert(sheet.to_string());
        self.sparkline_dirty_objects.insert(object_id.to_string());
        self.audit_events.push(AuditEvent {
            event_type: "sparkline_source_update".to_string(),
            sheet: sheet.to_string(),
            row: 0,
            col: 0,
            old_value: old_formula,
            new_value: normalized.to_string(),
            formula: object_id.to_string(),
            reason: format!("{reason}:sqref={ref_text}"),
        });
        Ok(())
    }

    fn apply_update_pivot_metadata(
        &mut self,
        sheet: &str,
        object_id: &str,
        name: Option<&str>,
        data_caption: Option<&str>,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, 1, 1)?;
        let normalized_name = normalize_optional_pivot_text(name, "pivot name")?;
        let normalized_caption = normalize_optional_pivot_text(data_caption, "pivot data caption")?;
        if normalized_name.is_none() && normalized_caption.is_none() {
            return Err(PyValueError::new_err(
                "unsafe_update: pivot metadata update requires name or data_caption",
            ));
        }
        self.pivot_object_for_edit(sheet, object_id)?;
        let (old_name, old_caption, target_path, new_name, new_caption) = {
            let object = self.high_risk_object_mut(sheet, object_id)?;
            let old_name = object.name.clone();
            let old_caption = object.pivot_data_caption.clone();
            if let Some(value) = normalized_name.as_ref() {
                object.name = value.clone();
            }
            if let Some(value) = normalized_caption.as_ref() {
                object.pivot_data_caption = value.clone();
            }
            (
                old_name,
                old_caption,
                object.target_path.clone(),
                object.name.clone(),
                object.pivot_data_caption.clone(),
            )
        };
        self.pivot_dirty_paths.insert(target_path.clone());
        self.audit_events.push(AuditEvent {
            event_type: "pivot_metadata_update".to_string(),
            sheet: sheet.to_string(),
            row: 0,
            col: 0,
            old_value: format!("name={old_name};data_caption={old_caption}"),
            new_value: format!("name={new_name};data_caption={new_caption}"),
            formula: object_id.to_string(),
            reason: format!("{reason}:target={target_path}"),
        });
        Ok(())
    }

    fn apply_replace_ole_object(
        &mut self,
        sheet: &str,
        object_id: &str,
        ole_path: &str,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, 1, 1)?;
        let object = self.ole_object_for_edit(sheet, object_id)?.clone();
        let bytes = std::fs::read(ole_path).map_err(to_py_runtime)?;
        if bytes.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: replacement OLE payload must not be empty",
            ));
        }
        let replacement_extension = file_extension_from_path(ole_path);
        if replacement_extension != object.ole_extension {
            return Err(PyValueError::new_err(format!(
                "unsafe_update: replacement OLE extension must match existing target extension {}",
                object.ole_extension
            )));
        }
        let new_size = bytes.len() as u64;
        {
            let object = self.high_risk_object_mut(sheet, object_id)?;
            object.target_size = new_size;
        }
        self.ole_replacements
            .insert(object.target_path.clone(), bytes);
        self.audit_events.push(AuditEvent {
            event_type: "ole_object_replace".to_string(),
            sheet: sheet.to_string(),
            row: 0,
            col: 0,
            old_value: object.target_path.clone(),
            new_value: ole_path.to_string(),
            formula: object_id.to_string(),
            reason: format!("{reason}:bytes={new_size}"),
        });
        Ok(())
    }

    fn high_risk_object_mut(
        &mut self,
        sheet: &str,
        object_id: &str,
    ) -> PyResult<&mut HighRiskObject> {
        self.high_risk_objects
            .iter_mut()
            .find(|object| object.sheet == sheet && object.object_id == object_id)
            .ok_or_else(|| {
                PyValueError::new_err("high_risk_object_not_found: object_id not found on sheet")
            })
    }

    fn high_risk_object_for_edit(&self, sheet: &str, object_id: &str) -> PyResult<&HighRiskObject> {
        self.high_risk_objects
            .iter()
            .find(|object| object.sheet == sheet && object.object_id == object_id)
            .ok_or_else(|| {
                PyValueError::new_err("high_risk_object_not_found: object_id not found on sheet")
            })
    }

    fn pivot_object_for_edit(&self, sheet: &str, object_id: &str) -> PyResult<&HighRiskObject> {
        let object = self.high_risk_object_for_edit(sheet, object_id)?;
        if object.object_type != "pivot_table" {
            return Err(PyValueError::new_err(
                "unsafe_update: pivot metadata update requires a pivot_table object",
            ));
        }
        if object.target_mode.eq_ignore_ascii_case("External")
            || object.target_path.is_empty()
            || !object.target_exists
        {
            return Err(PyValueError::new_err(
                "unsafe_update: pivot target part is not safely writable",
            ));
        }
        if object.cache_path.is_empty() || !object.cache_exists {
            return Err(PyValueError::new_err(
                "unsafe_update: pivot cache relationship must be valid before metadata write",
            ));
        }
        if !object.invalid_reason.is_empty() {
            return Err(PyValueError::new_err(format!(
                "unsafe_update: pivot object is invalid: {}",
                object.invalid_reason
            )));
        }
        Ok(object)
    }

    fn ole_object_for_edit(&self, sheet: &str, object_id: &str) -> PyResult<&HighRiskObject> {
        let object = self.high_risk_object_for_edit(sheet, object_id)?;
        if object.object_type != "ole_object" {
            return Err(PyValueError::new_err(
                "unsafe_update: OLE replacement requires an ole_object",
            ));
        }
        if object.target_mode.eq_ignore_ascii_case("External")
            || object.target_path.is_empty()
            || !object.target_exists
        {
            return Err(PyValueError::new_err(
                "unsafe_update: OLE target part is not safely replaceable",
            ));
        }
        if object.ole_extension.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: OLE target extension must be known before replacement",
            ));
        }
        if !object.invalid_reason.is_empty() {
            return Err(PyValueError::new_err(format!(
                "unsafe_update: OLE object is invalid: {}",
                object.invalid_reason
            )));
        }
        Ok(object)
    }

    fn drawing_object_mut(&mut self, sheet: &str, object_id: &str) -> PyResult<&mut DrawingObject> {
        self.drawing_objects
            .iter_mut()
            .find(|object| object.sheet == sheet && object.object_id == object_id)
            .ok_or_else(|| PyValueError::new_err("drawing_object: object_id not found on sheet"))
    }

    fn drawing_object_for_edit(&self, sheet: &str, object_id: &str) -> PyResult<&DrawingObject> {
        let object = self
            .drawing_objects
            .iter()
            .find(|object| object.sheet == sheet && object.object_id == object_id)
            .ok_or_else(|| PyValueError::new_err("drawing_object: object_id not found on sheet"))?;
        if !object.relationship_valid {
            return Err(PyValueError::new_err(
                "drawing_relationship_resolution: drawing object relationship is invalid",
            ));
        }
        Ok(object)
    }

    fn chart_object_for_edit(&self, sheet: &str, object_id: &str) -> PyResult<&DrawingObject> {
        let object = self.drawing_object_for_edit(sheet, object_id)?;
        if object.object_type != "chart" {
            return Err(PyValueError::new_err(
                "unsafe_update: chart operation requires a chart drawing object",
            ));
        }
        if object.target_path.is_empty() || !object.target_exists {
            return Err(PyValueError::new_err(
                "drawing_relationship_resolution: chart target part is missing",
            ));
        }
        Ok(object)
    }

    fn apply_comment_with_reason(
        &mut self,
        sheet: &str,
        row: usize,
        col: usize,
        text: &str,
        remove: bool,
        reason: &str,
    ) -> PyResult<()> {
        self.validate_cell_target(sheet, row, col)?;
        let key = Key {
            sheet: sheet.to_string(),
            row,
            col,
        };
        let old_value = self
            .comments
            .iter()
            .find(|comment| comment.key == key)
            .map(|comment| comment.text.clone())
            .unwrap_or_default();
        if remove {
            self.comments.retain(|comment| comment.key != key);
        } else {
            if text.trim().is_empty() {
                return Err(PyValueError::new_err(
                    "unsafe_update: comment text must not be empty",
                ));
            }
            if let Some(comment) = self.comments.iter_mut().find(|comment| comment.key == key) {
                comment.text = text.to_string();
            } else {
                self.comments.push(CellComment {
                    key: key.clone(),
                    text: text.to_string(),
                });
            }
        }
        self.comment_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "comment_update",
            sheet,
            row,
            col,
            &old_value,
            if remove { "" } else { text },
            reason,
        ));
        Ok(())
    }

    fn apply_data_validation_with_reason(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
        reason: &str,
    ) -> PyResult<()> {
        let range = self.validated_object_range(sheet, start_row, start_col, end_row, end_col)?;
        let validation_type = optional_enum(
            &rule,
            "type",
            &[
                "whole",
                "decimal",
                "list",
                "date",
                "time",
                "textLength",
                "custom",
            ],
        )?
        .unwrap_or_else(|| "list".to_string());
        let operator = optional_enum(
            &rule,
            "operator",
            &[
                "between",
                "notBetween",
                "equal",
                "notEqual",
                "greaterThan",
                "lessThan",
                "greaterThanOrEqual",
                "lessThanOrEqual",
            ],
        )?
        .unwrap_or_default();
        let formula1 = optional_nonempty(&rule, "formula1").unwrap_or_default();
        let formula2 = optional_nonempty(&rule, "formula2").unwrap_or_default();
        let allow_blank = optional_bool(&rule, "allow_blank")?.unwrap_or(true);
        if formula1.is_empty() && validation_type != "custom" {
            return Err(PyValueError::new_err(
                "unsafe_update: data validation requires formula1",
            ));
        }
        self.data_validations.retain(|existing| {
            existing.range.sheet != sheet || existing.range.ref_text() != range.ref_text()
        });
        self.data_validations.push(DataValidationRule {
            range: range.clone(),
            validation_type,
            operator,
            formula1,
            formula2,
            allow_blank,
        });
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "data_validation_update",
            sheet,
            start_row,
            start_col,
            "",
            &range.ref_text(),
            reason,
        ));
        Ok(())
    }

    fn apply_autofilter_with_reason(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        reason: &str,
    ) -> PyResult<()> {
        let range = self.validated_object_range(sheet, start_row, start_col, end_row, end_col)?;
        self.auto_filters.retain(|rule| rule.range.sheet != sheet);
        self.auto_filters.push(AutoFilterRule {
            range: range.clone(),
        });
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "autofilter_update",
            sheet,
            start_row,
            start_col,
            "",
            &range.ref_text(),
            reason,
        ));
        Ok(())
    }

    fn apply_conditional_format_with_reason(
        &mut self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
        rule: HashMap<String, String>,
        reason: &str,
    ) -> PyResult<()> {
        let range = self.validated_object_range(sheet, start_row, start_col, end_row, end_col)?;
        let rule_type = optional_enum(
            &rule,
            "type",
            &[
                "cellIs",
                "expression",
                "containsText",
                "top10",
                "aboveAverage",
            ],
        )?
        .unwrap_or_else(|| "cellIs".to_string());
        let operator = optional_enum(
            &rule,
            "operator",
            &[
                "between",
                "notBetween",
                "equal",
                "notEqual",
                "greaterThan",
                "lessThan",
                "greaterThanOrEqual",
                "lessThanOrEqual",
                "containsText",
            ],
        )?
        .unwrap_or_default();
        let formula = optional_nonempty(&rule, "formula").unwrap_or_default();
        if formula.is_empty() {
            return Err(PyValueError::new_err(
                "unsafe_update: conditional format requires formula",
            ));
        }
        let priority = self
            .conditional_formats
            .iter()
            .filter(|item| item.range.sheet == sheet)
            .map(|item| item.priority)
            .max()
            .unwrap_or(0)
            + 1;
        self.conditional_formats.push(ConditionalFormatRule {
            range: range.clone(),
            rule_type,
            operator,
            formula,
            priority,
        });
        self.object_dirty_sheets.insert(sheet.to_string());
        self.audit_events.push(object_audit_event(
            "conditional_format_update",
            sheet,
            start_row,
            start_col,
            "",
            &range.ref_text(),
            reason,
        ));
        Ok(())
    }

    fn validated_object_range(
        &self,
        sheet: &str,
        start_row: usize,
        start_col: usize,
        end_row: usize,
        end_col: usize,
    ) -> PyResult<ObjectRange> {
        self.validate_cell_target(sheet, start_row, start_col)?;
        self.validate_cell_target(sheet, end_row, end_col)?;
        Ok(ObjectRange {
            sheet: sheet.to_string(),
            start_row: start_row.min(end_row),
            start_col: start_col.min(end_col),
            end_row: start_row.max(end_row),
            end_col: start_col.max(end_col),
        })
    }

    fn object_inventory_for_sheet(&self, sheet: &str) -> Vec<HashMap<String, String>> {
        let mut out = Vec::new();
        for comment in self
            .comments
            .iter()
            .filter(|comment| comment.key.sheet == sheet)
        {
            out.push(HashMap::from([
                ("object_type".to_string(), "comment".to_string()),
                ("sheet".to_string(), sheet.to_string()),
                (
                    "ref".to_string(),
                    format!("{}{}", col_to_name(comment.key.col), comment.key.row),
                ),
                ("value".to_string(), comment.text.clone()),
            ]));
        }
        for rule in self
            .data_validations
            .iter()
            .filter(|rule| rule.range.sheet == sheet)
        {
            out.push(HashMap::from([
                ("object_type".to_string(), "data_validation".to_string()),
                ("sheet".to_string(), sheet.to_string()),
                ("ref".to_string(), rule.range.ref_text()),
                ("value".to_string(), rule.validation_type.clone()),
            ]));
        }
        for rule in self
            .auto_filters
            .iter()
            .filter(|rule| rule.range.sheet == sheet)
        {
            out.push(HashMap::from([
                ("object_type".to_string(), "autofilter".to_string()),
                ("sheet".to_string(), sheet.to_string()),
                ("ref".to_string(), rule.range.ref_text()),
                ("value".to_string(), String::new()),
            ]));
        }
        for rule in self
            .conditional_formats
            .iter()
            .filter(|rule| rule.range.sheet == sheet)
        {
            out.push(HashMap::from([
                ("object_type".to_string(), "conditional_format".to_string()),
                ("sheet".to_string(), sheet.to_string()),
                ("ref".to_string(), rule.range.ref_text()),
                ("value".to_string(), rule.rule_type.clone()),
            ]));
        }
        out
    }

    fn drawing_inventory_for_sheet(&self, sheet: &str) -> Vec<HashMap<String, String>> {
        self.drawing_objects
            .iter()
            .filter(|object| object.sheet == sheet)
            .map(drawing_object_to_map)
            .collect()
    }

    fn drawing_diagnostics_for_sheet(&self, sheet: &str) -> Vec<HashMap<String, String>> {
        let mut diagnostics = Vec::new();
        for object in self
            .drawing_objects
            .iter()
            .filter(|object| object.sheet == sheet)
        {
            if !object.relationship_valid {
                diagnostics.push(drawing_diagnostic(
                    object,
                    "missing_drawing_relationship",
                    "drawing_relationship_resolution",
                    "Drawing object references a relationship id that is missing from the drawing rels part.",
                ));
            }
            if object.relationship_valid && !object.target_path.is_empty() && !object.target_exists
            {
                diagnostics.push(drawing_diagnostic(
                    object,
                    "missing_drawing_target_part",
                    "drawing_target_validation",
                    "Drawing relationship target part is missing from the workbook package.",
                ));
            }
            if !object.invalid_reason.is_empty() {
                diagnostics.push(drawing_diagnostic(
                    object,
                    &object.invalid_reason,
                    "drawing_anchor_follow",
                    "Drawing anchor could not be safely followed through a structure edit.",
                ));
            }
        }
        diagnostics
    }

    fn high_risk_inventory_for_sheet(&self, sheet: &str) -> Vec<HashMap<String, String>> {
        self.high_risk_objects
            .iter()
            .filter(|object| object.sheet == sheet)
            .map(high_risk_object_to_map)
            .collect()
    }

    fn high_risk_diagnostics_for_sheet(&self, sheet: &str) -> Vec<HashMap<String, String>> {
        let mut diagnostics = Vec::new();
        for object in self
            .high_risk_objects
            .iter()
            .filter(|object| object.sheet == sheet)
        {
            if !object.relationship_valid {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    "missing_high_risk_relationship",
                    "high_risk_relationship_resolution",
                    "High-risk object relationship is missing or invalid.",
                ));
            }
            if object.relationship_valid && !object.target_path.is_empty() && !object.target_exists
            {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    "missing_high_risk_target_part",
                    "high_risk_target_validation",
                    "High-risk object target part is missing from the workbook package.",
                ));
            }
            if object.object_type == "pivot_table" && object.cache_path.is_empty() {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    "missing_pivot_cache_definition_relationship",
                    "pivot_cache_validation",
                    "Pivot table has no readable pivot cache definition relationship.",
                ));
            }
            if object.object_type == "pivot_table"
                && !object.cache_path.is_empty()
                && !object.cache_exists
            {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    "missing_pivot_cache_definition_part",
                    "pivot_cache_validation",
                    "Pivot cache definition target part is missing from the workbook package.",
                ));
            }
            if object.object_type == "sparkline" && object.source_formula.is_empty() {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    "missing_sparkline_source_formula",
                    "sparkline_source_validation",
                    "Sparkline source formula could not be read safely.",
                ));
            }
            if !object.invalid_reason.is_empty() {
                diagnostics.push(high_risk_diagnostic(
                    object,
                    &object.invalid_reason,
                    "high_risk_object_validation",
                    "High-risk object has an explicit validation boundary.",
                ));
            }
        }
        diagnostics
    }

    fn high_risk_status_for_sheet(&self, sheet: &str) -> HashMap<String, String> {
        let objects = self
            .high_risk_objects
            .iter()
            .filter(|object| object.sheet == sheet)
            .collect::<Vec<_>>();
        let diagnostics = self.high_risk_diagnostics_for_sheet(sheet);
        let mut pivot_count = 0usize;
        let mut sparkline_count = 0usize;
        let mut ole_count = 0usize;
        for object in &objects {
            match object.object_type.as_str() {
                "pivot_table" => pivot_count += 1,
                "sparkline" => sparkline_count += 1,
                "ole_object" => ole_count += 1,
                _ => {}
            }
        }
        let not_completed = unique_sorted_values(
            diagnostics
                .iter()
                .filter_map(|item| item.get("not_completed").cloned())
                .collect(),
        );
        let status = if objects.is_empty() {
            "empty"
        } else if diagnostics.is_empty() {
            "ready"
        } else {
            "warning"
        };
        let write_supported = objects
            .iter()
            .any(|object| high_risk_write_supported(object));
        let mutation_status = high_risk_sheet_mutation_status(&objects);
        HashMap::from([
            ("sheet".to_string(), sheet.to_string()),
            ("object_count".to_string(), objects.len().to_string()),
            ("pivot_table_count".to_string(), pivot_count.to_string()),
            ("sparkline_count".to_string(), sparkline_count.to_string()),
            ("ole_object_count".to_string(), ole_count.to_string()),
            (
                "diagnostic_count".to_string(),
                diagnostics.len().to_string(),
            ),
            ("status".to_string(), status.to_string()),
            ("read_supported".to_string(), "true".to_string()),
            ("write_supported".to_string(), write_supported.to_string()),
            ("mutation_status".to_string(), mutation_status.to_string()),
            ("not_completed".to_string(), not_completed.join(",")),
        ])
    }

    fn high_risk_read_for_object(
        &self,
        sheet: &str,
        object_id: &str,
    ) -> PyResult<HashMap<String, String>> {
        let Some(object) = self
            .high_risk_objects
            .iter()
            .find(|object| object.sheet == sheet && object.object_id == object_id)
        else {
            return Err(PyValueError::new_err(format!(
                "high_risk_object_not_found: {object_id}"
            )));
        };
        let diagnostics = self
            .high_risk_diagnostics_for_sheet(sheet)
            .into_iter()
            .filter(|item| {
                item.get("object_id")
                    .is_some_and(|value| value == object_id)
            })
            .collect::<Vec<_>>();
        let codes = unique_sorted_values(
            diagnostics
                .iter()
                .filter_map(|item| item.get("code").cloned())
                .collect(),
        );
        let not_completed = unique_sorted_values(
            diagnostics
                .iter()
                .filter_map(|item| item.get("not_completed").cloned())
                .collect(),
        );
        let mut item = high_risk_object_to_map(object);
        item.insert("read_supported".to_string(), "true".to_string());
        item.insert(
            "read_status".to_string(),
            if diagnostics.is_empty() {
                "ready".to_string()
            } else {
                "warning".to_string()
            },
        );
        item.insert(
            "diagnostic_count".to_string(),
            diagnostics.len().to_string(),
        );
        item.insert("diagnostic_codes".to_string(), codes.join(","));
        item.insert("not_completed".to_string(), not_completed.join(","));
        Ok(item)
    }

    fn comment_part_paths(&self) -> HashMap<String, String> {
        let mut mapping = HashMap::new();
        for (idx, sheet) in self.sheets.iter().enumerate() {
            if self.comment_dirty_sheets.contains(&sheet.name) {
                mapping.insert(
                    sheet.name.clone(),
                    format!("xl/comments/comment{}.xml", idx + 1),
                );
            }
        }
        mapping
    }

    fn rewrite_formulas_for_structure(&mut self, edit: &StructureEdit) {
        for (key, formula) in self.formulas.iter_mut() {
            let rewritten = rewrite_formula_structure_refs(&formula.formula, &key.sheet, edit);
            if rewritten != formula.formula {
                formula.formula = rewritten;
                self.modified.insert(key.clone());
            }
        }
        for (key, meta) in self.meta.iter_mut() {
            if meta.original_formula.is_empty() {
                continue;
            }
            let rewritten =
                rewrite_formula_structure_refs(&meta.original_formula, &key.sheet, edit);
            if rewritten != meta.original_formula {
                meta.original_formula = rewritten;
                meta.is_modified = true;
                self.modified.insert(key.clone());
            }
        }
    }

    fn recalculate_all_formulas(&mut self, reason: &str) -> PyResult<()> {
        let mut formula_keys = self.formulas.keys().cloned().collect::<Vec<_>>();
        formula_keys.sort_by_key(|key| (key.sheet.clone(), key.row, key.col));
        for key in formula_keys {
            let old_value = self.cells.get(&key).cloned().unwrap_or_default();
            let Ok(new_value) = self.evaluate_formula_cell(&key) else {
                continue;
            };
            if normalized_number(&old_value) == normalized_number(&new_value) {
                continue;
            }
            self.cells.insert(key.clone(), new_value.clone());
            self.dirty.insert(key.clone());
            let formula = self
                .formulas
                .get(&key)
                .map(|formula| formula.formula.clone())
                .unwrap_or_default();
            let meta = self.ensure_meta_record(&key);
            meta.cached_value_after = new_value.clone();
            meta.is_dirty = true;
            self.audit_events.push(AuditEvent {
                event_type: "formula_recalc".to_string(),
                sheet: key.sheet.clone(),
                row: key.row,
                col: key.col,
                old_value,
                new_value,
                formula,
                reason: reason.to_string(),
            });
        }
        Ok(())
    }

    fn validate_cell_target(&self, sheet: &str, row: usize, col: usize) -> PyResult<()> {
        if row == 0 || col == 0 {
            return Err(PyValueError::new_err(
                "invalid_cell_ref: row and col must be positive",
            ));
        }
        if !self.sheets.iter().any(|item| item.name == sheet) {
            return Err(PyValueError::new_err(format!("unknown_sheet: {sheet}")));
        }
        Ok(())
    }

    fn rename_keyed_state(&mut self, old_name: &str, new_name: &str) {
        self.cells = rename_key_map(std::mem::take(&mut self.cells), old_name, new_name);
        self.formulas = rename_key_map(std::mem::take(&mut self.formulas), old_name, new_name);
        self.meta = rename_key_map(std::mem::take(&mut self.meta), old_name, new_name);
        self.modified = rename_key_set(std::mem::take(&mut self.modified), old_name, new_name);
        self.dirty = rename_key_set(std::mem::take(&mut self.dirty), old_name, new_name);
        if let Some(ranges) = self.merges.remove(old_name) {
            self.merges.insert(new_name.to_string(), ranges);
        }
        if self.merge_dirty_sheets.remove(old_name) {
            self.merge_dirty_sheets.insert(new_name.to_string());
        }
        for patch in &mut self.style_patches {
            if patch.key.sheet == old_name {
                patch.key.sheet = new_name.to_string();
            }
        }
        for meta in self.meta.values_mut() {
            if meta.sheet_name == old_name {
                meta.sheet_name = new_name.to_string();
            }
        }
        for name in &mut self.defined_names {
            if name.scope_sheet.as_deref() == Some(old_name) {
                name.scope_sheet = Some(new_name.to_string());
            }
        }
    }

    fn rewrite_formula_sheet_refs(&mut self, old_name: &str, new_name: &str) {
        for (key, formula) in self.formulas.iter_mut() {
            let rewritten = rewrite_formula_sheet_ref(&formula.formula, old_name, new_name);
            if rewritten != formula.formula {
                formula.formula = rewritten;
                self.modified.insert(key.clone());
            }
        }
        for (key, meta) in self.meta.iter_mut() {
            if !meta.original_formula.is_empty() {
                let rewritten =
                    rewrite_formula_sheet_ref(&meta.original_formula, old_name, new_name);
                if rewritten != meta.original_formula {
                    meta.original_formula = rewritten;
                    meta.is_modified = true;
                    self.modified.insert(key.clone());
                }
            }
        }
    }

    fn ensure_meta_record(&mut self, key: &Key) -> &mut ShadowMetaRecord {
        self.meta
            .entry(key.clone())
            .or_insert_with(|| ShadowMetaRecord {
                sheet_name: key.sheet.clone(),
                row_idx: key.row,
                col_idx: key.col,
                cell_type: "blank".to_string(),
                style_id: None,
                number_format: String::new(),
                original_formula: String::new(),
                cached_value_before: String::new(),
                cached_value_after: String::new(),
                merge_range: String::new(),
                is_modified: false,
                is_dirty: false,
            })
    }

    fn rebuild_formula_deps(&mut self) {
        let sheet_order: Vec<String> = self.sheets.iter().map(|sheet| sheet.name.clone()).collect();
        let formula_keys: HashSet<Key> = self.formulas.keys().cloned().collect();
        let formulas: Vec<(Key, String)> = self
            .formulas
            .iter()
            .map(|(key, formula)| (key.clone(), formula.formula.clone()))
            .collect();

        for (key, formula_text) in formulas {
            if let Some(formula) = self.formulas.get_mut(&key) {
                formula.deps = extract_deps(
                    &formula_text,
                    &key,
                    &self.cells,
                    &sheet_order,
                    &self.defined_names,
                    &formula_keys,
                    &self.tables,
                );
            }
        }
    }

    fn rebuild_dependents(&mut self) {
        self.dependents.clear();
        for (formula_key, formula) in &self.formulas {
            for dep in &formula.deps {
                self.dependents
                    .entry(dep.clone())
                    .or_default()
                    .insert(formula_key.clone());
            }
        }
    }

    fn evaluate_formula_cell(&self, key: &Key) -> PyResult<String> {
        let formula = self
            .formulas
            .get(key)
            .ok_or_else(|| PyValueError::new_err("formula cell not found"))?;
        let backend = RustMvpFormulaBackend;
        backend.evaluate_formula(&formula.formula, &key.sheet, &self.cells)
    }

    fn sheet_table_map(&self) -> HashMap<String, String> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut mapping = HashMap::new();

        for sheet in &self.sheets {
            let base = sqlite_table_name(&sheet.name);
            let count = counts.entry(base.clone()).or_insert(0);
            let table_name = if *count == 0 {
                base.clone()
            } else {
                format!("{}_{}", base, *count + 1)
            };
            *count += 1;
            mapping.insert(sheet.name.clone(), table_name);
        }

        mapping
    }

    fn build_sqlite_projection(
        &self,
    ) -> PyResult<(
        Connection,
        HashMap<String, String>,
        Rc<RefCell<Vec<PendingSqliteUpdate>>>,
    )> {
        let conn = Connection::open_in_memory().map_err(to_py_runtime)?;
        let table_map = self.sheet_table_map();
        let pending_updates = Rc::new(RefCell::new(Vec::new()));

        for sheet in &self.sheets {
            let table_name = table_map
                .get(&sheet.name)
                .ok_or_else(|| PyRuntimeError::new_err("missing SQLite table mapping"))?;
            let module_name = format!("shadow_rows_{}", table_name);
            let data = self.sheet_vtab_data(&sheet.name, pending_updates.clone());
            conn.create_module::<SheetRowsVTab>(
                &module_name,
                update_module::<SheetRowsVTab>(),
                Some(data),
            )
            .map_err(to_py_runtime)?;
            let create_sql = format!(
                "CREATE VIRTUAL TABLE {} USING {}",
                sqlite_quote_ident(table_name),
                sqlite_quote_ident(&module_name)
            );
            conn.execute(&create_sql, []).map_err(to_py_runtime)?;
        }

        Ok((conn, table_map, pending_updates))
    }

    fn sheet_vtab_data(
        &self,
        sheet_name: &str,
        pending_updates: Rc<RefCell<Vec<PendingSqliteUpdate>>>,
    ) -> SheetRowsVTabData {
        let (max_row, max_col) = self.sheet_bounds(sheet_name);
        let max_col = max_col.max(1);
        let columns = (1..=max_col).map(col_to_name).collect::<Vec<_>>();
        let mut rows = Vec::new();

        for row in 1..=max_row {
            let mut values = Vec::new();
            for col in 1..=max_col {
                values.push(
                    self.cells
                        .get(&Key {
                            sheet: sheet_name.to_string(),
                            row,
                            col,
                        })
                        .cloned()
                        .unwrap_or_default(),
                );
            }
            rows.push(values);
        }

        SheetRowsVTabData {
            sheet_name: sheet_name.to_string(),
            columns,
            rows,
            pending_updates,
        }
    }

    fn sheet_bounds(&self, sheet_name: &str) -> (usize, usize) {
        let mut max_row = 0usize;
        let mut max_col = 0usize;
        for key in self.cells.keys().filter(|key| key.sheet == sheet_name) {
            max_row = max_row.max(key.row);
            max_col = max_col.max(key.col);
        }
        (max_row, max_col)
    }

    fn patch_sheet_xml(
        &self,
        sheet_name: &str,
        xml: &str,
        shared_string_plan: &SharedStringPatchPlan,
    ) -> PyResult<String> {
        let mut patched = if self.structural_dirty_sheets.contains(sheet_name) {
            patch_worksheet_structure_xml(xml, sheet_name, &self.structural_edits)?
        } else {
            xml.to_string()
        };
        let mut changed_keys: Vec<Key> = self
            .modified
            .iter()
            .chain(self.dirty.iter())
            .filter(|key| key.sheet == sheet_name)
            .cloned()
            .collect();
        changed_keys.sort_by_key(|key| (key.row, key.col));
        changed_keys.dedup();

        for key in changed_keys {
            let cell_ref = format!("{}{}", col_to_name(key.col), key.row);
            let value = self.cells.get(&key).cloned().unwrap_or_default();
            let formula = self.formulas.get(&key).map(|cell| cell.formula.as_str());
            let shared_string_index = shared_string_plan.cell_indices.get(&key).copied();
            let force_inline_string = self
                .meta
                .get(&key)
                .map(|meta| infer_semantic_type(meta) == "string")
                .unwrap_or(false);
            let style_id = self.meta.get(&key).and_then(|meta| meta.style_id);
            patched = patch_cell(
                &patched,
                &cell_ref,
                key.row,
                key.col,
                &value,
                formula,
                shared_string_index,
                force_inline_string,
                style_id,
            )?;
        }

        if self.object_dirty_sheets.contains(sheet_name)
            || self.structural_dirty_sheets.contains(sheet_name)
        {
            patched = patch_sheet_objects_xml(
                &patched,
                sheet_name,
                &self.data_validations,
                &self.auto_filters,
                &self.conditional_formats,
            )?;
        }

        if self.sparkline_dirty_sheets.contains(sheet_name) {
            patched = patch_sparkline_source_xml(
                &patched,
                sheet_name,
                &self.high_risk_objects,
                &self.sparkline_dirty_objects,
            )?;
        }

        if self.merge_dirty_sheets.contains(sheet_name) {
            patch_merge_cells_xml(
                &patched,
                self.merges
                    .get(sheet_name)
                    .cloned()
                    .unwrap_or_else(HashSet::new),
            )
        } else {
            Ok(patched)
        }
    }

    fn build_shared_string_patch_plan(
        &self,
        source_path: &PathBuf,
        policy: SharedStringPolicy,
    ) -> PyResult<SharedStringPatchPlan> {
        let mut plan = SharedStringPatchPlan {
            updates: HashMap::new(),
            cell_indices: HashMap::new(),
        };
        if policy == SharedStringPolicy::Preserve {
            return Ok(plan);
        }

        let source_file = File::open(source_path).map_err(to_py_runtime)?;
        let mut archive = ZipArchive::new(source_file).map_err(to_py_runtime)?;
        let mut usage: HashMap<usize, usize> = HashMap::new();
        let mut refs: HashMap<Key, usize> = HashMap::new();

        for sheet in &self.sheets {
            let xml = read_zip_text(&mut archive, &sheet.path)?;
            collect_shared_string_refs(&sheet.name, &xml, &mut usage, &mut refs)?;
        }

        for key in self.modified.iter().chain(self.dirty.iter()) {
            if self.formulas.contains_key(key) {
                continue;
            }
            let Some(index) = refs.get(key).copied() else {
                continue;
            };
            let value = self.cells.get(key).cloned().unwrap_or_default();
            let force_string = self
                .meta
                .get(key)
                .map(|meta| infer_semantic_type(meta) == "string")
                .unwrap_or(false);
            if value.parse::<f64>().is_ok() && !force_string {
                continue;
            }
            let use_count = usage.get(&index).copied().unwrap_or(0);
            if use_count == 1 {
                plan.updates.insert(index, value);
                plan.cell_indices.insert(key.clone(), index);
            } else if policy == SharedStringPolicy::UpdateUnique {
                return Err(PyValueError::new_err(format!(
                    "shared_string_policy: shared string index {index} is referenced by {use_count} cells"
                )));
            }
        }

        Ok(plan)
    }

    fn persist_sqlite_snapshot(&self, sqlite_path: &str) -> PyResult<HashMap<String, String>> {
        let mut conn = Connection::open(sqlite_path).map_err(to_py_runtime)?;
        create_snapshot_schema(&conn)?;
        let old_view_names = store_sheet_view_names(&conn)?;
        let tx = conn.transaction().map_err(to_py_runtime)?;
        for view_name in old_view_names {
            tx.execute(
                &format!("DROP VIEW IF EXISTS {}", sqlite_quote_ident(&view_name)),
                [],
            )
            .map_err(to_py_runtime)?;
        }
        tx.execute_batch(
            "
            DELETE FROM ss_graph_edge;
            DELETE FROM ss_graph_node;
            DELETE FROM ss_formula_edge;
            DELETE FROM ss_audit_event;
            DELETE FROM ss_shadow_meta;
            DELETE FROM ss_cell_snapshot;
            DELETE FROM ss_sheet;
            DELETE FROM ss_session;
            DELETE FROM ss_workbook;
            INSERT OR REPLACE INTO ss_migration(version, name) VALUES (1, 'phase7_runtime_audit_graph_snapshot');
            ",
        )
        .map_err(to_py_runtime)?;

        let source_path = self
            .source_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        tx.execute(
            "INSERT INTO ss_workbook(id, source_path, sheet_count, cell_count, formula_count)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![
                source_path,
                self.sheets.len() as i64,
                self.cells.len() as i64,
                self.formulas.len() as i64
            ],
        )
        .map_err(to_py_runtime)?;
        tx.execute(
            "INSERT INTO ss_session(id, workbook_id, state, modified_count, dirty_count)
             VALUES ('active', 1, 'snapshot', ?1, ?2)",
            params![self.modified.len() as i64, self.dirty.len() as i64],
        )
        .map_err(to_py_runtime)?;

        insert_graph_node(&tx, "workbook", "1", "workbook")?;
        let table_map = self.sheet_table_map();
        for (idx, sheet) in self.sheets.iter().enumerate() {
            let table_name = table_map
                .get(&sheet.name)
                .ok_or_else(|| PyRuntimeError::new_err("missing SQLite store table mapping"))?;
            tx.execute(
                "INSERT INTO ss_sheet(workbook_id, sheet_index, name, path, table_name) VALUES (1, ?1, ?2, ?3, ?4)",
                params![idx as i64, sheet.name, sheet.path, table_name],
            )
            .map_err(to_py_runtime)?;
            let sheet_id = graph_sheet_id(&sheet.name);
            insert_graph_node(&tx, "sheet", &sheet_id, &sheet.name)?;
            insert_graph_edge(&tx, "workbook", "1", "sheet", &sheet_id, "contains")?;
        }

        let mut cell_items: Vec<(&Key, &String)> = self.cells.iter().collect();
        cell_items.sort_by_key(|(key, _)| (key.sheet.clone(), key.row, key.col));
        for (key, value) in cell_items {
            let is_formula = self.formulas.contains_key(key);
            tx.execute(
                "INSERT INTO ss_cell_snapshot(workbook_id, sheet, row_idx, col_idx, value, is_formula)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                params![key.sheet, key.row as i64, key.col as i64, value, is_formula as i64],
            )
            .map_err(to_py_runtime)?;
            let cell_id = graph_cell_id(key);
            insert_graph_node(&tx, "cell", &cell_id, &cell_id)?;
            insert_graph_edge(
                &tx,
                "sheet",
                &graph_sheet_id(&key.sheet),
                "cell",
                &cell_id,
                "contains",
            )?;
        }

        let mut meta_items: Vec<(&Key, &ShadowMetaRecord)> = self.meta.iter().collect();
        meta_items.sort_by_key(|(key, _)| (key.sheet.clone(), key.row, key.col));
        for (key, meta) in meta_items {
            tx.execute(
                "INSERT INTO ss_shadow_meta(
                    workbook_id, sheet, row_idx, col_idx, cell_type, style_id, number_format,
                    original_formula, cached_value_before, cached_value_after, merge_range,
                    is_modified, is_dirty
                 ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    key.sheet,
                    key.row as i64,
                    key.col as i64,
                    meta.cell_type,
                    meta.style_id.map(|value| value as i64),
                    meta.number_format,
                    meta.original_formula,
                    meta.cached_value_before,
                    meta.cached_value_after,
                    meta.merge_range,
                    meta.is_modified as i64,
                    meta.is_dirty as i64,
                ],
            )
            .map_err(to_py_runtime)?;
        }

        for (idx, event) in self.audit_events.iter().enumerate() {
            tx.execute(
                "INSERT INTO ss_audit_event(
                    id, workbook_id, event_type, sheet, row_idx, col_idx, old_value, new_value,
                    formula, reason
                 ) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    idx as i64 + 1,
                    event.event_type,
                    event.sheet,
                    event.row as i64,
                    event.col as i64,
                    event.old_value,
                    event.new_value,
                    event.formula,
                    event.reason,
                ],
            )
            .map_err(to_py_runtime)?;
            let audit_id = format!("audit:{}", idx + 1);
            insert_graph_node(&tx, "audit_event", &audit_id, &event.event_type)?;
            insert_graph_edge(
                &tx,
                "cell",
                &graph_cell_id(&Key {
                    sheet: event.sheet.clone(),
                    row: event.row,
                    col: event.col,
                }),
                "audit_event",
                &audit_id,
                "modified_by",
            )?;
        }

        let mut formulas: Vec<(&Key, &FormulaCell)> = self.formulas.iter().collect();
        formulas.sort_by_key(|(key, _)| (key.sheet.clone(), key.row, key.col));
        for (formula_key, formula) in formulas {
            let formula_id = graph_cell_id(formula_key);
            insert_graph_node(&tx, "formula", &formula_id, &formula.formula)?;
            insert_graph_edge(&tx, "cell", &formula_id, "formula", &formula_id, "contains")?;
            let mut deps: Vec<&Key> = formula.deps.iter().collect();
            deps.sort_by_key(|key| (key.sheet.clone(), key.row, key.col));
            for dep in deps {
                tx.execute(
                    "INSERT INTO ss_formula_edge(
                        workbook_id, formula_sheet, formula_row, formula_col,
                        precedent_sheet, precedent_row, precedent_col
                     ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        formula_key.sheet,
                        formula_key.row as i64,
                        formula_key.col as i64,
                        dep.sheet,
                        dep.row as i64,
                        dep.col as i64,
                    ],
                )
                .map_err(to_py_runtime)?;
                insert_graph_edge(
                    &tx,
                    "formula",
                    &formula_id,
                    "cell",
                    &graph_cell_id(dep),
                    "depends_on",
                )?;
            }
        }

        create_store_sheet_views(&tx, self, &table_map)?;
        tx.commit().map_err(to_py_runtime)?;
        Ok(HashMap::from([
            ("sqlite_path".to_string(), sqlite_path.to_string()),
            ("workbook_count".to_string(), "1".to_string()),
            ("sheet_count".to_string(), self.sheets.len().to_string()),
            ("cell_count".to_string(), self.cells.len().to_string()),
            ("meta_count".to_string(), self.meta.len().to_string()),
            (
                "audit_event_count".to_string(),
                self.audit_events.len().to_string(),
            ),
            ("formula_count".to_string(), self.formulas.len().to_string()),
        ]))
    }
}

fn open_zip(file_path: &str) -> PyResult<ZipArchive<File>> {
    let file = File::open(file_path).map_err(to_py_runtime)?;
    ZipArchive::new(file).map_err(to_py_runtime)
}

fn read_zip_text<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> PyResult<String> {
    let mut file = archive.by_name(name).map_err(to_py_runtime)?;
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(to_py_runtime)?;
    Ok(text)
}

fn zip_entry_names<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> PyResult<HashSet<String>> {
    let mut names = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(to_py_runtime)?;
        names.insert(entry.name().to_string());
    }
    Ok(names)
}

fn zip_entry_sizes<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> PyResult<HashMap<String, u64>> {
    let mut sizes = HashMap::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(to_py_runtime)?;
        sizes.insert(entry.name().to_string(), entry.size());
    }
    Ok(sizes)
}

fn read_shared_strings<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> PyResult<Vec<String>> {
    let Ok(xml) = read_zip_text(archive, "xl/sharedStrings.xml") else {
        return Ok(Vec::new());
    };
    let doc = Document::parse(&xml).map_err(to_py_runtime)?;
    let mut values = Vec::new();

    for si in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "si")
    {
        let mut value = String::new();
        for t in si
            .descendants()
            .filter(|node| node.tag_name().name() == "t")
        {
            value.push_str(t.text().unwrap_or(""));
        }
        values.push(value);
    }

    Ok(values)
}

fn read_style_info<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> PyResult<HashMap<u32, String>> {
    let Ok(xml) = read_zip_text(archive, "xl/styles.xml") else {
        return Ok(HashMap::new());
    };
    let doc = Document::parse(&xml).map_err(to_py_runtime)?;
    let mut custom_formats = HashMap::new();

    for num_fmt in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "numFmt")
    {
        if let (Some(id), Some(code)) = (
            num_fmt
                .attribute("numFmtId")
                .and_then(|value| value.parse::<u32>().ok()),
            num_fmt.attribute("formatCode"),
        ) {
            custom_formats.insert(id, code.to_string());
        }
    }

    let mut style_info = HashMap::new();
    let Some(cell_xfs) = doc
        .descendants()
        .find(|node| node.tag_name().name() == "cellXfs")
    else {
        return Ok(style_info);
    };

    for (idx, xf) in cell_xfs
        .children()
        .filter(|node| node.tag_name().name() == "xf")
        .enumerate()
    {
        let number_format = xf
            .attribute("numFmtId")
            .and_then(|value| value.parse::<u32>().ok())
            .map(|id| {
                custom_formats
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| builtin_number_format(id).to_string())
            })
            .unwrap_or_default();
        style_info.insert(idx as u32, number_format);
    }

    Ok(style_info)
}

fn builtin_number_format(id: u32) -> &'static str {
    match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        14 => "mm-dd-yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        49 => "@",
        _ => "",
    }
}

#[derive(Clone, Debug)]
struct StyleBase {
    num_fmt_id: u32,
    font_id: u32,
    fill_id: u32,
    border_id: u32,
    xf_id: u32,
}

fn patch_styles_xml(xml: &str, patches: &[StylePatch]) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut font_snippets = Vec::new();
    let mut fill_snippets = Vec::new();
    let mut xf_snippets = Vec::new();
    let mut num_fmt_snippets = Vec::new();

    let mut next_font_id = collection_count(xml, "fonts");
    let mut next_fill_id = collection_count(xml, "fills");
    let mut next_num_fmt_id = max_num_fmt_id(&doc).max(163) + 1;

    for patch in patches {
        let base = style_base_from_doc(&doc, patch.base_style_id)?;
        let num_fmt_id = if let Some(format_code) = &patch.intent.number_format {
            let id = next_num_fmt_id;
            next_num_fmt_id += 1;
            num_fmt_snippets.push(format!(
                "<x:numFmt numFmtId=\"{id}\" formatCode=\"{}\" />",
                xml_escape(format_code)
            ));
            id
        } else {
            base.num_fmt_id
        };
        let font_id = if patch.intent.has_font_changes() {
            let id = next_font_id;
            next_font_id += 1;
            font_snippets.push(format_font_xml(&patch.intent));
            id
        } else {
            base.font_id
        };
        let fill_id = if patch.intent.has_fill_changes() {
            let id = next_fill_id;
            next_fill_id += 1;
            fill_snippets.push(format_fill_xml(&patch.intent));
            id
        } else {
            base.fill_id
        };
        xf_snippets.push(format_cell_xf_xml(
            num_fmt_id,
            font_id,
            fill_id,
            base.border_id,
            base.xf_id,
            &patch.intent,
        ));
    }

    let mut patched = xml.to_string();
    if !num_fmt_snippets.is_empty() {
        patched = append_num_fmts_xml(&patched, &num_fmt_snippets)?;
    }
    if !font_snippets.is_empty() {
        patched = append_collection_xml(&patched, "fonts", &font_snippets)?;
    }
    if !fill_snippets.is_empty() {
        patched = append_collection_xml(&patched, "fills", &fill_snippets)?;
    }
    if !xf_snippets.is_empty() {
        patched = append_collection_xml(&patched, "cellXfs", &xf_snippets)?;
    }
    Ok(patched)
}

fn style_base_from_doc(doc: &Document<'_>, style_id: u32) -> PyResult<StyleBase> {
    let xf = doc
        .descendants()
        .find(|node| node.tag_name().name() == "cellXfs")
        .and_then(|cell_xfs| {
            cell_xfs
                .children()
                .filter(|node| node.tag_name().name() == "xf")
                .nth(style_id as usize)
        })
        .or_else(|| {
            doc.descendants()
                .find(|node| node.tag_name().name() == "cellXfs")
                .and_then(|cell_xfs| {
                    cell_xfs
                        .children()
                        .filter(|node| node.tag_name().name() == "xf")
                        .next()
                })
        })
        .ok_or_else(|| PyValueError::new_err("style_patch: styles.xml has no cellXfs xf"))?;
    Ok(StyleBase {
        num_fmt_id: attr_u32(xf, "numFmtId").unwrap_or(0),
        font_id: attr_u32(xf, "fontId").unwrap_or(0),
        fill_id: attr_u32(xf, "fillId").unwrap_or(0),
        border_id: attr_u32(xf, "borderId").unwrap_or(0),
        xf_id: attr_u32(xf, "xfId").unwrap_or(0),
    })
}

fn attr_u32(node: roxmltree::Node<'_, '_>, name: &str) -> Option<u32> {
    node.attribute(name).and_then(|value| value.parse().ok())
}

fn max_num_fmt_id(doc: &Document<'_>) -> u32 {
    doc.descendants()
        .filter(|node| node.tag_name().name() == "numFmt")
        .filter_map(|node| attr_u32(node, "numFmtId"))
        .max()
        .unwrap_or(163)
}

fn format_font_xml(intent: &CellFormatIntent) -> String {
    let mut body = String::from("<x:sz val=\"11\" /><x:name val=\"Carlito\" />");
    if intent.bold == Some(true) {
        body.insert_str(0, "<x:b />");
    }
    if intent.italic == Some(true) {
        body.insert_str(0, "<x:i />");
    }
    if let Some(color) = &intent.font_color {
        body.push_str(&format!("<x:color rgb=\"FF{}\" />", xml_escape(color)));
    }
    format!("<x:font>{body}</x:font>")
}

fn format_fill_xml(intent: &CellFormatIntent) -> String {
    let color = intent.fill_color.as_deref().unwrap_or("FFFFFF");
    format!(
        "<x:fill><x:patternFill patternType=\"solid\"><x:fgColor rgb=\"FF{}\" /><x:bgColor indexed=\"64\" /></x:patternFill></x:fill>",
        xml_escape(color)
    )
}

fn format_cell_xf_xml(
    num_fmt_id: u32,
    font_id: u32,
    fill_id: u32,
    border_id: u32,
    xf_id: u32,
    intent: &CellFormatIntent,
) -> String {
    let alignment = if intent.has_alignment_changes() {
        let mut attrs = Vec::new();
        if let Some(horizontal) = &intent.horizontal {
            attrs.push(format!("horizontal=\"{}\"", xml_escape(horizontal)));
        }
        if let Some(vertical) = &intent.vertical {
            attrs.push(format!("vertical=\"{}\"", xml_escape(vertical)));
        }
        if intent.wrap_text == Some(true) {
            attrs.push("wrapText=\"1\"".to_string());
        }
        format!("<x:alignment {} />", attrs.join(" "))
    } else {
        String::new()
    };
    if alignment.is_empty() {
        format!(
            "<x:xf numFmtId=\"{num_fmt_id}\" fontId=\"{font_id}\" fillId=\"{fill_id}\" borderId=\"{border_id}\" xfId=\"{xf_id}\" applyNumberFormat=\"1\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"0\" />"
        )
    } else {
        format!(
            "<x:xf numFmtId=\"{num_fmt_id}\" fontId=\"{font_id}\" fillId=\"{fill_id}\" borderId=\"{border_id}\" xfId=\"{xf_id}\" applyNumberFormat=\"1\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\">{alignment}</x:xf>"
        )
    }
}

fn collection_count(xml: &str, local_name: &str) -> u32 {
    Regex::new(&format!(
        r#"<(?:[A-Za-z0-9_]+:)?{}\b[^>]*\bcount="(\d+)""#,
        regex::escape(local_name)
    ))
    .ok()
    .and_then(|re| re.captures(xml))
    .and_then(|cap| cap.get(1).and_then(|m| m.as_str().parse::<u32>().ok()))
    .unwrap_or(0)
}

fn append_collection_xml(xml: &str, local_name: &str, children: &[String]) -> PyResult<String> {
    if children.is_empty() {
        return Ok(xml.to_string());
    }
    let count = collection_count(xml, local_name) + children.len() as u32;
    let count_re = Regex::new(&format!(
        r#"(<(?:[A-Za-z0-9_]+:)?{}\b[^>]*\bcount=")\d+("[^>]*>)"#,
        regex::escape(local_name)
    ))
    .unwrap();
    let with_count = count_re
        .replace(xml, format!("${{1}}{count}${{2}}"))
        .to_string();
    let close_re = Regex::new(&format!(
        r#"</(?:[A-Za-z0-9_]+:)?{}>"#,
        regex::escape(local_name)
    ))
    .unwrap();
    let Some(close_match) = close_re.find(&with_count) else {
        return Err(PyValueError::new_err(format!(
            "style_patch: styles.xml missing {local_name} closing tag"
        )));
    };
    Ok(insert_at_index(
        &with_count,
        close_match.start(),
        &children.join(""),
    ))
}

fn append_num_fmts_xml(xml: &str, children: &[String]) -> PyResult<String> {
    if children.is_empty() {
        return Ok(xml.to_string());
    }
    if collection_count(xml, "numFmts") > 0 {
        return append_collection_xml(xml, "numFmts", children);
    }
    let fonts_re = Regex::new(r#"<([A-Za-z0-9_]+:)?fonts\b"#).unwrap();
    let Some(fonts_match) = fonts_re.find(xml) else {
        return Err(PyValueError::new_err(
            "style_patch: styles.xml missing fonts collection",
        ));
    };
    let prefix = fonts_re
        .captures(xml)
        .and_then(|cap| cap.get(1).map(|m| m.as_str()))
        .unwrap_or("");
    let num_fmts = format!(
        "<{prefix}numFmts count=\"{}\">{}</{prefix}numFmts>",
        children.len(),
        children.join("")
    );
    Ok(insert_at_index(xml, fonts_match.start(), &num_fmts))
}

fn read_workbook_sheets<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> PyResult<Vec<SheetInfo>> {
    let workbook_xml = read_zip_text(archive, "xl/workbook.xml")?;
    let rels_xml = read_zip_text(archive, "xl/_rels/workbook.xml.rels")?;
    let workbook = Document::parse(&workbook_xml).map_err(to_py_runtime)?;
    let rels = Document::parse(&rels_xml).map_err(to_py_runtime)?;

    let mut rel_map = HashMap::new();
    for rel in rels
        .descendants()
        .filter(|node| node.tag_name().name() == "Relationship")
    {
        if let (Some(id), Some(target)) = (rel.attribute("Id"), rel.attribute("Target")) {
            rel_map.insert(id.to_string(), normalize_sheet_path(target));
        }
    }

    let mut sheets = Vec::new();
    for sheet in workbook
        .descendants()
        .filter(|node| node.tag_name().name() == "sheet")
    {
        let name = sheet.attribute("name").unwrap_or("Sheet").to_string();
        let sheet_id = sheet.attribute("sheetId").unwrap_or("").to_string();
        let visibility = sheet.attribute("state").unwrap_or("visible").to_string();
        let rid = sheet
            .attributes()
            .find(|attr| attr.name().ends_with("id"))
            .map(|attr| attr.value().to_string());
        if let Some((rel_id, path)) =
            rid.and_then(|id| rel_map.get(&id).cloned().map(|path| (id, path)))
        {
            sheets.push(SheetInfo {
                name,
                path,
                sheet_id,
                rel_id,
                visibility,
            });
        }
    }

    Ok(sheets)
}

fn patch_workbook_xml(
    xml: &str,
    sheets: &[SheetInfo],
    defined_names: &[DefinedName],
) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut patches = Vec::new();
    for sheet_node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "sheet")
    {
        let sheet_id = sheet_node.attribute("sheetId").unwrap_or("");
        let rel_id = sheet_node
            .attributes()
            .find(|attr| attr.name().ends_with("id"))
            .map(|attr| attr.value())
            .unwrap_or("");
        let Some(sheet_info) = sheets
            .iter()
            .find(|item| item.sheet_id == sheet_id || item.rel_id == rel_id)
        else {
            continue;
        };
        let range = sheet_node.range();
        let whole = &xml[range.clone()];
        let start_end = whole.find('>').ok_or_else(|| {
            PyValueError::new_err("workbook_patch: malformed sheet tag in workbook.xml")
        })?;
        let mut start_tag = whole[..=start_end].to_string();
        start_tag = with_xml_attr(&start_tag, "name", Some(&sheet_info.name));
        start_tag = if sheet_info.visibility == "visible" {
            with_xml_attr(&start_tag, "state", None)
        } else {
            with_xml_attr(&start_tag, "state", Some(&sheet_info.visibility))
        };
        patches.push((range.start, range.start + start_end + 1, start_tag));
    }
    let mut defined_name_idx = 0usize;
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "definedName")
    {
        let Some(defined_name) = defined_names.get(defined_name_idx) else {
            break;
        };
        defined_name_idx += 1;
        let range = node.range();
        let whole = &xml[range.clone()];
        let Some(start_end) = whole.find('>') else {
            continue;
        };
        let Some(close_start) = whole.rfind("</") else {
            continue;
        };
        let replacement = format!(
            "{}{}{}",
            &whole[..=start_end],
            xml_escape(&defined_name.target),
            &whole[close_start..]
        );
        patches.push((range.start, range.end, replacement));
    }
    let mut patched = xml.to_string();
    for (start, end, replacement) in patches.into_iter().rev() {
        patched.replace_range(start..end, &replacement);
    }
    Ok(patched)
}

fn read_defined_names<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheets: &[SheetInfo],
) -> PyResult<Vec<DefinedName>> {
    let workbook_xml = read_zip_text(archive, "xl/workbook.xml")?;
    let workbook = Document::parse(&workbook_xml).map_err(to_py_runtime)?;
    let mut defined_names = Vec::new();

    for item in workbook
        .descendants()
        .filter(|node| node.tag_name().name() == "definedName")
    {
        let Some(name) = item.attribute("name") else {
            continue;
        };
        let target = item.text().unwrap_or("").trim();
        if !name.trim().is_empty() && !target.is_empty() {
            let scope_sheet = item
                .attribute("localSheetId")
                .and_then(|value| value.parse::<usize>().ok())
                .and_then(|idx| sheets.get(idx).map(|sheet| sheet.name.clone()));
            defined_names.push(DefinedName {
                name: name.to_string(),
                target: target.to_string(),
                scope_sheet,
            });
        }
    }

    Ok(defined_names)
}

fn read_table_info<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheets: &[SheetInfo],
) -> PyResult<Vec<TableInfo>> {
    let mut tables = Vec::new();

    for sheet in sheets {
        let rels_path = rels_path_for_part(&sheet.path);
        let Ok(rels_xml) = read_zip_text(archive, &rels_path) else {
            continue;
        };
        let rels = Document::parse(&rels_xml).map_err(to_py_runtime)?;

        for rel in rels
            .descendants()
            .filter(|node| node.tag_name().name() == "Relationship")
        {
            let rel_type = rel.attribute("Type").unwrap_or("");
            if !rel_type.ends_with("/table") {
                continue;
            }
            let Some(target) = rel.attribute("Target") else {
                continue;
            };
            let table_path = normalize_part_target(&sheet.path, target);
            let Ok(table_xml) = read_zip_text(archive, &table_path) else {
                continue;
            };
            if let Some(table) = parse_table_info(&sheet.name, &table_path, &table_xml) {
                tables.push(table);
            }
        }
    }

    Ok(tables)
}

fn read_comments<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheets: &[SheetInfo],
) -> PyResult<Vec<CellComment>> {
    let mut comments = Vec::new();
    for sheet in sheets {
        let rels_path = rels_path_for_part(&sheet.path);
        let Ok(rels_xml) = read_zip_text(archive, &rels_path) else {
            continue;
        };
        let rels = Document::parse(&rels_xml).map_err(to_py_runtime)?;
        for rel in rels
            .descendants()
            .filter(|node| node.tag_name().name() == "Relationship")
        {
            let rel_type = rel.attribute("Type").unwrap_or("");
            if !rel_type.ends_with("/comments") {
                continue;
            }
            let Some(target) = rel.attribute("Target") else {
                continue;
            };
            let comment_path = normalize_part_target(&sheet.path, target);
            let Ok(comment_xml) = read_zip_text(archive, &comment_path) else {
                continue;
            };
            comments.extend(parse_comments_xml(&sheet.name, &comment_xml)?);
        }
    }
    Ok(comments)
}

fn read_drawing_objects<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheets: &[SheetInfo],
    package_entries: &HashSet<String>,
) -> PyResult<Vec<DrawingObject>> {
    let mut objects = Vec::new();
    for sheet in sheets {
        let Ok(sheet_xml) = read_zip_text(archive, &sheet.path) else {
            continue;
        };
        let drawing_rel_ids = worksheet_drawing_rel_ids(&sheet_xml)?;
        if drawing_rel_ids.is_empty() {
            continue;
        }
        let rels_path = rels_path_for_part(&sheet.path);
        let Ok(rels_xml) = read_zip_text(archive, &rels_path) else {
            continue;
        };
        let rels = parse_relationships_xml(&rels_xml, &sheet.path)?;
        for drawing_rel_id in drawing_rel_ids {
            let Some(drawing_rel) = rels
                .iter()
                .find(|rel| rel.id == drawing_rel_id && rel.rel_type.ends_with("/drawing"))
            else {
                objects.push(DrawingObject {
                    sheet: sheet.name.clone(),
                    object_id: format!(
                        "drawing_object:{}:{}:{}",
                        sheet.sheet_id, sheet.path, drawing_rel_id
                    ),
                    object_type: "drawing".to_string(),
                    drawing_path: String::new(),
                    anchor_ordinal: 0,
                    anchor_kind: String::new(),
                    from_row: None,
                    from_col: None,
                    to_row: None,
                    to_col: None,
                    rel_id: drawing_rel_id,
                    target_path: String::new(),
                    target_exists: false,
                    relationship_valid: false,
                    invalid_reason: "missing_worksheet_drawing_relationship".to_string(),
                });
                continue;
            };
            if drawing_rel.target_mode.eq_ignore_ascii_case("External") {
                continue;
            }
            let drawing_path = normalize_part_target(&sheet.path, &drawing_rel.target);
            let Ok(drawing_xml) = read_zip_text(archive, &drawing_path) else {
                objects.push(DrawingObject {
                    sheet: sheet.name.clone(),
                    object_id: format!(
                        "drawing_object:{}:{}:{}",
                        sheet.sheet_id, sheet.path, drawing_rel.id
                    ),
                    object_type: "drawing".to_string(),
                    drawing_path,
                    anchor_ordinal: 0,
                    anchor_kind: String::new(),
                    from_row: None,
                    from_col: None,
                    to_row: None,
                    to_col: None,
                    rel_id: drawing_rel.id.clone(),
                    target_path: String::new(),
                    target_exists: false,
                    relationship_valid: false,
                    invalid_reason: "missing_drawing_part".to_string(),
                });
                continue;
            };
            let drawing_rels_path = rels_path_for_part(&drawing_path);
            let drawing_rels = read_zip_text(archive, &drawing_rels_path)
                .ok()
                .and_then(|xml| parse_relationships_xml(&xml, &drawing_path).ok())
                .unwrap_or_default();
            objects.extend(parse_drawing_objects_xml(
                sheet,
                &drawing_path,
                &drawing_xml,
                &drawing_rels,
                package_entries,
            )?);
        }
    }
    Ok(objects)
}

fn read_high_risk_objects<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheets: &[SheetInfo],
    package_entries: &HashSet<String>,
    package_sizes: &HashMap<String, u64>,
) -> PyResult<Vec<HighRiskObject>> {
    let mut objects = Vec::new();
    for sheet in sheets {
        let sheet_xml = read_zip_text(archive, &sheet.path).unwrap_or_default();
        objects.extend(parse_sparkline_objects_xml(sheet, &sheet_xml)?);

        let rels_path = rels_path_for_part(&sheet.path);
        let Ok(rels_xml) = read_zip_text(archive, &rels_path) else {
            continue;
        };
        let rels = parse_relationships_xml(&rels_xml, &sheet.path)?;
        for rel in rels {
            if rel.rel_type.ends_with("/pivotTable") {
                objects.push(read_pivot_object(
                    archive,
                    sheet,
                    &rel,
                    package_entries,
                    package_sizes,
                )?);
            } else if rel.rel_type.ends_with("/oleObject")
                || (rel.rel_type.ends_with("/package") && rel.target.contains("/embeddings/"))
            {
                objects.push(read_ole_object(sheet, &rel, package_entries, package_sizes));
            }
        }
    }
    Ok(objects)
}

fn read_pivot_object<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    sheet: &SheetInfo,
    rel: &PackageRelationship,
    package_entries: &HashSet<String>,
    package_sizes: &HashMap<String, u64>,
) -> PyResult<HighRiskObject> {
    let target_exists =
        rel.target_mode.eq_ignore_ascii_case("External") || package_entries.contains(&rel.target);
    let target_size = package_sizes.get(&rel.target).copied().unwrap_or(0);
    let mut name = file_stem_from_path(&rel.target);
    let mut cache_path = String::new();
    let mut cache_rel_id = String::new();
    let mut cache_target_mode = String::new();
    let mut cache_exists = false;
    let mut cache_size = 0;
    let mut pivot_cache_id = String::new();
    let mut pivot_data_caption = String::new();
    let mut pivot_updated_version = String::new();
    if target_exists {
        if let Ok(pivot_xml) = read_zip_text(archive, &rel.target) {
            if let Ok(doc) = Document::parse(&pivot_xml).map_err(to_py_runtime) {
                if let Some(node) = doc
                    .descendants()
                    .find(|node| node.tag_name().name() == "pivotTableDefinition")
                {
                    if let Some(value) = node.attribute("name") {
                        name = value.to_string();
                    }
                    pivot_cache_id = node.attribute("cacheId").unwrap_or("").to_string();
                    pivot_data_caption = node.attribute("dataCaption").unwrap_or("").to_string();
                    pivot_updated_version =
                        node.attribute("updatedVersion").unwrap_or("").to_string();
                }
            }
        }
        let pivot_rels_path = rels_path_for_part(&rel.target);
        if let Ok(pivot_rels_xml) = read_zip_text(archive, &pivot_rels_path) {
            let pivot_rels = parse_relationships_xml(&pivot_rels_xml, &rel.target)?;
            if let Some(cache_rel) = pivot_rels
                .iter()
                .find(|item| item.rel_type.ends_with("/pivotCacheDefinition"))
            {
                cache_rel_id = cache_rel.id.clone();
                cache_path = cache_rel.target.clone();
                cache_target_mode = cache_rel.target_mode.clone();
                cache_exists = cache_rel.target_mode.eq_ignore_ascii_case("External")
                    || package_entries.contains(&cache_rel.target);
                cache_size = package_sizes.get(&cache_rel.target).copied().unwrap_or(0);
            }
        }
    }
    Ok(HighRiskObject {
        sheet: sheet.name.clone(),
        object_id: format!("high_risk:{}:pivot_table:{}", sheet.sheet_id, rel.id),
        object_type: "pivot_table".to_string(),
        source_path: sheet.path.clone(),
        rel_id: rel.id.clone(),
        rel_type: rel.rel_type.clone(),
        target_path: rel.target.clone(),
        target_mode: rel.target_mode.clone(),
        target_exists,
        target_size,
        relationship_valid: true,
        name,
        ref_text: String::new(),
        source_formula: String::new(),
        cache_path,
        cache_rel_id,
        cache_target_mode,
        cache_exists,
        cache_size,
        pivot_cache_id,
        pivot_data_caption,
        pivot_updated_version,
        sparkline_group_type: String::new(),
        sparkline_display_empty_cells_as: String::new(),
        sparkline_markers: String::new(),
        ole_extension: String::new(),
        invalid_reason: String::new(),
    })
}

fn read_ole_object(
    sheet: &SheetInfo,
    rel: &PackageRelationship,
    package_entries: &HashSet<String>,
    package_sizes: &HashMap<String, u64>,
) -> HighRiskObject {
    let target_exists =
        rel.target_mode.eq_ignore_ascii_case("External") || package_entries.contains(&rel.target);
    let target_size = package_sizes.get(&rel.target).copied().unwrap_or(0);
    HighRiskObject {
        sheet: sheet.name.clone(),
        object_id: format!("high_risk:{}:ole_object:{}", sheet.sheet_id, rel.id),
        object_type: "ole_object".to_string(),
        source_path: sheet.path.clone(),
        rel_id: rel.id.clone(),
        rel_type: rel.rel_type.clone(),
        target_path: rel.target.clone(),
        target_mode: rel.target_mode.clone(),
        target_exists,
        target_size,
        relationship_valid: true,
        name: file_stem_from_path(&rel.target),
        ref_text: String::new(),
        source_formula: String::new(),
        cache_path: String::new(),
        cache_rel_id: String::new(),
        cache_target_mode: String::new(),
        cache_exists: false,
        cache_size: 0,
        pivot_cache_id: String::new(),
        pivot_data_caption: String::new(),
        pivot_updated_version: String::new(),
        sparkline_group_type: String::new(),
        sparkline_display_empty_cells_as: String::new(),
        sparkline_markers: String::new(),
        ole_extension: file_extension_from_path(&rel.target),
        invalid_reason: String::new(),
    }
}

fn parse_sparkline_objects_xml(sheet: &SheetInfo, xml: &str) -> PyResult<Vec<HighRiskObject>> {
    if xml.trim().is_empty() {
        return Ok(Vec::new());
    }
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut objects = Vec::new();
    for (idx, sparkline) in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "sparkline")
        .enumerate()
    {
        let ref_text = child_text(sparkline, "sqref");
        let source_formula = child_text(sparkline, "f");
        let group = sparkline
            .ancestors()
            .find(|node| node.is_element() && node.tag_name().name() == "sparklineGroup");
        let sparkline_group_type = group
            .and_then(|node| node.attribute("type"))
            .unwrap_or("")
            .to_string();
        let sparkline_display_empty_cells_as = group
            .and_then(|node| node.attribute("displayEmptyCellsAs"))
            .unwrap_or("")
            .to_string();
        let sparkline_markers = group.map(sparkline_group_markers).unwrap_or_default();
        objects.push(HighRiskObject {
            sheet: sheet.name.clone(),
            object_id: format!("high_risk:{}:sparkline:{}", sheet.sheet_id, idx + 1),
            object_type: "sparkline".to_string(),
            source_path: sheet.path.clone(),
            rel_id: String::new(),
            rel_type: String::new(),
            target_path: String::new(),
            target_mode: String::new(),
            target_exists: true,
            target_size: 0,
            relationship_valid: true,
            name: format!("sparkline_{}", idx + 1),
            ref_text,
            source_formula,
            cache_path: String::new(),
            cache_rel_id: String::new(),
            cache_target_mode: String::new(),
            cache_exists: false,
            cache_size: 0,
            pivot_cache_id: String::new(),
            pivot_data_caption: String::new(),
            pivot_updated_version: String::new(),
            sparkline_group_type,
            sparkline_display_empty_cells_as,
            sparkline_markers,
            ole_extension: String::new(),
            invalid_reason: String::new(),
        });
    }
    Ok(objects)
}

fn worksheet_drawing_rel_ids(xml: &str) -> PyResult<Vec<String>> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut rel_ids = Vec::new();
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "drawing")
    {
        for attr in node.attributes() {
            if attr.name().ends_with("id") && attr.value().starts_with("rId") {
                rel_ids.push(attr.value().to_string());
            }
        }
    }
    rel_ids.sort();
    rel_ids.dedup();
    Ok(rel_ids)
}

fn parse_relationships_xml(xml: &str, base_part: &str) -> PyResult<Vec<PackageRelationship>> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut rels = Vec::new();
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "Relationship")
    {
        let Some(id) = node.attribute("Id") else {
            continue;
        };
        let target = node.attribute("Target").unwrap_or("").to_string();
        let target_mode = node.attribute("TargetMode").unwrap_or("").to_string();
        let normalized_target = if target_mode.eq_ignore_ascii_case("External") {
            target
        } else {
            normalize_part_target(base_part, &target)
        };
        rels.push(PackageRelationship {
            id: id.to_string(),
            rel_type: node.attribute("Type").unwrap_or("").to_string(),
            target: normalized_target,
            target_mode,
        });
    }
    Ok(rels)
}

fn parse_drawing_objects_xml(
    sheet: &SheetInfo,
    drawing_path: &str,
    xml: &str,
    rels: &[PackageRelationship],
    package_entries: &HashSet<String>,
) -> PyResult<Vec<DrawingObject>> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut objects = Vec::new();
    for (anchor_ordinal, anchor) in doc
        .descendants()
        .filter(|node| {
            matches!(
                node.tag_name().name(),
                "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor"
            )
        })
        .enumerate()
    {
        let anchor_kind = anchor.tag_name().name().to_string();
        let (from_col, from_row) = parse_anchor_marker(anchor, "from");
        let (to_col, to_row) = parse_anchor_marker(anchor, "to");
        let rel_id = drawing_anchor_rel_id(anchor).unwrap_or_default();
        let rel = rels.iter().find(|item| item.id == rel_id);
        let relationship_valid = rel_id.is_empty() || rel.is_some();
        let target_path = rel.map(|item| item.target.clone()).unwrap_or_default();
        let target_exists = rel
            .map(|item| {
                item.target_mode.eq_ignore_ascii_case("External")
                    || package_entries.contains(&item.target)
            })
            .unwrap_or(rel_id.is_empty());
        let object_type = drawing_object_type(anchor, rel);
        let local_id =
            drawing_anchor_local_id(anchor).unwrap_or_else(|| anchor_ordinal.to_string());
        let stable_tail = if rel_id.is_empty() {
            local_id
        } else {
            rel_id.clone()
        };
        objects.push(DrawingObject {
            sheet: sheet.name.clone(),
            object_id: format!(
                "drawing_object:{}:{}:{}",
                sheet.sheet_id, drawing_path, stable_tail
            ),
            object_type,
            drawing_path: drawing_path.to_string(),
            anchor_ordinal,
            anchor_kind,
            from_row,
            from_col,
            to_row,
            to_col,
            rel_id,
            target_path,
            target_exists,
            relationship_valid,
            invalid_reason: String::new(),
        });
    }
    Ok(objects)
}

fn parse_anchor_marker(
    anchor: roxmltree::Node<'_, '_>,
    marker_name: &str,
) -> (Option<usize>, Option<usize>) {
    let Some(marker) = anchor
        .children()
        .find(|child| child.is_element() && child.tag_name().name() == marker_name)
    else {
        return (None, None);
    };
    let col = child_text(marker, "col")
        .parse::<usize>()
        .ok()
        .map(|value| value + 1);
    let row = child_text(marker, "row")
        .parse::<usize>()
        .ok()
        .map(|value| value + 1);
    (col, row)
}

fn drawing_anchor_rel_id(anchor: roxmltree::Node<'_, '_>) -> Option<String> {
    for node in anchor.descendants() {
        for attr in node.attributes() {
            if matches!(attr.name(), "embed" | "link" | "id") && attr.value().starts_with("rId") {
                return Some(attr.value().to_string());
            }
        }
    }
    None
}

fn drawing_anchor_local_id(anchor: roxmltree::Node<'_, '_>) -> Option<String> {
    anchor
        .descendants()
        .find(|node| node.tag_name().name() == "cNvPr")
        .and_then(|node| node.attribute("id"))
        .map(|value| value.to_string())
}

fn drawing_object_type(
    anchor: roxmltree::Node<'_, '_>,
    rel: Option<&PackageRelationship>,
) -> String {
    if let Some(rel) = rel {
        if rel.rel_type.ends_with("/chart") {
            return "chart".to_string();
        }
        if rel.rel_type.ends_with("/image") {
            return "image".to_string();
        }
    }
    if anchor
        .descendants()
        .any(|node| node.tag_name().name() == "pic")
    {
        "image".to_string()
    } else if anchor
        .descendants()
        .any(|node| node.tag_name().name() == "sp")
    {
        "shape".to_string()
    } else if anchor
        .descendants()
        .any(|node| node.tag_name().name() == "graphicFrame")
    {
        "chart".to_string()
    } else {
        "drawing".to_string()
    }
}

fn parse_comments_xml(sheet_name: &str, xml: &str) -> PyResult<Vec<CellComment>> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut comments = Vec::new();
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "comment")
    {
        let Some(cell_ref) = node.attribute("ref") else {
            continue;
        };
        let Some((col, row)) = parse_a1(cell_ref) else {
            continue;
        };
        let text = node
            .descendants()
            .filter(|child| child.tag_name().name() == "t")
            .filter_map(|child| child.text())
            .collect::<Vec<_>>()
            .join("");
        comments.push(CellComment {
            key: Key {
                sheet: sheet_name.to_string(),
                row,
                col,
            },
            text,
        });
    }
    Ok(comments)
}

fn parse_sheet_objects(
    sheet_name: &str,
    xml: &str,
    data_validations: &mut Vec<DataValidationRule>,
    auto_filters: &mut Vec<AutoFilterRule>,
    conditional_formats: &mut Vec<ConditionalFormatRule>,
) -> PyResult<()> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "dataValidation")
    {
        let Some(sqref) = node.attribute("sqref") else {
            continue;
        };
        let Some(range) = parse_object_range(sheet_name, sqref) else {
            continue;
        };
        data_validations.push(DataValidationRule {
            range,
            validation_type: node.attribute("type").unwrap_or("list").to_string(),
            operator: node.attribute("operator").unwrap_or("").to_string(),
            formula1: child_text(node, "formula1"),
            formula2: child_text(node, "formula2"),
            allow_blank: node
                .attribute("allowBlank")
                .map(xml_bool_attr_is_true)
                .unwrap_or(true),
        });
    }
    if let Some(node) = doc
        .descendants()
        .find(|node| node.tag_name().name() == "autoFilter")
    {
        if let Some(range) = node
            .attribute("ref")
            .and_then(|value| parse_object_range(sheet_name, value))
        {
            auto_filters.push(AutoFilterRule { range });
        }
    }
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "conditionalFormatting")
    {
        let Some(range) = node
            .attribute("sqref")
            .and_then(|value| parse_object_range(sheet_name, value))
        else {
            continue;
        };
        for cf_rule in node
            .children()
            .filter(|child| child.is_element() && child.tag_name().name() == "cfRule")
        {
            conditional_formats.push(ConditionalFormatRule {
                range: range.clone(),
                rule_type: cf_rule.attribute("type").unwrap_or("cellIs").to_string(),
                operator: cf_rule.attribute("operator").unwrap_or("").to_string(),
                formula: child_text(cf_rule, "formula"),
                priority: cf_rule
                    .attribute("priority")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(1),
            });
        }
    }
    Ok(())
}

fn parse_object_range(sheet_name: &str, value: &str) -> Option<ObjectRange> {
    let first = value.split_whitespace().next()?;
    let (left, right) = first.split_once(':').unwrap_or((first, first));
    let (start_col, start_row) = parse_a1(left)?;
    let (end_col, end_row) = parse_a1(right)?;
    Some(ObjectRange {
        sheet: sheet_name.to_string(),
        start_row: start_row.min(end_row),
        start_col: start_col.min(end_col),
        end_row: start_row.max(end_row),
        end_col: start_col.max(end_col),
    })
}

fn parse_table_info(sheet_name: &str, table_path: &str, xml: &str) -> Option<TableInfo> {
    let doc = Document::parse(xml).ok()?;
    let table = doc
        .descendants()
        .find(|node| node.tag_name().name() == "table")?;
    let name = table
        .attribute("displayName")
        .or_else(|| table.attribute("name"))?
        .to_string();
    let (start_ref, end_ref) = table.attribute("ref")?.split_once(':')?;
    let (start_col, start_row) = parse_a1(start_ref)?;
    let (end_col, end_row) = parse_a1(end_ref)?;
    let normalized_start_row = start_row.min(end_row);
    let normalized_end_row = start_row.max(end_row);
    let totals_row_count = table
        .attribute("totalsRowCount")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let totals_row_shown = table
        .attribute("totalsRowShown")
        .is_some_and(xml_bool_attr_is_true);
    let totals_row = (totals_row_count > 0 || totals_row_shown).then_some(normalized_end_row);
    let columns = doc
        .descendants()
        .filter(|node| node.tag_name().name() == "tableColumn")
        .filter_map(|node| node.attribute("name").map(|name| name.to_string()))
        .collect();

    Some(TableInfo {
        name,
        path: table_path.to_string(),
        sheet: sheet_name.to_string(),
        start_row: normalized_start_row,
        end_row: normalized_end_row,
        start_col: start_col.min(end_col),
        end_col: start_col.max(end_col),
        totals_row,
        columns,
    })
}

fn xml_bool_attr_is_true(value: &str) -> bool {
    value == "1" || value.eq_ignore_ascii_case("true")
}

fn rels_path_for_part(part_path: &str) -> String {
    let Some((dir, file_name)) = part_path.rsplit_once('/') else {
        return format!("_rels/{part_path}.rels");
    };
    format!("{dir}/_rels/{file_name}.rels")
}

fn normalize_part_target(base_part: &str, target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("xl/") {
        return target.to_string();
    }

    let base_dir = base_part.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    normalize_path_segments(&format!("{base_dir}/{target}"))
}

fn normalize_path_segments(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn file_stem_from_path(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name)
        .to_string()
}

fn file_extension_from_path(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("")
        .to_string()
}

fn sparkline_group_markers(group: roxmltree::Node<'_, '_>) -> String {
    ["markers", "high", "low", "first", "last", "negative"]
        .iter()
        .filter_map(|attr| {
            group
                .attribute(*attr)
                .filter(|value| xml_bool_attr_is_true(value))
                .map(|_| (*attr).to_string())
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn normalize_sheet_path(target: &str) -> String {
    let target = target.trim_start_matches('/');
    if target.starts_with("xl/") {
        target.to_string()
    } else {
        format!("xl/{}", target)
    }
}

fn parse_sheet_xml(
    sheet_name: &str,
    xml: &str,
    shared_strings: &[String],
    style_info: &HashMap<u32, String>,
    merges: &mut HashMap<String, HashSet<String>>,
    cells: &mut HashMap<Key, String>,
    formulas: &mut HashMap<Key, FormulaCell>,
    meta: &mut HashMap<Key, ShadowMetaRecord>,
) -> PyResult<()> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;

    for merge_cell in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "mergeCell")
    {
        if let Some(range) = merge_cell.attribute("ref") {
            merges
                .entry(sheet_name.to_string())
                .or_default()
                .insert(range.to_string());
        }
    }

    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "c")
    {
        let Some(cell_ref) = node.attribute("r") else {
            continue;
        };
        let Some((col, row)) = parse_a1(cell_ref) else {
            continue;
        };
        let key = Key {
            sheet: sheet_name.to_string(),
            row,
            col,
        };
        let cell_type = node.attribute("t").unwrap_or("");
        let style_id = node
            .attribute("s")
            .and_then(|value| value.parse::<u32>().ok());
        let formula = child_text(node, "f");
        let raw_value = child_text(node, "v");
        let mut inline_value = String::new();
        for child in node
            .descendants()
            .filter(|child| child.tag_name().name() == "t")
        {
            inline_value.push_str(child.text().unwrap_or(""));
        }

        let value = match cell_type {
            "s" => raw_value
                .parse::<usize>()
                .ok()
                .and_then(|idx| shared_strings.get(idx).cloned())
                .unwrap_or_default(),
            "inlineStr" => inline_value,
            _ => raw_value.clone(),
        };
        cells.insert(key.clone(), value);
        let shadow_cell_type = classify_cell_type(cell_type, &formula, &raw_value);
        meta.insert(
            key.clone(),
            ShadowMetaRecord {
                sheet_name: sheet_name.to_string(),
                row_idx: row,
                col_idx: col,
                cell_type: shadow_cell_type,
                style_id,
                number_format: style_id
                    .and_then(|id| style_info.get(&id).cloned())
                    .unwrap_or_default(),
                original_formula: if formula.is_empty() {
                    String::new()
                } else if formula.starts_with('=') {
                    formula.clone()
                } else {
                    format!("={formula}")
                },
                cached_value_before: cells.get(&key).cloned().unwrap_or_default(),
                cached_value_after: cells.get(&key).cloned().unwrap_or_default(),
                merge_range: String::new(),
                is_modified: false,
                is_dirty: false,
            },
        );

        if !formula.is_empty() {
            formulas.insert(
                key,
                FormulaCell {
                    formula: if formula.starts_with('=') {
                        formula
                    } else {
                        format!("={}", formula)
                    },
                    deps: HashSet::new(),
                },
            );
        }
    }

    Ok(())
}

fn classify_cell_type(cell_type: &str, formula: &str, raw_value: &str) -> String {
    if !formula.is_empty() {
        "formula".to_string()
    } else {
        match cell_type {
            "s" | "str" | "inlineStr" => "string".to_string(),
            "b" => "bool".to_string(),
            "e" => "error".to_string(),
            "d" => "date".to_string(),
            _ if raw_value.is_empty() => "blank".to_string(),
            _ => "number".to_string(),
        }
    }
}

fn normalize_formula_text(formula: &str) -> PyResult<String> {
    let formula = formula.trim();
    if formula.is_empty() || formula == "=" {
        return Err(PyValueError::new_err(
            "unsupported_formula: formula text must not be empty",
        ));
    }
    if formula.starts_with('=') {
        Ok(formula.to_string())
    } else {
        Ok(format!("={formula}"))
    }
}

fn optional_nonempty(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn optional_bool(values: &HashMap<String, String>, key: &str) -> PyResult<Option<bool>> {
    let Some(value) = optional_nonempty(values, key) else {
        return Ok(None);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(Some(true)),
        "false" | "0" | "no" => Ok(Some(false)),
        _ => Err(PyValueError::new_err(format!(
            "unsafe_update: {key} must be boolean"
        ))),
    }
}

fn optional_enum(
    values: &HashMap<String, String>,
    key: &str,
    allowed: &[&str],
) -> PyResult<Option<String>> {
    let Some(value) = optional_nonempty(values, key) else {
        return Ok(None);
    };
    if allowed.contains(&value.as_str()) {
        Ok(Some(value))
    } else {
        Err(PyValueError::new_err(format!(
            "unsafe_update: {key} must be one of {}",
            allowed.join(", ")
        )))
    }
}

fn optional_color(values: &HashMap<String, String>, key: &str) -> PyResult<Option<String>> {
    let Some(value) = optional_nonempty(values, key) else {
        return Ok(None);
    };
    let color = value.trim().trim_start_matches('#').to_ascii_uppercase();
    if color.len() == 6 && color.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(Some(color))
    } else {
        Err(PyValueError::new_err(format!(
            "unsafe_update: {key} must be a 6-digit hex color"
        )))
    }
}

fn rename_key_map<T>(input: HashMap<Key, T>, old_name: &str, new_name: &str) -> HashMap<Key, T> {
    input
        .into_iter()
        .map(|(mut key, value)| {
            if key.sheet == old_name {
                key.sheet = new_name.to_string();
            }
            (key, value)
        })
        .collect()
}

fn rename_key_set(input: HashSet<Key>, old_name: &str, new_name: &str) -> HashSet<Key> {
    input
        .into_iter()
        .map(|mut key| {
            if key.sheet == old_name {
                key.sheet = new_name.to_string();
            }
            key
        })
        .collect()
}

fn shift_key_map<T>(input: HashMap<Key, T>, edit: &StructureEdit) -> HashMap<Key, T> {
    input
        .into_iter()
        .filter_map(|(key, value)| transform_key(&key, edit).map(|next| (next, value)))
        .collect()
}

fn shift_key_set(input: HashSet<Key>, edit: &StructureEdit) -> HashSet<Key> {
    input
        .into_iter()
        .filter_map(|key| transform_key(&key, edit))
        .collect()
}

fn transform_key(key: &Key, edit: &StructureEdit) -> Option<Key> {
    if key.sheet != edit.sheet {
        return Some(key.clone());
    }
    let coord = match edit.axis {
        StructureAxis::Row => key.row,
        StructureAxis::Col => key.col,
    };
    let next_coord = transform_coord(coord, edit)?;
    let mut next = key.clone();
    match edit.axis {
        StructureAxis::Row => next.row = next_coord,
        StructureAxis::Col => next.col = next_coord,
    }
    Some(next)
}

fn transform_coord(coord: usize, edit: &StructureEdit) -> Option<usize> {
    let count = edit.end - edit.start + 1;
    match edit.kind {
        StructureOpKind::Insert => {
            if coord >= edit.start {
                Some(coord + count)
            } else {
                Some(coord)
            }
        }
        StructureOpKind::Delete => {
            if (edit.start..=edit.end).contains(&coord) {
                None
            } else if coord > edit.end {
                Some(coord - count)
            } else {
                Some(coord)
            }
        }
        StructureOpKind::Move => {
            if (edit.start..=edit.end).contains(&coord) {
                Some(edit.target + (coord - edit.start))
            } else if edit.target < edit.start && (edit.target..edit.start).contains(&coord) {
                Some(coord + count)
            } else if edit.target > edit.end && coord > edit.end && coord < edit.target + count {
                Some(coord - count)
            } else {
                Some(coord)
            }
        }
    }
}

fn checked_range_end(start: usize, count: usize) -> PyResult<usize> {
    if start == 0 || count == 0 {
        return Err(PyValueError::new_err(
            "unsafe_update: start and count must be positive",
        ));
    }
    start
        .checked_add(count - 1)
        .ok_or_else(|| PyValueError::new_err("unsafe_update: range overflows usize"))
}

fn normalize_optional_pivot_text(value: Option<&str>, label: &str) -> PyResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(PyValueError::new_err(format!(
            "unsafe_update: {label} must not be empty"
        )));
    }
    if normalized.chars().any(|ch| ch.is_control()) {
        return Err(PyValueError::new_err(format!(
            "unsafe_update: {label} must not contain control characters"
        )));
    }
    Ok(Some(normalized.to_string()))
}

fn rewrite_formula_structure_refs(
    formula: &str,
    default_sheet: &str,
    edit: &StructureEdit,
) -> String {
    let formula = rewrite_explicit_sheet_ranges(formula, edit);
    let formula = rewrite_unqualified_ranges(&formula, default_sheet, edit);
    let re = Regex::new(
        r#"(?i)(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!(?P<col_abs>\$?)(?P<col>[A-Z]{1,3})(?P<row_abs>\$?)(?P<row>[0-9]+)|(?P<col_abs2>\$?)(?P<col2>[A-Z]{1,3})(?P<row_abs2>\$?)(?P<row2>[0-9]+)"#,
    )
    .unwrap();
    let mut out = String::with_capacity(formula.len());
    let mut cursor = 0usize;
    for cap in re.captures_iter(&formula) {
        let Some(matched) = cap.get(0) else {
            continue;
        };
        if matched.start() < cursor {
            continue;
        }
        out.push_str(&formula[cursor..matched.start()]);
        let replacement = rewrite_formula_ref_capture(&formula, default_sheet, edit, &cap)
            .unwrap_or_else(|| matched.as_str().to_string());
        out.push_str(&replacement);
        cursor = matched.end();
    }
    out.push_str(&formula[cursor..]);
    out
}

fn rewrite_explicit_sheet_ranges(formula: &str, edit: &StructureEdit) -> String {
    let re = Regex::new(
        r#"(?i)(?P<sheet>'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!(?P<ref1>\$?[A-Z]{1,3}\$?[0-9]+):(?P<ref2>\$?[A-Z]{1,3}\$?[0-9]+)"#,
    )
    .unwrap();
    let mut out = String::with_capacity(formula.len());
    let mut cursor = 0usize;
    for cap in re.captures_iter(formula) {
        let Some(matched) = cap.get(0) else {
            continue;
        };
        if matched.start() < cursor {
            continue;
        }
        out.push_str(&formula[cursor..matched.start()]);
        if formula_offset_in_string_literal(formula, matched.start())
            || formula_offset_in_bracket_ref(formula, matched.start())
        {
            out.push_str(matched.as_str());
            cursor = matched.end();
            continue;
        }
        let sheet_token = cap.name("sheet").map(|m| m.as_str()).unwrap_or("");
        let sheet_name = unquote_sheet_name(sheet_token);
        let replacement = if sheet_name == edit.sheet {
            let left = rewrite_ref_token_for_sheet(
                cap.name("ref1").map(|m| m.as_str()).unwrap_or(""),
                &sheet_name,
                edit,
            );
            let right = rewrite_ref_token_for_sheet(
                cap.name("ref2").map(|m| m.as_str()).unwrap_or(""),
                &sheet_name,
                edit,
            );
            match (left, right) {
                (Some(left), Some(right)) => format!("{sheet_token}!{left}:{right}"),
                _ => "#REF!".to_string(),
            }
        } else {
            matched.as_str().to_string()
        };
        out.push_str(&replacement);
        cursor = matched.end();
    }
    out.push_str(&formula[cursor..]);
    out
}

fn rewrite_unqualified_ranges(formula: &str, default_sheet: &str, edit: &StructureEdit) -> String {
    if default_sheet != edit.sheet {
        return formula.to_string();
    }
    let re = Regex::new(r#"(?i)(?P<ref1>\$?[A-Z]{1,3}\$?[0-9]+):(?P<ref2>\$?[A-Z]{1,3}\$?[0-9]+)"#)
        .unwrap();
    let mut out = String::with_capacity(formula.len());
    let mut cursor = 0usize;
    for cap in re.captures_iter(formula) {
        let Some(matched) = cap.get(0) else {
            continue;
        };
        if matched.start() < cursor {
            continue;
        }
        out.push_str(&formula[cursor..matched.start()]);
        let previous = formula[..matched.start()].chars().next_back();
        if previous == Some('!') {
            out.push_str(matched.as_str());
            cursor = matched.end();
            continue;
        }
        let replacement = if formula_offset_in_string_literal(formula, matched.start())
            || formula_offset_in_bracket_ref(formula, matched.start())
        {
            matched.as_str().to_string()
        } else {
            let left = rewrite_ref_token_for_sheet(
                cap.name("ref1").map(|m| m.as_str()).unwrap_or(""),
                default_sheet,
                edit,
            );
            let right = rewrite_ref_token_for_sheet(
                cap.name("ref2").map(|m| m.as_str()).unwrap_or(""),
                default_sheet,
                edit,
            );
            match (left, right) {
                (Some(left), Some(right)) => format!("{left}:{right}"),
                _ => "#REF!".to_string(),
            }
        };
        out.push_str(&replacement);
        cursor = matched.end();
    }
    out.push_str(&formula[cursor..]);
    out
}

fn rewrite_ref_token_for_sheet(
    token: &str,
    sheet_name: &str,
    edit: &StructureEdit,
) -> Option<String> {
    let re =
        Regex::new(r#"(?i)^(?P<col_abs>\$?)(?P<col>[A-Z]{1,3})(?P<row_abs>\$?)(?P<row>[0-9]+)$"#)
            .unwrap();
    let cap = re.captures(token)?;
    let col = col_from_name(cap.name("col")?.as_str())?;
    let row = cap.name("row")?.as_str().parse::<usize>().ok()?;
    let next = transform_key(
        &Key {
            sheet: sheet_name.to_string(),
            row,
            col,
        },
        edit,
    )?;
    Some(format!(
        "{}{}{}{}",
        cap.name("col_abs").map(|m| m.as_str()).unwrap_or(""),
        col_to_name(next.col),
        cap.name("row_abs").map(|m| m.as_str()).unwrap_or(""),
        next.row
    ))
}

fn rewrite_formula_ref_capture(
    formula: &str,
    default_sheet: &str,
    edit: &StructureEdit,
    cap: &regex::Captures<'_>,
) -> Option<String> {
    let matched = cap.get(0)?;
    if formula_offset_in_string_literal(formula, matched.start())
        || formula_offset_in_bracket_ref(formula, matched.start())
    {
        return None;
    }
    let previous = formula[..matched.start()].chars().next_back();
    if previous == Some(':') || formula[matched.end()..].chars().next() == Some(':') {
        return None;
    }
    if previous.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == ']') {
        return None;
    }
    let next = formula[matched.end()..].chars().next();
    if next.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return None;
    }

    let sheet_token = cap.name("sheet").map(|m| m.as_str());
    let sheet_name = sheet_token
        .map(unquote_sheet_name)
        .unwrap_or_else(|| default_sheet.to_string());
    if sheet_name.contains('[') || sheet_name.contains(']') || sheet_name != edit.sheet {
        return None;
    }
    let col_abs = cap
        .name("col_abs")
        .or_else(|| cap.name("col_abs2"))
        .map(|m| m.as_str())
        .unwrap_or("");
    let col_text = cap
        .name("col")
        .or_else(|| cap.name("col2"))
        .map(|m| m.as_str())?;
    let row_abs = cap
        .name("row_abs")
        .or_else(|| cap.name("row_abs2"))
        .map(|m| m.as_str())
        .unwrap_or("");
    let row = cap
        .name("row")
        .or_else(|| cap.name("row2"))?
        .as_str()
        .parse::<usize>()
        .ok()?;
    let col = col_from_name(col_text)?;
    let key = Key {
        sheet: sheet_name,
        row,
        col,
    };
    let Some(next) = transform_key(&key, edit) else {
        return Some("#REF!".to_string());
    };
    let prefix = sheet_token
        .map(|token| format!("{token}!"))
        .unwrap_or_default();
    Some(format!(
        "{prefix}{col_abs}{}{row_abs}{}",
        col_to_name(next.col),
        next.row
    ))
}

fn formula_offset_in_string_literal(formula: &str, offset: usize) -> bool {
    let mut in_string = false;
    let bytes = formula.as_bytes();
    let mut idx = 0usize;
    while idx < offset && idx < bytes.len() {
        if bytes[idx] == b'"' {
            if in_string && idx + 1 < bytes.len() && bytes[idx + 1] == b'"' {
                idx += 2;
                continue;
            }
            in_string = !in_string;
        }
        idx += 1;
    }
    in_string
}

fn formula_offset_in_bracket_ref(formula: &str, offset: usize) -> bool {
    let before = &formula[..offset];
    before.rfind('[') > before.rfind(']')
}

fn unquote_sheet_name(value: &str) -> String {
    value
        .strip_prefix('\'')
        .and_then(|text| text.strip_suffix('\''))
        .map(|text| text.replace("''", "'"))
        .unwrap_or_else(|| value.to_string())
}

fn transform_range_ref(range: &str, default_sheet: &str, edit: &StructureEdit) -> Option<String> {
    if range.contains('!') {
        let rewritten = rewrite_formula_structure_refs(range, default_sheet, edit);
        if rewritten.contains("#REF!") {
            None
        } else {
            Some(rewritten)
        }
    } else {
        let mut parts = range.split(':');
        let first = parts.next()?;
        let second = parts.next().unwrap_or(first);
        let (start_col, start_row) = parse_a1(first)?;
        let (end_col, end_row) = parse_a1(second)?;
        let start_key = Key {
            sheet: edit.sheet.clone(),
            row: start_row,
            col: start_col,
        };
        let end_key = Key {
            sheet: edit.sheet.clone(),
            row: end_row,
            col: end_col,
        };
        let start_next = transform_key(&start_key, edit)?;
        let end_next = transform_key(&end_key, edit)?;
        Some(format!(
            "{}{}:{}{}",
            col_to_name(start_next.col),
            start_next.row,
            col_to_name(end_next.col),
            end_next.row
        ))
    }
}

fn transform_sqref_ref(sqref: &str, default_sheet: &str, edit: &StructureEdit) -> Option<String> {
    let mut refs = Vec::new();
    for token in sqref.split_whitespace() {
        let rewritten = transform_range_ref(token, default_sheet, edit)?;
        if !token.contains(':') {
            let collapsed = collapse_single_cell_range(&rewritten);
            refs.push(collapsed);
        } else {
            refs.push(rewritten);
        }
    }
    if refs.is_empty() {
        None
    } else {
        Some(refs.join(" "))
    }
}

fn collapse_single_cell_range(range: &str) -> String {
    let mut parts = range.split(':');
    let Some(first) = parts.next() else {
        return range.to_string();
    };
    let Some(second) = parts.next() else {
        return range.to_string();
    };
    if first == second {
        first.to_string()
    } else {
        range.to_string()
    }
}

fn table_ref(table: &TableInfo) -> String {
    format!(
        "{}{}:{}{}",
        col_to_name(table.start_col),
        table.start_row,
        col_to_name(table.end_col),
        table.end_row
    )
}

fn apply_table_shift(table: &mut TableInfo, edit: &StructureEdit) {
    match edit.axis {
        StructureAxis::Row => {
            let (start, end) = shift_span(table.start_row, table.end_row, edit);
            table.start_row = start;
            table.end_row = end.max(start);
            table.totals_row = table
                .totals_row
                .and_then(|row| transform_coord(row, edit))
                .or_else(|| (table.end_row >= table.start_row).then_some(table.end_row));
        }
        StructureAxis::Col => {
            let (start, end) = shift_span(table.start_col, table.end_col, edit);
            table.start_col = start;
            table.end_col = end.max(start);
        }
    }
}

fn shift_span(start: usize, end: usize, edit: &StructureEdit) -> (usize, usize) {
    match edit.kind {
        StructureOpKind::Insert => {
            let count = edit.end - edit.start + 1;
            if edit.start <= start {
                (start + count, end + count)
            } else if edit.start <= end + 1 {
                (start, end + count)
            } else {
                (start, end)
            }
        }
        StructureOpKind::Delete => {
            let removed_before = overlap_len(edit.start, edit.end, 1, start.saturating_sub(1));
            let removed_inside = overlap_len(edit.start, edit.end, start, end);
            let next_start = start.saturating_sub(removed_before).max(1);
            let next_end = end
                .saturating_sub(removed_before + removed_inside)
                .max(next_start);
            (next_start, next_end)
        }
        StructureOpKind::Move => {
            let start_next = transform_coord(start, edit).unwrap_or(start);
            let end_next = transform_coord(end, edit).unwrap_or(end);
            (start_next.min(end_next), start_next.max(end_next))
        }
    }
}

fn overlap_len(a_start: usize, a_end: usize, b_start: usize, b_end: usize) -> usize {
    if b_start == 0 || a_end < b_start || b_end < a_start {
        0
    } else {
        a_end.min(b_end) - a_start.max(b_start) + 1
    }
}

fn rewrite_formula_sheet_ref(formula: &str, old_name: &str, new_name: &str) -> String {
    let quoted_old = format!("'{}'!", old_name.replace('\'', "''"));
    let quoted_new = format!("'{}'!", new_name.replace('\'', "''"));
    let mut out = formula.replace(&quoted_old, &quoted_new);
    if simple_sheet_name(old_name) {
        let re = Regex::new(&format!(r#"\b{}!"#, regex::escape(old_name))).unwrap();
        let replacement = if simple_sheet_name(new_name) {
            format!("{new_name}!")
        } else {
            quoted_new
        };
        out = re.replace_all(&out, replacement.as_str()).to_string();
    }
    out
}

fn simple_sheet_name(name: &str) -> bool {
    name.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn infer_semantic_type(meta: &ShadowMetaRecord) -> String {
    if meta.cell_type == "formula" {
        return "formula".to_string();
    }
    if meta.cell_type == "bool" || meta.cell_type == "error" || meta.cell_type == "blank" {
        return meta.cell_type.clone();
    }
    if meta.cell_type == "string" {
        return "string".to_string();
    }
    let fmt = meta.number_format.to_ascii_lowercase();
    if fmt.contains('%') {
        return "percentage".to_string();
    }
    if fmt.contains('y') || fmt.contains('d') || fmt.contains("m/") || fmt.contains("mm-") {
        return "date".to_string();
    }
    "number".to_string()
}

fn canonical_cell_value(raw_value: &str, semantic_type: &str) -> String {
    match semantic_type {
        "date" => excel_serial_to_date(raw_value).unwrap_or_else(|| raw_value.to_string()),
        "bool" => match raw_value {
            "1" => "true".to_string(),
            "0" => "false".to_string(),
            _ => raw_value.to_ascii_lowercase(),
        },
        _ => raw_value.to_string(),
    }
}

fn display_cell_value(canonical_value: &str, semantic_type: &str) -> String {
    match semantic_type {
        "percentage" => canonical_value
            .parse::<f64>()
            .map(|value| format!("{}%", format_number(value * 100.0)))
            .unwrap_or_else(|_| canonical_value.to_string()),
        "bool" => match canonical_value {
            "true" => "TRUE".to_string(),
            "false" => "FALSE".to_string(),
            _ => canonical_value.to_string(),
        },
        _ => canonical_value.to_string(),
    }
}

fn excel_serial_to_date(raw_value: &str) -> Option<String> {
    let serial = raw_value.parse::<f64>().ok()?.floor() as i64;
    if serial < 1 {
        return None;
    }

    let mut year = 1900;
    let mut month = 1;
    let mut day = 1;
    let mut remaining = serial - 1;
    if serial >= 60 {
        remaining -= 1;
    }

    while remaining > 0 {
        day += 1;
        if day > days_in_month(year, month) {
            day = 1;
            month += 1;
            if month > 12 {
                month = 1;
                year += 1;
            }
        }
        remaining -= 1;
    }

    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 30,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn sqlite_table_name(sheet_name: &str) -> String {
    let mut out = String::from("sheet_");
    for ch in sheet_name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out == "sheet_" {
        out.push_str("unnamed");
    }
    out
}

fn sqlite_quote_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sqlite_quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sqlite_value_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => format_number(value),
        ValueRef::Text(value) => String::from_utf8_lossy(value).to_string(),
        ValueRef::Blob(value) => format!("<blob:{} bytes>", value.len()),
    }
}

fn query_sqlite_connection(conn: &Connection, sql: &str) -> PyResult<Vec<HashMap<String, String>>> {
    let mut stmt = conn.prepare(sql).map_err(to_py_runtime)?;
    let column_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|name| name.to_string())
        .collect();
    let mut rows = stmt.query([]).map_err(to_py_runtime)?;
    let mut result = Vec::new();

    while let Some(row) = rows.next().map_err(to_py_runtime)? {
        let mut item = HashMap::new();
        for (idx, name) in column_names.iter().enumerate() {
            let value = sqlite_value_to_string(row.get_ref(idx).map_err(to_py_runtime)?);
            item.insert(name.clone(), value);
        }
        result.push(item);
    }

    Ok(result)
}

fn open_existing_store(sqlite_path: &str) -> PyResult<Connection> {
    if !Path::new(sqlite_path).exists() {
        return Err(PyValueError::new_err(format!(
            "store_path_error: SQLite store not found: {sqlite_path}"
        )));
    }
    let conn = Connection::open(sqlite_path).map_err(to_py_runtime)?;
    ensure_store_schema_readable(&conn)?;
    Ok(conn)
}

fn ensure_store_schema_readable(conn: &Connection) -> PyResult<()> {
    for table in ["ss_workbook", "ss_sheet", "ss_cell_snapshot"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .map_err(to_py_runtime)?;
        if exists == 0 {
            return Err(PyValueError::new_err(format!(
                "store_schema_error: missing table {table}"
            )));
        }
    }
    Ok(())
}

fn install_store_update_triggers(conn: &Connection) -> PyResult<()> {
    conn.execute_batch(
        "
        DROP TABLE IF EXISTS temp.ss_pending_store_update;
        CREATE TEMP TABLE ss_pending_store_update(
            sheet TEXT NOT NULL,
            row_idx INTEGER NOT NULL,
            col_idx INTEGER NOT NULL,
            value TEXT NOT NULL
        );
        ",
    )
    .map_err(to_py_runtime)?;

    let sheets = query_sqlite_connection(
        conn,
        "SELECT name, table_name FROM ss_sheet ORDER BY sheet_index",
    )?;
    for sheet in sheets {
        let sheet_name = sheet.get("name").cloned().unwrap_or_default();
        let table_name = sheet.get("table_name").cloned().unwrap_or_default();
        if table_name.is_empty() {
            return Err(PyValueError::new_err(
                "store_schema_error: missing sheet view table_name",
            ));
        }
        let max_col: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(col_idx), 0) FROM ss_cell_snapshot WHERE workbook_id = 1 AND sheet = ?1",
                params![sheet_name],
                |row| row.get(0),
            )
            .map_err(to_py_runtime)?;
        let max_col = max_col.max(1) as usize;
        let trigger_name = format!("ss_store_update_{}", table_name);
        let mut statements = Vec::new();
        statements.push(
            "SELECT CASE WHEN NEW.row_id IS NOT OLD.row_id THEN RAISE(ABORT, 'unsafe_update: store-backed SQLite update does not allow row_id changes') END".to_string(),
        );
        for col in 1..=max_col {
            let col_name = col_to_name(col);
            statements.push(format!(
                "INSERT INTO ss_pending_store_update(sheet, row_idx, col_idx, value)
                 SELECT {}, OLD.row_id, {col}, COALESCE(NEW.{col_ident}, '')
                 WHERE COALESCE(OLD.{col_ident}, '') IS NOT COALESCE(NEW.{col_ident}, '')",
                sqlite_quote_literal(&sheet_name),
                col_ident = sqlite_quote_ident(&col_name)
            ));
        }
        let trigger_sql = format!(
            "CREATE TEMP TRIGGER {} INSTEAD OF UPDATE ON {} BEGIN {}; END",
            sqlite_quote_ident(&trigger_name),
            sqlite_quote_ident(&table_name),
            statements.join("; ")
        );
        conn.execute(&trigger_sql, []).map_err(to_py_runtime)?;
    }
    Ok(())
}

fn drop_store_update_triggers(conn: &Connection) -> PyResult<()> {
    let triggers = query_sqlite_connection(
        conn,
        "SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'ss_store_update_%'",
    )?;
    for trigger in triggers {
        let name = trigger.get("name").cloned().unwrap_or_default();
        if !name.is_empty() {
            conn.execute(
                &format!("DROP TRIGGER IF EXISTS {}", sqlite_quote_ident(&name)),
                [],
            )
            .map_err(to_py_runtime)?;
        }
    }
    Ok(())
}

fn read_pending_store_updates(conn: &Connection) -> PyResult<Vec<PendingSqliteUpdate>> {
    let mut stmt = conn
        .prepare(
            "SELECT sheet, row_idx, col_idx, value
             FROM ss_pending_store_update
             ORDER BY sheet, row_idx, col_idx",
        )
        .map_err(to_py_runtime)?;
    let updates = stmt
        .query_map([], |row| {
            Ok(PendingSqliteUpdate {
                sheet: row.get(0)?,
                row: row.get::<_, i64>(1)? as usize,
                col: row.get::<_, i64>(2)? as usize,
                value: row.get(3)?,
            })
        })
        .map_err(to_py_runtime)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_py_runtime)?;
    Ok(updates)
}

fn store_snapshot_matches_runtime(conn: &Connection, engine: &SheetShadowEngine) -> PyResult<bool> {
    let source_path: String = conn
        .query_row(
            "SELECT source_path FROM ss_workbook WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(to_py_runtime)?;
    let runtime_source_path = engine
        .source_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    if source_path != runtime_source_path {
        return Ok(false);
    }
    let snapshot_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ss_cell_snapshot WHERE workbook_id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(to_py_runtime)?;
    if snapshot_count as usize != engine.cells.len() {
        return Ok(false);
    }
    let mut stmt = conn
        .prepare(
            "SELECT sheet, row_idx, col_idx, value
             FROM ss_cell_snapshot
             WHERE workbook_id = 1",
        )
        .map_err(to_py_runtime)?;
    let mut rows = stmt.query([]).map_err(to_py_runtime)?;
    while let Some(row) = rows.next().map_err(to_py_runtime)? {
        let key = Key {
            sheet: row.get(0).map_err(to_py_runtime)?,
            row: row.get::<_, i64>(1).map_err(to_py_runtime)? as usize,
            col: row.get::<_, i64>(2).map_err(to_py_runtime)? as usize,
        };
        let value: String = row.get(3).map_err(to_py_runtime)?;
        if engine.cells.get(&key) != Some(&value) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn sqlite_count(conn: &Connection, table: &str) -> PyResult<i64> {
    let sql = format!("SELECT COUNT(*) FROM {}", sqlite_quote_ident(table));
    conn.query_row(&sql, [], |row| row.get(0))
        .map_err(to_py_runtime)
}

fn create_snapshot_schema(conn: &Connection) -> PyResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ss_migration(
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ss_workbook(
            id INTEGER PRIMARY KEY,
            source_path TEXT NOT NULL,
            sheet_count INTEGER NOT NULL,
            cell_count INTEGER NOT NULL,
            formula_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ss_session(
            id TEXT PRIMARY KEY,
            workbook_id INTEGER NOT NULL,
            state TEXT NOT NULL,
            modified_count INTEGER NOT NULL,
            dirty_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ss_sheet(
            workbook_id INTEGER NOT NULL,
            sheet_index INTEGER NOT NULL,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            table_name TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(workbook_id, name)
        );
        CREATE TABLE IF NOT EXISTS ss_cell_snapshot(
            workbook_id INTEGER NOT NULL,
            sheet TEXT NOT NULL,
            row_idx INTEGER NOT NULL,
            col_idx INTEGER NOT NULL,
            value TEXT NOT NULL,
            is_formula INTEGER NOT NULL,
            PRIMARY KEY(workbook_id, sheet, row_idx, col_idx)
        );
        CREATE TABLE IF NOT EXISTS ss_shadow_meta(
            workbook_id INTEGER NOT NULL,
            sheet TEXT NOT NULL,
            row_idx INTEGER NOT NULL,
            col_idx INTEGER NOT NULL,
            cell_type TEXT NOT NULL,
            style_id INTEGER,
            number_format TEXT NOT NULL,
            original_formula TEXT NOT NULL,
            cached_value_before TEXT NOT NULL,
            cached_value_after TEXT NOT NULL,
            merge_range TEXT NOT NULL,
            is_modified INTEGER NOT NULL,
            is_dirty INTEGER NOT NULL,
            PRIMARY KEY(workbook_id, sheet, row_idx, col_idx)
        );
        CREATE TABLE IF NOT EXISTS ss_audit_event(
            id INTEGER PRIMARY KEY,
            workbook_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            sheet TEXT NOT NULL,
            row_idx INTEGER NOT NULL,
            col_idx INTEGER NOT NULL,
            old_value TEXT NOT NULL,
            new_value TEXT NOT NULL,
            formula TEXT NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ss_formula_edge(
            workbook_id INTEGER NOT NULL,
            formula_sheet TEXT NOT NULL,
            formula_row INTEGER NOT NULL,
            formula_col INTEGER NOT NULL,
            precedent_sheet TEXT NOT NULL,
            precedent_row INTEGER NOT NULL,
            precedent_col INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ss_graph_node(
            namespace TEXT NOT NULL,
            node_id TEXT NOT NULL,
            label TEXT NOT NULL,
            PRIMARY KEY(namespace, node_id)
        );
        CREATE TABLE IF NOT EXISTS ss_graph_edge(
            src_namespace TEXT NOT NULL,
            src_id TEXT NOT NULL,
            dst_namespace TEXT NOT NULL,
            dst_id TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        ",
    )
    .map_err(to_py_runtime)?;
    ensure_column(conn, "ss_sheet", "table_name", "TEXT NOT NULL DEFAULT ''")?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> PyResult<()> {
    let pragma = format!("PRAGMA table_info({})", sqlite_quote_ident(table));
    let mut stmt = conn.prepare(&pragma).map_err(to_py_runtime)?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(to_py_runtime)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_py_runtime)?;
    if !columns.iter().any(|item| item == column) {
        let sql = format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            sqlite_quote_ident(table),
            sqlite_quote_ident(column),
            definition
        );
        conn.execute(&sql, []).map_err(to_py_runtime)?;
    }
    Ok(())
}

fn store_sheet_view_names(conn: &Connection) -> PyResult<Vec<String>> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ss_sheet'",
            [],
            |row| row.get(0),
        )
        .map_err(to_py_runtime)?;
    if exists == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT table_name FROM ss_sheet WHERE table_name <> ''")
        .map_err(to_py_runtime)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_py_runtime)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_py_runtime)?;
    Ok(names)
}

fn create_store_sheet_views(
    conn: &Connection,
    engine: &SheetShadowEngine,
    table_map: &HashMap<String, String>,
) -> PyResult<()> {
    for sheet in &engine.sheets {
        let table_name = table_map
            .get(&sheet.name)
            .ok_or_else(|| PyRuntimeError::new_err("missing SQLite store table mapping"))?;
        conn.execute(
            &format!("DROP VIEW IF EXISTS {}", sqlite_quote_ident(table_name)),
            [],
        )
        .map_err(to_py_runtime)?;

        let (_, max_col) = engine.sheet_bounds(&sheet.name);
        let max_col = max_col.max(1);
        let mut columns = Vec::new();
        columns.push("row_idx AS row_id".to_string());
        for col in 1..=max_col {
            columns.push(format!(
                "COALESCE(MAX(CASE WHEN col_idx = {col} THEN value END), '') AS {}",
                sqlite_quote_ident(&col_to_name(col))
            ));
        }
        let sql = format!(
            "CREATE VIEW {} AS SELECT {} FROM ss_cell_snapshot WHERE workbook_id = 1 AND sheet = {} GROUP BY row_idx",
            sqlite_quote_ident(table_name),
            columns.join(", "),
            sqlite_quote_literal(&sheet.name)
        );
        conn.execute(&sql, []).map_err(to_py_runtime)?;
    }
    Ok(())
}

fn insert_graph_node(
    conn: &Connection,
    namespace: &str,
    node_id: &str,
    label: &str,
) -> PyResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO ss_graph_node(namespace, node_id, label) VALUES (?1, ?2, ?3)",
        params![namespace, node_id, label],
    )
    .map(|_| ())
    .map_err(to_py_runtime)
}

fn insert_graph_edge(
    conn: &Connection,
    src_namespace: &str,
    src_id: &str,
    dst_namespace: &str,
    dst_id: &str,
    kind: &str,
) -> PyResult<()> {
    conn.execute(
        "INSERT INTO ss_graph_edge(src_namespace, src_id, dst_namespace, dst_id, kind)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![src_namespace, src_id, dst_namespace, dst_id, kind],
    )
    .map(|_| ())
    .map_err(to_py_runtime)
}

fn graph_sheet_id(sheet_name: &str) -> String {
    format!("sheet:{sheet_name}")
}

fn graph_cell_id(key: &Key) -> String {
    format!("{}!{}{}", key.sheet, col_to_name(key.col), key.row)
}

fn child_text(node: roxmltree::Node<'_, '_>, child_name: &str) -> String {
    node.children()
        .find(|child| child.tag_name().name() == child_name)
        .and_then(|child| child.text())
        .unwrap_or("")
        .to_string()
}

fn extract_deps(
    formula: &str,
    formula_key: &Key,
    cells: &HashMap<Key, String>,
    sheet_order: &[String],
    defined_names: &[DefinedName],
    formula_keys: &HashSet<Key>,
    tables: &[TableInfo],
) -> HashSet<Key> {
    let literal_stripped = strip_formula_string_literals(formula);
    let structured_deps =
        structured_table_ref_deps(&literal_stripped, formula_key, cells, formula_keys, tables);
    let scanned = mask_unsupported_dependency_tokens(&literal_stripped);
    let (defined_deps, scanned) = extract_defined_name_deps(
        &scanned,
        &formula_key.sheet,
        cells,
        sheet_order,
        defined_names,
    );
    let mut deps = extract_deps_regex(&scanned, &formula_key.sheet, cells, sheet_order);
    deps.extend(defined_deps);
    deps.extend(structured_deps);
    deps
}

fn formula_dependency_diagnostics(
    key: &Key,
    formula: &str,
    cells: &HashMap<Key, String>,
    formula_keys: &HashSet<Key>,
    tables: &[TableInfo],
    defined_names: &[DefinedName],
    sheet_order: &[String],
) -> Vec<HashMap<String, String>> {
    let literal_stripped = strip_formula_string_literals(formula);
    let mut diagnostics = Vec::new();

    for item in external_workbook_ref_regex().find_iter(&literal_stripped) {
        diagnostics.push(dependency_diagnostic(
            key,
            formula,
            "warning",
            "external_workbook_ref_unsupported",
            "External workbook references are not loaded by Sheet Shadow dependency extraction.",
            &[
                ("token", item.as_str()),
                ("not_completed", "external_workbook_dependency_resolution"),
                ("fallback", "external_ref_masked_local_refs_preserved"),
            ],
        ));
    }

    diagnostics.extend(structured_ref_diagnostics(
        key,
        formula,
        &literal_stripped,
        cells,
        formula_keys,
        tables,
    ));
    diagnostics.extend(defined_name_diagnostics(
        key,
        formula,
        &literal_stripped,
        cells,
        sheet_order,
        defined_names,
    ));

    diagnostics
}

fn dependency_diagnostic(
    key: &Key,
    formula: &str,
    severity: &str,
    code: &str,
    message: &str,
    fields: &[(&str, &str)],
) -> HashMap<String, String> {
    let mut out = HashMap::from([
        ("severity".to_string(), severity.to_string()),
        ("code".to_string(), code.to_string()),
        ("sheet".to_string(), key.sheet.clone()),
        ("row".to_string(), key.row.to_string()),
        ("col".to_string(), key.col.to_string()),
        (
            "cell".to_string(),
            format!("{}{}", col_to_name(key.col), key.row),
        ),
        ("formula".to_string(), formula.to_string()),
        ("message".to_string(), message.to_string()),
    ]);
    for (field, value) in fields {
        out.insert((*field).to_string(), (*value).to_string());
    }
    out
}

fn structured_ref_diagnostics(
    key: &Key,
    formula: &str,
    literal_stripped: &str,
    cells: &HashMap<Key, String>,
    formula_keys: &HashSet<Key>,
    tables: &[TableInfo],
) -> Vec<HashMap<String, String>> {
    if !has_structured_table_ref(literal_stripped) {
        return Vec::new();
    }

    let conservative_dep_count = cells
        .keys()
        .filter(|cell_key| !formula_keys.contains(*cell_key))
        .count()
        .to_string();
    let Some(refs) = structured_ref_specs(literal_stripped) else {
        return vec![dependency_diagnostic(
            key,
            formula,
            "warning",
            "structured_table_ref_parse_fallback",
            "Structured table reference syntax could not be parsed precisely.",
            &[
                (
                    "not_completed",
                    "precise_structured_table_dependency_resolution",
                ),
                ("fallback", "all_current_non_formula_workbook_cells"),
                ("fallback_dep_count", &conservative_dep_count),
            ],
        )];
    };

    let mut diagnostics = Vec::new();
    for (table_name, selector) in refs {
        let Some(table) = tables
            .iter()
            .find(|table| table.name.eq_ignore_ascii_case(table_name))
        else {
            diagnostics.push(dependency_diagnostic(
                key,
                formula,
                "warning",
                "structured_table_ref_table_not_found",
                "Structured table metadata was not found; dependency extraction used conservative coverage.",
                &[
                    ("table", table_name),
                    ("selector", selector),
                    ("not_completed", "structured_table_metadata_lookup"),
                    ("fallback", "all_current_non_formula_workbook_cells"),
                    ("fallback_dep_count", &conservative_dep_count),
                ],
            ));
            continue;
        };

        if let Some((selector_kind, dependency_shape)) =
            structured_ref_dependency_shape(table, selector, key)
        {
            diagnostics.push(dependency_diagnostic(
                key,
                formula,
                "info",
                "structured_table_ref_precise",
                "Structured table reference dependencies were resolved from table metadata.",
                &[
                    ("table", table_name),
                    ("selector", selector),
                    ("selector_kind", selector_kind),
                    ("dependency_shape", dependency_shape),
                    (
                        "row_scope",
                        structured_row_scope_status(tables, table, selector, key),
                    ),
                    (
                        "completed",
                        "precise_structured_table_dependency_resolution",
                    ),
                ],
            ));
            if let Some((selector_kind, start_column, end_column)) =
                structured_reverse_column_range(table, selector)
            {
                diagnostics.push(dependency_diagnostic(
                    key,
                    formula,
                    "warning",
                    "structured_table_ref_reverse_column_range",
                    "Structured table column range was written in reverse order; dependency extraction normalized it to the contiguous table column span.",
                    &[
                        ("table", table_name),
                        ("selector", selector),
                        ("selector_kind", selector_kind),
                        ("start_column", start_column),
                        ("end_column", end_column),
                        (
                            "not_completed",
                            "structured_table_reverse_column_order_semantics",
                        ),
                        ("fallback", "normalized_contiguous_column_span"),
                    ],
                ));
            }
        } else {
            let boundary = structured_ref_boundary(tables, table, selector, key);
            let missing_columns = boundary.missing_columns.join(",");
            diagnostics.push(dependency_diagnostic(
                key,
                formula,
                "warning",
                boundary.code,
                boundary.message,
                &[
                    ("table", table_name),
                    ("selector", selector),
                    ("not_completed", boundary.not_completed),
                    ("selector_kind", boundary.selector_kind),
                    ("row_scope", boundary.row_scope),
                    ("missing_columns", &missing_columns),
                    (
                        "table_data_rows",
                        &format!("{}:{}", table.data_start_row(), table.data_end_row()),
                    ),
                    ("fallback", "all_current_non_formula_workbook_cells"),
                    ("fallback_dep_count", &conservative_dep_count),
                ],
            ));
        }
    }

    diagnostics
}

fn structured_ref_dependency_shape(
    table: &TableInfo,
    selector: &str,
    formula_key: &Key,
) -> Option<(&'static str, &'static str)> {
    let selector = selector.trim();
    if selector.eq_ignore_ascii_case("[#All]") {
        return Some(("all", "full_table_ref_range"));
    }
    if selector.eq_ignore_ascii_case("[#Data]") {
        return Some(("data", "data_body_range"));
    }
    if selector.eq_ignore_ascii_case("[#Headers]") {
        return Some(("headers", "header_row_range"));
    }
    if selector.eq_ignore_ascii_case("[#Totals]") {
        return table.totals_row.map(|_| ("totals", "totals_row_range"));
    }
    if let Some(column_name) = simple_structured_column(selector) {
        return table
            .columns
            .iter()
            .any(|column| column.eq_ignore_ascii_case(column_name.trim()))
            .then_some(("column", "data_column_range"));
    }
    if let Some((selector_kind, start_column, end_column)) = structured_column_range(selector) {
        let dependency_shape = match selector_kind {
            "column_range" => "data_column_range_span",
            "data_column_range" => "data_column_range_span",
            "all_column_range" => "full_table_column_range_span",
            "header_column_range" => "header_column_range_cells",
            "totals_column_range" => "totals_column_range_cells",
            _ => return None,
        };
        return table
            .column_span(start_column, end_column)
            .map(|_| (selector_kind, dependency_shape));
    }
    if let Some((selector_kind, column_name)) = structured_qualified_column(selector) {
        let dependency_shape = match selector_kind {
            "data_column" => "data_column_range",
            "all_column" => "full_table_column_range",
            "header_column" => "header_column_cell",
            "totals_column" => "totals_column_cell",
            _ => return None,
        };
        return table
            .columns
            .iter()
            .any(|column| column.eq_ignore_ascii_case(column_name.trim()))
            .then_some((selector_kind, dependency_shape));
    }
    if let Some(column_name) = structured_row_scoped_column(selector) {
        return (formula_cell_in_table_data_row(formula_key, table)
            && table
                .columns
                .iter()
                .any(|column| column.eq_ignore_ascii_case(column_name.trim())))
        .then_some(("row_column", "current_table_row_column_cell"));
    }
    None
}

struct StructuredRefBoundary {
    code: &'static str,
    message: &'static str,
    not_completed: &'static str,
    selector_kind: &'static str,
    row_scope: &'static str,
    missing_columns: Vec<String>,
}

fn structured_ref_boundary(
    tables: &[TableInfo],
    table: &TableInfo,
    selector: &str,
    formula_key: &Key,
) -> StructuredRefBoundary {
    let row_scope = structured_row_scope_status(tables, table, selector, formula_key);

    if let Some(column_name) = simple_structured_column(selector) {
        return unknown_column_boundary(table, "column", row_scope, &[column_name]);
    }
    if let Some((selector_kind, start_column, end_column)) = structured_column_range(selector) {
        let columns = [start_column, end_column];
        let missing = missing_table_columns(table, &columns);
        if !missing.is_empty() {
            return StructuredRefBoundary {
                code: "structured_table_ref_unknown_column",
                message: "Structured table reference named one or more columns that were not found in table metadata; dependency extraction used conservative coverage.",
                not_completed: "structured_table_column_resolution",
                selector_kind,
                row_scope,
                missing_columns: missing,
            };
        }
        if selector_kind == "totals_column_range" && table.totals_row.is_none() {
            return totals_metadata_boundary(selector_kind, row_scope);
        }
    }
    if let Some((selector_kind, column_name)) = structured_qualified_column(selector) {
        if !table.has_column(column_name) {
            return unknown_column_boundary(table, selector_kind, row_scope, &[column_name]);
        }
        if selector_kind == "totals_column" && table.totals_row.is_none() {
            return totals_metadata_boundary(selector_kind, row_scope);
        }
    }
    if let Some(column_name) = structured_row_scoped_column(selector) {
        if !table.has_column(column_name) {
            return unknown_column_boundary(table, "row_column", row_scope, &[column_name]);
        }
        return StructuredRefBoundary {
            code: "structured_table_ref_row_scope_mismatch",
            message: "Structured table row-scoped selector could not be resolved for the formula cell's table context; dependency extraction used conservative coverage.",
            not_completed: "row_scoped_structured_table_dependency_resolution",
            selector_kind: "row_column",
            row_scope,
            missing_columns: Vec::new(),
        };
    }
    if selector.trim().eq_ignore_ascii_case("[#Totals]") {
        return totals_metadata_boundary("totals", row_scope);
    }

    let selector_lower = selector.to_ascii_lowercase();
    if selector_lower.matches("],[").count() > 1
        || selector_lower.contains("[#") && selector_lower.contains(':')
    {
        StructuredRefBoundary {
            code: "structured_table_ref_complex_selector",
            message: "Structured table selector uses a complex shape that is not yet precisely supported; dependency extraction used conservative coverage.",
            not_completed: "complex_structured_table_selector_resolution",
            selector_kind: "complex_selector",
            row_scope,
            missing_columns: Vec::new(),
        }
    } else {
        StructuredRefBoundary {
            code: "structured_table_ref_unsupported_selector",
            message: "Structured table selector is not yet precisely supported; dependency extraction used conservative coverage.",
            not_completed: "precise_structured_table_dependency_resolution",
            selector_kind: "unsupported_selector",
            row_scope,
            missing_columns: Vec::new(),
        }
    }
}

fn structured_row_scope_status(
    tables: &[TableInfo],
    table: &TableInfo,
    selector: &str,
    formula_key: &Key,
) -> &'static str {
    if structured_row_scoped_column(selector).is_none() {
        return "";
    }
    if formula_key.sheet != table.sheet {
        return "formula_cell_not_on_table_sheet";
    }
    if !formula_cell_in_table_data_row(formula_key, table) {
        if formula_cell_in_other_table_data_row(formula_key, table, tables) {
            return "formula_cell_in_different_table_data_row";
        }
        return "formula_cell_outside_table_data_body";
    }
    "same_table_data_row"
}

fn formula_cell_in_table_data_row(formula_key: &Key, table: &TableInfo) -> bool {
    formula_key.sheet == table.sheet
        && formula_key.row >= table.data_start_row()
        && formula_key.row <= table.data_end_row()
        && formula_key.col >= table.start_col
        && formula_key.col <= table.end_col
}

fn formula_cell_in_other_table_data_row(
    formula_key: &Key,
    referenced_table: &TableInfo,
    tables: &[TableInfo],
) -> bool {
    tables.iter().any(|table| {
        !table.name.eq_ignore_ascii_case(&referenced_table.name)
            && formula_cell_in_table_data_row(formula_key, table)
    })
}

fn unknown_column_boundary(
    table: &TableInfo,
    selector_kind: &'static str,
    row_scope: &'static str,
    columns: &[&str],
) -> StructuredRefBoundary {
    StructuredRefBoundary {
        code: "structured_table_ref_unknown_column",
        message: "Structured table reference named one or more columns that were not found in table metadata; dependency extraction used conservative coverage.",
        not_completed: "structured_table_column_resolution",
        selector_kind,
        row_scope,
        missing_columns: missing_table_columns(table, columns),
    }
}

fn missing_table_columns(table: &TableInfo, columns: &[&str]) -> Vec<String> {
    columns
        .iter()
        .filter(|column| !table.has_column(column))
        .map(|column| (*column).to_string())
        .collect()
}

fn totals_metadata_boundary(
    selector_kind: &'static str,
    row_scope: &'static str,
) -> StructuredRefBoundary {
    StructuredRefBoundary {
        code: "structured_table_ref_totals_metadata_missing",
        message: "Structured table totals selector could not be resolved because table totals-row metadata was not present; dependency extraction used conservative coverage.",
        not_completed: "structured_table_totals_dependency_resolution",
        selector_kind,
        row_scope,
        missing_columns: Vec::new(),
    }
}

fn structured_reverse_column_range<'a>(
    table: &TableInfo,
    selector: &'a str,
) -> Option<(&'static str, &'a str, &'a str)> {
    let (selector_kind, start_column, end_column) = structured_column_range(selector)?;
    let start_offset = table.column_offset(start_column)?;
    let end_offset = table.column_offset(end_column)?;
    (start_offset > end_offset).then_some((selector_kind, start_column, end_column))
}

fn defined_name_diagnostics(
    key: &Key,
    formula: &str,
    literal_stripped: &str,
    cells: &HashMap<Key, String>,
    sheet_order: &[String],
    defined_names: &[DefinedName],
) -> Vec<HashMap<String, String>> {
    if defined_names.is_empty() {
        return Vec::new();
    }

    let lookup = defined_name_lookup(defined_names, &key.sheet);
    let name_re = Regex::new(r"\b[A-Za-z_][A-Za-z0-9_.]*\b").unwrap();
    let mut diagnostics = Vec::new();
    let mut seen = HashSet::new();

    for item in name_re.find_iter(literal_stripped) {
        let token = item.as_str();
        if !seen.insert(token.to_ascii_lowercase()) {
            continue;
        }
        let Some(target) = lookup.get(&token.to_ascii_lowercase()) else {
            continue;
        };
        if !is_defined_name_context(literal_stripped, item.start(), item.end()) {
            continue;
        }

        let target = target.trim().trim_start_matches('=');
        let stripped_target = strip_formula_string_literals(target);
        let masked_target = mask_unsupported_dependency_tokens(&stripped_target);
        let deps = extract_deps_regex(&masked_target, &key.sheet, cells, sheet_order);
        if deps.is_empty() {
            diagnostics.push(dependency_diagnostic(
                key,
                formula,
                "warning",
                "defined_name_unsupported_target",
                "Defined name target did not resolve to simple local dependency ranges.",
                &[
                    ("name", token),
                    ("target", target),
                    ("not_completed", "defined_name_dependency_expansion"),
                ],
            ));
        } else {
            let dep_count = deps.len().to_string();
            diagnostics.push(dependency_diagnostic(
                key,
                formula,
                "info",
                "defined_name_dependency_expanded",
                "Defined name target was expanded into dependency edges.",
                &[
                    ("name", token),
                    ("target", target),
                    ("completed", "defined_name_dependency_expansion"),
                    ("dep_count", &dep_count),
                ],
            ));
        }
    }

    diagnostics
}

fn extract_deps_regex(
    formula: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
    sheet_order: &[String],
) -> HashSet<Key> {
    let mut deps = HashSet::new();
    let re = Regex::new(r"(?i)(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_ ]*(?::[A-Za-z_][A-Za-z0-9_ ]*)?))!)?\$?([A-Z]{1,3})\$?([0-9]+)(?::\$?([A-Z]{1,3})\$?([0-9]+))?").unwrap();

    for cap in re.captures_iter(formula) {
        let sheets = sheet_targets(
            cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str()),
            default_sheet,
            sheet_order,
        );
        let start_col = col_from_name(cap.get(3).unwrap().as_str()).unwrap_or(1);
        let start_row = cap.get(4).unwrap().as_str().parse::<usize>().unwrap_or(1);
        let end_col = cap
            .get(5)
            .and_then(|m| col_from_name(m.as_str()))
            .unwrap_or(start_col);
        let end_row = cap
            .get(6)
            .and_then(|m| m.as_str().parse::<usize>().ok())
            .unwrap_or(start_row);

        for sheet in sheets {
            for row in start_row.min(end_row)..=start_row.max(end_row) {
                for col in start_col.min(end_col)..=start_col.max(end_col) {
                    deps.insert(Key {
                        sheet: sheet.clone(),
                        row,
                        col,
                    });
                }
            }
        }
    }

    let col_re = Regex::new(
        r"(?i)(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_ ]*(?::[A-Za-z_][A-Za-z0-9_ ]*)?))!)?\$?([A-Z]{1,3}):\$?([A-Z]{1,3})",
    )
    .unwrap();
    for cap in col_re.captures_iter(formula) {
        let sheets = sheet_targets(
            cap.get(1).or_else(|| cap.get(2)).map(|m| m.as_str()),
            default_sheet,
            sheet_order,
        );
        let start_col = col_from_name(cap.get(3).unwrap().as_str()).unwrap_or(1);
        let end_col = col_from_name(cap.get(4).unwrap().as_str()).unwrap_or(start_col);
        for sheet in sheets {
            for key in cells.keys() {
                if key.sheet == sheet
                    && key.col >= start_col.min(end_col)
                    && key.col <= start_col.max(end_col)
                {
                    deps.insert(key.clone());
                }
            }
        }
    }

    deps
}

fn sheet_targets(
    sheet_spec: Option<&str>,
    default_sheet: &str,
    sheet_order: &[String],
) -> Vec<String> {
    let spec = sheet_spec.unwrap_or(default_sheet).replace("''", "'");
    let Some((start, end)) = spec.split_once(':') else {
        return vec![spec];
    };
    let Some(start_idx) = sheet_order.iter().position(|sheet| sheet == start) else {
        return vec![spec];
    };
    let Some(end_idx) = sheet_order.iter().position(|sheet| sheet == end) else {
        return vec![spec];
    };
    let lo = start_idx.min(end_idx);
    let hi = start_idx.max(end_idx);
    sheet_order[lo..=hi].to_vec()
}

fn strip_formula_string_literals(formula: &str) -> String {
    let mut out = String::with_capacity(formula.len());
    let mut chars = formula.chars().peekable();
    let mut in_string = false;
    while let Some(ch) = chars.next() {
        if ch == '"' {
            out.push(ch);
            if in_string && chars.peek() == Some(&'"') {
                out.push('"');
                chars.next();
                continue;
            }
            in_string = !in_string;
        } else if in_string {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

fn mask_unsupported_dependency_tokens(formula: &str) -> String {
    let without_external = mask_regex_matches(formula, &external_workbook_ref_regex());
    let without_structured = mask_structured_table_ref_tokens(&without_external);
    let structured_brackets = Regex::new(r"\[[^\]]*\]").unwrap();
    mask_regex_matches(&without_structured, &structured_brackets)
}

fn external_workbook_ref_regex() -> Regex {
    Regex::new(
        r"(?i)(?:'\[[^']+\]'|\[[^\]]+\][^!(),+\-*/^&=<> ]*)!\$?(?:[A-Z]{1,3}\$?[0-9]+(?::\$?[A-Z]{1,3}\$?[0-9]+)?|[A-Z]{1,3}:\$?[A-Z]{1,3})",
    )
    .unwrap()
}

fn mask_regex_matches(input: &str, re: &Regex) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for item in re.find_iter(input) {
        out.push_str(&input[last..item.start()]);
        out.push_str(&" ".repeat(item.end() - item.start()));
        last = item.end();
    }
    out.push_str(&input[last..]);
    out
}

fn mask_structured_table_ref_tokens(input: &str) -> String {
    let Some(spans) = structured_ref_spans(input) else {
        return input.to_string();
    };
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for (start, end) in spans {
        out.push_str(&input[last..start]);
        out.push_str(&" ".repeat(end - start));
        last = end;
    }
    out.push_str(&input[last..]);
    out
}

fn structured_table_ref_deps(
    formula: &str,
    formula_key: &Key,
    cells: &HashMap<Key, String>,
    formula_keys: &HashSet<Key>,
    tables: &[TableInfo],
) -> HashSet<Key> {
    if !has_structured_table_ref(formula) {
        return HashSet::new();
    }
    if let Some(deps) = precise_structured_table_ref_deps(formula, formula_key, tables) {
        return deps;
    }
    cells
        .keys()
        .filter(|key| !formula_keys.contains(*key))
        .cloned()
        .collect()
}

fn precise_structured_table_ref_deps(
    formula: &str,
    formula_key: &Key,
    tables: &[TableInfo],
) -> Option<HashSet<Key>> {
    let mut deps = HashSet::new();
    let mut matched = false;

    for (table_name, selector) in structured_ref_specs(formula)? {
        let Some(table) = tables
            .iter()
            .find(|table| table.name.eq_ignore_ascii_case(table_name))
        else {
            return None;
        };
        add_structured_ref_deps(&mut deps, table, formula_key, selector)?;
        matched = true;
    }

    matched.then_some(deps)
}

fn structured_ref_specs(formula: &str) -> Option<Vec<(&str, &str)>> {
    Some(
        structured_ref_spans(formula)?
            .into_iter()
            .map(|(name_start, selector_end)| {
                let selector_start = formula[name_start..selector_end]
                    .find('[')
                    .map(|offset| name_start + offset)
                    .unwrap_or(selector_end);
                (
                    formula[name_start..selector_start].trim(),
                    &formula[selector_start..selector_end],
                )
            })
            .collect(),
    )
}

fn structured_ref_spans(formula: &str) -> Option<Vec<(usize, usize)>> {
    let bytes = formula.as_bytes();
    let mut refs = Vec::new();
    let mut idx = 0usize;

    while idx < bytes.len() {
        if !is_table_name_start(bytes[idx])
            || idx
                .checked_sub(1)
                .is_some_and(|prev| is_table_name_continue(bytes[prev]))
        {
            idx += 1;
            continue;
        }

        let name_start = idx;
        idx += 1;
        while idx < bytes.len() && is_table_name_continue(bytes[idx]) {
            idx += 1;
        }
        while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if idx >= bytes.len() || bytes[idx] != b'[' {
            continue;
        }

        let mut depth = 0usize;
        while idx < bytes.len() {
            match bytes[idx] {
                b'[' => depth += 1,
                b']' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        idx += 1;
                        refs.push((name_start, idx));
                        break;
                    }
                }
                _ => {}
            }
            idx += 1;
        }
        if depth != 0 {
            return None;
        }
    }

    Some(refs)
}

fn is_table_name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_table_name_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn add_structured_ref_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    formula_key: &Key,
    selector: &str,
) -> Option<()> {
    let selector = selector.trim();
    if selector.eq_ignore_ascii_case("[#All]") {
        add_table_range_deps(
            deps,
            table,
            table.start_row,
            table.end_row,
            table.start_col,
            table.end_col,
        );
        return Some(());
    }
    if selector.eq_ignore_ascii_case("[#Data]") {
        add_table_range_deps(
            deps,
            table,
            table.data_start_row(),
            table.data_end_row(),
            table.start_col,
            table.end_col,
        );
        return Some(());
    }
    if selector.eq_ignore_ascii_case("[#Headers]") {
        add_table_range_deps(
            deps,
            table,
            table.start_row,
            table.start_row,
            table.start_col,
            table.end_col,
        );
        return Some(());
    }
    if selector.eq_ignore_ascii_case("[#Totals]") {
        let totals_row = table.totals_row?;
        add_table_range_deps(
            deps,
            table,
            totals_row,
            totals_row,
            table.start_col,
            table.end_col,
        );
        return Some(());
    }

    if let Some(column_name) = simple_structured_column(selector) {
        add_table_column_data_deps(deps, table, column_name)?;
        return Some(());
    }

    if let Some((selector_kind, start_column, end_column)) = structured_column_range(selector) {
        match selector_kind {
            "column_range" | "data_column_range" => add_table_column_span_deps(
                deps,
                table,
                start_column,
                end_column,
                table.data_start_row(),
                table.data_end_row(),
            )?,
            "all_column_range" => add_table_column_span_deps(
                deps,
                table,
                start_column,
                end_column,
                table.start_row,
                table.end_row,
            )?,
            "header_column_range" => add_table_column_span_deps(
                deps,
                table,
                start_column,
                end_column,
                table.start_row,
                table.start_row,
            )?,
            "totals_column_range" => {
                let totals_row = table.totals_row?;
                add_table_column_span_deps(
                    deps,
                    table,
                    start_column,
                    end_column,
                    totals_row,
                    totals_row,
                )?
            }
            _ => return None,
        }
        return Some(());
    }

    if let Some((selector_kind, column_name)) = structured_qualified_column(selector) {
        match selector_kind {
            "data_column" => add_table_column_data_deps(deps, table, column_name)?,
            "all_column" => add_table_column_range_deps(
                deps,
                table,
                column_name,
                table.start_row,
                table.end_row,
            )?,
            "header_column" => add_table_column_range_deps(
                deps,
                table,
                column_name,
                table.start_row,
                table.start_row,
            )?,
            "totals_column" => {
                let totals_row = table.totals_row?;
                add_table_column_range_deps(deps, table, column_name, totals_row, totals_row)?
            }
            _ => return None,
        }
        return Some(());
    }

    if let Some(column_name) = structured_row_scoped_column(selector) {
        add_table_current_row_column_deps(deps, table, formula_key, column_name)?;
        return Some(());
    }

    None
}

fn simple_structured_column(selector: &str) -> Option<&str> {
    let content = selector.strip_prefix('[')?.strip_suffix(']')?.trim();
    supported_structured_column_name(content)
}

fn supported_structured_column_name(content: &str) -> Option<&str> {
    if content.is_empty()
        || content
            .chars()
            .any(|ch| matches!(ch, '[' | ']' | '#' | '@' | ','))
    {
        return None;
    }
    Some(content)
}

fn structured_column_range(selector: &str) -> Option<(&'static str, &str, &str)> {
    let re =
        Regex::new(r"(?i)^\[\[\s*([^\]#,@:]+?)\s*\]\s*:\s*\[\s*([^\]#,@:]+?)\s*\]\s*\]$").unwrap();
    if let Some(cap) = re.captures(selector) {
        let start_column = supported_structured_column_name(cap.get(1)?.as_str().trim())?;
        let end_column = supported_structured_column_name(cap.get(2)?.as_str().trim())?;
        return Some(("column_range", start_column, end_column));
    }

    let re = Regex::new(
        r"(?i)^\[\[\s*(#Data|#All|#Headers|#Totals)\s*\]\s*,\s*\[\s*([^\]#,@:]+?)\s*\]\s*:\s*\[\s*([^\]#,@:]+?)\s*\]\s*\]$",
    )
    .unwrap();
    let cap = re.captures(selector)?;
    let selector_kind = match cap.get(1)?.as_str().to_ascii_lowercase().as_str() {
        "#data" => "data_column_range",
        "#all" => "all_column_range",
        "#headers" => "header_column_range",
        "#totals" => "totals_column_range",
        _ => return None,
    };
    let start_column = supported_structured_column_name(cap.get(2)?.as_str().trim())?;
    let end_column = supported_structured_column_name(cap.get(3)?.as_str().trim())?;
    Some((selector_kind, start_column, end_column))
}

fn structured_qualified_column(selector: &str) -> Option<(&'static str, &str)> {
    let re = Regex::new(r"(?i)^\[\[\s*#Data\s*\]\s*,\s*\[\s*([^\]#,@]+?)\s*\]\s*\]$").unwrap();
    if let Some(cap) = re.captures(selector) {
        let column_name = cap.get(1)?.as_str().trim();
        return Some((
            "data_column",
            supported_structured_column_name(column_name)?,
        ));
    }

    let re =
        Regex::new(r"(?i)^\[\[\s*(#All|#Headers|#Totals)\s*\]\s*,\s*\[\s*([^\]#,@]+?)\s*\]\s*\]$")
            .unwrap();
    let cap = re.captures(selector)?;
    let selector_kind = match cap.get(1)?.as_str().to_ascii_lowercase().as_str() {
        "#all" => "all_column",
        "#headers" => "header_column",
        "#totals" => "totals_column",
        _ => return None,
    };
    let column_name = cap.get(2)?.as_str().trim();
    Some((
        selector_kind,
        supported_structured_column_name(column_name)?,
    ))
}

fn structured_row_scoped_column(selector: &str) -> Option<&str> {
    let re = Regex::new(r"(?i)^\[\s*@\s*([^\]#,@]+?)\s*\]$").unwrap();
    if let Some(cap) = re.captures(selector) {
        let column_name = cap.get(1)?.as_str().trim();
        return supported_structured_column_name(column_name);
    }

    let re =
        Regex::new(r"(?i)^\[\[\s*#This\s+Row\s*\]\s*,\s*\[\s*([^\]#,@]+?)\s*\]\s*\]$").unwrap();
    let column_name = re.captures(selector)?.get(1)?.as_str().trim();
    supported_structured_column_name(column_name)
}

fn add_table_current_row_column_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    formula_key: &Key,
    column_name: &str,
) -> Option<()> {
    if !formula_cell_in_table_data_row(formula_key, table) {
        return None;
    }
    add_table_column_range_deps(deps, table, column_name, formula_key.row, formula_key.row)
}

fn add_table_column_data_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    column_name: &str,
) -> Option<()> {
    add_table_column_range_deps(
        deps,
        table,
        column_name,
        table.data_start_row(),
        table.data_end_row(),
    )
}

fn add_table_column_span_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    start_column: &str,
    end_column: &str,
    start_row: usize,
    end_row: usize,
) -> Option<()> {
    let (start_col, end_col) = table.column_span(start_column, end_column)?;
    add_table_range_deps(deps, table, start_row, end_row, start_col, end_col);
    Some(())
}

fn add_table_column_range_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    column_name: &str,
    start_row: usize,
    end_row: usize,
) -> Option<()> {
    let col_offset = table
        .columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case(column_name.trim()))?;
    let col = table.start_col + col_offset;
    if col > table.end_col {
        return None;
    }
    add_table_range_deps(deps, table, start_row, end_row, col, col);
    Some(())
}

fn add_table_range_deps(
    deps: &mut HashSet<Key>,
    table: &TableInfo,
    start_row: usize,
    end_row: usize,
    start_col: usize,
    end_col: usize,
) {
    for row in start_row..=end_row {
        for col in start_col..=end_col {
            deps.insert(Key {
                sheet: table.sheet.clone(),
                row,
                col,
            });
        }
    }
}

fn has_structured_table_ref(formula: &str) -> bool {
    let re = Regex::new(r"(?i)\b[A-Za-z_][A-Za-z0-9_]*\s*(?:\[[^\]]+\])+").unwrap();
    re.is_match(formula)
}

fn extract_defined_name_deps(
    formula: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
    sheet_order: &[String],
    defined_names: &[DefinedName],
) -> (HashSet<Key>, String) {
    if defined_names.is_empty() {
        return (HashSet::new(), formula.to_string());
    }

    let lookup = defined_name_lookup(defined_names, default_sheet);
    let name_re = Regex::new(r"\b[A-Za-z_][A-Za-z0-9_.]*\b").unwrap();
    let mut deps = HashSet::new();
    let mut output = String::with_capacity(formula.len());
    let mut last = 0;

    for item in name_re.find_iter(formula) {
        let token = item.as_str();
        let token_lower = token.to_ascii_lowercase();
        let Some(target) = lookup.get(&token_lower) else {
            continue;
        };
        if !is_defined_name_context(formula, item.start(), item.end()) {
            continue;
        }

        output.push_str(&formula[last..item.start()]);
        output.push_str(&" ".repeat(item.end() - item.start()));
        last = item.end();

        let target = target.trim().trim_start_matches('=');
        let target = mask_unsupported_dependency_tokens(&strip_formula_string_literals(target));
        deps.extend(extract_deps_regex(
            &target,
            default_sheet,
            cells,
            sheet_order,
        ));
    }

    output.push_str(&formula[last..]);
    (deps, output)
}

fn defined_name_lookup<'a>(
    defined_names: &'a [DefinedName],
    default_sheet: &str,
) -> HashMap<String, &'a str> {
    let mut lookup = HashMap::new();
    for item in defined_names {
        if item.scope_sheet.is_none() {
            lookup.insert(item.name.to_ascii_lowercase(), item.target.as_str());
        }
    }
    for item in defined_names {
        if item.scope_sheet.as_deref() == Some(default_sheet) {
            lookup.insert(item.name.to_ascii_lowercase(), item.target.as_str());
        }
    }
    lookup
}

fn is_defined_name_context(formula: &str, start: usize, end: usize) -> bool {
    let prev = formula[..start].chars().next_back();
    if matches!(prev, Some('\'') | Some('!') | Some('[')) {
        return false;
    }

    let next = formula[end..].chars().find(|ch| !ch.is_whitespace());
    if matches!(next, Some('!') | Some('(')) {
        return false;
    }

    true
}

fn evaluate_formula_mvp(
    formula: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut expr = formula.trim().trim_start_matches('=').to_string();
    if has_structured_table_ref(&strip_formula_string_literals(&expr)) {
        return Err(PyValueError::new_err(
            "unsupported_formula: structured table references are not yet evaluated",
        ));
    }
    if let Some(key) = parse_ref(&expr, default_sheet) {
        return Ok(cells.get(&key).cloned().unwrap_or_default());
    }

    expr = eval_iferror_calls(&expr, default_sheet, cells)?;
    expr = eval_if_calls(&expr, default_sheet, cells)?;
    expr = eval_logical_calls(&expr, default_sheet, cells)?;
    expr = eval_sumifs_calls(&expr, default_sheet, cells)?;
    expr = eval_sumif_calls(&expr, default_sheet, cells)?;
    expr = eval_countifs_calls(&expr, default_sheet, cells)?;
    expr = eval_countif_calls(&expr, default_sheet, cells)?;
    expr = eval_lookup_calls(&expr, default_sheet, cells)?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "SUM")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "AVERAGE")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "MAX")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "MIN")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNT")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNTA")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNTBLANK")?;
    expr = eval_text_calls(&expr, default_sheet, cells)?;
    expr = eval_concat_operator(&expr, default_sheet, cells)?;
    expr = eval_round_calls(&expr, default_sheet, cells)?;
    reject_unsupported_functions(&expr)?;
    expr = replace_cell_refs(&expr, default_sheet, cells)?;
    let expr = expr.trim();
    if expr.is_empty() {
        return Ok(String::new());
    }
    if expr.starts_with('"') && expr.ends_with('"') {
        return Ok(strip_quotes(expr));
    }
    if !looks_like_numeric_expression(expr) {
        return Ok(strip_quotes(expr));
    }
    let value = meval::eval_str(&expr).map_err(|err| PyValueError::new_err(err.to_string()))?;
    Ok(format_number(value))
}

fn eval_iferror_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "IFERROR") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err("IFERROR expects 2 arguments"));
        }
        let replacement = evaluate_formula_mvp(&format!("={}", args[0]), default_sheet, cells)
            .or_else(|_| evaluate_formula_mvp(&format!("={}", args[1]), default_sheet, cells))
            .unwrap_or_else(|_| strip_quotes(&args[1]));
        current.replace_range(call.start..call.end, &replacement);
    }

    Ok(current)
}

fn eval_if_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "IF") {
        let args = split_args(&call.args);
        if args.len() != 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: IF expects 3 arguments",
            ));
        }
        let selected = if evaluate_condition(&args[0], default_sheet, cells)? {
            &args[1]
        } else {
            &args[2]
        };
        let replacement = evaluate_formula_mvp(&format!("={selected}"), default_sheet, cells)
            .unwrap_or_else(|_| strip_quotes(selected));
        current.replace_range(call.start..call.end, &replacement);
    }

    Ok(current)
}

fn eval_logical_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "AND") {
        let args = split_args(&call.args);
        if args.is_empty() {
            return Err(PyValueError::new_err(
                "unsupported_formula: AND expects at least 1 argument",
            ));
        }
        let matched = args
            .iter()
            .map(|arg| evaluate_condition(arg, default_sheet, cells))
            .collect::<PyResult<Vec<_>>>()?
            .into_iter()
            .all(|value| value);
        current.replace_range(call.start..call.end, if matched { "1" } else { "0" });
    }
    while let Some(call) = find_function_call(&current, "OR") {
        let args = split_args(&call.args);
        if args.is_empty() {
            return Err(PyValueError::new_err(
                "unsupported_formula: OR expects at least 1 argument",
            ));
        }
        let matched = args
            .iter()
            .map(|arg| evaluate_condition(arg, default_sheet, cells))
            .collect::<PyResult<Vec<_>>>()?
            .into_iter()
            .any(|value| value);
        current.replace_range(call.start..call.end, if matched { "1" } else { "0" });
    }
    while let Some(call) = find_function_call(&current, "NOT") {
        let args = split_args(&call.args);
        if args.len() != 1 {
            return Err(PyValueError::new_err(
                "unsupported_formula: NOT expects 1 argument",
            ));
        }
        let matched = !evaluate_condition(&args[0], default_sheet, cells)?;
        current.replace_range(call.start..call.end, if matched { "1" } else { "0" });
    }

    Ok(current)
}

fn eval_sumifs_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "SUMIFS") {
        let args = split_args(&call.args);
        if args.len() < 3 || args.len() % 2 == 0 {
            return Err(PyValueError::new_err(
                "unsupported_formula: SUMIFS expects sum_range plus range/criteria pairs",
            ));
        }
        let sum_range = range_values(&args[0], default_sheet, cells);
        let mut total = 0.0;
        for idx in 0..sum_range.len() {
            let mut matched = true;
            for pair in args[1..].chunks(2) {
                let values = range_values(&pair[0], default_sheet, cells);
                let value = values
                    .get(idx)
                    .map(|(_, value)| value.as_str())
                    .unwrap_or("");
                let criteria = eval_criteria(&pair[1], default_sheet, cells);
                if !criteria_matches(value, &criteria) {
                    matched = false;
                    break;
                }
            }
            if matched {
                total += sum_range[idx].1.parse::<f64>().unwrap_or(0.0);
            }
        }
        current.replace_range(call.start..call.end, &format_number(total));
    }

    Ok(current)
}

fn eval_sumif_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "SUMIF") {
        let args = split_args(&call.args);
        if args.len() != 2 && args.len() != 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: SUMIF expects 2 or 3 arguments",
            ));
        }
        let criteria = eval_criteria(&args[1], default_sheet, cells);
        let criteria_range = range_values(&args[0], default_sheet, cells);
        let sum_range = if args.len() == 3 {
            range_values(&args[2], default_sheet, cells)
        } else {
            criteria_range.clone()
        };
        let mut total = 0.0;
        for (idx, (_, value)) in criteria_range.iter().enumerate() {
            if criteria_matches(value, &criteria) {
                total += sum_range
                    .get(idx)
                    .and_then(|(_, value)| value.parse::<f64>().ok())
                    .unwrap_or(0.0);
            }
        }
        current.replace_range(call.start..call.end, &format_number(total));
    }

    Ok(current)
}

fn eval_countifs_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "COUNTIFS") {
        let args = split_args(&call.args);
        if args.len() < 2 || args.len() % 2 != 0 {
            return Err(PyValueError::new_err(
                "COUNTIFS expects range/criteria pairs",
            ));
        }

        let first_range = range_values(&args[0], default_sheet, cells);
        let mut count = 0;
        for idx in 0..first_range.len() {
            let mut matched = true;
            for pair in args.chunks(2) {
                let values = range_values(&pair[0], default_sheet, cells);
                let value = values
                    .get(idx)
                    .map(|(_, value)| value.as_str())
                    .unwrap_or("");
                let criteria = eval_criteria(&pair[1], default_sheet, cells);
                if !criteria_matches(value, &criteria) {
                    matched = false;
                    break;
                }
            }
            if matched {
                count += 1;
            }
        }

        current.replace_range(call.start..call.end, &count.to_string());
    }

    Ok(current)
}

fn eval_countif_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "COUNTIF") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err("COUNTIF expects 2 arguments"));
        }

        let criteria = eval_criteria(&args[1], default_sheet, cells);
        let count = range_values(&args[0], default_sheet, cells)
            .into_iter()
            .filter(|(_, value)| criteria_matches(value, &criteria))
            .count();

        current.replace_range(call.start..call.end, &count.to_string());
    }

    Ok(current)
}

fn eval_aggregate_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
    function_name: &str,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, function_name) {
        let args = split_args(&call.args);
        let mut values = Vec::new();

        for arg in args {
            let arg = arg.trim();
            if arg.contains(':') {
                values.extend(
                    range_values(arg, default_sheet, cells)
                        .into_iter()
                        .map(|(_, value)| value),
                );
            } else if let Some(key) = parse_ref(arg, default_sheet) {
                values.push(cells.get(&key).cloned().unwrap_or_default());
            } else {
                values.push(arg.to_string());
            }
        }

        if function_name.eq_ignore_ascii_case("COUNT") {
            let count = values
                .iter()
                .filter(|value| value.parse::<f64>().is_ok())
                .count();
            current.replace_range(call.start..call.end, &count.to_string());
            continue;
        }
        if function_name.eq_ignore_ascii_case("COUNTA") {
            let count = values.iter().filter(|value| !value.is_empty()).count();
            current.replace_range(call.start..call.end, &count.to_string());
            continue;
        }
        if function_name.eq_ignore_ascii_case("COUNTBLANK") {
            let count = values.iter().filter(|value| value.is_empty()).count();
            current.replace_range(call.start..call.end, &count.to_string());
            continue;
        }

        let numeric_values: Vec<f64> = values
            .iter()
            .filter_map(|value| value.parse::<f64>().ok())
            .collect();
        let result = if function_name.eq_ignore_ascii_case("AVERAGE") {
            if numeric_values.is_empty() {
                0.0
            } else {
                numeric_values.iter().sum::<f64>() / numeric_values.len() as f64
            }
        } else if function_name.eq_ignore_ascii_case("MAX") {
            numeric_values
                .iter()
                .copied()
                .reduce(f64::max)
                .unwrap_or(0.0)
        } else if function_name.eq_ignore_ascii_case("MIN") {
            numeric_values
                .iter()
                .copied()
                .reduce(f64::min)
                .unwrap_or(0.0)
        } else {
            numeric_values.iter().sum::<f64>()
        };

        current.replace_range(call.start..call.end, &format_number(result));
    }

    Ok(current)
}

fn eval_text_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "LEN") {
        let args = split_args(&call.args);
        if args.len() != 1 {
            return Err(PyValueError::new_err(
                "unsupported_formula: LEN expects 1 argument",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        current.replace_range(call.start..call.end, &value.chars().count().to_string());
    }
    while let Some(call) = find_function_call(&current, "TRIM") {
        let args = split_args(&call.args);
        if args.len() != 1 {
            return Err(PyValueError::new_err(
                "unsupported_formula: TRIM expects 1 argument",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        current.replace_range(call.start..call.end, &format!("\"{}\"", value.trim()));
    }
    while let Some(call) = find_function_call(&current, "LEFT") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err(
                "unsupported_formula: LEFT expects 2 arguments",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let count = evaluate_numeric_arg(&args[1], default_sheet, cells)? as usize;
        let result: String = value.chars().take(count).collect();
        current.replace_range(call.start..call.end, &format!("\"{}\"", result));
    }
    while let Some(call) = find_function_call(&current, "RIGHT") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err(
                "unsupported_formula: RIGHT expects 2 arguments",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let count = evaluate_numeric_arg(&args[1], default_sheet, cells)? as usize;
        let len = value.chars().count();
        let result: String = value.chars().skip(len.saturating_sub(count)).collect();
        current.replace_range(call.start..call.end, &format!("\"{}\"", result));
    }
    while let Some(call) = find_function_call(&current, "MID") {
        let args = split_args(&call.args);
        if args.len() != 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: MID expects 3 arguments",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let start = evaluate_numeric_arg(&args[1], default_sheet, cells)? as usize;
        let count = evaluate_numeric_arg(&args[2], default_sheet, cells)? as usize;
        let result: String = value
            .chars()
            .skip(start.saturating_sub(1))
            .take(count)
            .collect();
        current.replace_range(call.start..call.end, &format!("\"{}\"", result));
    }
    while let Some(call) = find_function_call(&current, "VALUE") {
        let args = split_args(&call.args);
        if args.len() != 1 {
            return Err(PyValueError::new_err(
                "unsupported_formula: VALUE expects 1 argument",
            ));
        }
        let value = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let numeric = value.parse::<f64>().map_err(|_| {
            PyValueError::new_err("unsupported_formula: VALUE argument is not numeric")
        })?;
        current.replace_range(call.start..call.end, &format_number(numeric));
    }
    while let Some(call) = find_function_call(&current, "TEXT") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err(
                "unsupported_formula: TEXT expects 2 arguments",
            ));
        }
        let value = evaluate_numeric_arg(&args[0], default_sheet, cells)?;
        let format_code = evaluate_text_arg(&args[1], default_sheet, cells)?;
        let result = format_text_value(value, &format_code)?;
        current.replace_range(call.start..call.end, &format!("\"{}\"", result));
    }
    while let Some(call) = find_function_call(&current, "CONCAT") {
        let args = split_args(&call.args);
        let mut result = String::new();
        for arg in args {
            result.push_str(&evaluate_text_arg(&arg, default_sheet, cells)?);
        }
        current.replace_range(call.start..call.end, &format!("\"{}\"", result));
    }
    while let Some(call) = find_function_call(&current, "TEXTJOIN") {
        let args = split_args(&call.args);
        if args.len() < 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: TEXTJOIN expects delimiter, ignore_empty, and values",
            ));
        }
        let delimiter = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let ignore_empty = args[1].trim().eq_ignore_ascii_case("TRUE");
        let mut values = Vec::new();
        for arg in &args[2..] {
            let value = evaluate_text_arg(arg, default_sheet, cells)?;
            if !ignore_empty || !value.is_empty() {
                values.push(value);
            }
        }
        current.replace_range(
            call.start..call.end,
            &format!("\"{}\"", values.join(&delimiter)),
        );
    }

    Ok(current)
}

fn eval_concat_operator(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let parts = split_concat_parts(expr);
    if parts.len() <= 1 {
        return Ok(expr.to_string());
    }
    let mut result = String::new();
    for part in parts {
        result.push_str(&evaluate_text_arg(&part, default_sheet, cells)?);
    }
    Ok(format!("\"{}\"", result))
}

fn split_concat_parts(expr: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut start = 0usize;
    let mut depth = 0usize;
    let mut in_string = false;

    for (idx, ch) in expr.char_indices() {
        if ch == '"' {
            in_string = !in_string;
        } else if !in_string && ch == '(' {
            depth += 1;
        } else if !in_string && ch == ')' {
            depth = depth.saturating_sub(1);
        } else if !in_string && depth == 0 && ch == '&' {
            result.push(expr[start..idx].trim().to_string());
            start = idx + 1;
        }
    }

    if result.is_empty() {
        vec![expr.to_string()]
    } else {
        result.push(expr[start..].trim().to_string());
        result
    }
}

fn format_text_value(value: f64, format_code: &str) -> PyResult<String> {
    let format_code = format_code.trim();
    if format_code == "0" {
        return Ok(format!("{:.0}", value));
    }
    if let Some(decimal_places) = format_code
        .strip_prefix("0.")
        .filter(|tail| tail.chars().all(|ch| ch == '0'))
        .map(str::len)
    {
        return Ok(format!("{value:.decimal_places$}"));
    }
    if format_code == "0%" {
        return Ok(format!("{:.0}%", value * 100.0));
    }
    if let Some(decimal_places) = format_code
        .strip_prefix("0.")
        .and_then(|tail| tail.strip_suffix('%'))
        .filter(|tail| tail.chars().all(|ch| ch == '0'))
        .map(str::len)
    {
        return Ok(format!("{:.decimal_places$}%", value * 100.0));
    }
    Err(PyValueError::new_err(format!(
        "unsupported_formula: TEXT format is not supported: {format_code}"
    )))
}

fn eval_lookup_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "VLOOKUP") {
        let args = split_args(&call.args);
        if args.len() < 3 || args.len() > 4 {
            return Err(PyValueError::new_err(
                "unsupported_formula: VLOOKUP expects 3 or 4 arguments",
            ));
        }
        if args.len() == 4 && !matches!(args[3].trim().to_ascii_uppercase().as_str(), "FALSE" | "0")
        {
            return Err(PyValueError::new_err(
                "unsupported_formula: VLOOKUP approximate match is not supported",
            ));
        }
        let lookup = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let col_index = evaluate_numeric_arg(&args[2], default_sheet, cells)? as usize;
        let rows = range_rows(&args[1], default_sheet, cells);
        let mut found = None;
        for row in rows {
            if row.first().map(|(_, value)| value.as_str()) == Some(lookup.as_str()) {
                found = row
                    .get(col_index.saturating_sub(1))
                    .map(|(_, value)| value.clone());
                break;
            }
        }
        let Some(value) = found else {
            return Err(PyValueError::new_err(
                "unsupported_formula: VLOOKUP exact match not found",
            ));
        };
        current.replace_range(call.start..call.end, &format!("\"{}\"", value));
    }
    while let Some(call) = find_function_call(&current, "INDEX") {
        let args = split_args(&call.args);
        if args.len() < 2 || args.len() > 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: INDEX expects 2 or 3 arguments",
            ));
        }
        let row_index = evaluate_numeric_arg(&args[1], default_sheet, cells)? as usize;
        let col_index = if args.len() == 3 {
            evaluate_numeric_arg(&args[2], default_sheet, cells)? as usize
        } else {
            1
        };
        let rows = range_rows(&args[0], default_sheet, cells);
        let value = rows
            .get(row_index.saturating_sub(1))
            .and_then(|row| row.get(col_index.saturating_sub(1)))
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        current.replace_range(call.start..call.end, &format!("\"{}\"", value));
    }
    while let Some(call) = find_function_call(&current, "MATCH") {
        let args = split_args(&call.args);
        if args.len() < 2 || args.len() > 3 {
            return Err(PyValueError::new_err(
                "unsupported_formula: MATCH expects 2 or 3 arguments",
            ));
        }
        if args.len() == 3 && !matches!(args[2].trim(), "0") {
            return Err(PyValueError::new_err(
                "unsupported_formula: MATCH approximate match is not supported",
            ));
        }
        let lookup = evaluate_text_arg(&args[0], default_sheet, cells)?;
        let values = range_values(&args[1], default_sheet, cells);
        let Some(position) = values
            .iter()
            .position(|(_, value)| value == &lookup)
            .map(|idx| idx + 1)
        else {
            return Err(PyValueError::new_err(
                "unsupported_formula: MATCH exact value not found",
            ));
        };
        current.replace_range(call.start..call.end, &position.to_string());
    }

    Ok(current)
}

fn eval_round_calls(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let mut current = expr.to_string();

    while let Some(call) = find_function_call(&current, "ROUND") {
        let args = split_args(&call.args);
        if args.len() != 2 {
            return Err(PyValueError::new_err("ROUND expects 2 arguments"));
        }
        let value = evaluate_numeric_arg(&args[0], default_sheet, cells)?;
        let digits = evaluate_numeric_arg(&args[1], default_sheet, cells)? as i32;
        let factor = 10_f64.powi(digits);
        let rounded = (value * factor).round() / factor;
        current.replace_range(call.start..call.end, &format_number(rounded));
    }

    Ok(current)
}

fn evaluate_numeric_arg(
    arg: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<f64> {
    let mut expr = arg.trim().to_string();
    expr = eval_countifs_calls(&expr, default_sheet, cells)?;
    expr = eval_sumifs_calls(&expr, default_sheet, cells)?;
    expr = eval_sumif_calls(&expr, default_sheet, cells)?;
    expr = eval_countif_calls(&expr, default_sheet, cells)?;
    expr = eval_lookup_calls(&expr, default_sheet, cells)?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "SUM")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "AVERAGE")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "MAX")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "MIN")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNT")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNTA")?;
    expr = eval_aggregate_calls(&expr, default_sheet, cells, "COUNTBLANK")?;
    expr = eval_text_calls(&expr, default_sheet, cells)?;
    expr = eval_round_calls(&expr, default_sheet, cells)?;
    reject_unsupported_functions(&expr)?;
    expr = replace_cell_refs(&expr, default_sheet, cells)?;
    meval::eval_str(&expr).map_err(|err| PyValueError::new_err(err.to_string()))
}

fn evaluate_text_arg(
    arg: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let arg = arg.trim();
    if arg.starts_with('"') && arg.ends_with('"') {
        return Ok(strip_quotes(arg));
    }
    if let Some(key) = parse_ref(arg, default_sheet) {
        return Ok(cells.get(&key).cloned().unwrap_or_default());
    }
    if arg.contains('(') || looks_like_numeric_expression(arg) {
        return evaluate_formula_mvp(&format!("={arg}"), default_sheet, cells);
    }
    Ok(strip_quotes(arg))
}

fn evaluate_condition(
    condition: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<bool> {
    for op in [">=", "<=", "<>", ">", "<", "="] {
        if let Some(idx) = condition.find(op) {
            let left = evaluate_text_arg(&condition[..idx], default_sheet, cells)?;
            let right = evaluate_text_arg(&condition[idx + op.len()..], default_sheet, cells)?;
            return Ok(compare_criteria(&left, op, &right));
        }
    }
    Ok(evaluate_numeric_arg(condition, default_sheet, cells)? != 0.0)
}

fn reject_unsupported_functions(expr: &str) -> PyResult<()> {
    let re = Regex::new(r"(?i)\b([A-Z][A-Z0-9_]*)\s*\(").unwrap();
    if let Some(cap) = re.captures(expr) {
        return Err(PyValueError::new_err(format!(
            "unsupported_formula: {}",
            cap.get(1).map(|m| m.as_str()).unwrap_or("UNKNOWN")
        )));
    }
    Ok(())
}

fn looks_like_numeric_expression(expr: &str) -> bool {
    let trimmed = expr.trim();
    trimmed.parse::<f64>().is_ok()
        || trimmed.chars().any(|ch| {
            matches!(
                ch,
                '+' | '-' | '*' | '/' | '^' | '(' | ')' | '<' | '>' | '='
            )
        })
}

fn replace_cell_refs(
    expr: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> PyResult<String> {
    let re =
        Regex::new(r"(?i)(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!)?\$?([A-Z]{1,3})\$?([0-9]+)")
            .unwrap();
    let mut output = String::new();
    let mut last = 0;

    for cap in re.captures_iter(expr) {
        let m = cap.get(0).unwrap();
        output.push_str(&expr[last..m.start()]);
        let sheet = cap
            .get(1)
            .or_else(|| cap.get(2))
            .map(|m| m.as_str())
            .unwrap_or(default_sheet);
        let col = col_from_name(cap.get(3).unwrap().as_str()).unwrap_or(1);
        let row = cap.get(4).unwrap().as_str().parse::<usize>().unwrap_or(1);
        let value = numeric_cell(
            cells,
            &Key {
                sheet: sheet.to_string(),
                row,
                col,
            },
        );
        output.push_str(&format_number(value));
        last = m.end();
    }

    output.push_str(&expr[last..]);
    Ok(output)
}

#[derive(Debug)]
struct FunctionCall {
    start: usize,
    end: usize,
    args: String,
}

fn find_function_call(expr: &str, function_name: &str) -> Option<FunctionCall> {
    let needle = function_name.to_ascii_uppercase();
    let upper = expr.to_ascii_uppercase();
    let mut search_from = 0;

    while let Some(relative_start) = upper[search_from..].find(&needle) {
        let start = search_from + relative_start;
        let open = start + needle.len();
        if !expr[open..].starts_with('(') {
            search_from = open;
            continue;
        }

        let mut depth = 0usize;
        let mut in_string = false;
        for (offset, ch) in expr[open..].char_indices() {
            if ch == '"' {
                in_string = !in_string;
            } else if !in_string && ch == '(' {
                depth += 1;
            } else if !in_string && ch == ')' {
                depth -= 1;
                if depth == 0 {
                    let end = open + offset + 1;
                    return Some(FunctionCall {
                        start,
                        end,
                        args: expr[open + 1..end - 1].to_string(),
                    });
                }
            }
        }

        return None;
    }

    None
}

fn split_args(args: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut start = 0usize;
    let mut depth = 0usize;
    let mut in_string = false;

    for (idx, ch) in args.char_indices() {
        if ch == '"' {
            in_string = !in_string;
        } else if !in_string && ch == '(' {
            depth += 1;
        } else if !in_string && ch == ')' {
            depth = depth.saturating_sub(1);
        } else if !in_string && depth == 0 && ch == ',' {
            result.push(args[start..idx].trim().to_string());
            start = idx + 1;
        }
    }

    result.push(args[start..].trim().to_string());
    result
}

fn range_values(
    range: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> Vec<(Key, String)> {
    if let Some(keys) = expand_range(range, default_sheet, cells) {
        return keys
            .into_iter()
            .map(|key| {
                let value = cells.get(&key).cloned().unwrap_or_default();
                (key, value)
            })
            .collect();
    }
    if let Some(key) = parse_ref(range, default_sheet) {
        return vec![(key.clone(), cells.get(&key).cloned().unwrap_or_default())];
    }
    Vec::new()
}

fn range_rows(
    range: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> Vec<Vec<(Key, String)>> {
    let mut values = range_values(range, default_sheet, cells);
    values.sort_by_key(|(key, _)| (key.row, key.col));
    let mut rows: Vec<Vec<(Key, String)>> = Vec::new();
    for (key, value) in values {
        if rows
            .last()
            .and_then(|row| row.first())
            .map(|(row_key, _)| row_key.row != key.row)
            .unwrap_or(true)
        {
            rows.push(Vec::new());
        }
        rows.last_mut().unwrap().push((key, value));
    }
    rows
}

fn eval_criteria(criteria: &str, default_sheet: &str, cells: &HashMap<Key, String>) -> String {
    let criteria = criteria.trim();
    if let Some(key) = parse_ref(criteria, default_sheet) {
        return cells.get(&key).cloned().unwrap_or_default();
    }
    strip_quotes(criteria)
}

fn strip_quotes(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn criteria_matches(value: &str, criteria: &str) -> bool {
    let criteria = criteria.trim();
    for op in [">=", "<=", "<>", ">", "<", "="] {
        if let Some(rhs) = criteria.strip_prefix(op) {
            return compare_criteria(value, op, rhs.trim());
        }
    }
    value == criteria
}

fn compare_criteria(value: &str, op: &str, rhs: &str) -> bool {
    let rhs = strip_quotes(rhs);
    let left_num = value.parse::<f64>();
    let right_num = rhs.parse::<f64>();
    if let (Ok(left), Ok(right)) = (left_num, right_num) {
        return match op {
            ">=" => left >= right,
            "<=" => left <= right,
            "<>" => (left - right).abs() > f64::EPSILON,
            ">" => left > right,
            "<" => left < right,
            "=" => (left - right).abs() <= f64::EPSILON,
            _ => false,
        };
    }

    match op {
        "<>" => value != rhs,
        "=" => value == rhs,
        _ => false,
    }
}

fn expand_range(
    range: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> Option<Vec<Key>> {
    let parts: Vec<&str> = range.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    if let Some(keys) = expand_column_range(parts[0].trim(), parts[1].trim(), default_sheet, cells)
    {
        return Some(keys);
    }
    let Some(start) = parse_ref(parts[0].trim(), default_sheet) else {
        return None;
    };
    let Some(end) = parse_ref(parts[1].trim(), &start.sheet) else {
        return None;
    };

    let mut keys = Vec::new();
    for row in start.row.min(end.row)..=start.row.max(end.row) {
        for col in start.col.min(end.col)..=start.col.max(end.col) {
            keys.push(Key {
                sheet: start.sheet.clone(),
                row,
                col,
            });
        }
    }
    Some(keys)
}

fn expand_column_range(
    start: &str,
    end: &str,
    default_sheet: &str,
    cells: &HashMap<Key, String>,
) -> Option<Vec<Key>> {
    let (start_sheet, start_col) = parse_column_ref(start, default_sheet)?;
    let (end_sheet, end_col) = parse_column_ref(end, &start_sheet)?;
    if start_sheet != end_sheet {
        return None;
    }

    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);
    let mut keys: Vec<Key> = cells
        .keys()
        .filter(|key| key.sheet == start_sheet && key.col >= min_col && key.col <= max_col)
        .cloned()
        .collect();
    keys.sort_by_key(|key| (key.row, key.col));
    Some(keys)
}

fn parse_column_ref(value: &str, default_sheet: &str) -> Option<(String, usize)> {
    let re =
        Regex::new(r"(?i)^(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!)?\$?([A-Z]{1,3})$").unwrap();
    let cap = re.captures(value.trim())?;
    let sheet = cap
        .get(1)
        .or_else(|| cap.get(2))
        .map(|m| m.as_str())
        .unwrap_or(default_sheet)
        .to_string();
    let col = col_from_name(cap.get(3)?.as_str())?;
    Some((sheet, col))
}

fn parse_ref(value: &str, default_sheet: &str) -> Option<Key> {
    let re = Regex::new(
        r"(?i)^(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))!)?\$?([A-Z]{1,3})\$?([0-9]+)$",
    )
    .unwrap();
    let cap = re.captures(value.trim())?;
    let sheet = cap
        .get(1)
        .or_else(|| cap.get(2))
        .map(|m| m.as_str())
        .unwrap_or(default_sheet)
        .to_string();
    let col = col_from_name(cap.get(3)?.as_str())?;
    let row = cap.get(4)?.as_str().parse::<usize>().ok()?;
    Some(Key { sheet, row, col })
}

fn parse_shared_string_policy(value: &str) -> PyResult<SharedStringPolicy> {
    match value {
        "preserve" => Ok(SharedStringPolicy::Preserve),
        "update_unique" => Ok(SharedStringPolicy::UpdateUnique),
        "auto" => Ok(SharedStringPolicy::Auto),
        _ => Err(PyValueError::new_err(format!(
            "shared_string_policy: unsupported policy: {value}"
        ))),
    }
}

fn collect_shared_string_refs(
    sheet_name: &str,
    xml: &str,
    usage: &mut HashMap<usize, usize>,
    refs: &mut HashMap<Key, usize>,
) -> PyResult<()> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    for node in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "c" && node.attribute("t") == Some("s"))
    {
        let Some(cell_ref) = node.attribute("r") else {
            continue;
        };
        let Some((col, row)) = parse_a1(cell_ref) else {
            continue;
        };
        let Some(index) = child_text(node, "v").parse::<usize>().ok() else {
            continue;
        };
        *usage.entry(index).or_insert(0) += 1;
        refs.insert(
            Key {
                sheet: sheet_name.to_string(),
                row,
                col,
            },
            index,
        );
    }
    Ok(())
}

fn patch_shared_strings_xml(xml: &str, updates: &HashMap<usize, String>) -> PyResult<String> {
    if updates.is_empty() {
        return Ok(xml.to_string());
    }
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let shared_string_count = doc
        .descendants()
        .filter(|node| node.tag_name().name() == "si")
        .count();
    for idx in updates.keys() {
        if *idx >= shared_string_count {
            return Err(PyValueError::new_err(format!(
                "shared_string_policy: shared string index {idx} not found"
            )));
        }
    }

    let mut replacements = Vec::new();

    for (idx, si) in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "si")
        .enumerate()
    {
        let Some(value) = updates.get(&idx) else {
            continue;
        };
        let replacement = update_text_container_payload(xml, si, value).ok_or_else(|| {
            PyValueError::new_err(format!(
                "shared_string_policy: shared string index {idx} has no text node"
            ))
        })?;
        replacements.push((si.range(), replacement));
    }

    replacements.sort_by_key(|(range, _)| range.start);
    let mut patched = String::new();
    let mut cursor = 0usize;
    for (range, replacement) in replacements {
        patched.push_str(&xml[cursor..range.start]);
        patched.push_str(&replacement);
        cursor = range.end;
    }
    patched.push_str(&xml[cursor..]);
    Ok(patched)
}

fn patch_cell(
    xml: &str,
    cell_ref: &str,
    row: usize,
    col: usize,
    value: &str,
    formula: Option<&str>,
    shared_string_index: Option<usize>,
    force_inline_string: bool,
    style_id: Option<u32>,
) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let Some(cell_node) = doc
        .descendants()
        .find(|node| node.tag_name().name() == "c" && node.attribute("r") == Some(cell_ref))
    else {
        return patch_missing_cell(xml, &doc, cell_ref, row, col, value, formula, style_id);
    };
    let range = cell_node.range();
    let whole = &xml[range.clone()];
    let Some(start_end) = whole.find('>') else {
        return Err(PyValueError::new_err(format!(
            "xml_patch_miss: malformed cell start tag for {cell_ref}"
        )));
    };
    let mut start_tag = whole[..=start_end].to_string();
    let prefix = cell_tag_prefix(&start_tag);
    let end_tag = whole
        .rfind("</")
        .map(|idx| whole[idx..].to_string())
        .unwrap_or_else(|| format!("</{prefix}c>"));
    start_tag = normalize_cell_start_tag(&start_tag);
    let rich_inline_payload =
        if formula.is_none() && shared_string_index.is_none() && value.parse::<f64>().is_err() {
            rich_inline_string_payload(xml, cell_node, value)
        } else {
            None
        };
    let replacement = build_existing_cell_xml(
        xml,
        cell_node,
        &start_tag,
        &prefix,
        &end_tag,
        value,
        formula,
        shared_string_index,
        force_inline_string,
        style_id,
        rich_inline_payload.as_deref(),
    );

    let mut patched = String::with_capacity(xml.len() + replacement.len());
    patched.push_str(&xml[..range.start]);
    patched.push_str(&replacement);
    patched.push_str(&xml[range.end..]);
    Ok(patched)
}

fn patch_missing_cell(
    xml: &str,
    doc: &Document<'_>,
    cell_ref: &str,
    row: usize,
    col: usize,
    value: &str,
    formula: Option<&str>,
    style_id: Option<u32>,
) -> PyResult<String> {
    let Some(sheet_data) = doc
        .descendants()
        .find(|node| node.tag_name().name() == "sheetData")
    else {
        return Err(PyValueError::new_err(
            "xml_patch_miss: worksheet XML has no sheetData node",
        ));
    };
    let sheet_data_start = &xml[sheet_data.range()];
    let sheet_prefix = sheet_data_start
        .find('>')
        .map(|idx| element_tag_prefix(&sheet_data_start[..=idx], "sheetData"))
        .unwrap_or_default();

    let cell_xml = inserted_cell_xml(&sheet_prefix, cell_ref, value, formula, style_id);
    if let Some(row_node) = sheet_data.children().find(|node| {
        node.tag_name().name() == "row"
            && node
                .attribute("r")
                .and_then(|value| value.parse::<usize>().ok())
                == Some(row)
    }) {
        return insert_cell_into_row(xml, row_node, col, &cell_xml);
    }

    let row_xml = format!(
        "<{prefix}row r=\"{row}\">{cell_xml}</{prefix}row>",
        prefix = sheet_prefix
    );
    let insert_at = sheet_data
        .children()
        .filter(|node| node.tag_name().name() == "row")
        .find(|node| {
            node.attribute("r")
                .and_then(|value| value.parse::<usize>().ok())
                .map(|existing_row| existing_row > row)
                .unwrap_or(false)
        })
        .map(|node| node.range().start)
        .or_else(|| closing_tag_start(xml, sheet_data.range(), "sheetData"))
        .ok_or_else(|| PyValueError::new_err("xml_patch_miss: sheetData closing tag not found"))?;

    Ok(insert_at_index(xml, insert_at, &row_xml))
}

fn insert_cell_into_row(
    xml: &str,
    row_node: roxmltree::Node<'_, '_>,
    col: usize,
    cell_xml: &str,
) -> PyResult<String> {
    let insert_at = row_node
        .children()
        .filter(|node| node.tag_name().name() == "c")
        .find(|node| {
            node.attribute("r")
                .and_then(parse_a1)
                .map(|(existing_col, _)| existing_col > col)
                .unwrap_or(false)
        })
        .map(|node| node.range().start)
        .or_else(|| closing_tag_start(xml, row_node.range(), "row"))
        .ok_or_else(|| PyValueError::new_err("xml_patch_miss: row closing tag not found"))?;

    Ok(insert_at_index(xml, insert_at, cell_xml))
}

fn patch_merge_cells_xml(xml: &str, ranges: HashSet<String>) -> PyResult<String> {
    let without_existing = Regex::new(
        r#"(?s)<(?:[A-Za-z0-9_]+:)?mergeCells\b[^>]*>.*?</(?:[A-Za-z0-9_]+:)?mergeCells>"#,
    )
    .unwrap()
    .replace(xml, "")
    .to_string();
    if ranges.is_empty() {
        return Ok(without_existing);
    }
    let doc = Document::parse(&without_existing).map_err(to_py_runtime)?;
    let sheet_data = doc
        .descendants()
        .find(|node| node.tag_name().name() == "sheetData")
        .ok_or_else(|| {
            PyValueError::new_err("xml_patch_miss: worksheet XML has no sheetData node")
        })?;
    let sheet_data_xml = &without_existing[sheet_data.range()];
    let prefix = sheet_data_xml
        .find('>')
        .map(|idx| element_tag_prefix(&sheet_data_xml[..=idx], "sheetData"))
        .unwrap_or_default();
    let insert_at = closing_tag_start(&without_existing, sheet_data.range(), "sheetData")
        .map(|idx| {
            let close_re = Regex::new(r#"</(?:[A-Za-z0-9_]+:)?sheetData>"#).unwrap();
            close_re
                .find_at(&without_existing, idx)
                .map(|m| m.end())
                .unwrap_or(idx)
        })
        .ok_or_else(|| PyValueError::new_err("xml_patch_miss: sheetData closing tag not found"))?;
    let mut sorted = ranges.into_iter().collect::<Vec<_>>();
    sorted.sort();
    let merge_cells = format!(
        "<{prefix}mergeCells count=\"{}\">{}</{prefix}mergeCells>",
        sorted.len(),
        sorted
            .into_iter()
            .map(|range| format!("<{prefix}mergeCell ref=\"{}\" />", xml_escape(&range)))
            .collect::<Vec<_>>()
            .join("")
    );
    Ok(insert_at_index(&without_existing, insert_at, &merge_cells))
}

fn patch_sheet_objects_xml(
    xml: &str,
    sheet_name: &str,
    data_validations: &[DataValidationRule],
    auto_filters: &[AutoFilterRule],
    conditional_formats: &[ConditionalFormatRule],
) -> PyResult<String> {
    let patched = strip_sheet_object_nodes(xml);
    let doc = Document::parse(&patched).map_err(to_py_runtime)?;
    let sheet_data = doc
        .descendants()
        .find(|node| node.tag_name().name() == "sheetData")
        .ok_or_else(|| PyValueError::new_err("object_patch: worksheet XML has no sheetData"))?;
    let sheet_data_xml = &patched[sheet_data.range()];
    let prefix = sheet_data_xml
        .find('>')
        .map(|idx| element_tag_prefix(&sheet_data_xml[..=idx], "sheetData"))
        .unwrap_or_default();
    let insert_at = closing_tag_start(&patched, sheet_data.range(), "sheetData")
        .map(|idx| {
            let close_re = Regex::new(r#"</(?:[A-Za-z0-9_]+:)?sheetData>"#).unwrap();
            close_re
                .find_at(&patched, idx)
                .map(|m| m.end())
                .unwrap_or(idx)
        })
        .ok_or_else(|| PyValueError::new_err("object_patch: sheetData closing tag not found"))?;
    let mut body = String::new();
    if let Some(rule) = auto_filters
        .iter()
        .find(|rule| rule.range.sheet == sheet_name)
    {
        body.push_str(&format!(
            "<{prefix}autoFilter ref=\"{}\" />",
            xml_escape(&rule.range.ref_text())
        ));
    }
    let validations = data_validations
        .iter()
        .filter(|rule| rule.range.sheet == sheet_name)
        .collect::<Vec<_>>();
    if !validations.is_empty() {
        body.push_str(&format!(
            "<{prefix}dataValidations count=\"{}\">",
            validations.len()
        ));
        for rule in validations {
            body.push_str(&format!(
                "<{prefix}dataValidation type=\"{}\"{} allowBlank=\"{}\" sqref=\"{}\">",
                xml_escape(&rule.validation_type),
                if rule.operator.is_empty() {
                    String::new()
                } else {
                    format!(" operator=\"{}\"", xml_escape(&rule.operator))
                },
                if rule.allow_blank { "1" } else { "0" },
                xml_escape(&rule.range.ref_text())
            ));
            if !rule.formula1.is_empty() {
                body.push_str(&format!(
                    "<{prefix}formula1>{}</{prefix}formula1>",
                    xml_escape(&rule.formula1)
                ));
            }
            if !rule.formula2.is_empty() {
                body.push_str(&format!(
                    "<{prefix}formula2>{}</{prefix}formula2>",
                    xml_escape(&rule.formula2)
                ));
            }
            body.push_str(&format!("</{prefix}dataValidation>"));
        }
        body.push_str(&format!("</{prefix}dataValidations>"));
    }
    for rule in conditional_formats
        .iter()
        .filter(|rule| rule.range.sheet == sheet_name)
    {
        body.push_str(&format!(
            "<{prefix}conditionalFormatting sqref=\"{}\"><{prefix}cfRule type=\"{}\" priority=\"{}\"{}><{prefix}formula>{}</{prefix}formula></{prefix}cfRule></{prefix}conditionalFormatting>",
            xml_escape(&rule.range.ref_text()),
            xml_escape(&rule.rule_type),
            rule.priority,
            if rule.operator.is_empty() {
                String::new()
            } else {
                format!(" operator=\"{}\"", xml_escape(&rule.operator))
            },
            xml_escape(&rule.formula)
        ));
    }
    if body.is_empty() {
        Ok(patched)
    } else {
        Ok(insert_at_index(&patched, insert_at, &body))
    }
}

fn strip_sheet_object_nodes(xml: &str) -> String {
    let mut patched = xml.to_string();
    for pattern in [
        r#"(?s)<(?:[A-Za-z0-9_]+:)?autoFilter\b[^>]*/>"#,
        r#"(?s)<(?:[A-Za-z0-9_]+:)?autoFilter\b[^>]*>.*?</(?:[A-Za-z0-9_]+:)?autoFilter>"#,
        r#"(?s)<(?:[A-Za-z0-9_]+:)?dataValidations\b[^>]*>.*?</(?:[A-Za-z0-9_]+:)?dataValidations>"#,
        r#"(?s)<(?:[A-Za-z0-9_]+:)?conditionalFormatting\b[^>]*>.*?</(?:[A-Za-z0-9_]+:)?conditionalFormatting>"#,
    ] {
        patched = Regex::new(pattern)
            .unwrap()
            .replace_all(&patched, "")
            .to_string();
    }
    patched
}

fn patch_drawing_xml(
    xml: &str,
    drawing_path: &str,
    drawing_objects: &[DrawingObject],
    drawing_text_updates: &HashMap<String, String>,
) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let objects = drawing_objects
        .iter()
        .filter(|object| object.drawing_path == drawing_path)
        .collect::<Vec<_>>();
    if objects.is_empty() {
        return Ok(xml.to_string());
    }

    let mut replacements = Vec::new();
    for (anchor_ordinal, anchor) in doc
        .descendants()
        .filter(|node| {
            matches!(
                node.tag_name().name(),
                "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor"
            )
        })
        .enumerate()
    {
        let Some(object) = objects
            .iter()
            .find(|object| object.anchor_ordinal == anchor_ordinal)
        else {
            continue;
        };
        collect_anchor_marker_replacements(
            xml,
            anchor,
            "from",
            object.from_row,
            object.from_col,
            &mut replacements,
        );
        collect_anchor_marker_replacements(
            xml,
            anchor,
            "to",
            object.to_row,
            object.to_col,
            &mut replacements,
        );
        if let Some(text) = drawing_text_updates.get(&object.object_id) {
            collect_drawing_text_replacement(xml, anchor, text, &mut replacements);
        }
    }

    replacements.sort_by_key(|(start, _, _)| *start);
    let mut patched = xml.to_string();
    for (start, end, replacement) in replacements.into_iter().rev() {
        patched.replace_range(start..end, &replacement);
    }
    Ok(patched)
}

fn patch_sparkline_source_xml(
    xml: &str,
    sheet_name: &str,
    high_risk_objects: &[HighRiskObject],
    dirty_objects: &HashSet<String>,
) -> PyResult<String> {
    if dirty_objects.is_empty() {
        return Ok(xml.to_string());
    }
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let sparkline_objects = high_risk_objects
        .iter()
        .filter(|object| object.sheet == sheet_name && object.object_type == "sparkline")
        .collect::<Vec<_>>();
    let mut replacements = Vec::new();
    let mut applied = HashSet::new();

    for (idx, sparkline) in doc
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "sparkline")
        .enumerate()
    {
        let Some(object) = sparkline_objects.get(idx) else {
            continue;
        };
        if !dirty_objects.contains(&object.object_id) {
            continue;
        }
        let formula_node = sparkline
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == "f")
            .ok_or_else(|| {
                PyValueError::new_err("xml_patch_miss: sparkline source formula node missing")
            })?;
        let sqref_node = sparkline
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == "sqref")
            .ok_or_else(|| PyValueError::new_err("xml_patch_miss: sparkline sqref node missing"))?;
        replace_node_text(xml, formula_node, &object.source_formula, &mut replacements);
        replace_node_text(xml, sqref_node, &object.ref_text, &mut replacements);
        applied.insert(object.object_id.clone());
    }

    for object_id in dirty_objects {
        if high_risk_objects.iter().any(|object| {
            object.sheet == sheet_name
                && object.object_type == "sparkline"
                && object.object_id == *object_id
        }) && !applied.contains(object_id)
        {
            return Err(PyValueError::new_err(
                "xml_patch_miss: sparkline object not found in worksheet XML",
            ));
        }
    }

    replacements.sort_by_key(|(start, _, _)| *start);
    let mut patched = xml.to_string();
    for (start, end, replacement) in replacements.into_iter().rev() {
        patched.replace_range(start..end, &replacement);
    }
    Ok(patched)
}

fn collect_drawing_text_replacement(
    xml: &str,
    anchor: roxmltree::Node<'_, '_>,
    text: &str,
    replacements: &mut Vec<(usize, usize, String)>,
) {
    let Some(text_node) = anchor
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "t")
    else {
        return;
    };
    replace_node_text(xml, text_node, text, replacements);
}

fn collect_anchor_marker_replacements(
    xml: &str,
    anchor: roxmltree::Node<'_, '_>,
    marker_name: &str,
    row: Option<usize>,
    col: Option<usize>,
    replacements: &mut Vec<(usize, usize, String)>,
) {
    let Some(marker) = anchor
        .children()
        .find(|child| child.is_element() && child.tag_name().name() == marker_name)
    else {
        return;
    };
    if let Some(col) = col {
        collect_child_text_replacement(xml, marker, "col", col.saturating_sub(1), replacements);
    }
    if let Some(row) = row {
        collect_child_text_replacement(xml, marker, "row", row.saturating_sub(1), replacements);
    }
}

fn collect_child_text_replacement(
    xml: &str,
    parent: roxmltree::Node<'_, '_>,
    child_name: &str,
    value: usize,
    replacements: &mut Vec<(usize, usize, String)>,
) {
    let Some(child) = parent
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == child_name)
    else {
        return;
    };
    let range = child.range();
    let whole = &xml[range.clone()];
    let Some(start_end) = whole.find('>') else {
        return;
    };
    let Some(close_start) = whole.rfind("</") else {
        return;
    };
    let replacement = format!("{}{}{}", &whole[..=start_end], value, &whole[close_start..]);
    replacements.push((range.start, range.end, replacement));
}

fn patch_chart_xml(xml: &str, title: Option<&str>, source_range: Option<&str>) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let mut replacements = Vec::new();
    if let Some(title) = title {
        let title_node = doc
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "title")
            .ok_or_else(|| PyValueError::new_err("chart_patch: chart title node missing"))?;
        let text_node = title_node
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "t")
            .ok_or_else(|| PyValueError::new_err("chart_patch: chart title text node missing"))?;
        replace_node_text(xml, text_node, title, &mut replacements);
    }
    if let Some(source_range) = source_range {
        let formula_node = doc
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "f")
            .ok_or_else(|| {
                PyValueError::new_err("chart_patch: chart source formula node missing")
            })?;
        replace_node_text(xml, formula_node, source_range, &mut replacements);
    }
    replacements.sort_by_key(|(start, _, _)| *start);
    let mut patched = xml.to_string();
    for (start, end, replacement) in replacements.into_iter().rev() {
        patched.replace_range(start..end, &replacement);
    }
    Ok(patched)
}

fn patch_pivot_table_xml(xml: &str, object: &HighRiskObject) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let node = doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "pivotTableDefinition")
        .ok_or_else(|| {
            PyValueError::new_err("xml_patch_miss: pivotTableDefinition node missing")
        })?;
    let range = node.range();
    let whole = &xml[range.clone()];
    let start_end = whole
        .find('>')
        .ok_or_else(|| PyValueError::new_err("xml_patch_miss: pivotTableDefinition start tag"))?;
    let start_tag = &whole[..=start_end];
    let start_tag = with_xml_attr(start_tag, "name", Some(&object.name));
    let start_tag = with_xml_attr(&start_tag, "dataCaption", Some(&object.pivot_data_caption));
    let replacement = format!("{}{}", start_tag, &whole[start_end + 1..]);
    let mut patched = xml.to_string();
    patched.replace_range(range.start..range.end, &replacement);
    Ok(patched)
}

fn replace_node_text(
    xml: &str,
    node: roxmltree::Node<'_, '_>,
    value: &str,
    replacements: &mut Vec<(usize, usize, String)>,
) {
    let range = node.range();
    let whole = &xml[range.clone()];
    let Some(start_end) = whole.find('>') else {
        return;
    };
    let Some(close_start) = whole.rfind("</") else {
        return;
    };
    let replacement = format!(
        "{}{}{}",
        &whole[..=start_end],
        xml_escape(value),
        &whole[close_start..]
    );
    replacements.push((range.start, range.end, replacement));
}

fn patch_worksheet_structure_xml(
    xml: &str,
    sheet_name: &str,
    edits: &[StructureEdit],
) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let sheet_data = doc
        .descendants()
        .find(|node| node.tag_name().name() == "sheetData")
        .ok_or_else(|| PyValueError::new_err("structure_patch: worksheet has no sheetData"))?;
    let sheet_data_xml = &xml[sheet_data.range()];
    let start_end = sheet_data_xml
        .find('>')
        .ok_or_else(|| PyValueError::new_err("structure_patch: malformed sheetData"))?;
    let close_start = sheet_data_xml
        .rfind("</")
        .ok_or_else(|| PyValueError::new_err("structure_patch: sheetData closing tag missing"))?;
    let sheet_data_start = &sheet_data_xml[..=start_end];
    let sheet_data_end = &sheet_data_xml[close_start..];

    let mut rows = Vec::new();
    let mut max_row = 0usize;
    let mut max_col = 0usize;

    for row_node in sheet_data
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "row")
    {
        let old_row = row_node
            .attribute("r")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if old_row == 0 {
            continue;
        }
        let Some(new_row) = transform_row_through_edits(old_row, sheet_name, edits) else {
            continue;
        };
        let row_range = row_node.range();
        let row_xml = &xml[row_range.clone()];
        let Some(row_start_end) = row_xml.find('>') else {
            continue;
        };
        let row_close_start = row_xml.rfind("</");
        let row_prefix = element_tag_prefix(&row_xml[..=row_start_end], "row");
        let mut row_start =
            with_xml_attr(&row_xml[..=row_start_end], "r", Some(&new_row.to_string()));
        row_start = normalize_open_tag(&row_start);
        let row_end = row_close_start
            .map(|idx| row_xml[idx..].to_string())
            .unwrap_or_else(|| format!("</{row_prefix}row>"));

        let mut cells = Vec::new();
        let mut other_children = Vec::new();
        for child in row_node.children().filter(|node| node.is_element()) {
            if child.tag_name().name() != "c" {
                other_children.push(xml[child.range()].to_string());
                continue;
            }
            let Some(cell_ref) = child.attribute("r") else {
                other_children.push(xml[child.range()].to_string());
                continue;
            };
            let Some((old_col, old_cell_row)) = parse_a1(cell_ref) else {
                other_children.push(xml[child.range()].to_string());
                continue;
            };
            let old_key = Key {
                sheet: sheet_name.to_string(),
                row: old_cell_row,
                col: old_col,
            };
            let Some(new_key) = transform_key_through_edits(old_key, edits) else {
                continue;
            };
            let cell_xml = update_cell_ref_xml(
                &xml[child.range()],
                &format!("{}{}", col_to_name(new_key.col), new_key.row),
            );
            max_row = max_row.max(new_key.row);
            max_col = max_col.max(new_key.col);
            cells.push((new_key.col, cell_xml));
        }
        cells.sort_by_key(|(col, _)| *col);
        max_row = max_row.max(new_row);
        let mut body = String::new();
        for (_, cell_xml) in cells {
            body.push_str(&cell_xml);
        }
        for child_xml in other_children {
            body.push_str(&child_xml);
        }
        rows.push((new_row, format!("{row_start}{body}{row_end}")));
    }

    rows.sort_by_key(|(row, _)| *row);
    let mut sheet_data_replacement = String::new();
    sheet_data_replacement.push_str(sheet_data_start);
    for (_, row_xml) in rows {
        sheet_data_replacement.push_str(&row_xml);
    }
    sheet_data_replacement.push_str(sheet_data_end);

    let mut patched = String::with_capacity(xml.len() + sheet_data_replacement.len());
    patched.push_str(&xml[..sheet_data.range().start]);
    patched.push_str(&sheet_data_replacement);
    patched.push_str(&xml[sheet_data.range().end..]);
    Ok(patch_dimension_ref(&patched, max_row, max_col))
}

fn transform_key_through_edits(mut key: Key, edits: &[StructureEdit]) -> Option<Key> {
    for edit in edits {
        key = transform_key(&key, edit)?;
    }
    Some(key)
}

fn transform_row_through_edits(
    mut row: usize,
    sheet_name: &str,
    edits: &[StructureEdit],
) -> Option<usize> {
    for edit in edits
        .iter()
        .filter(|edit| edit.sheet == sheet_name && edit.axis == StructureAxis::Row)
    {
        row = transform_coord(row, edit)?;
    }
    Some(row)
}

fn update_cell_ref_xml(cell_xml: &str, cell_ref: &str) -> String {
    let Some(start_end) = cell_xml.find('>') else {
        return cell_xml.to_string();
    };
    let start = with_xml_attr(&cell_xml[..=start_end], "r", Some(cell_ref));
    format!("{start}{}", &cell_xml[start_end + 1..])
}

fn normalize_open_tag(start_tag: &str) -> String {
    if start_tag.trim_end().ends_with("/>") {
        format!(
            "{}>",
            start_tag.trim_end().trim_end_matches("/>").trim_end()
        )
    } else {
        start_tag.to_string()
    }
}

fn patch_dimension_ref(xml: &str, max_row: usize, max_col: usize) -> String {
    if max_row == 0 || max_col == 0 {
        return xml.to_string();
    }
    let ref_value = format!("A1:{}{}", col_to_name(max_col), max_row);
    Regex::new(r#"<(?:[A-Za-z0-9_]+:)?dimension\b[^>]*\bref="[^"]*"[^>]*/?>"#)
        .unwrap()
        .replace(xml, |caps: &regex::Captures<'_>| {
            with_xml_attr(
                caps.get(0).map(|m| m.as_str()).unwrap_or(""),
                "ref",
                Some(&ref_value),
            )
        })
        .to_string()
}

fn patch_table_xml(xml: &str, table: &TableInfo) -> PyResult<String> {
    let doc = Document::parse(xml).map_err(to_py_runtime)?;
    let table_node = doc
        .descendants()
        .find(|node| node.tag_name().name() == "table")
        .ok_or_else(|| PyValueError::new_err("table_patch: table node missing"))?;
    let range = table_node.range();
    let whole = &xml[range.clone()];
    let start_end = whole
        .find('>')
        .ok_or_else(|| PyValueError::new_err("table_patch: malformed table start tag"))?;
    let start_tag = with_xml_attr(&whole[..=start_end], "ref", Some(&table_ref(table)));
    let mut patched = xml.to_string();
    patched.replace_range(range.start..range.start + start_end + 1, &start_tag);
    Ok(patched)
}

fn build_comments_xml(comments: Vec<&CellComment>) -> String {
    let mut sorted = comments;
    sorted.sort_by_key(|comment| (comment.key.row, comment.key.col));
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Sheet Shadow</author></authors><commentList>"#,
    );
    for comment in sorted {
        let cell_ref = format!("{}{}", col_to_name(comment.key.col), comment.key.row);
        xml.push_str(&format!(
            r#"<comment ref="{}" authorId="0"><text><r><t>{}</t></r></text></comment>"#,
            xml_escape(&cell_ref),
            xml_escape(&comment.text)
        ));
    }
    xml.push_str("</commentList></comments>");
    xml
}

fn patch_content_types_for_comments(
    xml: &str,
    comment_parts: &HashMap<String, String>,
) -> PyResult<String> {
    if comment_parts.is_empty() {
        return Ok(xml.to_string());
    }
    let mut patched = xml.to_string();
    let mut insertions = String::new();
    for part in comment_parts.values() {
        let part_name = format!("/{}", part);
        if patched.contains(&format!("PartName=\"{}\"", part_name)) {
            continue;
        }
        insertions.push_str(&format!(
            r#"<Override PartName="{}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>"#,
            xml_escape(&part_name)
        ));
    }
    if insertions.is_empty() {
        return Ok(patched);
    }
    let idx = patched
        .rfind("</Types>")
        .ok_or_else(|| PyValueError::new_err("comment_patch: content types closing tag missing"))?;
    patched.insert_str(idx, &insertions);
    Ok(patched)
}

fn patch_sheet_rels_for_comments(xml: &str, comment_part: &str) -> PyResult<String> {
    let target = comment_part
        .strip_prefix("xl/")
        .unwrap_or(comment_part)
        .to_string();
    if xml.trim().is_empty() {
        return Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSheetShadowComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../{}"/></Relationships>"#,
            xml_escape(&target)
        ));
    }
    if xml.contains("relationships/comments") {
        return Ok(xml.to_string());
    }
    let idx = xml
        .rfind("</Relationships>")
        .ok_or_else(|| PyValueError::new_err("comment_patch: rels closing tag missing"))?;
    let mut patched = xml.to_string();
    patched.insert_str(
        idx,
        &format!(
            r#"<Relationship Id="rIdSheetShadowComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../{}"/>"#,
            xml_escape(&target)
        ),
    );
    Ok(patched)
}

fn object_audit_event(
    event_type: &str,
    sheet: &str,
    row: usize,
    col: usize,
    old_value: &str,
    new_value: &str,
    reason: &str,
) -> AuditEvent {
    AuditEvent {
        event_type: event_type.to_string(),
        sheet: sheet.to_string(),
        row,
        col,
        old_value: old_value.to_string(),
        new_value: new_value.to_string(),
        formula: String::new(),
        reason: reason.to_string(),
    }
}

fn drawing_object_to_map(object: &DrawingObject) -> HashMap<String, String> {
    HashMap::from([
        ("object_id".to_string(), object.object_id.clone()),
        ("object_type".to_string(), object.object_type.clone()),
        ("sheet".to_string(), object.sheet.clone()),
        ("ref".to_string(), object.ref_text()),
        ("drawing_path".to_string(), object.drawing_path.clone()),
        ("anchor_kind".to_string(), object.anchor_kind.clone()),
        (
            "from_row".to_string(),
            object
                .from_row
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "from_col".to_string(),
            object.from_col.map(col_to_name).unwrap_or_default(),
        ),
        (
            "to_row".to_string(),
            object
                .to_row
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "to_col".to_string(),
            object.to_col.map(col_to_name).unwrap_or_default(),
        ),
        ("rel_id".to_string(), object.rel_id.clone()),
        ("target_path".to_string(), object.target_path.clone()),
        (
            "relationship_valid".to_string(),
            object.relationship_valid.to_string(),
        ),
        (
            "target_exists".to_string(),
            object.target_exists.to_string(),
        ),
        ("invalid_reason".to_string(), object.invalid_reason.clone()),
    ])
}

fn drawing_diagnostic(
    object: &DrawingObject,
    code: &str,
    not_completed: &str,
    message: &str,
) -> HashMap<String, String> {
    let mut item = drawing_object_to_map(object);
    item.insert("code".to_string(), code.to_string());
    item.insert("not_completed".to_string(), not_completed.to_string());
    item.insert("message".to_string(), message.to_string());
    item
}

fn high_risk_object_to_map(object: &HighRiskObject) -> HashMap<String, String> {
    let write_supported = high_risk_write_supported(object);
    let mutation_status = high_risk_object_mutation_status(object);
    HashMap::from([
        ("object_id".to_string(), object.object_id.clone()),
        ("object_type".to_string(), object.object_type.clone()),
        ("sheet".to_string(), object.sheet.clone()),
        ("ref".to_string(), object.ref_text.clone()),
        ("source_path".to_string(), object.source_path.clone()),
        ("rel_id".to_string(), object.rel_id.clone()),
        ("rel_type".to_string(), object.rel_type.clone()),
        ("target_path".to_string(), object.target_path.clone()),
        ("target_mode".to_string(), object.target_mode.clone()),
        (
            "target_exists".to_string(),
            object.target_exists.to_string(),
        ),
        ("target_size".to_string(), object.target_size.to_string()),
        (
            "relationship_valid".to_string(),
            object.relationship_valid.to_string(),
        ),
        ("name".to_string(), object.name.clone()),
        ("source_formula".to_string(), object.source_formula.clone()),
        ("cache_path".to_string(), object.cache_path.clone()),
        ("cache_rel_id".to_string(), object.cache_rel_id.clone()),
        (
            "cache_target_mode".to_string(),
            object.cache_target_mode.clone(),
        ),
        ("cache_exists".to_string(), object.cache_exists.to_string()),
        ("cache_size".to_string(), object.cache_size.to_string()),
        ("pivot_cache_id".to_string(), object.pivot_cache_id.clone()),
        (
            "pivot_data_caption".to_string(),
            object.pivot_data_caption.clone(),
        ),
        (
            "pivot_updated_version".to_string(),
            object.pivot_updated_version.clone(),
        ),
        (
            "sparkline_group_type".to_string(),
            object.sparkline_group_type.clone(),
        ),
        (
            "sparkline_display_empty_cells_as".to_string(),
            object.sparkline_display_empty_cells_as.clone(),
        ),
        (
            "sparkline_markers".to_string(),
            object.sparkline_markers.clone(),
        ),
        ("ole_extension".to_string(), object.ole_extension.clone()),
        ("invalid_reason".to_string(), object.invalid_reason.clone()),
        ("write_supported".to_string(), write_supported.to_string()),
        ("mutation_status".to_string(), mutation_status.to_string()),
    ])
}

fn high_risk_write_supported(object: &HighRiskObject) -> bool {
    match object.object_type.as_str() {
        "sparkline" => !object.source_formula.trim().is_empty() && object.invalid_reason.is_empty(),
        "pivot_table" => {
            object.target_exists
                && object.target_mode.is_empty()
                && !object.target_path.is_empty()
                && !object.cache_path.is_empty()
                && object.cache_exists
                && object.cache_target_mode.is_empty()
                && object.invalid_reason.is_empty()
        }
        "ole_object" => {
            object.target_exists
                && object.target_mode.is_empty()
                && !object.target_path.is_empty()
                && !object.ole_extension.is_empty()
                && object.invalid_reason.is_empty()
        }
        _ => false,
    }
}

fn high_risk_object_mutation_status(object: &HighRiskObject) -> &'static str {
    if !high_risk_write_supported(object) {
        return "no_write_boundary";
    }
    match object.object_type.as_str() {
        "sparkline" => "update_source_only",
        "pivot_table" => "update_pivot_metadata_only",
        "ole_object" => "replace_existing_package_only",
        _ => "no_write_boundary",
    }
}

fn high_risk_sheet_mutation_status(objects: &[&HighRiskObject]) -> &'static str {
    let statuses = objects
        .iter()
        .filter(|object| high_risk_write_supported(object))
        .map(|object| high_risk_object_mutation_status(object))
        .collect::<HashSet<_>>();
    match statuses.len() {
        0 => "no_write_boundary",
        1 => statuses
            .iter()
            .next()
            .copied()
            .unwrap_or("no_write_boundary"),
        _ => "semantic_write_available",
    }
}

fn high_risk_diagnostic(
    object: &HighRiskObject,
    code: &str,
    not_completed: &str,
    message: &str,
) -> HashMap<String, String> {
    let mut item = high_risk_object_to_map(object);
    item.insert("severity".to_string(), "warning".to_string());
    item.insert("code".to_string(), code.to_string());
    item.insert("not_completed".to_string(), not_completed.to_string());
    item.insert("message".to_string(), message.to_string());
    item
}

fn unique_sorted_values(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out.sort();
    out
}

fn shift_drawing_marker(marker: &mut Option<usize>, edit: &StructureEdit) -> bool {
    let Some(value) = *marker else {
        return false;
    };
    let Some(next) = transform_coord(value, edit) else {
        return false;
    };
    if next != value {
        *marker = Some(next);
        true
    } else {
        false
    }
}

fn drawing_marker_deleted(marker: Option<usize>, edit: &StructureEdit) -> bool {
    matches!(edit.kind, StructureOpKind::Delete)
        && marker.is_some_and(|coord| (edit.start..=edit.end).contains(&coord))
}

fn normalize_chart_source_range(source_range: &str) -> PyResult<String> {
    let trimmed = source_range.trim();
    if trimmed.is_empty() || trimmed.contains('<') || trimmed.contains('>') {
        return Err(PyValueError::new_err(
            "unsafe_update: chart source range must be a non-empty A1 range",
        ));
    }
    let re = Regex::new(
        r#"(?i)^(?:'[^']+'|[A-Za-z_][A-Za-z0-9_ ]*)!\$?[A-Z]{1,3}\$?[0-9]+(?::\$?[A-Z]{1,3}\$?[0-9]+)?$"#,
    )
    .unwrap();
    if !re.is_match(trimmed) {
        return Err(PyValueError::new_err(
            "unsafe_update: chart source range must include an explicit sheet and A1 range",
        ));
    }
    Ok(trimmed.to_string())
}

fn shift_object_range(range: &mut ObjectRange, edit: &StructureEdit) -> bool {
    let old = range.ref_text();
    match edit.axis {
        StructureAxis::Row => {
            let (start, end) = shift_span(range.start_row, range.end_row, edit);
            range.start_row = start;
            range.end_row = end;
        }
        StructureAxis::Col => {
            let (start, end) = shift_span(range.start_col, range.end_col, edit);
            range.start_col = start;
            range.end_col = end;
        }
    }
    old != range.ref_text()
}

fn valid_object_range(range: &ObjectRange) -> bool {
    range.start_row > 0
        && range.start_col > 0
        && range.end_row >= range.start_row
        && range.end_col >= range.start_col
}

fn insert_at_index(xml: &str, idx: usize, insertion: &str) -> String {
    let mut patched = String::with_capacity(xml.len() + insertion.len());
    patched.push_str(&xml[..idx]);
    patched.push_str(insertion);
    patched.push_str(&xml[idx..]);
    patched
}

fn closing_tag_start(xml: &str, range: std::ops::Range<usize>, local_name: &str) -> Option<usize> {
    let fragment = &xml[range.clone()];
    let re = Regex::new(&format!(
        r#"</(?:[A-Za-z0-9_]+:)?{}\s*>"#,
        regex::escape(local_name)
    ))
    .ok()?;
    re.find_iter(fragment)
        .last()
        .map(|m| range.start + m.start())
}

fn build_existing_cell_xml(
    xml: &str,
    cell_node: roxmltree::Node<'_, '_>,
    start_tag: &str,
    prefix: &str,
    end_tag: &str,
    value: &str,
    formula: Option<&str>,
    shared_string_index: Option<usize>,
    force_inline_string: bool,
    style_id: Option<u32>,
    rich_inline_payload: Option<&str>,
) -> String {
    let start_tag = typed_cell_start_tag(
        start_tag,
        value,
        formula,
        shared_string_index,
        force_inline_string,
    );
    let start_tag = with_cell_style_attr(&start_tag, style_id);
    let payload = cell_value_payload(
        prefix,
        value,
        formula,
        shared_string_index,
        force_inline_string,
        rich_inline_payload,
    );
    let mut body = String::new();
    let mut inserted_payload = false;

    for child in cell_node.children().filter(|node| node.is_element()) {
        if matches!(child.tag_name().name(), "f" | "v" | "is") {
            if !inserted_payload {
                body.push_str(&payload);
                inserted_payload = true;
            }
            continue;
        }
        body.push_str(&xml[child.range()]);
    }

    if !inserted_payload {
        body = format!("{payload}{body}");
    }

    format!("{start_tag}{body}{end_tag}")
}

fn rich_inline_string_payload(
    xml: &str,
    cell_node: roxmltree::Node<'_, '_>,
    value: &str,
) -> Option<String> {
    let inline_node = cell_node
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "is")?;
    update_text_container_payload(xml, inline_node, value)
}

fn update_text_container_payload(
    xml: &str,
    container_node: roxmltree::Node<'_, '_>,
    value: &str,
) -> Option<String> {
    let runs: Vec<_> = container_node
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "r")
        .collect();
    if !runs.is_empty() {
        return update_rich_text_container_payload(xml, container_node, &runs, value);
    }

    let text_node = container_node
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "t")?;
    let text_range = text_node.range();
    let text_xml = &xml[text_range.clone()];
    let text_start_end = text_xml.find('>')?;
    let text_close_start = text_xml.rfind("</")?;
    let replacement_text = format!(
        "{}{}{}",
        &text_xml[..=text_start_end],
        xml_escape(value),
        &text_xml[text_close_start..]
    );

    let container_range = container_node.range();
    let mut payload = String::with_capacity(
        container_range.len() + replacement_text.len().saturating_sub(text_range.len()),
    );
    payload.push_str(&xml[container_range.start..text_range.start]);
    payload.push_str(&replacement_text);
    payload.push_str(&xml[text_range.end..container_range.end]);
    Some(payload)
}

fn update_rich_text_container_payload(
    xml: &str,
    container_node: roxmltree::Node<'_, '_>,
    runs: &[roxmltree::Node<'_, '_>],
    value: &str,
) -> Option<String> {
    let container_range = container_node.range();
    let mut payload = String::with_capacity(container_range.len() + value.len());
    let mut cursor = container_range.start;
    let mut remaining = value;
    let run_count = runs.len();

    for (idx, run_node) in runs.iter().enumerate() {
        let text_node = run_node
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == "t")?;
        let original_len = text_node.text().unwrap_or("").chars().count();
        let take_len = if idx + 1 == run_count {
            remaining.chars().count()
        } else {
            original_len.min(remaining.chars().count())
        };
        let replacement_text_value: String = remaining.chars().take(take_len).collect();
        let consumed_bytes = replacement_text_value.len();
        remaining = &remaining[consumed_bytes..];

        let text_range = text_node.range();
        let text_xml = &xml[text_range.clone()];
        let text_start_end = text_xml.find('>')?;
        let text_close_start = text_xml.rfind("</")?;
        let replacement_text = format!(
            "{}{}{}",
            &text_xml[..=text_start_end],
            xml_escape(&replacement_text_value),
            &text_xml[text_close_start..]
        );

        payload.push_str(&xml[cursor..text_range.start]);
        payload.push_str(&replacement_text);
        cursor = text_range.end;
    }

    payload.push_str(&xml[cursor..container_range.end]);
    Some(payload)
}

fn build_cell_xml(
    start_tag: &str,
    prefix: &str,
    end_tag: &str,
    value: &str,
    formula: Option<&str>,
    rich_inline_payload: Option<&str>,
    preserved_children: &str,
) -> String {
    let start_tag = typed_cell_start_tag(start_tag, value, formula, None, false);
    let payload = cell_value_payload(prefix, value, formula, None, false, rich_inline_payload);
    format!("{start_tag}{payload}{preserved_children}{end_tag}")
}

fn typed_cell_start_tag(
    start_tag: &str,
    value: &str,
    formula: Option<&str>,
    shared_string_index: Option<usize>,
    force_inline_string: bool,
) -> String {
    if shared_string_index.is_some() {
        with_cell_type_attr(start_tag, Some("s"))
    } else if force_inline_string {
        with_cell_type_attr(start_tag, Some("inlineStr"))
    } else if formula.is_some() || value.parse::<f64>().is_ok() {
        with_cell_type_attr(start_tag, None)
    } else {
        with_cell_type_attr(start_tag, Some("inlineStr"))
    }
}

fn cell_value_payload(
    prefix: &str,
    value: &str,
    formula: Option<&str>,
    shared_string_index: Option<usize>,
    force_inline_string: bool,
    rich_inline_payload: Option<&str>,
) -> String {
    if let Some(index) = shared_string_index {
        format!("<{prefix}v>{index}</{prefix}v>")
    } else if let Some(formula) = formula {
        format!(
            "<{prefix}f>{}</{prefix}f><{prefix}v>{}</{prefix}v>",
            xml_escape(formula.trim_start_matches('=')),
            xml_escape(value),
        )
    } else if value.parse::<f64>().is_ok() && !force_inline_string {
        format!("<{prefix}v>{}</{prefix}v>", xml_escape(value))
    } else {
        rich_inline_payload
            .map(|payload| payload.to_string())
            .unwrap_or_else(|| {
                format!(
                    "<{prefix}is><{prefix}t>{}</{prefix}t></{prefix}is>",
                    xml_escape(value)
                )
            })
    }
}

fn inserted_cell_xml(
    prefix: &str,
    cell_ref: &str,
    value: &str,
    formula: Option<&str>,
    style_id: Option<u32>,
) -> String {
    let start_tag = format!("<{prefix}c r=\"{cell_ref}\">");
    let end_tag = format!("</{prefix}c>");
    let start_tag = with_cell_style_attr(&start_tag, style_id);
    build_cell_xml(&start_tag, prefix, &end_tag, value, formula, None, "")
}

fn cell_tag_prefix(start_tag: &str) -> String {
    element_tag_prefix(start_tag, "c")
}

fn element_tag_prefix(start_tag: &str, local_name: &str) -> String {
    Regex::new(&format!(
        r#"^<([A-Za-z0-9_]+:)?{}\b"#,
        regex::escape(local_name)
    ))
    .unwrap()
    .captures(start_tag)
    .and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
    .unwrap_or_default()
}

fn normalize_cell_start_tag(start_tag: &str) -> String {
    if start_tag.ends_with("/>") {
        format!("{}>", start_tag.trim_end_matches("/>").trim_end())
    } else {
        start_tag.to_string()
    }
}

fn with_cell_type_attr(start_tag: &str, cell_type: Option<&str>) -> String {
    let without_type = Regex::new(r#"\s+t="[^"]*""#)
        .unwrap()
        .replace_all(start_tag, "")
        .to_string();
    if let Some(cell_type) = cell_type {
        format!(
            "{} t=\"{}\">",
            without_type.trim_end_matches('>'),
            xml_escape(cell_type)
        )
    } else {
        without_type
    }
}

fn with_cell_style_attr(start_tag: &str, style_id: Option<u32>) -> String {
    let Some(style_id) = style_id else {
        return start_tag.to_string();
    };
    with_xml_attr(start_tag, "s", Some(&style_id.to_string()))
}

fn with_xml_attr(start_tag: &str, name: &str, value: Option<&str>) -> String {
    let re = Regex::new(&format!(r#"\s+{}="[^"]*""#, regex::escape(name))).unwrap();
    let without_attr = re.replace_all(start_tag, "").to_string();
    let self_closing = without_attr.trim_end().ends_with("/>");
    let body = if self_closing {
        without_attr.trim_end().trim_end_matches("/>").trim_end()
    } else {
        without_attr.trim_end_matches('>').trim_end()
    };
    if let Some(value) = value {
        let close = if self_closing { " />" } else { ">" };
        format!("{} {}=\"{}\"{}", body, name, xml_escape(value), close)
    } else if self_closing {
        format!("{body} />")
    } else {
        without_attr
    }
}

fn numeric_cell(cells: &HashMap<Key, String>, key: &Key) -> f64 {
    cells
        .get(key)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn normalized_number(value: &str) -> String {
    value
        .parse::<f64>()
        .map(format_number)
        .unwrap_or_else(|_| value.to_string())
}

fn format_number(value: f64) -> String {
    if value.fract().abs() < 0.0000001 {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{:.10}", value);
        while text.contains('.') && text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
        text
    }
}

fn parse_a1(cell_ref: &str) -> Option<(usize, usize)> {
    let mut letters = String::new();
    let mut digits = String::new();
    for ch in cell_ref.chars() {
        if ch.is_ascii_alphabetic() {
            letters.push(ch);
        } else if ch.is_ascii_digit() {
            digits.push(ch);
        }
    }
    Some((col_from_name(&letters)?, digits.parse().ok()?))
}

fn col_from_name(name: &str) -> Option<usize> {
    let mut col = 0usize;
    for ch in name.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        col = col * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    Some(col)
}

fn col_to_name(mut col: usize) -> String {
    let mut name = String::new();
    while col > 0 {
        let rem = (col - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        col = (col - 1) / 26;
    }
    name
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn to_py_runtime<E: std::fmt::Display>(err: E) -> PyErr {
    PyRuntimeError::new_err(err.to_string())
}

fn to_py_store_update<E: std::fmt::Display>(err: E) -> PyErr {
    let message = err.to_string();
    if message.contains("unsafe_update:") {
        PyValueError::new_err(message)
    } else {
        PyValueError::new_err(format!("unsafe_update: {message}"))
    }
}

#[pymodule]
fn sheet_shadow_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<CellCoord>()?;
    m.add_class::<ShadowMetaRecord>()?;
    m.add_class::<SheetShadowEngine>()?;
    Ok(())
}
