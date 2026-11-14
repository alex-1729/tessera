"""The tilekit engine against the hand-written reference loop, and vectorised against single-policy runs."""

import math

import numpy as np
import pytest

from tilekit.cases import case_months, case_params, get_case, load_cases
from tilekit.engine import project
from tilekit.trace import run_case
from unit_linked.reference import run_reference

def test_every_case_file_loads(model):
    assert [c.id for c in load_cases(model)] == sorted(p.stem for p in (model.root / "cases").glob("*.json"))


def test_engine_matches_reference(model, case_id):
    case, params, results = run_case(model, case_id)
    series, summary = run_reference(case.model_point, params, case_months(model, case))
    for name, values in series.items():
        np.testing.assert_allclose(results[name][:, 0, 0], values, rtol=0, atol=1e-10, err_msg=name)
    for name, value in summary.items():
        got = float(results[name][0, 0])
        if math.isfinite(value):
            assert got == pytest.approx(value, rel=0, abs=1e-10), name
        else:
            assert not math.isfinite(got), name
    assert set(series) | set(summary) >= set(model.graph.order)


def test_high_charge_cap_bites(model, named_case):
    _, params, results = run_case(model, named_case("high_charge"))
    amc = results["units_amc"][:, 0, 0]
    assert amc[0] < params.amc_cap_units
    assert amc[-1] == params.amc_cap_units


def test_fund_overtakes_the_sum_assured(model, named_case):
    _, _, results = run_case(model, named_case("fund_overtakes"))
    at_risk = results["sum_at_risk"][:, 0, 0]
    assert at_risk[0] > 0 and at_risk[-1] == 0


def test_vectorised_equals_single_policy_runs(model, named_case):
    """Policies projected together equal each projected alone (sums over time may differ in the last bit,
    so present values compare to 1e-13 relative)."""
    rng = np.random.default_rng(20261114)
    n_pol = 1000
    months = model.config.months
    points = {
        "premium_pm": rng.uniform(0.0, 2000.0, n_pol),
        "premium_months": rng.integers(0, months + 1, n_pol).astype(np.float64),
        "age_at_entry": rng.integers(18, 90, n_pol).astype(np.float64),
        "sum_assured": rng.uniform(0.0, 200_000.0, n_pol),
    }
    params = case_params(model, get_case(model, named_case("high_charge")))
    together = project(model, points, params, months)

    for i in range(n_pol):
        single = project(model, {k: v[i:i + 1] for k, v in points.items()}, params, months)
        for name, values in single.items():
            np.testing.assert_allclose(together[name][..., i:i + 1], values, rtol=1e-13, atol=1e-10, err_msg=name)


def test_fifty_policies_together_equal_fifty_alone_for_every_summary(model, named_case):
    """C4: a summary quantity of one policy must not depend on the other policies projected with it."""
    rng = np.random.default_rng(50)
    months = model.config.months
    points = {
        "premium_pm": rng.uniform(0.0, 1000.0, 50),
        "premium_months": rng.integers(0, months + 1, 50).astype(np.float64),
        "age_at_entry": rng.integers(18, 90, 50).astype(np.float64),
        "sum_assured": rng.uniform(0.0, 200_000.0, 50),
    }
    params = case_params(model, get_case(model, named_case("base")))
    together = project(model, points, params, months)
    summaries = model.graph.summary_order()
    assert summaries
    for i in range(50):
        alone = project(model, {k: v[i:i + 1] for k, v in points.items()}, params, months)
        for name in summaries:
            np.testing.assert_allclose(together[name][0, i], alone[name][0, 0], rtol=1e-12, atol=1e-9,
                                       err_msg=f"{name}, policy {i}")
