"""Quota share reinsurance of the death strain, modelled from the cedant's side.

Inflows to the cedant are positive. A fixed share of every death strain is ceded; the
reinsurer pays that share of the claims and is paid a risk premium of the expected
ceded strain plus a loading. On the death strain line, gross = ceded + retained.
"""


def ceded_death_strain(death_strain, quota_share):
    """Ceded death strain.

    The share of the gross death strain borne by the reinsurer. Negative like the
    gross strain; the cedant recovers it from the reinsurer.

    Units: currency per policy at entry
    Timing: on death, at month end
    Format: amount
    Assumed: the reinsurer pays its share of claims in the month of death
    """
    return death_strain * quota_share


def retained_death_strain(death_strain, ceded_death_strain):
    """Retained death strain.

    The part of the gross death strain the cedant keeps: gross less ceded.

    Units: currency per policy at entry
    Timing: on death, at month end
    Format: amount
    """
    return death_strain - ceded_death_strain


def reinsurance_premium(sum_at_risk, in_force_bop, mort_rate_pm, quota_share, reinsurance_loading):
    """Reinsurance premium.

    The risk premium the cedant pays the reinsurer: the expected ceded death strain
    (sum at risk times expected deaths times the quota share) plus the loading. An
    outflow, so negative.

    Units: currency per policy at entry
    Timing: in arrear, at month end
    Format: amount
    Assumed: the premium is set on the same month's sum at risk and mortality rate
    Assumed: the premium is paid monthly in arrear, with the claims
    """
    return -sum_at_risk * in_force_bop * mort_rate_pm * quota_share * (1 + reinsurance_loading)


def net_profit(gross_profit, ceded_death_strain, reinsurance_premium):
    """Net profit.

    The cedant's profit after reinsurance: gross profit, plus the ceded death strain
    recovered from the reinsurer, plus the (negative) reinsurance premium.

    Units: currency per policy at entry
    Timing: over the month
    Format: amount
    """
    return gross_profit - ceded_death_strain + reinsurance_premium
