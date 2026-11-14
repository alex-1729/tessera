"""M6 (one JSON document, always), C5 (Excel ROUND), and the requests from other workstreams:
`Status:` lines and not-built tiles, graph fields, `test --file`, the `small` format."""

import json

import numpy as np
import pytest

from tilekit import load_model
from tilekit.cli import main
from tilekit.functions import round_half_away
from tilekit.graph import parse_docstring

from conftest import GOOD_STEP, PARAMS_SOURCE


def run(capsys, *argv):
    code = main([str(a) for a in argv])
    captured = capsys.readouterr()
    return code, json.loads(captured.out), captured.err


# ---------------------------------------------------------------- M6

def test_model_code_printing_goes_to_stderr(make_model, capsys):
    root = make_model()
    inputs = next((root / "src").glob("*/inputs.py"))
    inputs.write_text(inputs.read_text().replace("    size = ", "    print('hello from the model')\n    size = "))
    code, doc, err = run(capsys, "trace", "--model", root, "--case", "one")
    assert code == 0 and doc["case"] == "one" and "hello from the model" in err


def test_serialisation_failure_is_still_an_error_document(make_model, capsys):
    root = make_model()
    params = next((root / "src").glob("*/params.py"))
    params.write_text(PARAMS_SOURCE.replace("default=50.0", "default=float('nan')"))
    code, doc, _ = run(capsys, "graph", "--model", root)
    assert code == 1 and "error" in doc and "nan" in doc["error"]["message"].lower()


@pytest.mark.parametrize("text", ['{"id": "one", "name": "One", "model_point": {"size": NaN}}',
                                  '{"id": "one", "name": "One", "model_point": {"size": 1}, "params": {"cap": Infinity}}',
                                  '{"id": "one", "name": "One", "model_point": {"size": 1}, "params": {"cap": -Infinity}}'])
def test_non_finite_numbers_in_case_files_are_refused(make_model, capsys, text):
    root = make_model()
    (root / "cases" / "one.json").write_text(text)
    code, doc, _ = run(capsys, "trace", "--model", root, "--case", "one")
    assert code == 1 and "finite" in doc["error"]["message"]


# ---------------------------------------------------------------- C5

AWKWARD = [(2.675, 2), (1.005, 2), (0.5, 0), (1.5, 0), (2.5, 0), (-2.5, 0), (-2.675, 2), (1234.5678, -2),
           (1250.0, -2), (-1250.0, -2), (-1249.99, -2), (0.285, 2), (5.015, 2), (8.345, 2), (0.1 + 0.2, 1),
           (1.45, 1), (-1.45, 1), (0.045, 2), (4.35, 1), (123456789.125, 2), (2.5e-7, 6), (2.5e-7, 7),
           (0.000125, 4), (-0.000125, 5), (1.2345678901234567, 14), (9.995, 2), (99.5, 0), (-0.5, 0),
           (1 / 3, 3), (2 / 3 * 100, 1), (-0.0049, 2), (0.0, 2), (15.0, -1), (-15.0, -1), (45.0, -1),
           (1e15 + 0.5, 0), (2.345, 2.9), (-2.345, -0.5), (1e-20, 2), (7.0, -3)]


def test_round_half_away_rule():
    assert round_half_away(2.5, 0) == 3.0 and round_half_away(-2.5, 0) == -3.0
    assert round_half_away(2.675, 2) == 2.68 and round_half_away(-2.675, 2) == -2.68
    assert round_half_away(1250.0, -2) == 1300.0 and round_half_away(-1250.0, -2) == -1300.0
    assert round_half_away(2.345, 2.9) == 2.35  # digits truncate towards zero, like Excel
    assert np.isnan(round_half_away(np.nan, 2)) and round_half_away(np.inf, 2) == np.inf
    out = round_half_away(np.array([[0.5, 1.5], [-0.5, 2.25]]), np.array([0, 1]))
    assert out.shape == (2, 2) and out.tolist() == [[1.0, 1.5], [-1.0, 2.3]]
    assert str(round_half_away(-0.4, 0)) == "0.0"  # no negative zero


def test_round_half_away_matches_gridcraft_round(gridcraft_cli, tmp_path):
    from tilekit.gridcraft import GridCraft
    rows = [[x, d, f"=ROUND(A{i + 1},B{i + 1})"] for i, (x, d) in enumerate(AWKWARD)]
    result = GridCraft(gridcraft_cli).run([
        {"command": "range.setValues", "params": {"range": "A1", "values": rows}},
        {"command": "sheet.read", "params": {"range": f"A1:C{len(rows)}"}},
    ], tmp_path / "round.xlsx")
    excel = [row[2] for row in result[-1]["result"]["values"]]
    python = [round_half_away(x, d) for x, d in AWKWARD]
    assert python == excel


def test_round_translates_to_excel_round_and_np_round_does_not():
    from tilekit.translate import translate_source
    good = translate_source("def t(a, k):\n    return tk.round_half_away(a * k, 2)\n", {"a": "row", "k": "param"})
    assert good.formula == "=ROUND({a}*k,2)"
    for bad in ("np.round(a, 2)", "np.around(a, 2)", "np.round(a)"):
        assert not translate_source(f"def t(a, k):\n    return {bad}\n", {"a": "row", "k": "param"}).translatable


ROUNDING_TILE = '''
import numpy as np

from tilekit import functions as tk


def rounded(x, growth_pm):
    """Rounded.

    x grown, to whole pennies.

    Format: amount
    """
    return tk.round_half_away(x * (1 + growth_pm), 1 + 1)
'''


def test_rounding_tile_reconciles_in_gridcraft(make_model, gridcraft_cli, capsys):
    cases = {"one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 2.6475247524752477},
                     "params": {"growth_pm": 0.01}}}
    root = make_model(modules={"first": {"source": ROUNDING_TILE, "layer": "A"}}, states={}, cases=cases)
    code, check, _ = run(capsys, "check", "--model", root)
    assert check["counts"]["error"] == 0, check
    code, doc, _ = run(capsys, "build", "--model", root, "--tile", "rounded")
    assert code == 0 and doc["built"][0]["checks_pass"] is True, doc


# ---------------------------------------------------------------- requests

def test_status_key_is_parsed_and_kept_out_of_the_spec():
    doc = parse_docstring("Label.\n\nSpec text.\n\nFormat: amount\nStatus: not built\n")
    assert doc.status == "not built" and doc.not_built and doc.spec == "Spec text."
    assert not parse_docstring("Label.\n\nStatus: built\n").not_built


def test_not_built_tile_in_graph_build_and_status(make_model, gridcraft_cli, capsys):
    source = GOOD_STEP.replace("Units: currency\n    Format: amount", "Units: currency\n    Format: amount\n"
                                                                       "    Status: not built")
    root = make_model(modules={"step_mod": {"source": source, "layer": "A"}})
    code, graph, _ = run(capsys, "graph", "--model", root)
    assert graph["quantities"]["doubled"]["status"] == "not_built"
    assert graph["quantities"]["balance_eop"]["status"] is None
    assert "Status" not in graph["quantities"]["doubled"]["spec"]
    code, doc, _ = run(capsys, "build", "--model", root)
    assert code == 0 and ("tile", "doubled") not in [(b["kind"], b["name"]) for b in doc["built"]]
    assert not (root / "review/tiles/doubled").exists()
    code, doc, _ = run(capsys, "build", "--model", root, "--tile", "doubled")
    assert code == 1 and "not built" in doc["error"]["message"]
    code, s, _ = run(capsys, "status", "--model", root)
    assert s["tiles"]["doubled"]["state"] == "not_built"


def test_graph_has_module_paths_and_default_case(make_model, capsys):
    root = make_model()
    toml = root / "tilekit.toml"
    text = toml.read_text().replace('name = "Temp"', 'name = "Temp"\ndefault_case = "one"')
    text = text.replace('id = "step_mod"', 'id = "step_mod"\npurpose = "Steps."\nfeeds = ["summary_mod"]')
    toml.write_text(text)
    code, graph, _ = run(capsys, "graph", "--model", root)
    assert code == 0 and graph["model"]["default_case"] == "one"
    module = graph["modules"][0]
    package = next((root / "src").iterdir()).name
    assert module["python"] == f"{package}.step_mod" and module["file"] == f"src/{package}/step_mod.py"


def test_test_file_runs_one_file_without_touching_the_cache(make_model, capsys):
    root = make_model()
    (root / "tests").mkdir()
    (root / "tests/test_a.py").write_text("def test_a():\n    assert True\n")
    (root / "tests/test_b.py").write_text("def test_b():\n    assert False\n")
    code, doc, _ = run(capsys, "test", "--model", root, "--file", "tests/test_a.py")
    assert code == 0 and doc["passed"] == 1 and doc["failed"] == 0 and doc["file"] == "tests/test_a.py"
    assert not (root / "review/model/tests.json").exists()
    code, doc, _ = run(capsys, "test", "--model", root)
    assert doc["passed"] == 1 and doc["failed"] == 1
    cached = (root / "review/model/tests.json").read_text()
    run(capsys, "test", "--model", root, "--file", str(root / "tests/test_b.py"))
    assert (root / "review/model/tests.json").read_text() == cached
    code, doc, _ = run(capsys, "test", "--model", root, "--file", "tests/nope.py")
    assert code == 1


def test_small_format(make_model):
    from tilekit.config import FORMATS
    from tilekit.workbook import number_format
    assert "small" in FORMATS and number_format("small", [0.0001]) == "0.000000"
