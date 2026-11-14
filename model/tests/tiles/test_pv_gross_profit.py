"""pv_gross_profit: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import numpy as np
import pytest

from unit_linked.results.profit import pv_gross_profit

TOL = dict(rel=0, abs=1e-9)
FLOWS = np.array([-100.0, 60.0, 60.0])
FACTORS = np.array([0.99, 0.98, 0.97])


def test_pv_gross_profit_by_hand():
    """Sum over months of gross profit * discount factor.

    -100 * 0.99 + 60 * 0.98 + 60 * 0.97 = -99 + 58.8 + 58.2 = 18.0
    """
    assert pv_gross_profit(FLOWS, FACTORS) == pytest.approx(18.0, **TOL)
