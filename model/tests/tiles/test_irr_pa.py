"""irr_pa: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import pytest

from unit_linked.results.profit import irr_pa


def test_irr_pa_by_hand():
    """(1 + monthly IRR)^12 - 1 = 1.130662386292^12 - 1 = 3.365111454078."""
    assert irr_pa(0.1306623862918075, 12) == pytest.approx(3.365111454078, abs=1e-11)
