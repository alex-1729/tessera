"""units_allocated: worked by hand.

Base case: premium 250 a month, allocation rate 97%, AMC 0.0625% a month capped at
25 units, initial unit price 1.25 growing at 5% a year (1.25, 1.2550926547296, 1.2602060575649
in months 1 to 3). Allocated premium each month = 250 * 0.97 = 242.5.
"""

import pytest

from unit_linked.liability.units import units_allocated

TOL = dict(rel=0, abs=1e-9)


def test_units_allocated_by_hand():
    """Allocated premium / unit price.

    Month 1: 242.5 / 1.25           = 194.0
    Month 2: 242.5 / 1.2550926547296 = 193.212827026107
    Month 3: 242.5 / 1.2602060575649 = 192.428848079486
    """
    assert units_allocated(250.0, 0.97, 1.25) == pytest.approx(194.0, **TOL)
    assert units_allocated(250.0, 0.97, 1.2550926547295604) == pytest.approx(193.212827026107, **TOL)
    assert units_allocated(250.0, 0.97, 1.2602060575648766) == pytest.approx(192.428848079486, **TOL)
    assert units_allocated(0.0, 0.97, 1.25) == 0.0
