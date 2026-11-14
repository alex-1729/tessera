"""acquisition_expense: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import acquisition_expense


def test_acquisition_expense_by_hand():
    """-(acquisition cost paid) * opening in force: 150 in month 1, nothing afterwards.

    Month 1: -150 * 1.0               = -150.0
    Month 2:   -0 * 0.994711289129205 = 0
    """
    assert acquisition_expense(150.0, 1.0) == -150.0
    assert acquisition_expense(0.0, 0.994711289129205) == 0.0
