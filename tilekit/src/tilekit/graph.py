"""Discover tiles, parse their docstrings and build the model's dependency graph."""

import ast
import dataclasses
import inspect
import re
from dataclasses import dataclass
from pathlib import Path

from tilekit.errors import TilekitError

KIND_RANK = {"tile": 0, "input": 1, "param": 2, "state": 3}


# ---------------------------------------------------------------- docstrings

@dataclass(frozen=True)
class Docstring:
    label: str = ""
    spec: str = ""
    units: str | None = None
    timing: str | None = None
    format: str | None = None
    assumed: tuple[str, ...] = ()
    status: str | None = None  # `Status:` line, e.g. "not built"
    undefined: str | None = None  # `Undefined:` line: when the tile's value is expected not to be a number

    @property
    def not_built(self):
        return (self.status or "").strip().lower().rstrip(".") == "not built"


_KEY_LINE = re.compile(r"^(Units|Timing|Format|Assumed|Status|Undefined):\s*(.*)$")


def parse_docstring(text):
    """Parse a tile docstring: label line, free-text spec, then `Key: value` lines.

    Recognised keys are Units, Timing, Format, Status, Undefined and (repeatable) Assumed. An indented
    line directly after a key line continues that key's value. `Undefined:` says when the tile's value is
    expected not to be a number (an IRR with no root, a ratio to zero); without it such a value blocks sign-off.
    """
    if not text or not text.strip():
        return Docstring()
    lines = inspect.cleandoc(text).splitlines()
    label = lines[0].strip()
    if label.endswith("."):
        label = label[:-1].rstrip()

    keys = {}
    assumed = []
    paragraphs, current = [], []
    last_key = None  # (key, index into assumed) of the key line being continued
    for raw in lines[1:]:
        line = raw.strip()
        match = _KEY_LINE.match(raw)
        if match:
            key, value = match.group(1), match.group(2).strip()
            if key == "Assumed":
                assumed.append(value)
                last_key = ("Assumed", len(assumed) - 1)
            else:
                keys[key] = value
                last_key = (key, None)
            continue
        if last_key and line and raw[:1].isspace():
            key, index = last_key
            if key == "Assumed":
                assumed[index] = f"{assumed[index]} {line}".strip()
            else:
                keys[key] = f"{keys[key]} {line}".strip()
            continue
        last_key = None
        if line:
            current.append(line)
        elif current:
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))

    return Docstring(
        label=label,
        spec="\n\n".join(paragraphs),
        units=keys.get("Units"),
        timing=keys.get("Timing"),
        format=keys.get("Format"),
        assumed=tuple(assumed),
        status=keys.get("Status"),
        undefined=keys.get("Undefined") or None,
    )


# ---------------------------------------------------------------- tiles

@dataclass(frozen=True, eq=False)
class Tile:
    name: str
    module: str  # module id from tilekit.toml
    func: object
    args: tuple[str, ...]
    file: str  # relative to the model dir, POSIX style
    path: Path  # absolute path of the module file
    line: int
    code: str
    expression: str | None  # source text of the final return expression
    doc: Docstring
    node: ast.FunctionDef


def _relative(path, root):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def module_source(python_module):
    """(absolute path, source text, parsed AST) of an imported module's file."""
    path = Path(python_module.__file__).resolve()
    source = path.read_text()
    return path, source, ast.parse(source, filename=str(path))


def discover_tiles(model):
    """Every public top-level function defined in each module's file, in config then file order."""
    tiles = []
    for module in model.config.modules:
        python_module = model.python_modules[module.id]
        path, source, tree = module_source(python_module)
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
                continue
            arguments = node.args
            args = tuple(a.arg for a in [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs])
            returns = [s for s in node.body if isinstance(s, ast.Return) and s.value is not None]
            expression = ast.get_source_segment(source, returns[-1].value) if returns else None
            tiles.append(Tile(
                name=node.name,
                module=module.id,
                func=getattr(python_module, node.name),
                args=args,
                file=_relative(path, model.root),
                path=path,
                line=node.lineno,
                code=ast.get_source_segment(source, node),
                expression=expression,
                doc=parse_docstring(ast.get_docstring(node, clean=False)),
                node=node,
            ))
    return tiles


# ---------------------------------------------------------------- name resolution

def param_fields(model):
    return {f.name: f for f in dataclasses.fields(model.params_class)}


def quantity_kinds(model, tiles):
    """Map every quantity name to its kind, plus a list of names defined more than once."""
    seen = {}  # name -> list of descriptions of where it is defined
    kinds = {}

    def add(name, kind, where):
        seen.setdefault(name, []).append(where)
        kinds.setdefault(name, kind)

    for item in model.config.input_series:
        add(item.name, "input", "input in tilekit.toml")
    for name in param_fields(model):
        add(name, "param", f"field of {model.params_class.__name__}")
    for item in model.config.states:
        add(item.name, "state", "state in tilekit.toml")
    for tile in tiles:
        add(tile.name, "tile", f"tile in module '{tile.module}' ({tile.file}:{tile.line})")

    duplicates = [{"name": name, "defined_as": where} for name, where in seen.items() if len(where) > 1]
    by_folded = {}
    for name in seen:
        by_folded.setdefault(name.lower(), []).append(name)
    for names in by_folded.values():
        if len(names) > 1:  # Excel's defined names ignore case, so these would collide in a workbook
            for name in names:
                duplicates.append({"name": name, "defined_as": [f"'{n}' ({'; '.join(seen[n])})" for n in names],
                                   "differs_only_by_case": True})
    return kinds, duplicates


def unresolved_args(tiles, kinds):
    return [
        {"tile": tile.name, "arg": arg, "line": tile.line}
        for tile in tiles for arg in tile.args if arg not in kinds
    ]


def provider_module(name, kinds, tiles_by_name, states_by_name):
    """The module that produces a quantity: a tile's module, or for a state the module of its source tile."""
    kind = kinds.get(name)
    if kind == "tile":
        return tiles_by_name[name].module
    if kind == "state":
        source = tiles_by_name.get(states_by_name[name].source)
        return source.module if source else None
    return None


def topological_order(tiles, kinds):
    """Order tiles so each comes after the tiles it reads; ties keep declaration order.

    Returns (order, cycle). States are not edges: reading a carried-forward state reads
    last month's value, so a loop through a state is not a cycle.
    """
    deps = {t.name: [a for a in t.args if kinds.get(a) == "tile"] for t in tiles}
    remaining = [t.name for t in tiles]
    done = set()
    order = []
    progress = True
    while remaining and progress:
        progress = False
        for name in remaining:
            if all(d in done for d in deps[name]):
                order.append(name)
                done.add(name)
                remaining.remove(name)
                progress = True
                break
    if not remaining:
        return order, None
    return order, _find_cycle(remaining, deps)


def _find_cycle(names, deps):
    names = set(names)
    for start in sorted(names):
        path, on_path = [], set()

        def visit(node):
            if node in on_path:
                return path[path.index(node):] + [node]
            if node not in names:
                return None
            path.append(node)
            on_path.add(node)
            for dep in deps[node]:
                found = visit(dep)
                if found:
                    return found
            path.pop()
            on_path.discard(node)
            return None

        found = visit(start)
        if found:
            # deps point from reader to what it reads; report in flow direction
            return list(reversed(found))
    return sorted(names)


# ---------------------------------------------------------------- graph

@dataclass(frozen=True)
class ModuleInfo:
    id: str
    tiles: tuple[str, ...]
    inputs: tuple[str, ...]
    feeds: tuple[str, ...]
    fed_by: tuple[str, ...]


@dataclass(frozen=True)
class Graph:
    tiles: dict  # name -> Tile
    kinds: dict  # name -> "tile" | "input" | "param" | "state"
    order: tuple[str, ...]  # every tile, dependencies first
    used_by: dict  # name -> tiles that take it as an argument
    edges: tuple[tuple[str, str], ...]  # (argument quantity, tile reading it)
    modules: dict  # module id -> ModuleInfo
    timings: dict  # tile name -> "step" | "summary"
    # module id -> ((title or None, tiles), ...): every tile of the module once, the configured sections in the
    # order given and then one untitled section of the tiles not listed (dependency order); see `module_sections`
    sections: dict = dataclasses.field(default_factory=dict)

    def step_order(self):
        return [n for n in self.order if self.timings[n] == "step"]

    def summary_order(self):
        return [n for n in self.order if self.timings[n] == "summary"]


def build_graph(model):
    """Resolve names and build the validated graph, raising TilekitError on any structural problem."""
    tiles = model.tiles
    kinds, duplicates = quantity_kinds(model, tiles)
    if duplicates:
        names = ", ".join(dict.fromkeys(d["name"] for d in duplicates))
        if all(d.get("differs_only_by_case") for d in duplicates):
            raise TilekitError(f"Quantity names that differ only by case: {names}", duplicates)
        raise TilekitError(f"Quantity names defined more than once: {names}", duplicates)

    missing = unresolved_args(tiles, kinds)
    if missing:
        text = ", ".join(f"'{m['arg']}' in {m['tile']}" for m in missing)
        raise TilekitError(f"Unresolved argument names: {text}", missing)

    tiles_by_name = {t.name: t for t in tiles}
    states_by_name = {s.name: s for s in model.config.states}
    timings = {t.name: model.config.module(t.module).timing for t in tiles}

    for state in model.config.states:
        source = tiles_by_name.get(state.source)
        if source is None:
            raise TilekitError(f"State '{state.name}' comes from '{state.source}', which is not a tile")
        if timings[source.name] != "step":
            raise TilekitError(f"State '{state.name}' comes from summary tile '{state.source}'; it must be a step tile")

    for tile in tiles:
        if timings[tile.name] == "step":
            bad = [a for a in tile.args if kinds[a] == "tile" and timings[a] == "summary"]
            if bad:
                raise TilekitError(f"Step tile '{tile.name}' reads summary tiles {bad}; summaries are only known after the loop")

    order, cycle = topological_order(tiles, kinds)
    if cycle:
        raise TilekitError("Cycle between tiles: " + " -> ".join(cycle), {"cycle": cycle})

    used_by = {name: [] for name in kinds}
    edges = []
    for name in order:
        for arg in dict.fromkeys(tiles_by_name[name].args):
            used_by[arg].append(name)
            edges.append((arg, name))

    modules = {}
    feeds = {m.id: [] for m in model.config.modules}
    fed_by = {m.id: [] for m in model.config.modules}
    for module in model.config.modules:
        names = [n for n in order if tiles_by_name[n].module == module.id]
        inputs = []
        for name in names:
            for arg in tiles_by_name[name].args:
                is_own_tile = kinds[arg] == "tile" and tiles_by_name[arg].module == module.id
                if not is_own_tile and arg not in inputs:
                    inputs.append(arg)
                provider = provider_module(arg, kinds, tiles_by_name, states_by_name)
                if provider and provider != module.id and provider not in fed_by[module.id]:
                    fed_by[module.id].append(provider)
                    feeds[provider].append(module.id)
        inputs.sort(key=lambda n: KIND_RANK[kinds[n]])
        modules[module.id] = (names, inputs)

    module_order = [m.id for m in model.config.modules]
    infos = {
        module_id: ModuleInfo(
            id=module_id,
            tiles=tuple(names),
            inputs=tuple(inputs),
            feeds=tuple(sorted(feeds[module_id], key=module_order.index)),
            fed_by=tuple(sorted(fed_by[module_id], key=module_order.index)),
        )
        for module_id, (names, inputs) in modules.items()
    }
    sections = {module.id: module_sections(module, infos[module.id].tiles) for module in model.config.modules}
    for module in model.config.modules:
        validate_checks(module, kinds, timings)
    return Graph(
        tiles=tiles_by_name,
        kinds=kinds,
        order=tuple(order),
        used_by=used_by,
        edges=tuple(edges),
        modules=infos,
        timings=timings,
        sections=sections,
    )


def module_sections(module, tiles):
    """((title or None, tiles), ...) for a module: its `[[module.section]]`s in the order given (tiles in the order
    listed), then the tiles no section lists as one untitled section in dependency order. A module without sections
    has a single untitled section holding all its tiles. Every listed name must be a tile of the module, and no tile
    may be in two sections."""
    own = set(tiles)
    seen = {}
    out = []
    for section in module.sections:
        for name in section.tiles:
            if name not in own:
                raise TilekitError(f"tilekit.toml: section '{section.title}' of module '{module.id}' lists "
                                   f"'{name}', which is not a tile of that module", {"tiles": list(tiles)})
            if name in seen:
                raise TilekitError(f"tilekit.toml: tile '{name}' is in two sections of module '{module.id}' "
                                   f"('{seen[name]}' and '{section.title}')")
            seen[name] = section.title
        out.append((section.title, tuple(section.tiles)))
    rest = tuple(n for n in tiles if n not in seen)
    if rest or not out:
        out.append((None, rest))
    return tuple(out)


CHECK_KINDS = ("tile", "input", "state", "param")


def validate_checks(module, kinds, timings):
    """A module's `[[module.check]]`s read only step quantities of the model, and a check's name is not a quantity."""
    if module.checks and module.timing == "summary":
        raise TilekitError(f"tilekit.toml: module '{module.id}' is a summary module; checks are for step modules")
    folded = {n.lower(): n for n in kinds}
    from tilekit.reconcile import names, parse_expression
    for check in module.checks:
        if check.name.lower() in folded:
            raise TilekitError(f"tilekit.toml: check '{check.name}' of module '{module.id}' has the name of the "
                               f"quantity '{folded[check.name.lower()]}'; give it another name")
        for name in names(parse_expression(check.expression, f"check '{check.name}'")):
            kind = kinds.get(name)
            if kind not in CHECK_KINDS:
                raise TilekitError(f"tilekit.toml: check '{check.name}' of module '{module.id}' reads '{name}', "
                                   "which is not a tile, input, state or parameter of the model")
            if kind == "tile" and timings[name] != "step":
                raise TilekitError(f"tilekit.toml: check '{check.name}' of module '{module.id}' reads the summary "
                                   f"tile '{name}'; checks hold month by month, so they read step quantities only")


def graph_json(model):
    """The `tilekit graph` document."""
    from tilekit.translate import model_translations

    graph = model.graph
    config = model.config
    defaults = model.default_params()
    translations = model_translations(model)
    quantities = {}

    for item in config.input_series:
        quantities[item.name] = {"kind": "input", "label": item.label, "format": item.format,
                                 "excel": item.excel, "used_by": graph.used_by[item.name]}
    for name, field in param_fields(model).items():
        meta = field.metadata
        quantities[name] = {"kind": "param", "label": meta.get("label", name), "format": meta.get("format", "number"),
                            "units": meta.get("units"), "value": getattr(defaults, name),
                            "used_by": graph.used_by[name]}
    for state in config.states:
        quantities[state.name] = {"kind": "state", "label": state.label, "format": state.format,
                                  "from": state.source, "initial": state.initial,
                                  "used_by": graph.used_by[state.name]}
    for name in graph.order:
        tile = graph.tiles[name]
        translation = translations[name]
        quantities[name] = {
            "kind": "tile",
            "module": tile.module,
            "label": tile.doc.label,
            "spec": tile.doc.spec,
            "units": tile.doc.units,
            "timing": tile.doc.timing,
            "format": tile.doc.format,
            "assumed": list(tile.doc.assumed),
            "undefined": tile.doc.undefined,
            "args": list(tile.args),
            "used_by": graph.used_by[name],
            "source": {"file": tile.file, "line": tile.line, "code": tile.code},
            "expression": tile.expression,
            "formula": translation.formula,
            "translatable": translation.translatable,
            "untranslatable_reason": translation.reason,
            "branches": list(translation.branches),
            "status": "not_built" if tile.doc.not_built else None,
        }

    return {
        "model": {"name": config.name, "months": config.months, "default_case": _default_case(model)},
        "layers": list(config.layers),
        "tables": [{"name": t.name, "label": t.label, "file": t.file, "columns": list(t.columns), "rows": len(t.rows)}
                   for t in config.tables],
        "modules": [
            {
                "id": module.id,
                "title": module.title,
                "layer": module.layer,
                "timing": module.timing,
                "python": module.python,
                "file": _module_file(model, module.id),
                "tiles": list(graph.modules[module.id].tiles),
                "inputs": list(graph.modules[module.id].inputs),
                "feeds": list(graph.modules[module.id].feeds),
                "fed_by": list(graph.modules[module.id].fed_by),
                "sections": [{"title": title, "tiles": list(tiles)} for title, tiles in graph.sections[module.id]],
                "checks": [{"name": c.name, "label": c.label, "expression": c.expression, "tolerance": c.tolerance}
                           for c in module.checks],
            }
            for module in config.modules
        ],
        "quantities": quantities,
        "order": list(graph.order),
        "edges": [{"from": a, "to": b} for a, b in graph.edges],
    }


def _module_file(model, module_id):
    path = Path(model.python_modules[module_id].__file__).resolve()
    return _relative(path, model.root)


def _default_case(model):
    from tilekit.workbook import default_case_id
    try:
        return default_case_id(model)
    except TilekitError:
        return model.config.default_case
