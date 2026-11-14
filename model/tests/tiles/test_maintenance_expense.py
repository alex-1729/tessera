"""maintenance_expense: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import maintenance_expense

TOL = dict(rel=0, abs=1e-9)


def test_maintenance_expense_by_hand():
    """-(expense per month) * opening in force.

    Month 1: -2 * 1.0               = -2.0
    Month 2: -2 * 0.994711289129205 = -1.989422578258
    Month 3: -2 * 0.989450548721085 = -1.978901097442
    """
    assert maintenance_expense(2.0, 1.0) == -2.0
    assert maintenance_expense(2.0, 0.994711289129205) == pytest.approx(-1.989422578258, **TOL)
    assert maintenance_expense(2.0, 0.989450548721085) == pytest.approx(-1.978901097442, **TOL)
