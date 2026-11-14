#!/usr/bin/env python3
"""Build unit_projection.xlsx in house style by driving gridcraft-cli headlessly."""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE.parent.parent / "vendor/gridcraft/cli/gridcraft-cli"
OUT = HERE / "unit_projection.xlsx"
SCRIPT = HERE / "unit_projection.jsonl"
SH = "Unit projection"
Q = f"'{SH}'"
BLUE, MAROON, GREY = "#0000FF", "#800000", "#808080"
PX = 20  # col A width in px == row 1 height in px (15 pt)
COLS = [chr(ord("C") + i) for i in range(12)]  # C..N
L = "N"; NAMECOL = "O"

cmds = []
def c(command, **params): cmds.append({"command": command, "params": params})
def vals(rng, rows): c("range.setValues", range=rng, values=rows)

c("sheet.rename", name=SH)
c("view.gridlines", on=False)
# font everywhere (whole sheet, before content)
c("home.fontName", range="A1:Z40", name="Open Sans")
c("home.fontSize", range="A1:Z40", size=10)

vals("B2", [["Unit projection"]]); c("home.bold", range="B2")
vals("B3", [["Base, policy 1"]])
vals("B5", [["Allocation rate", 0.97, "allocation_rate"], ["AMC per month", 0.000625, "amc_pm"]])
c("formulas.defineName", name="allocation_rate", refersTo=f"={Q}!$C$5")
c("formulas.defineName", name="amc_pm", refersTo=f"={Q}!$C$6")

vals("B8", [["Month"] + list(range(1, 13))])
vals("B9", [["Premium"] + [250] * 12 + ["premium"]])
vals("B10", [["Unit price"] + [1.25 * 1.004 ** m for m in range(12)] + ["unit_price"]])
rows = {
 12: ("Opening units", lambda i, k: 0 if i == 0 else f"={COLS[i-1]}16", "units_bop"),
 13: ("Units allocated", lambda i, k: f"={k}9*allocation_rate/{k}10", "units_allocated"),
 14: ("Units after allocation", lambda i, k: f"={k}12+{k}13", "units_after_alloc"),
 15: ("AMC units", lambda i, k: f"={k}14*amc_pm", "units_amc"),
 16: ("Closing units", lambda i, k: f"={k}14-{k}15", "units_eop"),
}
for r, (label, f, name) in rows.items():
    vals(f"B{r}", [[label] + [f(i, k) for i, k in enumerate(COLS)] + [name]])
    c("formulas.defineName", name=name, refersTo=f"={Q}!$C${r}:${L}${r}")
for r, name in ((9, "premium"), (10, "unit_price")):
    c("formulas.defineName", name=name, refersTo=f"={Q}!$C${r}:${L}${r}")

# Python closing units pasted as values (computed here with the same maths)
units, closing = 0.0, []
for m in range(12):
    price = 1.25 * 1.004 ** m
    after = units + 250 * 0.97 / price
    units = after - after * 0.000625
    closing.append(units)
vals("B18", [["Python closing units"] + closing])
vals("B19", [["Difference"] + [f"={k}16-{k}18" for k in COLS]])

# formats
c("home.bold", range="C5:C6"); c("home.bold", range=f"C9:{L}10"); c("home.bold", range=f"B16:{L}16")
c("home.bold", range=f"B8:{L}8")
c("home.fontColor", range="C5:C6", color=BLUE); c("home.fontColor", range=f"C9:{L}10", color=BLUE)
c("home.fontColor", range="D5:D6", color=MAROON); c("home.fontColor", range=f"{NAMECOL}9:{NAMECOL}16", color=MAROON)
c("home.fontColor", range="B18:N19", color=GREY)
c("home.borders", range=f"B8:{L}8", preset="bottom", style="thin")
c("home.numberFormat", range="C5", format="0.00%")
c("home.numberFormat", range="C6", format="0.0000%")
c("home.numberFormat", range=f"C9:{L}9", format="0.00")
c("home.numberFormat", range=f"C10:{L}10", format="0.0000")
c("home.numberFormat", range=f"C12:{L}16", format="0.0000")
c("home.numberFormat", range=f"C18:{L}19", format="0.0000")
# geometry: A width px == row 1 height px
c("home.columnWidth", cols="A:A", width=PX)
c("home.rowHeight", rows="1:1", height=PX)

with open(SCRIPT, "w") as fh:
    for x in cmds: fh.write(json.dumps(x) + "\n")
r = subprocess.run([str(CLI), "run", "--script", str(SCRIPT), "--out", str(OUT)], capture_output=True, text=True)
errs = [l for l in r.stdout.splitlines() if '"error"' in l or '"ok":false' in l]
print(r.stdout[-1500:] if errs or r.returncode else f"{len(cmds)} commands ok")
if r.returncode or errs:
    print(r.stderr, file=sys.stderr); sys.exit(1)
print("wrote", OUT)

# ---- verification straight from the xlsx XML ----
import re, zipfile
z = zipfile.ZipFile(OUT)
st, sh, wb = (z.read(p).decode() for p in ("xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/workbook.xml"))
def cell(ref): return re.search(r'<c r="%s"[^>]*?(?:/>|>.*?</c>)' % ref, sh).group(0)
checks = {
  "gridlines off": 'showGridLines="0"' in sh,
  "Open Sans only on every cellXf font": all("Open Sans" in f for f in re.findall(r"<font>.*?</font>", st)[1:]),
  "size 10 on used fonts": all('<sz val="10"/>' in f for f in re.findall(r"<font>.*?</font>", st)[2:]),
  "blue FF0000FF": 'rgb="FF0000FF"' in st, "maroon FF800000": 'rgb="FF800000"' in st,
  "thin bottom border": '<bottom style="thin">' in st,
  "numFmt 0.0000% / 0.0000": 'formatCode="0.0000%"' in st and 'formatCode="0.0000"' in st,
  "9 defined names": wb.count("<definedName ") == 9,
  "row1 ht 15pt (=20px)": 'r="1" ht="15" customHeight="1"' in sh,
  "col A width 2.8515625 chars (=20px @7px/char)": 'min="1" max="1" width="2.8515625"' in sh,
  "closing month 12": abs(float(re.search(r"<v>(.*?)</v>", cell("N16")).group(1)) - 2268.3601797877595) < 1e-9,
}
for k, v in checks.items(): print("PASS" if v else "FAIL", k)
sys.exit(0 if all(checks.values()) else 1)
