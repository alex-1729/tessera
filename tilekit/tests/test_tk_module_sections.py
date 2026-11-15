"""Module sections, module checks (reconciliations) and the module's summary of its tiles' tests.

Sections and checks are declared under a module in `tilekit.toml`. They shape the module sheet (and the module's
sheet in the model workbook) and are part of those workbooks' stamps as `layout` (values drift); they never touch a
tile's stamp or sign-off, and a module without them is laid out and stamped exactly as before.
"""

import hashlib
import json

import pytest

from tilekit import load_model
from tilekit.errors import TilekitError
from tilekit.reconcile import evaluate, excel_template, names, parse_expression
from tilekit.review import _parse_junit, has_case_check
from tilekit.stamps import _group_stamp, layout_digest, model_stamp, module_stamp, tile_stamp
from tilekit.xlsxread import Xlsx

from test_tk_review import run, sign, status

ROLL = '''
import numpy as np


def inflow(x, growth_pm):
    """Inflow.

    x times the growth rate.

    Format: amount
    """
    return x * growth_pm


def outflow(balance_bop, growth_pm):
    """Outflow.

    The opening balance times the growth rate.

    Format: amount
    """
    return balance_bop * growth_pm


def balance_eop(balance_bop, inflow, outflow):
    """Closing balance.

    Opening balance plus inflow less outflow.

    Format: amount
    """
    return balance_bop + inflow - outflow
'''

OTHER = '''
import numpy as np


def half(x):
    """Half x.

    x halved.

    Format: amount
    """
    return x / (1 + 1)
'''

TOTALS = '''
import numpy as np


def total_inflow(inflow):
    """Total inflow.

    Inflow summed over the months.

    Format: amount
    """
    return np.sum(inflow, axis=0)
'''

MODULES = {
    "roll": {"source": ROLL, "layer": "A"},
    "other": {"source": OTHER, "layer": "A"},
    "totals": {"source": TOTALS, "layer": "B", "timing": "summary"},
}
STATES = {"balance_bop": {"from": "balance_eop", "initial": 100.0, "label": "Opening balance", "format": "amount"}}
CASES = {
    "one": {"id": "one", "name": "One", "purpose": "Size one.", "model_point": {"size": 1.0}},
    "two": {"id": "two", "name": "Two", "purpose": "Size two.", "model_point": {"size": 2.0}},
}

SECTIONS = '''
[[module.section]]
title = "Flows in the month"
tiles = ["outflow", "inflow"]

[[module.section]]
title = "Balance roll-forward"
tiles = ["balance_eop"]
'''

CHECK = '''
[[module.check]]
name = "balance_reconciles"
label = "Balance roll-forward reconciles"
expression = "balance_bop + inflow - outflow - balance_eop"
'''


def configure(root, module_id, text):
    """Put `text` (sub-tables such as [[module.section]]) right after the [[module]] table of `module_id`."""
    path = root / "tilekit.toml"
    toml = path.read_text()
    start = toml.index(f'id = "{module_id}"')
    end = toml.index("\n\n", start) + 1
    path.write_text(toml[:end] + text + toml[end:])


@pytest.fixture
def roll(make_model):
    return make_model(modules=MODULES, states=STATES, cases=CASES)


def graph_of(root):
    return load_model(root).graph


# ---------------------------------------------------------------- config and graph

def test_graph_lists_sections_and_checks(roll, capsys):
    code, doc = run(capsys, roll, "graph")
    assert code == 0, doc
    modules = {m["id"]: m for m in doc["modules"]}
    # no sections configured: one untitled section holding every tile, in dependency order
    assert modules["roll"]["sections"] == [{"title": None, "tiles": ["inflow", "outflow", "balance_eop"]}]
    assert modules["roll"]["checks"] == [] and modules["totals"]["sections"] == [
        {"title": None, "tiles": ["total_inflow"]}]
    configure(roll, "roll", '''
[[module.section]]
title = "Flows in the month"
tiles = ["outflow", "inflow"]
''' + CHECK)
    code, doc = run(capsys, roll, "graph")
    assert code == 0, doc
    module = {m["id"]: m for m in doc["modules"]}["roll"]
    # the tiles no section lists come last, untitled, in dependency order
    assert module["sections"] == [{"title": "Flows in the month", "tiles": ["outflow", "inflow"]},
                                  {"title": None, "tiles": ["balance_eop"]}]
    assert module["checks"] == [{"name": "balance_reconciles", "label": "Balance roll-forward reconciles",
                                 "expression": "balance_bop + inflow - outflow - balance_eop", "tolerance": 1e-9}]
    configure(roll, "roll", '''
[[module.section]]
title = "Balance"
tiles = ["balance_eop"]
''')
    code, doc = run(capsys, roll, "graph")
    module = {m["id"]: m for m in doc["modules"]}["roll"]
    # sections in the order the file gives them (this one was written first); every tile listed, so no untitled one
    assert [s["title"] for s in module["sections"]] == ["Balance", "Flows in the month"]


@pytest.mark.parametrize("text, message", [
    ('[[module.section]]\ntitle = "A"\ntiles = ["half"]\n', "not a tile of that module"),
    ('[[module.section]]\ntitle = "A"\ntiles = ["nothing"]\n', "not a tile of that module"),
    ('[[module.section]]\ntitle = "A"\ntiles = ["inflow"]\n\n[[module.section]]\ntitle = "B"\ntiles = ["inflow"]\n',
     "is in two sections"),
    ('[[module.section]]\ntitle = "A"\ntiles = ["inflow", "inflow"]\n', "lists a tile twice"),
    ('[[module.section]]\ntiles = ["inflow"]\n', "needs a title"),
    ('[[module.section]]\ntitle = "A"\ntiles = []\n', "needs `tiles`"),
])
def test_section_errors(roll, text, message):
    configure(roll, "roll", text)
    with pytest.raises(TilekitError, match=message):
        graph_of(roll)


def _check(name="c", expression="inflow - inflow", extra=""):
    return f'[[module.check]]\nname = "{name}"\nexpression = "{expression}"\n{extra}'


@pytest.mark.parametrize("text, message", [
    (_check(expression="__import__('os').system('true')"), "may only use names, numbers"),
    (_check(expression="inflow.real"), "may only use names, numbers"),
    (_check(expression="inflow ** 2"), "may only use names, numbers"),
    (_check(expression="inflow if 1 else 0"), "may only use names, numbers"),
    (_check(expression="max(inflow, 0)"), "may only use names, numbers"),
    (_check(expression="inflow -"), "is not valid"),
    (_check(expression="inflow - nothing"), "reads 'nothing', which is not a tile"),
    (_check(expression="inflow - total_inflow"), "reads the summary tile 'total_inflow'"),
    (_check(name="inflow"), "has the name of the quantity 'inflow'"),
    (_check(name="Growth_PM"), "snake_case"),
    (_check(name="growth-pm"), "snake_case"),
    (_check(name="dup") + "\n" + _check(name="dup"), "two checks with the same name"),
    (_check(extra="tolerance = -1\n"), "tolerance"),
    ('[[module.check]]\nname = "c"\n', "needs an `expression`"),
])
def test_check_errors(roll, text, message):
    configure(roll, "roll", text)
    with pytest.raises(TilekitError, match=message):
        graph_of(roll)


def test_a_check_on_a_summary_module_is_refused(roll):
    configure(roll, "totals", _check())
    with pytest.raises(TilekitError, match="summary module; checks are for step modules"):
        graph_of(roll)


def test_check_expressions_are_parsed_not_run():
    node = parse_expression("a - (b - c) * 2 / -d + 1.5e-3")
    assert names(node) == ["a", "b", "c", "d"]
    assert excel_template(node, {"a", "b", "c"}) == "={a}-({b}-{c})*2/(-d)+0.0015"
    assert excel_template(parse_expression("a - (b + c)"), {"a", "b", "c"}) == "={a}-({b}+{c})"
    assert excel_template(parse_expression("(a - b) - c"), {"a", "b", "c"}) == "={a}-{b}-{c}"
    assert excel_template(parse_expression("-(a - b)"), {"a", "b"}) == "=-({a}-{b})"
    values = {"a": [1.0, 2.0], "b": [1.0, 1.0], "c": [0.0, 0.5], "d": 4.0}
    assert list(evaluate(node, values.get)) == pytest.approx([1.5015, 2.2515])
    assert evaluate(parse_expression("a / 0"), {"a": 1.0}.get) == float("inf")


# ---------------------------------------------------------------- stamps

LEGACY_KEYS = ("id", "title", "layer", "python", "timing")  # a module's config as stamped before sections and checks


def test_no_sections_or_checks_keeps_every_stamp(roll):
    """A module (and a model) without sections or checks is stamped exactly as before they existed: the module's
    config in `code` is the same five keys, and `layout` is the plain layout version."""
    model = load_model(roll)
    module = model.config.module("roll")
    assert module.presentation() is None
    legacy = {k: getattr(module, k) for k in LEGACY_KEYS}
    assert module.identity() == legacy
    names = list(model.graph.modules["roll"].tiles)
    assert module_stamp(model, "roll") == {**_group_stamp(model, names, json.dumps(legacy, sort_keys=True)),
                                           "layout": layout_digest()}
    modules = [{k: getattr(m, k) for k in LEGACY_KEYS} for m in model.config.modules]
    expected = _group_stamp(model, list(model.graph.order),
                            json.dumps({"name": "Temp", "modules": modules}, sort_keys=True))
    whole = model_stamp(model, "one")
    assert whole["code"] == expected["code"] and whole["layout"] == layout_digest()


def test_sections_and_checks_change_only_the_module_and_model_workbook_layout(roll):
    before = load_model(roll)
    tiles = {n: tile_stamp(before, n) for n in before.graph.order}
    modules = {m.id: module_stamp(before, m.id) for m in before.config.modules}
    whole, workbook = model_stamp(before), model_stamp(before, "one")
    configure(roll, "roll", SECTIONS + CHECK)
    after = load_model(roll)
    assert {n: tile_stamp(after, n) for n in after.graph.order} == tiles  # no tile is touched
    changed = module_stamp(after, "roll")
    assert {k for k in changed if changed[k] != modules["roll"][k]} == {"layout"}  # values drift, never formula
    assert module_stamp(after, "other") == modules["other"] and module_stamp(after, "totals") == modules["totals"]
    now = model_stamp(after, "one")
    assert {k for k in now if now[k] != workbook[k]} == {"layout"}
    assert model_stamp(after) == whole  # the stamp the test cache and real-data runs are held to


# ---------------------------------------------------------------- the module sheet

def _rows(book, sheet):
    """{row: (label, C formula or value, name in the name column)} of a sheet with months in C..."""
    cells = book.cells(sheet)
    out = {}
    for ref, cell in cells.items():
        col, row = ref.rstrip("0123456789"), int(ref[len(ref.rstrip("0123456789")):])
        entry = out.setdefault(row, {})
        entry[col] = cell
    return out


def test_module_sheet_lays_out_sections_and_checks(roll, gridcraft_cli, capsys):
    configure(roll, "roll", SECTIONS + CHECK)
    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    book = Xlsx(roll / "review/modules/roll/workbook.xlsx")
    assert book.sheets == ["One", "Two", "Scratch"]
    cells = book.cells("One")
    labels = {int(ref[1:]): c["value"] for ref, c in cells.items() if ref.startswith("B") and ref[1:].isdigit()}
    by_label = {v: r for r, v in labels.items() if v}
    order = [labels[r] for r in sorted(labels) if labels[r]]
    month = order.index("Month")
    assert order[month:] == [
        "Month", "X",
        "Flows in the month", "Opening balance", "Outflow", "Inflow",  # the state goes with its first reader
        "Balance roll-forward", "Closing balance",
        "Python Inflow", "Difference", "Python Closing balance", "Difference",  # the module's outputs, as before
        "Checks", "Balance roll-forward reconciles"]
    # a heading is a bold label alone, with a blank row before it
    heading = by_label["Flows in the month"]
    assert labels.get(heading - 1) is None
    assert cells.get(f"C{heading}", {}).get("value") is None and cells.get(f"C{heading}", {}).get("formula") is None
    assert "<b/>" in _font_xml(book, cells[f"B{heading}"])
    # the check row: a live formula over the sheet's own rows, grey, with its name in maroon
    check = by_label["Balance roll-forward reconciles"]
    r = {name: by_label[label] for name, label in (("bop", "Opening balance"), ("in", "Inflow"),
                                                    ("out", "Outflow"), ("eop", "Closing balance"))}
    assert cells[f"C{check}"]["formula"] == f"C{r['bop']}+C{r['in']}-C{r['out']}-C{r['eop']}"
    assert cells[f"D{check}"]["formula"] == f"D{r['bop']}+D{r['in']}-D{r['out']}-D{r['eop']}"
    assert cells[f"C{check}"]["value"] == pytest.approx(0.0, abs=1e-9)
    assert "FF808080" in _font_xml(book, cells[f"C{check}"]) and "FF808080" in _font_xml(book, cells[f"B{check}"])
    name_col = "I"  # months 1..6 in C..H
    assert cells[f"{name_col}{check}"]["value"] == "balance_reconciles"
    assert "FF800000" in _font_xml(book, cells[f"{name_col}{check}"])
    assert not any(n["name"] == "balance_reconciles" for n in book.defined_names)  # a row nothing refers to
    # the sidecar and the status
    sidecar = json.loads((roll / "review/modules/roll/workbook.json").read_text())
    (rec,) = sidecar["reconciliations"]
    assert rec["name"] == "balance_reconciles" and rec["pass"] is True and rec["max_abs_difference"] <= 1e-9
    assert set(rec["cases"]) == {"one", "two"} and rec["tolerance"] == 1e-9
    assert sidecar["checks_pass"] is True
    m = status(capsys, roll)["modules"]["roll"]
    assert m["reconciliations"] == [{"name": "balance_reconciles", "label": "Balance roll-forward reconciles",
                                     "expression": "balance_bop + inflow - outflow - balance_eop",
                                     "max_abs_difference": rec["max_abs_difference"], "pass": True}]
    assert {"name": "Reconciliations hold", "pass": True} in m["checks"]
    assert not any("is not zero" in b for b in m["blockers"])
    # a module without checks has an empty list and no check row
    other = status(capsys, roll)["modules"]["other"]
    assert other["reconciliations"] == [] and not any(c["name"] == "Reconciliations hold" for c in other["checks"])
    # the model workbook's module sheet is laid out the same way, its check row reading the sheet's own rows
    book = Xlsx(roll / "review/model/workbook.xlsx")
    cells = book.cells("Roll")
    labels = [c["value"] for ref, c in sorted(cells.items(), key=lambda i: int(i[0][1:]) if i[0][1:].isdigit() else 0)
              if ref.startswith("B") and ref[1:].isdigit() and c["value"]]
    assert "Flows in the month" in labels and labels[-2:] == ["Checks", "Balance roll-forward reconciles"]
    row = next(int(ref[1:]) for ref, c in cells.items()
               if ref.startswith("B") and c["value"] == "Balance roll-forward reconciles")
    assert "!" not in cells[f"C{row}"]["formula"]
    model_sidecar = json.loads((roll / "review/model/workbook.json").read_text())
    assert model_sidecar["reconciliations"]["roll"][0]["pass"] is True and model_sidecar["checks_pass"] is True


def _font_xml(book, cell):
    """The <font> XML of a cell (colour and weight)."""
    return book.font(cell)


def test_a_check_reading_what_no_tile_of_the_module_reads(roll, gridcraft_cli, capsys):
    """A check may read a quantity of another module, a parameter or a state the module's tiles do not read: it is
    laid out on the module sheet (pasted, a parameter in the block) so the formula reads only the sheet itself."""
    configure(roll, "other", _check(name="half_of_x", expression="half * 2 - x + growth_pm * 0 + inflow * 0"))
    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    book = Xlsx(roll / "review/modules/other/workbook.xlsx")
    cells = book.cells("One")
    labels = {c["value"]: int(ref[1:]) for ref, c in cells.items() if ref.startswith("B") and ref[1:].isdigit()}
    assert "Growth per month" in labels and "Inflow" in labels
    row = labels["Half_of_x"] if "Half_of_x" in labels else labels["half_of_x"]
    assert "!" not in cells[f"C{row}"]["formula"] and "growth_pm" in cells[f"C{row}"]["formula"]
    m = status(capsys, roll)["modules"]["other"]
    assert m["reconciliations"][0]["pass"] is True


def test_a_failing_check_blocks_the_module(roll, gridcraft_cli, capsys):
    configure(roll, "roll", _check(name="not_zero", expression="balance_eop - balance_bop",
                                   extra='label = "Balance never moves"\n'))
    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    sidecar = json.loads((roll / "review/modules/roll/workbook.json").read_text())
    assert sidecar["checks_pass"] is True  # the sheet still agrees with Python: the check is separate
    rec = sidecar["reconciliations"][0]
    assert rec["pass"] is False and rec["excel_max_abs"] == pytest.approx(rec["python_max_abs"])
    assert rec["python_max_abs"] > 0
    m = status(capsys, roll)["modules"]["roll"]
    assert m["reconciliations"][0]["pass"] is False
    assert {"name": "Reconciliations hold", "pass": False} in m["checks"]
    worst = rec["max_abs_difference"]
    assert f"The check 'Balance never moves' is not zero (largest value {worst:g})." in m["blockers"]
    code, doc = sign(capsys, roll, "--module", "roll")
    assert code == 1 and "is not zero" in doc["error"]["message"]


def test_a_check_within_its_tolerance_passes(roll, gridcraft_cli, capsys):
    configure(roll, "roll", _check(name="small", expression="inflow * 0.000001", extra="tolerance = 0.01\n"))
    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    assert status(capsys, roll)["modules"]["roll"]["reconciliations"][0]["pass"] is True


# ---------------------------------------------------------------- sign-off

def _tile_tests(root):
    folder = root / "tests" / "tiles"
    folder.mkdir(parents=True, exist_ok=True)
    for tile in ("inflow", "outflow", "balance_eop", "half", "total_inflow"):
        (folder / f"test_{tile}.py").write_text(f"def test_{tile}_by_hand():\n    assert 1 + 1 == 2\n")


def test_adding_sections_and_checks_to_a_signed_module(roll, gridcraft_cli, capsys):
    """Adding sections and checks makes the module workbook (and the model workbook) out of date, with values drift:
    the module sign-off goes stale and is given again after a rebuild. No tile is touched."""
    _tile_tests(roll)
    assert run(capsys, roll, "build")[0] == 0
    assert run(capsys, roll, "test")[0] == 0
    for tile in ("inflow", "outflow", "balance_eop", "half", "total_inflow"):
        code, doc = sign(capsys, roll, "--tile", tile)
        assert code == 0, doc
    for module in ("roll", "other", "totals"):
        code, doc = sign(capsys, roll, "--module", module)
        assert code == 0, doc
    assert sign(capsys, roll, "--whole-model")[0] == 0
    tile_signoffs = {t: (roll / f"review/tiles/{t}/signoff.json").read_text() for t in ("inflow", "balance_eop")}

    configure(roll, "roll", SECTIONS + CHECK)
    s = status(capsys, roll)
    m = s["modules"]["roll"]
    assert m["state"] == "stale" and m["drift"] == "values" and not m["workbook_current"]
    assert m["reconciliations"] is None and {"name": "Reconciliations hold", "pass": False} in m["checks"]
    assert "The module's workbook is out of date; rebuild it first." in m["blockers"]
    assert all(t["state"] == "signed_off" and t["workbook_current"] for t in s["tiles"].values())
    assert s["modules"]["other"]["state"] == "signed_off" and s["modules"]["totals"]["state"] == "signed_off"
    assert s["model"]["state"] == "stale" and s["model"]["drift"] == "values"
    # the model tests' cache is not held to the layout: it stays current
    assert all(c["pass"] for c in s["model"]["checks"] if c["name"].startswith("Model tests pass"))

    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    assert sorted((b["kind"], b["name"]) for b in doc["built"]) == [("model", "Temp"), ("module", "roll")]
    s = status(capsys, roll)
    m = s["modules"]["roll"]
    assert m["state"] == "stale" and m["drift"] == "values" and m["workbook_current"] and m["can_sign_off"], m
    assert m["reconciliations"][0]["pass"] is True
    assert {t: (roll / f"review/tiles/{t}/signoff.json").read_text() for t in tile_signoffs} == tile_signoffs
    code, doc = sign(capsys, roll, "--module", "roll")
    assert code == 0 and doc["status"]["state"] == "signed_off"
    assert status(capsys, roll)["model"]["can_sign_off"]

    # taking them away again puts back the stamp the first sign-off was given against: rebuilt, it is signed off
    toml = (roll / "tilekit.toml").read_text()
    (roll / "tilekit.toml").write_text(toml.replace(SECTIONS + CHECK, ""))
    assert run(capsys, roll, "build")[0] == 0
    s = status(capsys, roll)
    assert s["modules"]["roll"]["state"] == "stale"  # signed again with the sections: that stamp has gone too


def test_changing_a_check_is_values_drift_for_the_module(roll, gridcraft_cli, capsys):
    configure(roll, "roll", CHECK)
    assert run(capsys, roll, "build")[0] == 0
    _tile_tests(roll)
    assert run(capsys, roll, "build")[0] == 0
    assert run(capsys, roll, "test")[0] == 0
    for tile in ("inflow", "outflow", "balance_eop"):
        assert sign(capsys, roll, "--tile", tile)[0] == 0
    assert sign(capsys, roll, "--module", "roll")[0] == 0
    path = roll / "tilekit.toml"
    path.write_text(path.read_text().replace('label = "Balance roll-forward reconciles"', 'label = "Balance holds"'))
    m = status(capsys, roll)["modules"]["roll"]
    assert m["state"] == "stale" and m["drift"] == "values"


# ---------------------------------------------------------------- the tiles' tests at module level

PASSING = '''"""inflow: worked by hand."""

import pytest

from {package}.roll import inflow


def test_inflow_by_hand():
    """x times the growth rate.

    Case: one, month 2
    """
    assert inflow(10.0, 0.01) == pytest.approx(0.1, rel=0, abs=1e-12)
'''

FAILING = '''def test_outflow_by_hand():
    """Wrong on purpose."""
    assert 1 + 1 == 3
'''

MODULE_TEST = '''def test_roll_walked_through():
    """The module for one case.

    Case: one, month 1
    """
    assert {result}
'''


def test_tile_tests_summary_and_module_test(roll, gridcraft_cli, capsys):
    package = roll.name
    folder = roll / "tests" / "tiles"
    folder.mkdir(parents=True)
    (folder / "test_inflow.py").write_text(PASSING.format(package=package))
    (folder / "test_outflow.py").write_text(FAILING)
    assert run(capsys, roll, "build")[0] == 0
    m = status(capsys, roll)["modules"]["roll"]
    # no test run cached yet
    assert m["tile_tests"]["tiles"]["inflow"]["tests"] == "not_run"
    assert m["module_test"] == {"file": "tests/modules/test_roll.py", "status": "none"}
    assert not any(c["name"] == "Module test passes" for c in m["checks"])

    code, doc = run(capsys, roll, "test")
    assert code == 0 and doc["failed"] == 1, doc
    cache = json.loads((roll / "review/model/tests.json").read_text())
    assert cache["files"]["tests/tiles/test_inflow.py"] == {
        "sha256": hashlib.sha256((folder / "test_inflow.py").read_bytes()).hexdigest(),
        "passed": 1, "failed": 0, "skipped": 0}
    assert cache["files"]["tests/tiles/test_outflow.py"]["failed"] == 1
    assert {t["path"] for t in cache["tests"]} == {"tests/tiles/test_inflow.py", "tests/tiles/test_outflow.py"}

    m = status(capsys, roll)["modules"]["roll"]
    tt = m["tile_tests"]
    assert tt["tiles"] == {
        "inflow": {"tests": "passed", "hand_checks": {"in_sheet": 1, "agree": 1}, "case_check": True},
        "outflow": {"tests": "failed", "hand_checks": {"in_sheet": 0, "agree": 0}, "case_check": False},
        "balance_eop": {"tests": "none", "hand_checks": None, "case_check": False},
    }
    assert (tt["total"], tt["passed"], tt["failed"], tt["not_run"], tt["none"]) == (3, 1, 1, 0, 1)
    assert {"name": "Tile tests pass (1 of 3)", "pass": False} in m["checks"]
    assert "Tile tests do not all pass: failed for outflow; no test file for balance_eop." in m["blockers"]

    # a test file edited since the run has not been run since the last change
    (folder / "test_outflow.py").write_text(FAILING.replace("1 + 1 == 3", "1 + 1 == 2"))
    m = status(capsys, roll)["modules"]["roll"]
    assert m["tile_tests"]["tiles"]["outflow"]["tests"] == "not_run"
    assert ("Tile tests do not all pass: not run since the last change for outflow (run `tilekit test`); "
            "no test file for balance_eop.") in m["blockers"]

    # every tile tested and passing, and a module test
    (folder / "test_balance_eop.py").write_text("def test_balance_eop_by_hand():\n    assert True\n")
    (roll / "tests" / "modules").mkdir()
    module_test = roll / "tests" / "modules" / "test_roll.py"
    module_test.write_text(MODULE_TEST.format(result="True"))
    assert run(capsys, roll, "build")[0] == 0  # the new tile test asks for its workbook to be rebuilt
    assert run(capsys, roll, "test")[1]["failed"] == 0
    m = status(capsys, roll)["modules"]["roll"]
    assert m["tile_tests"]["passed"] == 3 and {"name": "Tile tests pass (3 of 3)", "pass": True} in m["checks"]
    assert m["module_test"] == {"file": "tests/modules/test_roll.py", "status": "passed"}
    assert {"name": "Module test passes", "pass": True} in m["checks"]
    assert not any("test" in b.lower() for b in m["blockers"]), m["blockers"]
    # the summary module's tile has no test: only that module is blocked
    assert status(capsys, roll)["modules"]["totals"]["tile_tests"]["none"] == 1

    module_test.write_text(MODULE_TEST.format(result="False"))
    m = status(capsys, roll)["modules"]["roll"]
    assert m["module_test"]["status"] == "not_run"
    assert ("The module test tests/modules/test_roll.py has not been run since the last change; run `tilekit test`."
            in m["blockers"])
    run(capsys, roll, "test")
    m = status(capsys, roll)["modules"]["roll"]
    assert m["module_test"]["status"] == "failed" and {"name": "Module test passes", "pass": False} in m["checks"]
    assert "The module test tests/modules/test_roll.py fails." in m["blockers"]

    # a change to the model makes the whole cache stale: nothing counts as run
    path = roll / "src" / package / "roll.py"
    path.write_text(path.read_text().replace("return x * growth_pm", "return growth_pm * x"))
    tt = status(capsys, roll)["modules"]["roll"]["tile_tests"]
    assert {e["tests"] for e in tt["tiles"].values()} == {"not_run"} and tt["not_run"] == 3


def test_a_cache_without_per_file_results_counts_as_not_run(roll, capsys):
    folder = roll / "tests" / "tiles"
    folder.mkdir(parents=True)
    (folder / "test_inflow.py").write_text("def test_inflow_by_hand():\n    assert True\n")
    model = load_model(roll)
    old = {"at": "2026-01-01T00:00:00+00:00", "stamp": model_stamp(model), "passed": 1, "failed": 0,
           "tests": [{"id": "test_inflow.py::test_inflow_by_hand", "name": "test_inflow_by_hand",
                      "file": "test_inflow.py", "outcome": "passed"}]}
    (roll / "review" / "model").mkdir(parents=True)
    (roll / "review" / "model" / "tests.json").write_text(json.dumps(old))
    m = status(capsys, roll)["modules"]["roll"]
    assert m["tile_tests"]["tiles"]["inflow"]["tests"] == "not_run"


def test_not_built_tiles_are_listed_but_not_counted(make_model, capsys):
    source = ROLL.replace('''    Format: amount
    """
    return balance_bop * growth_pm''', '''    Format: amount
    Status: not built
    """
    return balance_bop * growth_pm''')
    root = make_model(modules={**MODULES, "roll": {"source": source, "layer": "A"}}, states=STATES, cases=CASES)
    tt = status(capsys, root)["modules"]["roll"]["tile_tests"]
    assert tt["total"] == 2 and tt["tiles"]["outflow"]["tests"] == "none"
    blockers = status(capsys, root)["modules"]["roll"]["blockers"]
    assert "Tile tests do not all pass: no test file for inflow, balance_eop." in blockers


def test_case_line_and_junit_paths(tmp_path):
    path = tmp_path / "test_x.py"
    path.write_text('"""Module.\n\n  Case: base_2 ,  month 12  \n"""\n')
    assert has_case_check(path)
    path.write_text('def test_x():\n    """Case: base, month twelve"""\n\n# Case: base, month 1\n')
    assert not has_case_check(path)
    path.write_text('class TestX:\n    def test_y(self):\n        """Hand.\n\n        Case: one, month 3\n        """\n')
    assert has_case_check(path)
    report = tmp_path / "junit.xml"
    report.write_text('<testsuites><testsuite>'
                      '<testcase classname="tests.tiles.test_amc" name="test_amc_by_hand"/>'
                      '<testcase classname="tests.modules.test_units.TestWalk" name="test_walk"><failure/></testcase>'
                      '<testcase classname="test_top" name="test_skip"><skipped/></testcase>'
                      '</testsuite></testsuites>')
    tests = _parse_junit(report)
    assert [(t["file"], t["path"], t["outcome"]) for t in tests] == [
        ("test_amc.py", "tests/tiles/test_amc.py", "passed"),
        ("test_units.py", "tests/modules/test_units.py", "failed"),
        ("test_top.py", "test_top.py", "skipped")]


def test_sections_on_a_summary_module(roll, gridcraft_cli, capsys):
    configure(roll, "totals", '[[module.section]]\ntitle = "Totals over the term"\ntiles = ["total_inflow"]\n')
    code, doc = run(capsys, roll, "build")
    assert code == 0, doc
    cells = Xlsx(roll / "review/modules/totals/workbook.xlsx").cells("One")
    labels = [c["value"] for ref, c in sorted(cells.items(), key=lambda i: (int(i[0].lstrip("ABCDEFGHIJ")), i[0]))
              if ref.startswith("B") and c["value"]]
    heading = labels.index("Totals over the term")
    assert labels[heading + 1] == "Total inflow"
    assert status(capsys, roll)["modules"]["totals"]["reconciliations"] == []
