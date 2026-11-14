"""lapses: worked by hand.

Base case, months 1 to 3: age 40 at entry, mortality q 0.001756 a year ->
0.000146451239576 a month; lapses 6% a year -> 0.005143012831823 a month.
"""

import pytest

from unit_linked.liability.decrements import lapses

LAPSE_PM = 0.005143012831822946  # 1 - (1 - 0.06)^(1/12)


def test_lapses_by_hand():
    """(Opening in force - deaths) * monthly lapse rate.

    Month 1: (1.0               - 0.000146451239576) * 0.005143012831823 = 0.005142259631219
    Month 2: (0.994711289129205 - 0.000145676701314) * 0.005143012831823 = 0.005115063706806
    Month 3: (0.989450548721085 - 0.000144906259360) * 0.005143012831823 = 0.005088011613775
    """
    assert lapses(1.0, 0.000146451239576, LAPSE_PM) == pytest.approx(0.005142259631219, abs=1e-15)
    assert lapses(0.994711289129205, 0.000145676701314, LAPSE_PM) == pytest.approx(0.005115063706806, abs=1e-15)
    assert lapses(0.989450548721085, 0.000144906259360, LAPSE_PM) == pytest.approx(0.005088011613775, abs=1e-15)
