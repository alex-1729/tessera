"""Financial functions tiles may call, each with an exact Excel counterpart.

Import in a tile file as `from tilekit import functions as tk` and call `tk.irr(...)`,
`tk.npv(...)`. Cash flows are on axis 0 (time); any further axes (scenarios, policies)
are independent and the result has the shape of the remaining axes.

- `irr(cashflows)` is Excel's `IRR(range)`: the per-period rate r with
  sum_t cashflows[t] / (1 + r)^t = 0, t = 0..n-1 (the first cash flow is at time 0).
- `npv(rate, cashflows)` is Excel's `NPV(rate, range)`: sum_t cashflows[t] / (1 + rate)^(t + 1),
  t = 0..n-1 (the first cash flow is discounted one period).
- `round_half_away(x, digits)` is Excel's `ROUND(x, digits)`: see its docstring for the rule.
"""

import math
from decimal import ROUND_HALF_UP, Decimal

import numpy as np

__all__ = ["irr", "npv", "round_half_away"]

EXCEL_SIGNIFICANT_DIGITS = 15

_GRID_POINTS = 4001  # log(1 + r) grid used to bracket roots
_LOG_GROWTH_LOW = np.log(1e-3)  # r = -99.9%
_LOG_GROWTH_HIGH = np.log(1e3)  # r = +99,900%
_EXCEL_GUESS = np.log1p(0.1)  # Excel's default guess; the bracket nearest to it wins
_BISECTIONS = 80


def _scaled_npv(cashflows, x):
    """A positive multiple of the NPV at log(1 + r) = x, for every column; never overflows.

    cashflows: (n, m); x: (m,) or (g, 1). For x >= 0 the weights are exp(-t x) <= 1; for x < 0
    the NPV is multiplied by exp((n - 1) x) > 0, giving weights exp((n - 1 - t) x) <= 1.
    """
    n = cashflows.shape[0]
    t = np.arange(n, dtype=np.float64)
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:  # one rate per column: (n, m) weights
        exponent = np.where(x[None, :] >= 0, -np.outer(t, x), np.outer(n - 1 - t, x))
        return np.sum(cashflows * np.exp(exponent), axis=0)
    xs = x[:, 0]  # a grid of rates for all columns: (g, n) @ (n, m)
    exponent = np.where(xs[:, None] >= 0, -np.outer(xs, t), np.outer(xs, n - 1 - t))
    return np.exp(exponent) @ cashflows


def irr(cashflows):
    """Per-period internal rate of return of `cashflows` (axis 0 is time), like Excel's IRR.

    Vectorised over every other axis. Roots are bracketed on a fine grid of log(1 + r)
    between r = -99.9% and r = 99,900%, the bracket nearest Excel's default guess of 10%
    is taken, and the root is found by bisection to machine precision. NaN where the cash
    flows do not change sign or no root is found.
    """
    cf = np.asarray(cashflows, dtype=np.float64)
    if cf.ndim == 0 or cf.shape[0] < 2:
        raise ValueError("irr needs at least two cash flows on axis 0")
    rest = cf.shape[1:]
    flat = cf.reshape(cf.shape[0], -1)
    m = flat.shape[1]
    result = np.full(m, np.nan)

    finite = np.all(np.isfinite(flat), axis=0)
    sign_change = finite & np.any(flat > 0, axis=0) & np.any(flat < 0, axis=0)
    columns = np.flatnonzero(sign_change)
    if columns.size:
        cfs = flat[:, columns]
        grid = np.linspace(_LOG_GROWTH_LOW, _LOG_GROWTH_HIGH, _GRID_POINTS)
        values = _scaled_npv(cfs, grid[:, None])  # (g, k)
        signs = np.sign(values)
        exact = signs == 0
        crosses = (signs[:-1] * signs[1:] < 0) | exact[:-1]
        has_root = np.any(crosses, axis=0)
        distance = np.where(crosses, np.abs((grid[:-1] + grid[1:]) / 2 - _EXCEL_GUESS)[:, None], np.inf)
        pick = np.argmin(distance, axis=0)  # (k,)
        k = np.arange(columns.size)
        low, high = grid[pick], grid[pick + 1]
        f_low = values[pick, k]
        root_at_low = f_low == 0
        for _ in range(_BISECTIONS):
            mid = (low + high) / 2
            f_mid = _scaled_npv(cfs, mid)
            same = np.sign(f_mid) == np.sign(f_low)
            low = np.where(same, mid, low)
            f_low = np.where(same, f_mid, f_low)
            high = np.where(same, high, mid)
        x = np.where(root_at_low, grid[pick], (low + high) / 2)
        result[columns] = np.where(has_root, np.expm1(x), np.nan)
    return result.reshape(rest) if rest else result[0]


def npv(rate, cashflows):
    """Excel's NPV(rate, range): the first cash flow is discounted one full period.

    `rate` is a scalar or broadcasts against the non-time axes of `cashflows`.
    """
    cf = np.asarray(cashflows, dtype=np.float64)
    periods = np.arange(1, cf.shape[0] + 1, dtype=np.float64).reshape((-1,) + (1,) * (cf.ndim - 1))
    return np.sum(cf / (1 + np.asarray(rate, dtype=np.float64)) ** periods, axis=0)


def _round_one(x, digits):
    x = float(x)
    if not math.isfinite(x):
        return x
    digits = math.trunc(float(digits))
    # Excel works on the value as it would show it to 15 significant digits: 2.675 (stored as
    # 2.67499999999999982236431605997495353221893310546875) is taken as 2.675.
    shown = Decimal(f"{x:.{EXCEL_SIGNIFICANT_DIGITS}g}")
    quantum = Decimal(1).scaleb(-digits)
    rounded = float(shown.quantize(quantum, rounding=ROUND_HALF_UP)) if shown != 0 else 0.0
    return rounded + 0.0  # no negative zero


_round_vectorised = np.frompyfunc(_round_one, 2, 1)


def round_half_away(x, digits):
    """Excel's ROUND(x, digits), elementwise.

    Rule: the value is first taken to 15 significant digits (the precision Excel shows and
    rounds), then rounded to `digits` decimal places with halves going away from zero
    (ROUND(2.5, 0) = 3, ROUND(-2.5, 0) = -3, ROUND(2.675, 2) = 2.68, ROUND(1250, -2) = 1300).
    `digits` may be negative and is truncated to a whole number, as in Excel. NaN and
    infinities pass through. Broadcasts like any NumPy function; a scalar in gives a float out.
    """
    out = _round_vectorised(np.asarray(x, dtype=np.float64), np.asarray(digits, dtype=np.float64))
    if isinstance(out, np.ndarray):
        return out.astype(np.float64)
    return float(out)
