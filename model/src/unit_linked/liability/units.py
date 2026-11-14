"""Unit projection: units bought with premium, the management charge, and units carried forward."""

import numpy as np


def units_allocated(premium, allocation_rate, unit_price):
    """Units allocated.

    Units bought this month with the allocated part of the premium, at this
    month's unit price.

    Units: units per policy
    Timing: during month, when the premium is received
    Format: units
    Assumed: premium is allocated at the unit price of the month it is paid
    """
    return premium * allocation_rate / unit_price


def units_after_alloc(units_bop, units_allocated):
    """Units after allocation.

    Opening units plus the units allocated this month, before any charge is
    taken.

    Units: units per policy
    Timing: during month, after allocation and before charges
    Format: units
    """
    return units_bop + units_allocated


def units_amc(units_after_alloc, amc_pm, amc_cap_units):
    """AMC units.

    Monthly management charge deducted in units, after allocation,
    capped at a fixed number of units.

    Units: units per policy
    Timing: during month, after allocation
    Format: units
    Assumed: the charge is on units after the same month's allocation
    Assumed: the cap is a number of units, not an amount of money
    """
    return np.minimum(units_after_alloc * amc_pm, amc_cap_units)


def units_eop(units_after_alloc, units_amc):
    """Closing units.

    Units held at the end of the month: units after allocation less the
    management charge. Next month's opening units.

    Units: units per policy
    Timing: end of month
    Format: units
    """
    return units_after_alloc - units_amc
