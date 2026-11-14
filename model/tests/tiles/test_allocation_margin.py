"""allocation_margin: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import allocation_margin

TOL = dict(rel=0, abs=1e-9)


def test_allocation_margin_by_hand():
    """Premium * (1 - allocation rate) * opening in force.

    Month 1: 250 * 0.03 * 1.0               = 7.5
    Month 2: 250 * 0.03 * 0.994711289129205 = 7.460334668469
    Month 3: 250 * 0.03 * 0.989450548721085 = 7.420879115408
    """
    assert allocation_margin(250.0, 0.97, 1.0) == pytest.approx(7.5, **TOL)
    assert allocation_margin(250.0, 0.97, 0.994711289129205) == pytest.approx(7.460334668469, **TOL)
    assert allocation_margin(250.0, 0.97, 0.989450548721085) == pytest.approx(7.420879115408, **TOL)
