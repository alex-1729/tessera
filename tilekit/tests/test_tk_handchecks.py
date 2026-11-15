"""Hand checks: the plain checks of a tile's hand-calculation test are run by its Excel formula too.

They are read from the test file, laid out on a `Hand checks` sheet of the tile workbook, and reported in the
status. They are not part of a stamp: a changed test asks for a rebuild and blocks a new sign-off until then,
but never makes an existing sign-off stale.
"""

import json
import textwrap

import pytest

from tilekit import handchecks, load_model
from tilekit.xlsxread import Xlsx

from test_tk_review import CASES, MODULES, rebuild, run, sign, status


@pytest.fixture
def built(make_model, gridcraft_cli, capsys):
    root = make_model(modules=MODULES, cases=CASES)
    code, doc = run(capsys, root, "build")
    assert code == 0, doc
    return root


def write_test(root, tile, body):
    path = root / "tests" / "tiles" / f"test_{tile}.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body))
    return path


BALANCE = '''
    """balance_eop worked by hand."""

    import pytest

    TOL = dict(rel=0, abs=1e-9)
    CAP = 50.0


    def test_grows_and_adds():
        """100 grown by 1% is 101, plus 4, under the cap of 500."""
        assert balance_eop(100.0, 4.0, 0.01, 500.0) == pytest.approx(105.0, **TOL)
        assert balance_eop(0.0, 2.0, growth_pm=0.01, cap=CAP) == 2.0


    def test_capped():
        """40 grown by 10% is 44, plus 20 is 64, capped at 50."""
        assert balance_eop(40.0, 20.0, 1 / 10, CAP) == pytest.approx(50.0, rel=0, abs=1e-9)


    def test_direction():
        """A bigger opening balance gives a bigger closing one."""
        assert balance_eop(10.0, 1.0, 0.01, 500.0) < balance_eop(20.0, 1.0, 0.01, 500.0)


    def test_loop():
        for x in (1.0, 2.0):
            assert balance_eop(0.0, x, 0.0, 500.0) == x
'''


def test_extract_reads_plain_checks_and_names_the_rest(make_model):
    root = make_model(modules=MODULES, cases=CASES)
    write_test(root, "balance_eop", BALANCE)
    found = handchecks.extract(load_model(root), "balance_eop")
    assert [(c["test"], c["index"]) for c in found["checks"]] == [
        ("test_grows_and_adds", 1), ("test_grows_and_adds", 2), ("test_capped", 1)]
    first, second, capped = found["checks"]
    assert first["args"] == {"balance_bop": 100.0, "doubled": 4.0, "growth_pm": 0.01, "cap": 500.0}
    assert first["expected"] == 105.0 and first["tolerance"] == 1e-9
    assert second["args"]["cap"] == 50.0 and second["expected"] == 2.0  # keywords and a module-level constant
    assert capped["args"]["growth_pm"] == pytest.approx(0.1)  # simple arithmetic on numbers
    assert found["not_in_sheet"] == ["test_direction", "test_loop"]


def test_no_test_file_means_no_checks_and_a_stable_digest(make_model):
    model = load_model(make_model(modules=MODULES, cases=CASES))
    none = handchecks.extract(model, "doubled")
    assert none["checks"] == [] and none["not_in_sheet"] == []
    assert none["digest"] == handchecks.extract(model, "doubled")["digest"]
    assert handchecks.current({}, none)  # an older sidecar is current while there is nothing to show


def test_summary_tiles_are_not_laid_out(make_model):
    root = make_model(modules=MODULES, cases=CASES)
    model = load_model(root)
    summary = model.graph.summary_order()[0]
    args = ", ".join("1.0" for _ in model.graph.tiles[summary].args)
    write_test(root, summary, f'''
        def test_it():
            assert {summary}({args}) == 1.0
    ''')
    found = handchecks.extract(load_model(root), summary)
    assert found["checks"] == [] and found["not_in_sheet"] == ["test_it"]


def test_build_lays_the_checks_out_and_excel_agrees(built, capsys):
    write_test(built, "balance_eop", BALANCE)
    s = status(capsys, built)["tiles"]["balance_eop"]
    assert s["workbook_current"] is False and s["hand_checks"] is None
    assert any("before its test last changed" in b for b in s["blockers"]) and not s["can_sign_off"]
    code, built_now = run(capsys, built, "build")
    assert code == 0 and any(b["kind"] == "tile" and b["name"] == "balance_eop" for b in built_now["built"])
    s = status(capsys, built)["tiles"]["balance_eop"]
    hand = s["hand_checks"]
    assert s["workbook_current"] is True and s["can_sign_off"], s["blockers"]
    assert hand["sheet"] == "Hand checks" and hand["checks_pass"] is True
    assert [c["excel"] for c in hand["checks"]] == pytest.approx([105.0, 2.0, 50.0])
    assert all(c["pass"] for c in hand["checks"]) and hand["not_in_sheet"] == ["test_direction", "test_loop"]
    # the sheet is in the workbook after the case sheets, and a second build has nothing to do
    book = Xlsx(built / "review/tiles/balance_eop/workbook.xlsx")
    assert "Hand checks" in book.sheets and book.sheets.index("Hand checks") == len(CASES)
    code, again = run(capsys, built, "build")
    assert code == 0 and not again["built"]


def test_a_wrong_hand_figure_blocks_sign_off(built, capsys):
    write_test(built, "doubled", '''
        def test_wrong():
            """3 doubled is 6, not 7."""
            assert doubled(3.0) == 7.0
    ''')
    rebuild(capsys, built)
    s = status(capsys, built)["tiles"]["doubled"]
    assert s["hand_checks"]["checks_pass"] is False and s["hand_checks"]["checks"][0]["excel"] == 6.0
    assert s["checks_pass"] is True  # the cases still agree with Python: this is a separate check
    assert any("does not agree with the hand calculation in test_wrong" in b for b in s["blockers"])
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code != 0, doc


def test_a_changed_test_never_makes_a_sign_off_stale(built, capsys):
    write_test(built, "doubled", '''
        def test_one():
            assert doubled(3.0) == 6.0
    ''')
    rebuild(capsys, built)
    code, doc = sign(capsys, built, "--tile", "doubled")
    assert code == 0, doc
    signed = json.loads((built / "review/tiles/doubled/signoff.json").read_text())
    write_test(built, "doubled", '''
        def test_one():
            assert doubled(3.0) == 6.0


        def test_two():
            assert doubled(4.0) == 8.0
    ''')
    s = status(capsys, built)["tiles"]["doubled"]
    assert s["state"] == "signed_off" and s["drift"] is None  # the sign-off stands
    assert s["workbook_current"] is False  # but the workbook wants a rebuild
    rebuild(capsys, built)
    s = status(capsys, built)["tiles"]["doubled"]
    assert s["state"] == "signed_off" and s["workbook_current"] is True
    assert len(s["hand_checks"]["checks"]) == 2 and s["hand_checks"]["checks_pass"] is True
    assert json.loads((built / "review/tiles/doubled/signoff.json").read_text()) == signed
