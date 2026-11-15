"""Two rules on a tile's sign-off.

1. A value that is not a number (NaN or infinite) blocks sign-off unless the docstring says, in an `Undefined:`
   line, when that is expected: Excel's error counts as agreeing with it, so the difference check checks nothing there.
2. A tile needs its own hand-calculation test to have passed since the last change. The sign-off records the test it
   was given with; a test changed afterwards never makes the sign-off stale, but it shows in the review queue and
   blocks a new sign-off until it has been run again.
"""

import hashlib
import json

import pytest

from test_tk_review import (CASES, MODULES, built, edit, pass_tile_tests, rebuild, run, run_tests, sign,  # noqa: F401
                            status, write_tile_tests)

NAN_STEP = '''
import numpy as np


def ratio(x, cap):
    """Ratio.

    x over x, times the cap.

    Format: number
    """
    return x / x * cap
'''

NAN_SUMMARY = '''
import numpy as np


def share(ratio):
    """Share.

    The first month's ratio over the total.

    Format: number
    """
    return ratio[0] / np.sum(ratio, axis=0)
'''

ZERO_CASES = {"zero": {"id": "zero", "name": "Zero", "purpose": "p", "model_point": {"size": 0.0}},
              "one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0}}}


def queue(capsys, root):
    code, doc = run(capsys, root, "queue")
    assert code == 0, doc
    return doc


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- 1. values that are not a number

@pytest.mark.filterwarnings("ignore:invalid value encountered")
def test_a_value_that_is_not_a_number_blocks_sign_off_until_the_docstring_says_when(make_model, gridcraft_cli, capsys):
    root = make_model(modules={"first": {"source": NAN_STEP, "layer": "A"}}, states={}, cases=ZERO_CASES)
    pass_tile_tests(capsys, root)
    t = status(capsys, root)["tiles"]["ratio"]
    assert t["state"] == "built" and t["checks_pass"] is True  # the hole: Excel's error agrees with Python's NaN
    assert t["undefined"] == {"declared": None, "cases": {"zero": {"count": 6, "first_month": 1}}}
    assert t["waiting_on"] == [] and not t["can_sign_off"]
    assert t["blockers"] == [
        "Its value is not a number in case zero (first in month 1). Excel shows an error there and the difference "
        "check counts that as agreeing, so those cells are not checked. Correct the tile, or, if that is expected, "
        "add an `Undefined:` line to its docstring saying when."]
    code, doc = sign(capsys, root, "--tile", "ratio")
    assert code == 1 and "is not a number in case zero" in doc["error"]["message"]

    # the docstring says when it is expected: a spec change, so rebuild and run the tests again
    edit(root, "first", "    Format: number\n", "    Format: number\n    Undefined: when x is zero.\n")
    rebuild(capsys, root)
    code, graph = run(capsys, root, "graph")
    assert graph["quantities"]["ratio"]["undefined"] == "when x is zero."
    t = status(capsys, root)["tiles"]["ratio"]
    assert t["undefined"] == {"declared": "when x is zero.", "cases": {"zero": {"count": 6, "first_month": 1}}}
    assert t["can_sign_off"], t["blockers"]
    code, doc = sign(capsys, root, "--tile", "ratio")
    assert code == 0, doc
    assert json.loads((root / "review/tiles/ratio/signoff.json").read_text())["undefined"] == "when x is zero."


@pytest.mark.filterwarnings("ignore:invalid value encountered")
def test_a_summary_tile_that_is_not_a_number_is_held_to_the_same_rule(make_model, gridcraft_cli, capsys):
    step = NAN_STEP.replace("    Format: number\n", "    Format: number\n    Undefined: when x is zero.\n")
    root = make_model(modules={"first": {"source": step, "layer": "A"},
                               "results": {"source": NAN_SUMMARY, "layer": "B", "timing": "summary"}},
                      states={}, cases=ZERO_CASES)
    pass_tile_tests(capsys, root)
    s = status(capsys, root)["tiles"]
    assert s["ratio"]["can_sign_off"], s["ratio"]["blockers"]
    assert s["share"]["undefined"]["cases"] == {"zero": {"count": 1, "first_month": None}}
    assert any(b.startswith("Its value is not a number in case zero. Excel shows") for b in s["share"]["blockers"])
    code, doc = sign(capsys, root, "--tile", "share")
    assert code == 1, doc


def test_a_tile_with_only_finite_values_reports_none(built, capsys):
    for entry in status(capsys, built)["tiles"].values():
        assert entry["undefined"] == {"declared": None, "cases": {}}


def test_undefined_line_is_parsed_with_its_continuation():
    from tilekit.graph import parse_docstring
    doc = parse_docstring('''Rate.

    The rate.

    Format: number
    Undefined: when there are no premiums,
        or no sign change.
    Assumed: something.
    ''')
    assert doc.undefined == "when there are no premiums, or no sign change." and doc.assumed == ("something.",)
    assert parse_docstring("Rate.\n\nFormat: number\nUndefined:\n").undefined is None  # an empty line declares nothing


# ---------------------------------------------------------------- 2. the tile's own test

def test_a_tile_needs_its_test_to_have_passed_since_the_last_change(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["test"]["result"] == "none" and "It has no hand-calculation test" in t["blockers"][0]

    folder = root / "tests" / "tiles"
    folder.mkdir(parents=True)
    (folder / "test_doubled.py").write_text("def test_doubled_by_hand():\n    assert 1 + 1 == 3\n")
    rebuild(capsys, root, tests=False)
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["test"]["result"] == "not_run" and not t["can_sign_off"]
    assert t["blockers"] == ["Its hand-calculation test (tests/tiles/test_doubled.py) has not been run since the "
                             "last change; run it first."]
    run(capsys, root, "test")
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["test"]["result"] == "failed"
    assert t["blockers"] == ["Its hand-calculation test (tests/tiles/test_doubled.py) fails."]
    code, doc = sign(capsys, root, "--tile", "doubled")
    assert code == 1 and "fails" in doc["error"]["message"]

    (folder / "test_doubled.py").write_text("def test_doubled_by_hand():\n    assert 1 + 1 == 2\n")
    assert status(capsys, root)["tiles"]["doubled"]["test"]["result"] == "not_run"  # edited since it ran
    run_tests(capsys, root)
    t = status(capsys, root)["tiles"]["doubled"]
    assert t["test"]["result"] == "passed" and t["can_sign_off"], t["blockers"]
    code, doc = sign(capsys, root, "--tile", "doubled")
    assert code == 0, doc
    signed = json.loads((root / "review/tiles/doubled/signoff.json").read_text())
    assert signed["test"] == {"file": "tests/tiles/test_doubled.py", "sha256": digest(folder / "test_doubled.py")}


def test_a_change_to_the_model_means_the_test_must_be_run_again(built, capsys):
    assert status(capsys, built)["tiles"]["balance_eop"]["can_sign_off"]
    edit(built, "second", "grown + doubled", "doubled + grown")
    rebuild(capsys, built, tests=False)
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["test"]["result"] == "not_run" and not t["can_sign_off"]
    code, doc = sign(capsys, built, "--tile", "balance_eop")
    assert code == 1 and "has not been run since the last change" in doc["error"]["message"]


def test_running_one_tile_test_on_its_own_counts_for_that_tile_only(built, capsys):
    edit(built, "second", "grown + doubled", "doubled + grown")
    rebuild(capsys, built, tests=False)  # the model changed: nothing counts as run
    code, doc = run(capsys, built, "test", "--file", "tests/tiles/test_balance_eop.py")
    assert code == 0 and doc["passed"] == 1 and doc["file"] == "tests/tiles/test_balance_eop.py"
    cache = json.loads((built / "review/model/tests.json").read_text())
    assert cache["partial"] is True and set(cache["files"]) == {"tests/tiles/test_balance_eop.py"}
    s = status(capsys, built)
    assert s["tiles"]["balance_eop"]["test"]["result"] == "passed" and s["tiles"]["balance_eop"]["can_sign_off"]
    assert s["tiles"]["doubled"]["test"]["result"] == "not_run" and not s["tiles"]["doubled"]["can_sign_off"]
    # the model's own test checks are not satisfied by a run of one file
    assert any("Model test check failed" in b and "stale" in b for b in s["model"]["blockers"]), s["model"]["blockers"]
    assert all(not c["pass"] for c in s["model"]["checks"] if c["name"].startswith("Model tests pass"))
    code, doc = sign(capsys, built, "--tile", "balance_eop")
    assert code == 0, doc

    # a second file joins the same cache; a full run then replaces it and is no longer partial
    run(capsys, built, "test", "--file", "tests/tiles/test_doubled.py")
    cache = json.loads((built / "review/model/tests.json").read_text())
    assert cache["partial"] is True and len(cache["files"]) == 2 and cache["passed"] == 2
    run_tests(capsys, built)
    cache = json.loads((built / "review/model/tests.json").read_text())
    assert "partial" not in cache and len(cache["files"]) == 4
    assert any(c["name"].startswith("Model tests pass") and c["pass"] for c in status(capsys, built)["model"]["checks"])


def test_one_file_run_on_a_current_cache_replaces_only_that_file(built, capsys):
    before = json.loads((built / "review/model/tests.json").read_text())
    path = built / "tests/tiles/test_doubled.py"
    path.write_text("def test_doubled_by_hand():\n    assert 1 + 1 == 3\n")
    code, doc = run(capsys, built, "test", "--file", "tests/tiles/test_doubled.py")
    assert doc["failed"] == 1
    cache = json.loads((built / "review/model/tests.json").read_text())
    assert "partial" not in cache and cache["stamp"] == before["stamp"]
    assert cache["files"]["tests/tiles/test_doubled.py"] == {"sha256": digest(path), "passed": 0, "failed": 1, "skipped": 0}
    others = {k: v for k, v in cache["files"].items() if k != "tests/tiles/test_doubled.py"}
    assert others == {k: v for k, v in before["files"].items() if k != "tests/tiles/test_doubled.py"}
    assert (cache["passed"], cache["failed"]) == (before["passed"] - 1, 1)
    s = status(capsys, built)
    assert s["tiles"]["doubled"]["test"]["result"] == "failed"
    assert s["tiles"]["balance_eop"]["test"]["result"] == "passed"


def test_a_test_changed_after_sign_off_shows_in_the_queue_and_never_makes_it_stale(built, capsys):
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code == 0, doc
    signed = (built / "review/tiles/doubled/signoff.json").read_text()
    assert not any(i["id"] == "doubled" for i in queue(capsys, built)["items"] if i["level"] == "tile")

    path = built / "tests/tiles/test_doubled.py"
    path.write_text("def test_doubled_by_hand():\n    assert 2 + 2 == 4\n")
    rebuild(capsys, built, tests=False)  # a changed test asks for the tile's workbook to be rebuilt, nothing more
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["drift"] is None  # the sign-off stands
    assert t["test"] == {"file": "tests/tiles/test_doubled.py", "result": "not_run", "changed_since_signoff": True}
    assert not t["can_sign_off"]  # a new sign-off waits for the changed test to be run
    doc = queue(capsys, built)
    item = next(i for i in doc["items"] if i["level"] == "tile" and i["id"] == "doubled")
    assert item["kind"] == "test_changed" and item["reconfirm"] is None
    assert item["reason"] == ("Its test changed after sign-off: the sign-off stands, but look at the test and sign "
                              "the tile off again.")
    assert doc["counts"]["kinds"]["test_changed"] == 1
    assert (built / "review/tiles/doubled/signoff.json").read_text() == signed
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code == 1 and "has not been run since the last change" in doc["error"]["message"]

    # run it, sign off again: the new sign-off records the new test and the queue item goes
    run(capsys, built, "test", "--file", "tests/tiles/test_doubled.py")
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code == 0, doc
    assert json.loads((built / "review/tiles/doubled/signoff.json").read_text())["test"]["sha256"] == digest(path)
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["test"]["changed_since_signoff"] is False
    assert not any(i["id"] == "doubled" for i in queue(capsys, built)["items"] if i["level"] == "tile")


def test_a_test_removed_after_sign_off_shows_in_the_queue(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    (built / "tests/tiles/test_doubled.py").unlink()
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["test"]["result"] == "none" and t["test"]["changed_since_signoff"] is True
    item = next(i for i in queue(capsys, built)["items"] if i["level"] == "tile" and i["id"] == "doubled")
    assert item["kind"] == "test_changed" and item["reason"].startswith("Its test was removed after sign-off")


def test_a_sign_off_from_before_tests_were_recorded_is_not_flagged(built, capsys):
    sign(capsys, built, "--tile", "doubled")
    path = built / "review/tiles/doubled/signoff.json"
    document = json.loads(path.read_text())
    del document["test"]
    path.write_text(json.dumps(document))
    (built / "tests/tiles/test_doubled.py").write_text("def test_doubled_by_hand():\n    assert 2 + 2 == 4\n")
    t = status(capsys, built)["tiles"]["doubled"]
    assert t["state"] == "signed_off" and t["test"]["changed_since_signoff"] is False


def test_reconfirm_waits_for_the_tests_to_be_run_on_the_changed_model(built, capsys):
    for tile in ("doubled", "balance_eop", "weighted"):
        assert sign(capsys, built, "--tile", tile)[0] == 0
    edit(built, "first", "x + x", "x * 2")  # upstream of the other two: values drift there
    item = lambda name: next(i for i in queue(capsys, built)["items"] if i["id"] == name and i["level"] == "tile")
    assert item("balance_eop")["reconfirm"] == "after_rebuild"
    rebuild(capsys, built, tests=False)
    s = status(capsys, built)["tiles"]
    assert s["balance_eop"]["test"]["result"] == "not_run" and not s["balance_eop"]["can_sign_off"]
    assert s["balance_eop"]["reconfirm_blockers"] == s["balance_eop"]["blockers"]
    # rebuilt, and the only thing in the way is that the tests have not been run on the changed model
    assert item("balance_eop")["reconfirm"] == "after_tests" and item("balance_eop")["kind"] == "values_drift"
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == []
    assert {s["name"]: s["reason"] for s in doc["skipped"]}["balance_eop"] == (
        "its test has not been run on the changed model; run the tests first")
    # a test changed since sign-off is never re-confirmed in bulk, run or not
    (built / "tests/tiles/test_weighted.py").write_text("def test_weighted_by_hand():\n    assert 2 + 2 == 4\n")
    rebuild(capsys, built)  # rebuilds for the changed test and runs the tests
    assert item("balance_eop")["reconfirm"] == "ready"
    doc = item("weighted")
    assert doc["reconfirm"] is None and [r["kind"] for r in doc["reasons"]] == ["values_drift", "test_changed"]
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == ["balance_eop"], doc
    assert "Its test changed after sign-off" in {s["name"]: s["reason"] for s in doc["skipped"]}["weighted"]
    signed = json.loads((built / "review/tiles/balance_eop/signoff.json").read_text())
    assert signed["test"]["sha256"] == digest(built / "tests/tiles/test_balance_eop.py")


def test_reconfirm_never_renews_an_old_sign_off_on_a_test_that_has_not_run(built, capsys):
    """A sign-off made before tests were recorded has no `test`: its test still has to pass on the model as it is."""
    assert sign(capsys, built, "--tile", "balance_eop")[0] == 0
    path = built / "review/tiles/balance_eop/signoff.json"
    document = json.loads(path.read_text())
    del document["test"]
    path.write_text(json.dumps(document))
    signed = path.read_text()
    edit(built, "first", "x + x", "x * 2")
    test = built / "tests/tiles/test_balance_eop.py"
    test.write_text(test.read_text() + "\n\ndef test_bad():\n    assert False\n")
    rebuild(capsys, built, tests=False)
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == [] and path.read_text() == signed
    run(capsys, built, "test")
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == [] and "fails" in doc["skipped"][0]["reason"] and path.read_text() == signed


def test_reconfirm_skips_a_tile_whose_test_fails(built, capsys):
    assert sign(capsys, built, "--tile", "balance_eop")[0] == 0
    signed = (built / "review/tiles/balance_eop/signoff.json").read_text()
    edit(built, "first", "x + x", "x * 2")
    rebuild(capsys, built, tests=False)
    # the same test file, but the cache says it failed when last run on this model
    cache_path = built / "review/model/tests.json"
    run(capsys, built, "test")
    cache = json.loads(cache_path.read_text())
    cache["files"]["tests/tiles/test_balance_eop.py"].update(passed=0, failed=1)
    cache_path.write_text(json.dumps(cache))
    code, doc = run(capsys, built, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == [] and "fails" in doc["skipped"][0]["reason"]
    assert (built / "review/tiles/balance_eop/signoff.json").read_text() == signed


# ---------------------------------------------------------------- undefined values and re-confirmation

NAN_BY_SIZE = '''
import numpy as np


def ratio(x, cap):
    """Ratio.

    The cap over x less six.

    Format: number
    Undefined: when x is six.
    """
    return cap / (x - (1 + 1 + 1 + 1 + 1 + 1))
'''


@pytest.mark.filterwarnings("ignore:divide by zero encountered")
def test_reconfirm_is_refused_when_the_undefined_cells_have_moved(make_model, gridcraft_cli, capsys):
    cases = {"one": {"id": "one", "name": "One", "purpose": "p", "model_point": {"size": 1.0}}}  # x = month: month 6
    root = make_model(modules={"first": {"source": NAN_BY_SIZE, "layer": "A"}}, states={}, cases=cases)
    pass_tile_tests(capsys, root)
    code, doc = sign(capsys, root, "--tile", "ratio")
    assert code == 0, doc
    signed = json.loads((root / "review/tiles/ratio/signoff.json").read_text())
    assert signed["undefined_cases"] == {"one": {"count": 1, "first_month": 6}}
    # the case changes (values drift): x = 2 * month, so the undefined month is now month 3
    (root / "cases/one.json").write_text(json.dumps({**cases["one"], "model_point": {"size": 2.0}}))
    rebuild(capsys, root)
    t = status(capsys, root)["tiles"]["ratio"]
    assert (t["state"], t["drift"]) == ("stale", "values")
    assert t["undefined"]["cases"] == {"one": {"count": 1, "first_month": 3}}
    assert t["reconfirm_blockers"] == ["The places where its value is not a number have changed since sign-off; "
                                       "review it again."]
    code, doc = run(capsys, root, "reconfirm", "--reviewer", "Pat")
    assert doc["reconfirmed"] == [] and "have changed since sign-off" in doc["skipped"][0]["reason"]


# ---------------------------------------------------------------- the model's own test checks

def test_model_test_checks_are_stale_when_the_test_files_are_not_the_ones_that_ran(built, capsys):
    model_checks = lambda: [c for c in status(capsys, built)["model"]["checks"] if c["name"].startswith("Model tests pass")]
    assert model_checks()[0]["pass"] is True
    (built / "tests" / "test_invariants.py").write_text("def test_never():\n    assert False\n")  # added since the run
    check = model_checks()[0]
    assert check["pass"] is False and check["stale"] is True
    assert any("results are stale" in b for b in status(capsys, built)["model"]["blockers"])
    run(capsys, built, "test")
    assert model_checks()[0]["pass"] is False  # run now, and it fails
    (built / "tests" / "test_invariants.py").unlink()  # removed since the run: stale again
    assert model_checks()[0].get("stale") is True
