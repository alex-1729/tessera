# Tile rules

`uv run tilekit check` enforces these. Errors block sign-off; warnings do not.

## The function

- A tile is one public top-level function in its module file. Its name is unique across the whole model, and no two quantity names (tiles, inputs, parameters, states) may differ only by case.
- **Signature:** no `*args`, `**kwargs`, keyword-only arguments or default values. Every argument resolves to exactly one of: another tile, an input series, a parameter (a `Params` field) or a carried-forward state. No cycle between tiles (a loop through a state is not a cycle).
- **Body:** the docstring, then optional simple assignments (`name = expression`, inlined into the formula), then `return <expression>`. It must translate to one Excel formula.
  - No loops or comprehensions.
  - No `if` statements or conditional expressions: use `np.where`.
  - No augmented, attribute or subscript assignment, no `del`, no `out=` keyword.
  - No nested `def`, `class` or `lambda`. No `global` or `nonlocal`. No decorator.
- **Calls:** only `np.abs`, `np.absolute`, `np.clip`, `np.exp`, `np.log`, `np.logical_and`, `np.logical_not`, `np.logical_or`, `np.maximum`, `np.minimum`, `np.sqrt`, `np.sum`, `np.where`, `tk.irr`, `tk.npv` and `tk.round_half_away`. Any other call, including a method call on an argument (`x.sum()`, `x.astype()`), is an error. A tile never calls another tile.
- `np.round` is not allowed: use `tk.round_half_away(x, digits)`, which rounds as Excel does.
- `np.sum` only in summary tiles, and only as `np.sum(<series or product of series>, axis=0)`. `tk.irr(cashflows)` and `tk.npv(rate, cashflows)` are for summary tiles.
- **Literals:** only `0` and `1`. No string constants other than the docstring. Any other constant is a parameter. Names read are the arguments, local names, `np` and `tk` only.
- `==` and `!=` between quantities that are not whole numbers is a warning.
- **Layers:** a tile reads nothing from a layer to the right of its own.
- Arrays inside a step have shape `(n_scen, n_pol)`; write plain elementwise NumPy so the tile also works on scalars. `float64` throughout.

## The module file

- The only imports are `import numpy as np`, `from tilekit import functions as tk` and `from __future__` imports. Add the `tk` import when the first tile in the file needs it.
- The only top-level statements are the module docstring, those imports and function definitions. No decorator or default argument value on any function in the file.

## The docstring (exactly this shape)

```python
def units_allocated(premium, allocation_rate, unit_price):
    """Units allocated.

    The units bought with this month's premium after the allocation rate.

    Units: units per policy
    Timing: during month, after allocation
    Format: units
    Assumed: one line per assumption the reviewer must confirm at sign-off
    """
    return premium * allocation_rate / unit_price
```

- The first line is the label shown in Excel; it ends with a full stop.
- The description is one plain sentence saying what the quantity is, in words a reviewer who does not read code can follow. A second sentence only when the tile has branches or a boundary worth stating ("zero after the guarantee term").
  - Never restate the formula, in symbols or in words: the `return` line and the spreadsheet show it.
  - Never explain why the arithmetic works: that is the test's job.
  - A convention or a choice goes in an `Assumed:` line, once, and nowhere else.
- Key lines come after the description: `Units`, `Timing`, `Format`, then optional `Status`, `Undefined` and any number of `Assumed:` lines.
- `Format` is one of `amount`, `units`, `number`, `small` (six decimals, for small proportions such as deaths and lapses), `percent`, `rate` (small monthly rates), `irr`, `integer`.
- `Status: not built` marks a spec without an implementation. Remove the line when the tile is built.

Not like this (the formula restated, then explained, then the assumption said a third time):

```
    Converts the annual probability of death to a monthly one: 1 - (1 -
    mortality_rate_pa)^(1/months_per_year). Twelve months of survival at this
    monthly rate compound back to the annual survival probability.
```

## Values that are not a number

A tile whose value is not a number in any month of any case (a division by zero, an IRR with no root) cannot be signed off: Excel shows an error in that cell and the difference check does not check it.

- Treat it as a mistake to correct first: guard the division, or fix what feeds it.
- Only when it is truly expected, say when in one `Undefined:` line after `Format:` (for example `Undefined: when there are no premiums.`), and tell the reviewer you did. They confirm it at sign-off.

## Conventions

- The time step is monthly, months numbered 1..N.
- Decrements happen at the end of the month in the order the model states (deaths first, then lapses applied to the survivors, unless the actuary says otherwise).
- Suffixes: `_bop` and `_eop` on time-located quantities, `_pa` and `_pm` on rates (`check` warns otherwise). Amounts are per policy unless suffixed `_total`. Inflows to the insurer are positive.
- Keep parameters and table values in the basis they are quoted in (annual rates stay annual) and convert in a tile.
- Write formulas plainly: never a trick such as negating a rate to reuse a helper.

## Backward modules

- A state in a backward module reads **next** month's value of its tile (for example `reserve_pu_next` from `reserve_pu`); its `initial` is the value after the last month.
- A backward tile may read this month's value of any step tile, input, parameter or forward state.
- A step tile can never read a backward tile or a backward state.
- So a recursion such as "the greater of the surrender value now and next month's reserve discounted a month" is one backward tile reading a backward state.

## Removing a tile

Remove a tile only when nothing reads it. Delete its function and its test, remove it from its section in `tilekit.toml`, and leave its folder under `review/` alone: tell the reviewer it is there, so they decide what happens to its sign-off record.
