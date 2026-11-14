"""Profit: present values, the profit margin and the internal rate of return, over the whole projection.

Summary tiles: each argument that is a monthly series arrives whole (axis 0 is the
month) and the result is one number per policy.
"""

import numpy as np

from tilekit import functions as tk


def pv_gross_profit(gross_profit, discount_factor):
    """PV of gross profit.

    Gross profit in every month discounted to the start of the policy at the
    discount rate, and added up.

    Units: currency per policy at entry
    Timing: at the start of the policy
    Format: amount
    Assumed: each month's cashflows are discounted from the end of that month
    """
    return np.sum(gross_profit * discount_factor, axis=0)


def pv_net_profit(net_profit, discount_factor):
    """PV of net profit.

    Net profit after reinsurance in every month, discounted to the start of the
    policy and added up.

    Units: currency per policy at entry
    Timing: at the start of the policy
    Format: amount
    Assumed: each month's cashflows are discounted from the end of that month
    """
    return np.sum(net_profit * discount_factor, axis=0)


def pv_premium(premium_income, discount_factor):
    """PV of premium.

    Premium income in every month, discounted to the start of the policy and added up.

    Units: currency per policy at entry
    Timing: at the start of the policy
    Format: amount
    Assumed: premium is discounted from the end of the month like the profit, so the
        margin compares like with like
    """
    return np.sum(premium_income * discount_factor, axis=0)


def profit_margin(pv_net_profit, pv_premium):
    """Profit margin.

    Present value of net profit as a proportion of the present value of premium.
    Undefined (#DIV/0!) when no premium is paid.

    Units: proportion of premium
    Timing: at the start of the policy
    Format: percent
    """
    return pv_net_profit / pv_premium


def irr_pm(net_profit):
    """IRR per month.

    The monthly rate at which the present value of the net profit stream is zero,
    with the first month's profit at time 0 (Excel's IRR convention). Undefined
    (#NUM!) when the profit stream never changes sign.

    Units: rate per month
    Timing: per month
    Format: rate
    Assumed: the first month's net profit is treated as occurring at time 0
    """
    return tk.irr(net_profit)


def irr_pa(irr_pm, months_per_year):
    """IRR per year.

    The monthly IRR compounded up to a year.

    Units: rate per year
    Timing: per year
    Format: irr
    """
    return (1 + irr_pm) ** months_per_year - 1
