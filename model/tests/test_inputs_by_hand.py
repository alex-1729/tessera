"""Hand-worked checks that are not about one tile: the rate conversions and table lookup of the inputs
layer, the engine's base-case inputs and units, and Excel's NPV convention.

Base case: premium 250 a month, age 40 at entry, sum assured 50,000, unit price 1.25 growing at
5% a year, lapses 6% a year, discount rate 7% a year, acquisition cost 150.
"""

import numpy as np
import pytest

from tilekit import functions as tk
from unit_linked.inputs import lookup, monthly_decrement_from_annual, monthly_rate_from_annual

Q_PM = 0.00014645123957646167
FLOWS = np.array([-100.0, 60.0, 60.0])


def test_monthly_growth_rate():
    """(1.05)^(1/12) - 1 = 0.0040741237836; twelve months of it compound back to 5%."""
    g = monthly_rate_from_annual(0.05, 12)
    assert g == pytest.approx(0.0040741237836, abs=1e-12)
    assert (1 + g) ** 12 == pytest.approx(1.05, abs=1e-14)


def test_inputs_by_hand():
    """Conversions and the table lookup.

    Monthly mortality: 1 - (1 - 0.001756)^(1/12) = 1 - 0.998244^(0.083333) = 0.000146451239576.
    Monthly lapses:    1 - (1 - 0.06)^(1/12)     = 1 - 0.94^(0.083333)     = 0.005143012831823.
    Monthly discount:  1.07^(1/12) - 1 = 0.005654145387405; month 1 factor 1/1.005654145387405
                       = 0.994377644229541; month 2 = 0.994377644229541^2 = 0.988786899343491.
    Lookup: ages 40 and 41 in a table [18, 19, ..., 110] -> the 23rd and 24th q values.
    """
    assert monthly_decrement_from_annual(0.001756, 12) == pytest.approx(0.000146451239576, abs=1e-15)
    assert monthly_decrement_from_annual(0.06, 12) == pytest.approx(0.005143012831823, abs=1e-15)
    discount_pm = monthly_rate_from_annual(0.07, 12)
    assert discount_pm == pytest.approx(0.005654145387405, abs=1e-15)
    assert 1 / (1 + discount_pm) == pytest.approx(0.994377644229541, abs=1e-15)
    assert 1 / (1 + discount_pm) ** 2 == pytest.approx(0.988786899343491, abs=1e-15)
    ages = np.arange(18.0, 111.0)
    qx = ages / 1000
    np.testing.assert_array_equal(lookup(np.array([40.0, 41.0]), ages, qx), [0.040, 0.041])
    with pytest.raises(ValueError):
        lookup(np.array([111.0]), ages, qx)


def test_engine_inputs_for_the_base_case(model):
    """Attained age steps up after every twelve months; acquisition cost is paid in month 1 only."""
    from tilekit.trace import run_case

    _, _, r = run_case(model, "base")
    age = r["attained_age"][:, 0, 0]
    assert age[0] == 40 and age[11] == 40 and age[12] == 41 and age[119] == 49
    assert r["mort_rate_pa"][0, 0, 0] == 0.001756
    assert r["mort_rate_pm"][0, 0, 0] == pytest.approx(Q_PM, abs=1e-18)
    assert list(r["acquisition_cost_paid"][:3, 0, 0]) == [150.0, 0.0, 0.0]


def test_engine_reproduces_hand_figures(model):
    """The same three months through the engine for the base case."""
    from tilekit.trace import run_case

    _, _, results = run_case(model, "base")
    assert list(results["unit_price"][:3, 0, 0]) == pytest.approx([1.25, 1.2550926547296, 1.2602060575649], abs=1e-12)
    assert list(results["units_eop"][:3, 0, 0]) == pytest.approx(
        [193.87875, 386.849644790466, 578.916443811908], abs=1e-9)


def test_npv_follows_excel():
    """Excel's NPV discounts the first flow one period: -100/1.1 + 60/1.21 + 60/1.331 = 4.1322314."""
    assert tk.npv(0.1, FLOWS) == pytest.approx(-100 / 1.1 + 60 / 1.21 + 60 / 1.331, abs=1e-12)
