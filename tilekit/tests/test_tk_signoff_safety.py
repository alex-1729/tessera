"""Regression tests: a sign-off never survives a change it should not survive.

C6 (new-case leniency), M3 (default_case), M4 (workbooks edited outside a build), M5 (non-finite values
in expected.json), M1 (near-ties), reconfirm against the signed formula, and C2 (inputs code and data in
the stamp).
"""

import json
import sys

import pytest

from tilekit import load_model
from tilekit.cli import main
from tilekit.gridcraft import GridCraft
from tilekit.review import check_expected, expected_path, tile_stamp
from tilekit.stamps import model_stamp, tile_stamp as stamp_of

from test_tk_review import (BRANCHY, CASES, MODULES, edit, pass_tile_tests, rebuild, run, run_tests, sign, sign_all,
                            status, write_tile_tests)


@pytest.fixture
def built(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    write_tile_tests(root)
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    run_tests(capsys, root)
    return root


def add_case(root, case_id, size, **extra):
    (root / "cases" / f"{case_id}.json").write_text(json.dumps(
        {"id": case_id, "name": case_id.title(), "purpose": "x", "model_point": {"size": size}, **extra}))


# ---------------------------------------------------------------- C6

def test_new_case_leniency_needs_a_current_workbook(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    add_case(built, "three", 3.0)
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "stale" and t["drift"] == "values" and not t["can_sign_off"]
    rebuild(capsys, built)
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["new_cases"] == ["three"]


def test_new_case_leniency_needs_every_check_to_pass(built, capsys):
    sign_all(capsys, built)
    add_case(built, "three", 3.0)
    rebuild(capsys, built)
    for kind, name in (("tiles", "doubled"), ("modules", "first")):
        path = built / f"review/{kind}/{name}/workbook.json"
        doc = json.loads(path.read_text())
        doc["checks_pass"] = False
        doc["cases"]["three"]["checks_pass"] = False
        path.write_text(json.dumps(doc))
    s = status(capsys, built)
    assert s["tiles"]["doubled"]["state"] == "stale" and s["tiles"]["doubled"]["drift"] == "formula"
    assert s["modules"]["first"]["state"] == "stale" and s["modules"]["first"]["drift"] == "formula"
    assert s["tiles"]["balance_eop"]["state"] == "signed_off"


def test_model_leniency_needs_a_current_workbook(built, capsys):
    sign_all(capsys, built)
    code, doc = sign(capsys, built, "--whole-model")
    assert code == 0, doc
    add_case(built, "three", 3.0)
    assert status(capsys, built)["model"]["state"] == "stale"
    rebuild(capsys, built)
    assert status(capsys, built)["model"]["state"] == "signed_off"


# ---------------------------------------------------------------- M3

def test_default_case_change_makes_the_model_workbook_stale(built, capsys):
    sign_all(capsys, built)
    assert sign(capsys, built, "--whole-model")[0] == 0
    toml = built / "tilekit.toml"
    toml.write_text(toml.read_text().replace('name = "Temp"', 'name = "Temp"\ndefault_case = "one"'))
    m = status(capsys, built)["model"]
    assert m["state"] == "stale" and not m["workbook_current"] and not m["can_sign_off"]
    assert m["case"] == "one" and m["workbook_case"] == "big"
    rebuild(capsys, built)
    m = status(capsys, built)["model"]
    assert m["workbook_current"] and m["workbook_case"] == "one"
    assert m["state"] == "stale"  # the model sign-off was for another case's workbook
    model = load_model(built)
    assert model_stamp(model, "one") != model_stamp(model, "big")


# ---------------------------------------------------------------- M4

def _set_cell(gridcraft_cli, path, sheet, ref, value):
    GridCraft(gridcraft_cli).run([
        {"command": "sheet.activate", "params": {"sheet": sheet}},
        {"command": "range.setValues", "params": {"range": ref, "values": [[value]], "parse": False}},
    ], path, source=path)


def _formula_cell(path, sheet):
    from tilekit.xlsxread import Xlsx
    cells = Xlsx(path).cells(sheet)
    return next(ref for ref, c in sorted(cells.items()) if c["formula"])


@pytest.mark.parametrize("kind, name", [("tiles", "doubled"), ("modules", "first"), ("model", None)])
def test_edited_workbook_is_not_current(built, gridcraft_cli, capsys, kind, name):
    sign_all(capsys, built)
    path = built / "review" / kind / (name or "") / "workbook.xlsx"
    sheet = "One" if kind != "model" else "First"
    ref = _formula_cell(path, sheet)
    _set_cell(gridcraft_cli, path, sheet, ref, "=0")
    s = status(capsys, built)
    entry = s["tiles"][name] if kind == "tiles" else s["modules"][name] if kind == "modules" else s["model"]
    assert entry["workbook_current"] is False
    assert "The stored workbook was changed outside a build. Rebuild it." in entry["blockers"]
    if kind != "model":
        assert entry["state"] == "stale" and entry["drift"] == "values"
    code, doc = run(capsys, built, "build")
    assert code == 0 and [b["workbook"] for b in doc["built"]] == [path.relative_to(built).as_posix()]
    s = status(capsys, built)
    entry = s["tiles"][name] if kind == "tiles" else s["modules"][name] if kind == "modules" else s["model"]
    assert entry["workbook_current"] is True


def test_editing_only_scratch_keeps_the_workbook_current(built, gridcraft_cli, capsys):
    sign(capsys, built, "--tile", "doubled")
    path = built / "review/tiles/doubled/workbook.xlsx"
    _set_cell(gridcraft_cli, path, "Scratch", "B2", "my note")
    GridCraft(gridcraft_cli).run([
        {"command": "sheet.activate", "params": {"sheet": "Scratch"}},
        {"command": "range.setValues", "params": {"range": "C2", "values": [["=One!C8*2"]]}},
    ], path, source=path)
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["workbook_current"] and t["state"] == "signed_off"
    code, doc = run(capsys, built, "build", "--tile", "doubled")
    assert doc["built"] == []


def test_edited_parameter_cell_is_caught(built, gridcraft_cli, capsys):
    path = built / "review/tiles/balance_eop/workbook.xlsx"
    from tilekit.xlsxread import Xlsx
    cells = Xlsx(path).cells("One")
    ref = next(r for r, c in cells.items() if c["value"] == "growth_pm")
    _set_cell(gridcraft_cli, path, "One", "C" + ref[1:], 0.5)
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert not t["workbook_current"] and not t["can_sign_off"]


# ---------------------------------------------------------------- M5

NAN_TILE = '''
import numpy as np


def ratio(x, cap):
    """Ratio.

    x over x.

    Format: number
    """
    return x / x * cap
'''


@pytest.mark.filterwarnings("ignore:invalid value encountered")
def test_expected_json_records_non_finite_values_by_kind(make_model, capsys):
    from tilekit.review import _tile_expected, case_hashes, write_json
    cases = {"zero": {"id": "zero", "name": "Zero", "purpose": "p", "model_point": {"size": 0.0}},
             "one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0}}}
    root = make_model(modules={"first": {"source": NAN_TILE, "layer": "A"}}, states={}, cases=cases)
    model = load_model(root)
    record = {"tile": "ratio", "stamp": stamp_of(model, "ratio"), "case_hashes": case_hashes(model),
              "cases": _tile_expected(model, "ratio")}
    assert record["cases"]["zero"]["values"] == ["nan"] * 6
    assert record["cases"]["one"]["values"] == [50.0] * 6
    path = expected_path(model, "ratio")
    path.parent.mkdir(parents=True)
    write_json(path, record)
    assert check_expected(model, "ratio")["status"] == "ok"

    tampered = json.loads(path.read_text())
    tampered["cases"]["zero"]["values"][0] = 50.0  # a recorded finite value that is now NaN
    path.write_text(json.dumps(tampered))
    result = check_expected(load_model(root), "ratio")
    assert result["status"] == "mismatch" and result["mismatches"][0]["python"] == "nan"

    tampered = json.loads(json.dumps(record))
    tampered["cases"]["one"]["values"][3] = "inf"  # recorded as infinite, now finite
    path.write_text(json.dumps(tampered))
    assert check_expected(load_model(root), "ratio")["status"] == "mismatch"

    tampered = json.loads(json.dumps(record))
    tampered["cases"]["zero"]["values"][0] = "inf"  # NaN and inf are different kinds
    path.write_text(json.dumps(tampered))
    assert check_expected(load_model(root), "ratio")["status"] == "mismatch"


# ---------------------------------------------------------------- reconfirm and the signed formula

def test_reconfirm_refuses_when_the_formula_differs_from_the_signed_one(built, capsys):
    for t in ("doubled", "balance_eop"):
        sign(capsys, built, "--tile", t)
    path = built / "review/tiles/balance_eop/signoff.json"
    doc = json.loads(path.read_text())
    doc["formula"] = "=MAX({balance_bop},cap)"  # what an older translator wrote for the same code
    path.write_text(json.dumps(doc))
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["state"] == "stale" and t["drift"] == "formula"
    edit(built, "params", "default=50.0", "default=60.0")  # values drift as well
    rebuild(capsys, built)
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["drift"] == "formula"
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert "balance_eop" not in doc["reconfirmed"]


# ---------------------------------------------------------------- M1

def test_near_tie_is_recorded_and_blocks_sign_off(make_model, gridcraft_cli, capsys):
    cases = {"one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0},
                     "params": {"cap": 3.0000000000000004}},
             "big": {"id": "big", "name": "Big", "purpose": "p", "model_point": {"size": 100.0}},
             "small": {"id": "small", "name": "Small", "purpose": "p", "model_point": {"size": 0.001}}}
    root = make_model(modules={"first": {"source": BRANCHY, "layer": "A"}}, states={}, cases=cases)
    code, trace = run(capsys, root, "trace", "--case", "one")
    assert trace["near_ties"] == {"clipped": [{"comparison": "MIN({x},cap)", "month": 3}]}
    rebuild(capsys, root)
    side = json.loads((root / "review/tiles/clipped/workbook.json").read_text())
    assert side["cases"]["one"]["near_ties"] == [{"comparison": "MIN({x},cap)", "month": 3}]
    assert side["cases"]["big"]["near_ties"] == [] and set(side["near_ties"]) == {"one"}
    t = status(capsys, root)["tiles"]["clipped"]
    assert t["near_ties"] == {"one": [{"comparison": "MIN({x},cap)", "month": 3}]}
    assert ("A comparison is within rounding of a tie in case one, month 3: Excel and Python may take "
            "different branches.") in t["blockers"] and not t["can_sign_off"]
    module = json.loads((root / "review/modules/first/workbook.json").read_text())
    assert module["tiles"]["clipped"]["near_ties"] == {"one": [{"comparison": "MIN({x},cap)", "month": 3}]}


def test_near_tie_rules():
    import numpy as np
    from tilekit.translate import near_ties, translate_source
    src = "def t(a, b):\n    return np.where(a {op} b, a, b)\n"
    kinds = {"a": "row", "b": "row"}

    def ties(op, a, b):
        tr = translate_source(src.format(op=op), kinds)
        return [t["month"] for t in near_ties(tr, {"a": np.array(a), "b": np.array(b)}, len(a))]

    assert ties(">", [1.0, 1.0 + 1e-15, 2.0], [1.0, 1.0, 1.0]) == [2]  # exact equality is not a tie for >
    assert ties("==", [1.0, 0.1, 0.1 + 1e-16, 0.2], [1.0, 0.1, 0.1, 0.3]) == [2, 3]  # = on non-integers
    assert ties("<", [0.0, 1e-300], [1e-300, 0.0]) == []


# ---------------------------------------------------------------- C2

def test_inputs_code_and_data_are_in_the_params_stamp(make_model):
    root = make_model()
    model = load_model(root)
    before = stamp_of(model, "doubled")
    package = next((root / "src").iterdir())
    (package / "helpers.py").write_text("def rate():\n    return 1\n")
    after = stamp_of(load_model(root), "doubled")
    assert after["params"] != before["params"] and after["code"] == before["code"]

    (root / "assumptions").mkdir()
    (root / "assumptions" / "factor.txt").write_text("2.0\n")
    with_data = stamp_of(load_model(root), "doubled")
    assert with_data["params"] != after["params"]
    (root / "assumptions" / "factor.txt").write_text("3.0\n")
    assert stamp_of(load_model(root), "doubled")["params"] != with_data["params"]

    current = stamp_of(load_model(root), "doubled")
    (package / "reference.py").write_text("# a slow hand-written check\n")
    assert stamp_of(load_model(root), "doubled")["params"] == current["params"]
    edit(root, "step_mod", "x added to itself.", "x added to itself, once.")
    assert stamp_of(load_model(root), "doubled")["params"] == current["params"]


def test_helper_module_change_makes_a_signed_tile_stale(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    package = next((built / "src").iterdir())
    (package / "rates.py").write_text("RATE = 1\n")
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "stale" and t["drift"] == "values"


# ---------------------------------------------------------------- a tile that reads something not built

LOOP = '''
import numpy as np


def interest(balance_bop, growth_pm):
    """Interest.

    Opening balance times the growth rate.

    Format: amount
    """
    return balance_bop * growth_pm


def balance_eop(balance_bop, interest):
    """Closing balance.

    Opening balance plus interest.

    Timing: end of month
    Format: amount
    Status: not built
    """
    return np.nan * balance_bop
'''

LOOP_STATE = {"balance_bop": {"from": "balance_eop", "initial": 100.0, "label": "Opening balance", "format": "amount"}}


def test_a_tile_waiting_on_an_unbuilt_tile_cannot_be_signed_off(make_model, gridcraft_cli, capsys):
    """`interest` reads the state `balance_bop`, carried forward from `balance_eop`, which is not built: from month 2
    its values are NaN in Python and #NUM! in Excel, which agree, so the difference check passes on nothing."""
    root = make_model(modules={"first": {"source": LOOP, "layer": "A"}}, states=LOOP_STATE)
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    t = status(capsys, root)["tiles"]["interest"]
    assert t["state"] == "built" and t["checks_pass"] is True  # the hole: the check itself passes
    assert t["waiting_on"] == ["balance_eop"] and not t["can_sign_off"]
    assert any("depends on balance_eop, which is not built yet" in b for b in t["blockers"])
    code, doc = sign(capsys, root, "--tile", "interest")
    assert code != 0, doc
    # once the loop is closed the blocker goes
    source = root / "src" / root.name / "first.py"
    source.write_text(source.read_text().replace("    Status: not built\n", "").replace(
        "return np.nan * balance_bop", "return balance_bop + interest"))
    pass_tile_tests(capsys, root)
    t = status(capsys, root)["tiles"]["interest"]
    assert t["waiting_on"] == [] and t["can_sign_off"], t["blockers"]
