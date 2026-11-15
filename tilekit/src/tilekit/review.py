"""Review state: sign-offs bound to stamps, staleness, status, reconfirm, export and the model test cache.

Files (all inside `<model>/review/`):
  tiles/<t>/signoff.json, expected.json; modules/<m>/signoff.json; model/signoff.json, model/tests.json

A sign-off is current when its stamp equals the current stamp. A stamp that differs only in `cases`
while every previously covered case file is unchanged (a case was added) still counts as signed off;
the new case ids are listed in `new_cases`. Any other difference is staleness, and `drift` says which kind:
`formula` (code, spec or translator moved) or `values` (only upstream, cases, params or the workbook layout
moved).
"""

import ast
import getpass
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from tilekit import handchecks, version
from tilekit.build import workbook_state
from tilekit.cases import case_months, get_case, load_cases
from tilekit.checks import run_checks
from tilekit.errors import TilekitError
from tilekit.stamps import STAMP_KEYS, model_stamp, module_stamp, tile_stamp, upstream_tiles
from tilekit.trace import plain_float, run_case
from tilekit.translate import model_translations
from tilekit.workbook import default_case_id, model_paths, module_paths, review_dir, tile_paths, write_json

log = logging.getLogger("tilekit")

FORMULA_KEYS = ("code", "spec", "translator")  # `layout` is not one: a layout change alone is values drift
EXPECTED_KEYS = tuple(k for k in STAMP_KEYS if k != "layout")  # the keys an expected.json record is held to
DEFAULT_RECONFIRM_COMMENT = "Values-only re-confirmation"


# ---------------------------------------------------------------- small helpers

def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _relative(model, path):
    try:
        return Path(path).relative_to(model.root).as_posix()
    except ValueError:
        return str(path)


def case_hashes(model):
    """{case id: sha256 of the case file}."""
    folder = model.root / "cases"
    if not folder.is_dir():
        return {}
    return {p.stem: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob("*.json"))}


def reviewer_default(model):
    try:
        out = subprocess.run(["git", "config", "user.name"], cwd=model.root, capture_output=True, text=True,
                             timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        return getpass.getuser()
    except Exception:  # no user database entry
        return "reviewer"


def signoff_path(model, kind, name):
    base = review_dir(model)
    if kind == "tile":
        return base / "tiles" / name / "signoff.json"
    if kind == "module":
        return base / "modules" / name / "signoff.json"
    return base / "model" / "signoff.json"


def expected_path(model, name):
    return review_dir(model) / "tiles" / name / "expected.json"


def tests_cache_path(model):
    return review_dir(model) / "model" / "tests.json"


def _assess(current, stored, signoff, hash_now, content_ok=True, checks_ok=True):
    """(state, drift, new case ids) for one tile, module or model.

    `stored` is the workbook's stamp (None when unbuilt), `signoff` the parsed sign-off or None,
    `content_ok` whether the stored workbook still holds exactly what the build wrote, and `checks_ok`
    whether every case's difference check passes (False for a values-only tile, which has none).

    A sign-off whose stamp differs only in `cases`, with every covered case file unchanged (cases were
    only added), stays signed off while the stored workbook is current and every check passes; otherwise
    it is stale with drift `formula` when a check fails, or `values` when the workbook needs a rebuild.
    """
    new_cases = _new_cases(signoff, hash_now)
    if stored is None:
        return "unbuilt", None, new_cases
    workbook_ok = stored == current and content_ok
    if signoff and isinstance(signoff.get("stamp"), dict):
        signed = signoff["stamp"]
        diff = {k for k in STAMP_KEYS if signed.get(k) != current.get(k)}
        if not diff:
            if content_ok:
                return "signed_off", None, new_cases
            return "stale", "values", new_cases
        if diff == {"cases"}:
            covered = signoff.get("cases") or []
            recorded = signoff.get("case_hashes") or {}
            if recorded and all(c in recorded and hash_now.get(c) == recorded[c] for c in covered):
                if workbook_ok and checks_ok:
                    return "signed_off", None, new_cases
                if workbook_ok:
                    return "stale", "formula", new_cases
                return "stale", "values", new_cases
        return "stale", _drift_of(diff), new_cases
    if workbook_ok:
        return "built", None, new_cases
    return "stale", _drift_of({k for k in STAMP_KEYS if stored.get(k) != current.get(k)}), new_cases


def _drift_of(diff):
    return "formula" if any(k in diff for k in FORMULA_KEYS) else "values"


def _new_cases(signoff, hash_now):
    if not signoff:
        return []
    covered = set(signoff.get("cases") or [])
    return [c for c in sorted(hash_now) if c not in covered]


def is_not_built(tile):
    """True when the tile's docstring has a `Status: not built` line (a spec without an implementation)."""
    return tile.doc.not_built


def _signed_summary(signoff):
    if not signoff:
        return None
    return {"reviewer": signoff.get("reviewer"), "at": signoff.get("at"), "comment": signoff.get("comment", "")}


# ---------------------------------------------------------------- status

def _tests_state(model):
    """(cached `tilekit test` result or None, stale). The cache is stale when its model stamp is not the current one,
    or when a file the tests lean on (`tests/conftest.py`, a helper module) is not the one that ran."""
    cache = _read_json(tests_cache_path(model))
    if not cache or not isinstance(cache.get("tests"), list):
        return None, False
    return cache, cache.get("stamp") != model_stamp(model) or cache.get("support") != _tests_support_digest(model)


def _tests_support_digest(model):
    """One digest of every Python file under `tests/` that is not itself a test file (conftest.py, helpers): a change
    to one can change what any test does, so a cache made with other bytes is stale."""
    folder = model.root / "tests"
    paths = [p for p in (sorted(folder.rglob("*.py")) if folder.is_dir() else [])
             if "__pycache__" not in p.parts and not p.name.startswith("test_")]
    h = hashlib.sha256()
    for path in paths:
        h.update(_relative(model, path).encode() + b"\x00" + path.read_bytes() + b"\x00")
    return h.hexdigest()


def _file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def cached_test_result(model, tests, relative):
    """How one test file fared in the cached test run: "passed", "failed", "not_run" or "none" (no such file).

    "not_run" when there is no cache, the cache is stale (the model changed since), the cache does not record the file
    (a cache written before per-file results existed, or a file added since), the file's bytes differ from those that
    ran (it was edited since), or none of its tests ran. A file whose tests were all skipped is `not_run` too: a
    passing test is a condition of sign-off, and a test that was skipped checked nothing."""
    path = model.root / relative
    if not path.is_file():
        return "none"
    cache, stale = tests
    if cache is None or stale or not isinstance(cache.get("files"), dict):
        return "not_run"
    entry = cache["files"].get(relative)
    if not isinstance(entry, dict) or entry.get("sha256") != _file_digest(path):
        return "not_run"
    if entry.get("failed"):
        return "failed"
    if entry.get("passed"):
        return "passed"
    return "not_run"  # nothing ran, or every test was skipped: nothing was checked


def undefined_values(model):
    """{tile: {case id: {"count": n, "first_month": m or None}}} for every tile whose Python value is not a number
    (NaN or infinite) somewhere in a case; `first_month` is None for a summary tile. None when the cases cannot be
    run. Cached on the model, like the stamps.

    Excel shows such a value as #NUM! or #DIV/0!, and the difference check counts the two as agreeing, so on these
    cells it checks nothing. A tile says when that is expected with an `Undefined:` line in its docstring."""
    if "_undefined_values" in model.__dict__:
        return model.__dict__["_undefined_values"]
    graph = model.graph
    summary = set(graph.summary_order())
    found = {}
    try:
        for case in load_cases(model):
            _, _, results = run_case(model, case.id)
            for name in graph.order:
                if name not in results:
                    continue
                values = results[name]
                series = [float(values[0, 0])] if name in summary else [float(v) for v in values[:, 0, 0]]
                bad = [i for i, v in enumerate(series) if not math.isfinite(v)]
                if bad:
                    found.setdefault(name, {})[case.id] = {"count": len(bad),
                                                          "first_month": None if name in summary else bad[0] + 1}
    except Exception as exc:  # noqa: BLE001 - a model whose cases do not run cannot be checked, and says so
        log.debug("cases could not be run for the undefined-values check: %s", exc)
        found = None
    model.__dict__["_undefined_values"] = found
    return found


def _undefined_blocker(cases):
    parts = []
    for case_id, info in sorted(cases.items()):
        month = info.get("first_month")
        parts.append(f"case {case_id}" + (f" (first in month {month})" if month is not None else ""))
    return ("Its value is not a number in " + ", ".join(parts) + ". Excel shows an error there and the difference "
            "check counts that as agreeing, so those cells are not checked. Correct the tile, or, if that is expected, "
            "add an `Undefined:` line to its docstring saying when.")


TEST_BLOCKERS = {
    "none": "It has no hand-calculation test ({file}); write one first.",
    "failed": "Its hand-calculation test ({file}) fails.",
    "not_run": "Its hand-calculation test ({file}) has not been run since the last change; run it first.",
}


def _all_skipped(tests, relative):
    """True when the cache holds a current run of this file, as it is now, in which every test was skipped."""
    cache, stale = tests
    entry = ((cache or {}).get("files") or {}).get(relative) if not stale and isinstance((cache or {}).get("files"), dict) else None
    return bool(isinstance(entry, dict) and entry.get("skipped") and not entry.get("passed") and not entry.get("failed"))


CASE_LINE = re.compile(r"^\s*Case:\s*([A-Za-z0-9_]+)\s*,\s*month\s+(\d+)\s*$", re.MULTILINE)


def has_case_check(path):
    """True when a docstring of the test file (the module's, a class's or a function's) has a line
    `Case: <case id>, month <n>`: the hand calculation is tied to a month of a named case."""
    try:
        tree = ast.parse(Path(path).read_text())
    except (OSError, SyntaxError, ValueError):
        return False
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc and CASE_LINE.search(doc):
                return True
    return False


def module_test_path(model, module_id):
    return model.root / "tests" / "modules" / f"test_{module_id}.py"


def _test_checks(model, tests=None):
    """Model checks from the cached `tilekit test` result (empty when there is none)."""
    cache, stale = tests if tests is not None else _tests_state(model)
    if not cache:
        return []
    # a cache made only of single-file runs since the model last changed does not hold the whole model's tests
    stale = stale or bool(cache.get("partial"))
    # ... nor does one made before a test file was added, removed or edited: the files that ran are not the ones there
    ran = {rel: (entry or {}).get("sha256") for rel, entry in (cache.get("files") or {}).items()} \
        if isinstance(cache.get("files"), dict) else None
    stale = stale or ran != _test_file_digests(model)
    checks = []
    for test in cache["tests"]:
        if not Path(test.get("file", "")).name.startswith("test_invariants"):
            continue
        name = test["name"]
        base = name.split("[", 1)[0]
        param = name[len(base):]
        words = (base[5:] if base.startswith("test_") else base).replace("_", " ").strip()
        words = (words[:1].upper() + words[1:]) + (f" {param}" if param else "")
        checks.append({"name": words, "pass": test.get("outcome") in ("passed", "skipped") and not stale})
    total = len(cache["tests"])
    passed = sum(t.get("outcome") == "passed" for t in cache["tests"])
    summary = {"name": f"Model tests pass ({passed} of {total})", "pass": cache.get("failed", 0) == 0 and not stale}
    checks.append(summary)
    if stale:
        for check in checks:
            check["pass"] = False
            check["stale"] = True
    return checks


def compute_status(model):
    graph = model.graph
    hash_now = case_hashes(model)
    default_case = default_case_id(model)
    errors = [v for v in run_checks(model) if v["severity"] == "error"]
    translations = model_translations(model)
    case_ids = [c.id for c in load_cases(model)]

    tests = _tests_state(model)

    tiles = {}
    for name in graph.order:
        tiles[name] = _tile_entry(model, name, hash_now, errors, translations, tests)

    modules = {}
    for item in model.config.modules:
        if graph.modules[item.id].tiles:
            modules[item.id] = _module_entry(model, item.id, hash_now, tiles, errors, tests)

    model_entry = _model_entry(model, default_case, case_ids, hash_now, tiles, modules, errors, tests)

    def count(entries):
        counts = {s: sum(e["state"] == s for e in entries.values())
                  for s in ("signed_off", "built", "stale", "unbuilt", "not_built")}
        counts["total"] = len(entries)
        return counts

    return {
        "reviewer_default": reviewer_default(model),
        "tiles": tiles,
        "modules": modules,
        "model": model_entry,
        "counts": {"tiles": count(tiles), "modules": count(modules),
                   "model": {s: int(model_entry["state"] == s) for s in ("signed_off", "built", "stale", "unbuilt")}},
    }


CHANGED_OUTSIDE_BUILD = "The stored workbook was changed outside a build. Rebuild it."
VALUES_ONLY_BLOCKER = ("This tile cannot be written as an Excel formula. "
                       "Sign-off needs a values-only acknowledgement.")


def _near_tie_blockers(near_ties):
    blockers = []
    for case_id, ties in sorted((near_ties or {}).items()):
        if not ties:
            continue
        month = ties[0].get("month")
        where = f"case {case_id}, month {month}" if month is not None else f"case {case_id}"
        blockers.append(f"A comparison is within rounding of a tie in {where}: "
                        "Excel and Python may take different branches.")
    return blockers


def _workbook_blockers(what, stored, current, content_ok):
    if stored is None:
        return [f"The {what} has not been built; build it first."]
    if stored != current:
        return [f"The {what} is out of date; rebuild it first."]
    if not content_ok:
        return [CHANGED_OUTSIDE_BUILD]
    return []


def _tile_entry(model, name, hash_now, errors, translations, tests=(None, False)):
    xlsx, sidecar = tile_paths(model, name)
    current = tile_stamp(model, name)
    stored, doc, content_ok = workbook_state(xlsx, sidecar)
    signoff = _read_json(signoff_path(model, "tile", name))
    translation = translations.get(name)
    formula = translation.formula if translation else None
    values_only = bool(translation) and not translation.translatable
    checks_pass = None if doc is None else doc.get("checks_pass")
    state, drift, new_cases = _assess(current, stored, signoff, hash_now, content_ok, checks_pass is True)
    if signoff and state in ("signed_off", "stale") and signoff.get("formula") != formula:
        state, drift = "stale", "formula"  # the formula moved since sign-off, whatever the stamps say
    # The workbook is also built for the checks of the tile's hand-calculation test (not part of the stamp, so a
    # changed test never makes a sign-off stale: it only asks for a rebuild and blocks a new sign-off until then).
    hand_now = handchecks.extract(model, name, translations)
    hand_current = stored is None or handchecks.current(doc, hand_now)
    hand = (doc or {}).get("hand_checks") if hand_current else None
    workbook_current = stored == current and content_ok and hand_current
    own = [{"rule": v["rule"], "message": v["message"], "line": v["line"]} for v in errors if v["tile"] == name]
    cases = (doc or {}).get("cases", {})
    case_results = {cid: {"max_abs_difference": c.get("max_abs_difference"),
                          "pass": None if c.get("checks_pass") is None else bool(c.get("checks_pass"))}
                    for cid, c in cases.items()}
    labels = list((doc or {}).get("branch_labels") or [])
    for c in cases.values():
        labels += [b for b in (c.get("branches") or {}) if b not in labels]
    uncovered = [b for b in labels if not any((c.get("branches") or {}).get(b, 0) > 0 for c in cases.values())] \
        if doc else []
    near = {cid: c.get("near_ties") for cid, c in cases.items() if c.get("near_ties")}

    blockers = _workbook_blockers("tile's workbook", stored, current, content_ok)
    if not blockers and not hand_current:
        blockers.append("The tile's workbook was built before its test last changed; rebuild it first.")
    if hand and hand.get("checks_pass") is False:
        failing = list(dict.fromkeys(c["test"] for c in hand.get("checks", []) if not c.get("pass")))
        blockers.append("The spreadsheet formula does not agree with the hand calculation in "
                        + (", ".join(failing) if failing else "a test") + ".")
    if doc is not None and checks_pass is False:
        worst = doc.get("max_abs_difference")
        failing = [cid for cid, c in case_results.items() if c["pass"] is False]
        blockers.append("The difference check fails" + (f" in case {', '.join(failing)}" if failing else "")
                        + (f" (largest difference {worst:g})." if isinstance(worst, (int, float)) else "."))
    for v in own:
        blockers.append(f"Rule violation ({v['rule']}) at line {v['line']}: {v['message']}")
    for label in uncovered:
        blockers.append(f"No case takes the branch '{label}'; add a case that does.")
    blockers += _near_tie_blockers(near)
    if values_only:
        blockers.append(VALUES_ONLY_BLOCKER)
    # A tile that reads something not built yet (directly, or through a carried-forward state that closes a loop)
    # has placeholder values wherever that reaches: Python's NaN agrees with Excel's #NUM!, so the difference check
    # passes without checking anything. It cannot be signed off until what it depends on is built.
    order = {t: i for i, t in enumerate(model.graph.order)}
    waiting = sorted((u for u in upstream_tiles(model, [name]) if u != name and model.graph.tiles[u].doc.not_built),
                     key=lambda u: order.get(u, 0))
    if waiting:
        blockers.append(f"It depends on {', '.join(waiting)}, which {'is' if len(waiting) == 1 else 'are'} not built "
                        "yet, so some of its values are placeholders (#NUM!). Build "
                        f"{'it' if len(waiting) == 1 else 'them'} before signing this off.")

    # A value that is not a number (NaN or infinite) for any other reason is the same hole: Excel's error counts as
    # agreeing with it. It blocks sign-off unless the docstring says, in an `Undefined:` line, when that is expected.
    declared = model.graph.tiles[name].doc.undefined
    found = undefined_values(model)
    undefined_cases = {} if found is None else found.get(name, {})
    if not waiting:
        if found is None:
            blockers.append("The cases could not be run, so its values could not be checked for ones that are not "
                            "a number.")
        elif undefined_cases and not declared:
            blockers.append(_undefined_blocker(undefined_cases))

    # The tile's own hand-calculation test, from the cached test runs. Like the hand checks it is not part of the
    # stamp: a test changed after sign-off never makes the sign-off stale. It shows in the review queue and, until
    # the test has been run again and passes, blocks a new sign-off.
    test_file = handchecks.test_path(model, name)
    test_rel = _relative(model, test_file)
    test_result = cached_test_result(model, tests, test_rel)
    all_skipped = test_result == "not_run" and _all_skipped(tests, test_rel)
    if all_skipped:
        blockers.append(f"Every test in its hand-calculation test ({test_rel}) was skipped, so nothing was checked.")
    elif test_result != "passed":
        blockers.append(TEST_BLOCKERS[test_result].format(file=test_rel))
    signed_test = (signoff or {}).get("test")
    test_changed = isinstance(signed_test, dict) and (
        test_result == "none" or signed_test.get("sha256") != _file_digest(test_file))
    # What stands in the way of a values-only re-confirmation: everything that blocks a sign-off (a re-confirmation
    # writes a new one, so the test must have passed on the model as it is now), and two things that need the
    # reviewer to look again rather than re-confirm in bulk: a test changed since sign-off, and values that are not
    # a number in other places than when the tile was signed off.
    reconfirm_blockers = list(blockers)
    if test_changed:
        reconfirm_blockers.append("Its test changed after sign-off; look at the test and sign the tile off again.")
    signed_undefined = (signoff or {}).get("undefined_cases")
    if isinstance(signed_undefined, dict) and signed_undefined != undefined_cases:
        reconfirm_blockers.append("The places where its value is not a number have changed since sign-off; "
                                  "review it again.")

    if model.graph.tiles[name].doc.not_built:
        state, drift, blockers = "not_built", None, ["This tile has not been built yet."]
    return {
        "state": state,
        "drift": drift,
        "workbook_current": workbook_current,
        "formula": formula,
        "signed_formula": (signoff or {}).get("formula"),
        "module": graph_module(model, name),
        "checks_pass": checks_pass,
        "max_abs_difference": None if doc is None else doc.get("max_abs_difference"),
        "case_results": case_results,
        "translatable": translation.translatable if translation else None,
        "values_only": values_only,
        "values_only_reason": (signoff or {}).get("values_only_reason"),
        "near_ties": near,
        "rule_violations": own,
        "uncovered_branches": uncovered,
        "new_cases": new_cases,
        "signed_off": _signed_summary(signoff),
        "workbook": _relative(model, xlsx),
        "waiting_on": waiting,
        "undefined": {"declared": declared, "cases": undefined_cases},
        "test": {"file": test_rel, "result": test_result, "changed_since_signoff": test_changed},
        "hand_checks": None if hand is None else {
            "sheet": hand.get("sheet"), "checks_pass": hand.get("checks_pass"),
            "max_abs_difference": hand.get("max_abs_difference"), "not_in_sheet": hand.get("not_in_sheet", []),
            "checks": [{k: c.get(k) for k in ("test", "index", "args", "expected", "tolerance", "excel", "difference",
                                              "pass")} for c in hand.get("checks", [])]},
        "can_sign_off": not blockers,
        "blockers": blockers,
        "reconfirm_blockers": reconfirm_blockers,
        "_formula": (doc or {}).get("formula"),
    }


def graph_module(model, name):
    return model.graph.tiles[name].module


def _tile_tests(model, names, tiles, tests):
    """The module's summary of its tiles' tests: per tile the cached result of its test file, its hand checks on the
    sheet and whether it names the case and month it was worked from; counts over the tiles that are built."""
    from tilekit.handchecks import test_path
    entries = {}
    for name in names:
        path = test_path(model, name)
        hand = tiles[name].get("hand_checks")
        result = cached_test_result(model, tests, _relative(model, path))
        entries[name] = {
            "tests": result,
            # null when the tile has no test file, or no stored workbook built for its current test
            "hand_checks": None if hand is None or result == "none" else {
                "in_sheet": len(hand.get("checks") or []),
                "agree": sum(bool(c.get("pass")) for c in hand.get("checks") or [])},
            "case_check": path.is_file() and has_case_check(path),
        }
    built = [n for n in names if tiles[n]["state"] != "not_built"]
    count = {k: sum(entries[n]["tests"] == k for n in built) for k in ("passed", "failed", "not_run", "none")}
    return {"total": len(built), "passed": count["passed"], "failed": count["failed"], "not_run": count["not_run"],
            "none": count["none"], "tiles": entries}


def _tile_tests_blocker(summary):
    by = {}
    for name, entry in summary["tiles"].items():
        by.setdefault(entry["tests"], []).append(name)
    parts = []
    if by.get("failed"):
        parts.append("failed for " + ", ".join(by["failed"]))
    if by.get("not_run"):
        parts.append("not run since the last change for " + ", ".join(by["not_run"]) + " (run `tilekit test`)")
    if by.get("none"):
        parts.append("no test file for " + ", ".join(by["none"]))
    return "Tile tests do not all pass: " + "; ".join(parts) + "."


def _module_entry(model, module_id, hash_now, tiles, errors, tests=(None, False)):
    xlsx, sidecar = module_paths(model, module_id)
    current = module_stamp(model, module_id)
    stored, doc, content_ok = workbook_state(xlsx, sidecar)
    signoff = _read_json(signoff_path(model, "module", module_id))
    # the reconciliations are not part of `checks_pass`: a sign-off kept through a new case needs them to hold too
    recorded_checks = {r.get("name"): r for r in ((doc or {}).get("reconciliations") or [])}
    reconciled = all(bool((recorded_checks.get(c.name) or {}).get("pass")) for c in model.config.module(module_id).checks)
    state, drift, new_cases = _assess(current, stored, signoff, hash_now, content_ok,
                                      bool(doc and doc.get("checks_pass") is True) and reconciled)
    names = list(model.graph.modules[module_id].tiles)
    mine = {n: tiles[n] for n in names}
    if state == "stale" and any(t["drift"] == "formula" for t in mine.values()):
        drift = "formula"

    formulas_match = bool(doc) and all(
        mine[n]["_formula"] is not None and (doc.get("tiles", {}).get(n, {}).get("formula")) == mine[n]["_formula"]
        for n in names if mine[n]["state"] != "not_built" and not mine[n]["values_only"])
    all_signed = all(t["state"] == "signed_off" for t in mine.values())
    module_errors = [v for v in errors if v["tile"] in mine]
    module_near = {n: doc.get("tiles", {}).get(n, {}).get("near_ties") for n in names} if doc else {}
    checks = [
        {"name": "Sheet agrees with Python", "pass": bool(doc and doc.get("checks_pass"))},
        {"name": "Tile formulas match the tile workbooks", "pass": formulas_match},
        {"name": "Every tile signed off", "pass": all_signed},
        {"name": "No rule violations", "pass": not module_errors},
    ]
    blockers = _workbook_blockers("module's workbook", stored, current, content_ok)
    for check in checks:
        if not check["pass"] and check["name"] != "Every tile signed off":
            blockers.append(f"Check failed: {check['name']}.")

    # Reconciliations (`[[module.check]]`): read from the sidecar, and only from a current one (they are part of the
    # module workbook's stamp, so a sidecar from before a check was added or changed is never current).
    workbook_current = stored == current and content_ok
    config = model.config.module(module_id)
    reconciliations = None
    if workbook_current:
        recorded = {r.get("name"): r for r in (doc.get("reconciliations") or [])}
        reconciliations = []
        for check in config.checks:
            found = recorded.get(check.name) or {}
            reconciliations.append({"name": check.name, "label": check.label, "expression": check.expression,
                                    "max_abs_difference": found.get("max_abs_difference"),
                                    "pass": bool(found.get("pass"))})
    if config.checks:
        checks.append({"name": "Reconciliations hold",
                       "pass": reconciliations is not None and all(r["pass"] for r in reconciliations)})
        for r in reconciliations or []:
            if not r["pass"]:
                worst = r["max_abs_difference"]
                blockers.append(f"The check '{r['label']}' is not zero (largest value "
                                + (f"{worst:g}" if isinstance(worst, (int, float)) else "not a number") + ").")

    # The tiles' own tests, from the cached test run.
    tile_tests = _tile_tests(model, names, tiles, tests)
    tests_pass = tile_tests["passed"] == tile_tests["total"]
    checks.append({"name": f"Tile tests pass ({tile_tests['passed']} of {tile_tests['total']})", "pass": tests_pass})
    if not tests_pass:
        blockers.append(_tile_tests_blocker({**tile_tests, "tiles": {
            n: e for n, e in tile_tests["tiles"].items() if tiles[n]["state"] != "not_built" and e["tests"] != "passed"}}))

    # The module's own hand-worked test, when it has one: it never blocks by being absent.
    module_path = module_test_path(model, module_id)
    module_test = {"file": _relative(model, module_path),
                   "status": cached_test_result(model, tests, _relative(model, module_path))}
    if module_test["status"] != "none":
        checks.append({"name": "Module test passes", "pass": module_test["status"] == "passed"})
        if module_test["status"] == "failed":
            blockers.append(f"The module test {module_test['file']} fails.")
        elif module_test["status"] == "not_run":
            blockers.append(f"The module test {module_test['file']} has not been run since the last change; "
                            "run `tilekit test`.")
    for tile, near in module_near.items():
        for text in _near_tie_blockers(near):
            blockers.append(f"{tile}: {text}")
    pending = [n for n, t in mine.items() if t["state"] != "signed_off"]
    if pending:
        blockers.append(f"{len(pending)} of {len(names)} tiles are not signed off: {', '.join(pending)}.")
    return {
        "state": state,
        "drift": drift,
        "workbook_current": stored == current and content_ok,
        "tiles_total": len(names),
        "tiles_signed_off": sum(t["state"] == "signed_off" for t in mine.values()),
        "stale": sum(t["state"] == "stale" for t in mine.values()),
        "unbuilt": sum(t["state"] == "unbuilt" for t in mine.values()),
        "checks": checks,
        "reconciliations": reconciliations,
        "tile_tests": tile_tests,
        "module_test": module_test,
        "new_cases": new_cases,
        "signed_off": _signed_summary(signoff),
        "workbook": _relative(model, xlsx),
        "can_sign_off": not blockers,
        "blockers": blockers,
    }


def _model_entry(model, default_case, case_ids, hash_now, tiles, modules, errors, tests=None):
    xlsx, sidecar = model_paths(model, default_case)
    current = model_stamp(model, default_case)
    stored, doc, content_ok = workbook_state(xlsx, sidecar)
    if doc is not None and doc.get("case") != default_case:
        content_ok = False  # the stored workbook shows another case
    signoff = _read_json(signoff_path(model, "model", model.config.name))
    # as for a module: the model keeps a sign-off through a new case only while every module's reconciliations hold
    reconciled = all(m["reconciliations"] is not None and all(r["pass"] for r in m["reconciliations"])
                     for m in modules.values() if any(c["name"] == "Reconciliations hold" for c in m["checks"]))
    state, drift, new_cases = _assess(current, stored, signoff, hash_now, content_ok,
                                      bool(doc and doc.get("checks_pass") is True))
    if state == "signed_off" and not reconciled:
        # a reconciliation that fails is a failed check; one that cannot be read yet (a module workbook out of date)
        # only asks for a rebuild
        failing = any(not r["pass"] for m in modules.values() for r in (m["reconciliations"] or []))
        state, drift = "stale", ("formula" if failing else "values")
    if state == "stale" and any(t["drift"] == "formula" for t in tiles.values()):
        drift = "formula"

    checks = [
        {"name": "Workbook agrees with Python", "pass": bool(doc and doc.get("checks_pass"))},
        {"name": "Every module signed off", "pass": all(m["state"] == "signed_off" for m in modules.values())},
        {"name": "No rule violations", "pass": not errors},
    ]
    test_checks = _test_checks(model, tests)
    checks += test_checks
    blockers = _workbook_blockers("model workbook", stored, current, content_ok)
    if doc is not None and doc.get("case") != default_case:
        blockers = [f"The model workbook shows case '{doc.get('case')}', not the default case '{default_case}'; "
                    "rebuild it first."]
    if not checks[0]["pass"] and stored is not None:
        blockers.append("Check failed: Workbook agrees with Python.")
    for tile, near in ((doc or {}).get("tiles") or {}).items():
        for text in _near_tie_blockers(near.get("near_ties")):
            blockers.append(f"{tile}: {text}")
    pending = [m for m, e in modules.items() if e["state"] != "signed_off"]
    if pending:
        blockers.append(f"{len(pending)} of {len(modules)} modules are not signed off: {', '.join(pending)}.")
    if errors:
        blockers.append(f"The model has {len(errors)} rule violation(s).")
    for check in test_checks:
        if not check["pass"]:
            blockers.append(f"Model test check failed: {check['name']}" + (" (results are stale; run `tilekit test`)."
                                                                          if check.get("stale") else "."))
    workbooks = {}
    for cid in case_ids:
        path, _ = model_paths(model, cid)
        if path.is_file():
            workbooks[cid] = _relative(model, path)
    return {
        "state": state,
        "drift": drift,
        "workbook_current": stored == current and content_ok,
        "case": default_case,
        "workbook_case": (doc or {}).get("case"),
        "modules_total": len(modules),
        "modules_signed_off": sum(m["state"] == "signed_off" for m in modules.values()),
        "stale": sum(m["state"] == "stale" for m in modules.values()),
        "checks": checks,
        "new_cases": new_cases,
        "signed_off": _signed_summary(signoff),
        "workbook": _relative(model, xlsx),
        "workbooks": workbooks,
        "can_sign_off": not blockers,
        "blockers": blockers,
    }


def status_json(model):
    """The `tilekit status` document."""
    document = compute_status(model)
    for entry in document["tiles"].values():
        entry.pop("_formula", None)
    document["tooling"] = version.tooling_info(model.root)  # how the model pins the tooling, and what is running
    document["runs"] = _runs_summary(model)  # real-data runs: informational only, never part of sign-off
    return document


def _runs_summary(model):
    from tilekit.runs import runs_summary
    return runs_summary(model)


# ---------------------------------------------------------------- sign-off

def encode_value(value):
    """A float for expected.json: finite values as numbers, NaN and infinities as "nan", "inf", "-inf"."""
    value = float(value)
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    return value


def decode_value(value):
    if isinstance(value, str) and value in ("nan", "inf", "-inf"):
        return float(value)
    if value is None:  # written by an older tilekit for any non-finite value; the kind is unknown
        return None
    return float(value)


def _tile_expected(model, name):
    summary = model.graph.timings[name] == "summary"
    cases = {}
    for case in load_cases(model):
        _, _, results = run_case(model, case.id)
        values = results[name]
        listed = [encode_value(values[0, 0])] if summary else [encode_value(v) for v in values[:, 0, 0]]
        cases[case.id] = {"months": case_months(model, case), "values": listed}
    return cases


def _write_signoff(model, kind, name, reviewer, comment, values_only_reason=None):
    hash_now = case_hashes(model)
    at = _now()
    if kind == "tile":
        stamp = tile_stamp(model, name)
    elif kind == "module":
        stamp = module_stamp(model, name)
    else:
        stamp = model_stamp(model, default_case_id(model))
    case_ids = sorted(hash_now)
    document = {
        "reviewer": reviewer, "at": at, "comment": comment or "", "stamp": stamp,
        "cases": case_ids, "case_hashes": hash_now,
        "assumed": list(model.graph.tiles[name].doc.assumed) if kind == "tile" else [],
        "tooling_version": version.VERSION,
    }
    if kind == "tile":
        document["formula"] = model_translations(model)[name].formula
        test_file = handchecks.test_path(model, name)
        if test_file.is_file():  # the test as it stood at sign-off: a later change shows in the review queue
            document["test"] = {"file": _relative(model, test_file), "sha256": _file_digest(test_file)}
        if model.graph.tiles[name].doc.undefined:
            document["undefined"] = model.graph.tiles[name].doc.undefined
        # where its value was not a number when it was signed off (empty when nowhere): a re-confirmation is refused
        # if that has moved since
        document["undefined_cases"] = (undefined_values(model) or {}).get(name, {})
        if values_only_reason:
            document["values_only_reason"] = values_only_reason
    path = signoff_path(model, kind, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "tile":
        expected = {"tile": name, "stamp": stamp, "case_hashes": hash_now, "cases": _tile_expected(model, name)}
        write_json(expected_path(model, name), expected)
    write_json(path, document)
    return at


def _entry(status, kind, name):
    return status["tiles"][name] if kind == "tile" else status["modules"][name] if kind == "module" else status["model"]


def signoff(model, tile=None, module=None, whole_model=False, reviewer=None, comment=None, values_only=None):
    """Record a sign-off. `values_only` is the reviewer's acknowledgement (a reason) for a tile that cannot be
    written as an Excel formula; it is required for such a tile and refused for any other target."""
    if not reviewer or not reviewer.strip():
        raise TilekitError("signoff needs --reviewer NAME")
    if values_only is not None and not values_only.strip():
        raise TilekitError("--values-only needs a reason")
    if values_only is not None and not tile:
        raise TilekitError("--values-only applies to a tile sign-off only")
    status = compute_status(model)
    if tile:
        if tile not in model.graph.tiles:
            raise TilekitError(f"Unknown tile '{tile}'", {"tiles": list(model.graph.order)})
        kind, name = "tile", tile
    elif module:
        model.config.module(module)
        if module not in status["modules"]:
            raise TilekitError(f"Module '{module}' has no tiles")
        kind, name = "module", module
    elif whole_model:
        kind, name = "model", model.config.name
    else:
        raise TilekitError("signoff needs --tile, --module or --whole-model")
    entry = _entry(status, kind, name)
    blockers = list(entry["blockers"])
    if kind == "tile" and values_only is not None:
        if not entry["values_only"]:
            raise TilekitError(f"Tile '{name}' has an Excel formula; --values-only is only for a tile that "
                               "cannot be written as one")
        blockers = [b for b in blockers if b != VALUES_ONLY_BLOCKER]
    if blockers:
        raise TilekitError(f"Cannot sign off {kind} '{name}': " + " ".join(blockers), {"blockers": blockers})
    at = _write_signoff(model, kind, name, reviewer.strip(), comment,
                        values_only.strip() if values_only is not None else None)
    new = _entry(compute_status(model), kind, name)
    new.pop("_formula", None)
    return {"signed_off": {"kind": kind, "name": name, "reviewer": reviewer.strip(), "at": at}, "status": new}


TESTS_NEED_RUNNING = "its test has not been run on the changed model; run the tests first"


def _reconfirm_skip(entry):
    """Why `reconfirm` leaves this tile with values drift alone; None when it would re-sign it."""
    if entry["formula"] != entry["signed_formula"]:
        return "the formula has changed since sign-off; review it again"
    if entry["values_only"]:
        return "values-only tile; sign it off again with --values-only"
    if not entry["workbook_current"]:
        return "workbook needs a rebuild"
    waiting = entry["reconfirm_blockers"]
    if waiting == [TEST_BLOCKERS["not_run"].format(file=entry["test"]["file"])]:
        return TESTS_NEED_RUNNING  # nothing else in the way: run the tests, then it can be re-confirmed
    if waiting:
        return " ".join(waiting)
    return None


def _has_values_drift(entry):
    """A signed-off tile that is stale only because values moved: the only kind `reconfirm` looks at."""
    return entry["state"] == "stale" and entry["drift"] == "values" and entry["signed_off"] is not None


def reconfirm(model, reviewer, module=None, comment=None):
    if not reviewer or not reviewer.strip():
        raise TilekitError("reconfirm needs --reviewer NAME")
    status = compute_status(model)
    names = list(model.graph.order)
    if module:
        model.config.module(module)
        names = [n for n in names if model.graph.tiles[n].module == module]
    done, skipped = [], []
    for name in names:
        entry = status["tiles"][name]
        if not _has_values_drift(entry):
            continue
        reason = _reconfirm_skip(entry)
        if reason:
            skipped.append({"name": name, "reason": reason})
        else:
            _write_signoff(model, "tile", name, reviewer.strip(), comment or DEFAULT_RECONFIRM_COMMENT)
            done.append(name)
    return {"reconfirmed": done, "skipped": skipped}


# ---------------------------------------------------------------- the review queue

QUEUE_KINDS = ("not_signed_off", "formula_drift", "values_drift", "new_case", "unexercised_branch", "test_changed")


def _new_case_text(new_cases, names):
    listed = ", ".join(names.get(c, c) for c in new_cases)
    return f"New {'cases' if len(new_cases) > 1 else 'case'} to review: {listed}."


def _tile_reasons(entry, case_names):
    """[(kind, plain sentence)] for one tile's status entry, the main reason first; empty when nothing is outstanding."""
    state = entry["state"]
    if state == "not_built":
        return []  # a spec without an implementation: nothing to review yet
    reasons = []
    if entry["signed_off"] is None:
        text = "Not signed off yet."
        if state == "unbuilt":
            text = "Not signed off yet, and its workbook has not been built."
        elif state == "stale":
            text = "Not signed off yet, and its workbook is out of date."
        reasons.append(("not_signed_off", text))
    elif state == "stale" and entry["drift"] == "values":
        skip = _reconfirm_skip(entry)
        if skip is None or skip in ("workbook needs a rebuild", TESTS_NEED_RUNNING):
            text = "Only values or the layout changed since sign-off, not the formula: rebuild and re-confirm."
        else:
            text = "Values or the layout changed since sign-off, and it needs a full review again."
        reasons.append(("values_drift", text))
    elif state == "stale":
        reasons.append(("formula_drift", "Changed since sign-off: needs a full review again."))
    elif state == "signed_off" and entry["new_cases"]:
        reasons.append(("new_case", _new_case_text(entry["new_cases"], case_names)))
    for label in entry["uncovered_branches"]:
        reasons.append(("unexercised_branch", f"No case takes the branch '{label}', which blocks sign-off."))
    if entry["signed_off"] is not None and entry["test"]["changed_since_signoff"]:
        gone = entry["test"]["result"] == "none"
        reasons.append(("test_changed", ("Its test was removed after sign-off" if gone else
                                         "Its test changed after sign-off")
                        + ": the sign-off stands, but look at the test and sign the tile off again."))
    return reasons


def _group_reasons(entry, what, pending, parts, case_names):
    """The same for a module or the model. `pending` counts its parts (tiles or modules) not yet signed off."""
    state = entry["state"]
    wait = f" {pending} of its {parts} still to sign off first." if pending else ""
    if state == "signed_off":
        return [("new_case", _new_case_text(entry["new_cases"], case_names))] if entry["new_cases"] else []
    if entry["signed_off"] is None:
        return [("not_signed_off", f"The {what} is not signed off yet.{wait}")]
    kind = "formula_drift" if entry["drift"] == "formula" else "values_drift"
    return [(kind, f"The {what} changed since its sign-off: sign it off again.{wait}")]


def queue_json(model):
    """The `tilekit queue` document: everything that still needs the reviewer, upstream first.

    One item per tile, module or the model that is not in order. Modules run left to right (dependency
    order); inside a module its tiles come in dependency order and then the module itself; the model is
    last. Signing off in this order avoids reviewing anything twice. Everything here is read from
    `compute_status`; nothing is decided again.
    """
    from tilekit.workbook import module_dependency_order
    status = compute_status(model)
    graph = model.graph
    case_names = {c.id: c.name or c.id for c in load_cases(model)}
    titles = {m.id: m.title for m in model.config.modules}
    items = []

    def add(level, ident, module_id, label, reasons, reconfirm=None):
        if not reasons:
            return
        items.append({
            "level": level, "id": ident, "module": module_id,
            "module_title": titles.get(module_id) if module_id else None, "label": label,
            "kind": reasons[0][0], "reason": " ".join(text for _, text in reasons),
            "reasons": [{"kind": kind, "text": text} for kind, text in reasons],
            "reconfirm": reconfirm,
        })

    for module_id in module_dependency_order(model):
        if module_id not in status["modules"]:
            continue  # a module without tiles has nothing to review
        names = list(graph.modules[module_id].tiles)
        for name in names:
            entry = status["tiles"][name]
            reconfirm = None
            if _has_values_drift(entry):
                skip = _reconfirm_skip(entry)
                reconfirm = ("ready" if skip is None else "after_rebuild" if skip == "workbook needs a rebuild"
                             else "after_tests" if skip == TESTS_NEED_RUNNING else None)
            add("tile", name, module_id, graph.tiles[name].doc.label, _tile_reasons(entry, case_names), reconfirm)
        pending = sum(status["tiles"][n]["state"] != "signed_off" for n in names)
        add("module", module_id, module_id, titles.get(module_id),
            _group_reasons(status["modules"][module_id], "module", pending, "tiles", case_names))
    pending = sum(m["state"] != "signed_off" for m in status["modules"].values())
    add("model", None, None, model.config.name,
        _group_reasons(status["model"], "model", pending, "modules", case_names))

    tiles = [i for i in items if i["level"] == "tile"]
    return {
        "items": items,
        "counts": {
            "total": len(items), "tiles": len(tiles),
            "modules": sum(i["level"] == "module" for i in items), "model": sum(i["level"] == "model" for i in items),
            "kinds": {k: sum(any(r["kind"] == k for r in i["reasons"]) for i in tiles) for k in QUEUE_KINDS},
            "reconfirm": sum(i["reconfirm"] is not None for i in tiles),
        },
    }


# ---------------------------------------------------------------- regression check against expected.json

def check_expected(model, name, tolerance=1e-9):
    """Compare a signed-off tile's recorded values with its current Python values.

    Returns {"status": "ok" | "stale" | "mismatch", "mismatches": [...]}. A record is stale when its stamp
    differs from the current one (except that a case added since sign-off does not make it stale).
    """
    expected = _read_json(expected_path(model, name))
    if expected is None:
        return {"status": "stale", "mismatches": []}
    current = tile_stamp(model, name)
    # the workbook layout has no bearing on Python values, so a layout change alone leaves the record current
    diff = {k for k in EXPECTED_KEYS if (expected.get("stamp") or {}).get(k) != current.get(k)}
    if diff:
        recorded = expected.get("case_hashes") or {}
        hash_now = case_hashes(model)
        ok = diff == {"cases"} and recorded and all(hash_now.get(c) == recorded[c] for c in expected.get("cases", {}))
        if not ok:
            return {"status": "stale", "mismatches": []}
    graph = model.graph
    summary = graph.timings[name] == "summary"
    mismatches = []
    for case_id, record in expected.get("cases", {}).items():
        _, _, results = run_case(model, case_id)
        values = results[name]
        now = [float(values[0, 0])] if summary else [float(v) for v in values[:, 0, 0]]
        want = record["values"]
        if len(now) != len(want):
            mismatches.append({"case": case_id, "reason": f"expected {len(want)} values, got {len(now)}"})
            continue
        for index, (a, raw) in enumerate(zip(now, want)):
            if not _same_value(a, decode_value(raw), tolerance):
                mismatches.append({"case": case_id, "index": index, "python": encode_value(a), "expected": raw})
                break
    return {"status": "mismatch" if mismatches else "ok", "mismatches": mismatches}


def _same_value(now, want, tolerance):
    """Equal within `tolerance` when both are finite; otherwise the same kind (NaN, +inf or -inf)."""
    if want is None:
        return False
    if math.isfinite(now) and math.isfinite(want):
        return abs(now - want) <= tolerance
    if math.isnan(now) or math.isnan(want):
        return math.isnan(now) and math.isnan(want)
    return now == want  # both infinite (or one finite, which differs)


# ---------------------------------------------------------------- export

def export(model, out, case=None):
    case_id = case or default_case_id(model)
    get_case(model, case_id)
    source, _ = model_paths(model, case_id)
    if not source.is_file():
        raise TilekitError(f"The model workbook for case '{case_id}' has not been built "
                           f"(expected {_relative(model, source)})")
    target = Path(out)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return {"exported": str(out), "case": case_id, "bytes": target.stat().st_size}


# ---------------------------------------------------------------- the model's own tests

def _parse_junit(path):
    tests = []
    for case in ET.parse(path).getroot().iter("testcase"):
        classname = case.get("classname", "")
        dotted = classname.split(".")
        parts = [p for p in dotted if p.startswith("test_")]
        file = f"{parts[0]}.py" if parts else (dotted[-1] + ".py" if classname else "")
        # the file's path relative to the model (pytest's rootdir): `tests.tiles.test_x` -> tests/tiles/test_x.py
        where = "/".join(dotted[:dotted.index(parts[0]) + 1]) + ".py" if parts else file
        if any(c.tag in ("failure", "error") for c in case):
            outcome = "failed"
        elif any(c.tag == "skipped" for c in case):
            outcome = "skipped"
        else:
            outcome = "passed"
        name = case.get("name", "")
        tests.append({"id": f"{file}::{name}", "name": name, "file": file, "path": where, "outcome": outcome})
    return tests


def _test_file_digests(model):
    """{path relative to the model: sha256} of every test file under `tests/`."""
    folder = model.root / "tests"
    return {_relative(model, path): _file_digest(path)
            for path in (sorted(folder.rglob("test_*.py")) if folder.is_dir() else []) if "__pycache__" not in path.parts}


def _file_results(digests, tests):
    """{path: {sha256, passed, failed, skipped}} for every test file under `tests/` (relative to the model): what each
    file's tests did in this run and the bytes that ran (read before the run), so a file edited since can be told
    apart."""
    files = {rel: {"sha256": digest, "passed": 0, "failed": 0, "skipped": 0} for rel, digest in digests.items()}
    by_name = {}
    for rel in files:
        by_name.setdefault(rel.rsplit("/", 1)[-1], []).append(rel)
    for test in tests:
        entry = files.get(test.get("path"))
        if entry is None and len(by_name.get(test.get("file"), [])) == 1:  # a rootdir other than the model
            entry = files[by_name[test["file"]][0]]
        if entry is not None:
            entry[test["outcome"]] += 1
    return files


def _keep_file_run(model, relative, digest, tests, stamp, support):
    """Put one file's results from a single-file run into the test cache.

    The rule that nothing counts as run unless it ran since the model last changed is kept: when the cache was made
    for the current model stamp, this file's results replace its old ones; otherwise the cache starts again with this
    file alone. A cache that started that way is marked `partial` until a full run replaces it, and a partial cache
    never satisfies the model-level test checks."""
    path = tests_cache_path(model)
    cache = _read_json(path)
    current = (isinstance(cache, dict) and cache.get("stamp") == stamp and cache.get("support") == support
               and isinstance(cache.get("tests"), list) and isinstance(cache.get("files"), dict))
    base = cache if current else {"tests": [], "files": {}, "partial": True}
    for test in tests:
        test["path"] = relative
    kept = [t for t in base["tests"] if t.get("path") != relative] + tests
    document = {
        "at": _now(), "stamp": stamp,
        "passed": sum(t["outcome"] == "passed" for t in kept),
        "failed": sum(t["outcome"] == "failed" for t in kept),
        "tests": kept,
        "files": {**base["files"], **_file_results({relative: digest}, tests)},
        "support": support,
    }
    if base.get("partial"):
        document["partial"] = True
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, document)


def run_model_tests(model, file=None):
    """Run the model's tests and cache the result; with `file`, run that one test file only.

    A single-file run of a tile's or a module's own test (`tests/tiles/`, `tests/modules/`) is kept in the same
    cache, for that file only (see `_keep_file_run`); any other single-file run leaves the cache alone. The document
    returned is that run's, not the cache."""
    tests_dir = model.root / "tests"
    target = tests_dir
    if file is not None:
        target = Path(file)
        if not target.is_absolute():
            target = (model.root / target) if (model.root / target).exists() else Path.cwd() / target
        if not target.is_file():
            raise TilekitError(f"No test file {file}")
    elif not tests_dir.is_dir():
        raise TilekitError(f"The model has no tests directory ({tests_dir})")
    # read before the run, so an edit made while the tests run is not recorded as tested
    digests = _test_file_digests(model)
    stamp_before, support_before = model_stamp(model), _tests_support_digest(model)
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "junit.xml"
        result = subprocess.run(
            [sys.executable, "-m", "pytest", str(target), "-q", "-p", "no:cacheprovider", f"--junitxml={report}",
             f"--rootdir={model.root}"],  # test ids and paths relative to the model
            cwd=model.root, capture_output=True, text=True,
            # the model's own package is found through its src folder, as `load_model` finds it for every other command
            env={**os.environ, "PYTHONPATH": os.pathsep.join(
                [str(model.root / "src"), *([os.environ["PYTHONPATH"]] if os.environ.get("PYTHONPATH") else [])])})
        if not report.is_file():
            raise TilekitError("The model's tests did not produce a report",
                               {"exit_code": result.returncode, "output": (result.stdout + result.stderr)[-4000:]})
        tests = _parse_junit(report)
    document = {
        "at": _now(), "stamp": stamp_before,
        "passed": sum(t["outcome"] == "passed" for t in tests),
        "failed": sum(t["outcome"] == "failed" for t in tests),
        "tests": tests,
    }
    if file is None:
        document["files"] = _file_results(digests, tests)
        document["support"] = support_before
    if file is not None:
        document["file"] = _relative(model, target.resolve())
        document["output"] = (result.stdout + result.stderr)[-4000:]
        # only the test of one tile or one module is kept from a run on its own: those gate that item's sign-off;
        # the model's other tests count only from a full run
        if document["file"] in digests and document["file"].startswith(("tests/tiles/", "tests/modules/")):
            _keep_file_run(model, document["file"], digests[document["file"]], tests, stamp_before, support_before)
        return document
    path = tests_cache_path(model)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json(path, document)
    return document
