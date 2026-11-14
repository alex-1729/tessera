import json

import numpy as np
import pytest

from conftest import GOOD_STEP
from tilekit.cli import main
from tilekit.config import load_model
from tilekit.cases import case_params
from tilekit.engine import project


def run(capsys, *argv):
    code = main([str(a) for a in argv])
    return code, json.loads(capsys.readouterr().out)


def write_csv(path, rows, header=("policy_id", "size")):
    path.write_text("\n".join([",".join(header)] + [",".join(str(c) for c in r) for r in rows]) + "\n")
    return path


@pytest.fixture
def model(make_model):
    return make_model()


def make_run(capsys, model, tmp_path, rows=None, name="r1"):
    rows = rows if rows is not None else [("A1", 1), ("B2", 3), ("C3", 10), ("D4", 0.5)]
    csv_file = write_csv(tmp_path / "pf.csv", rows)
    code, doc = run(capsys, "run", "--model", model, "--model-points", csv_file, "--name", name)
    assert code == 0, doc
    return doc


def test_csv_validation(model, capsys, tmp_path):
    def attempt(rows, header=("policy_id", "size"), name="bad"):
        f = write_csv(tmp_path / "x.csv", rows, header)
        return run(capsys, "run", "--model", model, "--model-points", f, "--name", name)

    code, doc = attempt([("A", 1)], header=("policy_id", "other"))
    assert code == 1 and doc["error"]["detail"]["missing_columns"] == ["size"]
    code, doc = attempt([("A", 1), ("B", "abc"), ("C", "")])
    assert code == 1
    bad = doc["error"]["detail"]["bad_rows"]
    assert [(b["row"], b["column"]) for b in bad] == [(3, "size"), (4, "size")]
    code, doc = attempt([("A", 1), ("A", 2)])
    assert code == 1 and "repeats" in doc["error"]["detail"]["bad_rows"][0]["problem"]
    code, doc = attempt([("A", "inf")])
    assert code == 1
    code, doc = attempt([("A", 1)], name="../evil")
    assert code == 1 and "run name" in doc["error"]["message"]
    assert not (model / "real-data").exists()


def test_run_matches_per_policy_project(model, capsys, tmp_path):
    rng = np.random.default_rng(1)
    rows = [(f"P{i}", round(float(rng.uniform(0, 12)), 3)) for i in range(500)]
    doc = make_run(capsys, model, tmp_path, rows)
    assert doc["policies"] == 500 and doc["months"] == 6 and set(doc["summary_totals"]) == {"total_doubled"}

    folder = model / "real-data" / "runs" / "r1"
    run_json = json.loads((folder / "run.json").read_text())
    assert run_json["fields"] == ["size"] and run_json["id_column"] == "policy_id" and run_json["policies"] == 500
    assert (folder / "model_points.csv").is_file()
    loaded = load_model(model)
    params = loaded.default_params()
    with np.load(folder / "results.npz") as stored:
        assert stored["balance_eop"].shape == (6, 500) and stored["total_doubled"].shape == (500,)
        for i in (0, 7, 123, 499):
            one = project(loaded, {"size": np.array([rows[i][1]])}, params, 6)
            for name, values in one.items():
                expected = values[0, 0] if name == "total_doubled" else values[:, 0, 0]
                got = stored[name][i] if name == "total_doubled" else stored[name][:, i]
                assert np.allclose(got, expected, rtol=0, atol=1e-12), name
    totals = json.loads((folder / "totals.json").read_text())
    assert set(totals["totals"]) >= {"doubled", "balance_eop"} and len(totals["totals"]["doubled"]) == 6
    assert "total_doubled" not in totals["totals"]


def test_policies_sort_page_search_flags(model, capsys, tmp_path):
    make_run(capsys, model, tmp_path)
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1")
    assert code == 0 and doc["total"] == 4 and [p["id"] for p in doc["policies"]] == ["A1", "B2", "C3", "D4"]
    first = doc["policies"][0]
    assert first["model_point"] == {"size": 1} and set(first["headline"]) == {"total_doubled"}
    # size 1 is the only synthetic case; bigger policies hit the cap, so "min: second" is uncovered
    flagged = {p["id"] for p in doc["policies"] if "uncovered" in p["flags"]}
    assert flagged == {"B2", "C3"} or flagged == {"C3"}
    assert doc["flags"] == {"uncovered": len(flagged), "nan": 0, "undefined": 0}

    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--sort", "size", "--desc")
    assert [p["id"] for p in doc["policies"]] == ["C3", "B2", "A1", "D4"]
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--sort", "total_doubled", "--limit", "2",
                    "--offset", "1")
    assert [p["id"] for p in doc["policies"]] == ["A1", "B2"] and doc["total"] == 4
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--search", "c")
    assert [p["id"] for p in doc["policies"]] == ["C3"] and doc["total"] == 1
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--flag", "uncovered")
    assert {p["id"] for p in doc["policies"]} == flagged
    assert (model / "real-data" / "runs" / "r1" / "signatures.npz").is_file()
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--sort", "nonsense")
    assert code == 1 and "keys" in doc["error"]["detail"]
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--flag", "bogus")
    assert code == 1


def test_nan_flag_and_headline(make_model, capsys, tmp_path):
    source = GOOD_STEP.replace("return x + x", "return x / x + x")  # 0/0 gives NaN for size 0
    model = make_model(modules={"step_mod": {"source": source, "layer": "A"}})
    toml = model / "tilekit.toml"
    toml.write_text(toml.read_text() + '\n[runs]\nheadline = ["balance_eop"]\n')
    make_run(capsys, model, tmp_path, rows=[("A", 1), ("Z", 0)])
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--flag", "nan")
    assert code == 0 and [p["id"] for p in doc["policies"]] == ["Z"] and doc["flags"]["nan"] == 1
    assert "nan" in doc["policies"][0]["flags"] and "undefined" not in doc["policies"][0]["flags"]
    assert doc["policies"][0]["headline"]["balance_eop"] is None
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--sort", "balance_eop", "--desc")
    assert [p["id"] for p in doc["policies"]] == ["A", "Z"]  # NaN sorts last


def test_undefined_flag_is_a_non_finite_summary(make_model, capsys, tmp_path):
    from conftest import GOOD_SUMMARY
    ratio = GOOD_SUMMARY.replace("return np.sum(doubled, axis=0)",
                                 "return np.sum(doubled, axis=0) / np.sum(doubled, axis=0)")
    model = make_model(modules={"step_mod": {"source": GOOD_STEP, "layer": "A"},
                                "summary_mod": {"source": ratio, "layer": "B", "timing": "summary"}})
    make_run(capsys, model, tmp_path, rows=[("A", 1), ("Z", 0)])
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1")
    flags = {p["id"]: p["flags"] for p in doc["policies"]}
    assert "undefined" in flags["Z"] and "nan" not in flags["Z"] and "undefined" not in flags["A"]
    assert doc["flags"]["undefined"] == 1 and doc["flags"]["nan"] == 0
    code, doc = run(capsys, "policies", "--model", model, "--run", "r1", "--flag", "undefined")
    assert [p["id"] for p in doc["policies"]] == ["Z"]


def test_summary_totals_cover_amounts_only(make_model, capsys, tmp_path):
    from conftest import GOOD_SUMMARY
    extra = GOOD_SUMMARY + '''

def share(total_doubled, cap):
    """Share.

    Total over cap.

    Format: percent
    """
    return total_doubled / cap
'''
    model = make_model(modules={"step_mod": {"source": GOOD_STEP, "layer": "A"},
                                "summary_mod": {"source": extra, "layer": "B", "timing": "summary"}})
    doc = make_run(capsys, model, tmp_path)
    assert set(doc["summary_totals"]) == {"total_doubled"}


def test_trace_run(model, capsys, tmp_path):
    make_run(capsys, model, tmp_path)
    code, doc = run(capsys, "trace", "--model", model, "--run", "r1", "--policy", "C3")
    assert code == 0 and doc["case"] is None and doc["run"] == "r1" and doc["policy"] == "C3" and doc["months"] == 6
    loaded = load_model(model)
    expected = project(loaded, {"size": np.array([10.0])}, loaded.default_params(), 6)
    assert doc["series"]["balance_eop"] == pytest.approx(list(expected["balance_eop"][:, 0, 0]))
    assert doc["summary"]["total_doubled"] == pytest.approx(expected["total_doubled"][0, 0])
    assert doc["branches"]["balance_eop"]["min: second"] > 0
    code, case_doc = run(capsys, "trace", "--model", model, "--case", "one")
    assert set(case_doc) == set(doc) - {"run", "policy"} and case_doc["case"] == "one"
    code, doc = run(capsys, "trace", "--model", model, "--run", "r1", "--policy", "nope")
    assert code == 1


def test_promote(model, capsys, tmp_path):
    make_run(capsys, model, tmp_path, rows=[("A1", 1), ("C3", 12345.678)])
    code, doc = run(capsys, "promote", "--model", model, "--run", "r1", "--policy", "C3", "--id", "big",
                    "--name", "Big one")
    assert code == 0 and doc["case"]["model_point"] == {"size": 12300} and doc["case"]["name"] == "Big one"
    assert doc["case"]["purpose"].startswith("Promoted from a real policy:") and "uncovered" in doc["case"]["purpose"]
    assert "new case" in doc["note"]
    written = json.loads((model / "cases" / "big.json").read_text())
    assert written == doc["case"] and "C3" not in json.dumps(written)
    assert isinstance(written["model_point"]["size"], int)
    assert run(capsys, "promote", "--model", model, "--run", "r1", "--policy", "C3", "--id", "big", "--name", "x")[0] == 1
    assert run(capsys, "promote", "--model", model, "--run", "r1", "--policy", "C3", "--id", "Bad Id",
               "--name", "x")[0] == 1
    assert run(capsys, "promote", "--model", model, "--run", "r1", "--policy", "zz", "--id", "ok1", "--name", "x")[0] == 1
    assert not (model / "cases" / "ok1.json").exists()


def test_promote_rounding_rules():
    from tilekit.runs import EXACT_FIELD, round_sig
    assert round_sig(0.123456) == 0.123 and round_sig(1234.5) == 1230 and round_sig(0) == 0
    assert EXACT_FIELD.search("age_at_entry") and EXACT_FIELD.search("premium_months")
    assert not EXACT_FIELD.search("sum_assured") and not EXACT_FIELD.search("premium_pm")


def test_runs_listing_and_current_flag(model, capsys, tmp_path):
    assert run(capsys, "runs", "--model", model)[1] == {"runs": []}
    make_run(capsys, model, tmp_path, name="old")
    make_run(capsys, model, tmp_path, name="new")
    code, doc = run(capsys, "runs", "--model", model)
    assert [r["name"] for r in doc["runs"]] == ["new", "old"] or {r["name"] for r in doc["runs"]} == {"old", "new"}
    assert all(r["current"] for r in doc["runs"]) and doc["runs"][0]["policies"] == 4
    tile = next(model.glob("src/*/step_mod.py"))
    tile.write_text(tile.read_text().replace("return x + x", "return x + x + 0"))
    code, doc = run(capsys, "runs", "--model", model)
    assert code == 0 and not any(r["current"] for r in doc["runs"])


def test_status_runs_summary(model, capsys, tmp_path):
    assert run(capsys, "status", "--model", model)[1]["runs"] == {"count": 0, "newest": None}
    make_run(capsys, model, tmp_path)
    assert run(capsys, "status", "--model", model)[1]["runs"] == {"count": 1, "newest": "r1"}


def test_build_policy(model, capsys, tmp_path, gridcraft_cli):
    make_run(capsys, model, tmp_path, rows=[("P/1: [x]", 3), ("C3", 10)])
    before = run(capsys, "status", "--model", model)[1]
    review_before = sorted(p.relative_to(model).as_posix() for p in model.rglob("*") if "real-data" not in p.parts)

    code, doc = run(capsys, "build", "--model", model, "--run", "r1", "--policy", "C3")
    assert code == 0, doc
    assert [b["kind"] for b in doc["built"]] == ["model"] and doc["built"][0]["checks_pass"]
    assert doc["built"][0]["workbook"] == "real-data/runs/r1/policies/C3/model/workbook.xlsx"
    for flag, kind in (("--tile", "balance_eop"), ("--module", "summary_mod")):
        code, doc = run(capsys, "build", "--model", model, "--run", "r1", "--policy", "P/1: [x]", flag, kind)
        assert code == 0, doc
        assert doc["built"][0]["checks_pass"] and doc["built"][0]["max_abs_difference"] <= 1e-9
    code, doc = run(capsys, "build", "--model", model, "--run", "r1", "--policy", "C3", "--tile", "balance_eop")
    assert code == 0
    base = model / "real-data" / "runs" / "r1" / "policies"
    assert (base / "C3" / "tiles" / "balance_eop" / "workbook.xlsx").is_file()
    assert (base / "C3" / "tiles" / "balance_eop" / "workbook.json").is_file()

    side = json.loads((base / "C3" / "tiles" / "balance_eop" / "workbook.json").read_text())
    assert side["real_data"]["label"] == "Real data: policy C3, run r1" and side["checks_pass"]
    assert list(side["cases"].values())[0]["sheet"] == "Policy C3"
    odd = next((base).glob("P_1*"))
    odd_side = json.loads((odd / "modules" / "summary_mod" / "workbook.json").read_text())
    sheet = list(odd_side["cases"].values())[0]["sheet"]
    assert sheet == "Policy P 1  x" or len(sheet) <= 31 and not any(c in sheet for c in "[]:*?/\\")

    # a real policy's workbooks use the same colours: computed upstream values bold dark green
    from tilekit.xlsxread import Xlsx
    book = Xlsx(base / "C3" / "tiles" / "balance_eop" / "workbook.xlsx")
    cells = book.cells("Policy C3")
    upstream = cells[f"C{book.row_named('Policy C3', 'balance_bop')}"]
    assert upstream["formula"] is None
    assert "FF006100" in book.font(upstream) and "<b/>" in book.font(upstream)
    assert "FF0000FF" in book.font(cells["C5"]) and "<b/>" in book.font(cells["C5"])

    assert run(capsys, "status", "--model", model)[1] == before
    after = sorted(p.relative_to(model).as_posix() for p in model.rglob("*") if "real-data" not in p.parts)
    assert after == review_before and not (model / "review").exists()


def test_build_policy_sheet_label_in_xlsx(model, capsys, tmp_path, gridcraft_cli):
    import zipfile
    make_run(capsys, model, tmp_path)
    run(capsys, "build", "--model", model, "--run", "r1", "--policy", "A1")
    xlsx = model / "real-data" / "runs" / "r1" / "policies" / "A1" / "model" / "workbook.xlsx"
    with zipfile.ZipFile(xlsx) as z:
        text = "".join(z.read(n).decode("utf8", "ignore") for n in z.namelist() if n.endswith(".xml"))
    assert "Real data: policy A1, run r1" in text


def _column_b_chars(book, sheet):
    import re
    match = re.search(r'<col [^>]*min="2" max="2"[^>]*width="([0-9.]+)"', book.sheet_xml(sheet))
    return float(match.group(1)) if match else 0.0


def test_real_data_label_on_every_sheet_and_not_clipped(model, capsys, tmp_path, gridcraft_cli):
    from tilekit.xlsxread import Xlsx
    make_run(capsys, model, tmp_path, rows=[("P000056", 3)], name="run-with-a-long-name")
    label = "Real data: policy P000056, run run-with-a-long-name"
    base = model / "real-data" / "runs" / "run-with-a-long-name" / "policies" / "P000056"
    run(capsys, "build", "--model", model, "--run", "run-with-a-long-name", "--policy", "P000056", "--whole-model")
    run(capsys, "build", "--model", model, "--run", "run-with-a-long-name", "--policy", "P000056",
        "--tile", "balance_eop")
    run(capsys, "build", "--model", model, "--run", "run-with-a-long-name", "--policy", "P000056",
        "--module", "step_mod")
    for path in (base / "model" / "workbook.xlsx", base / "tiles" / "balance_eop" / "workbook.xlsx",
                 base / "modules" / "step_mod" / "workbook.xlsx"):
        book = Xlsx(path)
        generated = [s for s in book.sheets if s != "Scratch"]
        assert generated
        for sheet in generated:
            assert book.cells(sheet)["B3"]["value"] == label, (path, sheet)
            assert _column_b_chars(book, sheet) >= len(label), (path, sheet)  # wide enough not to clip


def test_sample_portfolio(make_model, capsys, tmp_path):
    model = make_model(cases={
        "a": {"id": "a", "name": "A", "model_point": {"size": 4.5, "age": 40}},
        "b": {"id": "b", "name": "B", "model_point": {"size": 2.0, "age": 60}},
    })
    out1, out2, out3 = tmp_path / "s1.csv", tmp_path / "s2.csv", tmp_path / "s3.csv"
    code, doc = run(capsys, "sample-portfolio", "--model", model, "--out", out1, "--policies", 300, "--seed", 5)
    assert code == 0 and doc["policies"] == 300 and doc["fields"] == ["size", "age"]
    run(capsys, "sample-portfolio", "--model", model, "--out", out2, "--policies", 300, "--seed", 5)
    run(capsys, "sample-portfolio", "--model", model, "--out", out3, "--policies", 300, "--seed", 6)
    assert out1.read_text() == out2.read_text() != out3.read_text()
    lines = out1.read_text().splitlines()
    assert lines[0] == "policy_id,size,age" and len(lines) == 301
    ages = [float(l.split(",")[2]) for l in lines[1:]]
    sizes = [float(l.split(",")[1]) for l in lines[1:]]
    assert all(float(a).is_integer() and "." not in l.split(",")[2] for a, l in zip(ages, lines[1:]))
    assert 0 <= min(ages) and max(ages) <= 120 and 1.0 <= max(sizes) <= 9.0 and min(sizes) >= 0
    assert 0 in ages or 0 in sizes  # edge values are present
    # accepted by `run` (the model's inputs only read `size`; the extra field is simply carried)
    code, doc = run(capsys, "run", "--model", model, "--model-points", out1, "--name", "sampled")
    assert code == 0 and doc["policies"] == 300


def test_real_data_dir_env_var(model, capsys, tmp_path, monkeypatch):
    custom = tmp_path / "elsewhere" / "rd"
    monkeypatch.setenv("TILEKIT_REAL_DATA_DIR", str(custom))
    doc = make_run(capsys, model, tmp_path)
    assert (custom / "runs" / "r1" / "run.json").is_file()
    assert not (model / "real-data").exists()
    code, runs = run(capsys, "runs", "--model", model)
    assert code == 0 and [r["name"] for r in runs["runs"]] == ["r1"]
    code, st = run(capsys, "status", "--model", model)
    assert st["runs"] == {"count": 1, "newest": "r1"}
    # a relative `real-data/...` path goes to the chosen folder too
    code, sample = run(capsys, "sample-portfolio", "--model", model, "--out", "real-data/s.csv", "--policies", 5)
    assert code == 0 and (custom / "s.csv").is_file()
    assert doc["policies"] == 4


def test_real_data_dir_must_be_absolute(model, capsys, monkeypatch):
    monkeypatch.setenv("TILEKIT_REAL_DATA_DIR", "relative/dir")
    code, doc = run(capsys, "runs", "--model", model)
    assert code == 1 and "absolute" in doc["error"]["message"]


def test_real_data_dir_defaults_to_the_model(model, capsys, tmp_path, monkeypatch):
    monkeypatch.delenv("TILEKIT_REAL_DATA_DIR", raising=False)
    make_run(capsys, model, tmp_path)
    assert (model / "real-data" / "runs" / "r1" / "run.json").is_file()
