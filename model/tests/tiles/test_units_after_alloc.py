"""units_after_alloc: worked by hand.

Base case: premium 250 a month, allocation rate 97%, AMC 0.0625% a month capped at
25 units, initial unit price 1.25 growing at 5% a year (1.25, 1.2550926547296, 1.2602060575649
in months 1 to 3). Allocated premium each month = 250 * 0.97 = 242.5.
"""

import pytest

from unit_linked.liability.units import units_after_alloc

TOL = dict(rel=0, abs=1e-9)


def test_units_after_alloc_by_hand():
    """Opening units + units allocated.

    Month 1: 0          + 194.0            = 194.0
    Month 2: 193.87875  + 193.212827026107 = 387.091577026107
    Month 3: 386.849644790466 + 192.428848079486 = 579.278492869952
    """
    assert units_after_alloc(0.0, 194.0) == pytest.approx(194.0, **TOL)
    assert units_after_alloc(193.87875, 193.212827026107) == pytest.approx(387.091577026107, **TOL)
    assert units_after_alloc(386.849644790466, 192.428848079486) == pytest.approx(579.278492869952, **TOL)
