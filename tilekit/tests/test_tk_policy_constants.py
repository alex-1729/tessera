"""Per-policy constants: an input series that is a model-point field passed through unchanged is laid out as one
named input cell under the parameters (like a parameter), not as a row with the same value in every month.

The rule is decided once for the whole model (`workbook.policy_constants`), so a quantity is a cell in every
workbook or a row in every workbook. Formulas refer to the cell by its defined name; the tile's translated formula
(`{size}` placeholders) is unchanged. The `Hand checks` sheet keeps every argument as a row (one value per check).
The layout change is values drift for an existing sign-off, which can then be re-confirmed.
"""

import json
import re
import sys
import textwrap

import pytest

from tilekit import load_model
from tilekit.review import check_expected
from tilekit.xlsxread import Xlsx

from test_tk_review import run, status

BLUE, MAROON = "FF0000FF", "FF800000"

INPUTS = '''
import numpy as np


def build_inputs(model_points, params, months):
    size = np.asarray(model_points["size"], dtype=np.float64)
    n_pol = size.shape[0]
    month = np.arange(1, months + 1, dtype=np.float64).reshape(months, 1, 1)
    series = {
        "x": month * size,
        "size": size,
        "c": np.asarray(model_points["c"], dtype=np.float64),
        "term": np.asarray(model_points["term"], dtype=np.float64),
        "bump": np.where(month == 1, np.asarray(model_points["bump"], dtype=np.float64), 0.0),
    }
    return {k: np.broadcast_to(v, (months, 1, n_pol)).astype(np.float64) for k, v in series.items()}
'''

INPUT_CONFIG = '''
[input.size]
label = "Size"
format = "number"

[input.c]
label = "Factor"
format = "number"

[input.term]
label = "Term"
format = "integer"

[input.bump]
label = "Bump"
format = "amount"
'''

FIRST = '''
def doubled(x):
    """Doubled x.

    x added to itself.

    Format: amount
    """
    return x + x


def scaled(doubled, size, c, bump, growth_pm):
    """Scaled.

    Doubled x times the size and the factor, grown, plus the bump.

    Format: amount
    """
    return doubled * size * c * (1 + growth_pm) + bump
'''

RESULTS = '''
import numpy as np


def total_scaled(scaled, term):
    """Total scaled.

    Scaled times the term, summed over the months.

    Format: amount
    """
    return np.sum(scaled * term, axis=0)
'''

MODULES = {"first": {"source": FIRST, "layer": "A"},
           "results": {"source": RESULTS, "layer": "B", "timing": "summary"}}
CASES = {
    "one": {"id": "one", "name": "One", "purpose": "Small.",
            "model_point": {"size": 1.0, "c": 2.0, "term": 3, "bump": 0.0}},
    "two": {"id": "two", "name": "Two", "purpose": "Bigger, with a bump in month 1.",
            "model_point": {"size": 2.0, "c": 0.5, "term": 4, "bump": 5.0}},
}

HAND = '''
    """scaled worked by hand."""

    import pytest


    def test_scaled_by_hand():
        """3 times 2 times 0.5, grown by 10%, is 3.3, plus 1 is 4.3."""
        assert scaled(3.0, 2.0, 0.5, 1.0, 0.1) == pytest.approx(4.3, rel=0, abs=1e-9)
        assert scaled(1.0, 4.0, 1.0, 0.0, 0.0) == 4.0
'''


@pytest.fixture
def model_dir(make_model):
    root = make_model(modules=MODULES, states={}, cases=CASES)
    package = next((root / "src").iterdir())
    (package / "inputs.py").write_text(INPUTS)
    with (root / "tilekit.toml").open("a") as handle:
        handle.write(INPUT_CONFIG)
    return root


@pytest.fixture
def built(model_dir, gridcraft_cli, capsys):
    tests = model_dir / "tests" / "tiles"
    tests.mkdir(parents=True)
    (tests / "test_scaled.py").write_text(  # the import goes last: the test is really run now (`tilekit test`)
        textwrap.dedent(HAND) + f"\n\nfrom {model_dir.name}.first import scaled  # noqa: E402\n")
    code, doc = run(capsys, model_dir, "build")
    assert code == 0, doc
    for item in doc["built"]:
        assert item["checks_pass"], item
    code, doc = run(capsys, model_dir, "test")  # a tile's sign-off needs its test to have passed since the last change
    assert code == 0 and doc["failed"] == 0, doc
    return model_dir


def test_rule_is_a_field_passed_through_in_every_case(model_dir):
    from tilekit.workbook import policy_constants
    # size and c qualify; x is not a field; term is read by a summary tile; bump is a field that is constant in
    # case one (0 throughout) but not in case two, so it is a row everywhere
    assert policy_constants(load_model(model_dir)) == {"size", "c"}


def _fresh(root):
    """The model loaded again after its code changed (as a new process would)."""
    for key in [k for k in sys.modules if k == root.name or k.startswith(root.name + ".")]:
        del sys.modules[key]
    return load_model(root)


def test_rule_needs_the_field_in_every_case_and_the_same_value(model_dir):
    from tilekit.workbook import policy_constants
    # a case without the field: the series is not that field passed through there
    package = next((model_dir / "src").iterdir())
    (package / "inputs.py").write_text(INPUTS.replace('model_points["c"]', 'model_points.get("c", size)'))
    three = {"id": "three", "name": "Three", "purpose": "No c.", "model_point": {"size": 1.0, "term": 1, "bump": 0.0}}
    (model_dir / "cases" / "three.json").write_text(json.dumps(three))
    assert policy_constants(_fresh(model_dir)) == {"size"}
    # a series constant in every month but not equal to the field
    (model_dir / "cases" / "three.json").unlink()
    (package / "inputs.py").write_text(INPUTS.replace('"size": size,', '"size": size + 1,'))
    assert policy_constants(_fresh(model_dir)) == {"c"}


def _block(book, sheet):
    """{code name: (row, value)} of the named cells at the top of a sheet (name in D, value in C)."""
    cells = book.cells(sheet)
    out = {}
    row = 5
    while f"D{row}" in cells and isinstance(cells[f"D{row}"]["value"], str):
        out[cells[f"D{row}"]["value"]] = (row, cells[f"C{row}"]["value"])
        row += 1
    return out


def _row_formulas(book, sheet, name):
    row = book.row_named(sheet, name)
    return [c["formula"] for ref, c in book.cells(sheet).items()
            if c["formula"] and int(re.search(r"\d+", ref).group(0)) == row]


def test_tile_workbook_shows_a_constant_as_a_named_cell(built):
    sidecar = json.loads((built / "review/tiles/scaled/workbook.json").read_text())
    assert "{size}" in sidecar["formula"] and "{c}" in sidecar["formula"]  # the translation is unchanged
    book = Xlsx(built / "review/tiles/scaled/workbook.xlsx")
    for sheet, (size, c) in (("One", (1.0, 2.0)), ("Two", (2.0, 0.5))):
        block = _block(book, sheet)
        assert list(block) == ["growth_pm", "size", "c"]  # parameters, then the constants directly under them
        assert block["size"][1] == size and block["c"][1] == c
        cells = book.cells(sheet)
        for name in ("size", "c"):
            row = block[name][0]
            assert BLUE in book.font(cells[f"C{row}"]) and "<b/>" in book.font(cells[f"C{row}"])
            assert MAROON in book.font(cells[f"D{row}"])
            assert cells[f"B{row}"]["value"] == {"size": "Size", "c": "Factor"}[name]
        # no time row for a constant; bump (not a constant) keeps its row
        rows_named = {c["value"] for ref, c in cells.items() if ref.startswith("I")}
        assert "size" not in rows_named and "c" not in rows_named and "bump" in rows_named
        formulas = _row_formulas(book, sheet, "scaled")
        assert len(formulas) == 6
        for formula in formulas:  # by defined name; `c` reads as a column, so its name is c_
            assert re.search(r"\bsize\b", formula) and re.search(r"\bc_\b", formula), formula
            assert f"C{block['size'][0]}" not in formula and f"$C${block['size'][0]}" not in formula
    names = {(n["name"], n["scope"]) for n in book.defined_names}
    assert {("size", "One"), ("c_", "One"), ("size", "Two"), ("c_", "Two")} <= names


def test_module_and_model_workbooks_use_the_same_cells(built):
    book = Xlsx(built / "review/modules/first/workbook.xlsx")
    assert list(_block(book, "One")) == ["growth_pm", "size", "c"]
    assert all(re.search(r"\bsize\b", f) for f in _row_formulas(book, "One", "scaled"))
    assert {("size", "One"), ("c_", "Two")} <= {(n["name"], n["scope"]) for n in book.defined_names}
    # the summary module: term is read by a summary tile, so it is a row (and SUMPRODUCT takes its range)
    book = Xlsx(built / "review/modules/results/workbook.xlsx")
    assert "term" not in _block(book, "One")
    assert any(f.startswith("SUMPRODUCT(") for f in _row_formulas(book, "One", "total_scaled"))

    book = Xlsx(built / "review/model/workbook.xlsx")
    block = _block(book, "Inputs")
    assert list(block)[-2:] == ["size", "c"] and block["size"][1] == 1.0
    assert {("size", None), ("c_", None)} <= {(n["name"], n["scope"]) for n in book.defined_names}
    first = book.cells("First")
    assert not any(c["value"] in ("size", "c") for c in first.values())  # no link row for a constant
    assert all(re.search(r"\bsize\b", f) and "!" not in f for f in _row_formulas(book, "First", "scaled"))
    assert _row_formulas(book, "First", "bump")[0].startswith("Inputs!")  # a real series is still linked
    inputs = book.cells("Inputs")
    assert not any(c["value"] == "size" for ref, c in inputs.items() if not ref.startswith(("B", "D")))


def test_hand_checks_keep_a_constant_as_a_row(built):
    sidecar = json.loads((built / "review/tiles/scaled/workbook.json").read_text())
    hand = sidecar["hand_checks"]
    assert hand["checks_pass"] is True and len(hand["checks"]) == 2
    book = Xlsx(built / "review/tiles/scaled/workbook.xlsx")
    sheet = hand["sheet"]
    row = book.row_named(sheet, "size")
    cells = book.cells(sheet)
    assert cells[f"C{row}"]["value"] == 2.0 and cells[f"D{row}"]["value"] == 4.0  # one value per check
    assert all(f"C{row}" in f or f"D{row}" in f for f in _row_formulas(book, sheet, "scaled"))
    assert not any(n["name"] == "size" and n["scope"] == sheet for n in book.defined_names)


def _drop_layout(path):
    """Make a stored stamp look like one written before the `layout` key existed (tilekit-workbook 4)."""
    document = json.loads(path.read_text())
    document["stamp"].pop("layout")
    path.write_text(json.dumps(document))


def test_an_existing_sign_off_goes_stale_as_values_drift_and_can_be_reconfirmed(built, capsys):
    code, doc = run(capsys, built, "signoff", "--tile", "scaled", "--reviewer", "Pat")
    assert code == 0, doc
    signed_formula = json.loads((built / "review/tiles/scaled/signoff.json").read_text())["formula"]
    for path in (built / "review").rglob("*.json"):
        if path.name in ("signoff.json", "expected.json", "workbook.json"):
            _drop_layout(path)

    entry = status(capsys, built)["tiles"]["scaled"]
    assert (entry["state"], entry["drift"], entry["workbook_current"]) == ("stale", "values", False)
    assert entry["formula"] == entry["signed_formula"] == signed_formula
    code, queue = run(capsys, built, "queue")
    item = next(i for i in queue["items"] if i["id"] == "scaled")
    assert item["kind"] == "values_drift" and item["reconfirm"] == "after_rebuild"
    # the recorded expected values are still current: the layout has no bearing on Python
    assert check_expected(load_model(built), "scaled")["status"] == "ok"

    code, doc = run(capsys, built, "build")
    assert code == 0, doc
    entry = status(capsys, built)["tiles"]["scaled"]
    assert (entry["state"], entry["drift"], entry["workbook_current"]) == ("stale", "values", True)
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert code == 0 and doc["reconfirmed"] == ["scaled"], doc
    entry = status(capsys, built)["tiles"]["scaled"]
    assert entry["state"] == "signed_off" and entry["signed_formula"] == signed_formula
    assert "layout" in json.loads((built / "review/tiles/scaled/signoff.json").read_text())["stamp"]


def test_layout_is_values_drift_and_the_formula_part_is_unchanged():
    from tilekit.review import _assess
    from tilekit.stamps import FORMULA_LAYOUT_VERSION, STAMP_KEYS, _digest, translator_digest
    from tilekit.translate import TRANSLATOR_VERSION
    # the `translator` digest is what it was under tilekit-workbook 4, so old stamps still match it
    assert FORMULA_LAYOUT_VERSION == "tilekit-workbook 4"
    assert translator_digest() == _digest(TRANSLATOR_VERSION, "tilekit-workbook 4")
    current = {k: k for k in STAMP_KEYS}
    old = {k: k for k in STAMP_KEYS if k != "layout"}
    signoff = {"stamp": old, "cases": [], "case_hashes": {}}
    assert _assess(current, current, signoff, {}) == ("stale", "values", [])
    assert _assess(current, old, None, {}) == ("stale", "values", [])  # an old workbook needs a rebuild
    assert _assess(current, current, {**signoff, "stamp": {**old, "translator": "x"}}, {})[1] == "formula"
