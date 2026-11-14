"""fund_value_eop: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import fund_value_eop

TOL = dict(rel=0, abs=1e-9)
PRICES = [1.25, 1.2550926547295604, 1.2602060575648766]  # unit price, months 1 to 3


def test_fund_value_eop_by_hand():
    """Closing units * unit price.

    Month 1: 193.87875        * 1.25            = 242.3484375
    Month 2: 386.849644790466 * 1.2550926547296 = 485.532147661253
    Month 3: 578.916443811908 * 1.2602060575649 = 729.554009315683
    """
    assert fund_value_eop(193.87875, PRICES[0]) == pytest.approx(242.3484375, **TOL)
    assert fund_value_eop(386.849644790466, PRICES[1]) == pytest.approx(485.532147661253, **TOL)
    assert fund_value_eop(578.916443811908, PRICES[2]) == pytest.approx(729.554009315683, **TOL)
