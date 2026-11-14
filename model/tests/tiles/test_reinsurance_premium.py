"""reinsurance_premium: worked by hand.

Base case, months 1 to 2: quota share 50% with a 10% loading.
"""

import pytest

from unit_linked.treaty.quota_share import reinsurance_premium

TOL = dict(rel=0, abs=1e-9)
Q_PM = 0.00014645123957646167  # base case, age 40: 1 - (1 - 0.001756)^(1/12)


def test_reinsurance_premium_by_hand():
    """-(sum at risk * opening in force * monthly mortality * quota share * (1 + loading)).

    Month 1: -49,757.6515625 * 1.0 * 0.000146451239576 * 0.5 * 1.1 = -4.007888362358
    Month 2: -49,514.467852338747 * 0.994711289129205 * 0.000146451239576 * 0.5 * 1.1 = -3.967207389217
    """
    assert reinsurance_premium(49757.6515625, 1.0, Q_PM, 0.5, 0.1) == pytest.approx(-4.007888362358, **TOL)
    assert reinsurance_premium(49514.467852338747, 0.994711289129205, Q_PM, 0.5, 0.1) == pytest.approx(
        -3.967207389217, **TOL)
