"""Inputs layer: turn model points, parameters and assumption tables into monthly input series, once, before the loop.

This is the only place that reads a table or does a lookup. Every series is aligned to
the projection grid here, so nothing is looked up inside the time loop.

The mortality table in `assumptions/mortality.csv` is SYNTHETIC: an annual Gompertz-
Makeham curve, q = 1 - exp(-(0.0004 + 0.00003 * 1.1^age)), rounded to 6 decimals, for
ages 18 to 110. It is for demonstrating the tooling only and is not based on any
population's experience.
"""

import csv
from pathlib import Path

import numpy as np

MORTALITY_TABLE = Path(__file__).resolve().parents[2] / "assumptions" / "mortality.csv"


def monthly_rate_from_annual(rate_pa, months_per_year):
    """The monthly rate that compounds to `rate_pa` over a year: (1 + rate_pa)^(1/months_per_year) - 1.

    This is the model's one annual-to-monthly conversion. A probability of decrement
    converts through it too: q_pm = -monthly_rate_from_annual(-q_pa) = 1 - (1 - q_pa)^(1/12),
    which assumes a constant force of decrement over the year.
    """
    return (1 + rate_pa) ** (1 / months_per_year) - 1


def monthly_decrement_from_annual(q_pa, months_per_year):
    """Monthly probability of decrement with the same annual survival: 1 - (1 - q_pa)^(1/12).

    Written through `monthly_rate_from_annual` so the conversion lives in one place.
    """
    return -monthly_rate_from_annual(-q_pa, months_per_year)


def load_table(path):
    """{column name: 1-D float64 array} from a CSV with a header row."""
    with Path(path).open(newline="") as handle:
        rows = [row for row in csv.reader(handle) if row]
    header, values = rows[0], np.array(rows[1:], dtype=np.float64)
    return {name: values[:, i] for i, name in enumerate(header)}


def lookup(keys, table_keys, table_values):
    """Exact-match lookup of every key (like Excel's INDEX/MATCH with match type 0); raises if any key is missing."""
    position = np.searchsorted(table_keys, keys)
    position = np.clip(position, 0, len(table_keys) - 1)
    found = table_keys[position] == keys
    if not np.all(found):
        missing = np.unique(np.asarray(keys)[~found])
        raise ValueError(f"keys not in the table: {missing.tolist()}")
    return table_values[position]


def build_inputs(model_points, params, months):
    """Input series of shape (months, 1, n_pol).

    model_points: dict of 1-D arrays with fields `premium_pm` (monthly premium),
    `premium_months` (number of months for which premium is paid), `age_at_entry`
    (whole years) and `sum_assured` (paid on death, or the fund if higher).

    month: 1..months.
    premium: premium_pm in months 1..premium_months, then 0.
    unit_price: initial_unit_price * (1 + unit growth per month)^(month - 1).
    age_at_entry, sum_assured: the model-point values in every month.
    attained_age: age at entry plus completed policy years, (month - 1) // 12.
    mort_rate_pa: the mortality table's q at the attained age; mort_rate_pm its monthly equivalent.
    lapse_rate_pm: the monthly equivalent of lapse_rate_pa.
    acquisition_cost_paid: the acquisition cost in month 1, zero afterwards.
    discount_rate_pm: the monthly equivalent of discount_rate_pa.
    discount_factor: 1 / (1 + discount_rate_pm)^month, discounting to the end of each month.
    """
    premium_pm = np.asarray(model_points["premium_pm"], dtype=np.float64)
    premium_months = np.asarray(model_points["premium_months"], dtype=np.float64)
    age_at_entry = np.asarray(model_points["age_at_entry"], dtype=np.float64)
    sum_assured = np.asarray(model_points["sum_assured"], dtype=np.float64)
    n_pol = premium_pm.shape[0]
    shape = (months, 1, n_pol)
    per_year = params.months_per_year

    month = np.arange(1, months + 1, dtype=np.float64).reshape(months, 1, 1)
    premium = np.where(month <= premium_months, premium_pm, 0.0)

    growth_pm = monthly_rate_from_annual(params.unit_growth_pa, per_year)
    unit_price = params.initial_unit_price * (1 + growth_pm) ** (month - 1)

    attained_age = age_at_entry + np.floor((month - 1) / per_year)
    mortality = load_table(MORTALITY_TABLE)
    mort_rate_pa = lookup(attained_age, mortality["age"], mortality["qx"])
    mort_rate_pm = monthly_decrement_from_annual(mort_rate_pa, per_year)
    lapse_rate_pm = monthly_decrement_from_annual(params.lapse_rate_pa, per_year)

    acquisition_cost_paid = np.where(month == 1, params.acquisition_cost, 0.0)
    discount_rate_pm = monthly_rate_from_annual(params.discount_rate_pa, per_year)
    discount_factor = 1 / (1 + discount_rate_pm) ** month

    series = {
        "month": month,
        "premium": premium,
        "unit_price": unit_price,
        "age_at_entry": age_at_entry,
        "attained_age": attained_age,
        "mort_rate_pa": mort_rate_pa,
        "mort_rate_pm": mort_rate_pm,
        "lapse_rate_pm": lapse_rate_pm,
        "sum_assured": sum_assured,
        "acquisition_cost_paid": acquisition_cost_paid,
        "discount_rate_pm": discount_rate_pm,
        "discount_factor": discount_factor,
    }
    return {name: np.broadcast_to(np.asarray(values, dtype=np.float64), shape).copy() for name, values in series.items()}
