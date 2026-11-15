"""Unit projection: the module walked through by hand for the base case.

Base case: premium 250 a month, allocation rate 97%, AMC 0.0625% a month capped at 25 units, initial unit price
1.25 growing at 5% a year. Each month: units bought, units after allocation, the AMC in units, closing units, and
the closing units carried forward as next month's opening units.
"""

import pytest

from tilekit.trace import run_case
from unit_linked.liability.units import units_after_alloc, units_allocated, units_amc, units_eop

TOL = dict(rel=0, abs=1e-9)
PRICES = [1.25, 1.2550926547295604, 1.2602060575648766]  # 1.25 * 1.05 ** ((month - 1) / 12)


def test_unit_projection_first_three_months(model):
    """Months 1 to 3 of the base case, tile by tile, carrying the closing units forward.

    Case: base, month 3

    Month 1: 0 + 242.5 / 1.25 = 194.0; AMC 0.12125; closing 193.87875
    Month 2: 193.87875 + 193.215... = 387.091577026107; AMC 0.241932235641317; closing 386.849644790466
    Month 3: 386.849644790466 + 192.428... = 579.278492869952; AMC 0.362049058043720; closing 578.916443811908
    """
    expected_eop = [193.87875, 386.849644790466, 578.916443811908]
    units_bop = 0.0
    walked = []
    for price, want in zip(PRICES, expected_eop):
        bought = units_allocated(250.0, 0.97, price)
        after = units_after_alloc(units_bop, bought)
        charge = units_amc(after, 0.000625, 25.0)
        closing = units_eop(after, charge)
        assert closing == pytest.approx(want, **TOL)
        assert units_bop + bought - charge - closing == pytest.approx(0.0, **TOL)  # the roll-forward reconciles
        walked.append(closing)
        units_bop = closing
    # the engine's projection of the same case agrees with the walk
    _, _, results = run_case(model, "base")
    assert list(results["units_eop"][:3, 0, 0]) == pytest.approx(walked, **TOL)
