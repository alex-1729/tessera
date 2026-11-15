"""Stamps: SHA-256 digests of everything a stored workbook depends on.

A stamp is `{code, spec, upstream, cases, params, translator}`, each a hex digest:

- code: the tile's normalised source (`ast.dump` of the function, decorators included, without
  its docstring, so formatting and comments do not matter) and the normalised top-level code of
  its module file other than function definitions and the module docstring (imports and anything
  else that runs at import);
- spec: the tile's docstring;
- upstream: the code and spec of every tile upstream of it (followed through arguments,
  and through a carried-forward state to its source tile; each tile counted once, so
  loops through states end);
- cases: every case file;
- params: parameter defaults and metadata, input and state config (including `excel`
  templates), assumption tables (their config and every value), months, the normalised
  source of every `.py` file in the model package except the tile module files (covered by
  `code`) and `reference.py`, the bytes of every file under `<model>/assumptions/` and of
  every table file declared in `tilekit.toml`; for the model workbook also the case it shows;
- translator: the translator version and the formula layout version (layout changes that change
  what a formula means);
- layout: the workbook layout version (any other layout change).

`code`/`spec`/`translator` changing means the formula itself changed; only
`upstream`/`cases`/`params`/`layout` changing means only values (or how they are shown) changed.
A stamp written before `layout` existed lacks the key, so it differs from a current stamp in
`layout` (values drift) and, for tilekit-workbook 4 stamps, in nothing else.
"""

import ast
import copy
import dataclasses
import hashlib
import json
from pathlib import Path

from tilekit.translate import TRANSLATOR_VERSION

# Two layout versions. FORMULA_LAYOUT_VERSION is part of `translator` (formula drift): bump it only for a layout
# change that changes what a tile's formula means. It was the whole layout version up to "tilekit-workbook 4".
# LAYOUT_VERSION is the stamp's own `layout` key (values drift): bump it for any other change to how workbooks are
# laid out, such as "tilekit-workbook 5", which shows a per-policy constant input as one named cell. A sign-off
# then goes stale with values drift and, its formula text being unchanged, can be re-confirmed.
FORMULA_LAYOUT_VERSION = "tilekit-workbook 4"
LAYOUT_VERSION = "tilekit-workbook 5"
STAMP_KEYS = ("code", "spec", "upstream", "cases", "params", "translator", "layout")


def _digest(*parts):
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode() if isinstance(part, str) else part)
        h.update(b"\x00")
    return h.hexdigest()


def normalised_source(node):
    """`ast.dump` of a function definition without its docstring."""
    node = copy.deepcopy(node)
    body = node.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        node.body = body[1:] or [ast.Pass()]
    return ast.dump(node, include_attributes=False)


def module_digest(path):
    """Digest of a module file's top-level code other than function definitions and its docstring."""
    tree = ast.parse(Path(path).read_text(), filename=str(path))
    body = list(tree.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]
    rest = [n for n in body if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return _digest(*(ast.dump(n, include_attributes=False) for n in rest))


def code_digest(tile):
    return _digest(normalised_source(tile.node), module_digest(tile.path))


def spec_digest(tile):
    doc = ast.get_docstring(tile.node, clean=True) or ""
    return _digest(doc)


def upstream_tiles(model, names):
    """Every tile upstream of the given tiles (not including them unless reached through a loop)."""
    graph = model.graph
    states = {s.name: s.source for s in model.config.states}
    seen, stack = set(), []
    for name in names:
        stack.extend(graph.tiles[name].args)
    while stack:
        arg = stack.pop()
        kind = graph.kinds.get(arg)
        if kind == "state":
            arg, kind = states[arg], "tile"
        if kind != "tile" or arg in seen:
            continue
        seen.add(arg)
        stack.extend(graph.tiles[arg].args)
    return seen


def _tiles_digest(model, names):
    graph = model.graph
    return _digest(*(f"{n}:{code_digest(graph.tiles[n])}:{spec_digest(graph.tiles[n])}" for n in sorted(names)))


def cases_digest(model):
    folder = model.root / "cases"
    files = sorted(folder.glob("*.json")) if folder.is_dir() else []
    return _digest(*(p.name.encode() + b"\x00" + p.read_bytes() for p in files))


def params_digest(model):
    config = model.config
    defaults = model.default_params()
    params = [
        {"name": f.name, "default": getattr(defaults, f.name), "metadata": dict(f.metadata)}
        for f in dataclasses.fields(model.params_class)
    ]
    data = {
        "params": params,
        "inputs": [dataclasses.asdict(i) for i in config.input_series],
        "states": [dataclasses.asdict(s) for s in config.states],
        "tables": [dataclasses.asdict(t) for t in config.tables],
        "months": config.months,
    }
    return _digest(json.dumps(data, sort_keys=True, default=str), *_package_sources(model), *_data_files(model))


def _package_sources(model):
    """`name:ast` of every .py file in the model package except tile module files and reference.py."""
    package_file = getattr(model.package, "__file__", None)
    if not package_file:
        return []
    package_dir = Path(package_file).resolve().parent
    tile_files = {Path(m.__file__).resolve() for m in model.python_modules.values()}
    out = []
    for path in sorted(package_dir.rglob("*.py")):
        if "__pycache__" in path.parts or path.resolve() in tile_files or path.name == "reference.py":
            continue
        rel = path.relative_to(package_dir).as_posix()
        try:
            text = ast.dump(ast.parse(path.read_text(), filename=str(path)), include_attributes=False)
        except SyntaxError:
            text = "syntax-error:" + path.read_text()
        out.append(f"{rel}:{text}")
    return out


def _data_files(model):
    """`name` + bytes of every file under assumptions/ and every declared table file."""
    root = model.root
    paths = set()
    folder = root / "assumptions"
    if folder.is_dir():
        paths |= {p for p in folder.rglob("*") if p.is_file()}
    for table in model.config.tables:
        path = root / table.file
        if path.is_file():
            paths.add(path)
    out = []
    for path in sorted(paths):
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            rel = path.as_posix()
        out.append(rel.encode() + b"\x00" + path.read_bytes())
    return out


def translator_digest():
    return _digest(TRANSLATOR_VERSION, FORMULA_LAYOUT_VERSION)


def layout_digest():
    return _digest(LAYOUT_VERSION)


def _shared(model):
    cache = model.__dict__.get("_stamp_shared")
    if cache is None:
        cache = {"cases": cases_digest(model), "params": params_digest(model), "translator": translator_digest(),
                 "layout": layout_digest()}
        model.__dict__["_stamp_shared"] = cache
    return cache


def tile_stamp(model, name):
    tile = model.graph.tiles[name]
    upstream = upstream_tiles(model, [name]) - {name}
    return {"code": code_digest(tile), "spec": spec_digest(tile), "upstream": _tiles_digest(model, upstream),
            **_shared(model)}


def _group_stamp(model, names, extra):
    graph = model.graph
    upstream = upstream_tiles(model, names) - set(names)
    return {
        "code": _digest(extra, *(f"{n}:{code_digest(graph.tiles[n])}" for n in names)),
        "spec": _digest(*(f"{n}:{spec_digest(graph.tiles[n])}" for n in names)),
        "upstream": _tiles_digest(model, upstream),
        **_shared(model),
    }


def module_stamp(model, module_id):
    module = model.config.module(module_id)
    names = list(model.graph.modules[module_id].tiles)
    return _group_stamp(model, names, json.dumps(dataclasses.asdict(module), sort_keys=True))


def model_stamp(model, case_id=None):
    """The model's stamp; with `case_id`, the stamp of the model workbook for that case (the case is in `params`)."""
    modules = [dataclasses.asdict(m) for m in model.config.modules]
    extra = json.dumps({"name": model.config.name, "modules": modules}, sort_keys=True)
    stamp = _group_stamp(model, list(model.graph.order), extra)
    if case_id is not None:
        stamp["params"] = _digest(stamp["params"], f"case:{case_id}")
    return stamp
