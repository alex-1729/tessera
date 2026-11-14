"""in_force_eop: worked by hand.

Base case, months 1 to 3: age 40 at entry, mortality q 0.001756 a year ->
0.000146451239576 a month; lapses 6% a year -> 0.005143012831823 a month.
"""

import pytest

from unit_linked.liability.decrements import in_force_eop


def test_in_force_eop_by_hand():
    """Opening in force - deaths - lapses.

    Month 1: 1.0               - 0.000146451239576 - 0.005142259631219 = 0.994711289129205
    Month 2: 0.994711289129205 - 0.000145676701314 - 0.005115063706806 = 0.989450548721085
    Month 3: 0.989450548721085 - 0.000144906259360 - 0.005088011613775 = 0.984217630847950
    """
    assert in_force_eop(1.0, 0.000146451239576, 0.005142259631219) == pytest.approx(0.994711289129205, abs=1e-15)
    assert in_force_eop(0.994711289129205, 0.000145676701314, 0.005115063706806) == pytest.approx(
        0.989450548721085, abs=1e-15)
    assert in_force_eop(0.989450548721085, 0.000144906259360, 0.005088011613775) == pytest.approx(
        0.984217630847950, abs=1e-15)
