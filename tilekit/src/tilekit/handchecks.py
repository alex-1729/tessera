"""Hand checks: the checks of a tile's hand-calculation test, read so they can be laid out in its workbook.

A tile's test file (`tests/tiles/test_<tile>.py`) asserts the tile's value for inputs worked out by hand.
Every assertion of the plain form

    assert tile(1.0, 2.0, name=3.0) == pytest.approx(4.0, rel=0, abs=1e-9)
    assert tile(1.0, 2.0, 3.0) == 4.0

(numbers, or module-level constants and simple arithmetic on them) becomes one hand check:
`{test, index, args: {argument: value}, expected, tolerance}`. The tile workbook gets a `Hand checks`
sheet with one column per check, where the tile's own Excel formula is evaluated on those inputs and
compared with the hand figure. A test whose assertions are not of that form (a loop, a comparison of two
calls, an inequality) is listed in `not_in_sheet`: it still runs in Python, but Excel does not see it.

Hand checks are not part of a stamp: adding or changing a test never makes a sign-off stale. The sidecar
records their digest, and a workbook built for other checks than the test file now holds is out of date.
"""

import ast
import hashlib
import json
import operator

from tilekit.translate import TOLERANCE_ABS, model_translations

SHEET = "Hand checks"
CASE = "__hand__"  # the pseudo case id of the Hand checks sheet in a build's results

_BINARY = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
           ast.Pow: operator.pow}


def test_path(model, name):
    return model.root / "tests" / "tiles" / f"test_{name}.py"


def _number(node, constants):
    """The number a literal expression stands for, or None."""
    if isinstance(node, ast.Constant):
        value = node.value
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if isinstance(node, ast.Name):
        value = constants.get(node.id)
        return value if isinstance(value, float) else None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _number(node.operand, constants)
        return None if value is None else (-value if isinstance(node.op, ast.USub) else value)
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        left, right = _number(node.left, constants), _number(node.right, constants)
        if left is None or right is None:
            return None
        try:
            value = _BINARY[type(node.op)](left, right)
        except (ArithmeticError, ValueError):
            return None
        return float(value) if isinstance(value, (int, float)) else None
    return None


def _mapping(node, constants):
    """{keyword: number} of a `dict(a=1)` call, a `{"a": 1}` literal or a module-level name bound to one."""
    if isinstance(node, ast.Name):
        value = constants.get(node.id)
        return value if isinstance(value, dict) else None
    out = {}
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict" and not node.args:
        pairs = [(k.arg, k.value) for k in node.keywords]
    elif isinstance(node, ast.Dict):
        pairs = [(k.value if isinstance(k, ast.Constant) else None, v) for k, v in zip(node.keys, node.values)]
    else:
        return None
    for key, value in pairs:
        number = _number(value, constants)
        if not isinstance(key, str) or number is None:
            return None
        out[key] = number
    return out


def _constants(tree):
    """Module-level names bound once to a number or to a mapping of numbers."""
    found, seen = {}, set()
    for node in tree.body:
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)):
            continue
        name = node.targets[0].id
        if name in seen:
            found.pop(name, None)
            continue
        seen.add(name)
        value = _number(node.value, found)
        if value is None:
            value = _mapping(node.value, found)
        if value is not None:
            found[name] = value
    return found


def _call_args(node, tile, arg_names, constants):
    """{argument: value} of a call `tile(...)` with every argument a number, or None."""
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == tile):
        return None
    if len(node.args) > len(arg_names) or any(isinstance(a, ast.Starred) for a in node.args):
        return None
    values = {}
    for name, arg in zip(arg_names, node.args):
        values[name] = _number(arg, constants)
    for keyword in node.keywords:
        if keyword.arg is None or keyword.arg not in arg_names or keyword.arg in values:
            return None
        values[keyword.arg] = _number(keyword.value, constants)
    if set(values) != set(arg_names) or any(v is None for v in values.values()):
        return None
    return {name: values[name] for name in arg_names}


def _expected(node, constants):
    """(expected, tolerance) of the right-hand side: a number, or `pytest.approx(number, ...)`; or None."""
    number = _number(node, constants)
    if number is not None:
        return number, TOLERANCE_ABS
    if not isinstance(node, ast.Call):
        return None
    func = node.func
    is_approx = (isinstance(func, ast.Attribute) and func.attr == "approx") or \
        (isinstance(func, ast.Name) and func.id == "approx")
    if not is_approx or not node.args:
        return None
    number = _number(node.args[0], constants)
    if number is None:
        return None
    options = {}
    if len(node.args) > 1:
        return None  # positional rel/abs: not the form the tests use
    for keyword in node.keywords:
        if keyword.arg is None:
            extra = _mapping(keyword.value, constants)
            if extra is None:
                return None
            options.update(extra)
        else:
            value = _number(keyword.value, constants)
            if value is None:
                return None
            options[keyword.arg] = value
    if any(k not in ("rel", "abs") for k in options):
        return None
    # pytest's own defaults when a bound is not given: rel 1e-6, abs 1e-12
    rel = options.get("rel", 1e-6 if "abs" not in options else 0.0)
    tolerance = max(options.get("abs", 1e-12), rel * abs(number))
    return number, tolerance


def _assert_check(node, tile, arg_names, constants):
    test = node.test
    if not (isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)):
        return None
    left, right = test.left, test.comparators[0]
    args = _call_args(left, tile, arg_names, constants)
    other = right
    if args is None:
        args, other = _call_args(right, tile, arg_names, constants), left
    if args is None:
        return None
    expected = _expected(other, constants)
    if expected is None:
        return None
    return {"args": args, "expected": expected[0], "tolerance": expected[1]}


def extract(model, name, translations=None):
    """The hand checks of tile `name`: `{checks, not_in_sheet, digest}`.

    A summary tile, or one with no Excel formula, has every test in `not_in_sheet`: only a step tile's formula
    can be evaluated on one check's inputs. A tile with no test file, or one that does not parse, has no checks.
    `translations` is `model_translations(model)` when the caller already has it.
    """
    if translations is None:
        translations = model_translations(model)
    translation = translations.get(name)
    in_sheet = bool(translation and translation.translatable) and name not in set(model.graph.summary_order())
    path = test_path(model, name)
    checks, not_in_sheet = [], []
    try:
        tree = ast.parse(path.read_text(), filename=str(path))
    except (OSError, SyntaxError, ValueError):
        tree = None
    if tree is not None:
        arg_names = list(model.graph.tiles[name].args)
        constants = _constants(tree)
        for node in tree.body:
            if not (isinstance(node, ast.FunctionDef) and node.name.startswith("test_")):
                continue
            asserts = [n for n in ast.walk(node) if isinstance(n, ast.Assert)]
            if not asserts:
                continue
            direct = {id(n) for n in node.body if isinstance(n, ast.Assert)}
            found = []
            for item in asserts:
                check = _assert_check(item, name, arg_names, constants) if id(item) in direct and in_sheet else None
                if check is not None:
                    found.append(check)
            if len(found) != len(asserts) and node.name not in not_in_sheet:
                not_in_sheet.append(node.name)
            for index, check in enumerate(found, start=1):
                checks.append({"test": node.name, "index": index, **check})
    payload = json.dumps({"checks": checks, "not_in_sheet": not_in_sheet}, sort_keys=True)
    return {"checks": checks, "not_in_sheet": not_in_sheet, "digest": hashlib.sha256(payload.encode()).hexdigest()}


def current(document, now):
    """True when the stored workbook was built for the hand checks the test file holds now.

    A sidecar from before hand checks existed counts as current only while there is nothing to show.
    """
    stored = (document or {}).get("hand_checks")
    if stored is None:
        return not now["checks"] and not now["not_in_sheet"]
    return stored.get("digest") == now["digest"]
