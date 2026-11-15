"""Module checks (reconciliations): an arithmetic expression over a module's step quantities that must be zero.

A check is declared in `tilekit.toml` under its module:

    [[module.check]]
    name = "units_reconcile"
    label = "Units roll-forward reconciles"
    expression = "units_bop - deaths_units - lapses_units - units_eop"
    # tolerance = 1e-9

The expression may use names, numbers, `+ - * /`, unary minus and parentheses, nothing else. It is parsed with
`ast` and never evaluated as Python code: `evaluate` walks the tree itself. The module sheet shows each check as a
real Excel formula (`excel_template`) over the sheet's own rows and names, and the build evaluates the same tree on
each case's Python results. A check passes when |value| <= tolerance in every month of every case, in both.
"""

import ast
import math

import numpy as np

from tilekit.errors import TilekitError

_BINARY = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/"}
_PRECEDENCE = {ast.Add: 1, ast.Sub: 1, ast.Mult: 2, ast.Div: 2}
_UNARY = {ast.USub: "-", ast.UAdd: "+"}


def parse_expression(text, what="check"):
    """The expression's AST (an `ast.Expression` body), refused unless it is plain arithmetic on names and numbers."""
    try:
        tree = ast.parse(text.strip(), mode="eval")
    except SyntaxError as exc:
        raise TilekitError(f"tilekit.toml: the expression of {what} is not valid: {exc.msg}", {"expression": text})
    _validate(tree.body, text, what)
    return tree.body


def _validate(node, text, what):
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        _validate(node.left, text, what)
        _validate(node.right, text, what)
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        _validate(node.operand, text, what)
    elif isinstance(node, ast.Name):
        pass
    elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        if not math.isfinite(node.value):
            raise TilekitError(f"tilekit.toml: the expression of {what} has a number that is not finite",
                               {"expression": text})
    else:
        raise TilekitError(f"tilekit.toml: the expression of {what} may only use names, numbers, + - * / and "
                           f"parentheses; '{ast.unparse(node)}' is not allowed", {"expression": text})


def names(node):
    """The names an expression reads, in first-use order."""
    found = sorted((n for n in ast.walk(node) if isinstance(n, ast.Name)), key=lambda n: (n.lineno, n.col_offset))
    return list(dict.fromkeys(n.id for n in found))


def _number(value):
    if isinstance(value, int) or float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(float(value)).replace("e", "E")


def excel_template(node, row_names):
    """An Excel formula template: a row quantity is `{name}` (filled with a cell, or a per-policy constant's defined
    name, by the layout); any other name (a parameter) is written bare, as tile formulas write parameters."""
    def render(item, parent=None, right=False):
        if isinstance(item, ast.Name):
            return "{" + item.id + "}" if item.id in row_names else item.id
        if isinstance(item, ast.Constant):
            return _number(item.value)
        if isinstance(item, ast.UnaryOp):
            inner = render(item.operand, item)
            if isinstance(item.operand, ast.BinOp):
                inner = f"({inner})"
            text = _UNARY[type(item.op)] + inner
            return f"({text})" if isinstance(parent, ast.BinOp) and right else text
        op = type(item.op)
        text = f"{render(item.left, item)}{_BINARY[op]}{render(item.right, item, True)}"
        if isinstance(parent, ast.BinOp):
            outer = _PRECEDENCE[type(parent.op)]
            if _PRECEDENCE[op] < outer or (right and _PRECEDENCE[op] == outer):
                return f"({text})"
        return text
    return "=" + render(node)


def evaluate(node, value_of):
    """The expression's value, with `value_of(name)` giving each name's value (a number or a NumPy array)."""
    with np.errstate(all="ignore"):
        return _evaluate(node, value_of)


def _evaluate(node, value_of):
    if isinstance(node, ast.Name):
        return np.asarray(value_of(node.id), dtype=np.float64)
    if isinstance(node, ast.Constant):
        return np.float64(node.value)
    if isinstance(node, ast.UnaryOp):
        value = _evaluate(node.operand, value_of)
        return -value if isinstance(node.op, ast.USub) else value
    left, right = _evaluate(node.left, value_of), _evaluate(node.right, value_of)
    op = type(node.op)
    if op is ast.Add:
        return left + right
    if op is ast.Sub:
        return left - right
    if op is ast.Mult:
        return left * right
    return np.divide(left, right)


def largest(values):
    """The largest |value|, or None when any value is not finite (NaN or infinite never passes a check)."""
    flat = np.ravel(np.asarray(values, dtype=np.float64))
    if flat.size and not np.all(np.isfinite(flat)):
        return None
    return float(np.max(np.abs(flat))) if flat.size else 0.0
