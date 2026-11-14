"""premium_income: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import premium_income

TOL = dict(rel=0, abs=1e-9)


def test_premium_income_by_hand():
    """Premium * opening in force.

    Month 1: 250 * 1.0               = 250.0
    Month 2: 250 * 0.994711289129205 = 248.677822282301
    Month 3: 250 * 0.989450548721085 = 247.362637180271
    """
    assert premium_income(250.0, 1.0) == 250.0
    assert premium_income(250.0, 0.994711289129205) == pytest.approx(248.677822282301, **TOL)
    assert premium_income(250.0, 0.989450548721085) == pytest.approx(247.362637180271, **TOL)
