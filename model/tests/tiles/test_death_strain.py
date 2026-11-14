"""death_strain: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import death_strain

TOL = dict(rel=0, abs=1e-9)


def test_death_strain_by_hand():
    """-(deaths) * sum at risk.

    Month 1: -0.000146451239576 * 49,757.6515625      = -7.287069749742
    Month 2: -0.000145676701314 * 49,514.467852338747 = -7.213104344031
    No sum at risk: -0.0001 * 0 = 0
    """
    assert death_strain(0.000146451239576, 49757.6515625) == pytest.approx(-7.287069749742, **TOL)
    assert death_strain(0.000145676701314, 49514.467852338747) == pytest.approx(-7.213104344031, **TOL)
    assert death_strain(0.0001, 0.0) == 0.0
