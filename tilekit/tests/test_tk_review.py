"""Review state: sign-offs, staleness kinds, reconfirm, export and the test cache."""

import json
import sys

import pytest

from tilekit import load_model
from tilekit.cli import main
from tilekit.review import check_expected

from test_tk_workbook import CASES, FIRST, MODULES, RESULTS, SECOND

CASES = {**CASES, "capped": {"id": "capped", "name": "Capped", "purpose": "Cap binds.",
                              "model_point": {"size": 100.0}, "params": {"cap": 10.0}}}
IDS = ["big", "capped", "one"]

BRANCHY = '''
import numpy as np


def clipped(x, cap):
    """Clipped x.

    x limited to the cap.

    Format: amount
    """
    return np.minimum(x, cap)
'''


def run(capsys, root, *argv):
    for key in [k for k in sys.modules if k == root.name or k.startswith(root.name + ".")]:
        del sys.modules[key]  # a fresh process would re-import edited model code
    code = main([argv[0], "--model", str(root), *argv[1:]])
    return code, json.loads(capsys.readouterr().out)


@pytest.fixture
def built(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    return root


def status(capsys, root):
    code, doc = run(capsys, root, "status")
    assert code == 0, doc
    return doc


def sign(capsys, root, *target):
    return run(capsys, root, "signoff", *target, "--reviewer", "Pat", "--comment", "ok")


def sign_all(capsys, root):
    for t in ("doubled", "balance_eop", "weighted", "weighted_grown"):
        code, doc = sign(capsys, root, "--tile", t)
        assert code == 0, doc
    for m in ("first", "second", "results"):
        code, doc = sign(capsys, root, "--module", m)
        assert code == 0, doc


def edit(root, module, old, new):
    path = next((root / "src").glob(f"*/{module}.py"))
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new))


def rebuild(capsys, root):
    code, doc = run(capsys, root, "build")
    assert code == 0, doc


def test_unbuilt_built_signed(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    s = status(capsys, root)
    assert s["tiles"]["doubled"]["state"] == "unbuilt" and not s["tiles"]["doubled"]["can_sign_off"]
    assert s["counts"]["tiles"] == {"signed_off": 0, "built": 0, "stale": 0, "unbuilt": 4, "not_built": 0, "total": 4}
    code, doc = sign(capsys, root, "--tile", "doubled")
    assert code == 1 and "not been built" in doc["error"]["message"]
    run(capsys, root, "build")
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["state"] == "built" and t["drift"] is None and t["workbook_current"] and t["can_sign_off"]
    assert t["checks_pass"] and t["formula"] == "={x}+{x}" and t["signed_formula"] is None
    assert set(t["case_results"]) == set(IDS) and t["workbook"] == "review/tiles/doubled/workbook.xlsx"
    code, doc = sign(capsys, root, "--tile", "doubled")
    assert code == 0 and doc["status"]["state"] == "signed_off"
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["signed_off"]["reviewer"] == "Pat" and t["signed_formula"] == "={x}+{x}"
    so = json.loads((root / "review/tiles/doubled/signoff.json").read_text())
    assert so["cases"] == IDS and set(so["case_hashes"]) == set(IDS) and so["comment"] == "ok"
    assert set(so["stamp"]) == {"code", "spec", "upstream", "cases", "params", "translator", "layout"}


def test_expected_json_and_regression(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    sign(capsys, built, "--tile", "weighted")
    exp = json.loads((built / "review/tiles/doubled/expected.json").read_text())
    assert exp["tile"] == "doubled" and set(exp["cases"]) == set(IDS)
    assert exp["cases"]["one"]["months"] == 6 and exp["cases"]["one"]["values"] == [2.0 * k for k in range(1, 7)]
    summ = json.loads((built / "review/tiles/weighted/expected.json").read_text())
    assert len(summ["cases"]["one"]["values"]) == 1
    model = load_model(built)
    assert check_expected(model, "doubled")["status"] == "ok"
    exp["cases"]["one"]["values"][2] += 1e-6
    (built / "review/tiles/doubled/expected.json").write_text(json.dumps(exp))
    result = check_expected(load_model(built), "doubled")
    assert result["status"] == "mismatch" and result["mismatches"][0]["index"] == 2
    edit(built, "first", "x + x", "x + x + 0")
    assert check_expected(load_model(built), "doubled")["status"] == "stale"


def test_formula_drift_on_code(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    edit(built, "first", "x + x", "x * (1 + 1)")
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "stale" and t["drift"] == "formula" and not t["workbook_current"]
    assert t["signed_formula"] == "={x}+{x}" and t["formula"] != t["signed_formula"]
    assert any("out of date" in b for b in t["blockers"])


def test_formula_drift_on_spec_only(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    edit(built, "first", "x added to itself.", "x added to itself, really.")
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "stale" and t["drift"] == "formula"


def test_stale_without_signoff_uses_built_stamp(built, capsys):
    edit(built, "first", "x + x", "x * (1 + 1)")
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "stale" and t["drift"] == "formula" and t["signed_off"] is None


def test_values_drift_downstream_and_reconfirm(built, capsys):
    for t in ("doubled", "balance_eop"):
        sign(capsys, built, "--tile", t)
    edit(built, "first", "x + x", "x * (1 + 1)")
    tiles = status(capsys, built)["tiles"]
    assert tiles["doubled"]["drift"] == "formula"
    assert tiles["balance_eop"]["state"] == "stale" and tiles["balance_eop"]["drift"] == "values"
    # no rebuild yet: skipped
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert code == 0 and doc["reconfirmed"] == []
    assert doc["skipped"] == [{"name": "balance_eop", "reason": "workbook needs a rebuild"}]
    rebuild(capsys, built)
    before = json.loads((built / "review/tiles/doubled/signoff.json").read_text())
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Quinn")
    assert doc["reconfirmed"] == ["balance_eop"] and doc["skipped"] == []
    tiles = status(capsys, built)["tiles"]
    assert tiles["balance_eop"]["state"] == "signed_off" and tiles["balance_eop"]["signed_off"]["reviewer"] == "Quinn"
    assert tiles["balance_eop"]["signed_off"]["comment"] == "Values-only re-confirmation"
    assert tiles["doubled"]["state"] == "stale"  # formula drift never touched
    assert json.loads((built / "review/tiles/doubled/signoff.json").read_text()) == before


def test_values_drift_on_param_and_case_change(built, capsys):
    sign(capsys, built, "--tile", "balance_eop")
    edit(built, "params", "default=50.0", "default=60.0")
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["state"] == "stale" and t["drift"] == "values"
    rebuild(capsys, built)
    run(capsys, built, "reconfirm", "--reviewer", "Pat", "--module", "second")
    assert status(capsys, built)["tiles"]["balance_eop"]["state"] == "signed_off"
    case = built / "cases/one.json"
    data = json.loads(case.read_text())
    data["model_point"]["size"] = 2.0
    case.write_text(json.dumps(data))
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["state"] == "stale" and t["drift"] == "values"


def test_new_case_keeps_signoffs(built, capsys):
    sign_all(capsys, built)
    run(capsys, built, "signoff", "--whole-model", "--reviewer", "Pat")
    (built / "cases/three.json").write_text(json.dumps(
        {"id": "three", "name": "Three", "purpose": "x", "model_point": {"size": 3.0}}))
    # until the workbooks are rebuilt with the new case, the sign-offs are stale (values)
    s = status(capsys, built)
    for t in s["tiles"].values():
        assert t["state"] == "stale" and t["drift"] == "values" and t["new_cases"] == ["three"]
        assert not t["workbook_current"]
    assert all(m["state"] == "stale" and m["drift"] == "values" for m in s["modules"].values())
    assert s["model"]["state"] == "stale"
    rebuild(capsys, built)
    s = status(capsys, built)
    for t in s["tiles"].values():
        assert t["state"] == "signed_off" and t["new_cases"] == ["three"] and t["workbook_current"]
    assert all(m["state"] == "signed_off" for m in s["modules"].values())
    assert s["model"]["state"] == "signed_off"
    # an existing case changing is still staleness
    case = built / "cases/one.json"
    data = json.loads(case.read_text())
    data["purpose"] = "changed"
    case.write_text(json.dumps(data))
    assert status(capsys, built)["tiles"]["doubled"]["state"] == "stale"


def test_blocker_failing_difference(built, capsys):
    path = built / "review/tiles/doubled/workbook.json"
    doc = json.loads(path.read_text())
    doc["checks_pass"] = False
    doc["max_abs_difference"] = 0.5
    path.write_text(json.dumps(doc))
    t = status(capsys, built)["tiles"]["doubled"]
    assert not t["can_sign_off"] and any("difference check fails" in b for b in t["blockers"])
    code, out = sign(capsys, built, "--tile", "doubled")
    assert code == 1 and out["error"]["detail"]["blockers"] and not (built / "review/tiles/doubled/signoff.json").exists()


def test_blocker_rule_error(make_model, gridcraft_cli, capsys):
    bad = FIRST.replace("x + x", "x + 3.5")
    root = make_model(modules={"first": {"source": bad, "layer": "A"}}, states={})
    run(capsys, root, "build", "--tile", "doubled")
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["rule_violations"] and t["rule_violations"][0]["rule"] == "literals"
    assert not t["can_sign_off"] and any("Rule violation" in b for b in t["blockers"])


def test_blocker_uncovered_branch(make_model, gridcraft_cli, capsys):
    cases = {"one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0}}}
    root = make_model(modules={"first": {"source": BRANCHY, "layer": "A"}}, states={},
                      cases=cases)
    run(capsys, root, "build")
    t = status(capsys, root)["tiles"]["clipped"]
    assert t["uncovered_branches"] and not t["can_sign_off"]
    assert any("branch" in b for b in t["blockers"])
    # a case that takes the other branch unblocks it
    (root / "cases/capped.json").write_text(json.dumps(
        {"id": "capped", "name": "Capped", "purpose": "p", "model_point": {"size": 100.0}}))
    rebuild(capsys, root)
    t = status(capsys, root)["tiles"]["clipped"]
    assert t["uncovered_branches"] == [] and t["can_sign_off"]


def test_not_built_marker(make_model, capsys):
    src = FIRST.replace("Format: amount", "Format: amount\n    Status: not built")
    root = make_model(modules={"first": {"source": src, "layer": "A"}}, states={})
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["state"] == "not_built" and t["blockers"] == ["This tile has not been built yet."]
    assert status(capsys, root)["counts"]["tiles"]["not_built"] == 1


def test_module_and_model_rules(built, capsys):
    s = status(capsys, built)
    m = s["modules"]["first"]
    assert m["state"] == "built" and [c["name"] for c in m["checks"]] == [
        "Sheet agrees with Python", "Tile formulas match the tile workbooks", "Every tile signed off",
        "No rule violations"]
    assert not m["can_sign_off"] and "not signed off" in " ".join(m["blockers"])
    code, doc = sign(capsys, built, "--module", "first")
    assert code == 1 and "doubled" in doc["error"]["message"]
    code, doc = sign(capsys, built, "--whole-model")
    assert code == 1
    sign(capsys, built, "--tile", "doubled")
    code, doc = sign(capsys, built, "--module", "first")
    assert code == 0 and doc["signed_off"]["kind"] == "module"
    s = status(capsys, built)
    assert s["modules"]["first"]["state"] == "signed_off" and s["modules"]["first"]["tiles_signed_off"] == 1
    assert s["model"]["modules_signed_off"] == 1 and s["model"]["modules_total"] == 3
    sign_all(capsys, built)
    code, doc = sign(capsys, built, "--whole-model")
    assert code == 0 and doc["status"]["state"] == "signed_off"
    assert (built / "review/model/signoff.json").exists()
    # formula change in the first module: tile formula drift, module formula drift, downstream values drift
    edit(built, "first", "x + x", "x * (1 + 1)")
    s = status(capsys, built)
    assert s["modules"]["first"]["state"] == "stale" and s["modules"]["first"]["drift"] == "formula"
    assert s["modules"]["second"]["state"] == "stale" and s["modules"]["second"]["drift"] == "values"
    assert s["modules"]["second"]["stale"] == 1
    assert s["model"]["state"] == "stale" and s["model"]["drift"] == "formula" and s["model"]["stale"] == 3
    assert s["counts"]["tiles"]["stale"] == 4  # doubled and all downstream


def test_export(built, capsys, tmp_path):
    out = tmp_path / "out" / "m.xlsx"
    code, doc = run(capsys, built, "export", "--out", str(out))
    assert code == 0 and doc["case"] == "big" and doc["bytes"] == out.stat().st_size > 0
    code, doc = run(capsys, built, "export", "--out", str(tmp_path / "x.xlsx"), "--case", "one")
    assert code == 1 and "not been built" in doc["error"]["message"]
    assert status(capsys, built)["model"]["workbooks"] == {"big": "review/model/workbook.xlsx"}


def test_model_test_cache(make_model, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    (root / "tests").mkdir()
    (root / "tests/test_invariants_x.py").write_text(
        "def test_balance_never_negative():\n    assert True\n\ndef test_other_thing():\n    assert True\n")
    (root / "tests/test_misc.py").write_text("def test_fails():\n    assert False\n")
    code, doc = run(capsys, root, "test")
    assert code == 0 and doc["passed"] == 2 and doc["failed"] == 1
    assert {t["outcome"] for t in doc["tests"]} == {"passed", "failed"}
    assert (root / "review/model/tests.json").is_file()
    checks = status(capsys, root)["model"]["checks"]
    names = [c["name"] for c in checks]
    assert "Balance never negative" in names and "Other thing" in names
    assert "Model tests pass (2 of 3)" in names
    assert not [c for c in checks if c["name"] == "Balance never negative"][0].get("stale")
    edit(root, "first", "x + x", "x * (1 + 1)")
    checks = status(capsys, root)["model"]["checks"]
    assert all(c["pass"] is False and c.get("stale") for c in checks if c["name"] in names[3:])
