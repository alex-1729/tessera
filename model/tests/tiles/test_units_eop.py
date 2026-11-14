"""units_eop: worked by hand.

Base case: premium 250 a month, allocation rate 97%, AMC 0.0625% a month capped at
25 units, initial unit price 1.25 growing at 5% a year (1.25, 1.2550926547296, 1.2602060575649
in months 1 to 3). Allocated premium each month = 250 * 0.97 = 242.5.
"""

import pytest

from unit_linked.liability.units import units_eop

TOL = dict(rel=0, abs=1e-9)


def test_units_eop_by_hand():
    """Units after allocation - AMC units.

    Month 1: 194.0            - 0.12125           = 193.87875
    Month 2: 387.091577026107 - 0.241932235641317 = 386.849644790466
    Month 3: 579.278492869952 - 0.362049058043720 = 578.916443811908
    """
    assert units_eop(194.0, 0.12125) == pytest.approx(193.87875, **TOL)
    assert units_eop(387.091577026107, 0.241932235641317) == pytest.approx(386.849644790466, **TOL)
    assert units_eop(579.278492869952, 0.362049058043720) == pytest.approx(578.916443811908, **TOL)
