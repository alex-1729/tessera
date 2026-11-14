"""net_profit: worked by hand.

Base case, months 1 to 2: quota share 50% with a 10% loading.
"""

import pytest

from unit_linked.treaty.quota_share import net_profit

TOL = dict(rel=0, abs=1e-9)


def test_net_profit_by_hand():
    """Gross profit - ceded death strain + reinsurance premium.

    Month 1: -151.635507249742 + 3.643534874871 - 4.007888362358 = -151.999860737229
    Month 2:   -1.440150785081 + 3.606552172015 - 3.967207389217 =   -1.800806002283
    """
    assert net_profit(-151.635507249742, -3.643534874871, -4.007888362358) == pytest.approx(-151.999860737229, **TOL)
    assert net_profit(-1.440150785081, -3.606552172015, -3.967207389217) == pytest.approx(-1.800806002283, **TOL)
