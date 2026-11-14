"""Translate a tile's Python expression into one Excel formula, and count which branches it takes.

The tile body (after inlining simple local assignments) is turned into a small
expression tree, which is then rendered as an Excel formula template and can also
be evaluated with NumPy to count, month by month, which alternative of every
`IF`/`MIN`/`MAX` was taken.

In a template, `{name}` marks a row quantity (in a step tile, this month's cell;
in a summary tile, the whole row range or, for another summary tile, its cell)
and a bare identifier is a parameter, which is a defined name in the workbook.

Functions are looked up in two registries so later phases can add more
(`tk.irr` and `tk.npv` from `tilekit.functions` are registered here too):
`PYTHON_FUNCTIONS` maps a dotted Python name (`np.minimum`) to a builder that turns
the call's arguments into tree nodes, and `EXCEL_FUNCTIONS` says how a node renders
and evaluates. Use `register_python` and `register_excel`.
"""

import ast
import math
from dataclasses import dataclass, field, replace

import numpy as np

from tilekit import functions as tk_functions

TRANSLATOR_VERSION = "tilekit-translate 3"

TOLERANCE_ABS = 1e-9  # default absolute tolerance of a difference check

# A comparison whose two sides differ by no more than this, relative to the larger, is a near-tie:
# Excel works to about 15 significant digits, so it may take the other branch.
NEAR_TIE_REL = 1e-12

NUMPY_ALIASES = ("np", "numpy")


class Untranslatable(Exception):
    """The tile cannot be written as one classic Excel formula; the message says why."""


# ---------------------------------------------------------------- expression tree

@dataclass(frozen=True)
class Num:
    value: float


@dataclass(frozen=True)
class Ref:
    name: str
    kind: str  # "row" (this month's cell), "series" (whole row range), "scalar" (one cell) or "param"


@dataclass(frozen=True)
class Bin:
    op: str  # + - * / ^
    left: object
    right: object


@dataclass(frozen=True)
class Neg:
    operand: object


@dataclass(frozen=True)
class Cmp:
    op: str  # = <> < <= > >=
    left: object
    right: object


@dataclass(frozen=True)
class Call:
    func: str  # key in EXCEL_FUNCTIONS
    args: tuple
    branch: int | None = None  # index of this node among the tile's branch nodes


def children(node):
    if isinstance(node, Bin | Cmp):
        return (node.left, node.right)
    if isinstance(node, Neg):
        return (node.operand,)
    if isinstance(node, Call):
        return node.args
    return ()


# ---------------------------------------------------------------- registries

@dataclass(frozen=True)
class ExcelFunction:
    """How a Call node renders and evaluates.

    `render(arg_texts) -> str` defaults to `NAME(a,b,...)`. `evaluate(*values)` works on
    NumPy arrays. `branch` is a kind ("if", "min", "max", "clip") whose alternatives are
    listed in BRANCH_ALTERNATIVES, or None. `tolerance` is the absolute tolerance the
    difference check needs for a formula using this function (None: the default), for
    functions like IRR that Excel solves iteratively. `series_args` are the positions of
    arguments that may be whole time series in a summary tile.
    """
    name: str
    evaluate: object
    branch: str | None = None
    render: object = None
    tolerance: float | None = None
    series_args: tuple = ()


BRANCH_ALTERNATIVES = {
    "if": ("true", "false"),
    "min": ("first", "second"),
    "max": ("first", "second"),
    "clip": ("low", "middle", "high"),
}

EXCEL_FUNCTIONS = {}
PYTHON_FUNCTIONS = {}


def register_excel(key, function):
    EXCEL_FUNCTIONS[key] = function


def register_python(name, builder):
    """`builder(args, kwargs, context) -> node`; `args` and `kwargs` are already-built nodes."""
    PYTHON_FUNCTIONS[name] = builder


def simple(key, arity):
    """A builder for a Python function that maps one-to-one onto Excel function `key`."""
    def build(args, kwargs, context):
        if kwargs:
            raise Untranslatable(f"keyword arguments are not supported here: {sorted(kwargs)}")
        if len(args) != arity:
            raise Untranslatable(f"{EXCEL_FUNCTIONS[key].name} needs {arity} argument(s), got {len(args)}")
        return Call(key, tuple(args))
    return build


def _summary_only(name):
    def check(context):
        if context.timing != "summary":
            raise Untranslatable(f"{name} is only translated in summary tiles")
    return check


register_excel("IF", ExcelFunction("IF", lambda c, a, b: np.where(c, a, b), branch="if"))
register_excel("MIN", ExcelFunction("MIN", np.minimum, branch="min"))
register_excel("MAX", ExcelFunction("MAX", np.maximum, branch="max"))
register_excel("CLIP", ExcelFunction(
    "CLIP", np.clip, branch="clip",
    render=lambda a: f"MIN(MAX({a[0]},{a[1]}),{a[2]})"))
register_excel("ABS", ExcelFunction("ABS", np.abs))
register_excel("EXP", ExcelFunction("EXP", np.exp))
register_excel("LN", ExcelFunction("LN", np.log))
register_excel("SQRT", ExcelFunction("SQRT", np.sqrt))
register_excel("ROUND", ExcelFunction("ROUND", tk_functions.round_half_away))
register_excel("AND", ExcelFunction("AND", np.logical_and))
register_excel("OR", ExcelFunction("OR", np.logical_or))
register_excel("NOT", ExcelFunction("NOT", np.logical_not))
register_excel("SUM", ExcelFunction("SUM", lambda x: np.sum(x, axis=0), series_args=(0,)))
register_excel("SUMPRODUCT", ExcelFunction("SUMPRODUCT", lambda *xs: np.sum(np.prod(np.stack(xs), axis=0), axis=0),
                                           series_args=tuple(range(255))))
register_excel("IRR", ExcelFunction("IRR", tk_functions.irr, tolerance=1e-7, series_args=(0,)))
register_excel("NPV", ExcelFunction("NPV", tk_functions.npv, series_args=(1,)))

for _name, _key, _arity in [
    ("where", "IF", 3), ("minimum", "MIN", 2), ("maximum", "MAX", 2), ("clip", "CLIP", 3),
    ("abs", "ABS", 1), ("absolute", "ABS", 1), ("exp", "EXP", 1), ("log", "LN", 1), ("sqrt", "SQRT", 1),
    ("logical_and", "AND", 2), ("logical_or", "OR", 2), ("logical_not", "NOT", 1),
]:
    for _alias in NUMPY_ALIASES:
        register_python(f"{_alias}.{_name}", simple(_key, _arity))


def _build_round(args, kwargs, context):
    if kwargs or len(args) != 2:
        raise Untranslatable("tk.round_half_away takes exactly two arguments, the value and the number of digits")
    return Call("ROUND", (args[0], args[1]))


def _product_factors(node):
    if isinstance(node, Bin) and node.op == "*":
        return _product_factors(node.left) + _product_factors(node.right)
    return [node]


def _build_sum(args, kwargs, context):
    _summary_only("np.sum")(context)
    axis = kwargs.pop("axis", None)
    if kwargs:
        raise Untranslatable(f"np.sum: unsupported keyword arguments {sorted(kwargs)}")
    if axis is None:
        raise Untranslatable("sum over time needs axis=0")
    if axis != Num(0):
        raise Untranslatable("np.sum is only translated over time (axis=0)")
    if len(args) != 1:
        raise Untranslatable("np.sum needs exactly one argument")
    factors = _product_factors(args[0])
    if not all(isinstance(f, Ref) and f.kind == "series" for f in factors):
        raise Untranslatable("np.sum is only translated for one time series or a product of time series")
    if len(factors) == 1:
        return Call("SUM", tuple(factors))
    return Call("SUMPRODUCT", tuple(factors))


def _build_irr(args, kwargs, context):
    _summary_only("tk.irr")(context)
    if kwargs or len(args) != 1:
        raise Untranslatable("tk.irr takes exactly one argument, the cash flow series")
    if not (isinstance(args[0], Ref) and args[0].kind == "series"):
        raise Untranslatable("tk.irr is only translated for one time series argument")
    return Call("IRR", (args[0],))


def _build_npv(args, kwargs, context):
    _summary_only("tk.npv")(context)
    if kwargs or len(args) != 2:
        raise Untranslatable("tk.npv takes exactly two arguments, the rate and the cash flow series")
    rate, cashflows = args
    if not (isinstance(cashflows, Ref) and cashflows.kind == "series"):
        raise Untranslatable("tk.npv is only translated for one time series of cash flows")
    if any(isinstance(r, Ref) and r.kind == "series" for r in _walk(rate)):
        raise Untranslatable("the rate of tk.npv must not be a time series")
    return Call("NPV", (rate, cashflows))


TK_ALIAS = "tk"
register_python(f"{TK_ALIAS}.irr", _build_irr)
register_python(f"{TK_ALIAS}.npv", _build_npv)
register_python(f"{TK_ALIAS}.round_half_away", _build_round)

for _alias in NUMPY_ALIASES:
    register_python(f"{_alias}.sum", _build_sum)


def allowed_calls():
    """The dotted names a tile may call: every registered `np.*` and `tk.*` function, sorted."""
    return sorted(n for n in PYTHON_FUNCTIONS if n.startswith(("np.", f"{TK_ALIAS}.")))


# ---------------------------------------------------------------- AST -> tree

BIN_OPS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Pow: "^"}
CMP_OPS = {ast.Eq: "=", ast.NotEq: "<>", ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">="}


@dataclass
class Context:
    kinds: dict  # argument name -> "row" | "series" | "scalar" | "param"
    timing: str
    locals: dict = field(default_factory=dict)


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _build(node, context):
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise Untranslatable(f"unsupported constant {value!r}")
        if not math.isfinite(value):
            raise Untranslatable(f"constant {value!r} has no Excel equivalent")
        return Num(float(value))
    if isinstance(node, ast.Name):
        if node.id in context.locals:
            return context.locals[node.id]
        if node.id in context.kinds:
            return Ref(node.id, context.kinds[node.id])
        raise Untranslatable(f"'{node.id}' is not an argument of the tile")
    if isinstance(node, ast.BinOp):
        op = BIN_OPS.get(type(node.op))
        if op is None:
            raise Untranslatable(f"operator {type(node.op).__name__} is not supported")
        return Bin(op, _build(node.left, context), _build(node.right, context))
    if isinstance(node, ast.UnaryOp):
        operand = _build(node.operand, context)
        if isinstance(node.op, ast.USub):
            return Neg(operand)
        if isinstance(node.op, ast.UAdd):
            return operand
        if isinstance(node.op, ast.Not):
            return Call("NOT", (operand,))
        raise Untranslatable(f"operator {type(node.op).__name__} is not supported")
    if isinstance(node, ast.Compare):
        terms = [_build(node.left, context), *(_build(c, context) for c in node.comparators)]
        parts = []
        for op, left, right in zip(node.ops, terms, terms[1:]):
            symbol = CMP_OPS.get(type(op))
            if symbol is None:
                raise Untranslatable(f"comparison {type(op).__name__} is not supported")
            parts.append(Cmp(symbol, left, right))
        return parts[0] if len(parts) == 1 else Call("AND", tuple(parts))
    if isinstance(node, ast.Call):
        name = _dotted(node.func)
        builder = PYTHON_FUNCTIONS.get(name)
        if builder is None:
            raise Untranslatable(f"function {name or ast.unparse(node.func)} has no Excel translation")
        if any(isinstance(a, ast.Starred) for a in node.args) or any(k.arg is None for k in node.keywords):
            raise Untranslatable("*args and **kwargs are not supported")
        args = [_build(a, context) for a in node.args]
        kwargs = {k.arg: _build(k.value, context) for k in node.keywords}
        return builder(args, kwargs, context)
    raise Untranslatable(f"{type(node).__name__} expressions are not supported")


def _number_branches(node, counter):
    """Give every branching Call a number, outer and left first."""
    if isinstance(node, Call):
        branch = None
        if EXCEL_FUNCTIONS[node.func].branch:
            branch = counter[0]
            counter[0] += 1
        args = tuple(_number_branches(a, counter) for a in node.args)
        return replace(node, args=args, branch=branch)
    if isinstance(node, Bin | Cmp):
        return replace(node, left=_number_branches(node.left, counter), right=_number_branches(node.right, counter))
    if isinstance(node, Neg):
        return Neg(_number_branches(node.operand, counter))
    return node


def _branch_kinds(node, out):
    if isinstance(node, Call) and node.branch is not None:
        out.append(EXCEL_FUNCTIONS[node.func].branch)
    for child in children(node):
        _branch_kinds(child, out)
    return out


def branch_labels_for(kind, index, several):
    prefix = f"{kind} {index + 1}" if several else kind
    return [f"{prefix}: {alt}" for alt in BRANCH_ALTERNATIVES[kind]]


def _check_summary(node):
    if isinstance(node, Ref) and node.kind == "series":
        raise Untranslatable(f"summary tile uses time series '{node.name}' outside np.sum, tk.irr or tk.npv")
    if isinstance(node, Call):
        allowed = EXCEL_FUNCTIONS[node.func].series_args
        for index, child in enumerate(node.args):
            if index not in allowed:
                _check_summary(child)
        return
    for child in children(node):
        _check_summary(child)


# ---------------------------------------------------------------- rendering

PREC_CMP, PREC_ADD, PREC_MUL, PREC_POW, PREC_NEG, PREC_ATOM = 1, 2, 3, 4, 5, 6
BIN_PREC = {"+": PREC_ADD, "-": PREC_ADD, "*": PREC_MUL, "/": PREC_MUL, "^": PREC_POW}


def format_number(value):
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return repr(value).upper()  # Excel writes exponents as 1E-10


def _render(node):
    """(text, precedence) of a node, with only the parentheses Excel needs to keep Python's grouping."""
    if isinstance(node, Num):
        text = format_number(node.value)
        return text, PREC_ATOM
    if isinstance(node, Ref):
        return (node.name if node.kind == "param" else "{" + node.name + "}"), PREC_ATOM
    if isinstance(node, Neg):
        text, prec = _render(node.operand)
        if prec < PREC_ATOM:
            text = f"({text})"
        return "-" + text, PREC_NEG
    if isinstance(node, Bin):
        prec = BIN_PREC[node.op]
        left, left_prec = _render(node.left)
        right, right_prec = _render(node.right)
        # Excel's negation binds tighter than ^, so keep (-a)^b explicit
        if left_prec < prec or (node.op == "^" and isinstance(node.left, Neg)):
            left = f"({left})"
        # Excel is left-associative everywhere (including ^): a right operand of equal
        # precedence keeps its parentheses, and so does a negative right operand
        if right_prec <= prec or isinstance(node.right, Neg):
            right = f"({right})"
        return f"{left}{node.op}{right}", prec
    if isinstance(node, Cmp):
        left, left_prec = _render(node.left)
        right, right_prec = _render(node.right)
        if left_prec <= PREC_CMP:
            left = f"({left})"
        if right_prec <= PREC_CMP:
            right = f"({right})"
        return f"{left}{node.op}{right}", PREC_CMP
    if isinstance(node, Call):
        function = EXCEL_FUNCTIONS[node.func]
        args = [_render(a)[0] for a in node.args]
        if function.render:
            return function.render(args), PREC_ATOM
        return f"{function.name}({','.join(args)})", PREC_ATOM
    raise TypeError(node)


def render(node):
    return "=" + _render(node)[0]


# ---------------------------------------------------------------- translation

@dataclass(frozen=True)
class Translation:
    tile: str
    translatable: bool
    formula: str | None  # the template, starting with "="
    reason: str | None  # why not translatable
    branches: tuple[str, ...]  # branch labels in order
    expr: object = None  # the expression tree (None when not translatable)
    refs: tuple[str, ...] = ()  # row quantities the formula uses ({name})
    params: tuple[str, ...] = ()  # parameters the formula uses
    tolerance: float = TOLERANCE_ABS  # absolute tolerance of its difference check


def formula_tolerance(node):
    """The loosest tolerance any function in the tree needs (the default when none does)."""
    found = [EXCEL_FUNCTIONS[n.func].tolerance for n in _walk(node) if isinstance(n, Call)]
    return max([TOLERANCE_ABS, *(t for t in found if t is not None)])


def _collect_refs(node, kinds_wanted, out):
    if isinstance(node, Ref) and (node.kind == "param") == (kinds_wanted == "param"):
        if node.name not in out:
            out.append(node.name)
    for child in children(node):
        _collect_refs(child, kinds_wanted, out)
    return out


def translate_function(node, kinds, timing="step"):
    """Translate an `ast.FunctionDef`; `kinds` maps each argument to row/series/scalar/param."""
    context = Context(kinds=dict(kinds), timing=timing)
    name = node.name
    try:
        body = list(node.body)
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                and isinstance(body[0].value.value, str):
            body = body[1:]
        if not body or not isinstance(body[-1], ast.Return) or body[-1].value is None:
            raise Untranslatable("the body does not end with `return <expression>`")
        for statement in body[:-1]:
            if not (isinstance(statement, ast.Assign) and len(statement.targets) == 1
                    and isinstance(statement.targets[0], ast.Name)):
                raise Untranslatable(f"line {statement.lineno}: only simple `name = expression` assignments can be inlined")
            context.locals[statement.targets[0].id] = _build(statement.value, context)
        expr = _build(body[-1].value, context)
        if timing == "summary":
            _check_summary(expr)
        elif any(isinstance(r, Ref) and r.kind in ("series",) for r in _walk(expr)):
            raise Untranslatable("step tile reads a whole time series")
        expr = _number_branches(expr, [0])
        kinds_found = _branch_kinds(expr, [])
        labels = []
        for index, kind in enumerate(kinds_found):
            labels += branch_labels_for(kind, index, len(kinds_found) > 1)
        return Translation(
            tile=name, translatable=True, formula=render(expr), reason=None, branches=tuple(labels),
            expr=expr, refs=tuple(_collect_refs(expr, "row", [])), params=tuple(_collect_refs(expr, "param", [])),
            tolerance=formula_tolerance(expr),
        )
    except Untranslatable as exc:
        return Translation(tile=name, translatable=False, formula=None, reason=str(exc), branches=())


def _walk(node):
    yield node
    for child in children(node):
        yield from _walk(child)


def argument_kinds(tile, graph):
    """How each argument of a tile appears in its formula."""
    timing = graph.timings[tile.name]
    kinds = {}
    for arg in tile.args:
        kind = graph.kinds[arg]
        if kind == "param":
            kinds[arg] = "param"
        elif timing == "summary":
            is_scalar = kind == "tile" and graph.timings[arg] == "summary"
            kinds[arg] = "scalar" if is_scalar else "series"
        else:
            kinds[arg] = "row"
    return kinds


def translate(tile, graph):
    """Translate one tile of a built graph."""
    timing = graph.timings[tile.name]
    return translate_function(tile.node, argument_kinds(tile, graph), timing)


def translate_source(source, kinds, timing="step"):
    """Translate the first function in a source string (for tests and tools)."""
    tree = ast.parse(source)
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef))
    return translate_function(node, kinds, timing)


def model_translations(model):
    """{tile name: Translation} for every tile, cached on the model."""
    cache = model.__dict__.get("_translations")
    if cache is None:
        graph = model.graph
        cache = {name: translate(graph.tiles[name], graph) for name in graph.order}
        model.__dict__["_translations"] = cache
    return cache


# ---------------------------------------------------------------- evaluation and branches

def evaluate(node, env):
    """Evaluate a tree with NumPy; `env` maps names to arrays (time on axis 0) or scalars."""
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Ref):
        return env[node.name]
    if isinstance(node, Neg):
        return -evaluate(node.operand, env)
    if isinstance(node, Bin):
        left, right = evaluate(node.left, env), evaluate(node.right, env)
        if node.op == "^":
            return np.power(left, right)
        return {"+": np.add, "-": np.subtract, "*": np.multiply, "/": np.divide}[node.op](left, right)
    if isinstance(node, Cmp):
        left, right = evaluate(node.left, env), evaluate(node.right, env)
        return {"=": np.equal, "<>": np.not_equal, "<": np.less, "<=": np.less_equal,
                ">": np.greater, ">=": np.greater_equal}[node.op](left, right)
    if isinstance(node, Call):
        return EXCEL_FUNCTIONS[node.func].evaluate(*(evaluate(a, env) for a in node.args))
    raise TypeError(node)


def _count(node, env, mask, counts, labels):
    if isinstance(node, Call) and node.branch is not None:
        kind = EXCEL_FUNCTIONS[node.func].branch
        values = [evaluate(a, env) for a in node.args]
        if kind == "if":
            cond = np.asarray(values[0], dtype=bool)
            taken = [cond, ~cond]
            arg_masks = [mask, mask & cond, mask & ~cond]
        elif kind in ("min", "max"):
            a, b = np.asarray(values[0]), np.asarray(values[1])
            first = a <= b if kind == "min" else a >= b
            taken = [first, ~first]
            arg_masks = [mask, mask]
        else:  # clip
            x, low, high = (np.asarray(v) for v in values)
            is_low = x <= low
            is_middle = ~is_low & (x <= high)
            taken = [is_low, is_middle, ~is_low & ~is_middle]
            arg_masks = [mask, mask, mask]
        for label, alternative in zip(labels[node.branch], taken):
            counts[label] += int(np.sum(np.logical_and(mask, alternative)))
        for arg, arg_mask in zip(node.args, arg_masks):
            _count(arg, env, arg_mask, counts, labels)
        return
    for child in children(node):
        _count(child, env, mask, counts, labels)


def count_branches(translation, env, months=None):
    """{branch label: number of months that alternative was taken}; ties go to the first alternative.

    `env` maps the tile's arguments to their traced values (arrays over months for row
    quantities, scalars for parameters). A branch nested inside one arm of an IF is only
    counted in the months that arm was reached. In a summary tile each branch counts once.
    """
    if not translation.translatable or not translation.branches:
        return {}
    labels = []
    kinds = _branch_kinds(translation.expr, [])
    for index, kind in enumerate(kinds):
        labels.append(branch_labels_for(kind, index, len(kinds) > 1))
    counts = {label: 0 for label in translation.branches}
    mask = np.ones(months, dtype=bool) if months is not None else np.array(True)
    with np.errstate(all="ignore"):
        _count(translation.expr, env, mask, counts, labels)
    return counts


def _tie_mask(left, right, exact_counts):
    """Elementwise: the two sides are within rounding of each other (and, unless `exact_counts`, not equal)."""
    a, b = np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)
    with np.errstate(all="ignore"):
        close = np.abs(a - b) <= NEAR_TIE_REL * np.maximum(np.abs(a), np.abs(b))
        if exact_counts:  # = and <>: exact equality of non-integers is a tie too; integers compare exactly in Excel
            integers = (a == np.floor(a)) & (b == np.floor(b))
            return close & ~integers
        return close & (a != b)


def _ties(node, env, mask, out):
    """Append (comparison text, mask of months with a near-tie) for every comparison reached under `mask`."""
    if isinstance(node, Cmp):
        left, right = evaluate(node.left, env), evaluate(node.right, env)
        out.append((_render(node)[0], mask & _tie_mask(left, right, node.op in ("=", "<>"))))
    if isinstance(node, Call) and node.branch is not None:
        kind = EXCEL_FUNCTIONS[node.func].branch
        values = [evaluate(a, env) for a in node.args]
        text = _render(node)[0]
        if kind in ("min", "max"):
            out.append((text, mask & _tie_mask(values[0], values[1], False)))
        elif kind == "clip":
            out.append((text, mask & (_tie_mask(values[0], values[1], False) | _tie_mask(values[0], values[2], False))))
        if kind == "if":
            cond = np.asarray(values[0], dtype=bool)
            _ties(node.args[0], env, mask, out)
            _ties(node.args[1], env, mask & cond, out)
            _ties(node.args[2], env, mask & ~cond, out)
            return
    for child in children(node):
        _ties(child, env, mask, out)


def near_ties(translation, env, months=None):
    """[{"comparison", "month"}] for every comparison within rounding of a tie (month is 1-based; None in a summary tile).

    `env` and `months` are as for `count_branches`. Only comparisons that are actually reached count.
    """
    if not translation.translatable:
        return []
    found = []
    mask = np.ones(months, dtype=bool) if months is not None else np.array(True)
    with np.errstate(all="ignore"):
        _ties(translation.expr, env, mask, found)
    out = []
    for text, hit in found:
        hit = np.broadcast_to(np.asarray(hit, dtype=bool), mask.shape)
        if months is None:
            if bool(hit):
                out.append({"comparison": text, "month": None})
        else:
            out += [{"comparison": text, "month": int(k) + 1} for k in np.flatnonzero(hit)]
    out.sort(key=lambda t: (t["month"] or 0, t["comparison"]))
    return out


def tile_env(tile, graph, params, results, case_months):
    """Values of a tile's arguments for one case (scenario 0, policy 0), shaped for `count_branches`."""
    env = {}
    summary = set(graph.summary_order())
    for arg in tile.args:
        if graph.kinds[arg] == "param":
            env[arg] = float(getattr(params, arg))
        elif arg in summary:
            env[arg] = float(results[arg][0, 0])
        else:
            env[arg] = np.asarray(results[arg][:, 0, 0], dtype=np.float64)
    months = None if graph.timings[tile.name] == "summary" else case_months
    return env, months
