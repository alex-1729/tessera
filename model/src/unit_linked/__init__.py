"""Unit-linked pricing model, written as tiles for review with tilekit.

Conventions
-----------
Period
    Monthly. Months are numbered 1..N; `tilekit.toml` sets N (120 by default).
    Within a month: premium is received and allocated to units at the start,
    charges are deducted after allocation, and decrements (once modelled)
    happen at the end of the month, deaths first, then lapses applied to the
    survivors.
Suffixes
    `_bop` / `_eop`: value at the beginning / end of the month.
    `_pa` / `_pm`: annual / monthly rate.
    `_total`: summed over policies; every other amount is per policy.
Sign
    Inflows to the insurer are positive.
Units
    Money amounts are in the policy currency; unit holdings are numbers of
    units; unit prices are currency per unit.
Precision
    float64 throughout.
Shapes
    Input series built by `inputs.build_inputs` have shape (months, n_scen, n_pol).
    Inside a monthly step every array has shape (n_scen, n_pol). One
    deterministic scenario is used, so n_scen = 1. Tiles use elementwise NumPy
    so they also work on plain scalars.
Literals
    Calculation code uses no literals except 0 and 1; parameters live in the
    frozen `params.Params` dataclass.
"""
