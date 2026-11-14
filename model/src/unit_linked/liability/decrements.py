"""Decrements: deaths and lapses out of the policies in force, and the policies carried forward.

The decrement order is written here once: at the end of the month, deaths first, then
lapses applied to the survivors. In force is a proportion of one policy at entry.
"""


def deaths(in_force_bop, mort_rate_pm):
    """Deaths.

    Policies in force at the start of the month that die during it: the opening
    in force times the monthly mortality rate. Deaths are taken first, before lapses.

    Units: proportion of the policy at entry
    Timing: decrement at month end, taken first
    Format: small
    Assumed: deaths are counted at the end of the month, before lapses
    """
    return in_force_bop * mort_rate_pm


def lapses(in_force_bop, deaths, lapse_rate_pm):
    """Lapses.

    Policies that lapse this month: the survivors of the month's deaths times the
    monthly lapse rate.

    Units: proportion of the policy at entry
    Timing: decrement at month end, after deaths
    Format: small
    Assumed: the lapse rate applies to the policies that survived the month's deaths
    """
    return (in_force_bop - deaths) * lapse_rate_pm


def in_force_eop(in_force_bop, deaths, lapses):
    """Closing in force.

    Policies in force at the end of the month: opening in force less deaths and
    lapses. Next month's opening in force.

    Units: proportion of the policy at entry
    Timing: end of month, after decrements
    Format: number
    """
    return in_force_bop - deaths - lapses
