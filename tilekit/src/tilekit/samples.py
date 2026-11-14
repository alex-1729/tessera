"""A synthetic portfolio CSV for trying the real-data feature without real data.

Each model-point field is drawn from between 0.5x and 2x of the range seen across the model's
cases (integer-valued fields stay integers), with a small share of edge values such as zero.
"""

import csv
import math
from pathlib import Path

import numpy as np

from tilekit.cases import load_cases
from tilekit.errors import TilekitError
from tilekit.runs import model_point_fields

EDGE_SHARE = 0.03


def _table_bounds(model, values):
    """(lowest key, highest key minus the projection length in years) of an integer-keyed assumption table
    whose key range holds every value the cases give the field; None when no table does.

    This is a heuristic: it keeps a field like `age_at_entry` inside the mortality table. It cannot see
    what `build_inputs` really does, so it may miss a field that is table-keyed in some other way.
    """
    years = math.ceil(model.config.months / 12)
    for table in model.config.tables:
        keys = table.column(table.columns[0])
        if all(float(k).is_integer() for k in keys) and min(keys) <= min(values) and max(values) <= max(keys):
            high = max(keys) - years
            if high >= max(values):
                return min(keys), high
    return None


def _field_ranges(model, fields):
    cases = load_cases(model)
    ranges = {}
    for field in fields:
        values = [float(c.model_point[field]) for c in cases if field in c.model_point]
        lo, hi = min(values), max(values)
        low = min(lo * 0.5, lo * 2)
        high = max(hi * 0.5, hi * 2)
        integer = all(float(v).is_integer() for v in values)
        seen = sorted({lo, hi})
        bound = _table_bounds(model, values) if integer else None
        if bound:  # keep a table-keyed field (such as age) inside its table for the whole projection
            low, high = max(low, bound[0]), min(high, bound[1])
            seen = [v for v in seen if low <= v <= high]
        ranges[field] = (low, high, integer, seen, bound is not None)
    return ranges


def sample_portfolio(model, out, policies, seed=0):
    """Write `policies` synthetic policies to `out`; returns the command's JSON document."""
    if policies < 1:
        raise TilekitError("--policies must be at least 1")
    fields = model_point_fields(model)
    ranges = _field_ranges(model, fields)
    rng = np.random.default_rng(seed)
    columns = {}
    for field in fields:
        low, high, integer, seen, bounded = ranges[field]
        values = rng.uniform(low, high, policies)
        if integer:
            values = np.clip(np.rint(values), math.ceil(low), math.floor(high)) if bounded else np.rint(values)
        else:
            values = np.round(values, 2)
        edges = [*seen] if bounded else [0.0, *seen]
        is_edge = rng.random(policies) < EDGE_SHARE
        picks = rng.integers(0, len(edges), policies)
        values = np.where(is_edge, np.array(edges)[picks], values)
        columns[field] = values
    width = max(6, len(str(policies)))
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["policy_id", *fields])
        for i in range(policies):
            row = [f"P{i + 1:0{width}d}"]
            for field in fields:
                v = float(columns[field][i])
                row.append(str(int(v)) if ranges[field][2] else repr(round(v, 2)))
            writer.writerow(row)
    return {"file": str(path), "policies": policies, "seed": seed, "fields": fields,
            "note": "Synthetic data for trying the real-data feature; not a real portfolio."}
