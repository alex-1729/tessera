---
name: building-tessera-models
description: Rules and workflow for building or changing a Tessera actuarial model (tiles, modules, tilekit.toml, params, inputs, cases, hand-calculation tests). Use before designing a model, adding or editing a tile or module, writing a tile or module test, or answering why a number is what it is.
---

# Building a Tessera model

A model is a plain Python package of small pure functions called **tiles**. One tile is one quantity and one row in an Excel workbook; the function name is the quantity name. The tooling (`tilekit`) keeps a workbook for every tile, module and the model that replicates the Python with native Excel formulas and compares the two for every case. A reviewer reads the workbook and the hand-calculation test, then signs off in the Tessera app. Sign-offs are bound to hashes: a formula change needs a full re-review; a change only upstream, in parameters, inputs or cases, is values-only drift that the reviewer can re-confirm in bulk.

Everything here exists so that a reviewer who does not read code can check each quantity by hand.

## References

Read the one that matches the work before starting it.

| File | Read it when |
|---|---|
| [references/tile-rules.md](references/tile-rules.md) | Writing or changing any tile: what `tilekit check` allows, the docstring grammar, conventions |
| [references/design-standards.md](references/design-standards.md) | Designing a model, adding a module, or deciding which module a function belongs in: the spine and how a model is cut up |
| [references/module-sheets.md](references/module-sheets.md) | Laying out a module: one step per tile, sections, reconciliations, the module test |
| [references/tests.md](references/tests.md) | Writing a tile's or a module's hand-calculation test |

If the model has a `standards.md` at its root, read it too. It wins where it disagrees with these.

## How a model runs

- Modules sit in layers (`tilekit.toml` lists them) and the model reads left to right through the layers.
- A module's `timing` is one of:
  - **step** (the default): evaluated once per month from month 1 to the last. Arguments are that month's values.
  - **backward**: evaluated once per month from the last month to the first, after the forward loop. Used for reserves.
  - **summary**: evaluated once after both loops. Arguments are whole time series with time on axis 0; the result is one value per policy.
- A **carried-forward state** is how a quantity reads last month's value: `[state.units_bop]` with `from = "units_eop"` and an `initial` value. In a backward module a state reads **next** month's value of its tile, and its initial value is the value after the last month.
- A step tile can never read a backward tile or a backward state: the forward loop finishes first.
- `inputs.py` builds the monthly input series once, before the loop. Input series are data: a model-point field passed through, a value looked up from a table, or plain time bookkeeping. Anything that carries an actuarial choice is a tile.

## Workflow

### 1. Design before building

For a new model, or a restructuring, agree the whole design with the actuary before writing any tile. Ask the questions that matter first and never guess: the product and what is being priced or valued; the cash flows; the decrements and their order; the time step and projection length; any reinsurance; the results wanted. A specification they point to answers these: read it and ask only about what it leaves open.

Start from the spine in `references/design-standards.md` and work backward from the results. Write the design down for them to read (every module in calculation order, every function with what it reads and the one step it does, the carried values with their reconciliations, the inputs, parameters, tables and cases, and the assumptions to confirm) and build nothing until they agree.

If `design.json` exists, follow it. Depart from it only when the work shows it was wrong: say why, and stop to agree a new design when more than a function or two changes.

### 2. Structure, then tiles

In this order: modules in `tilekit.toml`, parameters in `params.py`, model-point fields, tables and input series in `inputs.py` and `tilekit.toml`, then cases that between them take every branch. Read `params.py` and `inputs.py` first and follow their pattern.

Lay out one module at a time, in the order the modules feed each other. For each: list its tiles with the sections, states and reconciliation checks in `tilekit.toml`, then build one tile at a time in dependency order.

### 3. One tile at a time

For each tile:

1. Write the whole function: signature, full docstring, body. See `references/tile-rules.md`.
2. Write `tests/tiles/test_<tile>.py` with the figures worked by hand. See `references/tests.md`.
3. Run the loop and read the output:

```bash
uv run tilekit check
uv run tilekit test --file tests/tiles/test_<tile>.py
uv run tilekit build
uv run tilekit status
```

4. In `status`, the tile must have no rule errors, every difference check passing in every case, every branch taken by some case, and its test passed. Fix what fails. If it cannot be done within the rules, say why instead of bending them.
5. Say in a sentence or two what changed and what the reviewer should look at in the app (the formula in the tile's sheet, the test). Then stop, unless they asked for the whole module.

A tile that reads a carried-forward state depends on every tile in that loop. Until all of them are built its values after month 1 are placeholders (NaN in Python, `#NUM!` in the workbook) and it cannot be signed off. That is expected: say so, and carry on building the rest of the loop.

When changing an existing tile, keep the label, `Units`, `Timing` and `Format` unless the change requires otherwise; rewrite the description for the new behaviour; keep the `Assumed:` lines that still hold.

### 4. Finish the module

Once every tile of a module is built, write its module test (`tests/modules/test_<module>.py`) if it has a roll-forward, run `uv run tilekit test`, and check the module's reconciliations hold in `status`. Move to the next module only then.

## What the command line does not check

`tilekit check` enforces the tile rules. These standards were enforced by the app's own chat and are **not** checked from the command line, so check them yourself every time:

- One step per tile (choosing and converting are two tiles).
- Named sections for every module with more than three tiles, every tile in exactly one.
- A reconciliation check for every carried-forward state.
- A test in every tile's test file taken from a case of the model, with the line `Case: <id>, month <n>`.
- The spine: module ids, order and fixed names; a design that departs from it says why.
- Nothing unread: a function that nothing reads and that is not a result does not belong.

## Answering questions about numbers

Run `uv run tilekit trace --case <id>` and explain from the actual values, naming months and quantities. Do not speculate beyond what the values show. `uv run tilekit graph` gives the structure: what reads what.

## Sign-off

You cannot sign off and must not try: `tilekit signoff` and `tilekit reconfirm` are the reviewer's, through the app. When the reviewer says they are happy, check `status` for blockers and tell them the tile is ready to sign off in the app, or what is in the way. For tiles whose values changed only because something upstream changed, tell them a bulk re-confirm is available there.

Record every assumption you make as an `Assumed:` line in the relevant tile's docstring, or in the input's description, so the reviewer confirms it at sign-off.
