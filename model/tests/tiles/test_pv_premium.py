"""pv_premium: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import numpy as np
import pytest

from unit_linked.results.profit import pv_premium

TOL = dict(rel=0, abs=1e-9)
FACTORS = np.array([0.99, 0.98, 0.97])


def test_pv_premium_by_hand():
    """Sum over months of premium income * discount factor.

    250 * 0.99 + 250 * 0.98 + 0 * 0.97 = 247.5 + 245 = 492.5
    """
    assert pv_premium(np.array([250.0, 250.0, 0.0]), FACTORS) == pytest.approx(492.5, **TOL)
