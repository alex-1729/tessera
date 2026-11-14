"""Financial functions (tk.irr, tk.npv), assumption tables and `excel` input templates.

The workbook tests need gridcraft-cli and are skipped without it.
"""

import json
import math

import numpy as np
import pytest

from tilekit import functions as tk
from tilekit import load_model
from tilekit.checks import run_checks
from tilekit.cli import main
from tilekit.errors import TilekitError
from tilekit.stamps import params_digest
from tilekit.translate import translate_source
from tilekit.workbook import compare
from tilekit.xlsxread import Xlsx

# ---------------------------------------------------------------- functions


def test_irr_matches_textbook_values():
    assert tk.irr(np.array([-100.0, 10, 10, 10, 110])) == pytest.approx(0.1, abs=1e-14)
    v = (-60 + math.sqrt(27600)) / 120  # -100 + 60 v + 60 v^2 = 0
    assert tk.irr(np.array([-100.0, 60, 60])) == pytest.approx(1 / v - 1, abs=1e-14)
    assert tk.irr(np.array([-100.0, 50, 40])) < 0  # a negative IRR


def test_irr_is_nan_without_a_sign_change():
    assert math.isnan(tk.irr(np.array([1.0, 2.0, 3.0])))
    assert math.isnan(tk.irr(np.array([-1.0, -2.0, 0.0])))
    assert math.isnan(tk.irr(np.zeros(4)))


def test_irr_is_vectorised_over_trailing_axes():
    rng = np.random.default_rng(7)
    flows = rng.normal(1.0, 1.0, (120, 1, 200))
    flows[0] -= 60
    flows[:, 0, 5] = 1.0  # no sign change
    rates = tk.irr(flows)
    assert rates.shape == (1, 200)
    assert math.isnan(rates[0, 5])
    for i in range(200):
        if i == 5:
            continue
        assert rates[0, i] == pytest.approx(tk.irr(flows[:, 0, i]), abs=1e-15)
        value = np.sum(flows[:, 0, i] / (1 + rates[0, i]) ** np.arange(120))
        assert abs(value) < 1e-9


def test_npv_discounts_the_first_flow_one_period():
    assert tk.npv(0.1, np.array([-100.0, 60, 60])) == pytest.approx(-100 / 1.1 + 60 / 1.21 + 60 / 1.331, abs=1e-12)
    flows = np.array([[1.0, 2.0], [1.0, 2.0]])
    np.testing.assert_allclose(tk.npv(np.array([0.0, 1.0]), flows), [2.0, 2 / 2 + 2 / 4])


# ---------------------------------------------------------------- translation and checks

def test_tk_functions_translate_with_their_own_tolerance():
    irr = translate_source("def f(flow):\n    return tk.irr(flow)\n", {"flow": "series"}, "summary")
    assert irr.translatable and irr.formula == "=IRR({flow})" and irr.tolerance == 1e-7
    npv = translate_source("def f(rate_pm, flow):\n    return tk.npv(rate_pm * 2, flow)\n",
                           {"rate_pm": "param", "flow": "series"}, "summary")
    assert npv.formula == "=NPV(rate_pm*2,{flow})" and npv.tolerance == 1e-9
    mixed = translate_source("def f(flow, total, g):\n    return (1 + tk.irr(flow)) * total + g\n",
                             {"flow": "series", "total": "scalar", "g": "param"}, "summary")
    assert mixed.formula == "=(1+IRR({flow}))*{total}+g"


@pytest.mark.parametrize("source, kinds, timing", [
    ("def f(flow):\n    return tk.irr(flow)\n", {"flow": "row"}, "step"),  # summary tiles only
    ("def f(a, b):\n    return tk.irr(a * b)\n", {"a": "series", "b": "series"}, "summary"),  # one range
    ("def f(r, flow):\n    return tk.npv(r, flow)\n", {"r": "series", "flow": "series"}, "summary"),
    ("def f(flow):\n    return tk.irr(flow) + flow\n", {"flow": "series"}, "summary"),  # series outside
])
def test_tk_functions_untranslatable(source, kinds, timing):
    assert not translate_source(source, kinds, timing).translatable


def test_compare_lets_excel_errors_agree_with_nan_and_infinity():
    assert compare([{"error": "#NUM!"}, {"error": "#DIV/0!"}, 1.0], [math.nan, -math.inf, 1.0])[1]
    assert not compare([{"error": "#NUM!"}], [1.0])[1]
    assert not compare([0.0], [math.nan])[1]
    assert compare([1.0 + 5e-8], [1.0], tolerance=1e-7)[1] and not compare([1.0 + 5e-8], [1.0])[1]


# ---------------------------------------------------------------- a model with a table and excel inputs

INPUTS_SOURCE = '''
import numpy as np


def build_inputs(model_points, params, months):
    size = np.asarray(model_points["size"], dtype=np.float64)
    month = np.arange(1, months + 1, dtype=np.float64).reshape(months, 1, 1)
    keys = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    vals = np.array([1.0, 0.0, 0.0, 0.0, 0.5, 0.0])
    looked_up = vals[np.searchsorted(keys, month)]
    shape = (months, 1, size.shape[0])
    series = {"x": month * size, "key": month, "looked_up": looked_up, "scaled": looked_up * params.cap}
    return {k: np.broadcast_to(v, shape).astype(np.float64) for k, v in series.items()}
'''

FLOW = '''
def flow(x, scaled):
    """Flow.

    x less the scaled lookup.

    Format: amount
    """
    return x - scaled
'''

RESULTS = '''
import numpy as np

from tilekit import functions as tk


def total(flow):
    """Total flow.

    Format: amount
    """
    return np.sum(flow, axis=0)


def rate_pm(flow):
    """IRR.

    Format: rate
    """
    return tk.irr(flow)


def npv_flow(growth_pm, flow):
    """NPV.

    Format: amount
    """
    return tk.npv(growth_pm, flow)


def mixed(rate_pm, total, flow, growth_pm):
    """Mixed summary.

    A summary tile reading another summary, a series and a parameter.

    Format: number
    """
    return (1 + rate_pm) * total + np.sum(flow * flow, axis=0) * growth_pm
'''

TABLE_TOML = '''
[table.rates]
file = "assumptions/rates.csv"
label = "Rate table"

[input.key]
label = "Key"
format = "integer"

[input.scaled]
label = "Scaled"
format = "amount"
excel = "={looked_up}*cap"

[input.looked_up]
label = "Looked up"
format = "number"
excel = "=INDEX({table:rates.val},MATCH({key},{table:rates.key},0))"
'''

CASES = {
    "one": {"id": "one", "name": "One", "purpose": "Size one: flows -49, 2, .., 6 and a negative IRR.",
            "model_point": {"size": 1.0}},
    "big": {"id": "big", "name": "Big", "purpose": "Size twenty: a positive IRR.", "model_point": {"size": 20.0}},
    "flat": {"id": "flat", "name": "Flat", "purpose": "Cap zero: no outflow, no IRR.", "model_point": {"size": 1.0},
             "params": {"cap": 0.0}},
}


@pytest.fixture
def table_model(make_model):
    def make(extra_toml=TABLE_TOML, csv_text="key,val\n1,1\n2,0\n3,0\n4,0\n5,0.5\n6,0\n"):
        root = make_model(modules={"step": {"source": FLOW, "layer": "A"},
                                   "results": {"source": RESULTS, "layer": "B", "timing": "summary"}},
                          states={}, cases=CASES)
        package = next((root / "src").iterdir()).name
        (root / "src" / package / "inputs.py").write_text(INPUTS_SOURCE)
        (root / "assumptions").mkdir()
        (root / "assumptions" / "rates.csv").write_text(csv_text)
        with (root / "tilekit.toml").open("a") as handle:
            handle.write(extra_toml)
        return root
    return make


def test_tables_and_excel_templates_load(table_model):
    model = load_model(table_model())
    table = model.config.table("rates")
    assert table.columns == ("key", "val") and table.column("val")[4] == 0.5
    assert model.config.excel_input_order() == ["looked_up", "scaled"]  # dependencies first
    assert run_checks(model) == []


@pytest.mark.parametrize("excel, message", [
    ("={nope}*cap", "not an input"),
    ("=INDEX({table:other.val},1)", "unknown table"),
    ("=INDEX({table:rates.nope},1)", "unknown column"),
    ("={key}*not_a_param", "not parameters"),
    ("={looked_up}*cap", "cycle"),  # with looked_up reading scaled
    ("1+1", "starting with '='"),
])
def test_bad_templates_are_clear_errors(table_model, excel, message):
    toml = TABLE_TOML.replace('excel = "={looked_up}*cap"', f'excel = "{excel}"')
    if message == "cycle":
        toml = toml.replace("MATCH({key}", "MATCH({scaled}")
    with pytest.raises(TilekitError, match=message):
        load_model(table_model(extra_toml=toml))


def test_a_table_change_changes_the_params_stamp(table_model):
    before = params_digest(load_model(table_model()))
    after = params_digest(load_model(table_model(csv_text="key,val\n1,1\n2,0\n3,0\n4,0\n5,0.25\n6,0\n")))
    assert before != after


def test_tk_import_is_the_only_extra_import_allowed(make_model):
    source = RESULTS.replace("from tilekit import functions as tk", "from tilekit import functions as tk\nimport os")
    root = make_model(modules={"step": {"source": FLOW.replace("x - scaled", "x"), "layer": "A"},
                               "results": {"source": source.replace("tk.npv(", "tk.pmt("), "layer": "B",
                                           "timing": "summary"}}, states={})
    pkg = next((root / "src").iterdir())
    (pkg / "step.py").write_text((pkg / "step.py").read_text().replace("def flow(x, scaled)", "def flow(x)"))
    violations = run_checks(load_model(root))
    rules = {(v["tile"], v["rule"]) for v in violations}
    assert ("total", "imports") in rules  # import os
    assert any(v["rule"] == "numpy-calls-only" and "tk.pmt" in v["message"] for v in violations)
    assert not any(v["rule"] == "imports" and "tilekit" in v["message"] for v in violations)
    assert not any(v["rule"] == "names" for v in violations)


def run(capsys, *argv):
    code = main(list(argv))
    return code, json.loads(capsys.readouterr().out)


def test_build_with_tables_excel_inputs_and_irr(table_model, gridcraft_cli, capsys):
    root = table_model()
    code, doc = run(capsys, "build", "--model", str(root))
    assert code == 0, doc
    for item in doc["built"]:
        assert item["checks_pass"], item
    # the summary tile reading a summary, a series and a parameter works at every level
    for path in ["tiles/mixed", "modules/results", "model"]:
        sidecar = json.loads((root / "review" / path / "workbook.json").read_text())
        assert sidecar["checks_pass"], path
    irr = json.loads((root / "review/tiles/rate_pm/workbook.json").read_text())
    assert irr["formula"] == "=IRR({flow})" and irr["tolerance"] == 1e-7
    assert irr["cases"]["flat"]["checks_pass"]  # NaN in Python, #NUM! in Excel
    model = json.loads((root / "review/model/workbook.json").read_text())
    assert model["sheets"] == ["Inputs", "Assumptions", "Step", "Results", "Scratch"]
    assert list(model["inputs"]) == ["looked_up", "scaled"]
    assert all(v["checks_pass"] for v in model["inputs"].values())
    assert model["tiles"]["rate_pm"]["checks_pass"]

    book = Xlsx(root / "review/model/workbook.xlsx")
    inputs = book.cells("Inputs")
    labels = {c["value"]: ref[1:] for ref, c in inputs.items() if ref.startswith("B")}
    key, looked, scaled = labels["Key"], labels["Looked up"], labels["Scaled"]
    assert inputs[f"C{key}"]["formula"] is None
    assert inputs[f"D{looked}"]["formula"] == f"INDEX(Assumptions!$C$7:$C$12,MATCH(D{key},Assumptions!$B$7:$B$12,0))"
    assert inputs[f"E{looked}"]["value"] == 0.0 and inputs[f"G{looked}"]["value"] == 0.5
    assert inputs[f"C{scaled}"]["formula"] == f"C{looked}*cap"
    assert "Python Looked up" in labels and "Difference" in labels
    table = book.cells("Assumptions")
    assert (table["B5"]["value"], table["B6"]["value"], table["C11"]["value"]) == ("Rate table", "key", 0.5)
    # tile and module workbooks keep inputs as pasted values
    tile = Xlsx(root / "review/tiles/flow/workbook.xlsx")
    assert "Assumptions" not in tile.sheets
    assert not any(c["formula"] and "INDEX" in c["formula"] for c in tile.cells("One").values())
