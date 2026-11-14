"""deaths: worked by hand.

Base case, months 1 to 3: age 40 at entry, mortality q 0.001756 a year ->
0.000146451239576 a month; lapses 6% a year -> 0.005143012831823 a month.
"""

import pytest

from unit_linked.liability.decrements import deaths

Q_PM = 0.00014645123957646167  # base case, age 40: 1 - (1 - 0.001756)^(1/12)


def test_deaths_by_hand():
    """Opening in force * monthly mortality.

    Month 1: 1.0               * 0.000146451239576 = 0.000146451239576
    Month 2: 0.994711289129205 * 0.000146451239576 = 0.000145676701314
    Month 3: 0.989450548721085 * 0.000146451239576 = 0.000144906259360
    """
    assert deaths(1.0, Q_PM) == pytest.approx(0.000146451239576, abs=1e-15)
    assert deaths(0.994711289129205, Q_PM) == pytest.approx(0.000145676701314, abs=1e-15)
    assert deaths(0.989450548721085, Q_PM) == pytest.approx(0.000144906259360, abs=1e-15)
