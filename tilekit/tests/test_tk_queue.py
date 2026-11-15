"""The review queue: every outstanding item, each kind, upstream first; and it never records anything."""

import json

from test_tk_review import (BRANCHY, MODULES, built, edit, pass_tile_tests, rebuild, run, run_tests, sign,  # noqa: F401
                            sign_all, status)
from test_tk_signoff_safety import add_case
from test_tk_workbook import CASES, FIRST

TILES = ["doubled", "balance_eop", "weighted", "weighted_grown"]


def queue(capsys, root):
    code, doc = run(capsys, root, "queue")
    assert code == 0, doc
    return doc


def keys(doc):
    return [(i["level"], i["id"]) for i in doc["items"]]


def item(doc, ident, level="tile"):
    return next(i for i in doc["items"] if i["level"] == level and i["id"] == ident)


def snapshot(root):
    """Every file under review/ that holds review state, with its bytes."""
    return {p.relative_to(root).as_posix(): p.read_bytes()
            for p in sorted((root / "review").rglob("*")) if p.is_file() and ".cache" not in p.parts}


# ---------------------------------------------------------------- ordering

def test_order_is_upstream_first(built, capsys):
    doc = queue(capsys, built)
    assert keys(doc) == [
        ("tile", "doubled"), ("module", "first"),
        ("tile", "balance_eop"), ("module", "second"),
        ("tile", "weighted"), ("tile", "weighted_grown"), ("module", "results"),
        ("model", None),
    ]
    first = doc["items"][0]
    assert first["module"] == "first" and first["module_title"] == "First" and first["label"] == "Doubled x"
    assert doc["counts"]["total"] == 8 and doc["counts"]["tiles"] == 4
    assert doc["counts"]["modules"] == 3 and doc["counts"]["model"] == 1


def test_modules_follow_dependencies_not_the_listed_order(make_model, capsys):
    # `second` reads `first` but is listed before it: the queue still puts `first` on the left
    listed = {"second": MODULES["second"], "results": MODULES["results"], "first": MODULES["first"]}
    root = make_model(modules=listed, cases=CASES)
    order = [k for k in keys(queue(capsys, root)) if k[0] == "module"]
    assert order == [("module", "first"), ("module", "second"), ("module", "results")]
    tiles = [k[1] for k in keys(queue(capsys, root)) if k[0] == "tile"]
    assert tiles == TILES


# ---------------------------------------------------------------- each kind

def test_never_signed_off(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    doc = queue(capsys, root)
    assert all(i["kind"] == "not_signed_off" for i in doc["items"])
    assert "workbook has not been built" in item(doc, "doubled")["reason"]
    assert doc["counts"]["kinds"]["not_signed_off"] == 4
    pass_tile_tests(capsys, root)  # builds, and gives each tile a passing test: sign-off needs both
    doc = queue(capsys, root)
    assert item(doc, "doubled")["reason"] == "Not signed off yet."
    assert item(doc, "results", "module")["reason"] == "The module is not signed off yet. 2 of its tiles still to sign off first."
    sign(capsys, root, "--tile", "doubled")
    doc = queue(capsys, root)
    assert ("tile", "doubled") not in keys(doc) and doc["counts"]["kinds"]["not_signed_off"] == 3
    # an unsigned tile whose workbook went out of date is still "never signed off", not drift
    edit(root, "second", "grown + doubled", "doubled + grown")
    assert item(queue(capsys, root), "balance_eop")["kind"] == "not_signed_off"


def test_formula_and_values_drift(built, capsys):
    sign_all(capsys, built)
    assert keys(queue(capsys, built)) == [("model", None)]
    edit(built, "first", "x + x", "x * (1 + 1)")
    doc = queue(capsys, built)
    assert item(doc, "doubled")["kind"] == "formula_drift" and item(doc, "doubled")["reconfirm"] is None
    assert "full review" in item(doc, "doubled")["reason"]
    for name in ("balance_eop", "weighted", "weighted_grown"):
        assert item(doc, name)["kind"] == "values_drift" and item(doc, name)["reconfirm"] == "after_rebuild"
    assert item(doc, "first", "module")["kind"] == "formula_drift"
    assert doc["counts"]["kinds"]["formula_drift"] == 1 and doc["counts"]["kinds"]["values_drift"] == 3
    assert doc["counts"]["reconfirm"] == 3
    rebuild(capsys, built)
    doc = queue(capsys, built)
    assert item(doc, "balance_eop")["reconfirm"] == "ready"
    assert item(doc, "doubled")["kind"] == "formula_drift" and item(doc, "doubled")["reconfirm"] is None


def test_reconfirm_flag_matches_what_reconfirm_does(built, capsys):
    """The queue offers bulk re-confirmation for exactly the tiles `reconfirm` re-signs."""
    sign_all(capsys, built)
    edit(built, "first", "x + x", "x * (1 + 1)")
    rebuild(capsys, built)
    # a failing difference check on one of them: no longer eligible
    path = built / "review/tiles/weighted/workbook.json"
    sidecar = json.loads(path.read_text())
    sidecar["checks_pass"] = False
    sidecar["cases"]["one"]["checks_pass"] = False
    path.write_text(json.dumps(sidecar))
    doc = queue(capsys, built)
    ready = [i["id"] for i in doc["items"] if i["reconfirm"] == "ready"]
    assert item(doc, "weighted")["reconfirm"] is None and "full review" in item(doc, "weighted")["reason"]
    code, done = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert code == 0 and done["reconfirmed"] == ready == ["balance_eop", "weighted_grown"]
    assert [s["name"] for s in done["skipped"]] == ["weighted"]
    doc = queue(capsys, built)
    assert ("tile", "balance_eop") not in keys(doc) and ("tile", "doubled") in keys(doc)


def test_new_case_to_review(built, capsys):
    sign_all(capsys, built)
    add_case(built, "three", 3.0)
    rebuild(capsys, built)
    doc = queue(capsys, built)
    assert status(capsys, built)["tiles"]["doubled"]["state"] == "signed_off"  # not un-ticked
    for name in TILES:
        assert item(doc, name)["kind"] == "new_case" and item(doc, name)["reason"] == "New case to review: Three."
        assert item(doc, name)["reconfirm"] is None
    assert item(doc, "first", "module")["kind"] == "new_case"
    assert doc["counts"]["kinds"]["new_case"] == 4


def test_unexercised_branch(make_model, gridcraft_cli, capsys):
    cases = {"one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0}}}
    root = make_model(modules={"first": {"source": BRANCHY, "layer": "A"}}, states={}, cases=cases)
    rebuild(capsys, root)
    doc = queue(capsys, root)
    it = item(doc, "clipped")
    assert [r["kind"] for r in it["reasons"]] == ["not_signed_off", "unexercised_branch"]
    assert "blocks sign-off" in it["reason"] and doc["counts"]["kinds"]["unexercised_branch"] == 1
    (root / "cases/capped.json").write_text(json.dumps(
        {"id": "capped", "name": "Capped", "purpose": "p", "model_point": {"size": 100.0}}))
    rebuild(capsys, root)
    assert [r["kind"] for r in item(queue(capsys, root), "clipped")["reasons"]] == ["not_signed_off"]


def test_not_built_tile_is_not_a_review_item(make_model, capsys):
    src = FIRST.replace("Format: amount", "Format: amount\n    Status: not built")
    root = make_model(modules={"first": {"source": src, "layer": "A"}}, states={})
    assert [k for k in keys(queue(capsys, root)) if k[0] == "tile"] == []


# ---------------------------------------------------------------- empty, and read-only

def test_empty_when_everything_is_signed_off(built, capsys):
    sign_all(capsys, built)
    code, doc = sign(capsys, built, "--whole-model")
    assert code == 0, doc
    doc = queue(capsys, built)
    assert doc["items"] == [] and doc["counts"]["total"] == 0 and doc["counts"]["reconfirm"] == 0


def test_queue_writes_no_review_state(built, capsys):
    sign_all(capsys, built)
    edit(built, "first", "x + x", "x * (1 + 1)")
    rebuild(capsys, built)
    before = snapshot(built)
    doc = queue(capsys, built)
    assert doc["counts"]["reconfirm"] == 3
    assert snapshot(built) == before
    assert status(capsys, built)["tiles"]["balance_eop"]["state"] == "stale"
