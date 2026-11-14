"""A slow, readable, single-policy monthly loop, written out by hand.

It restates the whole model's arithmetic (inputs, unit projection, decrements,
cashflows, quota share and profit) without tilekit's engine, the tile functions or
`build_inputs`, so the engine can be checked against it. Plain Python floats only.
"""

import csv
import math
from pathlib import Path

MORTALITY_FILE = Path(__file__).resolve().parents[2] / "assumptions" / "mortality.csv"

QUANTITIES = [
    "month", "premium", "unit_price", "age_at_entry", "attained_age", "mort_rate_pa", "mort_rate_pm",
    "lapse_rate_pm", "sum_assured", "acquisition_cost_paid", "discount_rate_pm", "discount_factor",
    "units_bop", "units_allocated", "units_after_alloc", "units_amc", "units_eop",
    "in_force_bop", "deaths", "lapses", "in_force_eop",
    "fund_value_eop", "premium_income", "allocation_margin", "amc_income", "maintenance_expense",
    "acquisition_expense", "sum_at_risk", "death_strain", "gross_profit",
    "ceded_death_strain", "retained_death_strain", "reinsurance_premium", "net_profit",
]


def read_mortality():
    """{age: annual q} from the mortality table."""
    with MORTALITY_FILE.open(newline="") as handle:
        return {int(row["age"]): float(row["qx"]) for row in csv.DictReader(handle)}


def irr_by_bisection(cashflows):
    """The rate r with sum cashflows[t] / (1 + r)^t = 0, t = 0.., by plain bisection on (-0.99, 1).

    Assumes one sign change (one root in that interval); returns NaN when there is none.
    """
    def value(rate):
        return sum(cf / (1 + rate) ** t for t, cf in enumerate(cashflows))

    low, high = -0.99, 1.0
    if value(low) * value(high) > 0:
        return math.nan
    for _ in range(200):
        mid = (low + high) / 2
        if value(mid) * value(low) > 0:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def run_reference(model_point, params, months):
    """Project one policy month by month.

    Returns (series, summary): series maps each quantity to a list of floats, one per
    month; summary maps each present value, the margin and the IRRs to a float.
    """
    premium_pm = model_point["premium_pm"]
    premium_months = model_point["premium_months"]
    age_at_entry = model_point["age_at_entry"]
    sum_assured = model_point["sum_assured"]
    per_year = params.months_per_year
    mortality = read_mortality()

    growth_pm = (1 + params.unit_growth_pa) ** (1 / per_year) - 1
    lapse_pm = 1 - (1 - params.lapse_rate_pa) ** (1 / per_year)
    discount_pm = (1 + params.discount_rate_pa) ** (1 / per_year) - 1

    out = {name: [] for name in QUANTITIES}
    units = 0.0  # opening units of month 1
    in_force = 1.0  # opening in force of month 1
    for month in range(1, months + 1):
        # inputs
        premium = premium_pm if month <= premium_months else 0.0
        unit_price = params.initial_unit_price * (1 + growth_pm) ** (month - 1)
        attained_age = age_at_entry + (month - 1) // per_year
        q_pa = mortality[int(attained_age)]
        q_pm = 1 - (1 - q_pa) ** (1 / per_year)
        acquisition_paid = params.acquisition_cost if month == 1 else 0.0
        discount_factor = 1 / (1 + discount_pm) ** month

        # unit projection, per policy in force
        opening_units = units
        allocated = premium * params.allocation_rate / unit_price
        after_alloc = opening_units + allocated
        charge_units = min(after_alloc * params.amc_pm, params.amc_cap_units)
        closing_units = after_alloc - charge_units

        # decrements at the end of the month: deaths first, then lapses of the survivors
        opening_in_force = in_force
        died = opening_in_force * q_pm
        lapsed = (opening_in_force - died) * lapse_pm
        closing_in_force = opening_in_force - died - lapsed

        # gross cashflows per policy at entry; inflows positive
        fund = closing_units * unit_price
        premium_in = premium * opening_in_force
        margin = premium * (1 - params.allocation_rate) * opening_in_force
        charge_income = charge_units * unit_price * opening_in_force
        maintenance = -params.expense_pm * opening_in_force
        acquisition = -acquisition_paid * opening_in_force
        at_risk = max(sum_assured - fund, 0.0)
        strain = -died * at_risk
        gross = margin + charge_income + maintenance + acquisition + strain

        # quota share, for the cedant
        ceded = strain * params.quota_share
        retained = strain - ceded
        risk_premium = -at_risk * opening_in_force * q_pm * params.quota_share * (1 + params.reinsurance_loading)
        net = gross - ceded + risk_premium

        values = {
            "month": month, "premium": premium, "unit_price": unit_price, "age_at_entry": age_at_entry,
            "attained_age": attained_age, "mort_rate_pa": q_pa, "mort_rate_pm": q_pm, "lapse_rate_pm": lapse_pm,
            "sum_assured": sum_assured, "acquisition_cost_paid": acquisition_paid, "discount_rate_pm": discount_pm,
            "discount_factor": discount_factor,
            "units_bop": opening_units, "units_allocated": allocated, "units_after_alloc": after_alloc,
            "units_amc": charge_units, "units_eop": closing_units,
            "in_force_bop": opening_in_force, "deaths": died, "lapses": lapsed, "in_force_eop": closing_in_force,
            "fund_value_eop": fund, "premium_income": premium_in, "allocation_margin": margin,
            "amc_income": charge_income, "maintenance_expense": maintenance, "acquisition_expense": acquisition,
            "sum_at_risk": at_risk, "death_strain": strain, "gross_profit": gross,
            "ceded_death_strain": ceded, "retained_death_strain": retained, "reinsurance_premium": risk_premium,
            "net_profit": net,
        }
        for name in QUANTITIES:
            out[name].append(float(values[name]))
        units = closing_units
        in_force = closing_in_force

    pv_gross = sum(g * v for g, v in zip(out["gross_profit"], out["discount_factor"]))
    pv_net = sum(n * v for n, v in zip(out["net_profit"], out["discount_factor"]))
    pv_prem = sum(p * v for p, v in zip(out["premium_income"], out["discount_factor"]))
    irr_month = irr_by_bisection(out["net_profit"])
    summary = {
        "pv_gross_profit": pv_gross,
        "pv_net_profit": pv_net,
        "pv_premium": pv_prem,
        "profit_margin": pv_net / pv_prem if pv_prem else math.nan,
        "irr_pm": irr_month,
        "irr_pa": (1 + irr_month) ** per_year - 1,
    }
    return out, summary
