import pytest

from tilekit import load_model
from tilekit.checks import checks_json, run_checks

DOC = '''"""Bad thing.

    Spec.

    Format: amount
    """'''


def tile(signature, *body):
    """Module source with one tile `bad`: docstring, then the given body lines."""
    lines = "\n".join(f"    {line}" for line in body)
    return f"import numpy as np\n\n\ndef {signature}:\n    {DOC}\n{lines}\n"


BAD_TILES = {
    "args-resolve": tile("bad(x, nowhere)", "return x"),
    "signature/*args": tile("bad(x, *rest)", "return x"),
    "signature/**kwargs": tile("bad(x, **extra)", "return x"),
    "signature/default": tile("bad(x, cap=0)", "return x"),
    "literals": tile("bad(x)", "return x * 2.5"),
    "names": "LIMIT = 1\n\n\n" + tile("bad(x)", "return x * LIMIT"),
    "numpy-calls-only": tile("bad(x)", "return max(x, 0)"),
    "numpy-calls-only/method": tile("bad(x)", "return x.sum()"),
    "loops/for": tile("bad(x)", "total = 0", "for v in x:", "    total = total + v", "return total"),
    "loops/comprehension": tile("bad(x)", "return np.array([v for v in x])"),
    "no-if/statement": tile("bad(x)", "if x:", "    return x", "return x"),
    "no-if/expression": tile("bad(x)", "return x if x else 0"),
    "no-mutation/subscript": tile("bad(x)", "x[0] = 0", "return x"),
    "no-mutation/augmented": tile("bad(x)", "x += 1", "return x"),
    "no-mutation/attribute": tile("bad(x)", "x.flags = 0", "return x"),
    "body-shape/no-return": tile("bad(x)", "y = x"),
    "body-shape/expression-statement": tile("bad(x)", "np.sum(x)", "return x"),
    "docstring/missing": "import numpy as np\n\n\ndef bad(x):\n    return x\n",
    "docstring/no-format": 'def bad(x):\n    """Bad thing.\n\n    Spec.\n    """\n    return x\n',
    "docstring/bad-format": 'def bad(x):\n    """Bad thing.\n\n    Format: money\n    """\n    return x\n',
    "imports": "import math\n" + tile("bad(x)", "return x"),
    "imports/from": "from numpy import minimum\n" + tile("bad(x)", "return x"),
}

EXPECTED_RULE = {key: key.split("/")[0] for key in BAD_TILES}
EXPECTED_RULE["loops/for"] = "no-loops"
EXPECTED_RULE["loops/comprehension"] = "no-loops"


def violations_for(make_model, modules, states=None):
    model = load_model(make_model(modules, states={} if states is None else states))
    return run_checks(model)


@pytest.mark.parametrize("key", sorted(BAD_TILES))
def test_rule_fires(make_model, key):
    found = violations_for(make_model, {"m": {"source": BAD_TILES[key], "layer": "A"}})
    rule = EXPECTED_RULE[key]
    hits = [v for v in found if v["rule"] == rule and v["tile"] == "bad"]
    assert hits, f"expected rule {rule}, got {found}"
    assert all(v["severity"] == "error" for v in hits)
    assert all(set(v) == {"tile", "module", "rule", "message", "line", "severity"} for v in found)


def test_calling_another_tile(make_model):
    source = tile("good(x)", "return x") + "\n\n" + tile("bad(x)", "return good(x)")
    found = violations_for(make_model, {"m": {"source": source, "layer": "A"}})
    assert [v["rule"] for v in found if v["tile"] == "bad"] == ["no-tile-calls"]
    assert not [v for v in found if v["tile"] == "good"]


def test_naming_warnings(make_model):
    rate = 'def growth(x):\n    """Growth.\n\n    Format: rate\n    """\n    return x\n'
    balance = 'def balance(x):\n    """Balance.\n\n    Timing: end of month\n    Format: amount\n    """\n    return x\n'
    opening = 'def opening(x):\n    """Opening.\n\n    Timing: beginning of month\n    Format: amount\n    """\n    return x\n'
    found = violations_for(make_model, {"m": {"source": "\n\n".join([rate, balance, opening]), "layer": "A"}})
    assert {(v["tile"], v["rule"], v["severity"]) for v in found} == {
        ("growth", "naming", "warning"), ("balance", "naming", "warning"), ("opening", "naming", "warning")}


def test_layer_rule(make_model):
    left = tile("bad(right_value)", "return right_value")
    right = tile("right_value(x)", "return x")
    found = violations_for(make_model, {"left": {"source": left, "layer": "A"},
                                        "right": {"source": right, "layer": "B"}})
    assert [(v["tile"], v["rule"]) for v in found] == [("bad", "layers")]


def test_duplicate_and_cycle_reported(make_model):
    first = tile("bad(other)", "return other")
    second = tile("other(bad)", "return bad")
    found = violations_for(make_model, {"m": {"source": first + "\n\n" + second, "layer": "A"}})
    assert {(v["tile"], v["rule"]) for v in found} == {("bad", "no-cycle"), ("other", "no-cycle")}

    dup = tile("bad(x)", "return x")
    found = violations_for(make_model, {"m1": {"source": dup, "layer": "A"}, "m2": {"source": dup, "layer": "A"}})
    assert [v["rule"] for v in found] == ["unique-name", "unique-name"]


def test_clean_model_has_no_violations(make_model):
    model = load_model(make_model())
    assert checks_json(model) == {"violations": [], "counts": {"error": 0, "warning": 0}}


def test_local_assignments_and_negation_are_fine(make_model):
    source = tile("bad(x, cap)", "y = -x", "z = np.maximum(y, 0)", "return np.minimum(z, cap)")
    assert violations_for(make_model, {"m": {"source": source, "layer": "A"}}) == []
