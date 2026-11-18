# Hand-calculation tests

Every tile has a test file, `tests/tiles/test_<tile>.py`. A reviewer reads the working, not the code. A tile cannot be signed off until its own test has passed since the last change.

Follow an existing file in `tests/tiles/` if there is one.

## Shape of a tile's test file

```python
"""Hand calculation of death_units.

Case figures: one policy is issued, so units_bop is 1 in month 1. In the base case the
monthly probability of death at month 1 is 0.0013956636.
"""

import pytest

from myga.liability.decrements import death_units


def test_death_units_base_month_1():
    """Month 1 of the base case: one policy in force times the monthly probability of death.

    Case: base, month 1
    1 x 0.0013956636 = 0.0013956636.
    """
    assert death_units(1.0, 0.0013956636) == pytest.approx(0.0013956636, rel=0, abs=1e-9)
```

- The module docstring states the case figures used.
- One test function per behaviour. Each test's docstring has a first line saying what is checked, then the working by hand, figure by figure.
- **One test is taken from a case of the model**, so the hand figure can be set beside the Python value and the spreadsheet. Its docstring carries the line `Case: base, month 1` (any case id and month) straight after the first line, and its working uses that case's inputs for that month. Every tile's test file must have one.
- Imports: `pytest` and the tile from its module. The test calls the tile directly with plain numbers.

## The figures

- **Work the expected figure out by hand from the inputs.** Never copy the tile's own output from the trace as the expected value. You may take the tile's *inputs* for a month from `uv run tilekit trace --case <id>`.
- Write each check as a plain call of the tile with numbers on the left and the hand figure on the right:

  ```python
  assert units_amc(194.0, 0.000625) == pytest.approx(0.12125, rel=0, abs=1e-9)
  ```

  Checks in that form are also run by the tile's Excel formula on a Hand checks sheet of its workbook and shown beside the hand figure. A check inside a loop, or one that compares two calls, runs in Python only; use those only when the kind of test needs it (a direction test, for example), and still assert each figure in the plain form first.
- Give every hand figure to the precision it is checked at: with the tolerance of 1e-9, an expected value that is not exact needs at least ten decimal places (`0.2928932188`, not `0.29289322`). A figure rounded further than the tolerance makes a correct tile fail.
- Choose figures that can be checked by eye (an exact square root, a round number) wherever the kind of test allows.
- Cover every branch.

## Kinds of test a reviewer can ask for

- **Boundary values:** zero, one, the first and last month, the month a term ends.
- **Each branch:** one check on each side of every condition.
- **Direction:** raising an input moves the result the expected way.
- **Reconciliation:** the parts add up to the whole.
- **A known figure:** a value the reviewer supplies from a pricing sheet or a published table.

## Module tests

A module with a roll-forward has `tests/modules/test_<module>.py`: one case of the model walked through the module's tiles in order, for the first months and the month where behaviour changes (the end of a guarantee, a cap starting to bite), with every figure worked by hand. One of its tests names the case and month with a line `Case: base, month 1`. See `module-sheets.md` for an example.

## Running them

```bash
uv run tilekit test --file tests/tiles/test_<tile>.py
uv run tilekit test
```

Use `tilekit test`, not bare `pytest`: only `tilekit test` records the result that sign-off depends on. A single-file run records that file only; run the whole suite before a commit.
