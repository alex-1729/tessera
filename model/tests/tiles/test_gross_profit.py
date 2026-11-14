"""gross_profit: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import gross_profit

TOL = dict(rel=0, abs=1e-9)


def test_gross_profit_by_hand():
    """Allocation margin + AMC income + maintenance + acquisition + death strain.

    Month 1: 7.5            + 0.1515625      - 2.0            - 150 - 7.287069749742 = -151.635507249742
    Month 2: 7.460334668469 + 0.302041468739 - 1.989422578258 - 0   - 7.213104344031 = -1.440150785081
    """
    assert gross_profit(7.5, 0.1515625, -2.0, -150.0, -7.287069749742) == pytest.approx(-151.635507249742, **TOL)
    assert gross_profit(7.460334668469, 0.302041468739, -1.989422578258, 0.0, -7.213104344031) == pytest.approx(
        -1.440150785081, **TOL)
