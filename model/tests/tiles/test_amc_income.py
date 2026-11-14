"""amc_income: worked by hand.

Base case, months 1 to 3: premium 250 a month, allocation 97%, expenses 2 a month,
acquisition cost 150, sum assured 50,000; in force 1.0, 0.994711289129205, 0.989450548721085.
"""

import pytest

from unit_linked.liability.cashflows import amc_income

TOL = dict(rel=0, abs=1e-9)
PRICES = [1.25, 1.2550926547295604, 1.2602060575648766]  # unit price, months 1 to 3


def test_amc_income_by_hand():
    """AMC units * unit price * opening in force.

    Month 1: 0.12125           * 1.25            * 1.0               = 0.1515625
    Month 2: 0.241932235641317 * 1.2550926547296 * 0.994711289129205 = 0.302041468739
    Month 3: 0.362049058043720 * 1.2602060575649 * 0.989450548721085 = 0.451443161250
    """
    assert amc_income(0.12125, PRICES[0], 1.0) == pytest.approx(0.1515625, **TOL)
    assert amc_income(0.241932235641317, PRICES[1], 0.994711289129205) == pytest.approx(0.302041468739, **TOL)
    assert amc_income(0.362049058043720, PRICES[2], 0.989450548721085) == pytest.approx(0.451443161250, **TOL)
