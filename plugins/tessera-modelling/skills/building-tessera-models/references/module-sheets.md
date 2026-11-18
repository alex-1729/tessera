# Module sheets

A module sheet should read like a well-built Excel model: blocks from top to bottom, each doing one job, with checks that prove the blocks hang together. These apply to every model; a model's own `standards.md` wins where the two disagree. Nothing here is checked from the command line: check each rule yourself.

## One step per tile

Looking a value up or choosing between values (which rate applies this month) is one tile; converting or applying it is the next. A formula that both chooses and converts is two tiles. Never write a tile that chooses with `np.where` and converts a rate in the same formula (a power over a period such as `** (1 / months_per_year)`, or `np.exp` with `np.log`).

Like this (two tiles):

```python
def lapse_rate_pa(policy_year, lapse_rate_year1_pa, lapse_rate_later_pa):
    return np.where(policy_year == 1, lapse_rate_year1_pa, lapse_rate_later_pa)

def lapse_rate_pm(lapse_rate_pa, months_per_year):
    return 1 - (1 - lapse_rate_pa) ** (1 / months_per_year)
```

Not like this (one tile that chooses and converts):

```python
    return 1 - (1 - np.where(policy_year == 1, lapse_rate_year1_pa, lapse_rate_later_pa)) ** (1 / months_per_year)
```

## Named sections

Every module with more than three tiles is laid out in named sections that read top to bottom as the calculation does, typically: the rates or factors applying in the period, then the roll-forward or the cashflows, then results. Every tile is in exactly one section. They are `[[module.section]]` blocks under the module in `tilekit.toml`, each with a `title` and its `tiles`.

Like this:

```toml
[[module.section]]
title = "Rates in the period"
tiles = ["mortality_rate_pm", "lapse_rate_pm"]

[[module.section]]
title = "Unit roll-forward"
tiles = ["units_allocated", "units_amc", "units_eop"]
```

## A reconciliation for every roll-forward

Every roll-forward (a carried-forward state) has a reconciliation check: opening plus movements minus closing is zero. It is a `[[module.check]]` block under the module in `tilekit.toml`, with a `name`, a `label` and an `expression`, added with the state; the expression uses only `+ - * /`, parentheses, numbers and quantity names.

Like this:

```toml
[state.units_bop]
from = "units_eop"
initial = 0.0
label = "Units at start of month"
format = "units"

[[module.check]]
name = "units_reconcile"
label = "Units roll-forward reconciles"
expression = "units_bop + units_allocated - units_amc - units_eop"
```

## A module test for every roll-forward

Every module with a roll-forward has a hand-worked module test, `tests/modules/test_<module>.py`, that walks one case through the first months and the month where behaviour changes (the end of a guarantee, a cap starting to bite), calling the tiles in order with plain numbers. Write it once the module's tiles are built. One of its tests names the case and month with a line `Case: base, month 1`.

Like this:

```python
def test_units_base_case_months_1_to_2():
    """Units roll forward through the first two months of the base case.

    Case: base, month 1
    Month 1: allocated 250 * 0.97 / 1.25 = 194.0; AMC 194.0 * 0.000625 = 0.12125; closing 193.87875
    Month 2: opening 193.87875; ...
    """
    assert units_allocated(250.0, 0.97, 1.25) == pytest.approx(194.0, rel=0, abs=1e-9)
    assert units_amc(194.0, 0.000625, 25.0) == pytest.approx(0.12125, rel=0, abs=1e-9)
```
