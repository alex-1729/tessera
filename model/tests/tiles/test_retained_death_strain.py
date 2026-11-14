"""retained_death_strain: worked by hand.

Base case, months 1 to 2: quota share 50% with a 10% loading.
"""

import pytest

from unit_linked.treaty.quota_share import retained_death_strain

TOL = dict(rel=0, abs=1e-9)


def test_retained_death_strain_by_hand():
    """Death strain - ceded death strain.

    Month 1: -7.287069749742 - (-3.643534874871) = -3.643534874871
    Month 2: with 30% ceded, -10 - (-3) = -7
    """
    assert retained_death_strain(-7.287069749742, -3.643534874871) == pytest.approx(-3.643534874871, **TOL)
    assert retained_death_strain(-10.0, -3.0) == -7.0
