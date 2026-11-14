"""pv_net_profit: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import numpy as np
import pytest

from unit_linked.results.profit import pv_net_profit

TOL = dict(rel=0, abs=1e-9)
FLOWS = np.array([-100.0, 60.0, 60.0])
FACTORS = np.array([0.99, 0.98, 0.97])


def test_pv_net_profit_by_hand():
    """Sum over months of net profit * discount factor.

    -100 * 0.99 + 60 * 0.98 + 60 * 0.97 = -99 + 58.8 + 58.2 = 18.0
    """
    assert pv_net_profit(FLOWS, FACTORS) == pytest.approx(18.0, **TOL)


def test_pv_net_profit_is_per_policy():
    """Two policies side by side (axis 1) give one present value each: 18.0 and 2 * 18.0."""
    flows = np.stack([FLOWS, 2 * FLOWS], axis=1)
    np.testing.assert_allclose(pv_net_profit(flows, FACTORS[:, None]), [18.0, 36.0], rtol=0, atol=1e-12)
