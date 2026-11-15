"""Faults found by review on 2026-11-15, each of which let a sign-off stand, or be given, on something unchecked.

A. A module's check may read a tile of another module (or a state carried forward from one): that tile and what is
   upstream of it are upstream of the module, so the module's sign-off goes stale when they change.
B. A module kept through a new case needs its reconciliations to hold, not only the sheet to agree with Python.
C. The test cache records the model as it stood before the run, and the files the tests lean on (conftest.py).
D. A hand check's constant is a name bound exactly once in the whole test file.
E. A test file whose tests were all skipped is not a pass.
"""

import json
import subprocess
import textwrap

import pytest

from tilekit import handchecks, load_model
from tilekit.stamps import check_tiles, module_stamp

from test_tk_module_sections import CASES, MODULES, STATES, _tile_tests, configure
from test_tk_review import edit, rebuild, run, run_tests, sign, status
from test_tk_review import CASES as REVIEW_CASES, MODULES as REVIEW_MODULES
from test_tk_review import built  # noqa: F401
from test_tk_signoff_safety import add_case


@pytest.fixture
def roll(make_model):
    root = make_model(modules=MODULES, states=STATES, cases=CASES)
    _tile_tests(root)
    return root


def check(name, expression, extra=""):
    return f'\n[[module.check]]\nname = "{name}"\nlabel = "{name}"\nexpression = "{expression}"\n{extra}'


def ready(capsys, root):
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    run_tests(capsys, root)


# ---------------------------------------------------------------- A

def test_a_module_goes_stale_when_a_tile_its_check_reads_changes(roll, gridcraft_cli, capsys):
    # `other` holds only `half`, which reads nothing of `roll`; its check reads `inflow`, a tile of `roll`
    configure(roll, "other", check("inflow_is_x_times_growth", "inflow - x * growth_pm"))
    assert check_tiles(load_model(roll), load_model(roll).config.module("other")) == {"inflow"}
    ready(capsys, roll)
    assert sign(capsys, roll, "--tile", "half")[0] == 0
    code, doc = sign(capsys, roll, "--module", "other")
    assert code == 0, doc
    before = module_stamp(load_model(roll), "other")

    edit(roll, "roll", "return x * growth_pm", "return x * growth_pm * (1 + 1)")
    for key in [k for k in __import__("sys").modules if k == roll.name or k.startswith(roll.name + ".")]:
        del __import__("sys").modules[key]
    after = module_stamp(load_model(roll), "other")
    assert after["upstream"] != before["upstream"] and after["code"] == before["code"]
    m = status(capsys, roll)["modules"]["other"]
    assert (m["state"], m["drift"]) == ("stale", "values")  # the sign-off no longer stands on the old numbers
    assert status(capsys, roll)["tiles"]["half"]["state"] == "signed_off"  # the tile itself reads nothing that moved
    # the rebuild is no longer skipped, and the check now fails
    code, doc = run(capsys, roll, "build")
    assert any(b["kind"] == "module" and b["name"] == "other" for b in doc["built"]), doc
    m = status(capsys, roll)["modules"]["other"]
    assert m["reconciliations"][0]["pass"] is False and not m["can_sign_off"]


def test_a_check_reading_a_state_follows_the_tile_it_is_carried_from(roll, gridcraft_cli, capsys):
    configure(roll, "other", check("opening_balance", "balance_bop - balance_bop"))
    model = load_model(roll)
    assert check_tiles(model, model.config.module("other")) == {"balance_eop"}
    before = module_stamp(model, "other")
    edit(roll, "roll", "return balance_bop * growth_pm", "return growth_pm * balance_bop")  # outflow, upstream of balance_eop
    for key in [k for k in __import__("sys").modules if k == roll.name or k.startswith(roll.name + ".")]:
        del __import__("sys").modules[key]
    assert module_stamp(load_model(roll), "other")["upstream"] != before["upstream"]


def test_a_check_on_the_modules_own_tiles_leaves_its_upstream_alone(roll):
    model = load_model(roll)
    plain = module_stamp(model, "roll")
    configure(roll, "roll", check("balance_reconciles", "balance_bop + inflow - outflow - balance_eop"))
    for key in [k for k in __import__("sys").modules if k == roll.name or k.startswith(roll.name + ".")]:
        del __import__("sys").modules[key]
    with_check = module_stamp(load_model(roll), "roll")
    assert with_check["upstream"] == plain["upstream"] and with_check["layout"] != plain["layout"]


# ---------------------------------------------------------------- B

def test_a_new_case_that_breaks_a_reconciliation_makes_the_module_and_model_stale(roll, gridcraft_cli, capsys):
    # holds for the two small cases (largest value 0.00012), fails for a big one
    configure(roll, "roll", check("inflow_is_small", "inflow * 0.001", "tolerance = 0.001\n"))
    ready(capsys, roll)
    for tile in ("inflow", "outflow", "balance_eop", "half", "total_inflow"):
        assert sign(capsys, roll, "--tile", tile)[0] == 0
    for module in ("roll", "other", "totals"):
        code, doc = sign(capsys, roll, "--module", module)
        assert code == 0, doc
    code, doc = sign(capsys, roll, "--whole-model")
    assert code == 0, doc

    add_case(roll, "big", 1000.0)
    rebuild(capsys, roll)
    s = status(capsys, roll)
    sidecar = json.loads((roll / "review/modules/roll/workbook.json").read_text())
    assert sidecar["checks_pass"] is True and sidecar["reconciliations"][0]["pass"] is False
    assert s["tiles"]["inflow"]["state"] == "signed_off" and s["tiles"]["inflow"]["new_cases"] == ["big"]
    assert s["modules"]["other"]["state"] == "signed_off" and s["modules"]["other"]["new_cases"] == ["big"]
    assert s["modules"]["roll"]["state"] == "stale"  # not kept: its reconciliation fails in the new case
    assert s["model"]["state"] == "stale"


# ---------------------------------------------------------------- C

def test_an_edit_made_while_the_tests_run_is_not_recorded_as_tested(built, capsys, monkeypatch):  # noqa: F811
    real = subprocess.run

    def run_then_edit(*args, **kwargs):
        result = real(*args, **kwargs)
        # the model changes while pytest is running: a case file, which the stamp reads from disk when it is taken
        case = next((built / "cases").glob("*.json"))
        document = json.loads(case.read_text())
        document["purpose"] = "Changed while the tests ran."
        case.write_text(json.dumps(document))
        return result

    monkeypatch.setattr(subprocess, "run", run_then_edit)
    code, doc = run(capsys, built, "test")
    assert code == 0 and doc["failed"] == 0
    monkeypatch.setattr(subprocess, "run", real)
    t = status(capsys, built)["tiles"]["balance_eop"]
    assert t["test"]["result"] == "not_run"  # the cache is for the model as it stood before the run


def test_a_changed_conftest_makes_the_test_cache_stale(built, capsys):  # noqa: F811
    assert status(capsys, built)["tiles"]["doubled"]["test"]["result"] == "passed"
    (built / "tests" / "conftest.py").write_text("import pytest\n")
    s = status(capsys, built)
    assert {t["test"]["result"] for t in s["tiles"].values()} == {"not_run"}
    assert any("stale" in b for b in s["model"]["blockers"])
    run_tests(capsys, built)
    assert status(capsys, built)["tiles"]["doubled"]["test"]["result"] == "passed"
    # a cache written before support files were recorded counts as stale
    path = built / "review/model/tests.json"
    cache = json.loads(path.read_text())
    del cache["support"]
    path.write_text(json.dumps(cache))
    assert status(capsys, built)["tiles"]["doubled"]["test"]["result"] == "not_run"


# ---------------------------------------------------------------- D

REBOUND = '''
    """doubled worked by hand."""

    SHADOWED = 50.0
    AUGMENTED = 3.0
    AUGMENTED += 1
    LOOPED = 2.0
    PAIR, OTHER = 1.0, 2.0
    ARGUMENT = 6.0
    ONCE = 2.0

    for LOOPED in (5.0,):
        pass


    def test_shadowed():
        SHADOWED = 10.0
        assert doubled(SHADOWED) == 20.0


    def test_augmented():
        assert doubled(AUGMENTED) == 8.0


    def test_looped():
        assert doubled(LOOPED) == 10.0


    def test_unpacked():
        assert doubled(PAIR) == 2.0


    def test_argument(ARGUMENT=7.0):
        assert doubled(ARGUMENT) == 14.0


    def test_once():
        assert doubled(ONCE) == 4.0
'''


def test_a_hand_check_constant_is_a_name_bound_exactly_once(make_model):
    root = make_model(modules=REVIEW_MODULES, cases=REVIEW_CASES)
    path = root / "tests" / "tiles" / "test_doubled.py"
    path.parent.mkdir(parents=True)
    path.write_text(textwrap.dedent(REBOUND) + f"\n\nfrom {root.name}.first import doubled  # noqa: E402\n")
    found = handchecks.extract(load_model(root), "doubled")
    assert [(c["test"], c["args"]) for c in found["checks"]] == [("test_once", {"x": 2.0})]
    assert found["not_in_sheet"] == ["test_shadowed", "test_augmented", "test_looped", "test_unpacked",
                                     "test_argument"]


# ---------------------------------------------------------------- E

def test_a_test_file_whose_tests_were_all_skipped_is_not_a_pass(built, capsys):  # noqa: F811
    path = built / "tests/tiles/test_doubled.py"
    path.write_text("import pytest\n\n\n@pytest.mark.skip(reason=\"its case was removed\")\n"
                    "def test_doubled_by_hand():\n    assert 1 + 1 == 2\n")
    rebuild(capsys, built)
    cache = json.loads((built / "review/model/tests.json").read_text())
    assert cache["files"]["tests/tiles/test_doubled.py"]["skipped"] == 1
    s = status(capsys, built)
    t = s["tiles"]["doubled"]
    assert t["test"]["result"] == "not_run" and not t["can_sign_off"]
    assert t["blockers"] == ["Every test in its hand-calculation test (tests/tiles/test_doubled.py) was skipped, "
                             "so nothing was checked."]
    assert t["reconfirm_blockers"] == t["blockers"]  # nor is it re-confirmed in bulk
    assert s["modules"]["first"]["tile_tests"]["tiles"]["doubled"]["tests"] == "not_run"
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code == 1 and "was skipped" in doc["error"]["message"]
