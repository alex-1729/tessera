# Architecture and contracts

This is the shared contract for everyone building this project. If code and this file disagree, fix one of them in the same change.

## What the project is

A desktop app for reviewing and signing off Python actuarial models the way a well-built Excel model is reviewed: left to right, block by block. A model is a plain Python repo of small pure functions ("tiles"). For every tile, module and the whole model the app keeps a stored Excel workbook that replicates the Python with native Excel formulas and reconciles to it. A reviewer reads the workbook and signs off; sign-offs are bound to hashes and go stale when anything they depend on changes.

## Repo layout

```
model/      the example model being reviewed (uv project, package `unit_linked`)
tilekit/    generic Python tooling: graph, engine, trace, rule checks, translator,
            workbook builder, stamps, sign-off. uv project, package `tilekit`,
            console script `tilekit`. `model` depends on it by path.
app/        the Electron app (plain JavaScript, no framework, no bundler)
vendor/gridcraft/   GridCraft 0.19.1: `cli/gridcraft-cli` and `web/` (not in git)
spikes/     Phase 0 experiments; reference only
docs/       this file
build-plan.json   the to-do list shown in the user's sidebar (only the lead edits it)
```

`tilekit` never imports from `app`. `app` never contains actuarial or workbook logic: it shells out to `tilekit` and shows what comes back.

## Model conventions (package `unit_linked`)

Follows the "actuarial functional modelling" rules: pure functions over arrays, explicit state, one driver owns the time loop, vectorised over policies, data in/data out.

- Time step is monthly. Months are numbered 1..N. Decrements happen at the end of the month, deaths first, then lapses applied to the survivors.
- Suffixes: `_bop`, `_eop` on time-located quantities; `_pa`, `_pm` on rates. Per-policy amounts unless suffixed `_total`. Inflows to the insurer are positive. float64 throughout.
- Arrays inside a step have shape `(n_scen, n_pol)`; only one deterministic scenario is used, so `n_scen = 1`. Tiles are written with elementwise NumPy so they also work on scalars.
- No literals in calculation code except `0` and `1`. Parameters live in the frozen `Params` dataclass.

### Tiles

A **tile** is one public top-level function in a module file. One tile = one quantity = one row in Excel.

```python
def units_amc(units_after_alloc, amc_pm, amc_cap_units):
    """AMC units.

    Monthly management charge deducted in units, after allocation,
    capped at a fixed number of units.

    Units: units per policy
    Timing: during month, after allocation
    Format: units
    Assumed: the charge is on units after the same month's allocation
    """
    return np.minimum(units_after_alloc * amc_pm, amc_cap_units)
```

- The function name is the quantity name. It is unique across the whole model, and no two quantity names (tiles, inputs, parameters, states) may differ only by case (Excel names ignore case): either is a graph error.
- Every argument name must resolve to exactly one of: another tile, an input series, a parameter (a `Params` field), or a carried-forward state name.
- The body is a docstring followed by a single `return <expression>` (short `name = expression` assignments before the return are allowed and are inlined into the formula). It must translate to one Excel formula.
- Docstring grammar: first line is the plain-English label (ends with a full stop, which is dropped). Then free-text spec. Then optional `Key: value` lines: `Units`, `Timing`, `Format`, `Status`, and any number of `Assumed:` lines (assumptions the reviewer must confirm at sign-off). An indented line continues the previous key. Key lines are not part of the spec text; any other `Word:` line is.
- `Status: not built` marks a spec without an implementation: the tile's state is `not_built`, `graph` reports `"status": "not_built"`, and no tile workbook is generated for it.
- `Format` is one of:

| Format | Excel number format |
|---|---|
| `amount` | `#,##0.00`; `#,##0` when any value in the row is at least 1,000,000 |
| `units` | `#,##0.0000` |
| `number` | `#,##0.0000` |
| `small` | `0.000000` (six decimals, for small proportions such as deaths and lapses) |
| `percent` | `0.00%` |
| `rate` | `0.0000%` (small monthly rates) |
| `irr` | `0.0%` |
| `integer` | `0` |

The same formats apply to parameters (`metadata["format"]`), inputs, states and table columns.

#### Tile rules (`tilekit check`)

Errors block sign-off; warnings do not. Rule names in brackets.

- Signature: no `*args`, `**kwargs`, keyword-only arguments or default values [`signature`]; every argument resolves [`args-resolve`]; the name is unique [`unique-name`]; no cycle between tiles (a loop through a state is not a cycle) [`no-cycle`].
- Body: docstring, then simple assignments, then `return <expression>` [`body-shape`]; no loops or comprehensions [`no-loops`]; no `if` statements or conditional expressions (use `np.where`) [`no-if`]; no augmented, attribute or subscript assignment, `del`, or `out=` keyword [`no-mutation`]; no nested `def`, `class` or `lambda` [`no-nested-functions`]; no `global` or `nonlocal` [`no-globals`]; no decorator on a tile [`decorators`].
- Calls: only the functions the translator has registered may be called: `np.abs`, `np.absolute`, `np.clip`, `np.exp`, `np.log`, `np.logical_and`, `np.logical_not`, `np.logical_or`, `np.maximum`, `np.minimum`, `np.sqrt`, `np.sum`, `np.where`, `tk.irr`, `tk.npv`, `tk.round_half_away` (the list is `translate.allowed_calls()`; the message names it). Any other call, including any method call on an argument (`x.sort()`), is an error [`numpy-calls-only`]. A tile never calls another tile [`no-tile-calls`].
- `np.sum` only in summary tiles, and only as `np.sum(<series or product of series>, axis=0)`; otherwise "sum over time needs axis=0" [`sum-axis`].
- Literals: only `0` and `1`; no string, bytes or f-string constants other than the docstring [`literals`]. Names read are arguments, locals, `np` and `tk` only [`names`].
- `==` / `!=` where either side is not a whole number (a quantity whose `Format` is `integer`, an integer literal, or sums/products of those) is a warning [`comparisons`].
- Module file: the only imports are `import numpy as np`, `from tilekit import functions as tk` and `from __future__ import ...` [`imports`]. The only top-level statements are the module docstring, those imports and function definitions; no decorator or default argument value on any function in the file [`module-level`]. Both are reported against every tile of the module.
- Layers: a tile reads nothing from a layer to the right of its own [`layers`]. Naming: a `rate` should end `_pa`/`_pm`, a beginning-of-month quantity `_bop`, an end-of-month one `_eop` (warnings) [`naming`].

There are two tile timings, set per module in `tilekit.toml`:
- `step` (default): evaluated once per month inside the time loop; arguments are that month's values.
- `summary`: evaluated once after the loop; arguments are whole time series (axis 0 is time) and the result is a scalar per policy. Used for present values, IRR and totals.

#### `tk.*` functions (`from tilekit import functions as tk`)

Each has an exact Excel counterpart; axis 0 is time, other axes are independent.

| Python | Excel | Difference-check tolerance |
|---|---|---|
| `tk.irr(cashflows)` (summary only, one series) | `IRR(range)`; the first flow is at time 0; NaN when the flows never change sign | 1e-7 absolute (Excel solves iteratively) |
| `tk.npv(rate, cashflows)` (summary only) | `NPV(rate, range)`; the first flow is discounted one period | default |
| `tk.round_half_away(x, digits)` | `ROUND(x, digits)` | default |

`tk.round_half_away` rule: the value is first taken to 15 significant digits (what Excel shows and rounds), then rounded to `digits` decimal places with halves away from zero; `digits` may be negative and is truncated to a whole number; NaN and infinities pass through. So `ROUND(2.675,2)=2.68`, `ROUND(-2.5,0)=-3`, `ROUND(1250,-2)=1300`. `np.round`/`np.around` are not allowed (they round halves to even and work on the binary value).

The default tolerance of a difference check is 1e-9 absolute plus 1e-12 relative. A formula row uses the loosest tolerance of the functions in it; in module and model workbooks a row also takes the loosest tolerance of every tile upstream of it.

### `model/tilekit.toml`

```toml
[model]
name = "Unit-linked pricing"
package = "unit_linked"
params = "unit_linked.params:Params"
inputs = "unit_linked.inputs:build_inputs"
months = 120
default_case = "base"
layers = ["Inputs", "Liability", "Treaty", "Results"]

[[module]]
id = "unit_projection"
title = "Unit projection"
layer = "Liability"
python = "unit_linked.liability.units"
# timing = "summary"   (optional; default "step")
# unknown keys (purpose, feeds, ...) are allowed and ignored

[[module.section]]         # optional: how the module sheet groups its tiles (presentation only)
title = "Units allocated in the month"
tiles = ["units_allocated", "units_after_alloc"]

[[module.section]]
title = "Charge and closing units"
tiles = ["units_amc", "units_eop"]

[[module.check]]           # optional: a reconciliation that must be zero every month of every case
name = "units_reconcile"
label = "Units roll-forward reconciles"
expression = "units_bop + units_allocated - units_amc - units_eop"
# tolerance = 1e-9         (optional; absolute, at least 0)

[state.units_bop]          # carried forward: next month's units_bop is this month's units_eop
from = "units_eop"
initial = 0.0
label = "Opening units"
format = "units"

[table.mortality]          # an assumption table: CSV with a header row; the first column is the key
file = "assumptions/mortality.csv"
label = "Mortality table"
formats = { age = "integer", qx = "rate" }

[input.premium]            # a series produced by build_inputs
label = "Premium"
format = "amount"

[input.mort_rate_pa]
label = "Mortality rate per year"
format = "rate"
excel = "=INDEX({table:mortality.qx},MATCH({attained_age},{table:mortality.age},0))"

[runs]                     # optional
headline = ["in_force_eop"] # step quantities shown (at the last month) in `policies`
```

- **Sections** (`[[module.section]]`, after the module's `[[module]]` table): `title` (text) and `tiles` (a non-empty list). Every listed name must be a tile of that module, listed once; a tile in two sections is an error. Sections come in the order written, tiles in the order listed; the tiles no section lists form one final untitled section in dependency order. A module with no sections is laid out exactly as before. Sections are not part of any tile's formula, so they never touch a tile's stamp (see stamps).
- **Checks** (`[[module.check]]`): `name` (snake_case, unique within the module and not the name of any quantity, ignoring case), `label` (defaults to the name), `expression` and optional `tolerance` (default `1e-9`). The expression may use the names of the model's step quantities (tiles of step modules, input series, states, parameters; not summary tiles), numbers, `+ - * /`, unary minus and parentheses; it is parsed with `ast` and never run as Python (`tilekit/reconcile.py`). A summary module cannot have checks. A check passes when `|value| <= tolerance` in every month of every case, both in the Excel formula on the module sheet and in Python (the same expression evaluated on each case's results); a non-finite value or an Excel error never passes. These are graph errors, so every command reports them.
- `Params` is a frozen dataclass. Each field carries `metadata={"label": ..., "format": ..., "units": ...}`.
- `build_inputs(model_points, params, months) -> dict[str, np.ndarray]`: the I/O and assumptions layers. `model_points` is a dict of 1-D arrays of length `n_pol` (one key per model-point field). Each returned series has shape `(months, 1, n_pol)`. This is the only place that reads tables or does lookups, and it runs once, before the loop.
- `excel` on an input is an Excel template that replicates the series live on the model workbook's "Inputs" sheet: `{name}` is another input's cell in the same month (the defined name of a per-policy constant, see "Workbooks and the house style"), `{table:T.col}` the absolute range of a table column, and a bare identifier a parameter. Templates may read each other but not in a cycle. Inputs without `excel` are pasted values.
- A table's CSV lines starting `#` are comments; values must be numbers; the key column must not repeat. `formats` sets per-column formats on the Assumptions sheet.
- A **case** is `model/cases/<id>.json`: `{"id", "name", "purpose", "model_point": {field: value}, "params": {overrides}, "months": optional}`. The id must equal the file name. `NaN`, `Infinity` and `-Infinity` are refused in case files and parameter overrides. Cases are synthetic single policies on the deterministic scenario, used at tile, module and model level. `default_case` names the case of `review/model/workbook.xlsx` (the first case by id when absent).

### Engine (in `tilekit`, used by the model's tests and by the app)

- `tilekit.engine.make_step(model)` returns a pure `step(state, inputs_t, params) -> (state_next, outputs_t)`, composed from the step tiles in dependency order. The step contains no arithmetic of its own: it only resolves argument names and calls tiles.
- `tilekit.engine.project(model, model_points, params, months)` is the one driver that owns the time loop. It returns every quantity: step quantities as arrays `(months, n_scen, n_pol)`, summary quantities as `(n_scen, n_pol)`.
- Every array a tile receives (inputs, state, earlier outputs) is read-only; an attempt to write into one raises.
- `model/src/unit_linked/reference.py` is a slow, readable single-policy loop written out by hand without the engine. The engine must match it to 1e-10.

### Model tests

- `model/tests/tiles/test_<tile>.py` holds one tile's hand calculation: `test_<tile>_by_hand`, with the working in its docstring. There is one file per tile. Hand checks that are not about one tile live in `model/tests/test_inputs_by_hand.py`.
- Tests that run over cases take a `case_id` argument and are parametrised over whatever `cases/*.json` exist; a test that needs a particular case uses the `named_case("<id>")` fixture, which skips with a reason when that case is absent.
- `model/tests/test_signed_off.py` compares each signed-off tile's `expected.json` with Python.
- A tile test may say which case and month its figures were worked from with a line `Case: <case id>, month <n>` in a docstring (module, class or test function); `status` reports it as `case_check`.
- A module may have its own hand-worked test, `tests/modules/test_<module id>.py`: a walk through the module for one case written with the tile functions (the example model has `tests/modules/test_unit_projection.py`). It is optional; when present it must pass for the module to be signed off.

## `tilekit` command line

Run from the repo root as `uv run --project tilekit tilekit <command> --model model [options]`. The tooling has its own environment (`uv sync --project tilekit`: numpy, and pytest in the `dev` group; `tilekit/uv.lock`), so it runs against any model folder; the model's package is found because tilekit puts `<model>/src` on the path (`test` also sets `PYTHONPATH=<model>/src` for pytest). Every command prints exactly one JSON document to stdout and exits 0 on success. On failure it prints `{"error": {"message": "...", "detail": ...}}` and exits 1; this includes a result that cannot be serialised. Anything the model code prints goes to stderr, with tilekit's logs (`--verbose` for debug logs).

| Command | Purpose |
|---|---|
| `graph` | Model structure: layers, tables, modules, quantities, edges |
| `cases` | The named cases |
| `trace --case ID` | Every quantity's values for one case |
| `trace --run RUN --policy ID` | The same for one stored real policy |
| `check` | Rule violations per tile (exits 0 even with violations) |
| `build [--tile T \| --module M \| --whole-model] [--case ID] [--force]` | (Re)build stored workbooks. With no target, builds every tile (except `not_built` ones), module and the default-case model workbook that is unbuilt, stale or changed outside a build. `--case` picks the model workbook's case |
| `build --run RUN --policy ID [--tile T \| --module M \| --whole-model]` | Workbooks for one real policy under `real-data/` (model workbook when no target) |
| `status` | Review state of every tile, module and the model |
| `queue` | Everything that still needs review, upstream first |
| `signoff (--tile T \| --module M \| --whole-model) --reviewer NAME [--comment TEXT] [--values-only REASON]` | Record a sign-off. `--values-only` is the acknowledgement a values-only tile needs; refused for any other target |
| `reconfirm --reviewer NAME [--module M] [--comment TEXT]` | Bulk re-confirm tiles with values-only drift whose checks pass |
| `export --out FILE [--case ID]` | Copy a model workbook out |
| `test [--file PATH]` | Run the model's tests (pytest, with the model as rootdir) and cache the result in `review/model/tests.json`: `{at, stamp, passed, failed, tests: [{id, name, file, path, outcome}], files: {<path>: {sha256, passed, failed, skipped}}}`, where `path` is relative to the model (`tests/tiles/test_units_amc.py`) and `files` has every `tests/**/test_*.py` with the digest of the bytes that ran. With `--file`, run that one file (relative to the model or the working directory) and return its results without touching the cache (no `files`) |
| `run --model-points FILE.csv --name RUN [--id-column COL]` | Project real model points (default id column `policy_id`) |
| `runs` | Stored real-data runs, newest first, each with `current` (made with the current model stamp) |
| `policies --run RUN [--sort KEY] [--desc] [--limit N] [--offset N] [--search TEXT] [--flag uncovered\|nan\|undefined]` | List policies in a run. Sort keys: `id`, `index`, a model-point field, a summary quantity or a `[runs] headline` quantity; NaN and infinities sort last |
| `promote --run RUN --policy ID --id CASE --name NAME [--purpose TEXT]` | Write `cases/<CASE>.json` from a real policy |
| `sample-portfolio --out FILE.csv --policies N [--seed S]` | Write a SYNTHETIC portfolio CSV for trying the real-data commands |
| `init --name "Model name" [--package PKG]` | Create a new model directory at `--model DIR` (which must not exist or be empty): `pyproject.toml` (uv project; numpy, tilekit by relative path, pytest as a dev dependency), `.python-version`, `tilekit.toml` (months 120, default case `base`, layers Inputs/Liability/Results, no modules), `src/<pkg>/__init__.py` (conventions), `params.py` (`Params` with `months_per_year`), `inputs.py` (`build_inputs` returning `month`, the one annual-to-monthly conversion, table helpers), `cases/base.json`, `tests/` (conftest and a load-and-check test), `review/.gitkeep`. The package defaults to the name in snake case and must be a valid identifier. Returns `{"created", "package", "next": "uv sync"}`. Every other command works on the fresh model (a case with no model-point fields projects one policy) |

`--model DIR` names the model directory on every command, so the whole-model target of `build` and `signoff` is spelled `--whole-model`.

### `graph` output

```json
{
  "model": {"name": "Unit-linked pricing", "months": 120, "default_case": "base"},
  "layers": ["Inputs", "Liability", "Treaty", "Results"],
  "tables": [{"name": "mortality", "label": "Mortality table", "file": "assumptions/mortality.csv",
              "columns": ["age", "qx"], "rows": 93}],
  "modules": [
    {"id": "unit_projection", "title": "Unit projection", "layer": "Liability", "timing": "step",
     "python": "unit_linked.liability.units", "file": "src/unit_linked/liability/units.py",
     "tiles": ["units_allocated", "units_after_alloc", "units_amc", "units_eop"],
     "inputs": ["premium", "unit_price", "allocation_rate", "amc_pm", "amc_cap_units", "units_bop"],
     "feeds": ["cashflows"], "fed_by": [],
     "sections": [{"title": "Units allocated in the month", "tiles": ["units_allocated", "units_after_alloc"]},
                  {"title": "Charge and closing units", "tiles": ["units_amc", "units_eop"]}],
     "checks": [{"name": "units_reconcile", "label": "Units roll-forward reconciles",
                 "expression": "units_bop + units_allocated - units_amc - units_eop", "tolerance": 1e-9}]}
  ],
  "quantities": {
    "units_amc": {
      "kind": "tile", "module": "unit_projection", "label": "AMC units",
      "spec": "Monthly management charge ...", "units": "units per policy", "timing": "during month, after allocation",
      "format": "units", "assumed": ["the charge is on units after the same month's allocation"],
      "args": ["units_after_alloc", "amc_pm", "amc_cap_units"], "used_by": ["units_eop"],
      "source": {"file": "src/unit_linked/liability/units.py", "line": 31, "code": "def units_amc(...): ..."},
      "expression": "np.minimum(units_after_alloc * amc_pm, amc_cap_units)",
      "formula": "=MIN({units_after_alloc}*amc_pm,amc_cap_units)",
      "translatable": true, "untranslatable_reason": null, "branches": ["min: first", "min: second"],
      "status": null
    },
    "premium": {"kind": "input", "label": "Premium", "format": "amount", "excel": null, "used_by": ["..."]},
    "amc_pm": {"kind": "param", "label": "AMC per month", "format": "rate", "units": "...", "value": 0.000625, "used_by": ["..."]},
    "units_bop": {"kind": "state", "label": "Opening units", "format": "units", "from": "units_eop", "initial": 0.0, "used_by": ["..."]}
  },
  "order": ["units_allocated", "units_after_alloc", "units_amc", "units_eop"],
  "edges": [{"from": "units_after_alloc", "to": "units_amc"}]
}
```

`sections` is always present and complete: every tile of the module once, the configured sections in order and then, when any tile is not listed, `{"title": null, "tiles": [...]}`; a module with no sections configured has one section with `title: null` holding all its tiles. `checks` is `[]` when the module has none.

In `formula`, `{name}` marks a row quantity (replaced by a cell reference when a sheet is laid out, or by the defined name of a per-policy constant, which is one named cell) and a bare name is a parameter (a defined name in the workbook). `formula` is the same whatever the layout. `kind` is one of `tile`, `input`, `param`, `state`. `status` is `"not_built"` or null. `edges` lists argument edges only.

### `cases` and `check` output

```json
{"cases": [{"id": "base", "name": "Base", "purpose": "...", "model_point": {}, "params": {}, "months": 120, "file": "cases/base.json"}]}
{"violations": [{"tile": "...", "module": "...", "rule": "literals", "message": "...", "line": 12, "severity": "error"}],
 "counts": {"error": 0, "warning": 0}}
```

### `trace` output

```json
{"case": "base", "months": 120,
 "params": {"allocation_rate": 0.97, "...": 0},
 "series": {"premium": [250.0, "..."], "units_amc": ["..."]},
 "summary": {"pv_net_profit": 123.45},
 "branches": {"units_amc": {"min: first": 120, "min: second": 0}},
 "near_ties": {"units_amc": [{"comparison": "MIN({units_after_alloc}*amc_pm,amc_cap_units)", "month": 3}]}}
```

Non-finite values are `null`. `branches` counts the months in which each branch was taken (ties go to the first alternative; a branch inside one arm of an `IF` counts only in months that arm was reached; a summary tile counts once). `near_ties` lists, per tile, each comparison reached in a month where its two sides are within rounding of a tie: `|a-b| <= 1e-12 * max(|a|,|b|)` with `a != b` for `<`, `<=`, `>`, `>=`, `MIN`, `MAX` and clips; for `=` and `<>` exact equality counts too unless both sides are whole numbers. `month` is 1-based, `null` in a summary tile. For a real policy, `case` is null and `run` and `policy` are added.

### Tile states and sign-off

| State | Meaning |
|---|---|
| `not_built` | The docstring says `Status: not built`; no workbook, cannot be signed off |
| `unbuilt` | No stored workbook |
| `built` | Stored workbook current, no sign-off |
| `signed_off` | Sign-off current |
| `stale` | The stored workbook or the sign-off no longer matches the current stamp, or the workbook was changed outside a build |

`drift` is `null` unless the state is `stale`: `"formula"` when the tile's code, spec or the translator (with the formula layout version) changed, when the current formula differs from the `formula` stored in its `signoff.json` (whatever the version constants say), or when a check fails on a sign-off kept only for new cases; otherwise `"values"` (only upstream tiles, cases, parameters, inputs or the workbook layout changed, or the workbook needs a rebuild). A module or the model has `formula` drift when any of its tiles does.

A sign-off whose stamp differs only in `cases`, with every case it covered unchanged (cases were only added), stays `signed_off` (the new ids are in `new_cases`) only while the stored workbook is current and every case's difference check passes; otherwise it is `stale`. This applies to tiles, modules and the model; a values-only tile never gets it.

A tile can be signed off only when its workbook is built, current and unedited, every difference check passes, it has no rule errors, every branch is taken by some case, no comparison is a near-tie in any case, and it is translatable. A **values-only** tile (the translator refuses its expression form, so the workbook pastes its Python values and nothing is reconciled) needs `signoff --tile T --values-only "reason"`; the reason is stored as `values_only_reason`. `reconfirm` re-signs only tiles that are `stale` with `values` drift, whose workbook is current, that can be signed off, whose current formula equals the signed formula and that are not values-only; it lists the others in `skipped` with a reason.

### `status` output

```json
{"reviewer_default": "…",
 "tiles": {"units_amc": {
     "state": "built", "drift": null, "workbook_current": true,
     "formula": "=MIN(…)", "signed_formula": null, "module": "unit_projection",
     "checks_pass": true, "max_abs_difference": 0.0,
     "case_results": {"base": {"max_abs_difference": 0.0, "pass": true}},
     "translatable": true, "values_only": false, "values_only_reason": null,
     "near_ties": {},
     "rule_violations": [{"rule": "…", "message": "…", "line": 3}], "uncovered_branches": [],
     "new_cases": [], "signed_off": {"reviewer": "…", "at": "ISO time", "comment": "…"},
     "workbook": "review/tiles/units_amc/workbook.xlsx",
     "can_sign_off": true, "blockers": []}},
 "modules": {"unit_projection": {"state": "...", "drift": null, "workbook_current": true,
     "tiles_signed_off": 3, "tiles_total": 4, "stale": 1, "unbuilt": 0,
     "checks": [{"name": "Sheet agrees with Python", "pass": true}], "new_cases": [], "signed_off": null,
     "reconciliations": [{"name": "units_reconcile", "label": "Units roll-forward reconciles",
                          "expression": "units_bop + units_allocated - units_amc - units_eop",
                          "max_abs_difference": 0.0, "pass": true}],
     "tile_tests": {"total": 4, "passed": 4, "failed": 0, "not_run": 0, "none": 0,
                    "tiles": {"units_amc": {"tests": "passed", "hand_checks": {"in_sheet": 3, "agree": 3},
                                            "case_check": false}}},
     "module_test": {"file": "tests/modules/test_unit_projection.py", "status": "passed"},
     "workbook": "review/modules/unit_projection/workbook.xlsx", "can_sign_off": false, "blockers": ["…"]}},
 "model": {"state": "...", "drift": null, "workbook_current": true, "case": "base", "workbook_case": "base",
     "modules_signed_off": 0, "modules_total": 5, "stale": 0, "checks": [...], "new_cases": [], "signed_off": null,
     "workbook": "review/model/workbook.xlsx", "workbooks": {"base": "review/model/workbook.xlsx"},
     "can_sign_off": false, "blockers": ["…"]},
 "counts": {"tiles": {"signed_off": 0, "built": 26, "stale": 0, "unbuilt": 0, "not_built": 0, "total": 26},
            "modules": {"...": 0}, "model": {"signed_off": 0, "built": 1, "stale": 0, "unbuilt": 0}},
 "runs": {"count": 1, "newest": "sample"}}
```

- `checks_pass` / `max_abs_difference` are `null` when unbuilt and for a values-only tile; `case_results[*].pass` likewise.
- `workbook_current` is false when the stored stamp differs from the current one or the workbook's content digest no longer matches (edited outside a build). For the model it is also false when the stored workbook shows a case other than the default (`workbook_case` vs `case`).
- `near_ties` is `{case: [{"comparison", "month"}]}` from the stored sidecar.
- Module `reconciliations`: one entry per `[[module.check]]` in order, read from the module sidecar; `null` when the stored module workbook is not current (checks are part of its stamp, so a sidecar from before a check was added or changed never counts), `[]` when the module has no checks. `max_abs_difference` is the largest |value| in Excel and in Python over every month of every case (null when one is not finite or Excel returned an error); `pass` is both within the tolerance everywhere.
- Module `tile_tests`: per tile (every tile of the module, not-built ones included) `tests` is the cached result of `tests/tiles/test_<tile>.py`: `"passed"` (no test failed; all-skipped counts as passed), `"failed"`, `"not_run"` (no cache, the cache's model stamp is stale, the cache predates per-file results, the file is not in it, its bytes differ from those that ran, or none of its tests ran) or `"none"` (no test file). `hand_checks` is `{in_sheet, agree}` from the tile's `hand_checks` (null when the tile has no test file or no stored workbook built for its current test). `case_check` is whether a docstring of the test file has a line matching `^\s*Case:\s*([A-Za-z0-9_]+)\s*,\s*month\s+(\d+)\s*$`. `total` counts the built tiles (not `not_built`) and `passed`/`failed`/`not_run`/`none` split them. "Tile tests pass (n of m)" passes when every built tile's tests passed.
- Module `module_test`: `{file: "tests/modules/test_<module>.py", status}` with the same statuses; absent (`"none"`) never blocks.
- Module checks: "Sheet agrees with Python", "Tile formulas match the tile workbooks" (values-only and not-built tiles excluded), "Every tile signed off", "No rule violations", then "Reconciliations hold" (only when the module has checks), "Tile tests pass (n of m)" and "Module test passes" (only when `tests/modules/test_<module>.py` exists). Model checks: "Workbook agrees with Python", "Every module signed off", "No rule violations", then the cached model-test checks (one per `test_invariants*` test and "Model tests pass (P of T)"; all marked `"stale": true` and failing when the cache's model stamp is out of date).
- Blockers, as written: "The tile's workbook has not been built; build it first." / "… is out of date; rebuild it first." / "The stored workbook was changed outside a build. Rebuild it." / "The difference check fails in case X (largest difference D)." / "Rule violation (rule) at line N: message" / "No case takes the branch 'L'; add a case that does." / "A comparison is within rounding of a tie in case X, month N: Excel and Python may take different branches." / "This tile cannot be written as an Excel formula. Sign-off needs a values-only acknowledgement." / "This tile has not been built yet." Modules and the model add failed checks, near-ties of their tiles (prefixed with the tile name), pending sign-offs, rule-violation counts, failed model-test checks; modules also "The check '<label>' is not zero (largest value X)." per failing reconciliation (instead of a "Check failed" line), "Tile tests do not all pass: failed for a, b; not run since the last change for c (run `tilekit test`); no test file for d." (only the parts that apply), "The module test tests/modules/test_<m>.py fails." / "… has not been run since the last change; run `tilekit test`."; and, for the model, "The model workbook shows case 'X', not the default case 'Y'; rebuild it first."

### `queue` output

```json
{"items": [{"level": "tile", "id": "units_amc", "module": "unit_projection", "module_title": "Unit projection",
            "label": "AMC units", "kind": "values_drift",
            "reason": "Only upstream values changed since sign-off: rebuild and re-confirm.",
            "reasons": [{"kind": "values_drift", "text": "…"}], "reconfirm": "after_rebuild"}],
 "counts": {"total": 1, "tiles": 1, "modules": 0, "model": 0,
            "kinds": {"not_signed_off": 0, "formula_drift": 0, "values_drift": 1, "new_case": 0, "unexercised_branch": 0},
            "reconfirm": 1}}
```

The review queue is read from `status` and decides nothing again; it writes nothing. One item per tile, module (`level: "module"`, `id` the module id) or the model (`level: "model"`, `id` null) that is not in order. Order: modules left to right (`module_dependency_order`); inside a module its tiles in dependency order, then the module itself; the model last. `kind` is the main reason and `reasons` lists them all, in plain words:

- `not_signed_off`: no sign-off has ever been recorded (whatever the state of its workbook).
- `formula_drift`: stale with `formula` drift; needs a full review.
- `values_drift`: stale with `values` drift.
- `new_case`: signed off, with cases added since.
- `unexercised_branch` (tiles only, always after one of the others): no case takes a branch, which blocks sign-off.

A `not_built` tile is not an item. `reconfirm` (tiles with values drift only) is `"ready"` when `reconfirm` would re-sign the tile now, `"after_rebuild"` when the only thing in the way is an out-of-date workbook, otherwise null; it uses the same test as `reconfirm` itself. `counts.kinds` counts tiles having each reason.

### Real-data runs

The real-data folder is `<model>/real-data/` unless the environment variable `TILEKIT_REAL_DATA_DIR` names another one (an absolute path, created on first use; a relative one is an error). `runs.real_data_dir(model)` is the one place that decides; `run`, `runs`, `policies`, `build --run`, `promote`, the `status` runs summary and `sample-portfolio` (for a relative `--out real-data/...`) all go through it. The app sets the variable from the model's settings (below). Workbook paths in a command's output are relative to the model when they are inside it and absolute otherwise.

`run` stores `real-data/runs/<RUN>/` (`run.json`, `model_points.csv`, `results.npz`, `totals.json`) and returns `{"run", "policies", "months", "seconds", "summary_totals"}`; `summary_totals` sums, over policies, each summary quantity whose `Format` is `amount` (non-finite values left out). `totals.json` also holds per-month totals of every `amount` step quantity.

`policies` returns `{"run", "total", "policies": [{"id", "index", "model_point", "headline", "flags"}], "flags": {"uncovered": n, "nan": n, "undefined": n}}`. Flags: `uncovered` — the policy takes a branch no synthetic case takes; `nan` — a step series has a non-finite value (a real problem); `undefined` — a summary quantity is non-finite (for example no IRR because the cash flows never change sign). Real-data runs are never part of sign-off.

`build --run RUN --policy ID` writes only under `real-data/runs/<RUN>/policies/<ID>/{tiles/<T>,modules/<M>,model}/workbook.{xlsx,json}`. Tile and module workbooks have one sheet named `Policy <ID>`; the model workbook keeps its usual sheets. Every generated sheet's second title line (B3) is `Real data: policy <ID>, run <RUN>`. Sidecars add `"real_data": {"run", "policy", "label"}`.

## Stored review files (inside the model repo)

```
model/review/
  tiles/<tile>/workbook.xlsx     one sheet per case + "Scratch"
  tiles/<tile>/workbook.json     sidecar
  tiles/<tile>/signoff.json      {reviewer, at, comment, stamp, cases, case_hashes, assumed, formula, values_only_reason?}
  tiles/<tile>/expected.json     values frozen at sign-off; read by model/tests/test_signed_off.py
  tiles/<tile>/log.jsonl         the agent events filed under this tile (its audit trail)
  modules/<module>/log.jsonl     the same for a module
  modules/<module>/workbook.xlsx, workbook.json, signoff.json
  model/workbook.xlsx, workbook.json, signoff.json    default case; workbook-<case>.xlsx/.json for others
  model/tests.json               cached `tilekit test` result
  model/chat.jsonl               the model's one agent conversation: every event in order with its scope, and the
                                 Agent SDK session id (`{"type": "session", "session_id"}`) that is resumed
  model/log.jsonl                the agent events filed under the whole model
  drafts/<id>.json               agent drafts (modules, tiles, params, inputs, cases, what_if) and their status
  requests/<id>.json             sign-off requests: {id, kind, name, label, spec, formula, assumed, cases, blockers,
                                 values_only, stamp, workbook_current, scope, at, status: pending | confirmed |
                                 declined | expired | superseded, reviewer?}
  .cache/content.json            content digests recomputed by `status` (git-ignored by its own .gitignore)
model/real-data/                 runs and workbooks from real policies; git-ignored (or the folder chosen in the app, see below)
```

Sidecar `workbook.json` for a tile:

```json
{"kind": "tile", "name": "units_amc", "module": "unit_projection", "built_at": "ISO time", "workbook": "workbook.xlsx",
 "stamp": {"code": "…", "spec": "…", "upstream": "…", "cases": "…", "params": "…", "translator": "…", "layout": "…"},
 "formula": "=MIN({units_after_alloc}*amc_pm,amc_cap_units)", "translatable": true, "untranslatable_reason": null,
 "branch_labels": ["min: first", "min: second"], "tolerance": 1e-9, "relative_tolerance": 1e-12,
 "max_abs_difference": 0.0, "checks_pass": true,
 "cases": {"base": {"sheet": "Base", "max_abs_difference": 0.0, "checks_pass": true,
                    "branches": {"min: first": 120, "min: second": 0}, "near_ties": []}},
 "near_ties": {},
 "content_digest": "…", "content_stat": {"mtime_ns": 0, "size": 0}}
```

For a values-only tile `formula` is null and every `checks_pass` / `max_abs_difference` is null. A case entry has `"error": "#VALUE!"` when Excel returned an error Python does not agree with.

Module and model sidecars have `"kind": "module"` / `"model"`, `"tiles": {tile: {"module", "formula", "translatable", "max_abs_difference", "checks_pass", "near_ties"}}` (null checks for values-only tiles) and per-case `"tiles"` entries with `branches` and `near_ties`; modules add `"outputs"`; the model adds `"case"`, `"sheets"` and `"inputs": {input: {"excel", "max_abs_difference", "checks_pass"}}`. A module with checks adds `"reconciliations": [{name, label, expression, tolerance, excel_max_abs, python_max_abs, max_abs_difference, pass, cases: {case: {excel_max_abs, python_max_abs, pass, error?}}}]`, and the model sidecar `"reconciliations": {module: [...]}` for every module with checks; per-case entries carry them under `"reconciliations"` keyed `<module>:<name>`. Reconciliations are not part of `checks_pass` (the sheet agreeing with Python).

`content_digest` is the SHA-256 of every generated sheet's cells (formula text and cached value), the sheet order and the defined names, read from the xlsx itself; the "Scratch" sheet and names scoped to it or pointing only at it are excluded, so the app's autosave of Scratch edits does not change it. `content_stat` is the file's mtime and size at build; `status` recomputes the digest only when they differ (and caches it in `review/.cache/content.json` by mtime and size). `build` rebuilds a workbook whose digest no longer matches.

`expected.json` is `{"tile", "stamp", "case_hashes", "cases": {case: {"months", "values": [...]}}}`; non-finite values are the strings `"nan"`, `"inf"`, `"-inf"`. A current value matches when both are finite and within 1e-9, or both are the same non-finite kind.

A **stamp** is `{code, spec, upstream, cases, params, translator, layout}`, each a hex SHA-256:
- `code`: the tile's function AST (decorators included, docstring and formatting excluded) and the AST of its module file's top-level statements other than function definitions and the module docstring.
- `spec`: the tile's docstring.
- `upstream`: the `code` and `spec` of every tile upstream (through arguments, and through a state to its source tile).
- `cases`: every case file's name and bytes.
- `params`: parameter defaults and metadata; input, state and table config (including `excel` templates and every table value); `months`; the AST of every `.py` file in the model package except the tile module files and `reference.py`; the bytes of every file under `model/assumptions/` and of every declared table file. A model workbook's stamp also includes its case id here.
- `translator`: the translator version and the formula layout version (`stamps.FORMULA_LAYOUT_VERSION`, bumped only for a layout change that changes what a formula means; it has stayed `tilekit-workbook 4`).
- `layout`: the workbook layout version (`stamps.LAYOUT_VERSION`, now `tilekit-workbook 5`), bumped for any other change to how workbooks are laid out.

Module stamps combine their tiles' `code` (with the module's config) and `spec`; the model stamp combines every tile's with the model name and module config. The module config in `code` leaves out its sections and checks (`ModuleConfig.identity()`: id, title, layer, python, timing, exactly the keys stamped before sections existed). Sections and checks are part of `layout` instead: a module workbook's `layout` is the digest of the layout version with the module's sections and checks, and the model workbook's (`model_stamp(model, case)`) the same with every module's; with none it is exactly the plain layout digest, so a model without sections or checks keeps its stamps and builds byte-identical workbooks. The plain `model_stamp(model)` that the test cache and real-data runs are held to never includes them. So adding, changing or removing a section or check: no tile stamp, tile sign-off, `expected.json` or test cache changes; the module workbook (and the model workbook) goes out of date with values drift (a module's drift is `formula` only when one of its tiles has formula drift); a module or model sign-off goes `stale` (values) and, after a rebuild, is given again (modules and the model are not re-confirmed in bulk). `code`/`spec`/`translator` changing is formula drift; the rest, `layout` included, is values drift. A stamp written before `layout` existed has no such key, so it differs from a current one in `layout`: its workbook is out of date, a sign-off on it is stale with values drift and (its formula being unchanged) `reconfirm` re-signs a tile once it is rebuilt; a module or model sign-off is given again. `expected.json` is not held to `layout` (it records Python values).

## Workbooks and the house style

Workbooks are produced by scripting `vendor/gridcraft/cli/gridcraft-cli run --script X.jsonl --out FILE.xlsx` (see `spikes/house-style/build_sheet.py` for a working example and the commands that are known to work). GridCraft computes the formulas; the builder then reads the computed values back and compares them with Python. That comparison is the difference check.

House style (the user's own; follow it exactly):
- Font Open Sans 10 pt. Gridlines off. Row 1 and column A blank and equal in size (20 px). Content starts at B2.
- B2 bold title; B3 the case name. Then a parameters block: label in B, value in C, defined name written in D in maroon (128,0,0). Directly under the parameters, in the same block and style, come the sheet's **per-policy constants** (below).
- Then a block with time across the columns: a bold "Month" header row with a thin bottom border, months 1..N from column C.
- Column B holds plain-English labels (from the tile docstring / config), never code names. The code name is written in maroon in the column after the last month.
- Colour says where a value comes from; there is no key on the sheets:
  - **Blue, bold** (0,0,255): a true input, something you set. Parameters, model-point fields, assumption tables, input series (including those replicated by an `excel` template elsewhere) and a carried-forward state's month-1 initial value.
  - **Dark green, bold** (0,97,0): a value that comes from elsewhere in the model, something another tile calculated. In a tile workbook, every row argument that is another tile's output or a carried-forward state; in a module workbook, the rows from other modules' tiles; in the model workbook, every link row on a module sheet that refers to another sheet (`=Inputs!C12`, `='Unit projection'!C9`), whether it points at Inputs or at another module.
  - **Black**: a formula on this sheet.
  - **Maroon** (128,0,0): defined names. **Grey** (128,128,128): the Python and Difference comparison rows.
- Green values in tile and module workbooks are pasted from Python, never formulas: a tile or module workbook never links to another workbook file. Only the model workbook has live links, and only between its own sheets. Tracing a green value back to its source is done in the app (`app/renderer/trace.js`), not by linking files.
- Parameters are defined names and are used by name in formulas. Row quantities are also defined as named ranges, but formulas refer to them by ordinary cell reference.
- **Per-policy constants.** An input series that is a model-point field passed through unchanged (one number per policy, the same in every month, such as a sum assured or a guarantee term) is one named input cell, not a row repeating the value: bold blue value in C, label in B, code name in maroon in D, defined as a name, and formulas refer to it by that name (`MAX(sum_assured-C8,0)`, never `$C$5` or a month cell). The rule (`workbook.policy_constants`) is decided once for the whole model, so a quantity is a cell in every workbook (tile, module and model, every case sheet) or a row in every one: the input has no `excel` template, no summary tile reads it (a summary formula takes a series as a whole row range), and in every case the case's `model_point` has a field of the same name and the Python series equals that value in every month. Tile and module sheets carry the constants their tiles read (sheet-scoped names); in the model workbook they are on the Inputs sheet (workbook scope) and the module sheets use the name with no link row. The tile's translated `formula` keeps its `{name}` placeholder; only the layout fills it with the name. On a real policy's workbook a constant whose series is not one value throughout stays a row (never part of sign-off). The `Hand checks` sheet keeps every argument as a row, constants included, since each check has its own value.
- One formula per row, copied across. Classic functions: `INDEX`/`MATCH` (never `VLOOKUP`/`XLOOKUP`), `SUMPRODUCT`, `IF`, `MIN`, `MAX`, `SUM`, `NPV`, `IRR`. No `LET`, `LAMBDA` or spilling arrays.
- Below the block, in grey (128,128,128): "Python <label>" (pasted values) and "Difference" (formula minus Python), difference to 4 dp.
- Number formats by `Format` as listed under Tiles. Column B is wide enough for every label and for the B2/B3 title lines.
- A tile workbook has one sheet per case (named after the case) plus "Scratch". A module workbook has the module's tiles as one linked block per case sheet: rows from other modules, then the module's tiles (with carried-forward state rows first), then the grey Python/Difference rows of the module's outputs. With sections, each section starts with a bold heading row (the title in B, nothing else), sections separated by a blank row, in the order configured; a state row sits in the section of the first tile (in sheet order) that reads it; untitled tiles come after the titled sections without a heading. With checks, a final bold "Checks" heading after the grey rows, then one grey row per check: label in B, a live formula copied across the months over the sheet's own rows and names (for example `=C14+C15-C19-C20`), number format `0.0000`, the check name in maroon after the last month (not a defined name). Anything a check reads that no tile of the module reads (another module's tile, an input, a parameter, a state) is laid out on the sheet like the tiles' own arguments, so the formula never reaches off the sheet. The model workbook's module sheets are laid out the same way (their check rows read the sheet's link rows). The model workbook has, for one case, an "Inputs" sheet first (every parameter and per-policy constant as a defined name, pasted inputs, then inputs with an `excel` template as live formula rows checked against Python), an "Assumptions" sheet when the model has tables (each table: bold label, header row with a thin bottom border, values in bold blue, the table name in maroon), then one sheet per module in dependency order (left to right) with cross-sheet references (dark green link rows), then "Scratch".
- A values-only tile's row holds its pasted Python values (bold blue, like an input); its grey Python and Difference rows are then zero by construction and are not a check.
- Error agreement: a Python NaN agrees with an Excel `#NUM!` and a Python infinity with `#DIV/0!` (pasted Python values that are NaN or infinite are written as those errors). Any other Excel error, or an error against a finite Python value, fails the check.
- Defined names: a Python name that Excel would read as a cell reference (`A1`, `R`, `C`, `R1C1`), a boolean or a function name (`true`, `false`, `sum`, `if`, `min`, `max`, `and`, `or`, `not`, `irr`, `npv`, `index`, `match`, `round`, `int` and similar, in any case) is defined with a trailing underscore (`sum_`).
- The "Scratch" sheet belongs to the user and must survive a rebuild.

### Sign-off through the chat

**Standards files** (standing instructions kept as text, not code): every `*.md` in `app/standards/` (the house standards, shipped with the app) and then `standards.md` at the top of the open model's folder, if it has one, are appended to the agent's instructions each time a conversation starts, in both the terminal and the app's own chat. The model's file comes last and wins. Keep them short: rules and one example each. Rules that can be checked mechanically are also enforced where the work is done; for the docstring description, `descriptionProblems` in `app/src/agent/source.js` makes `write_tile` send back a tile whose description runs past two sentences or restates the formula.

**Claude Code in the chat pane (the default in the real app)**: the right bar runs the `claude` program that ships with the Agent SDK, in a pseudo-terminal (`app/src/terminal.js`, `node-pty`; drawn with xterm.js by `app/renderer/terminal.js`), started in the model's folder with the user's Claude Code sign-in. The conversation, its history (`--continue`, `/resume`, `/clear`) and the question form are Claude Code's own. It is given the app's instructions (`--append-system-prompt`), only the built-in tools Read, Glob, Grep and AskUserQuestion, and the app's tools through `app/src/agent/cli-bridge.js`: a small MCP server on stdio that posts each call to the app's local server (`/agent/tools`, `/agent/call`, with a per-launch token), where the same handlers run with the same scoping to the selection. The user's own Claude Code settings, plugins and MCP servers are not loaded. Two hooks mark a turn: UserPromptSubmit asks the app for the bracketed selection line (the selection is whatever the window shows when the message is sent), Stop ends the turn and refreshes the window. Drafts, sign-off requests and push requests are still made by the tools and still need the reviewer's click: their cards sit above the terminal, and nothing typed in the terminal can sign off or push. The app's own chat (below) is used when a test supplies an agent, under `APP_NO_AUTOSTART`, or with `chatMode: "builtin"` in the app's settings file.

**Conversations**: the conversation on show is `review/model/chat.jsonl`. `New conversation` (above the chat) moves it unchanged to `review/model/chats/<id>.jsonl` (the folder holds a `.gitignore` of `*`, so transcripts stay out of the model's repository) and the chat starts empty with a new agent session. `Conversations (N)…` lists the one on show and the earlier ones, newest first, each with its first line, date and message count, `Open` (swaps it with the one on show; its agent session is resumed) and `Delete` (asks once more, then removes that file for good). None of this runs while a turn is running, and none of it touches sign-offs, stamps, drafts, requests or the per-item `log.jsonl` audit trails. The service methods are `conversations`, `newConversation`, `openConversation(id)` and `deleteConversation(id)`; ids are `current` or `c<14 digits>-<6 hex>`.

**Markdown** (`app/renderer/markdown.js`): the agent's replies and questions are drawn from their markdown as DOM nodes, never as HTML text: paragraphs, headings (bold, same size), nested bullet and numbered lists, fenced code, tables, rules, quotes, and inline bold, italic and code. A link shows its text and address as plain text; nothing in a reply is clickable. The reviewer's own messages stay as typed.

**Questions** (`ask_user`): one call carries one to four questions, each `{question, header, options: [{label, description}], multi_select}`. The event is `{type: "question", text, questions}` and the window draws one form: per question its header, the suggested answers (radio buttons, or tick boxes with `multi_select`) and a box for another answer; `Send answers` is live once every question has an answer and sends one message, a line per question (`Header: answer`). The form goes once answered or when the reviewer types a reply instead; the questions stay as text. A single question with no suggested answers is a plain line.

The agent can prepare a sign-off; only the reviewer's explicit confirmation in the app records one. When the reviewer says they are happy, the agent calls `request_signoff` (or `request_reconfirm` for bulk re-confirmation of values-only drift), which reads `status` and saves a pending request that the window shows with a Confirm button, blockers included. The window's `confirmSignoff(id, {reviewer, comment, valuesOnlyReason})` re-reads `status`, refuses if the item's stored stamp changed since the request (or its workbook went out of date) or if blockers now exist, and only then runs `tilekit signoff` (or `reconfirm`). A typed "yes" is not a confirmation. The agent's tools are given a `tilekit` runner that refuses `signoff` and `reconfirm`, and no tool can reach `confirmSignoff`.

## Models, the launch page and git

The app keeps its own list of models in its settings file (Electron's userData `settings.json`, never in a repo): `models: [{id, name, dir, github, realDataDir, lastOpened}]`. `#/launch` is the first route and the one shown whenever no model is open: a tile per model (name, folder, GitHub link opened with `shell.openExternal` only when it is `https://github.com/...`, branch and git state in words, review progress from `status` in words, "last opened"), drawn at once from the list and filled in as `git` and `status` answer. Under each tile: `Commit and push…`, `Settings…`, `Remove from list` (the list only; the folder is never deleted). After the tiles: a dashed `New model…` tile and `Add existing folder…`. The first launch with an empty list adds the example model (`<repo>/model`); `--model DIR` (and a test's `modelDir`) opens that model directly and adds it to the list. In a model view the model name, the logo and "Tessera" in the top bar link back to the launch page. Opening a model re-points everything: the tilekit runner (and its real-data folder), the file watcher, the agent service (one conversation per model, in the model's own `review/model/chat.jsonl`), the settings entry and the window.

**The tooling**: the app always runs `uv run --project <repo>/tilekit tilekit ...` (`APP_TILEKIT_PROJECT` overrides the project; the agent's pytest uses the same default). It never uses the model's own environment.

**New model** asks for a name, a local folder and a GitHub link (`https://github.com/owner/repo`, the same with `.git`, or `git@github.com:owner/repo.git`; `APP_ALLOW_LOCAL_REMOTE=1` additionally allows a local path or `file://` URL, for tests only). Steps, each reported in words: `git ls-remote` with the user's existing git sign-in (terminal prompts are off; the app never asks for or stores a token; a sign-in or not-found failure stops with nothing created); a repository with commits is cloned and must hold `tilekit.toml` at its root (otherwise "That repository is not a Tessera model (no tilekit.toml)." and the clone is left where it is); an empty repository gets `tilekit init`, `git init -b main`, the link as `origin` and a local commit "Start <name>" (nothing is pushed), and the chat input is prefilled with the scaffolding request. The model goes in the chosen folder when it is empty, else in a subfolder named from the model name. `Add existing folder…` needs `tilekit.toml`, reads the name from it and the link from `git remote get-url origin`.

**New model with a new GitHub repository.** In the New model dialog the repository is a choice of two radio options: `Use an existing repository` (the link, as above) or `Create a new repository on GitHub`, with an owner (the signed-in account first, then its organisations), a repository name (prefilled as a lower-case slug of the model name; GitHub's rules: letters, digits, `-`, `_`, `.`, up to 100 characters, not ending in `.git`), `Private` (the default) or `Public`, and an optional one-line description (prefilled "Tessera model: <name>", at most 350 characters). One line under the fields says what will happen ("Creates <owner>/<name> on GitHub as a private repository. Nothing is pushed to it until you choose to push.") and the button reads `Create repository and model`. This uses the GitHub command-line tool `gh` and the user's existing `gh` sign-in (`app/src/github.js`; the only code that runs `gh`): `execFile`, no shell, found on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin` (`APP_GH_BIN` names another binary, for tests; under test there is no fallback to the real one); the app never reads, asks for or stores a token, and every argument is validated in the main process. When the dialog opens, `launch:github` asks `gh auth status`, `gh api user` and `gh api user/orgs`; if `gh` is missing or signed out the option stays visible but disabled with one line saying why ("The GitHub command-line tool is not installed." / "You are not signed in to GitHub in the command-line tool. Run `gh auth login` in a terminal."), and the existing-repository option works as before. **Rule: a repository is created only by the user pressing that button with that option selected** (`launch:new` with `create`, in `app/src/newrepo.js`); never by the chat agent (it has no tool for it), never automatically, never on a retry without another press. Steps, each reported in words: the owner must be the account or one of its organisations; `gh repo view <owner>/<name>` must say not found (a name that exists is refused and nothing happens); `gh repo create <owner>/<name> --private|--public --description <text>` (no `--source`, `--push` or `--clone`, so the repository is empty); its link comes from `gh repo view --json url`; then exactly the empty-repository steps above (`tilekit init`, `git init -b main`, the link as `origin`, the local commit "Start <name>", the scaffolding request in the chat input). Nothing is pushed. If a step fails after the repository was created, the repository is never deleted: the dialog says that <owner>/<name> was created and is empty, what failed, and that the user can retry with `Use an existing repository` and its link (the dialog switches to that option with the link filled in); the local folder is put back as it was.

**Git rules** (`app/src/git.js`; the only code that runs `git`): `execFile`, no shell, in a registered model's folder only; a folder that is not the top of a repository of its own (for example the example model inside this repository) is reported as such and is never committed or pushed. `commit` is `git add -A` (so `.gitignore` applies) and `git commit`; `push` is `git push -u origin <branch>`. Never a force-push, never a remote or config change (only a brand-new model adds `origin`). Git's own error text is shown. `tilekit init` writes a `.gitignore` (`.venv/`, `__pycache__/`, `real-data/`, `review/.cache/`, `review/**/log.jsonl`, `review/model/chat.jsonl`, `review/drafts/`, `review/requests/`); sign-offs, stamps, expected values, cases and stored workbooks belong in the model repo, chat transcripts and real data do not.

**Push request** (the chat can commit, never push): the agent has `git_status` (read only), `commit(message)` (local commit of the model folder, only when the user asked) and `request_push()`, which saves a pending request (`review/requests/<id>.json`, `kind: "push"`) and emits `{type: "push_request", scope, text, request: {id, branch, remote, commits: [{hash, subject}]}}`; the window draws a card with `Push` and `Not now`. Only the window's click reaches `confirmPush(id)` (re-reads git state; refuses and expires the request if the branch or remote changed; otherwise `git push`) or `declinePush(id)`. No tool can reach either.

**Per-model settings** (`Settings…` / File > Model settings…): the name (written to `[model] name` in the model's `tilekit.toml` and to the app's list; the folder and the repository are not renamed; the name is part of the model stamp, so the model workbook goes out of date and a model sign-off must be given again), the GitHub link (a label in the app's list; validated; it does not change `origin`) and the real-data folder (`Choose…`, `Use the default`). The runner passes the folder as `TILEKIT_REAL_DATA_DIR`; a path written `real-data/...` in the window means that folder; the workbook read/write allowance is `<model>/review` plus that folder (absolute paths are accepted only inside it).

## App

Electron, plain JavaScript. The main process owns the model repo path, runs `tilekit` commands, serves GridCraft's web build and the stored workbooks over a local HTTP server, and exposes a small IPC API to the window. The window has the launch page (`#/launch`) and three model views (model, module, tile). Each view is a plain details/map panel on the left half and the workbook in GridCraft on the right half.

Tracing (`app/renderer/trace.js`): in the Spreadsheet view one plain line above the spreadsheet says what the selected row is, read from the sheet's own maroon names (`app/renderer/sheetmap.js`) and `graph`. A row from elsewhere in the model (another tile's output or a carried-forward state: the dark green rows) names its source tile, module and review state, with a **Go to source** button (Ctrl+[ or Cmd+[, Excel's "go to precedents"). It opens the source tile on the same case or real policy and selects the same month in its own formula row (the month before for a carried-forward state); in the model workbook, and for a source on the same module sheet, it selects the cell inside the open workbook instead. A parameter or input row says what it is. The row a tile is calculated in lists the tiles that use it, each a link to the row where it comes in. Back and Forward return to the cell that was selected. The out-of-date, typed-formula and not-saved lines take the bar first; the real-data line stays and the trace line shows under it. Nothing links one workbook file to another. The View menu's bar items are Cmd/Ctrl+Shift+[ and ].

Review queue (`app/renderer/queue.js`): the top bar of every model view shows `Review queue N`, `Previous`, `Next` and the place of the view on show (`3 of 12`). The list comes from `tilekit queue` on every refresh (`S.queue`); the window decides nothing about review state. The button drops the list down: items grouped under their module, each with the tile name, its label and the reason in words; choosing one opens that view. Next and Previous (Cmd/Ctrl+J and Cmd/Ctrl+K; Cmd/Ctrl+Shift+J shows the list; the Review menu has the same items) move through the queue, and from a view that is not in the queue they return to the place last visited. After a sign-off recorded by the signature block, or by a chat sign-off card for the item on show, the window opens the item that followed it. The queue never records a sign-off. Its one action, `Rebuild and re-confirm (N)`, is for tiles whose `reconfirm` is not null: a dialog lists them and the reviewer's name; on the reviewer's click it builds the out-of-date ones, reads `queue` again, stops if a tile that was not listed has become eligible, and then runs `tilekit reconfirm`, which itself re-signs only tiles with values drift, an unchanged formula and passing check rows. An empty queue says "Nothing needs review." `app/test/queue.js` drives all of this against a copy of the example model.

Look: plain and dense, like a classic desktop tool. System font, thin rules, square corners, statuses written as words. No coloured pills, rounded cards, icons, status dots, gradients or shadows. The one exception is the chat, which the user asked to read as a back and forth: what the reviewer said is a navy box on the right, what the agent said a white box on the left (square corners, no labels); actions, cards and drafts stay plain.

## Hand checks (the test's figures in the spreadsheet)

A tile's hand-calculation test (`tests/tiles/test_<tile>.py`) is also run by the tile's Excel formula. `tilekit/handchecks.py` reads the test file with `ast` and takes every assertion of the plain form `assert tile(numbers...) == pytest.approx(number, rel=0, abs=...)` or `== number` (numbers, module-level constants and simple arithmetic on them; keywords allowed) as one hand check `{test, index, args, expected, tolerance}`. Assertions in any other form (inside a loop, comparing two calls, an inequality) put their test in `not_in_sheet`: Python still runs them, Excel does not. Summary tiles and tiles with no Excel formula have every test in `not_in_sheet`.

- **The sheet.** The stored tile workbook gets a `Hand checks` sheet after the case sheets: one column per check (row 4 names the test, row 5 numbers the checks), a blue input row for every argument of the tile (parameters and per-policy constants too, since a check may vary them), the tile's own formula evaluated on each column, the figure worked by hand, and their difference. One-off workbooks for a real policy do not carry it.
- **The sidecar.** `workbook.json` gains `hand_checks: {digest, sheet, checks: [{test, index, args, expected, tolerance, excel, difference, pass}], not_in_sheet, max_abs_difference, checks_pass}`. A check passes when `|excel - expected| <= max(its tolerance, the tile's tolerance) + 1e-12 * |expected|`.
- **Not part of a stamp.** Adding or changing a test never makes a sign-off stale and never changes `drift`. The sidecar's digest is compared with the test file as it is now: when they differ the tile's `workbook_current` is false, `build` rebuilds it, and until then the tile has the blocker "The tile's workbook was built before its test last changed; rebuild it first." A sidecar from before hand checks existed counts as current only while the tile has no test to show.
- **Blocks a new sign-off.** A check that does not agree adds the blocker "The spreadsheet formula does not agree with the hand calculation in <tests>." The cases' own difference check (`checks_pass`) is separate and unchanged.
- **Status.** Each tile in `status` has `hand_checks` (null when the tile has no stored workbook built for its current test): `{sheet, checks_pass, max_abs_difference, not_in_sheet, checks}`.
- **In the app.** The Test view shows, for each test, the inputs, the hand figure and the Excel formula's figure for every check on the sheet, and says which tests Excel does not see. The house standards ask for checks in the plain form so they reach the sheet.

## Module sheets in the app, and the standing rules for them

**Views.** The tile strip groups a module's boxes by its `sections`, each section's title a small plain label before its group (one untitled section, or none, draws as a single run). The strip marks only a tile that reads the one just before it, so the module view's left bar also has "How the tiles link" (`app/renderer/tilemap.js`): a map of the module's tiles with every link drawn, a solid arrow from a tile to each tile that reads it, a dashed arrow for a value carried forward to the next month, a light box for what the module reads from outside, and the sections as bands. After Module checks the left bar has "Tile tests" (one sentence from `status.modules[id].tile_tests`, then per tile: tests pass, fail, not run or no test; hand checks agreeing in Excel as "n of m" or "Python only"; and whether a check is taken from a case) and "Reconciliations" (each check's label, its expression and "holds" or "not zero (largest value X)"; "not checked yet" when `reconciliations` is null). The centre's Test segment exists at module level too: it shows `tests/modules/test_<module>.py` laid out like a tile's test, with Run (`tilekit test --file`), or a "No module test yet" panel whose button asks the agent to propose one. Missing tooling fields draw as "not reported".

**Standing rules.** House standards for module sheets are in `app/standards/building-spreadsheets.md`: one step per tile; named sections for a module of more than three tiles; a reconciliation for every roll-forward; a hand-worked module test for every roll-forward. They are enforced where the work is done. `propose_structure` takes `sections` (`[{title, tiles}]`) and `checks` (`[{name, label, expression}]`) with a module's tiles; given, they replace the module's sections or checks in `tilekit.toml` when the draft is accepted, written in the same step as states and restored with the module file if the model does not load. When proposing, `validateLayout` (`app/src/agent/validate.js`) sends back a draft that leaves a module of more than three tiles without sections covering every tile, or that carries a carried-forward state without a check naming both the state and its source tile. `write_tile` refuses a tile whose body chooses with `np.where` and also converts a rate (a power whose exponent divides or names a period, or `np.exp` with `np.log`), asking for two tiles (`chooseConvertProblems` in `app/src/agent/source.js`). `propose_module_test` drafts `tests/modules/test_<module>.py`: the whole file when there is none, otherwise functions to add; allowed with the module, one of its tiles or the whole model selected. On accept the file is written and run, and nothing is saved if a check fails. `remove_tiles` (a tiles draft with only removals) deletes tiles nothing reads: code, test and stored review files. The app's line-based toml editing (`tomlModules`, `setModuleLayout`, `dropTilesFromSections`, `insertModuleToml` in `app/src/agent/source.js`) treats every `module.*` sub-table as part of the `[[module]]` above it.

**Drafts.** `drafts/<id>.json` kinds include `tests` (functions added to a tile's test file) and `module_test` (`module`, `file`, `items`, and `code` when it writes the whole file). Tiles drafts may carry `states`, `remove`, `sections`, `checks` and `replaces`.

## The spreadsheet engine's patches

GridCraft's web build (`vendor/gridcraft/web`, not in git) is built from source at v0.19.1 by `scripts/build-gridcraft-web.sh`, which applies the patches in `vendor-patches/` in order, each skipped when already applied:

- `gridcraft-v0.19.1-open-sans.patch` embeds Open Sans (regular, bold, italic, bold italic), so cells set to Open Sans draw in it with real bold.
- `gridcraft-v0.19.1-name-highlight.patch`: while a formula is being edited, a defined name that refers to a single cell or range is coloured in the formula text and its range outlined on its own sheet, as cell references are. Names resolve as in Excel: one scoped to the sheet the edit started on first, then workbook scope. Names that are constants or formulas stay plain. The change is confined to the reference finder in `crates/ui-egui/src/editor.rs` (`formula_refs_named`) and its two display callers; F4 and point mode still see cell references only.

The unpatched release build is kept at `vendor/gridcraft/web-prebuilt`; `scripts/fetch-gridcraft.sh` restores it and wipes the patched one.

## Tooling version and pinning

- The tooling's version is `tilekit.version.VERSION`, equal to `version` in `tilekit/pyproject.toml`. Each release is tagged `tilekit-v<version>` in this repository.
- A model in its own repository pins the tooling to a tag in its `pyproject.toml`: `[tool.uv.sources] tilekit = { git = "https://github.com/alex-1729/tessera", tag = "tilekit-v0.1.0", subdirectory = "tilekit" }`. `tilekit init` writes this by default (`--tooling git`); `--tooling path` writes a relative path to this machine's copy instead, which is what the example model in this repository uses. `TILEKIT_TOOLING_REPO` overrides the repository address.
- The app never uses the model's own environment: it runs the tooling from its own copy. The pin is for the model's own tests, for other machines and for automated runs.
- `status` reports `"tooling": {"running", "source": "git" | "path" | "other" | "none", "pinned", "ref", "match"}`. `pinned` is the version when the model names a version tag; `match` is false when that differs from the running version, or when the model follows a branch or commit instead of a version tag. `init` returns the same object as `"tooling"`.
- Every `signoff.json` records `"tooling_version"`, the version that was running when the sign-off was made.
- Upgrading a model is a change to the tag in its `pyproject.toml`. Because the translator and layout versions are part of every stamp, an upgrade that changes either makes sign-offs stale.

