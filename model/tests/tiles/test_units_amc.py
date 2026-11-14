"""units_amc: worked by hand.

Base case: premium 250 a month, allocation rate 97%, AMC 0.0625% a month capped at
25 units, initial unit price 1.25 growing at 5% a year (1.25, 1.2550926547296, 1.2602060575649
in months 1 to 3). Allocated premium each month = 250 * 0.97 = 242.5.
"""

import pytest

from unit_linked.liability.units import units_amc

TOL = dict(rel=0, abs=1e-9)


def test_units_amc_by_hand():
    """min(units after allocation * 0.000625, 25).

    Month 1: 194.0 * 0.000625            = 0.12125
    Month 2: 387.091577026107 * 0.000625 = 0.241932235641317
    Month 3: 579.278492869952 * 0.000625 = 0.362049058043720
    Cap: with AMC 0.2% a month on 12,570.8899 units, 25.1418 exceeds the cap, so 25.
    Just below the cap: 12,456.8056 * 0.002 = 24.913611243 (not capped).
    """
    assert units_amc(194.0, 0.000625, 25.0) == pytest.approx(0.12125, **TOL)
    assert units_amc(387.091577026107, 0.000625, 25.0) == pytest.approx(0.241932235641317, **TOL)
    assert units_amc(579.278492869952, 0.000625, 25.0) == pytest.approx(0.362049058043720, **TOL)
    assert units_amc(12570.889893416273, 0.002, 25.0) == 25.0
    assert units_amc(12456.805621505462, 0.002, 25.0) == pytest.approx(24.913611243010926, **TOL)
