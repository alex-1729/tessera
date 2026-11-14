"""ceded_death_strain: worked by hand.

Base case, months 1 to 2: quota share 50% with a 10% loading.
"""

import pytest

from unit_linked.treaty.quota_share import ceded_death_strain

TOL = dict(rel=0, abs=1e-9)


def test_ceded_death_strain_by_hand():
    """Death strain * quota share.

    Month 1: -7.287069749742 * 0.5 = -3.643534874871
    Month 2: -7.213104344031 * 0.5 = -3.606552172015
    """
    assert ceded_death_strain(-7.287069749742, 0.5) == pytest.approx(-3.643534874871, **TOL)
    assert ceded_death_strain(-7.213104344031, 0.5) == pytest.approx(-3.606552172015, **TOL)
