"""A tiny read-only look inside an .xlsx file (standard library only), for tests and checks.

It reads sheet names, cell formulas and cached values, defined names and the raw
XML parts; it does not calculate anything.
"""

import re
import zipfile
from xml.etree import ElementTree

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class Xlsx:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        self.workbook_xml = self.part("xl/workbook.xml")
        self.styles_xml = self.part("xl/styles.xml")
        root = ElementTree.fromstring(self.workbook_xml)
        rels = ElementTree.fromstring(self.part("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels.iter(f"{REL_NS}Relationship")}
        self.sheet_paths = {}
        self.sheets = []
        for sheet in root.find("m:sheets", NS):
            name = sheet.get("name")
            target = targets[sheet.get(f"{{{NS['r']}}}id")].lstrip("/")
            self.sheets.append(name)
            self.sheet_paths[name] = target if target.startswith("xl/") else f"xl/{target}"
        self.defined_names = []
        names = root.find("m:definedNames", NS)
        for item in names if names is not None else []:
            scope = item.get("localSheetId")
            self.defined_names.append({
                "name": item.get("name"),
                "scope": self.sheets[int(scope)] if scope is not None else None,
                "refers_to": item.text,
            })
        self._strings = None

    def part(self, name):
        return self.zip.read(name).decode("utf-8")

    def sheet_xml(self, sheet):
        return self.part(self.sheet_paths[sheet])

    @property
    def shared_strings(self):
        if self._strings is None:
            try:
                root = ElementTree.fromstring(self.part("xl/sharedStrings.xml"))
            except KeyError:
                self._strings = []
            else:
                self._strings = ["".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t"))
                                 for si in root.findall("m:si", NS)]
        return self._strings

    def cells(self, sheet):
        """{ref: {"formula": str | None, "value": float | str | None, "style": int}} for every cell element."""
        root = ElementTree.fromstring(self.sheet_xml(sheet))
        out = {}
        for c in root.iter(f"{{{NS['m']}}}c"):
            f = c.find("m:f", NS)
            v = c.find("m:v", NS)
            inline = c.find("m:is", NS)
            kind = c.get("t")
            value = None
            if v is not None and v.text is not None:
                if kind == "s":
                    value = self.shared_strings[int(v.text)]
                elif kind in ("str", "e"):
                    value = v.text
                elif kind == "b":
                    value = v.text == "1"
                else:
                    value = float(v.text)
            elif inline is not None:
                value = "".join(t.text or "" for t in inline.iter(f"{{{NS['m']}}}t"))
            out[c.get("r")] = {"formula": f.text if f is not None else None, "value": value,
                               "style": int(c.get("s", 0))}
        return out

    def fonts(self):
        """Each <font> element of styles.xml as raw XML text, in order."""
        return re.findall(r"<font>.*?</font>", self.styles_xml)

    def font(self, cell):
        """The raw <font> XML of a cell from `cells()` (its colour, weight, name and size)."""
        cell_xfs = re.search(r"<cellXfs[^>]*>(.*?)</cellXfs>", self.styles_xml, re.S).group(1)
        xfs = re.findall(r"<xf [^>]*?(?:/>|>.*?</xf>)", cell_xfs, re.S)
        return self.fonts()[int(re.search(r'fontId="(\d+)"', xfs[cell["style"]]).group(1))]

    def row_named(self, sheet, name):
        """The row number whose code-name cell (any column but B) holds `name`."""
        for ref, cell in self.cells(sheet).items():
            if cell["value"] == name and not ref.startswith("B"):
                return int(re.search(r"\d+", ref).group(0))
        raise KeyError(name)
