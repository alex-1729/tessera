"""Properties that hold for every case, and the model's invariants under special parameters."""

import dataclasses

import numpy as np
import pytest

from tilekit.cases import case_model_points, case_months, case_params, get_case
from tilekit.checks import run_checks
from tilekit.config import Model
from tilekit.engine import project
from tilekit.trace import run_case



def run_with(model, case_id, **overrides):
    """Project a case with some parameters overridden."""
    case = get_case(model, case_id)
    params = dataclasses.replace(case_params(model, case), **overrides)
    return project(model, case_model_points(case), params, case_months(model, case))


# ---------------------------------------------------------------- unit projection

def test_zero_premium_gives_zero_units(model, named_case):
    _, _, r = run_case(model, named_case("zero_premium"))
    for name in ["units_bop", "units_allocated", "units_after_alloc", "units_amc", "units_eop"]:
        assert np.all(r[name] == 0.0), name


def test_closing_units_are_after_alloc_less_amc(model, case_id):
    _, _, r = run_case(model, case_id)
    np.testing.assert_array_equal(r["units_eop"], r["units_after_alloc"] - r["units_amc"])


def test_opening_units_are_last_months_closing(model, case_id):
    _, _, r = run_case(model, case_id)
    assert np.all(r["units_bop"][0] == 0.0)
    np.testing.assert_array_equal(r["units_bop"][1:], r["units_eop"][:-1])


def test_units_never_negative(model, case_id):
    _, _, r = run_case(model, case_id)
    for name in ["units_bop", "units_allocated", "units_after_alloc", "units_amc", "units_eop"]:
        assert np.all(r[name] >= 0.0), name


# ---------------------------------------------------------------- decrements

def test_in_force_never_increases(model, case_id):
    _, _, r = run_case(model, case_id)
    in_force = np.concatenate([r["in_force_bop"][:1, 0, 0], r["in_force_eop"][:, 0, 0]])
    assert in_force[0] == 1.0
    assert np.all(np.diff(in_force) <= 0)
    assert np.all(in_force > 0)


def test_opening_in_force_is_last_months_closing(model, case_id):
    _, _, r = run_case(model, case_id)
    np.testing.assert_array_equal(r["in_force_bop"][1:], r["in_force_eop"][:-1])


def test_zero_decrements_leave_in_force_at_one(model, named_case):
    """With no mortality (inputs zeroed after build_inputs) and no lapses, every policy stays in force."""
    def without_mortality(model_points, params, months):
        inputs = model.build_inputs(model_points, params, months)
        return {**inputs, "mort_rate_pa": np.zeros_like(inputs["mort_rate_pa"]),
                "mort_rate_pm": np.zeros_like(inputs["mort_rate_pm"])}

    immortal = Model(model.config, model.package, model.params_class, without_mortality, model.python_modules)
    r = run_with(immortal, named_case("base"), lapse_rate_pa=0.0)
    assert np.all(r["lapse_rate_pm"] == 0.0)
    for name in ["in_force_bop", "in_force_eop"]:
        assert np.all(r[name] == 1.0), name
    for name in ["deaths", "lapses", "death_strain", "reinsurance_premium"]:
        assert np.all(r[name] == 0.0), name


# ---------------------------------------------------------------- cashflows and treaty

def test_gross_equals_ceded_plus_retained_death_strain(model, case_id):
    _, _, r = run_case(model, case_id)
    np.testing.assert_allclose(r["ceded_death_strain"] + r["retained_death_strain"], r["death_strain"],
                               rtol=0, atol=1e-12)


def test_outflows_are_negative_and_inflows_positive(model, case_id):
    _, _, r = run_case(model, case_id)
    for name in ["maintenance_expense", "acquisition_expense", "death_strain", "ceded_death_strain",
                 "retained_death_strain", "reinsurance_premium"]:
        assert np.all(r[name] <= 0), name
    for name in ["premium_income", "allocation_margin", "amc_income", "sum_at_risk"]:
        assert np.all(r[name] >= 0), name


def test_zero_quota_share_makes_net_profit_equal_gross_profit(model, named_case):
    r = run_with(model, named_case("base"), quota_share=0.0)
    assert np.all(r["ceded_death_strain"] == 0.0)
    assert np.all(r["reinsurance_premium"] == 0.0)
    np.testing.assert_array_equal(r["retained_death_strain"], r["death_strain"])
    np.testing.assert_array_equal(r["net_profit"], r["gross_profit"])
    np.testing.assert_array_equal(r["pv_net_profit"], r["pv_gross_profit"])


def test_reinsurance_costs_the_loading_on_average(model, named_case):
    """With the expected strain ceded, the cedant's net cost of reinsurance is the loading on the
    ceded expected strain; since actual deaths equal expected deaths here, net - gross is exactly that."""
    _, params, r = run_case(model, named_case("base"))
    expected_ceded = r["death_strain"] * params.quota_share
    np.testing.assert_allclose(r["net_profit"] - r["gross_profit"], expected_ceded * params.reinsurance_loading,
                               rtol=0, atol=1e-12)


def test_no_charges_or_expenses_and_full_allocation_leave_only_the_death_strain(model, named_case):
    r = run_with(model, named_case("base"), allocation_rate=1.0, amc_pm=0.0, expense_pm=0.0, acquisition_cost=0.0)
    np.testing.assert_allclose(r["gross_profit"] - r["death_strain"], 0.0, rtol=0, atol=1e-12)
    assert np.any(r["death_strain"] < 0)


# ---------------------------------------------------------------- profit

def test_present_value_at_zero_discount_is_the_undiscounted_sum(model, named_case):
    r = run_with(model, named_case("base"), discount_rate_pa=0.0)
    assert np.all(r["discount_factor"] == 1.0)
    np.testing.assert_allclose(r["pv_gross_profit"], np.sum(r["gross_profit"], axis=0), rtol=0, atol=1e-9)
    np.testing.assert_allclose(r["pv_net_profit"], np.sum(r["net_profit"], axis=0), rtol=0, atol=1e-9)
    np.testing.assert_allclose(r["pv_premium"], np.sum(r["premium_income"], axis=0), rtol=0, atol=1e-9)


def test_net_profit_has_zero_value_at_the_irr(model, case_id):
    _, _, r = run_case(model, case_id)
    rate = float(r["irr_pm"][0, 0])
    if not np.isfinite(rate):
        pytest.skip(f"case '{case_id}' has no IRR (its net profit never changes sign)")
    flows = r["net_profit"][:, 0, 0]
    value = np.sum(flows / (1 + rate) ** np.arange(flows.size))
    assert abs(value) < 1e-9


def test_zero_premium_has_no_margin_or_irr(model, named_case):
    _, _, r = run_case(model, named_case("zero_premium"))
    assert np.isneginf(r["profit_margin"][0, 0])
    assert np.isnan(r["irr_pm"][0, 0]) and np.isnan(r["irr_pa"][0, 0])


def test_model_passes_rule_checks(model):
    errors = [v for v in run_checks(model) if v["severity"] == "error"]
    assert errors == []


def test_tilekit_check_reports_no_errors_or_warnings(model):
    from tilekit.checks import checks_json

    assert checks_json(model)["counts"] == {"error": 0, "warning": 0}
