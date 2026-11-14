"""irr_pm: worked by hand.

Whole series over three months (a summary tile sees every month at once).
"""

import math

import numpy as np
import pytest

from unit_linked.results.profit import irr_pm

FLOWS = np.array([-100.0, 60.0, 60.0])


def test_irr_pm_by_hand():
    """-100 + 60 v + 60 v^2 = 0 with v = 1/(1 + r), the first flow at time 0 (Excel's IRR).

    v = (-60 + sqrt(60^2 + 4 * 60 * 100)) / (2 * 60) = (-60 + sqrt(27,600)) / 120 = 0.884437310486
    r = 1/v - 1 = 0.130662386292
    No sign change (all outflows): no IRR, NaN.
    """
    assert irr_pm(FLOWS) == pytest.approx(0.130662386292, abs=1e-12)
    assert math.isnan(irr_pm(np.array([-1.0, -2.0, -3.0])))
