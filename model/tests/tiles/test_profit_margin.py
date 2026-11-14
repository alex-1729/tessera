"""profit_margin: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import pytest

from unit_linked.results.profit import profit_margin

TOL = dict(rel=0, abs=1e-9)


def test_profit_margin_by_hand():
    """PV of net profit / PV of premium: 18 / 492.5 = 0.036548223350."""
    assert profit_margin(18.0, 492.5) == pytest.approx(0.036548223350, **TOL)
