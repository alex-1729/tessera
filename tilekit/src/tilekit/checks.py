"""Static rule checks on every tile, read from the source with `ast`."""

import ast
import dataclasses

from tilekit.config import FORMATS
from tilekit.graph import module_source, provider_module, quantity_kinds, topological_order
from tilekit.translate import allowed_calls

ALLOWED_LITERALS = (0, 1)
RATE_SUFFIXES = ("_pa", "_pm")
TK_ALIAS = "tk"  # tiles import tilekit's financial functions as `from tilekit import functions as tk`
SUM_AXIS_MESSAGE = "sum over time needs axis=0"


def _violation(tile, rule, message, line, severity="error"):
    return {"tile": tile.name, "module": tile.module, "rule": rule, "message": message,
            "line": line, "severity": severity}


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        return ".".join([node.id, *reversed(parts)])
    return None


def _target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for t in target.elts for n in _target_names(t)]
    return []


def _mutating_targets(target):
    """Attribute or subscript targets, including inside tuple unpacking."""
    if isinstance(target, (ast.Attribute, ast.Subscript)):
        return [target]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for t in target.elts for n in _mutating_targets(t)]
    return []


def _check_signature(tile):
    a = tile.node.args
    found = []
    if a.vararg:
        found.append(_violation(tile, "signature", f"*{a.vararg.arg} is not allowed; list every argument by name", tile.line))
    if a.kwarg:
        found.append(_violation(tile, "signature", f"**{a.kwarg.arg} is not allowed; list every argument by name", tile.line))
    if a.defaults or any(d is not None for d in a.kw_defaults):
        found.append(_violation(tile, "signature", "Arguments may not have defaults", tile.line))
    if a.kwonlyargs:
        found.append(_violation(tile, "signature", "Keyword-only arguments are not allowed", tile.line))
    return found


def _check_body_shape(tile):
    body = tile.node.body
    statements = body[1:] if ast.get_docstring(tile.node, clean=False) is not None else body
    found = []
    if not statements or not isinstance(statements[-1], ast.Return) or statements[-1].value is None:
        line = statements[-1].lineno if statements else tile.line
        found.append(_violation(tile, "body-shape", "The body must end with a single `return <expression>`", line))
    reported_elsewhere = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.AugAssign, ast.Delete)
    for statement in statements[:-1]:
        if isinstance(statement, reported_elsewhere):
            continue
        if isinstance(statement, ast.Assign):
            continue  # attribute/subscript targets are reported as mutation
        kind = type(statement).__name__
        found.append(_violation(tile, "body-shape",
                                f"Only simple assignments may come before the return (found {kind})",
                                statement.lineno))
    return found


def _check_docstring(tile):
    doc = tile.doc
    if ast.get_docstring(tile.node) is None:
        return [_violation(tile, "docstring", "No docstring; the first line must be the plain-English label", tile.line)]
    found = []
    if not doc.label:
        found.append(_violation(tile, "docstring", "The docstring has no label line", tile.line))
    if doc.format is None:
        found.append(_violation(tile, "docstring", f"The docstring has no `Format:` line; use one of {list(FORMATS)}", tile.line))
    elif doc.format not in FORMATS:
        found.append(_violation(tile, "docstring", f"Format '{doc.format}' is not one of {list(FORMATS)}", tile.line))
    return found


def _check_naming(tile):
    name, doc = tile.name, tile.doc
    timing = (doc.timing or "").lower()
    found = []
    if doc.format == "rate" and not name.endswith(RATE_SUFFIXES):
        found.append(_violation(tile, "naming", "A rate's name should end _pa or _pm", tile.line, "warning"))
    if ("beginning of month" in timing or "start of month" in timing) and not name.endswith("_bop"):
        found.append(_violation(tile, "naming", "A beginning-of-month quantity's name should end _bop", tile.line, "warning"))
    if "end of month" in timing and not name.endswith("_eop"):
        found.append(_violation(tile, "naming", "An end-of-month quantity's name should end _eop", tile.line, "warning"))
    return found


def _check_expressions(tile, tile_names, timing="step", is_integer=lambda node: False):
    """Literals, names read, calls, loops, ifs and mutation, from a walk over the function body."""
    found = []
    allowed = allowed_calls()
    for decorator in tile.node.decorator_list:
        found.append(_violation(tile, "decorators", f"Decorator '@{ast.unparse(decorator)}' is not allowed on a tile",
                                decorator.lineno))
    args = set(tile.args)
    local_names = set()
    for node in ast.walk(tile.node):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                local_names.update(_target_names(target))
        elif isinstance(node, ast.NamedExpr):
            local_names.add(node.target.id)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            local_names.update(_target_names(node.target))  # the loop itself is reported once, as no-loops
    call_funcs = set()

    docstring_node = None
    if ast.get_docstring(tile.node, clean=False) is not None:
        docstring_node = tile.node.body[0].value

    for statement in tile.node.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Call):
                func = node.func
                call_funcs.add(id(func))
                dotted = _dotted(func)
                if isinstance(func, ast.Name) and func.id in tile_names:
                    found.append(_violation(tile, "no-tile-calls",
                                            f"Calls tile '{func.id}'; take it as an argument instead", node.lineno))
                elif dotted not in allowed:
                    text = ast.unparse(func)
                    found.append(_violation(tile, "numpy-calls-only",
                                            f"Calls '{text}'; only these functions may be called: {', '.join(allowed)}",
                                            node.lineno))
                for keyword in node.keywords:
                    if keyword.arg == "out":
                        found.append(_violation(tile, "no-mutation",
                                                "The `out=` keyword writes into an array; return a new value instead",
                                                node.lineno))
                if dotted == "np.sum":
                    axis = [k for k in node.keywords if k.arg == "axis"]
                    if timing != "summary":
                        found.append(_violation(tile, "sum-axis",
                                                "np.sum is only allowed in summary tiles, as np.sum(..., axis=0)",
                                                node.lineno))
                    elif not (len(axis) == 1 and isinstance(axis[0].value, ast.Constant)
                              and axis[0].value.value == 0 and not isinstance(axis[0].value.value, bool)
                              and len(node.args) == 1):
                        found.append(_violation(tile, "sum-axis", SUM_AXIS_MESSAGE, node.lineno))
            elif isinstance(node, ast.Constant) and node is not docstring_node:
                value = node.value
                if isinstance(value, (int, float, complex)) and not isinstance(value, bool) and value not in ALLOWED_LITERALS:
                    found.append(_violation(tile, "literals",
                                            f"Literal {value!r}; only 0 and 1 are allowed, put other values in Params",
                                            node.lineno))
                elif isinstance(value, (str, bytes)):
                    found.append(_violation(tile, "literals",
                                            f"Text constant {value!r}; a tile computes numbers only", node.lineno))
            elif isinstance(node, ast.JoinedStr):
                found.append(_violation(tile, "literals", "f-strings are not allowed in a tile", node.lineno))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                what = "lambda" if isinstance(node, ast.Lambda) else f"definition of '{node.name}'"
                found.append(_violation(tile, "no-nested-functions",
                                        f"Nested {what} inside a tile; write a separate tile instead", node.lineno))
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                found.append(_violation(tile, "no-globals",
                                        f"`{type(node).__name__.lower()}` is not allowed in a tile", node.lineno))
            elif isinstance(node, ast.Compare):
                operands = [node.left, *node.comparators]
                for op, left, right in zip(node.ops, operands, operands[1:]):
                    if isinstance(op, (ast.Eq, ast.NotEq)) and not (is_integer(left) and is_integer(right)):
                        found.append(_violation(
                            tile, "comparisons",
                            f"`{ast.unparse(left)} {'==' if isinstance(op, ast.Eq) else '!='} {ast.unparse(right)}` "
                            "compares quantities that are not whole numbers; Excel and Python may disagree on "
                            "equality after rounding", node.lineno, "warning"))
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
                found.append(_violation(tile, "no-loops", "Loops are not allowed; use whole-array NumPy", node.lineno))
            elif isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                found.append(_violation(tile, "no-loops", "Comprehensions are loops; use whole-array NumPy", node.lineno))
            elif isinstance(node, ast.If):
                found.append(_violation(tile, "no-if", "`if` statements are not allowed; use np.where", node.lineno))
            elif isinstance(node, ast.IfExp):
                found.append(_violation(tile, "no-if", "Conditional expressions are not allowed; use np.where", node.lineno))
            elif isinstance(node, ast.AugAssign):
                found.append(_violation(tile, "no-mutation",
                                        f"In-place update of '{ast.unparse(node.target)}'; write a new name instead",
                                        node.lineno))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for bad in _mutating_targets(target):
                        found.append(_violation(tile, "no-mutation",
                                                f"Assigns to '{ast.unparse(bad)}'; tiles may not mutate anything",
                                                node.lineno))
            elif isinstance(node, ast.Delete):
                found.append(_violation(tile, "no-mutation", "`del` is not allowed", node.lineno))

    for statement in tile.node.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and id(node) not in call_funcs:
                if node.id not in args and node.id not in local_names and node.id not in ("np", TK_ALIAS):
                    found.append(_violation(tile, "names",
                                            f"Reads '{node.id}', which is not an argument, a local or np",
                                            node.lineno))
    return found


def _import_problems(tree):
    """(line, message) for every import other than `import numpy as np` and `from tilekit import functions as tk`."""
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name != "numpy":
                    problems.append((node.lineno, f"Imports '{alias.name}'; a module may import only numpy"))
                elif alias.asname != "np":
                    problems.append((node.lineno, "Import numpy as `import numpy as np`"))
        elif isinstance(node, ast.ImportFrom):
            if node.module == "__future__":
                continue
            if node.module == "tilekit" and node.level == 0 and all(
                    a.name == "functions" and a.asname == TK_ALIAS for a in node.names):
                continue
            names = ", ".join(a.name for a in node.names)
            problems.append((node.lineno, f"`from {node.module} import {names}`; use `import numpy as np` "
                                          f"and `from tilekit import functions as {TK_ALIAS}` only"))
    return problems


def _module_level_problems(tree):
    """(line, message) for top-level code in a tile module other than its docstring, imports and plain functions.

    Imports are reported by the imports rule. Decorators and default argument values on any function in the
    module run code at import time, so they are reported here too.
    """
    problems = []
    for index, node in enumerate(tree.body):
        if index == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            continue
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        if isinstance(node, ast.FunctionDef):
            if node.name.startswith("_"):
                if node.decorator_list:
                    problems.append((node.lineno, f"Decorator on '{node.name}'; a tile module may not run code "
                                                  "at import time"))
                if node.args.defaults or any(d is not None for d in node.args.kw_defaults):
                    problems.append((node.lineno, f"Default argument values on '{node.name}'; a tile module may "
                                                  "not run code at import time"))
            continue
        kind = type(node).__name__
        problems.append((node.lineno, f"Top-level {kind} statement `{ast.unparse(node).splitlines()[0][:60]}`; a tile "
                                      "module may hold only its docstring, `import numpy as np`, "
                                      f"`from tilekit import functions as {TK_ALIAS}` and function definitions"))
    return problems


def _integer_names(model):
    """Quantities whose Format is `integer`."""
    names = set()
    for field in dataclasses.fields(model.params_class):
        if field.metadata.get("format") == "integer":
            names.add(field.name)
    names |= {i.name for i in model.config.input_series if i.format == "integer"}
    names |= {s.name for s in model.config.states if s.format == "integer"}
    names |= {t.name for t in model.tiles if t.doc.format == "integer"}
    return names


def _is_integer_expression(node, integers, locals_):
    if isinstance(node, ast.Constant):
        return isinstance(node.value, int) and not isinstance(node.value, bool)
    if isinstance(node, ast.Name):
        if node.id in locals_:
            return _is_integer_expression(locals_[node.id], integers, {})
        return node.id in integers
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        return _is_integer_expression(node.operand, integers, locals_)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)):
        return all(_is_integer_expression(n, integers, locals_) for n in (node.left, node.right))
    return False


def run_checks(model):
    """Every rule violation in the model: a list of {tile, module, rule, message, line, severity}."""
    tiles = model.tiles
    config = model.config
    tile_names = {t.name for t in tiles}
    kinds, duplicates = quantity_kinds(model, tiles)
    tiles_by_name = {t.name: t for t in tiles}
    states_by_name = {s.name: s for s in config.states}
    layer_index = {m.id: config.layers.index(m.layer) for m in config.modules}
    module_layer = {m.id: m.layer for m in config.modules}

    import_problems = {}
    module_problems = {}
    for module in config.modules:
        _, _, tree = module_source(model.python_modules[module.id])
        import_problems[module.id] = _import_problems(tree)
        module_problems[module.id] = _module_level_problems(tree)
    integers = _integer_names(model)

    duplicate_names = {d["name"]: d["defined_as"] for d in duplicates}
    _, cycle = topological_order(tiles, kinds)
    cycle_names = set(cycle or [])

    violations = []
    for tile in tiles:
        found = []
        for arg in tile.args:
            if arg not in kinds:
                found.append(_violation(tile, "args-resolve",
                                        f"Argument '{arg}' is not a tile, input, parameter or state", tile.line))
        if tile.name in duplicate_names:
            where = "; ".join(duplicate_names[tile.name])
            found.append(_violation(tile, "unique-name", f"'{tile.name}' is defined more than once: {where}", tile.line))
        if tile.name in cycle_names:
            found.append(_violation(tile, "no-cycle", "Part of a cycle: " + " -> ".join(cycle), tile.line))
        found += _check_signature(tile)
        found += _check_body_shape(tile)
        locals_ = {t.id: s.value for s in tile.node.body if isinstance(s, ast.Assign)
                   for t in s.targets if isinstance(t, ast.Name)}
        found += _check_expressions(tile, tile_names, config.module(tile.module).timing,
                                    lambda node: _is_integer_expression(node, integers, locals_))
        found += _check_docstring(tile)
        found += _check_naming(tile)
        for line, message in import_problems[tile.module]:
            found.append(_violation(tile, "imports", message, line))
        for line, message in module_problems[tile.module]:
            found.append(_violation(tile, "module-level", message, line))
        for arg in tile.args:
            provider = provider_module(arg, kinds, tiles_by_name, states_by_name)
            if provider and layer_index[provider] > layer_index[tile.module]:
                found.append(_violation(
                    tile, "layers",
                    f"Reads '{arg}' from layer '{module_layer[provider]}', which is to the right of "
                    f"'{module_layer[tile.module]}'", tile.line))
        violations += sorted(found, key=lambda v: v["line"])
    return violations


def checks_json(model):
    """The `tilekit check` document."""
    violations = run_checks(model)
    return {
        "violations": violations,
        "counts": {
            "error": sum(v["severity"] == "error" for v in violations),
            "warning": sum(v["severity"] == "warning" for v in violations),
        },
    }
