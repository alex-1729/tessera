"""Load `tilekit.toml` and import the model package it describes."""

import csv
import dataclasses
import importlib
import re
import sys
import tomllib
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from types import ModuleType

from tilekit.errors import TilekitError

FORMATS = ("amount", "units", "percent", "rate", "irr", "number", "integer", "small")
TIMINGS = ("step", "summary")


@dataclass(frozen=True)
class SectionConfig:
    """A named group of a module's tiles on the module sheet (`[[module.section]]`): presentation only."""
    title: str
    tiles: tuple[str, ...]


@dataclass(frozen=True)
class CheckConfig:
    """A reconciliation (`[[module.check]]`): an expression over step quantities that must be zero every month."""
    name: str
    label: str
    expression: str
    tolerance: float = 1e-9


# How a module is presented (its sections) and the reconciliations shown on its sheet. They are not part of any
# tile's formula, so they are kept out of the module's identity in the stamps' `code` (see `stamps.py`).
PRESENTATION_FIELDS = ("sections", "checks")


@dataclass(frozen=True)
class ModuleConfig:
    id: str
    title: str
    layer: str
    python: str
    timing: str = "step"
    sections: tuple[SectionConfig, ...] = ()
    checks: tuple[CheckConfig, ...] = ()

    def identity(self):
        """The module's config without its presentation (sections and checks): what the stamps' `code` holds."""
        return {k: v for k, v in dataclasses.asdict(self).items() if k not in PRESENTATION_FIELDS}

    def presentation(self):
        """The sections and checks as plain data, or None when the module has neither."""
        if not self.sections and not self.checks:
            return None
        return {"sections": [dataclasses.asdict(s) for s in self.sections],
                "checks": [dataclasses.asdict(c) for c in self.checks]}


@dataclass(frozen=True)
class StateConfig:
    name: str
    source: str  # the tile whose value this state takes next month (`from` in the toml)
    initial: float
    label: str
    format: str


@dataclass(frozen=True)
class InputConfig:
    name: str
    label: str
    format: str
    excel: str | None = None  # template replicating the series on the model workbook's "Inputs" sheet


@dataclass(frozen=True)
class TableConfig:
    """An assumption table: a CSV with a header row; the first column is the key."""
    name: str
    file: str  # relative to the model dir
    label: str
    columns: tuple[str, ...]
    rows: tuple[tuple[float, ...], ...]  # numeric values, one tuple per data row
    formats: dict = field(default_factory=dict)  # optional {column: Format} for the Assumptions sheet

    def column(self, name):
        return [row[self.columns.index(name)] for row in self.rows]


# In an `excel` template: {name} is another input's cell this month, {table:T.col} a table column's
# range, and a bare identifier (not followed by "(") is a parameter.
EXCEL_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
EXCEL_TABLE_REF = re.compile(r"^table:([A-Za-z_]\w*)\.([A-Za-z_]\w*)$")
EXCEL_IDENTIFIER = re.compile(r"(?<![\w.$!'\"])([A-Za-z_][A-Za-z0-9_]*)(?![\w(!])")
EXCEL_KEYWORDS = frozenset({"TRUE", "FALSE"})


def excel_template_parts(template):
    """(input names, (table, column) pairs, bare identifiers) used by an `excel` template."""
    inputs, tables = [], []
    for match in EXCEL_PLACEHOLDER.finditer(template):
        inner = match.group(1).strip()
        table = EXCEL_TABLE_REF.match(inner)
        if table:
            tables.append((table.group(1), table.group(2)))
        else:
            inputs.append(inner)
    outside = EXCEL_PLACEHOLDER.sub(" ", template)
    outside = re.sub(r'"[^"]*"', " ", outside)  # text literals
    identifiers = [m.group(1) for m in EXCEL_IDENTIFIER.finditer(outside) if m.group(1).upper() not in EXCEL_KEYWORDS]
    return list(dict.fromkeys(inputs)), list(dict.fromkeys(tables)), list(dict.fromkeys(identifiers))


@dataclass(frozen=True)
class ModelConfig:
    root: Path
    name: str
    package: str
    params: str
    inputs: str
    months: int
    default_case: str | None
    layers: tuple[str, ...]
    modules: tuple[ModuleConfig, ...]
    states: tuple[StateConfig, ...]
    input_series: tuple[InputConfig, ...]
    tables: tuple[TableConfig, ...] = ()

    def table(self, name):
        for table in self.tables:
            if table.name == name:
                return table
        raise TilekitError(f"Unknown table '{name}'", {"tables": [t.name for t in self.tables]})

    def excel_input_order(self):
        """Inputs that have an `excel` template, each after the inputs its template reads."""
        excel = {i.name: i for i in self.input_series if i.excel}
        deps = {n: [d for d in excel_template_parts(i.excel)[0] if d in excel] for n, i in excel.items()}
        order, remaining = [], list(excel)
        while remaining:
            ready = [n for n in remaining if all(d in order for d in deps[n])]
            if not ready:
                raise TilekitError("tilekit.toml: the `excel` templates of these inputs read each other in a cycle",
                                   {"inputs": remaining})
            order.append(ready[0])
            remaining.remove(ready[0])
        return order

    def module(self, module_id):
        for module in self.modules:
            if module.id == module_id:
                return module
        raise TilekitError(f"Unknown module '{module_id}'", {"modules": [m.id for m in self.modules]})


def _require(table, key, where):
    if key not in table:
        raise TilekitError(f"tilekit.toml: missing '{key}' in {where}")
    return table[key]


def load_config(model_dir):
    """Read and validate `<model_dir>/tilekit.toml`."""
    root = Path(model_dir).resolve()
    path = root / "tilekit.toml"
    if not path.is_file():
        raise TilekitError(f"No tilekit.toml in {root}")
    try:
        data = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as exc:
        raise TilekitError(f"tilekit.toml is not valid TOML: {exc}") from exc

    model = _require(data, "model", "the file")
    layers = tuple(_require(model, "layers", "[model]"))

    modules = []
    for i, table in enumerate(data.get("module", [])):
        where = f"[[module]] #{i + 1}"
        module = ModuleConfig(
            id=_require(table, "id", where),
            title=table.get("title", table.get("id")),
            layer=_require(table, "layer", where),
            python=_require(table, "python", where),
            timing=table.get("timing", "step"),
            sections=_load_sections(table, where),
            checks=_load_checks(table, where),
        )
        if module.layer not in layers:
            raise TilekitError(f"tilekit.toml: module '{module.id}' has unknown layer '{module.layer}'", {"layers": list(layers)})
        if module.timing not in TIMINGS:
            raise TilekitError(f"tilekit.toml: module '{module.id}' has timing '{module.timing}'; use one of {list(TIMINGS)}")
        modules.append(module)
    ids = [m.id for m in modules]
    if len(set(ids)) != len(ids):
        raise TilekitError("tilekit.toml: duplicate module ids", {"modules": ids})

    states = []
    for name, table in data.get("state", {}).items():
        states.append(StateConfig(
            name=name,
            source=_require(table, "from", f"[state.{name}]"),
            initial=float(table.get("initial", 0.0)),
            label=table.get("label", name),
            format=table.get("format", "number"),
        ))

    tables = [_load_table(root, name, table) for name, table in data.get("table", {}).items()]

    input_series = [
        InputConfig(name=name, label=table.get("label", name), format=table.get("format", "number"),
                    excel=table.get("excel"))
        for name, table in data.get("input", {}).items()
    ]
    _validate_excel_templates(input_series, tables)

    for item in [*states, *input_series]:
        if item.format not in FORMATS:
            raise TilekitError(f"tilekit.toml: '{item.name}' has format '{item.format}'; use one of {list(FORMATS)}")

    return ModelConfig(
        root=root,
        name=model.get("name", root.name),
        package=_require(model, "package", "[model]"),
        params=_require(model, "params", "[model]"),
        inputs=_require(model, "inputs", "[model]"),
        months=int(_require(model, "months", "[model]")),
        default_case=model.get("default_case"),
        layers=layers,
        modules=tuple(modules),
        states=tuple(states),
        input_series=tuple(input_series),
        tables=tuple(tables),
    )


SNAKE_CASE = re.compile(r"[a-z][a-z0-9]*(_[a-z0-9]+)*")


def _load_sections(table, where):
    """`[[module.section]]` entries: {title, tiles}. Whether the tiles belong to the module is checked by the graph."""
    raw = table.get("section", [])
    if not isinstance(raw, list):
        raise TilekitError(f"tilekit.toml: {where}: write sections as [[module.section]] tables")
    sections = []
    for i, item in enumerate(raw):
        at = f"{where} section #{i + 1}"
        if not isinstance(item, dict):
            raise TilekitError(f"tilekit.toml: {at} is not a table")
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            raise TilekitError(f"tilekit.toml: {at} needs a title")
        tiles = item.get("tiles")
        if not isinstance(tiles, list) or not tiles or not all(isinstance(t, str) and t for t in tiles):
            raise TilekitError(f"tilekit.toml: {at} ('{title}') needs `tiles`, a list of tile names")
        if len(set(tiles)) != len(tiles):
            raise TilekitError(f"tilekit.toml: {at} ('{title}') lists a tile twice", {"tiles": tiles})
        sections.append(SectionConfig(title=title.strip(), tiles=tuple(tiles)))
    return tuple(sections)


def _load_checks(table, where):
    """`[[module.check]]` entries: {name, label, expression, tolerance}. The names the expression reads are checked
    against the model's quantities by the graph."""
    from tilekit.reconcile import parse_expression
    raw = table.get("check", [])
    if not isinstance(raw, list):
        raise TilekitError(f"tilekit.toml: {where}: write checks as [[module.check]] tables")
    checks = []
    for i, item in enumerate(raw):
        at = f"{where} check #{i + 1}"
        if not isinstance(item, dict):
            raise TilekitError(f"tilekit.toml: {at} is not a table")
        name = item.get("name")
        if not isinstance(name, str) or not SNAKE_CASE.fullmatch(name):
            raise TilekitError(f"tilekit.toml: {at} needs a snake_case `name`, got {name!r}")
        expression = item.get("expression")
        if not isinstance(expression, str) or not expression.strip():
            raise TilekitError(f"tilekit.toml: check '{name}' in {where} needs an `expression`")
        parse_expression(expression, f"check '{name}'")  # raises when it is not plain arithmetic on names
        label = item.get("label", name)
        if not isinstance(label, str) or not label.strip():
            raise TilekitError(f"tilekit.toml: check '{name}' in {where} has an empty label")
        tolerance = item.get("tolerance", 1e-9)
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not tolerance >= 0 \
                or tolerance != tolerance or tolerance == float("inf"):
            raise TilekitError(f"tilekit.toml: check '{name}' in {where} has tolerance {tolerance!r}; "
                               "use a number at least 0")
        checks.append(CheckConfig(name=name, label=label.strip(), expression=expression.strip(),
                                  tolerance=float(tolerance)))
    names = [c.name for c in checks]
    if len(set(names)) != len(names):
        raise TilekitError(f"tilekit.toml: {where} has two checks with the same name", {"checks": names})
    return tuple(checks)


def _load_table(root, name, table):
    where = f"[table.{name}]"
    file = _require(table, "file", where)
    path = root / file
    if not path.is_file():
        raise TilekitError(f"tilekit.toml: {where} file '{file}' does not exist")
    with path.open(newline="") as handle:
        lines = [row for row in csv.reader(handle) if row and not row[0].lstrip().startswith("#")]
    if not lines:
        raise TilekitError(f"Table '{name}' ({file}) is empty; it needs a header row")
    columns = tuple(c.strip() for c in lines[0])
    if len(set(columns)) != len(columns) or not all(re.fullmatch(r"[A-Za-z_]\w*", c) for c in columns):
        raise TilekitError(f"Table '{name}' ({file}): column names must be distinct identifiers", {"columns": columns})
    rows = []
    for number, row in enumerate(lines[1:], start=2):
        if len(row) != len(columns):
            raise TilekitError(f"Table '{name}' ({file}) line {number} has {len(row)} values; expected {len(columns)}")
        try:
            rows.append(tuple(float(v) for v in row))
        except ValueError as exc:
            raise TilekitError(f"Table '{name}' ({file}) line {number}: {exc}") from exc
    keys = [r[0] for r in rows]
    if len(set(keys)) != len(keys):
        raise TilekitError(f"Table '{name}' ({file}): the key column '{columns[0]}' has repeated values")
    formats = dict(table.get("formats", {}))
    for column, fmt in formats.items():
        if column not in columns or fmt not in FORMATS:
            raise TilekitError(f"tilekit.toml: {where} formats: '{column}' = '{fmt}' needs a column of the table "
                               f"and one of {list(FORMATS)}")
    return TableConfig(name=name, file=file, label=table.get("label", name), columns=columns, rows=tuple(rows),
                       formats=formats)


def _validate_excel_templates(input_series, tables):
    names = {i.name for i in input_series}
    by_name = {t.name: t for t in tables}
    for item in input_series:
        if item.excel is None:
            continue
        if not isinstance(item.excel, str) or not item.excel.startswith("="):
            raise TilekitError(f"tilekit.toml: [input.{item.name}] excel must be a formula starting with '='")
        inputs, table_refs, _ = excel_template_parts(item.excel)
        for name in inputs:
            if name not in names:
                raise TilekitError(f"tilekit.toml: [input.{item.name}] excel reads '{{{name}}}', which is not an input")
            if name == item.name:
                raise TilekitError(f"tilekit.toml: [input.{item.name}] excel reads itself")
        for table, column in table_refs:
            if table not in by_name:
                raise TilekitError(f"tilekit.toml: [input.{item.name}] excel reads unknown table '{table}'")
            if column not in by_name[table].columns:
                raise TilekitError(f"tilekit.toml: [input.{item.name}] excel reads unknown column '{column}' "
                                   f"of table '{table}'", {"columns": list(by_name[table].columns)})


def _forget_foreign_package(package, root):
    """Drop a same-named package imported from another directory so the right one is imported."""
    loaded = sys.modules.get(package)
    if loaded is None:
        return
    file = getattr(loaded, "__file__", None)
    if file and Path(file).resolve().is_relative_to(root):
        return
    for name in list(sys.modules):
        if name == package or name.startswith(package + "."):
            del sys.modules[name]


def _import_package(config):
    src = config.root / "src"
    search_dir = str(src if src.is_dir() else config.root)
    if search_dir not in sys.path:
        sys.path.insert(0, search_dir)
    _forget_foreign_package(config.package, config.root)
    try:
        return importlib.import_module(config.package)
    except ImportError as exc:
        raise TilekitError(f"Cannot import model package '{config.package}': {exc}") from exc


def _resolve_ref(ref, what):
    """Import `package.module:attribute`."""
    if ":" not in ref:
        raise TilekitError(f"tilekit.toml: {what} must look like 'package.module:name', got '{ref}'")
    module_name, attribute = ref.split(":", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise TilekitError(f"Cannot import '{module_name}' for {what}: {exc}") from exc
    if not hasattr(module, attribute):
        raise TilekitError(f"'{module_name}' has no '{attribute}' ({what})")
    return getattr(module, attribute)


@dataclass(eq=False)
class Model:
    """A loaded model: its config, the imported Python and (lazily) its tiles and graph."""

    config: ModelConfig
    package: ModuleType
    params_class: type
    build_inputs: object
    python_modules: dict  # module id -> imported Python module

    @property
    def root(self):
        return self.config.root

    def default_params(self):
        return self.params_class()

    @cached_property
    def tiles(self):
        """Every discovered tile in config order, as a list (duplicates are kept so checks can report them)."""
        from tilekit.graph import discover_tiles
        return discover_tiles(self)

    @cached_property
    def graph(self):
        """The validated dependency graph; raises TilekitError if the model is not well formed."""
        from tilekit.graph import build_graph
        return build_graph(self)


def load_model(model_dir):
    """Load `tilekit.toml` from `model_dir` and import the model package, its params, inputs and modules."""
    config = load_config(model_dir)
    package = _import_package(config)
    params_class = _resolve_ref(config.params, "params")
    if not (dataclasses.is_dataclass(params_class) and isinstance(params_class, type)):
        raise TilekitError(f"'{config.params}' is not a dataclass")
    build_inputs = _resolve_ref(config.inputs, "inputs")
    config.excel_input_order()  # raises on a cycle
    fields = {f.name for f in dataclasses.fields(params_class)}
    for item in config.input_series:
        if item.excel:
            unknown = [n for n in excel_template_parts(item.excel)[2] if n not in fields]
            if unknown:
                raise TilekitError(f"tilekit.toml: [input.{item.name}] excel uses {unknown}, which are not parameters; "
                                   "write other inputs as {name} and table columns as {table:T.col}")
    python_modules = {}
    for module in config.modules:
        try:
            python_modules[module.id] = importlib.import_module(module.python)
        except ImportError as exc:
            raise TilekitError(f"Cannot import module '{module.id}' ({module.python}): {exc}") from exc
        except SyntaxError as exc:
            raise TilekitError(f"Syntax error in module '{module.id}': {exc}") from exc
    return Model(config, package, params_class, build_inputs, python_modules)
