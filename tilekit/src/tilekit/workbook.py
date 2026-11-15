"""Lay out and build the stored review workbooks (tile, module and model) with GridCraft.

One layout engine serves all three kinds. A workbook is planned as a list of
`SheetPlan`s, each made of a title, an optional parameters block, sections of time
rows (months across the columns) and sections of single-cell rows (for summary
tiles). Rows are allocated first, so a formula can refer to any row in the
workbook, then rendered into GridCraft commands in the house style. After the
build the computed values of every formula row are read back and compared with
the Python trace: that is the difference check.

The model workbook also replicates the input series that declare an `excel` template
in `tilekit.toml`: assumption tables are laid out on an "Assumptions" sheet and those
inputs become live formula rows on "Inputs" (checked against Python like tile rows).

The "Scratch" sheet belongs to the user: it is created empty the first time and is
never cleared, styled or written afterwards. Generated sheets are cleared and
rewritten in place (not deleted) so formulas on Scratch that point at them survive.
"""

import dataclasses
import hashlib
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from tilekit.cases import case_months, load_cases
from tilekit.errors import TilekitError
from tilekit.graph import param_fields
from tilekit.stamps import upstream_tiles
from tilekit.trace import branch_counts, near_tie_map, run_case
from tilekit import handchecks
from tilekit.translate import TOLERANCE_ABS, model_translations

TOLERANCE_REL = 1e-12
SCRATCH = "Scratch"
FONT_NAME, FONT_SIZE = "Open Sans", 10
BLUE, MAROON, GREY = "#0000FF", "#800000", "#808080"
GREEN = "#006100"  # bold: a value that comes from elsewhere in the model (another tile, module or sheet)
EDGE_PX = 20  # width of column A and height of row 1
CHAR_PX = 7  # GridCraft's pixel widths assume a 7 px character
DEFAULT_COLUMN_PX = 64

FORMAT_CODES = {
    "amount": "#,##0.00",
    "units": "#,##0.0000",
    "number": "#,##0.0000",
    "percent": "0.00%",
    "rate": "0.0000%",
    "irr": "0.0%",
    "integer": "0",
    "small": "0.000000",
}
AMOUNT_LARGE = "#,##0"
DIFFERENCE_FORMAT = "0.0000"

_DISPLAY = {
    "#,##0.00": lambda v: f"{v:,.2f}",
    "#,##0": lambda v: f"{v:,.0f}",
    "#,##0.0000": lambda v: f"{v:,.4f}",
    "0.00%": lambda v: f"{v * 100:.2f}%",
    "0.0000%": lambda v: f"{v * 100:.4f}%",
    "0.0%": lambda v: f"{v * 100:.1f}%",
    "0": lambda v: f"{v:.0f}",
    "0.0000": lambda v: f"{v:.4f}",
    "0.000000": lambda v: f"{v:.6f}",
}


def number_format(fmt, values=()):
    """Excel number format for a `Format`; amounts drop the decimals when any value reaches 1,000,000."""
    if fmt == "amount":
        finite = [abs(v) for v in np.ravel(values) if v is not None and math.isfinite(v)]
        if finite and max(finite) >= 1_000_000:
            return AMOUNT_LARGE
    return FORMAT_CODES.get(fmt or "number", FORMAT_CODES["number"])


def display_length(code, values):
    show = _DISPLAY.get(code, lambda v: f"{v:.4f}")
    lengths = [len(show(float(v))) for v in np.ravel(values) if v is not None and math.isfinite(float(v))]
    return max(lengths, default=0)


def column_letter(index):
    """1 -> A, 27 -> AA."""
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


FIRST_MONTH_COL = 3  # C


def month_col(k):
    """Column letter of month k (0-based)."""
    return column_letter(FIRST_MONTH_COL + k)


_CELL_LIKE = re.compile(r"^([A-Za-z]{1,3}\d+|[RrCc]|[Rr]\d*[Cc]\d*)$")
# Names Excel reads as a boolean or a function; a defined name spelled like one gets a trailing underscore.
EXCEL_RESERVED = frozenset({
    "true", "false", "sum", "sumproduct", "if", "min", "max", "and", "or", "not", "irr", "npv", "index", "match",
    "round", "int", "abs", "exp", "ln", "sqrt", "average", "count", "na", "pi", "today", "now", "rand",
})


def excel_name(name):
    """A defined name for a Python name; one that would read as a cell reference, a boolean or an Excel
    function (`true`, `sum`, `if`, `irr`, ... in any case) gets a trailing underscore."""
    return name + "_" if _CELL_LIKE.match(name) or name.lower() in EXCEL_RESERVED else name


def quote_sheet(sheet):
    return "'" + sheet.replace("'", "''") + "'"


_BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")


def sheet_name(text, taken):
    name = _BAD_SHEET_CHARS.sub(" ", text).strip().strip("'")[:31] or "Sheet"
    base, i = name, 2
    while name.lower() in {t.lower() for t in taken} or name.lower() == SCRATCH.lower():
        suffix = f" ({i})"
        name = base[:31 - len(suffix)] + suffix
        i += 1
    taken.add(name)
    return name


def _plain(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _pasted(value):
    """A Python value as written to a cell: NaN as #NUM! and infinities as #DIV/0!, like Excel's errors."""
    value = float(value)
    if math.isnan(value):
        return ExcelError("#NUM!")
    if math.isinf(value):
        return ExcelError("#DIV/0!")
    return value


@dataclass(frozen=True)
class ExcelError:
    """An error value to write into a cell (GridCraft parses its text into the error)."""
    text: str


# ---------------------------------------------------------------- plans

@dataclass
class Line:
    """One row: a time row (months across) or, with `scalar`, a single cell in column C."""
    key: str | None  # what formulas call this row ({key}); None for a row nothing refers to
    label: str
    content: tuple  # ("values", data) | ("formula", template) | ("state", initial, source) | ("link", name)
    fmt: str  # number format code
    # input (bold blue: a true input) | elsewhere (bold dark green: pasted from another tile or module) |
    # link (bold dark green: a live link to another sheet) | calc | output | grey
    style: str = "calc"
    name: str | None = None  # code name shown in maroon
    define: bool = False  # define a named range for it
    scalar: bool = False
    check: str | None = None  # tile whose formula row is compared with Python
    python: object = None  # Python values (for widths and the comparison)
    home: bool = True  # the row that owns the quantity in this workbook (not a link)
    tolerance: float = TOLERANCE_ABS  # absolute tolerance of the difference check
    check_kind: str = "tile"  # what `check` names: "tile" or "input"


@dataclass
class TableBlock:
    """An assumption table laid out down the rows: a bold label row, a header row of column names, values."""
    name: str
    label: str
    columns: tuple  # column names
    rows: tuple  # tuples of values
    fmts: tuple  # number format code per column


@dataclass
class SheetPlan:
    name: str
    title: str
    subtitle: str
    months: int
    params: list = field(default_factory=list)  # (name, label, value, format code)
    scope: str = "sheet"  # scope of defined names: "sheet" or "workbook"
    series: list = field(default_factory=list)  # sections of time Lines
    scalars: list = field(default_factory=list)  # sections of scalar Lines
    tables: list = field(default_factory=list)  # TableBlocks, laid out before any time rows
    case: str | None = None
    rows: dict = field(default_factory=dict)  # id(line) or id(table) -> row number (a table's label row)
    header_row: int | None = None
    header: str = "Month"  # what the numbered header row counts
    column_notes: tuple = ()  # (label, texts): a row of text above the header, one per column
    last_row: int = 3

    @property
    def last_col(self):
        return month_col(self.months - 1)

    @property
    def name_col(self):
        return month_col(self.months)


@dataclass(frozen=True)
class Loc:
    sheet: str
    row: int
    scalar: bool
    last_col: str


class Locator:
    """Where each row lives: a sheet's own rows first, then the workbook-wide home of the quantity."""

    def __init__(self):
        self.local = {}
        self.home = {}
        self.tables = {}  # (table, column) -> absolute range text, e.g. 'Assumptions'!$C$7:$C$99

    def table_range(self, sheet, ref):
        table, column = ref.split(":", 1)[1].split(".", 1)
        found = self.tables.get((table, column))
        if found is None:
            raise TilekitError(f"Workbook layout: no table column '{table}.{column}' for sheet '{sheet}'")
        target, text = found
        return text if target == sheet else f"{quote_sheet(target)}!{text}"

    def add(self, sheet, key, loc, home):
        self.local[(sheet, key)] = loc
        if home and key not in self.home:
            self.home[key] = loc
            return True
        return False

    def find(self, sheet, key):
        loc = self.local.get((sheet, key)) or self.home.get(key)
        if loc is None:
            raise TilekitError(f"Workbook layout: nothing provides '{key}' for sheet '{sheet}'")
        return loc


def allocate(plans):
    """Give every line a row number and register it with a Locator."""
    locator = Locator()
    for plan in plans:
        row = 5
        if plan.params:
            row += len(plan.params) + 1
        for table in plan.tables:
            plan.rows[id(table)] = row
            row += len(table.rows) + 3  # label, header, values, blank
        sections = [s for s in plan.series if s]
        if sections:
            plan.header_row = row
            row += 1
            for i, section in enumerate(sections):
                if i:
                    row += 1
                for line in section:
                    plan.rows[id(line)] = row
                    row += 1
            row += 1
        scalar_sections = [s for s in plan.scalars if s]
        for i, section in enumerate(scalar_sections):
            if i:
                row += 1
            for line in section:
                plan.rows[id(line)] = row
                row += 1
        plan.last_row = row - 1
    for plan in plans:
        for table in plan.tables:
            first = plan.rows[id(table)] + 2
            last = first + len(table.rows) - 1
            for index, column in enumerate(table.columns):
                letter = column_letter(2 + index)
                locator.tables[(table.name, column)] = (plan.name, f"${letter}${first}:${letter}${last}")
        for line in _lines(plan):
            if line.key is not None:
                loc = Loc(plan.name, plan.rows[id(line)], line.scalar, plan.last_col)
                is_new_home = locator.add(plan.name, line.key, loc, line.home)
                if line.define and not is_new_home and plan.scope == "workbook":
                    line.define = False  # already defined on an earlier sheet
    return locator


def _lines(plan):
    for section in [*plan.series, *plan.scalars]:
        yield from section


_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
_IDENTIFIER = re.compile(r"(?<![\w.$!'])([A-Za-z_][A-Za-z0-9_]*)(?![\w(!])")


def _cell(loc, col, from_sheet):
    prefix = "" if loc.sheet == from_sheet else quote_sheet(loc.sheet) + "!"
    return f"{prefix}{col}{loc.row}"


def _range(loc, from_sheet):
    prefix = "" if loc.sheet == from_sheet else quote_sheet(loc.sheet) + "!"
    if loc.scalar:
        return f"{prefix}C{loc.row}"
    return f"{prefix}C{loc.row}:{loc.last_col}{loc.row}"


def _rename_params(text, renames):
    if not renames:
        return text
    return _IDENTIFIER.sub(lambda m: renames.get(m.group(1), m.group(1)), text)


def _fill_tables(template, sheet, locator):
    """Replace every {table:T.col} with the absolute range of that table column."""
    return _PLACEHOLDER.sub(
        lambda m: locator.table_range(sheet, m.group(1)) if m.group(1).startswith("table:") else m.group(0),
        template)


def fill_step(template, sheet, k, locator, renames=None):
    """A step template for month k (0-based) on `sheet`."""
    text = _fill_tables(_rename_params(template, renames), sheet, locator)
    return _PLACEHOLDER.sub(lambda m: _cell(locator.find(sheet, m.group(1)), month_col(k), sheet), text)


def fill_scalar(template, sheet, locator, renames=None):
    """A summary template: series become whole row ranges, scalars single cells."""
    text = _fill_tables(_rename_params(template, renames), sheet, locator)
    return _PLACEHOLDER.sub(lambda m: _range(locator.find(sheet, m.group(1)), sheet), text)


def _line_cells(line, plan, locator, renames):
    """The values/formulas for a line's value cells."""
    kind = line.content[0]
    sheet = plan.name
    if line.scalar:
        if kind == "values":
            return [_pasted(line.content[1])]
        if kind == "formula":
            return [fill_scalar(line.content[1], sheet, locator, renames)]
        if kind == "link":
            return ["=" + _range(locator.home[line.content[1]], sheet)]
        raise TilekitError(f"Workbook layout: scalar line cannot hold {kind}")
    months = plan.months
    if kind == "values":
        return [_pasted(v) for v in line.content[1][:months]]
    if kind == "formula":
        return [fill_step(line.content[1], sheet, k, locator, renames) for k in range(months)]
    if kind == "state":
        _, initial, source = line.content
        loc = locator.find(sheet, source)
        return [_plain(initial)] + ["=" + _cell(loc, month_col(k - 1), sheet) for k in range(1, months)]
    if kind == "link":
        loc = locator.home[line.content[1]]
        return ["=" + _cell(loc, month_col(k), sheet) for k in range(months)]
    raise TilekitError(f"Workbook layout: unknown line content {kind}")


def _cmd(command, **params):
    return {"command": command, "params": params}


def render_sheet(plan, locator, renames):
    """GridCraft commands that write one generated sheet (which must be the active sheet)."""
    cmds = []
    q = quote_sheet(plan.name)
    last, name_col = plan.last_col, plan.name_col
    has_series = plan.header_row is not None
    table_cols = max([len(t.columns) + 1 for t in plan.tables], default=0)  # values, then the maroon name
    used_last_col = name_col if has_series else column_letter(max(4, 1 + table_cols))
    used = f"A1:{used_last_col}{max(plan.last_row, 3)}"

    cmds.append(_cmd("view.gridlines", on=False))
    cmds.append(_cmd("home.fontName", range=used, name=FONT_NAME))
    cmds.append(_cmd("home.fontSize", range=used, size=FONT_SIZE))
    cmds.append(_cmd("range.setValues", range="B2", values=[[plan.title]], parse=False))
    cmds.append(_cmd("home.bold", range="B2"))
    cmds.append(_cmd("range.setValues", range="B3", values=[[plan.subtitle]], parse=False))

    def define(name, refers):
        params = {"name": excel_name(name), "refersTo": refers}
        if plan.scope == "sheet":
            params["scope"] = plan.name
        cmds.append(_cmd("formulas.defineName", **params))
        return (excel_name(name), plan.name if plan.scope == "sheet" else "Workbook")

    defined = []
    for i, (name, label, value, code) in enumerate(plan.params):
        row = 5 + i
        cmds.append(_cmd("range.setValues", range=f"B{row}", values=[[label, _plain(value), name]], parse=False))
        cmds.append(_cmd("home.numberFormat", range=f"C{row}", format=code))
        defined.append(define(name, f"={q}!$C${row}"))
    if plan.params:
        end = 4 + len(plan.params)
        cmds.append(_cmd("home.bold", range=f"C5:C{end}"))
        cmds.append(_cmd("home.fontColor", range=f"C5:C{end}", color=BLUE))
        cmds.append(_cmd("home.fontColor", range=f"D5:D{end}", color=MAROON))

    for table in plan.tables:
        top = plan.rows[id(table)]
        width = len(table.columns)
        last_table_col = column_letter(1 + width)
        cmds.append(_cmd("range.setValues", range=f"B{top}", values=[[table.label]], parse=False))
        cmds.append(_cmd("home.bold", range=f"B{top}"))
        cmds.append(_cmd("range.setValues", range=f"{column_letter(2 + width)}{top}", values=[[table.name]],
                         parse=False))
        cmds.append(_cmd("home.fontColor", range=f"{column_letter(2 + width)}{top}", color=MAROON))
        cmds.append(_cmd("range.setValues", range=f"B{top + 1}", values=[list(table.columns)], parse=False))
        cmds.append(_cmd("home.bold", range=f"B{top + 1}:{last_table_col}{top + 1}"))
        cmds.append(_cmd("home.borders", range=f"B{top + 1}:{last_table_col}{top + 1}", preset="bottom", style="thin"))
        first, last_row = top + 2, top + 1 + len(table.rows)
        cmds.append(_cmd("range.setValues", range=f"B{first}",
                         values=[[_plain(v) for v in row] for row in table.rows], parse=False))
        for index, code in enumerate(table.fmts):
            letter = column_letter(2 + index)
            cmds.append(_cmd("home.numberFormat", range=f"{letter}{first}:{letter}{last_row}", format=code))
        cmds.append(_cmd("home.bold", range=f"B{first}:{last_table_col}{last_row}"))
        cmds.append(_cmd("home.fontColor", range=f"B{first}:{last_table_col}{last_row}", color=BLUE))

    if has_series:
        h = plan.header_row
        cmds.append(_cmd("range.setValues", range=f"B{h}", values=[[plan.header, *range(1, plan.months + 1)]]))
        if plan.column_notes:
            label, texts = plan.column_notes
            cmds.append(_cmd("range.setValues", range=f"B{h - 1}", values=[[label, *texts]], parse=False))
            cmds.append(_cmd("home.fontColor", range=f"B{h - 1}:{last}{h - 1}", color=GREY))
        cmds.append(_cmd("home.bold", range=f"B{h}:{last}{h}"))
        cmds.append(_cmd("home.borders", range=f"B{h}:{last}{h}", preset="bottom", style="thin"))

    for line in _lines(plan):
        row = plan.rows[id(line)]
        cells = _line_cells(line, plan, locator, renames)
        value_end = "C" if line.scalar else last
        name_at = "D" if line.scalar else name_col
        errors = [(i, c) for i, c in enumerate(cells) if isinstance(c, ExcelError)]
        cells = [None if isinstance(c, ExcelError) else c for c in cells]
        cmds.append(_cmd("range.setValues", range=f"B{row}",
                         values=[[line.label, *cells, *([line.name] if line.name else [])]], parse=False))
        for i, error in errors:  # parsed, so GridCraft stores the error value rather than text
            cmds.append(_cmd("range.setValues", range=f"{month_col(i)}{row}", values=[[error.text]]))
        values = f"C{row}:{value_end}{row}" if value_end != "C" else f"C{row}"
        cmds.append(_cmd("home.numberFormat", range=values, format=line.fmt))
        if line.style == "input":
            cmds.append(_cmd("home.bold", range=values))
            cmds.append(_cmd("home.fontColor", range=values, color=BLUE))
        elif line.style in ("elsewhere", "link"):
            cmds.append(_cmd("home.bold", range=values))
            cmds.append(_cmd("home.fontColor", range=values, color=GREEN))
        elif line.style == "output":
            cmds.append(_cmd("home.bold", range=f"B{row}:{value_end}{row}"))
        elif line.style == "grey":
            cmds.append(_cmd("home.fontColor", range=f"B{row}:{value_end}{row}", color=GREY))
        if line.content[0] == "state":
            cmds.append(_cmd("home.bold", range=f"C{row}"))
            cmds.append(_cmd("home.fontColor", range=f"C{row}", color=BLUE))
        if line.name:
            cmds.append(_cmd("home.fontColor", range=f"{name_at}{row}", color=MAROON))
        if line.define and line.name:
            refers = f"={q}!$C${row}" if line.scalar else f"={q}!$C${row}:${last}${row}"
            defined.append(define(line.name, refers))

    # geometry
    labels = [*(p[1] for p in plan.params), *(line.label for line in _lines(plan)), plan.header,
              *(t.label for t in plan.tables), plan.title, plan.subtitle]  # B2/B3 never clip at the frozen column
    label_px = (max(len(t) for t in labels) + 2) * CHAR_PX
    cmds.append(_cmd("home.columnWidth", cols="A:A", width=EDGE_PX))
    cmds.append(_cmd("home.columnWidth", cols="B:B", width=max(label_px, 120)))
    cmds.append(_cmd("home.rowHeight", rows="1:1", height=EDGE_PX))
    value_chars = max([6, *(len(t) for t in (plan.column_notes[1] if plan.column_notes else ()))])
    for line in _lines(plan):
        if line.python is not None and not line.scalar:
            value_chars = max(value_chars, display_length(line.fmt, line.python))
    scalar_chars = max([display_length(l.fmt, l.python) for l in _lines(plan) if l.scalar and l.python is not None]
                       + [display_length(code, value) for _, _, value, code in plan.params] + [0])
    month_px = (value_chars + 2) * CHAR_PX
    names = [l.name for l in _lines(plan) if l.name and not l.scalar]
    if has_series:
        cmds.append(_cmd("home.columnWidth", cols=f"C:{last}", width=max(month_px, (scalar_chars + 2) * CHAR_PX)))
        if names:
            cmds.append(_cmd("home.columnWidth", cols=f"{name_col}:{name_col}",
                             width=(max(len(n) for n in names) + 2) * CHAR_PX))
        cmds.append(_cmd("view.freezePanes", cell=f"C{plan.header_row + 1}"))
    elif plan.tables:
        for index in range(table_cols - 1):
            chars = max(display_length(t.fmts[index], [r[index] for r in t.rows]) + 2
                        for t in plan.tables if index < len(t.columns))
            if index:  # column B is sized for labels above
                cmds.append(_cmd("home.columnWidth", cols=f"{column_letter(2 + index)}:{column_letter(2 + index)}",
                                 width=max(chars, 10) * CHAR_PX))
        cmds.append(_cmd("view.freezePanes", cell=f"A{plan.rows[id(plan.tables[0])] + 2}"))
    else:
        cmds.append(_cmd("home.columnWidth", cols="C:C", width=max(scalar_chars + 2, 10) * CHAR_PX))
    return cmds, defined


def _used_cols(used_range):
    """Last column index of a used range like 'B2:DS20'."""
    if not used_range:
        return 0
    last = used_range.split(":")[-1]
    letters = re.match(r"[A-Z]+", last)
    if not letters:
        return 0
    index = 0
    for ch in letters.group(0):
        index = index * 26 + ord(ch) - ord("A") + 1
    return index


def build_workbook(gridcraft, path, plans):
    """Build or rebuild the workbook at `path` from `plans`, keeping its Scratch sheet.

    Returns the list of (plan, line, values read back) for every line with `check` set.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    locator = allocate(plans)
    renames = {}
    for plan in plans:
        for name, *_ in plan.params:
            if excel_name(name) != name:
                renames[name] = excel_name(name)

    plan_names = [p.name for p in plans]
    existing = {}  # sheet name -> used range
    old_names = []
    if path.exists():
        info = gridcraft.info(path)
        sheet_list = [s["name"] for s in info["sheets"]]
        existing = {s["name"]: s.get("usedRange") for s in info["sheets"]}
        for item in info.get("names", []):
            scope = item.get("scope")
            scope_name = sheet_list[scope] if isinstance(scope, int) and scope < len(sheet_list) else "Workbook"
            old_names.append((item["name"], scope_name, item.get("refersTo", "")))

    cmds = []
    if not existing:
        cmds.append(_cmd("sheet.rename", name=plan_names[0]))
        for name in plan_names[1:]:
            cmds.append(_cmd("home.insertSheet", name=name))
        cmds.append(_cmd("home.insertSheet", name=SCRATCH))
    else:
        for name in plan_names:
            if name not in existing:
                cmds.append(_cmd("home.insertSheet", name=name))
        if SCRATCH not in existing:
            cmds.append(_cmd("home.insertSheet", name=SCRATCH))
        stale_sheets = [s for s in existing if s != SCRATCH and s not in plan_names]
        for sheet in stale_sheets:
            cmds.append(_cmd("home.deleteSheet", sheet=sheet))

    all_cmds_by_sheet = []
    new_names = set()
    for plan in plans:
        sheet_cmds, defined = render_sheet(plan, locator, renames)
        new_names.update(defined)
        all_cmds_by_sheet.append((plan, sheet_cmds))

    if existing:
        generated = set(plan_names) | (set(existing) - {SCRATCH})
        for name, scope, refers in old_names:
            if (name, scope) in new_names:
                continue  # redefined in place
            if scope in generated and scope not in plan_names:
                continue  # goes with its deleted sheet
            points_at_generated = any(f"{quote_sheet(s)}!" in refers or f"={s}!" in refers for s in generated)
            if scope in generated or points_at_generated:
                params = {"name": name}
                params["scope"] = scope
                cmds.append(_cmd("formulas.deleteName", **params))

    for plan, sheet_cmds in all_cmds_by_sheet:
        cmds.append(_cmd("sheet.activate", sheet=plan.name))
        if plan.name in existing:
            used = existing[plan.name]
            if used:
                cmds.append(_cmd("edit.clearAll", range=f"A1:{used.split(':')[-1]}"))
            cmds.append(_cmd("view.unfreezePanes"))
            old_cols = _used_cols(used)
            table_cols = max([len(t.columns) + 2 for t in plan.tables], default=0)
            new_cols = FIRST_MONTH_COL + plan.months if plan.header_row is not None else max(4, table_cols)
            if old_cols > new_cols:
                cmds.append(_cmd("home.columnWidth", cols=f"{column_letter(new_cols + 1)}:{column_letter(old_cols)}",
                                 width=DEFAULT_COLUMN_PX))
        cmds.extend(sheet_cmds)

    for index, name in enumerate(plan_names):
        cmds.append(_cmd("sheet.move", sheet=name, to=index))
    cmds.append(_cmd("sheet.move", sheet=SCRATCH, to=len(plan_names)))
    cmds.append(_cmd("pageLayout.themeFonts", major=FONT_NAME, minor=FONT_NAME))
    cmds.append(_cmd("sheet.activate", sheet=plan_names[0]))
    cmds.append(_cmd("selection.set", range="A1"))

    checks = []
    for plan in plans:
        for line in _lines(plan):
            if line.check:
                row = plan.rows[id(line)]
                rng = f"C{row}" if line.scalar else f"C{row}:{plan.last_col}{row}"
                cmds.append(_cmd("sheet.read", sheet=plan.name, range=rng))
                checks.append((plan, line))

    tmp = path.with_name(f".{path.stem}.building{path.suffix}")
    try:
        results = gridcraft.run(cmds, tmp, source=path if existing else None)
        reads = [r["result"] for r in results if r.get("command") == "sheet.read"]
        if len(reads) != len(checks):
            raise TilekitError("gridcraft-cli did not return every value read back",
                               {"expected": len(checks), "got": len(reads)})
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    out = []
    for (plan, line), read in zip(checks, reads):
        values = [v for row in read["values"] for v in row]
        out.append((plan, line, values))
    return out


# ---------------------------------------------------------------- comparison

AGREEING_ERRORS = ("#NUM!", "#DIV/0!")  # Excel's errors for what Python returns as NaN or an infinity


def compare(excel_values, python_values, tolerance=TOLERANCE_ABS):
    """(max_abs_difference or None, checks_pass, first error text or None).

    A NaN or infinite Python value agrees with an Excel #NUM! or #DIV/0! error (for
    example an IRR with no sign change, or a ratio to zero).
    """
    python = np.ravel(np.asarray(python_values, dtype=np.float64))
    worst, ok, error = 0.0, True, None
    for got, want in zip(excel_values, python):
        if isinstance(got, dict) and got.get("error") in AGREEING_ERRORS and not math.isfinite(want):
            continue
        if not isinstance(got, int | float) or isinstance(got, bool):
            ok = False
            error = error or (got.get("error") if isinstance(got, dict) else repr(got))
            worst = None
            continue
        if math.isnan(want) and math.isnan(got):
            continue
        diff = abs(float(got) - float(want))
        if not diff <= tolerance + TOLERANCE_REL * abs(want):
            ok = False
        if worst is not None:
            worst = max(worst, diff) if math.isfinite(diff) else None
    if len(excel_values) != len(python):
        ok = False
    return worst, ok, error


# ---------------------------------------------------------------- model data

class CaseData:
    """One case's Python trace, as needed to lay out sheets."""

    def __init__(self, model, case):
        self.case = case
        _, self.params, self.results = run_case(model, case.id)
        self.months = case_months(model, case)
        self._analyse(model)

    def _analyse(self, model):
        self.branches = branch_counts(model, self.params, self.results, self.months)
        self.near_ties = near_tie_map(model, self.params, self.results, self.months)

    @classmethod
    def from_results(cls, model, case, params, results, months):
        """Case data from results already computed (a real policy, for example); `case` needs `id` and `name`."""
        data = cls.__new__(cls)
        data.case, data.params, data.results, data.months = case, params, results, months
        data._analyse(model)
        return data

    def series(self, name):
        return np.asarray(self.results[name][:, 0, 0], dtype=np.float64)

    def scalar(self, name):
        return float(self.results[name][0, 0])

    def param(self, name):
        return float(getattr(self.params, name))


class ModelInfo:
    """Labels, formats and roles of the model's quantities."""

    def __init__(self, model):
        self.model = model
        self.graph = model.graph
        self.translations = model_translations(model)
        self.fields = param_fields(model)
        self.inputs = {i.name: i for i in model.config.input_series}
        self.states = {s.name: s for s in model.config.states}
        self.summary = set(self.graph.summary_order())

    def kind(self, name):
        return self.graph.kinds[name]

    def label(self, name):
        kind = self.kind(name)
        if kind == "tile":
            return self.graph.tiles[name].doc.label or name
        if kind == "param":
            return self.fields[name].metadata.get("label", name)
        if kind == "input":
            return self.inputs[name].label
        return self.states[name].label

    def fmt(self, name):
        kind = self.kind(name)
        if kind == "tile":
            return self.graph.tiles[name].doc.format or "number"
        if kind == "param":
            return self.fields[name].metadata.get("format", "number")
        if kind == "input":
            return self.inputs[name].format
        return self.states[name].format

    def is_scalar(self, name):
        return name in self.summary

    def param_order(self, names):
        order = list(self.fields)
        return sorted(dict.fromkeys(names), key=order.index)

    def module_outputs(self, module_id):
        """Tiles of a module used outside it (directly or through a state), or used by nothing."""
        tiles = self.graph.tiles
        own = set(self.graph.modules[module_id].tiles)
        outside_state_sources = set()
        for state in self.states.values():
            readers = self.graph.used_by[state.name]
            if any(tiles[r].module != module_id for r in readers):
                outside_state_sources.add(state.source)
        outputs = []
        for name in self.graph.modules[module_id].tiles:
            users = self.graph.used_by[name]
            if not users or any(u not in own for u in users) or name in outside_state_sources:
                outputs.append(name)
        return outputs


def _pasted_style(info, name):
    """How a pasted row is shown: a true input (an input series) in bold blue, anything the model
    calculated (another tile's output, a carried-forward state) in bold dark green."""
    return "input" if info.kind(name) == "input" else "elsewhere"


def _value_line(info, data, name, style=None, define=True, key=None):
    """A row of Python values pasted in for a quantity, styled by where the quantity comes from."""
    style = style or _pasted_style(info, name)
    if info.is_scalar(name):
        value = data.scalar(name)
        return Line(key or name, info.label(name), ("values", value), number_format(info.fmt(name), [value]),
                    style=style, name=name, define=define, scalar=True, python=value)
    values = data.series(name)
    return Line(key or name, info.label(name), ("values", values), number_format(info.fmt(name), values),
                style=style, name=name, define=define, python=values)


def _tile_line(info, data, name, style, define=True, linked_upstream=False):
    """A tile's own row: its formula, or its Python values when it cannot be translated.

    With `linked_upstream` (module and model workbooks, where upstream rows are live
    formulas too) the difference check uses the loosest tolerance of the tile and
    everything upstream of it, so an IRR's solver tolerance carries to rows built on it.
    """
    translation = info.translations[name]
    tolerance = translation.tolerance
    if linked_upstream:
        tolerance = max([tolerance, *(info.translations[u].tolerance for u in upstream_tiles(info.model, [name]))])
    scalar = info.is_scalar(name)
    python = data.scalar(name) if scalar else data.series(name)
    code = number_format(info.fmt(name), python)
    if not translation.translatable:
        return Line(name, info.label(name), ("values", python), code, style="input", name=name, define=define,
                    scalar=scalar, python=python)
    return Line(name, info.label(name), ("formula", translation.formula), code, style=style, name=name,
                define=define, scalar=scalar, check=name, python=python, tolerance=tolerance)


def _comparison_lines(info, data, name):
    scalar = info.is_scalar(name)
    python = data.scalar(name) if scalar else data.series(name)
    key = f"python:{name}"
    return [
        Line(key, f"Python {info.label(name)}", ("values", python), number_format(info.fmt(name), python),
             style="grey", scalar=scalar, python=python),
        Line(None, "Difference", ("formula", "={" + name + "}-{" + key + "}"), DIFFERENCE_FORMAT, style="grey",
             scalar=scalar, python=np.zeros(1)),
    ]


def _state_line(info, data, name, define=True):
    state = info.states[name]
    values = data.series(name)
    return Line(name, state.label, ("state", state.initial, state.source), number_format(state.format, values),
                style="calc", name=name, define=define, python=values)


def _params_block(info, data, names):
    return [(n, info.label(n), data.param(n), number_format(info.fmt(n), [data.param(n)]))
            for n in info.param_order(names)]


# ---------------------------------------------------------------- tile workbook

def tile_plans(info, tile_name, datas):
    tile = info.graph.tiles[tile_name]
    taken = set()
    plans = []
    for data in datas:
        params = [a for a in tile.args if info.kind(a) == "param"]
        others = [a for a in dict.fromkeys(tile.args) if info.kind(a) != "param"]
        plan = SheetPlan(sheet_name(data.case.name, taken), tile.doc.label or tile_name, data.case.name,
                         data.months, params=_params_block(info, data, params), scope="sheet", case=data.case.id)
        series_inputs = [_value_line(info, data, a) for a in others if not info.is_scalar(a)]
        scalar_inputs = [_value_line(info, data, a) for a in others if info.is_scalar(a)]
        own = _tile_line(info, data, tile_name, "output")
        grey = _comparison_lines(info, data, tile_name)
        if info.is_scalar(tile_name):
            plan.series = [series_inputs]
            plan.scalars = [scalar_inputs, [own], grey]
        else:
            plan.series = [series_inputs, [own], grey]
        plans.append(plan)
    return plans


# ---------------------------------------------------------------- hand checks sheet

def hand_plan(info, tile_name, checks, taken):
    """The `Hand checks` sheet of a tile workbook: one column per check of the tile's hand-calculation test.

    Every argument of the tile (parameters too, since a check may vary them) is a row of the check's inputs,
    the tile's own formula is evaluated on each column, and the row is compared with the figures worked by hand:
    the line's `python` is the hand figures, so the build's difference check is Excel against the hand calculation.
    """
    tile = info.graph.tiles[tile_name]
    translation = info.translations[tile_name]
    count = len(checks)
    plan = SheetPlan(sheet_name(handchecks.SHEET, taken), tile.doc.label or tile_name,
                     "Hand checks: the tile's formula on the inputs of each check of its test, against the figure "
                     "worked by hand", count, scope="sheet", case=handchecks.CASE, header="Check",
                     column_notes=("Test", tuple(f"{c['test']} ({c['index']})" for c in checks)))
    args = list(dict.fromkeys(tile.args))
    params = {a for a in args if info.kind(a) == "param"}
    inputs = []
    for a in args:
        values = np.array([c["args"][a] for c in checks], dtype=np.float64)
        # a parameter is a row here, not a defined name: `$name` cannot clash with a renamed parameter
        inputs.append(Line(f"${a}" if a in params else a, info.label(a), ("values", values),
                           number_format(info.fmt(a), values), style="input", name=a, python=values))
    template = _IDENTIFIER.sub(lambda m: "{$" + m.group(1) + "}" if m.group(1) in params else m.group(0),
                               translation.formula)
    expected = np.array([c["expected"] for c in checks], dtype=np.float64)
    code = number_format(info.fmt(tile_name), expected)
    tolerance = max([translation.tolerance, *(c["tolerance"] for c in checks)])
    own = Line(tile_name, info.label(tile_name), ("formula", template), code, style="output", name=tile_name,
               check=tile_name, python=expected, tolerance=tolerance)
    hand = f"hand:{tile_name}"
    grey = [
        Line(hand, "Worked by hand", ("values", expected), code, style="input", python=expected),
        Line(None, "Difference", ("formula", "={" + tile_name + "}-{" + hand + "}"), DIFFERENCE_FORMAT, style="grey",
             python=np.zeros(1)),
    ]
    plan.series = [inputs, [own], grey]
    return plan


def _hand_document(hand, plan, results, translation):
    """The sidecar's `hand_checks`: what was laid out, what Excel made of each check, and whether all agree."""
    document = {"digest": hand["digest"], "sheet": plan.name if plan else None, "not_in_sheet": hand["not_in_sheet"],
                "checks": [], "max_abs_difference": None, "checks_pass": None}
    if plan is None:
        return document
    values = next((v for p, line, v in results if p is plan and line.check), [])
    worst, ok = 0.0, True
    for check, got in zip(hand["checks"], values):
        entry = {**check}
        if isinstance(got, int | float) and not isinstance(got, bool):
            diff = abs(float(got) - check["expected"])
            agrees = diff <= max(check["tolerance"], translation.tolerance) + TOLERANCE_REL * abs(check["expected"])
            entry.update(excel=float(got), difference=diff)
            entry["pass"] = bool(agrees)
            if worst is not None:
                worst = max(worst, diff) if math.isfinite(diff) else None
        else:
            entry.update(excel=None, difference=None, error=got.get("error") if isinstance(got, dict) else repr(got))
            entry["pass"] = False
            worst = None
        ok = ok and entry["pass"]
        document["checks"].append(entry)
    if len(values) != len(hand["checks"]):
        ok = False
    document["max_abs_difference"], document["checks_pass"] = worst, ok
    return document


# ---------------------------------------------------------------- module workbook

def _module_parts(info, module_id):
    """(params, external quantities, states) a module's tiles read."""
    graph = info.graph
    module = graph.modules[module_id]
    own = set(module.tiles)
    params = [n for n in module.inputs if info.kind(n) == "param"]
    states = [n for n in module.inputs if info.kind(n) == "state"]
    external = [n for n in module.inputs if info.kind(n) in ("tile", "input")]
    for state in states:
        source = info.states[state].source
        if source not in own and source not in external:
            external.append(source)
    return params, external, states


def _module_sections(info, data, module_id, linked):
    """(series sections, scalar sections) for one module; `linked` makes external rows cross-sheet links."""
    graph = info.graph
    module = graph.modules[module_id]
    params, external, states = _module_parts(info, module_id)
    outputs = set(info.module_outputs(module_id))

    def external_line(name):
        if linked:
            line = _value_line(info, data, name, style="link", define=False)
            line.content = ("link", name)
            line.home = False
            return line
        return _value_line(info, data, name)

    ext_series = [external_line(n) for n in external if not info.is_scalar(n)]
    ext_scalars = [external_line(n) for n in external if info.is_scalar(n)]
    state_lines = [_state_line(info, data, s) for s in states]
    tile_lines = [_tile_line(info, data, n, "output" if n in outputs else "calc", linked_upstream=True)
                  for n in module.tiles]
    grey = [line for n in module.tiles if n in outputs for line in _comparison_lines(info, data, n)]

    if info.model.config.module(module_id).timing == "summary":
        return [ext_series + state_lines], [ext_scalars, tile_lines, grey]
    return [ext_series, state_lines + tile_lines, grey], [ext_scalars]


def module_plans(info, module_id, datas):
    module = info.model.config.module(module_id)
    params, _, _ = _module_parts(info, module_id)
    taken = set()
    plans = []
    for data in datas:
        plan = SheetPlan(sheet_name(data.case.name, taken), module.title, data.case.name, data.months,
                         params=_params_block(info, data, params), scope="sheet", case=data.case.id)
        plan.series, plan.scalars = _module_sections(info, data, module_id, linked=False)
        plans.append(plan)
    return plans


# ---------------------------------------------------------------- model workbook

def module_dependency_order(model):
    """Module ids so each comes after the modules that feed it, where possible (config order otherwise)."""
    graph = model.graph
    remaining = [m.id for m in model.config.modules]
    order = []
    while remaining:
        ready = [m for m in remaining if all(f in order for f in graph.modules[m].fed_by if f != m)]
        pick = ready[0] if ready else remaining[0]
        order.append(pick)
        remaining.remove(pick)
    return order


def _input_formula_lines(info, data):
    """(formula rows, grey Python/Difference rows) for inputs with an `excel` template, in dependency order."""
    config = info.model.config
    formulas, grey = [], []
    for name in config.excel_input_order():
        item = info.inputs[name]
        values = data.series(name)
        code = number_format(item.format, values)
        formulas.append(Line(name, item.label, ("formula", item.excel), code, style="calc", name=name, define=True,
                             check=name, check_kind="input", python=values))
        key = f"python:{name}"
        grey += [
            Line(key, f"Python {item.label}", ("values", values), code, style="grey", python=values),
            Line(None, "Difference", ("formula", "={" + name + "}-{" + key + "}"), DIFFERENCE_FORMAT, style="grey",
                 python=np.zeros(1)),
        ]
    return formulas, grey


def _table_format(table, column):
    fmt = table.formats.get(column)
    values = table.column(column)
    if fmt is None:
        fmt = "integer" if all(float(v).is_integer() for v in values) else "number"
    return number_format(fmt, values)


def assumptions_plan(info, data, taken):
    """The "Assumptions" sheet: every table of `tilekit.toml`, or None when there are none."""
    tables = info.model.config.tables
    if not tables:
        return None
    plan = SheetPlan(sheet_name("Assumptions", taken), "Assumptions", data.case.name, data.months, scope="workbook",
                     case=data.case.id)
    plan.tables = [TableBlock(t.name, t.label, t.columns, t.rows, tuple(_table_format(t, c) for c in t.columns))
                   for t in tables]
    return plan


def model_plans(info, data):
    model = info.model
    taken = {SCRATCH}
    inputs = SheetPlan(sheet_name("Inputs", taken), model.config.name, data.case.name, data.months,
                       params=_params_block(info, data, list(info.fields)), scope="workbook", case=data.case.id)
    pasted = [_value_line(info, data, i.name) for i in model.config.input_series if not i.excel]
    formulas, grey = _input_formula_lines(info, data)
    inputs.series = [pasted, formulas, grey]
    plans = [inputs]
    assumptions = assumptions_plan(info, data, taken)
    if assumptions:
        plans.append(assumptions)
    for module_id in module_dependency_order(model):
        module = model.config.module(module_id)
        plan = SheetPlan(sheet_name(module.title, taken), module.title, data.case.name, data.months,
                         scope="workbook", case=data.case.id)
        plan.series, plan.scalars = _module_sections(info, data, module_id, linked=True)
        plans.append(plan)
    return plans


# ---------------------------------------------------------------- results and sidecars

def summarise(results, datas):
    """Per case: {sheet, max_abs_difference, checks_pass, tiles: {tile: {...}}}."""
    by_case = {}
    for plan, line, values in results:
        worst, ok, error = compare(values, line.python, line.tolerance)
        entry = by_case.setdefault(plan.case, {"sheet": plan.name, "tiles": {}})
        tile_entry = {"max_abs_difference": worst, "checks_pass": ok}
        if line.tolerance != TOLERANCE_ABS:
            tile_entry["tolerance"] = line.tolerance
        if error:
            tile_entry["error"] = error
        group = "tiles" if line.check_kind == "tile" else "inputs"
        entry.setdefault(group, {})[line.check] = tile_entry
    for data in datas:
        entry = by_case.setdefault(data.case.id, {"sheet": None, "tiles": {}})
        checked = [*entry["tiles"].values(), *entry.get("inputs", {}).values()]
        diffs = [t["max_abs_difference"] for t in checked]
        entry["max_abs_difference"] = None if None in diffs else max(diffs, default=0.0)
        entry["checks_pass"] = all(t["checks_pass"] for t in checked)
    return by_case


def _overall(cases):
    diffs = [c["max_abs_difference"] for c in cases.values()]
    return (None if None in diffs else max(diffs, default=0.0)), all(c["checks_pass"] for c in cases.values())


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_json(path, document):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    os.replace(tmp, path)


def review_dir(model):
    return model.root / "review"


def tile_paths(model, name):
    folder = review_dir(model) / "tiles" / name
    return folder / "workbook.xlsx", folder / "workbook.json"


def module_paths(model, module_id):
    folder = review_dir(model) / "modules" / module_id
    return folder / "workbook.xlsx", folder / "workbook.json"


def default_case_id(model):
    cases = load_cases(model)
    wanted = model.config.default_case
    if wanted and any(c.id == wanted for c in cases):
        return wanted
    if wanted:
        raise TilekitError(f"default_case '{wanted}' in tilekit.toml has no case file")
    if not cases:
        raise TilekitError("The model has no cases")
    return cases[0].id


def model_paths(model, case_id):
    folder = review_dir(model) / "model"
    stem = "workbook" if case_id == default_case_id(model) else f"workbook-{case_id}"
    return folder / f"{stem}.xlsx", folder / f"{stem}.json"


# ---------------------------------------------------------------- content digest

def content_digest(path):
    """SHA-256 of every generated sheet's cells (formula and cached value), the sheet order and the defined names,
    read from the xlsx itself. The "Scratch" sheet, and names scoped to it or pointing only at it, are left out, so
    the user's Scratch edits never change it."""
    from tilekit.xlsxread import Xlsx
    book = Xlsx(path)
    h = hashlib.sha256()
    sheets = [s for s in book.sheets if s != SCRATCH]
    h.update(json.dumps(sheets).encode())
    for sheet in sheets:
        cells = book.cells(sheet)
        for ref in sorted(cells, key=_cell_sort_key):
            cell = cells[ref]
            if cell["formula"] is None and cell["value"] is None:
                continue
            value = cell["value"]
            h.update(f"{sheet}!{ref}\x00{cell['formula']}\x00{type(value).__name__}:{value!r}\x00".encode())
    for item in sorted(book.defined_names, key=lambda n: (n["name"] or "", n["scope"] or "")):
        refers = item["refers_to"] or ""
        if item["scope"] == SCRATCH or (SCRATCH in refers and not any(s in refers for s in sheets)):
            continue
        h.update(f"name\x00{item['name']}\x00{item['scope']}\x00{refers}\x00".encode())
    return h.hexdigest()


def _cell_sort_key(ref):
    match = re.match(r"([A-Z]+)(\d+)", ref)
    return (int(match.group(2)), len(match.group(1)), match.group(1)) if match else (0, 0, ref)


def file_stat(path):
    stat = Path(path).stat()
    return {"mtime_ns": stat.st_mtime_ns, "size": stat.st_size}


def _seal(document, xlsx):
    """Record the built workbook's content digest and file stat in its sidecar document."""
    document["content_digest"] = content_digest(xlsx)
    document["content_stat"] = file_stat(xlsx)
    return document


def _apply_overrides(plans, sheet=None, label=None):
    """Rename every sheet to `sheet` (one-case workbooks only) and/or replace every sheet's second title line."""
    if sheet is not None:
        if len(plans) != 1:
            raise TilekitError("A sheet-name override needs a workbook with exactly one sheet")
        plans[0].name = sheet_name(sheet, set())
    if label is not None:
        for plan in plans:
            plan.subtitle = label


def build_tile(model, gridcraft, name, datas, stamp, paths=None, sheet=None, label=None, extra=None):
    """Build a tile workbook and its sidecar (default `review/tiles/<name>/`); returns the sidecar document.

    `paths` is an explicit (xlsx, sidecar) pair, `sheet` a sheet name for a one-case workbook, `label` the
    second title line of every sheet and `extra` fields merged into the sidecar.

    A tile the translator refuses is laid out as pasted Python values (values-only): nothing is checked, so
    its `checks_pass` and `max_abs_difference` are null.
    """
    info = ModelInfo(model)
    if name not in info.graph.tiles:
        raise TilekitError(f"Unknown tile '{name}'", {"tiles": list(info.graph.order)})
    xlsx, sidecar = paths or tile_paths(model, name)
    plans = tile_plans(info, name, datas)
    _apply_overrides(plans, sheet, label)
    translation = info.translations[name]
    # The stored tile workbook (not a one-off for a real policy) also carries the hand checks of the tile's test.
    hand, hand_sheet = None, None
    if paths is None and sheet is None:
        hand = handchecks.extract(model, name, info.translations)
        if hand["checks"]:
            hand_sheet = hand_plan(info, name, hand["checks"], {p.name for p in plans})
            plans.append(hand_sheet)
    results = build_workbook(gridcraft, xlsx, plans)
    cases = summarise(results, datas)
    case_docs = {}
    for data, plan in zip(datas, plans):
        entry = cases[data.case.id]
        own = entry["tiles"].get(name)
        doc = {
            "sheet": plan.name,
            "max_abs_difference": own["max_abs_difference"] if own else None,
            "checks_pass": own["checks_pass"] if own else None,
            "branches": data.branches.get(name, {}),
            "near_ties": data.near_ties.get(name, []),
        }
        if own and own.get("error"):
            doc["error"] = own["error"]
        case_docs[data.case.id] = doc
    worst, ok = _overall(case_docs) if translation.translatable else (None, None)
    document = {
        "kind": "tile", "name": name, "module": info.graph.tiles[name].module, "built_at": _now(), "stamp": stamp,
        "workbook": xlsx.name,
        "formula": translation.formula, "translatable": translation.translatable,
        "untranslatable_reason": translation.reason, "branch_labels": list(translation.branches),
        "tolerance": translation.tolerance, "relative_tolerance": TOLERANCE_REL,
        "max_abs_difference": worst, "checks_pass": ok, "cases": case_docs,
        "near_ties": {cid: c["near_ties"] for cid, c in case_docs.items() if c["near_ties"]},
        **({"hand_checks": _hand_document(hand, hand_sheet, results, translation)} if hand is not None else {}),
        **(extra or {}),
    }
    write_json(sidecar, _seal(document, xlsx))
    return document


def _group_document(kind, name, info, tile_names, plans, datas, results, stamp, xlsx):
    cases = summarise(results, datas)
    for data in datas:
        entry = cases[data.case.id]
        entry["sheet"] = next((p.name for p in plans if p.case == data.case.id), entry["sheet"])
        for tile in tile_names:
            tile_entry = entry["tiles"].setdefault(tile, {"max_abs_difference": None, "checks_pass": None})
            tile_entry["branches"] = data.branches.get(tile, {})
            tile_entry["near_ties"] = data.near_ties.get(tile, [])
    tiles = {}
    for tile in tile_names:
        translation = info.translations[tile]
        per_case = [cases[d.case.id]["tiles"][tile] for d in datas]
        diffs = [c["max_abs_difference"] for c in per_case]
        checked = translation.translatable
        tiles[tile] = {
            "module": info.graph.tiles[tile].module,
            "formula": translation.formula, "translatable": translation.translatable,
            "max_abs_difference": (None if None in diffs else max(diffs, default=0.0)) if checked else None,
            "checks_pass": all(c["checks_pass"] for c in per_case) if checked else None,
            "near_ties": {d.case.id: c["near_ties"] for d, c in zip(datas, per_case) if c["near_ties"]},
        }
    worst, ok = _overall(cases)
    return {
        "kind": kind, "name": name, "built_at": _now(), "stamp": stamp, "workbook": xlsx.name,
        "tolerance": TOLERANCE_ABS, "relative_tolerance": TOLERANCE_REL,
        "max_abs_difference": worst, "checks_pass": ok, "tiles": tiles, "cases": cases,
    }


def build_module(model, gridcraft, module_id, datas, stamp, paths=None, sheet=None, label=None, extra=None):
    """Build a module workbook and its sidecar (default `review/modules/<id>/`); options as for `build_tile`."""
    info = ModelInfo(model)
    model.config.module(module_id)  # raises for an unknown module
    xlsx, sidecar = paths or module_paths(model, module_id)
    tile_names = list(info.graph.modules[module_id].tiles)
    if not tile_names:
        raise TilekitError(f"Module '{module_id}' has no tiles")
    plans = module_plans(info, module_id, datas)
    _apply_overrides(plans, sheet, label)
    results = build_workbook(gridcraft, xlsx, plans)
    document = _group_document("module", module_id, info, tile_names, plans, datas, results, stamp, xlsx)
    document["outputs"] = info.module_outputs(module_id)
    document.update(extra or {})
    write_json(sidecar, _seal(document, xlsx))
    return document


def build_model(model, gridcraft, data, stamp, paths=None, label=None, extra=None):
    """Build the model workbook for one case and its sidecar (default `review/model/`).

    Sheet names are fixed (Inputs, Assumptions, one per module); `label` replaces every sheet's second title line.
    """
    info = ModelInfo(model)
    xlsx, sidecar = paths or model_paths(model, data.case.id)
    plans = model_plans(info, data)
    _apply_overrides(plans, None, label)
    results = build_workbook(gridcraft, xlsx, plans)
    tile_names = list(info.graph.order)
    document = _group_document("model", model.config.name, info, tile_names, plans, [data], results, stamp, xlsx)
    document["case"] = data.case.id
    document["sheets"] = [p.name for p in plans] + [SCRATCH]
    case_inputs = document["cases"][data.case.id].get("inputs", {})
    document["inputs"] = {
        name: {"excel": info.inputs[name].excel, **case_inputs.get(name, {})}
        for name in model.config.excel_input_order()
    }
    document.update(extra or {})
    write_json(sidecar, _seal(document, xlsx))
    return document
