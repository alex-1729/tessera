"""Workbook building against small temporary models (needs gridcraft-cli; skipped without it)."""

import json

import pytest

from tilekit import load_model
from tilekit.cli import main
from tilekit.xlsxread import Xlsx

FIRST = '''
import numpy as np


def doubled(x):
    """Doubled x.

    x added to itself.

    Format: amount
    """
    return x + x
'''

SECOND = '''
import numpy as np


def balance_eop(balance_bop, doubled, growth_pm, cap):
    """Closing balance.

    Opening balance grown, plus doubled x, capped.

    Format: amount
    """
    grown = balance_bop * (1 + growth_pm)
    return np.minimum(grown + doubled, cap)
'''

RESULTS = '''
import numpy as np


def weighted(doubled, balance_eop):
    """Weighted total.

    Doubled x times the closing balance, summed over months.

    Format: amount
    """
    return np.sum(doubled * balance_eop, axis=0)


def weighted_grown(weighted, growth_pm):
    """Weighted total grown.

    The weighted total grown by one month.

    Format: amount
    """
    return weighted * (1 + growth_pm)
'''

MODULES = {
    "first": {"source": FIRST, "layer": "A"},
    "second": {"source": SECOND, "layer": "A"},
    "results": {"source": RESULTS, "layer": "B", "timing": "summary"},
}
CASES = {
    "one": {"id": "one", "name": "One", "purpose": "Size one.", "model_point": {"size": 1.0}},
    "big": {"id": "big", "name": "Big", "purpose": "Size a million.", "model_point": {"size": 1e6},
            "params": {"cap": 1e9}},
}


def run(capsys, *argv):
    code = main(list(argv))
    out = capsys.readouterr().out
    return code, json.loads(out)


@pytest.fixture
def three_modules(make_model):
    return make_model(modules=MODULES, cases=CASES)


def test_build_everything(three_modules, gridcraft_cli, capsys):
    root = three_modules
    code, doc = run(capsys, "build", "--model", str(root))
    assert code == 0, doc
    kinds = [(b["kind"], b["name"]) for b in doc["built"]]
    assert kinds == [("tile", "doubled"), ("tile", "balance_eop"), ("tile", "weighted"), ("tile", "weighted_grown"),
                     ("module", "first"), ("module", "second"), ("module", "results"), ("model", "Temp")]
    for item in doc["built"]:
        assert item["checks_pass"] and item["max_abs_difference"] < 1e-9, item
        assert (root / item["workbook"]).is_file()
        assert (root / item["workbook"]).with_suffix(".json").is_file()

    # summary tile: SUMPRODUCT over the pasted series, scalar block below the time block
    sidecar = json.loads((root / "review/tiles/weighted/workbook.json").read_text())
    assert sidecar["formula"] == "=SUMPRODUCT({doubled},{balance_eop})"
    assert set(sidecar["cases"]) == {"one", "big"} and sidecar["cases"]["one"]["sheet"] == "One"
    book = Xlsx(root / "review/tiles/weighted/workbook.xlsx")
    assert book.sheets == ["Big", "One", "Scratch"]
    cells = book.cells("One")
    formulas = {ref: c["formula"] for ref, c in cells.items() if c["formula"]}
    assert "SUMPRODUCT(C6:H6,C7:H7)" in formulas.values()
    assert cells["D6"]["value"] == "doubled" or cells["I6"]["value"] == "doubled"

    # a summary tile reading another summary tile refers to its cell
    grown = Xlsx(root / "review/tiles/weighted_grown/workbook.xlsx").cells("One")
    assert any(c["formula"] == "C7*(1+growth_pm)" for c in grown.values())

    # model workbook: Inputs first, modules in dependency order, cross-sheet links, Scratch last
    book = Xlsx(root / "review/model/workbook.xlsx")
    assert book.sheets == ["Inputs", "First", "Second", "Results", "Scratch"]
    second = {c["formula"] for c in book.cells("Second").values() if c["formula"]}
    assert "First!C8" in second  # doubled linked in from the First sheet
    assert any(f.startswith("MIN(") and "growth_pm" in f and "!" not in f for f in second)
    first = {c["formula"] for c in book.cells("First").values() if c["formula"]}
    assert "Inputs!C9" in first  # input series linked from Inputs
    results = {c["formula"] for c in book.cells("Results").values() if c["formula"]}
    assert any(f.startswith("SUMPRODUCT(") for f in results)
    assert any(f.startswith("Second!") for f in results)
    names = {(n["name"], n["scope"]) for n in book.defined_names}
    assert {("growth_pm", None), ("cap", None), ("x", None), ("doubled", None), ("balance_eop", None),
            ("balance_bop", None), ("weighted", None)} <= names
    assert json.loads((root / "review/model/workbook.json").read_text())["case"] == "big"  # no default_case: the first case

    # module workbook: sheet-scoped names (one set per case sheet)
    book = Xlsx(root / "review/modules/second/workbook.xlsx")
    assert ("cap", "One") in {(n["name"], n["scope"]) for n in book.defined_names}

    # amounts of a million or more lose their decimals
    assert 'numFmtId="3"' in Xlsx(root / "review/tiles/doubled/workbook.xlsx").styles_xml  # built-in #,##0

    # another case's model workbook goes to its own file
    code, doc = run(capsys, "build", "--model", str(root), "--whole-model", "--case", "one")
    assert code == 0 and doc["built"][0]["workbook"] == "review/model/workbook-one.xlsx"
    assert json.loads((root / "review/model/workbook-one.json").read_text())["case"] == "one"


def test_scratch_survives_and_unchanged_build_skips(three_modules, gridcraft_cli, capsys):
    from tilekit.gridcraft import GridCraft
    root = str(three_modules)
    code, first = run(capsys, "build", "--model", root, "--tile", "doubled")
    assert code == 0 and len(first["built"]) == 1

    path = three_modules / "review/tiles/doubled/workbook.xlsx"
    GridCraft(gridcraft_cli).run([
        {"command": "sheet.activate", "params": {"sheet": "Scratch"}},
        {"command": "range.setValues", "params": {"range": "B2", "values": [["my working", "=One!C8*2"]]}},
        {"command": "home.fillColor", "params": {"range": "B2", "color": "#FFFF00"}},
    ], path, source=path)

    code, doc = run(capsys, "build", "--model", root, "--tile", "doubled")
    assert code == 0 and doc["built"] == [] and doc["skipped"][0]["reason"] == "up to date"

    code, doc = run(capsys, "build", "--model", root, "--tile", "doubled", "--force")
    assert code == 0 and doc["built"][0]["checks_pass"]
    book = Xlsx(path)
    assert book.sheets[-1] == "Scratch"
    scratch = book.cells("Scratch")
    assert scratch["B2"]["value"] == "my working"
    assert scratch["C2"]["formula"] == "One!C8*2" and scratch["C2"]["value"] == 4.0
    assert 'rgb="FFFFFF00"' in book.styles_xml

    # everything else, then nothing at all on the second run
    code, doc = run(capsys, "build", "--model", root)
    assert code == 0 and len(doc["built"]) == 7 and len(doc["skipped"]) == 1
    code, doc = run(capsys, "build", "--model", root)
    assert code == 0 and doc["built"] == [] and len(doc["skipped"]) == 8

    # a case change makes everything stale; a removed case's sheet goes away
    (three_modules / "cases" / "big.json").unlink()
    code, doc = run(capsys, "build", "--model", root, "--tile", "doubled")
    assert code == 0 and len(doc["built"]) == 1
    assert Xlsx(path).sheets == ["One", "Scratch"]
    assert Xlsx(path).cells("Scratch")["B2"]["value"] == "my working"


def test_cumsum_is_a_rule_error_not_a_values_only_tile(make_model, capsys):
    source = FIRST + '''

def running(x):
    """Running total.

    Cumulative x.

    Format: amount
    """
    return np.cumsum(x, axis=0)
'''
    root = make_model(modules={"first": {"source": source, "layer": "A"}}, states={})
    code, check = run(capsys, "check", "--model", str(root))
    hits = [v for v in check["violations"] if v["tile"] == "running" and v["rule"] == "numpy-calls-only"]
    assert hits and "np.cumsum" in hits[0]["message"] and "np.minimum" in hits[0]["message"]


VALUES_ONLY = '''
import numpy as np


def scaled_total(doubled, growth_pm):
    """Scaled total.

    Doubled x times the growth rate, summed over months.

    Format: amount
    """
    return np.sum(doubled * growth_pm, axis=0)
'''


def test_untranslatable_tile_is_values_only(make_model, gridcraft_cli, capsys):
    root = make_model(modules={"first": {"source": FIRST, "layer": "A"},
                               "results": {"source": VALUES_ONLY, "layer": "B", "timing": "summary"}}, states={})
    code, check = run(capsys, "check", "--model", str(root))
    assert check["counts"]["error"] == 0, check
    code, graph = run(capsys, "graph", "--model", str(root))
    assert graph["quantities"]["scaled_total"]["translatable"] is False
    code, doc = run(capsys, "build", "--model", str(root), "--tile", "scaled_total")
    assert code == 0
    assert doc["built"][0]["checks_pass"] is None and doc["built"][0]["max_abs_difference"] is None
    sidecar = json.loads((root / "review/tiles/scaled_total/workbook.json").read_text())
    assert sidecar["translatable"] is False and sidecar["formula"] is None
    assert sidecar["checks_pass"] is None and sidecar["max_abs_difference"] is None
    assert all(c["checks_pass"] is None and c["max_abs_difference"] is None for c in sidecar["cases"].values())

    code, status = run(capsys, "status", "--model", str(root))
    t = status["tiles"]["scaled_total"]
    assert t["translatable"] is False and t["values_only"] is True and t["checks_pass"] is None
    blocker = "This tile cannot be written as an Excel formula. Sign-off needs a values-only acknowledgement."
    assert t["blockers"] == [blocker] and not t["can_sign_off"]
    code, doc = run(capsys, "signoff", "--model", str(root), "--tile", "scaled_total", "--reviewer", "Pat")
    assert code == 1 and blocker in doc["error"]["message"]
    code, doc = run(capsys, "signoff", "--model", str(root), "--tile", "doubled", "--reviewer", "Pat",
                    "--values-only", "because")
    assert code == 1 and "has an Excel formula" in doc["error"]["message"]
    code, doc = run(capsys, "signoff", "--model", str(root), "--tile", "scaled_total", "--reviewer", "Pat",
                    "--values-only", "   ")
    assert code == 1
    code, doc = run(capsys, "signoff", "--model", str(root), "--tile", "scaled_total", "--reviewer", "Pat",
                    "--values-only", "Checked the totals by hand")
    assert code == 0, doc
    signoff = json.loads((root / "review/tiles/scaled_total/signoff.json").read_text())
    assert signoff["values_only_reason"] == "Checked the totals by hand"
    code, status = run(capsys, "status", "--model", str(root))
    t = status["tiles"]["scaled_total"]
    assert t["state"] == "signed_off" and t["values_only_reason"] == "Checked the totals by hand"

    # the module workbook pastes the values-only row; its check covers the formula rows only
    code, doc = run(capsys, "build", "--model", str(root), "--module", "results")
    module = json.loads((root / "review/modules/results/workbook.json").read_text())
    assert module["tiles"]["scaled_total"]["checks_pass"] is None


def test_missing_gridcraft_is_a_clear_error(make_model, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("GRIDCRAFT_CLI", str(tmp_path / "no-such-cli"))
    code, doc = run(capsys, "build", "--model", str(make_model()))
    assert code == 1 and "gridcraft-cli not found" in doc["error"]["message"]


def test_graph_and_trace_carry_formulas_and_branches(three_modules, capsys):
    code, graph = run(capsys, "graph", "--model", str(three_modules))
    q = graph["quantities"]["balance_eop"]
    assert q["formula"] == "=MIN({balance_bop}*(1+growth_pm)+{doubled},cap)"
    assert q["translatable"] is True and q["branches"] == ["min: first", "min: second"]
    code, trace = run(capsys, "trace", "--model", str(three_modules), "--case", "one")
    assert trace["branches"] == {"balance_eop": {"min: first": 6, "min: second": 0}}


def test_stamps(make_model):
    from tilekit.stamps import model_stamp, module_stamp, tile_stamp
    root = make_model(modules=MODULES, cases=CASES)
    model = load_model(root)
    before = {n: tile_stamp(model, n) for n in model.graph.order}
    module_before = module_stamp(model, "second")
    whole_before = model_stamp(model)
    assert set(before["doubled"]) == {"code", "spec", "upstream", "cases", "params", "translator"}
    assert all(len(v) == 64 for v in before["doubled"].values())

    package = next((root / "src").iterdir())
    first = package / "first.py"

    # whitespace and comments do not change the code stamp; a docstring edit changes only the spec
    first.write_text(FIRST.replace("return x + x", "return x+x   # same"))
    model = load_model(root)
    assert tile_stamp(model, "doubled") == before["doubled"]
    first.write_text(FIRST.replace("x added to itself.", "x added to itself, once."))
    model = load_model(root)
    after = tile_stamp(model, "doubled")
    assert after["code"] == before["doubled"]["code"] and after["spec"] != before["doubled"]["spec"]
    # downstream tiles see it as an upstream change only
    downstream = tile_stamp(model, "balance_eop")
    assert downstream["upstream"] != before["balance_eop"]["upstream"]
    assert downstream["code"] == before["balance_eop"]["code"]
    assert module_stamp(model, "second")["upstream"] != module_before["upstream"]
    assert model_stamp(model)["spec"] != whole_before["spec"]

    # a case change touches every stamp's cases digest
    (root / "cases" / "one.json").write_text(json.dumps({**CASES["one"], "purpose": "Changed."}))
    model = load_model(root)
    assert tile_stamp(model, "doubled")["cases"] != before["doubled"]["cases"]
