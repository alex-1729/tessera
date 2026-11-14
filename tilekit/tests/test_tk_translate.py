import numpy as np
import pytest

from tilekit.translate import (EXCEL_FUNCTIONS, PYTHON_FUNCTIONS, ExcelFunction, count_branches, evaluate,
                               register_excel, register_python, simple, translate_source)

ROWS = {"a": "row", "b": "row", "c": "row", "k": "param", "j": "param"}


def tr(expr, kinds=ROWS, timing="step", body=""):
    args = ", ".join(kinds)
    source = f"import numpy as np\n\ndef t({args}):\n    \"\"\"Doc.\"\"\"\n{body}    return {expr}\n"
    return translate_source(source, kinds, timing)


def formula(expr, **kw):
    result = tr(expr, **kw)
    assert result.translatable, result.reason
    return result.formula


@pytest.mark.parametrize("expr, expected", [
    ("a + b", "={a}+{b}"),
    ("a - b", "={a}-{b}"),
    ("a * k", "={a}*k"),
    ("a / b", "={a}/{b}"),
    ("a ** 2", "={a}^2"),
    ("-a", "=-{a}"),
    ("+a", "={a}"),
    ("0.5 * a", "=0.5*{a}"),
    ("1e-10 + a", "=1E-10+{a}"),
    ("2.0 * a", "=2*{a}"),
    ("a > b", "={a}>{b}"),
    ("a == b", "={a}={b}"),
    ("a != b", "={a}<>{b}"),
    ("a <= k", "={a}<=k"),
    ("np.where(a > 0, b, c)", "=IF({a}>0,{b},{c})"),
    ("np.minimum(a * k, j)", "=MIN({a}*k,j)"),
    ("np.maximum(a, 0)", "=MAX({a},0)"),
    ("np.clip(a, 0, k)", "=MIN(MAX({a},0),k)"),
    ("np.abs(a)", "=ABS({a})"),
    ("np.exp(a)", "=EXP({a})"),
    ("np.log(a)", "=LN({a})"),
    ("np.sqrt(a)", "=SQRT({a})"),
    ("tk.round_half_away(a, 0)", "=ROUND({a},0)"),
    ("tk.round_half_away(a, k)", "=ROUND({a},k)"),
    ("np.logical_and(a > 0, b > 0)", "=AND({a}>0,{b}>0)"),
    ("np.logical_or(a > 0, b > 0)", "=OR({a}>0,{b}>0)"),
    ("np.logical_not(a > 0)", "=NOT({a}>0)"),
    ("0 < a < k", "=AND(0<{a},{a}<k)"),
])
def test_constructs(expr, expected):
    assert formula(expr) == expected


@pytest.mark.parametrize("expr, expected", [
    ("a + b * c", "={a}+{b}*{c}"),
    ("(a + b) * c", "=({a}+{b})*{c}"),
    ("a - (b - c)", "={a}-({b}-{c})"),
    ("(a - b) - c", "={a}-{b}-{c}"),
    ("a - (b + c)", "={a}-({b}+{c})"),
    ("a + (b + c)", "={a}+({b}+{c})"),  # keeps Python's grouping (floating point)
    ("a / (b * c)", "={a}/({b}*{c})"),
    ("a / b * c", "={a}/{b}*{c}"),
    ("a * (b / c)", "={a}*({b}/{c})"),
    ("-a ** 2", "=-({a}^2)"),  # Python: -(a**2); Excel's -a^2 would be (-a)^2
    ("(-a) ** 2", "=(-{a})^2"),
    ("a ** b ** c", "={a}^({b}^{c})"),  # Python's ** is right-associative, Excel's ^ is not
    ("(a ** b) ** c", "={a}^{b}^{c}"),
    ("a - -b", "={a}-(-{b})"),
    ("-(a + b)", "=-({a}+{b})"),
    ("-a * b", "=-{a}*{b}"),
    ("(a > b) * c", "=({a}>{b})*{c}"),
    ("(1 + k) ** (1 / 12)", "=(1+k)^(1/12)"),
    ("np.minimum(a + b, (c - a) * k)", "=MIN({a}+{b},({c}-{a})*k)"),
])
def test_precedence_and_parentheses(expr, expected):
    assert formula(expr) == expected


@pytest.mark.parametrize("expr", [
    "a + b * c", "(a + b) * c", "a - (b - c)", "-a ** 2", "(-a) ** 2", "a ** b ** c", "(a ** b) ** c",
    "a / (b * c)", "a - -b", "-(a + b) / c",
])
def test_rendering_matches_python_semantics(expr):
    """Evaluate the rendered formula with Excel's rules and compare with Python."""
    values = {"a": 1.7, "b": 2.3, "c": 0.9, "k": 3.0, "j": 2.0}
    result = tr(expr)
    excel = _excel_eval(result.formula[1:].replace("{", "").replace("}", ""), values)
    assert excel == pytest.approx(eval(expr, {}, values), rel=1e-12)


def _excel_eval(text, values):
    """A minimal Excel-semantics evaluator for + - * / ^ and unary minus (negation binds tightest, ^ left-assoc)."""
    import re
    tokens = re.findall(r"\d+\.?\d*(?:E-?\d+)?|[A-Za-z_]\w*|[-+*/^()]", text)
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def take():
        nonlocal pos
        pos += 1
        return tokens[pos - 1]

    def atom():
        tok = take()
        if tok == "-":
            return -atom()
        if tok == "(":
            value = add()
            take()
            return value
        return values[tok] if tok in values else float(tok)

    def power():
        value = atom()
        while peek() == "^":
            take()
            value = value ** atom()
        return value

    def mul():
        value = power()
        while peek() in ("*", "/"):
            op = take()
            value = value * power() if op == "*" else value / power()
        return value

    def add():
        value = mul()
        while peek() in ("+", "-"):
            op = take()
            value = value + mul() if op == "+" else value - mul()
        return value

    return add()


def test_inlined_locals():
    body = "    grown = a * (1 + k)\n    capped = np.minimum(grown + b, j)\n"
    assert formula("capped - grown", body=body) == "=MIN({a}*(1+k)+{b},j)-{a}*(1+k)"


def test_untranslatable_tiles_give_a_reason():
    cases = {
        "np.cumsum(a)": "np.cumsum",
        "a % b": "Mod",
        "a // b": "FloorDiv",
        "[a, b]": "List",
        "a.sum()": "a.sum",
        "zzz + a": "'zzz' is not an argument",
        "np.sum(a)": "only translated in summary tiles",
        "np.round(a)": "np.round has no Excel translation",
        "np.around(a, 2)": "np.around has no Excel translation",
        "a if a > 0 else b": "IfExp",
    }
    for expr, reason in cases.items():
        result = tr(expr)
        assert not result.translatable and result.formula is None and result.branches == ()
        assert reason in result.reason, (expr, result.reason)
    result = tr("a", body="    for i in range(2):\n        pass\n")
    assert not result.translatable and "assignments" in result.reason


def test_summary_sum_and_sumproduct():
    kinds = {"x": "series", "y": "series", "z": "series", "s": "scalar", "k": "param"}
    assert formula("np.sum(x, axis=0)", kinds=kinds, timing="summary") == "=SUM({x})"
    assert formula("np.sum(x * y, axis=0)", kinds=kinds, timing="summary") == "=SUMPRODUCT({x},{y})"
    bare = tr("np.sum(x)", kinds=kinds, timing="summary")  # would sum over policies too
    assert not bare.translatable and bare.reason == "sum over time needs axis=0"
    assert not tr("np.sum(x, axis=1)", kinds=kinds, timing="summary").translatable
    assert formula("np.sum(x * y * z, axis=0) * k + s", kinds=kinds, timing="summary") == \
        "=SUMPRODUCT({x},{y},{z})*k+{s}"
    assert not tr("np.sum(x * k, axis=0)", kinds=kinds, timing="summary").translatable
    assert not tr("np.sum(x + y, axis=0)", kinds=kinds, timing="summary").translatable
    outside = tr("x * k", kinds=kinds, timing="summary")
    assert not outside.translatable and "outside np.sum" in outside.reason


def test_branch_labels():
    assert tr("np.minimum(a, b)").branches == ("min: first", "min: second")
    assert tr("np.where(a > 0, a, b)").branches == ("if: true", "if: false")
    assert tr("np.clip(a, 0, k)").branches == ("clip: low", "clip: middle", "clip: high")
    assert tr("np.where(a > 0, np.maximum(a, b), np.minimum(b, c))").branches == (
        "if 1: true", "if 1: false", "max 2: first", "max 2: second", "min 3: first", "min 3: second")
    assert tr("a + b").branches == ()


def test_branch_counting():
    a = np.array([1.0, 5.0, 2.0, 2.0, -1.0])
    b = np.array([2.0, 2.0, 2.0, 1.0, 0.0])
    counts = count_branches(tr("np.minimum(a, b)"), {"a": a, "b": b}, months=5)
    assert counts == {"min: first": 3, "min: second": 2}  # tie in month 3 goes to the first

    counts = count_branches(tr("np.maximum(a, k)"), {"a": a, "k": 1.5}, months=5)
    assert counts == {"max: first": 3, "max: second": 2}

    nested = tr("np.where(a > 0, np.minimum(a, b), b)")
    counts = count_branches(nested, {"a": a, "b": b}, months=5)
    # month 5 takes the false arm, so the min is only reached in months 1-4
    assert counts == {"if 1: true": 4, "if 1: false": 1, "min 2: first": 2, "min 2: second": 2}

    counts = count_branches(tr("np.clip(a, 0, k)"), {"a": a, "k": 2.0}, months=5)
    assert counts == {"clip: low": 1, "clip: middle": 3, "clip: high": 1}

    counts = count_branches(tr("np.where(k > 0, a, b)"), {"a": a, "b": b, "k": 1.0}, months=5)
    assert counts == {"if: true": 5, "if: false": 0}


def test_evaluate_matches_numpy():
    a, b = np.array([0.5, 2.0, 3.0]), np.array([1.0, 1.0, 4.0])
    result = tr("np.minimum(a * k, b) + np.where(a > 1, np.sqrt(a), -b) ** 2")
    env = {"a": a, "b": b, "k": 2.0}
    expected = np.minimum(a * 2.0, b) + np.where(a > 1, np.sqrt(a), -b) ** 2
    assert np.allclose(evaluate(result.expr, env), expected)


def test_registry_is_extensible():
    register_excel("TESTPOW", ExcelFunction("POWER", np.power))
    register_python("np.float_power", simple("TESTPOW", 2))
    try:
        assert formula("np.float_power(a, k)") == "=POWER({a},k)"
    finally:
        EXCEL_FUNCTIONS.pop("TESTPOW")
        PYTHON_FUNCTIONS.pop("np.float_power")


def test_real_model_formulas(make_model):
    from tilekit import load_model
    from tilekit.translate import model_translations
    model = load_model(make_model())
    translations = model_translations(model)
    assert translations["doubled"].formula == "={x}+{x}"
    assert translations["balance_eop"].formula == "=MIN({balance_bop}*(1+growth_pm)+{doubled},cap)"
    assert translations["balance_eop"].params == ("growth_pm", "cap")
    assert translations["total_doubled"].formula == "=SUM({doubled})"
