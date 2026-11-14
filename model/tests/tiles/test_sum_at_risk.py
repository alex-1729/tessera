"""sum_at_risk: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import sum_at_risk

TOL = dict(rel=0, abs=1e-9)


def test_sum_at_risk_by_hand():
    """max(sum assured - fund value, 0); both branches.

    Month 1: max(50,000 - 242.3484375,        0) = 49,757.6515625
    Month 2: max(50,000 - 485.532147661253,   0) = 49,514.467852338747
    Fund overtakes: max(12,000 - 12,345.67, 0) = 0
    """
    assert sum_at_risk(50000.0, 242.3484375) == pytest.approx(49757.6515625, **TOL)
    assert sum_at_risk(50000.0, 485.532147661253) == pytest.approx(49514.467852338747, **TOL)
    assert sum_at_risk(12000.0, 12345.67) == 0.0
