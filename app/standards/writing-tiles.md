# House standards for writing tiles

These apply to every model. A model can add its own in a `standards.md` file at the top of its folder; where the two disagree, the model's file wins.

## The description in a tile's docstring

The paragraph between the label and the `Units:` line says what the quantity is, in words a reviewer who does not read code can follow.

- One plain sentence. A second only when the tile has branches or a boundary worth stating (for example "zero after the guarantee term").
- Never restate the formula, in symbols or in words: the `return` line and the spreadsheet show it.
- Never explain why the arithmetic works: that is the hand-calculation test's job.
- A convention or a choice goes in an `Assumed:` line, once, and nowhere else.

Like this:

```python
def mortality_rate_pm(mortality_rate_pa, months_per_year):
    """Monthly probability of death.

    The annual probability of death converted to a monthly one.

    Units: probability per month
    Timing: during month
    Format: small
    Assumed: constant force of mortality within the year.
    """
    return 1 - (1 - mortality_rate_pa) ** (1 / months_per_year)
```

Not like this (the formula is restated, then explained, then the assumption says it a third time):

```
    Converts the annual probability of death to a monthly one: 1 - (1 -
    mortality_rate_pa)^(1/months_per_year). Twelve months of survival at this
    monthly rate compound back to the annual survival probability.
```

## Values that are not a number

A tile whose value is not a number in some month of some case (a division by zero, an IRR with no root) cannot be signed off: Excel shows an error in that cell and the difference check does not check it.

- Treat it as a mistake to correct first: guard the division, or fix what feeds it.
- Only when it is truly expected, say when in one `Undefined:` line after `Format:`, for example `Undefined: when there are no premiums.` The reviewer confirms it at sign-off.

## Tests

Every tile has a hand-calculation test file. A reviewer reads the working, not the code.

- Each test's docstring: a first line saying what is checked, then the working by hand, figure by figure.
- One test is taken from a case of the model, so the hand figure can be set beside the Python value and the spreadsheet. Its docstring carries the line `Case: base, month 1` (any case id and month) straight after the first line, and its working uses that case's inputs for that month.
- More tests are proposed with `propose_tests` when the reviewer asks. The kinds a reviewer can ask for:
  - **Boundary values:** zero, one, the first and last month, the month a term ends.
  - **Each branch:** one check on each side of every condition.
  - **Direction:** raising an input moves the result the expected way.
  - **Reconciliation:** the parts add up to the whole.
  - **A known figure:** a value the reviewer supplies from a pricing sheet or a published table.
- Write each check as a plain call of the tile with numbers on the left and the hand figure on the right: `assert tile(194.0, 0.000625) == pytest.approx(0.12125, rel=0, abs=1e-9)`. Checks in that form are also run by the tile's Excel formula on a Hand checks sheet of its workbook and shown beside the hand figure. A check inside a loop, or one that compares two calls, runs in Python only; use those only when the kind of test needs it (a direction test, for example), and still assert each figure in the plain form first.
- Give every hand figure to the precision it is checked at: with the usual tolerance of 1e-9, an expected value that is not exact needs at least ten decimal places (0.2928932188, not 0.29289322). A figure rounded further than the tolerance makes a correct tile fail.
- Choose figures that can be checked by eye (an exact square root, a round number) wherever the kind of test allows.
