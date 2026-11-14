"""Run one case and report every quantity's values."""

import dataclasses
import math

from tilekit.cases import case_model_points, case_months, case_params, get_case
from tilekit.engine import project
from tilekit.translate import count_branches, model_translations, near_ties, tile_env


def plain_float(value):
    """A JSON-safe float: NaN and infinities become None."""
    value = float(value)
    return value if math.isfinite(value) else None


def run_case(model, case_id):
    """(case, params, results) for one case; results as returned by `engine.project`."""
    case = get_case(model, case_id)
    params = case_params(model, case)
    months = case_months(model, case)
    results = project(model, case_model_points(case), params, months)
    return case, params, results


def trace_json(model, case_id):
    """The `tilekit trace --case ID` document. Values are for scenario 0, policy 0."""
    case, params, results = run_case(model, case_id)
    graph = model.graph
    summary_names = set(graph.summary_order())
    series = {
        name: [plain_float(v) for v in values[:, 0, 0]]
        for name, values in results.items() if name not in summary_names
    }
    summary = {name: plain_float(results[name][0, 0]) for name in graph.summary_order()}
    return {
        "case": case.id,
        "months": case_months(model, case),
        "params": dataclasses.asdict(params),
        "series": series,
        "summary": summary,
        "branches": branch_counts(model, params, results, case_months(model, case)),
        "near_ties": near_tie_map(model, params, results, case_months(model, case)),
    }


def branch_counts(model, params, results, months):
    """{tile: {branch label: months taken}} for every tile that has branches."""
    graph = model.graph
    counts = {}
    for name, translation in model_translations(model).items():
        if translation.branches:
            env, n = tile_env(graph.tiles[name], graph, params, results, months)
            counts[name] = count_branches(translation, env, n)
    return counts


def near_tie_map(model, params, results, months):
    """{tile: [{"comparison", "month"}]} for every tile with a comparison within rounding of a tie."""
    graph = model.graph
    out = {}
    for name, translation in model_translations(model).items():
        env, n = tile_env(graph.tiles[name], graph, params, results, months)
        found = near_ties(translation, env, n)
        if found:
            out[name] = found
    return out
