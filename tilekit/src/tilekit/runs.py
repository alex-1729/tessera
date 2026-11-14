"""Real-data runs: a portfolio projected in one call, inspected policy by policy, never part of sign-off.

Everything lives under `<model>/real-data/` (git-ignored): `runs/<RUN>/run.json`, `model_points.csv`,
`results.npz`, `totals.json`, `signatures.{json,npz}` and `policies/<ID>/...` workbooks.
These workbooks reuse the review builders' layout code but are written to their own paths and
never touch `review/` or any stamp that `status` reads.
"""

import csv
import dataclasses
import json
import math
import re
import shutil
import time
import tomllib
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from tilekit.cases import case_model_points, case_months, case_params, load_cases
from tilekit.engine import project
from tilekit.errors import TilekitError
from tilekit.stamps import model_stamp, module_stamp, tile_stamp
from tilekit.trace import branch_counts, near_tie_map, plain_float, run_case
from tilekit.translate import (EXCEL_FUNCTIONS, Call, _branch_kinds, branch_labels_for, children, evaluate,
                               model_translations)

RUN_SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
CASE_SLUG = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
EXACT_FIELD = re.compile(r"(^|_)(age|ages|month|months|year|years|term|duration|count)(_|$)")
FLAGS = ("uncovered", "nan", "undefined")
MAX_BAD = 20


def real_data_dir(model):
    return model.root / "real-data"


def runs_dir(model):
    return real_data_dir(model) / "runs"


def run_dir(model, name, must_exist=True):
    if not isinstance(name, str) or not RUN_SLUG.fullmatch(name):
        raise TilekitError(f"'{name}' is not a valid run name; use letters, digits, '_' and '-' (at most 64)")
    folder = runs_dir(model) / name
    if must_exist and not (folder / "run.json").is_file():
        raise TilekitError(f"No run '{name}'", {"runs": sorted(p.parent.name for p in runs_dir(model).glob("*/run.json"))})
    return folder


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _write_json(path, document):
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


def model_point_fields(model):
    """The model-point fields the model needs: the union of `model_point` keys across the cases, in first-seen order."""
    fields = []
    for case in load_cases(model):
        fields += [f for f in case.model_point if f not in fields]
    if not fields:
        raise TilekitError("The model has no cases with model-point fields, so the needed fields cannot be worked out")
    return fields


def summary_names(model):
    return list(model.graph.summary_order())


def _squeeze(results, summary):
    """Engine output -> step quantities (months, n_pol), summary quantities (n_pol,)."""
    return {name: (values[0] if name in summary else values[:, 0, :]).astype(np.float64)
            for name, values in results.items()}


# ---------------------------------------------------------------- reading the CSV

def read_portfolio(model, path, id_column="policy_id"):
    """(ids, {field: float64 array}, header, rows) from a CSV, validated against the model's needed fields."""
    path = Path(path)
    if not path.is_file():
        raise TilekitError(f"No such file: {path}")
    fields = model_point_fields(model)
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle)
        try:
            header = [h.strip() for h in next(reader)]
        except StopIteration:
            raise TilekitError(f"{path.name} is empty; it needs a header row") from None
        rows = [row for row in reader if any(cell.strip() for cell in row)]
    missing = [c for c in [id_column, *fields] if c not in header]
    if missing:
        raise TilekitError(f"{path.name} lacks required columns: {missing}",
                           {"missing_columns": missing, "columns": header, "required": [id_column, *fields]})
    if len(set(header)) != len(header):
        raise TilekitError(f"{path.name} has repeated column names", {"columns": header})
    if not rows:
        raise TilekitError(f"{path.name} has no data rows")
    index = {name: header.index(name) for name in header}
    bad, ids = [], []
    values = {f: np.zeros(len(rows)) for f in fields}
    # data row i is on line i + 2 only when there are no blank lines; report the row number among data rows
    for i, row in enumerate(rows):
        number = i + 2
        if len(row) != len(header):
            bad.append({"row": number, "column": None, "problem": f"{len(row)} values; expected {len(header)}"})
            continue
        pid = row[index[id_column]].strip()
        if not pid:
            bad.append({"row": number, "column": id_column, "problem": "blank"})
        ids.append(pid)
        for f in fields:
            text = row[index[f]].strip()
            if text == "":
                bad.append({"row": number, "column": f, "problem": "blank"})
                continue
            try:
                number_value = float(text)
            except ValueError:
                bad.append({"row": number, "column": f, "problem": f"not a number: '{text}'"})
                continue
            if not math.isfinite(number_value):
                bad.append({"row": number, "column": f, "problem": f"not a finite number: '{text}'"})
                continue
            values[f][i] = number_value
    if not bad:
        seen = {}
        for i, pid in enumerate(ids):
            if pid in seen:
                bad.append({"row": i + 2, "column": id_column, "problem": f"'{pid}' repeats row {seen[pid]}"})
            seen.setdefault(pid, i + 2)
    if bad:
        columns = sorted({b["column"] for b in bad if b["column"]})
        raise TilekitError(f"{path.name} has {len(bad)} invalid value(s) in columns {columns}",
                           {"bad_rows": bad[:MAX_BAD], "bad_count": len(bad), "columns": columns})
    return ids, values, header, rows


# ---------------------------------------------------------------- run

def run_portfolio(model, model_points_file, name, id_column="policy_id"):
    """The `run` command."""
    folder = run_dir(model, name, must_exist=False)
    ids, values, header, rows = read_portfolio(model, model_points_file, id_column)
    fields = list(values)
    months = model.config.months
    started = time.monotonic()
    params = model.default_params()
    with np.errstate(all="ignore"):
        raw = project(model, values, params, months)
    summary = set(summary_names(model))
    results = _squeeze(raw, summary)
    seconds = time.monotonic() - started

    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    np.savez(folder / "results.npz", **results)
    with (folder / "model_points.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)

    totals, summary_totals = _totals(model, results, summary)
    _write_json(folder / "totals.json", {"months": months, "totals": totals, "summary_totals": summary_totals})
    run = {"name": name, "at": _now(), "source_file": str(Path(model_points_file).resolve()), "policies": len(ids),
           "months": months, "model_stamp": model_stamp(model), "id_column": id_column, "fields": fields}
    _write_json(folder / "run.json", run)
    return {"run": name, "policies": len(ids), "months": months, "seconds": round(seconds, 3),
            "summary_totals": summary_totals}


def _finite_sum(array, axis):
    return np.where(np.isfinite(array), array, 0.0).sum(axis=axis)


def _totals(model, results, summary):
    from tilekit.workbook import ModelInfo
    info = ModelInfo(model)
    totals = {}
    for name, array in results.items():
        if name in summary or info.fmt(name) != "amount":
            continue
        totals[name] = [plain_float(v) for v in _finite_sum(array, axis=1)]
    summary_totals = {name: plain_float(_finite_sum(results[name], axis=0)) for name in summary_names(model)
                      if info.fmt(name) == "amount"}
    return totals, summary_totals


def list_runs(model):
    """The `runs` command."""
    current = model_stamp(model)
    out = []
    for path in runs_dir(model).glob("*/run.json"):
        try:
            run = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        out.append({**run, "current": run.get("model_stamp") == current})
    out.sort(key=lambda r: (r.get("at", ""), r.get("name", "")), reverse=True)
    return {"runs": out}


def runs_summary(model):
    """Small summary for `status`: how many runs are stored and which is newest."""
    found = []
    for path in runs_dir(model).glob("*/run.json"):
        try:
            found.append(json.loads(path.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    found.sort(key=lambda r: (r.get("at", ""), r.get("name", "")), reverse=True)
    return {"count": len(found), "newest": found[0].get("name") if found else None}


# ---------------------------------------------------------------- loading a stored run

class StoredRun:
    def __init__(self, model, name):
        self.model = model
        self.name = name
        self.folder = run_dir(model, name)
        self.run = json.loads((self.folder / "run.json").read_text())
        npz = self.folder / "results.npz"
        if not npz.is_file():
            raise TilekitError(f"Run '{name}' has no results.npz")
        with np.load(npz) as data:
            self.results = {k: data[k] for k in data.files}
        self.summary = set(summary_names(model))
        stored = set(self.results)
        graph_names = set(self.summary) | set(model.graph.step_order())
        missing = sorted(graph_names - stored)
        if missing:
            raise TilekitError(f"Run '{name}' was made with a different model (no stored results for {missing}); "
                               "run it again")
        self.months = int(self.run["months"])
        with (self.folder / "model_points.csv").open(newline="") as handle:
            reader = csv.DictReader(handle)
            idc = self.run["id_column"]
            self.ids, self.points = [], []
            for row in reader:
                if not any((v or "").strip() for v in row.values()):
                    continue
                self.ids.append(row[idc].strip())
                self.points.append({f: float(row[f]) for f in self.run["fields"]})
        self.n = len(self.ids)
        self._by_id = {pid: i for i, pid in enumerate(self.ids)}

    def index(self, policy):
        if policy not in self._by_id:
            raise TilekitError(f"No policy '{policy}' in run '{self.name}'")
        return self._by_id[policy]

    def one(self, i):
        """One policy's results in the engine's shapes: step (months, 1, 1), summary (1, 1)."""
        return {name: (a[i].reshape(1, 1) if name in self.summary else a[:, i].reshape(self.months, 1, 1))
                for name, a in self.results.items()}


def _headline_names(model):
    """Step quantities named in `[runs] headline` in tilekit.toml (the loader ignores that table)."""
    data = tomllib.loads((model.root / "tilekit.toml").read_text())
    names = (data.get("runs") or {}).get("headline") or []
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise TilekitError("tilekit.toml: [runs] headline must be a list of quantity names")
    known = set(model.graph.step_order()) | {s.name for s in model.config.states} | \
        {i.name for i in model.config.input_series}
    unknown = [n for n in names if n not in known]
    if unknown:
        raise TilekitError(f"tilekit.toml: [runs] headline names unknown step quantities: {unknown}",
                           {"step_quantities": sorted(known)})
    return names


# ---------------------------------------------------------------- branch signatures

def _taken(node, env, mask, out, labels):
    """Mirror of translate._count that records, per policy, whether each branch was taken in any month."""
    if isinstance(node, Call) and node.branch is not None:
        kind = EXCEL_FUNCTIONS[node.func].branch
        values = [evaluate(a, env) for a in node.args]
        if kind == "if":
            cond = np.asarray(values[0], dtype=bool)
            taken = [cond, ~cond]
            arg_masks = [mask, mask & cond, mask & ~cond]
        elif kind in ("min", "max"):
            a, b = np.asarray(values[0]), np.asarray(values[1])
            first = a <= b if kind == "min" else a >= b
            taken = [first, ~first]
            arg_masks = [mask, mask]
        else:
            x, low, high = (np.asarray(v) for v in values)
            is_low = x <= low
            is_middle = ~is_low & (x <= high)
            taken = [is_low, is_middle, ~is_low & ~is_middle]
            arg_masks = [mask, mask, mask]
        for label, alternative in zip(labels[node.branch], taken):
            hit = np.broadcast_to(np.logical_and(mask, alternative), mask.shape)
            out[label] = out.get(label, False) | (hit.any(axis=0) if hit.ndim > 1 else hit)
        for arg, arg_mask in zip(node.args, arg_masks):
            _taken(arg, env, np.broadcast_to(arg_mask, mask.shape), out, labels)
        return
    for child in children(node):
        _taken(child, env, mask, out, labels)


def policy_signatures(model, params, results, n_pol, months):
    """{(tile, label): bool array (n_pol,)}: policies that take the branch at least once.

    `results` has step quantities (months, n_pol) and summary quantities (n_pol,).
    """
    graph = model.graph
    summary = set(graph.summary_order())
    out = {}
    for name, translation in model_translations(model).items():
        if not translation.translatable or not translation.branches:
            continue
        tile = graph.tiles[name]
        env = {}
        for arg in tile.args:
            env[arg] = float(getattr(params, arg)) if graph.kinds[arg] == "param" else results[arg]
        is_summary = graph.timings[name] == "summary"
        mask = np.ones((n_pol,) if is_summary else (months, n_pol), dtype=bool)
        kinds = _branch_kinds(translation.expr, [])
        labels = [branch_labels_for(kind, i, len(kinds) > 1) for i, kind in enumerate(kinds)]
        found = {}
        with np.errstate(all="ignore"):
            _taken(translation.expr, env, mask, found, labels)
        for label in translation.branches:
            out[(name, label)] = np.broadcast_to(found.get(label, np.zeros(n_pol, dtype=bool)), (n_pol,)).copy()
    return out


def case_coverage(model):
    """The set of (tile, label) taken at least once by some synthetic case."""
    covered = set()
    summary = set(summary_names(model))
    for case in load_cases(model):
        _, params, raw = run_case(model, case.id)
        sig = policy_signatures(model, params, _squeeze(raw, summary), 1, case_months(model, case))
        covered |= {key for key, taken in sig.items() if taken[0]}
    return covered


def _signatures(model, stored):
    """(keys, matrix (n_keys, n_pol) bool), cached in the run folder against the model stamp."""
    meta, matrix = stored.folder / "signatures.json", stored.folder / "signatures.npz"
    stamp = model_stamp(model)
    if meta.is_file() and matrix.is_file():
        try:
            doc = json.loads(meta.read_text())
            if doc.get("stamp") == stamp:
                with np.load(matrix) as data:
                    return [tuple(k) for k in doc["keys"]], data["matrix"]
        except (json.JSONDecodeError, OSError, KeyError, ValueError):
            pass
    sig = policy_signatures(model, model.default_params(), stored.results, stored.n, stored.months)
    keys = list(sig)
    array = np.array([sig[k] for k in keys], dtype=bool).reshape(len(keys), stored.n)
    np.savez(matrix, matrix=array)
    _write_json(meta, {"stamp": stamp, "keys": [list(k) for k in keys]})
    return keys, array


def _flag_masks(model, stored):
    keys, matrix = _signatures(model, stored)
    covered = case_coverage(model)
    uncovered = np.zeros(stored.n, dtype=bool)
    for (key, row) in zip(keys, matrix):
        if key not in covered:
            uncovered |= row
    nan = np.zeros(stored.n, dtype=bool)  # a step series has a non-finite value: a real problem
    undefined = np.zeros(stored.n, dtype=bool)  # a summary quantity is non-finite (e.g. no IRR without a sign change)
    for name, array in stored.results.items():
        bad = ~np.isfinite(array)
        if name in stored.summary:
            undefined |= bad
        else:
            nan |= bad.any(axis=0) if array.ndim == 2 else bad
    return {"uncovered": uncovered, "nan": nan, "undefined": undefined}


# ---------------------------------------------------------------- policies

def policies_json(model, run, sort=None, desc=False, limit=None, offset=0, search=None, flag=None):
    """The `policies` command."""
    if flag is not None and flag not in FLAGS:
        raise TilekitError(f"Unknown flag '{flag}'", {"flags": list(FLAGS)})
    if limit is not None and limit < 0 or offset < 0:
        raise TilekitError("--limit and --offset must not be negative")
    stored = StoredRun(model, run)
    fields = stored.run["fields"]
    summary = summary_names(model)
    headline_steps = _headline_names(model)
    headline_keys = [*summary, *[h for h in headline_steps if h not in summary]]

    def headline_array(key):
        a = stored.results[key]
        return a if key in stored.summary else a[stored.months - 1]

    headline = {k: headline_array(k) for k in headline_keys}
    flags = _flag_masks(model, stored)

    keep = np.ones(stored.n, dtype=bool)
    if search:
        needle = search.lower()
        keep &= np.array([needle in pid.lower() for pid in stored.ids], dtype=bool)
    if flag:
        keep &= flags[flag]
    order = np.flatnonzero(keep)

    if sort:
        if sort in fields:
            column = np.array([p[sort] for p in stored.points], dtype=np.float64)
        elif sort in headline:
            column = headline[sort]
        elif sort in ("id", "index"):
            column = None
        else:
            raise TilekitError(f"Cannot sort by '{sort}'",
                               {"keys": ["id", "index", *fields, *headline_keys]})
        if sort == "id":
            order = np.array(sorted(order, key=lambda i: stored.ids[i], reverse=desc), dtype=int)
        elif column is not None:
            sub = column[order]
            finite = np.isfinite(sub)
            ordered = order[finite][np.argsort(sub[finite] * (-1 if desc else 1), kind="stable")]
            order = np.concatenate([ordered, order[~finite]]).astype(int)  # NaN and infinite values last
        elif desc:
            order = order[::-1]
    elif desc:
        order = order[::-1]

    total = len(order)
    page = order[offset:] if limit is None else order[offset:offset + limit]
    rows = []
    for i in page:
        i = int(i)
        rows.append({
            "id": stored.ids[i], "index": i,
            "model_point": {f: _clean_number(stored.points[i][f]) for f in fields},
            "headline": {k: plain_float(headline[k][i]) for k in headline_keys},
            "flags": [f for f in FLAGS if flags[f][i]],
        })
    return {"run": run, "total": total, "policies": rows,
            "flags": {f: int(flags[f].sum()) for f in FLAGS}}


def _clean_number(value):
    return int(value) if float(value).is_integer() and abs(value) < 1e15 else float(value)


# ---------------------------------------------------------------- trace

def trace_run_json(model, run, policy):
    """The `trace --run RUN --policy ID` document, read from the stored results."""
    stored = StoredRun(model, run)
    i = stored.index(policy)
    graph = model.graph
    params = model.default_params()
    one = stored.one(i)
    series = {name: [plain_float(v) for v in values[:, 0, 0]] for name, values in one.items()
              if name not in stored.summary}
    summary = {name: plain_float(one[name][0, 0]) for name in graph.summary_order()}
    return {"case": None, "run": run, "policy": policy, "months": stored.months,
            "params": dataclasses.asdict(params), "series": series, "summary": summary,
            "branches": branch_counts(model, params, one, stored.months),
            "near_ties": near_tie_map(model, params, one, stored.months)}


# ---------------------------------------------------------------- workbooks

def _safe_folder(policy):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", policy).strip(".") or "policy"
    return safe if safe == policy else f"{safe}-{sha1(policy.encode()).hexdigest()[:6]}"


def policy_dir(model, run, policy):
    return run_dir(model, run) / "policies" / _safe_folder(policy)


def _policy_data(model, stored, policy):
    """`workbook.CaseData` for one stored real policy."""
    from tilekit.workbook import CaseData
    i = stored.index(policy)
    label = real_data_label(stored.name, policy)
    case = SimpleNamespace(id=f"policy-{_safe_folder(policy)}", name=label, purpose=label,
                           model_point=stored.points[i], params={}, months=None, file=None)
    return CaseData.from_results(model, case, model.default_params(), stored.one(i), stored.months)


def real_data_label(run, policy):
    return f"Real data: policy {policy}, run {run}"


def _relative(model, path):
    try:
        return path.relative_to(model.root).as_posix()
    except ValueError:
        return str(path)


def build_policy(model, run, policy, tile=None, module=None, whole_model=False, gridcraft=None):
    """The `build --run RUN --policy ID` command. Without a target only the model workbook is built.

    Workbooks go only under `real-data/runs/<RUN>/policies/<ID>/`; tile and module workbooks have one sheet
    named "Policy <ID>", and every sheet's second title line is the real-data label.
    """
    from tilekit import workbook as wb
    from tilekit.gridcraft import GridCraft, require_cli
    graph = model.graph
    if tile and tile not in graph.tiles:
        raise TilekitError(f"Unknown tile '{tile}'", {"tiles": list(graph.order)})
    if module:
        model.config.module(module)
        if not graph.modules[module].tiles:
            raise TilekitError(f"Module '{module}' has no tiles")
    stored = StoredRun(model, run)
    data = _policy_data(model, stored, policy)
    base = policy_dir(model, run, policy)
    gridcraft = gridcraft or GridCraft(require_cli(model.root))
    label = data.case.name
    sheet = f"Policy {policy}"
    extra = {"real_data": {"run": run, "policy": policy, "label": label}}
    built = []

    def paths(*parts):
        folder = base.joinpath(*parts)
        return folder / "workbook.xlsx", folder / "workbook.json"

    def finish(kind, name, xlsx, document, started):
        built.append({"kind": kind, "name": name, "workbook": _relative(model, xlsx),
                      "checks_pass": document["checks_pass"], "max_abs_difference": document["max_abs_difference"],
                      "seconds": round(time.monotonic() - started, 3)})

    if tile:
        started = time.monotonic()
        where = paths("tiles", tile)
        document = wb.build_tile(model, gridcraft, tile, [data], tile_stamp(model, tile), paths=where, sheet=sheet,
                                 label=label, extra=extra)
        finish("tile", tile, where[0], document, started)
    if module:
        started = time.monotonic()
        where = paths("modules", module)
        document = wb.build_module(model, gridcraft, module, [data], module_stamp(model, module), paths=where,
                                   sheet=sheet, label=label, extra=extra)
        finish("module", module, where[0], document, started)
    if whole_model or not (tile or module):
        started = time.monotonic()
        where = paths("model")
        document = wb.build_model(model, gridcraft, data, model_stamp(model), paths=where, label=label, extra=extra)
        finish("model", model.config.name, where[0], document, started)
    return {"run": run, "policy": policy, "label": label, "built": built}


# ---------------------------------------------------------------- promote

def round_sig(value, digits=3):
    if value == 0 or not math.isfinite(value):
        return value
    return round(value, digits - 1 - math.floor(math.log10(abs(value))))


def promote(model, run, policy, case_id, name, purpose=None):
    """The `promote` command: write `cases/<case_id>.json` from one real policy."""
    if not isinstance(case_id, str) or not CASE_SLUG.fullmatch(case_id):
        raise TilekitError(f"'{case_id}' is not a valid case id; use lower-case letters, digits, '_' and '-'")
    path = model.root / "cases" / f"{case_id}.json"
    if path.exists():
        raise TilekitError(f"Case '{case_id}' already exists", {"file": _relative(model, path)})
    stored = StoredRun(model, run)
    i = stored.index(policy)
    flags = _flag_masks(model, stored)
    taken = [f for f in FLAGS if flags[f][i]]
    point = {}
    for field, value in stored.points[i].items():
        exact = bool(EXACT_FIELD.search(field))
        value = value if exact else round_sig(value)
        point[field] = int(value) if float(value).is_integer() else float(value)
    document = {
        "id": case_id, "name": name,
        "purpose": purpose or "Promoted from a real policy: " + (", ".join(taken) if taken else "no flags"),
        "model_point": point, "params": {},
    }
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(document, indent=2, allow_nan=False) + "\n")
    return {"case": document, "file": _relative(model, path),
            "note": "Sign-offs will show a new case to review: tiles that were signed off now list "
                    f"'{case_id}' as a new case until they are reviewed again."}
