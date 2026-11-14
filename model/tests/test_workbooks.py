"""Build every stored workbook for this model into a temporary copy and check it against Python.

Needs GridCraft's command line (vendor/gridcraft/cli/gridcraft-cli, not in git); skipped without it.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tilekit.gridcraft import find_cli
from tilekit.xlsxread import Xlsx

MODEL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = MODEL_DIR.parent
MODULES = {
    "unit_projection": ["units_allocated", "units_after_alloc", "units_amc", "units_eop"],
    "decrements": ["deaths", "lapses", "in_force_eop"],
    "cashflows": ["fund_value_eop", "premium_income", "allocation_margin", "amc_income", "maintenance_expense",
                  "acquisition_expense", "sum_at_risk", "death_strain", "gross_profit"],
    "quota_share": ["ceded_death_strain", "retained_death_strain", "reinsurance_premium", "net_profit"],
    "profit": ["pv_gross_profit", "pv_net_profit", "pv_premium", "profit_margin", "irr_pm", "irr_pa"],
}
TILES = [t for tiles in MODULES.values() for t in tiles]
CASES = sorted(p.stem for p in (MODEL_DIR / "cases").glob("*.json"))  # whatever cases exist


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    cli = find_cli(REPO_ROOT)
    if cli is None:
        pytest.skip("gridcraft-cli not found (vendor/gridcraft is not in git)")
    copy = tmp_path_factory.mktemp("model") / "model"
    shutil.copytree(MODEL_DIR, copy, ignore=shutil.ignore_patterns(".venv", "review", ".pytest_cache", "__pycache__"))
    result = subprocess.run(
        [sys.executable, "-c", "from tilekit.cli import main; main()", "build", "--model", str(copy)],
        capture_output=True, text=True, env={**__import__("os").environ, "GRIDCRAFT_CLI": str(cli)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return copy, json.loads(result.stdout)


def test_every_workbook_agrees_with_python(built):
    root, doc = built
    kinds = sorted((b["kind"], b["name"]) for b in doc["built"])
    assert kinds == sorted([("tile", t) for t in TILES] + [("module", m) for m in MODULES]
                           + [("model", "Unit-linked pricing")])
    for item in doc["built"]:
        assert item["checks_pass"] is True, item
        assert item["max_abs_difference"] < 1e-9, item
    for tile in TILES:
        sidecar = json.loads((root / f"review/tiles/{tile}/workbook.json").read_text())
        assert sidecar["translatable"] and sidecar["formula"].startswith("=")
        assert set(sidecar["stamp"]) == {"code", "spec", "upstream", "cases", "params", "translator"}
        assert sidecar["tolerance"] == (1e-7 if tile == "irr_pm" else 1e-9)
        for case in CASES:
            assert sidecar["cases"][case]["checks_pass"] and sidecar["cases"][case]["max_abs_difference"] < 1e-9
    for module_id, tiles in MODULES.items():
        module = json.loads((root / f"review/modules/{module_id}/workbook.json").read_text())
        assert module["kind"] == "module" and set(module["tiles"]) == set(tiles) and module["checks_pass"]
    units = json.loads((root / "review/modules/unit_projection/workbook.json").read_text())
    assert units["outputs"] == ["units_amc", "units_eop"]  # the AMC feeds the cashflows, closing units the fund
    model = json.loads((root / "review/model/workbook.json").read_text())
    assert model["kind"] == "model" and model["checks_pass"] and model["content_digest"]
    assert model["sheets"] == ["Inputs", "Assumptions", "Unit projection", "Decrements", "Cashflows", "Quota share",
                               "Profit", "Scratch"]
    assert set(model["tiles"]) == set(TILES)
    assert set(model["inputs"]) == {"unit_price", "attained_age", "mort_rate_pa", "mort_rate_pm", "lapse_rate_pm",
                                    "acquisition_cost_paid", "discount_rate_pm", "discount_factor"}
    for name, entry in model["inputs"].items():
        assert entry["excel"].startswith("=") and entry["checks_pass"] and entry["max_abs_difference"] < 1e-9, name


def test_branches(built, named_case):
    root, _ = built
    for case in ("high_charge", "base", "fund_overtakes"):
        named_case(case)
    cases = json.loads((root / "review/tiles/units_amc/workbook.json").read_text())["cases"]
    assert cases["high_charge"]["branches"]["min: first"] > 0 and cases["high_charge"]["branches"]["min: second"] > 0
    assert cases["base"]["branches"] == {"min: first": 120, "min: second": 0}
    at_risk = json.loads((root / "review/tiles/sum_at_risk/workbook.json").read_text())["cases"]
    assert at_risk["base"]["branches"] == {"max: first": 120, "max: second": 0}
    assert at_risk["fund_overtakes"]["branches"]["max: first"] > 0
    assert at_risk["fund_overtakes"]["branches"]["max: second"] > 0


def test_undefined_results_agree_with_excel_errors(built, named_case):
    """Zero premium: Python's -inf margin and NaN IRR agree with Excel's #DIV/0! and #NUM!."""
    root, _ = built
    named_case("zero_premium")
    for tile, error in [("profit_margin", "#DIV/0!"), ("irr_pm", "#NUM!"), ("irr_pa", "#NUM!")]:
        sidecar = json.loads((root / f"review/tiles/{tile}/workbook.json").read_text())
        assert sidecar["cases"]["zero_premium"]["checks_pass"], tile
        book = Xlsx(root / f"review/tiles/{tile}/workbook.xlsx")
        cells = book.cells("Zero premium")
        row = next(ref[1:] for ref, c in cells.items() if ref.startswith("D") and c["value"] == tile)
        assert cells[f"C{row}"]["formula"] and cells[f"C{row}"]["value"] == error, (tile, cells[f"C{row}"])

def _fonts_and_xfs(book):
    fonts = book.fonts()
    cell_xfs = re.search(r"<cellXfs[^>]*>(.*?)</cellXfs>", book.styles_xml, re.S).group(1)
    xfs = re.findall(r"<xf [^>]*?(?:/>|>.*?</xf>)", cell_xfs, re.S)
    return fonts, xfs


def _font_of(book, cell):
    fonts, xfs = _fonts_and_xfs(book)
    font_id = int(re.search(r'fontId="(\d+)"', xfs[cell["style"]]).group(1))
    return fonts[font_id]


def _numfmt_of(book, cell):
    _, xfs = _fonts_and_xfs(book)
    fmt_id = int(re.search(r'numFmtId="(\d+)"', xfs[cell["style"]]).group(1))
    if fmt_id < 164:
        return {0: "General", 3: "#,##0", 4: "#,##0.00", 1: "0", 10: "0.00%"}.get(fmt_id, str(fmt_id))
    return re.search(rf'numFmtId="{fmt_id}" formatCode="([^"]*)"', book.styles_xml).group(1).replace("&quot;", '"')


@pytest.mark.parametrize("workbook", ["review/tiles/units_amc/workbook.xlsx",
                                      "review/modules/unit_projection/workbook.xlsx",
                                      "review/model/workbook.xlsx"])
def test_house_style(built, workbook):
    root, _ = built
    book = Xlsx(root / workbook)
    assert book.sheets[-1] == "Scratch"
    for sheet in book.sheets[:-1]:
        xml = book.sheet_xml(sheet)
        assert 'showGridLines="0"' in xml
        assert '<col min="1" max="1" width="2.8515625" customWidth="1"/>' in xml  # 20 px
        assert '<row r="1" ht="15" customHeight="1"' in xml  # 20 px
        assert 'state="frozen"' in xml
        cells = book.cells(sheet)
        for ref, cell in cells.items():
            font = _font_of(book, cell)
            assert "Open Sans" in font and '<sz val="10"/>' in font, (sheet, ref, font)
        assert cells["B2"]["value"] and "<b/>" in _font_of(book, cells["B2"])
        assert "B1" not in cells or cells["B1"]["value"] is None
    assert 'rgb="FF0000FF"' in book.styles_xml and 'rgb="FF800000"' in book.styles_xml
    assert 'rgb="FF808080"' in book.styles_xml and '<bottom style="thin">' in book.styles_xml


def test_layout_formats_and_names_of_the_tile_workbook(built, named_case):
    root, _ = built
    named_case("high_charge")
    book = Xlsx(root / "review/tiles/units_amc/workbook.xlsx")
    assert len(book.sheets) == len(CASES) + 1 and book.sheets[-1] == "Scratch" and "High charge" in book.sheets
    cells = book.cells("High charge")
    assert cells["B2"]["value"] == "AMC units" and cells["B3"]["value"] == "High charge"
    # parameters: label, blue bold value, maroon name; defined per sheet
    assert (cells["B5"]["value"], cells["C5"]["value"], cells["D5"]["value"]) == ("AMC per month", 0.002, "amc_pm")
    assert "FF0000FF" in _font_of(book, cells["C5"]) and "<b/>" in _font_of(book, cells["C5"])
    assert "FF800000" in _font_of(book, cells["D5"])
    assert _numfmt_of(book, cells["C5"]) == "0.0000%"
    names = {(n["name"], n["scope"]): n["refers_to"] for n in book.defined_names}
    assert names[("amc_pm", "High charge")] == "'High charge'!$C$5"
    assert ("units_amc", "High charge") in names
    # time block: bold Month header with a thin bottom border, pasted inputs in bold blue
    assert cells["B8"]["value"] == "Month" and cells["DR8"]["value"] == 120
    assert cells["B9"]["value"] == "Units after allocation"
    assert "FF0000FF" in _font_of(book, cells["C9"]) and cells["C9"]["formula"] is None
    assert cells["DS9"]["value"] == "units_after_alloc" and "FF800000" in _font_of(book, cells["DS9"])
    # the tile's own row: a live formula with parameter names and cell references, bold
    assert cells["B11"]["value"] == "AMC units"
    assert cells["C11"]["formula"] == "MIN(C9*amc_pm,amc_cap_units)"
    assert cells["DR11"]["formula"] == "MIN(DR9*amc_pm,amc_cap_units)"
    assert "<b/>" in _font_of(book, cells["C11"]) and _numfmt_of(book, cells["C11"]) == "#,##0.0000"
    assert cells["DR11"]["value"] == 25.0  # the cap bites in the last month
    # grey comparison rows
    assert cells["B13"]["value"] == "Python AMC units" and "FF808080" in _font_of(book, cells["B13"])
    assert cells["B14"]["value"] == "Difference" and cells["C14"]["formula"] == "C11-C13"
    assert _numfmt_of(book, cells["C14"]) == "0.0000"


def test_formats_and_links_of_the_model_workbook(built):
    root, _ = built
    book = Xlsx(root / "review/model/workbook.xlsx")
    assert book.sheets == ["Inputs", "Assumptions", "Unit projection", "Decrements", "Cashflows", "Quota share",
                           "Profit", "Scratch"]
    names = {(n["name"], n["scope"]) for n in book.defined_names}
    for name in ["allocation_rate", "amc_pm", "amc_cap_units", "unit_growth_pa", "initial_unit_price",
                 "months_per_year", "quota_share", "premium", "unit_price", "mort_rate_pa", "units_bop",
                 "units_allocated", "units_after_alloc", "units_amc", "units_eop", "in_force_bop", "net_profit",
                 "pv_net_profit", "irr_pa"]:
        assert (name, None) in names, name
    inputs = book.cells("Inputs")
    assert inputs["C5"]["value"] == 0.97 and _numfmt_of(book, inputs["C5"]) == "0.00%"
    premium_row = next(ref[1:] for ref, c in inputs.items() if ref.startswith("B") and c["value"] == "Premium")
    assert _numfmt_of(book, inputs[f"C{premium_row}"]) == "#,##0.00"
    sheet = book.cells("Unit projection")
    formulas = {c["formula"] for c in sheet.values() if c["formula"]}
    assert f"Inputs!C{premium_row}" in formulas
    assert any(f.startswith("MIN(") and f.endswith("*amc_pm,amc_cap_units)") for f in formulas)
    assert any(re.fullmatch(r"C\d+\*allocation_rate/C\d+", f) for f in formulas)


def _row_of(cells, label):
    return next(ref[1:] for ref, c in cells.items() if ref.startswith("B") and c["value"] == label)


def test_inputs_replicate_lookups_with_formulas(built):
    root, _ = built
    book = Xlsx(root / "review/model/workbook.xlsx")
    inputs = book.cells("Inputs")
    # pasted inputs stay bold blue values; replicated inputs are live formulas
    premium = _row_of(inputs, "Premium")
    assert inputs[f"C{premium}"]["formula"] is None and "FF0000FF" in _font_of(book, inputs[f"C{premium}"])
    mortality = _row_of(inputs, "Mortality rate per year")
    attained = _row_of(inputs, "Attained age")
    assert int(attained) < int(mortality)  # dependencies first
    assert inputs[f"D{mortality}"]["formula"] == (
        f"INDEX(Assumptions!$C$7:$C$99,MATCH(D{attained},Assumptions!$B$7:$B$99,0))")
    assert inputs[f"C{mortality}"]["value"] == 0.001756
    assert _numfmt_of(book, inputs[f"C{mortality}"]) == "0.0000%"
    assert inputs[f"C{_row_of(inputs, 'Acquisition cost paid')}"]["formula"].startswith("IF(C")
    assert any(c["value"] == "Python Mortality rate per year" for c in inputs.values())
    formulas = [c["formula"] for c in inputs.values() if c["formula"]]
    assert not any("VLOOKUP" in f or "XLOOKUP" in f for f in formulas)
    # the table: label, header, values in bold blue
    table = book.cells("Assumptions")
    assert (table["B5"]["value"], table["B6"]["value"], table["C6"]["value"]) == ("Mortality table", "age", "qx")
    assert (table["B7"]["value"], table["B99"]["value"]) == (18, 110)
    assert "FF0000FF" in _font_of(book, table["C7"]) and "<b/>" in _font_of(book, table["C7"])


def test_profit_sheet_reads_series_and_summaries(built):
    root, _ = built
    book = Xlsx(root / "review/model/workbook.xlsx")
    cells = book.cells("Profit")
    formulas = {cells[f"B{r[1:]}"]["value"]: c["formula"] for r, c in cells.items()
                if r.startswith("C") and c["formula"] and not c["formula"].startswith(("Cashflows", "'Quota", "Inputs"))}
    assert formulas["PV of net profit"].startswith("SUMPRODUCT(C") and ":DR" in formulas["PV of net profit"]
    assert re.fullmatch(r"IRR\(C\d+:DR\d+\)", formulas["IRR per month"])
    assert re.fullmatch(r"C\d+/C\d+", formulas["Profit margin"])
    assert re.fullmatch(r"\(1\+C\d+\)\^months_per_year-1", formulas["IRR per year"])
    irr = next(c["value"] for r, c in cells.items() if r.startswith("C") and c["formula"] and c["formula"].startswith("IRR"))
    assert 0.01 < irr < 0.03
