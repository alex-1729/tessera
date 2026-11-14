"""Cashflows: the insurer's gross monthly cashflows per policy at entry, before reinsurance.

Amounts are per policy at entry: a per-policy amount times the proportion in force.
Inflows to the insurer are positive, outflows negative. The allocated premium buys
units held for the policyholder, so the insurer's profit comes from the unallocated
premium and the management charge, less expenses and the cost of deaths.
"""

import numpy as np


def fund_value_eop(units_eop, unit_price):
    """Fund value.

    Value of the units held at the end of the month for one policy in force: closing
    units at this month's unit price.

    Units: currency per policy in force
    Timing: end of month
    Format: amount
    Assumed: the closing units are valued at the same month's unit price
    """
    return units_eop * unit_price


def premium_income(premium, in_force_bop):
    """Premium income.

    Premium received this month from the policies in force at the start of the month.

    Units: currency per policy at entry
    Timing: start of the month, when the premium is paid
    Format: amount
    """
    return premium * in_force_bop


def allocation_margin(premium, allocation_rate, in_force_bop):
    """Allocation margin.

    The part of the premium not allocated to units, kept by the insurer, for the
    policies in force at the start of the month.

    Units: currency per policy at entry
    Timing: start of the month, when the premium is paid
    Format: amount
    """
    return premium * (1 - allocation_rate) * in_force_bop


def amc_income(units_amc, unit_price, in_force_bop):
    """AMC income.

    The management charge taken in units, turned into money at this month's unit
    price, for the policies in force at the start of the month.

    Units: currency per policy at entry
    Timing: during month, after allocation
    Format: amount
    Assumed: the charge is earned on every policy in force at the start of the month,
        including those that die or lapse at its end
    """
    return units_amc * unit_price * in_force_bop


def maintenance_expense(expense_pm, in_force_bop):
    """Maintenance expense.

    The monthly per-policy expense for the policies in force at the start of the
    month. An outflow, so negative.

    Units: currency per policy at entry
    Timing: during month
    Format: amount
    Assumed: the expense is flat, with no inflation
    """
    return -expense_pm * in_force_bop


def acquisition_expense(acquisition_cost_paid, in_force_bop):
    """Acquisition expense.

    The one-off cost of selling the policy, paid in the first month. An outflow, so
    negative.

    Units: currency per policy at entry
    Timing: first month
    Format: amount
    """
    return -acquisition_cost_paid * in_force_bop


def sum_at_risk(sum_assured, fund_value_eop):
    """Sum at risk.

    The amount the insurer pays on a death beyond the fund it already holds: the sum
    assured less the fund value, and nothing once the fund exceeds the sum assured.

    Units: currency per policy in force
    Timing: at month end
    Format: amount
    Assumed: the death benefit is the higher of the sum assured and the fund value
    """
    return np.maximum(sum_assured - fund_value_eop, 0)


def death_strain(deaths, sum_at_risk):
    """Death strain.

    The cost of this month's deaths beyond the fund released: deaths times the sum
    at risk. An outflow, so negative.

    Units: currency per policy at entry
    Timing: on death, at month end
    Format: amount
    Assumed: death benefits are paid at the end of the month of death
    """
    return -deaths * sum_at_risk


def gross_profit(allocation_margin, amc_income, maintenance_expense, acquisition_expense, death_strain):
    """Gross profit.

    The insurer's profit this month before reinsurance: allocation margin and AMC
    income, less expenses and the death strain.

    Units: currency per policy at entry
    Timing: over the month
    Format: amount
    Assumed: no interest is earned on cashflows within the month
    Assumed: no reserves beyond the unit fund are held, so profit is the cashflow
    """
    return allocation_margin + amc_income + maintenance_expense + acquisition_expense + death_strain
