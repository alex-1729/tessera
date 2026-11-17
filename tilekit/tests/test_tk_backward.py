"""Backward modules: tiles worked out from the last month to the first, with states that hold next month's value."""

import json

import numpy as np
import pytest

from tilekit import TilekitError, load_model
from tilekit.cli import main
from tilekit.engine import initial_state, project
from tilekit.xlsxread import Xlsx

from conftest import GOOD_STEP, GOOD_SUMMARY

BACKWARD = '''
import numpy as np


def value_now(doubled, value_next, growth_pm):
    """Value now.

    The greater of this month's doubled x and next month's value discounted a month.

    Timing: end of month
    Format: amount
    """
    return np.maximum(doubled, value_next / (1 + growth_pm))


def value_margin(value_now, balance_eop):
    """Value over balance.

    The value less the closing balance.

    Format: amount
    """
    return value_now - balance_eop
'''

SUMMARY = GOOD_SUMMARY + '''

def total_value(value_now):
    """Total value.

    Sum of the value over all months.

    Format: amount
    """
    return np.sum(value_now, axis=0)
'''

MODULES = {
    "step_mod": {"source": GOOD_STEP, "layer": "A"},
    "back_mod": {"source": BACKWARD, "layer": "A", "timing": "backward"},
    "summary_mod": {"source": SUMMARY, "layer": "B", "timing": "summary"},
}
STATES = {
    "balance_bop": {"from": "balance_eop", "initial": 0.0, "label": "Opening balance", "format": "amount"},
    "value_next": {"from": "value_now", "initial": 3.0, "label": "Value next month", "format": "amount"},
}


def run(capsys, *argv):
    code = main(list(argv))
    return code, json.loads(capsys.readouterr().out)


def test_backward_pass_values(make_model):
    model = load_model(make_model(modules=MODULES, states=STATES))
    assert model.graph.backward_states == {"value_next"}
    assert model.graph.backward_order() == ["value_now", "value_margin"]
    assert "value_now" not in model.graph.step_order() and "value_now" in model.graph.monthly_order()
    assert set(initial_state(model, 1)) == {"balance_bop"}  # the forward step knows nothing of backward states

    results = project(model, {"size": np.array([1.0, 2.0])}, model.default_params(), 6)
    for name in ["value_now", "value_next", "value_margin"]:
        assert results[name].shape == (6, 1, 2)

    # by hand, last month first: x_t = t, doubled = 2t, value_t = max(2t, value_{t+1} / 1.01), value_7 = 3
    nxt, want = 3.0, {}
    for t in range(6, 0, -1):
        want[t] = max(2.0 * t, nxt / 1.01)
        nxt = want[t]
    np.testing.assert_allclose(results["value_now"][:, 0, 0], [want[t] for t in range(1, 7)], rtol=0, atol=1e-12)
    # the state holds next month's value; in the last month, its initial
    np.testing.assert_allclose(results["value_next"][:-1], results["value_now"][1:])
    assert results["value_next"][-1, 0, 0] == 3.0
    # a backward tile reads this month's forward values, and a summary tile reads the backward series
    np.testing.assert_allclose(results["value_margin"], results["value_now"] - results["balance_eop"])
    np.testing.assert_allclose(results["total_value"], results["value_now"].sum(axis=0))


def test_backward_value_decays_from_a_large_terminal_value(make_model):
    states = {**STATES, "value_next": {**STATES["value_next"], "initial": 1000.0}}
    model = load_model(make_model(modules=MODULES, states=states))
    results = project(model, {"size": np.array([1.0])}, model.default_params(), 6)
    np.testing.assert_allclose(results["value_now"][:, 0, 0], [1000.0 / 1.01 ** k for k in range(6, 0, -1)], rtol=1e-12)


STEP_READS_BACKWARD = GOOD_STEP + '''

def uses_value(value_now):
    """Uses the value.

    The value as it is.

    Format: amount
    """
    return value_now + 0
'''

STEP_READS_BACKWARD_STATE = GOOD_STEP + '''

def uses_next(value_next):
    """Uses next month's value.

    The value as it is.

    Format: amount
    """
    return value_next + 0
'''


@pytest.mark.parametrize("source, word", [(STEP_READS_BACKWARD, "value_now"), (STEP_READS_BACKWARD_STATE, "value_next")])
def test_a_step_tile_cannot_read_backward_quantities(make_model, source, word):
    modules = {**MODULES, "step_mod": {"source": source, "layer": "A"}}
    with pytest.raises(TilekitError, match=f"reads backward quantities.*{word}"):
        load_model(make_model(modules=modules, states=STATES)).graph


def test_backward_workbooks_agree_with_python(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, states=STATES)
    code, doc = run(capsys, "build", "--model", str(root))
    assert code == 0, doc
    built = {(b["kind"], b["name"]): b for b in doc["built"]}
    for key in [("tile", "value_now"), ("tile", "value_margin"), ("module", "back_mod"), ("model", "Temp")]:
        assert built[key]["checks_pass"] and built[key]["max_abs_difference"] < 1e-9, built[key]

    # module sheet: the state's row reads the next month's column of its source, and the last month is the typed value
    cells = Xlsx(root / "review/modules/back_mod/workbook.xlsx").cells("One")
    row = next(int(ref[1:]) for ref, c in cells.items() if c["value"] == "value_next")
    src = next(int(ref[1:]) for ref, c in cells.items() if c["value"] == "value_now" and int(ref[1:]) != row)
    assert cells[f"C{row}"]["formula"] == f"D{src}" and cells[f"G{row}"]["formula"] == f"H{src}"
    assert not cells[f"H{row}"]["formula"] and cells[f"H{row}"]["value"] == 3

    code, graph = run(capsys, "graph", "--model", str(root))
    assert graph["quantities"]["value_next"]["backward"] is True and "backward" not in graph["quantities"]["balance_bop"]
    assert next(m for m in graph["modules"] if m["id"] == "back_mod")["timing"] == "backward"
    code, trace = run(capsys, "trace", "--model", str(root), "--case", "one")
    assert len(trace["series"]["value_now"]) == 6 and trace["series"]["value_next"][-1] == 3.0
    code, check = run(capsys, "check", "--model", str(root))
    assert check["counts"]["error"] == 0, check
