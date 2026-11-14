"""Regression tests for the tile rules that keep the Excel formula equal to the Python.

C1 (only registered numpy and tk functions; no text constants), C3 (decorators, module-level code,
globals, nested functions, defaults), C4 (sums over time need axis=0), C5 (no np.round), M1 (== and !=
between non-integers), M2 (no in-place mutation), and the engine's read-only arrays.
"""

import json

import numpy as np
import pytest

from tilekit import load_model
from tilekit.checks import run_checks
from tilekit.engine import project
from tilekit.translate import allowed_calls

from conftest import GOOD_STEP, GOOD_SUMMARY

DOC = '''"""Bad thing.

    Spec.

    Format: amount
    """'''


def tile(signature, *body, decorators=()):
    lines = "\n".join(f"    {line}" for line in body)
    deco = "".join(f"{d}\n" for d in decorators)
    return f"import numpy as np\n\n\n{deco}def {signature}:\n    {DOC}\n{lines}\n"


def violations(make_model, source, timing="step", states=None):
    module = {"source": source, "layer": "A"}
    if timing == "summary":
        module["timing"] = "summary"
    model = load_model(make_model({"m": module}, states={} if states is None else states))
    return run_checks(model)


def rules_for(found, name="bad"):
    return {(v["rule"], v["severity"]) for v in found if v["tile"] == name}


# ---------------------------------------------------------------- C1: allowed calls and text constants

@pytest.mark.parametrize("call", ["np.loadtxt(x)", "np.cumsum(x)", "np.round(x)", "np.around(x, 1)",
                                  "np.random.rand()", "np.copyto(x, x)", "np.put(x, 0, x)", "np.place(x, x, x)",
                                  "np.putmask(x, x, x)", "np.fill_diagonal(x, 0)", "np.frompyfunc(x, 1, 1)"])
def test_only_registered_numpy_functions_may_be_called(make_model, call):
    found = violations(make_model, tile("bad(x)", f"return {call}"))
    hits = [v for v in found if v["rule"] == "numpy-calls-only"]
    assert hits and all(v["severity"] == "error" for v in hits)
    assert "np.minimum" in hits[0]["message"] and "tk.irr" in hits[0]["message"]  # names the allowed list


def test_allowed_list_is_the_translators_registry():
    allowed = allowed_calls()
    assert "np.minimum" in allowed and "np.sum" in allowed and "tk.round_half_away" in allowed
    assert "np.round" not in allowed and "np.around" not in allowed and "np.cumsum" not in allowed


@pytest.mark.parametrize("expr", ["x * len('ab')", "x if 'a' else x", "np.where(x > 0, x, b'0')",
                                  "np.minimum(x, f'{x}')"])
def test_text_constants_are_rule_errors(make_model, expr):
    found = violations(make_model, tile("bad(x)", f"return {expr}"))
    assert ("literals", "error") in rules_for(found)


def test_m2_file_read_by_a_tile_is_refused(make_model):
    """The reviewer's m2: a tile reading a file through np.loadtxt and a path string."""
    found = violations(make_model, tile("bad(x)", "return x * np.loadtxt('/tmp/factor.txt')"))
    assert {"numpy-calls-only", "literals"} <= {r for r, _ in rules_for(found)}


# ---------------------------------------------------------------- C3: decorators, module-level code

def test_decorator_on_a_tile_is_an_error(make_model):
    found = violations(make_model, tile("bad(x)", "return x", decorators=["@(lambda f: f)"]))
    assert ("decorators", "error") in rules_for(found)


def test_module_level_code_is_an_error(make_model):
    source = tile("bad(x)", "return x") + "\n\nbad.__code__ = (lambda x: x + 1).__code__\n"
    found = violations(make_model, source)
    assert ("module-level", "error") in rules_for(found)
    source = 'X = 1\n' + tile("bad(x)", "return x")
    assert ("module-level", "error") in rules_for(violations(make_model, source))


def test_allowed_module_level_forms(make_model):
    source = ('"""Module docstring."""\n\nfrom __future__ import annotations\n\nimport numpy as np\n\n'
              'from tilekit import functions as tk\n\n\n' + tile("good(x)", "return tk.round_half_away(x, 1)")
              .replace("import numpy as np\n", "").replace("Bad thing", "Good thing"))
    assert violations(make_model, source) == []


def test_import_numpy_needs_the_np_alias(make_model):
    source = tile("bad(x)", "return x").replace("import numpy as np", "import numpy")
    assert ("imports", "error") in rules_for(violations(make_model, source))


def test_private_helper_decorator_and_defaults_are_module_level_errors(make_model):
    source = tile("bad(x)", "return x") + "\n\n@print\ndef _helper(a=print('import time')):\n    return a\n"
    found = [v for v in violations(make_model, source) if v["rule"] == "module-level"]
    assert len(found) == 2


@pytest.mark.parametrize("body, rule", [
    (["global y", "return x"], "no-globals"),
    (["def inner(v):", "    return v", "return x"], "no-nested-functions"),
    (["f = lambda v: v", "return x"], "no-nested-functions"),
])
def test_globals_and_nested_functions(make_model, body, rule):
    assert (rule, "error") in rules_for(violations(make_model, tile("bad(x)", *body)))


def test_default_argument_values_are_errors(make_model):
    found = violations(make_model, tile("bad(x, cap=1)", "return x"))
    assert ("signature", "error") in rules_for(found)


def test_module_code_is_in_each_tiles_code_stamp(make_model):
    from tilekit.stamps import tile_stamp
    root = make_model()
    before = tile_stamp(load_model(root), "doubled")
    path = next((root / "src").glob("*/step_mod.py"))
    path.write_text(path.read_text() + "\n\ndoubled.__code__ = balance_eop.__code__\n")
    after = tile_stamp(load_model(root), "doubled")
    assert after["code"] != before["code"] and after["spec"] == before["spec"]
    # the module docstring is documentation, not code
    path.write_text('"""A docstring."""\n' + GOOD_STEP)
    assert tile_stamp(load_model(root), "doubled")["code"] == before["code"]


# ---------------------------------------------------------------- C4: sums over time

def test_bare_sum_in_a_summary_tile_is_a_rule_error(make_model):
    source = GOOD_SUMMARY.replace("np.sum(doubled, axis=0)", "np.sum(doubled)")
    model = load_model(make_model({"step_mod": {"source": GOOD_STEP, "layer": "A"},
                                   "summary_mod": {"source": source, "layer": "B", "timing": "summary"}}))
    found = [v for v in run_checks(model) if v["tile"] == "total_doubled"]
    assert [(v["rule"], v["message"]) for v in found] == [("sum-axis", "sum over time needs axis=0")]
    from tilekit.translate import model_translations
    assert not model_translations(model)["total_doubled"].translatable


def test_sum_in_a_step_tile_is_a_rule_error(make_model):
    found = violations(make_model, tile("bad(x)", "return np.sum(x, axis=0)"))
    assert ("sum-axis", "error") in rules_for(found)


def test_bare_sum_mixes_policies(make_model):
    """Why C4 matters: without axis=0 the sum runs over every policy too."""
    source = GOOD_SUMMARY.replace("np.sum(doubled, axis=0)", "np.sum(doubled)")
    model = load_model(make_model({"step_mod": {"source": GOOD_STEP, "layer": "A"},
                                   "summary_mod": {"source": source, "layer": "B", "timing": "summary"}}))
    results = project(model, {"size": np.array([1.0, 2.0])}, model.default_params(), 6)
    assert results["total_doubled"][0, 0] == results["total_doubled"][0, 1]  # both policies get the grand total


# ---------------------------------------------------------------- M1: equality between non-integers

def test_equality_between_non_integers_is_a_warning(make_model):
    found = violations(make_model, tile("bad(x, growth_pm)", "return np.where(x == growth_pm, x, 0)"))
    assert ("comparisons", "warning") in rules_for(found)
    found = violations(make_model, tile("bad(x)", "return np.where(x != 1, x, 0)"))
    assert ("comparisons", "warning") in rules_for(found)  # x is an amount, not a whole number


# ---------------------------------------------------------------- M2: no in-place mutation

@pytest.mark.parametrize("expr", ["np.subtract(x, x, out=x)", "np.minimum(x, 0, out=x)"])
def test_out_keyword_is_an_error(make_model, expr):
    assert ("no-mutation", "error") in rules_for(violations(make_model, tile("bad(x)", f"return {expr}")))


@pytest.mark.parametrize("call", ["x.sort()", "x.fill(0)", "x.resize(1)", "x.itemset(0, 1)", "x.copy()"])
def test_method_calls_on_arguments_are_errors(make_model, call):
    found = violations(make_model, tile("bad(x)", f"y = {call}", "return x"))
    assert ("numpy-calls-only", "error") in rules_for(found)


def test_engine_passes_read_only_arrays(make_model):
    """The reviewer's m7: `np.subtract(a, b, out=a)` would rewrite an earlier tile's output in place."""
    source = GOOD_STEP.replace("return np.minimum(grown + doubled, cap)",
                               "return np.subtract(doubled, doubled, out=doubled)")
    model = load_model(make_model({"step_mod": {"source": source, "layer": "A"}}))
    with pytest.raises(ValueError, match="read-only"):
        project(model, {"size": np.array([1.0])}, model.default_params(), 3)


def test_engine_state_and_inputs_are_read_only(make_model):
    source = GOOD_STEP.replace("return x + x", "return np.add(x, 0, out=x)")
    model = load_model(make_model({"step_mod": {"source": source, "layer": "A"}}))
    with pytest.raises(ValueError, match="read-only"):
        project(model, {"size": np.array([1.0])}, model.default_params(), 3)


# ---------------------------------------------------------------- minor: Excel names

def test_names_differing_only_by_case_are_a_graph_error(make_model):
    from tilekit.errors import TilekitError
    source = GOOD_STEP + '''

def Doubled(x):
    """Doubled again.

    Format: amount
    """
    return x
'''
    model = load_model(make_model({"step_mod": {"source": source, "layer": "A"}}))
    with pytest.raises(TilekitError, match="differ only by case"):
        model.graph


@pytest.mark.parametrize("name, expected", [("true", "true_"), ("FALSE", "FALSE_"), ("sum", "sum_"), ("If", "If_"),
                                            ("min", "min_"), ("max", "max_"), ("and", "and_"), ("or", "or_"),
                                            ("not", "not_"), ("irr", "irr_"), ("npv", "npv_"), ("index", "index_"),
                                            ("match", "match_"), ("round", "round_"), ("int", "int_"),
                                            ("A1", "A1_"), ("growth_pm", "growth_pm"), ("summary", "summary")])
def test_excel_names(name, expected):
    from tilekit.workbook import excel_name
    assert excel_name(name) == expected


def test_check_is_json_with_the_new_rules(make_model, capsys):
    from tilekit.cli import main
    root = make_model({"m": {"source": tile("bad(x)", "return np.cumsum(x, axis=0)"), "layer": "A"}}, states={})
    assert main(["check", "--model", str(root)]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["counts"]["error"] >= 1
