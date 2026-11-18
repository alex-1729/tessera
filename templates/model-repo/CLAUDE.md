# A Tessera model

This repository is one actuarial model built from **tiles**: small pure Python functions, one per quantity, each replicated as a native Excel formula in a stored workbook and reviewed and signed off by an actuary in the Tessera app. The code is written here, in the editor; the app is open alongside to show the map, the workbooks, the tests and the review queue.

The actuary knows the actuarial side better than you do. Turn what they say into correct, reviewable code, show the evidence, and ask when an actuarial choice is open.

## Before changing the model

Load the `tessera-modelling:building-tessera-models` skill. It comes from the `tessera-modelling` plugin in the Tessera repository's marketplace, which this repository's `.claude/settings.json` enables; if the skill is not listed, say so and ask the user to install the plugin instead of carrying on without it. It holds the tile rules, the standard module spine, the design standards and the test format. Do not write or change a tile, a module, `tilekit.toml`, `params.py`, `inputs.py` or a case without it.

## Where things are

| Path | Holds |
|---|---|
| `tilekit.toml` | Layers, modules (with sections and reconciliation checks), input series, assumption tables, carried-forward states |
| `design.json` | The agreed design of the whole model, when there is one. Follow it |
| `standards.md` | This model's own standards, when present. They win over the skill's |
| `src/<package>/<layer>/<module>.py` | The tiles of one module |
| `src/<package>/params.py` | The frozen `Params` dataclass: every parameter with label, format and units |
| `src/<package>/inputs.py` | Builds the monthly input series once, before the time loop. The only place with lookups |
| `assumptions/*.csv` | Assumption tables |
| `cases/*.json` | The synthetic single-policy cases used everywhere |
| `tests/tiles/test_<tile>.py` | The hand calculation of one tile |
| `tests/modules/test_<module>.py` | The hand-worked walk through one module |
| `review/` | Stored workbooks, stamps and sign-offs. Written by the tooling only |

## The loop after every change

Run these from the repository root, in this order, and read the output before saying anything is done:

```bash
uv run tilekit check
uv run tilekit test --file tests/tiles/test_<tile>.py
uv run tilekit build
uv run tilekit status
```

- `check` exits 0 even with violations: read the list. Errors block sign-off; warnings do not.
- `build` rebuilds every workbook that is unbuilt or stale. In `status`, a built tile must have every difference check passing in every case.
- Run the whole suite with `uv run tilekit test` before a commit. Use `tilekit test`, not bare `pytest`: only `tilekit test` records the result that sign-off depends on.
- `uv run tilekit trace --case base` gives every quantity's values for a case; `uv run tilekit queue` lists what still needs review.

## Hard rules

- **Never sign anything off.** Do not run `tilekit signoff` or `tilekit reconfirm`, and never say something is signed off. Only the reviewer signs off, in the app. When they say they are happy with a tile, tell them it is ready to sign off there, and name any blocker `status` reports.
- **Never edit anything under `review/` by hand**, and never delete a sign-off. The tooling writes those files; a hand edit breaks the hash that binds a sign-off to the code.
- **Changing a signed-off tile makes its sign-off stale**, and that of everything downstream. Check `status` first, and ask before changing a tile that is signed off or has signed-off tiles downstream.
- **Never guess an actuarial choice** that changes the numbers: the basis of a rate, a sign, the timing within the month, the order of decrements, what happens at a boundary. Ask.
- **Never copy a tile's output into its test as the expected figure.** Work it by hand from the inputs.
- **One writer at a time.** Do not edit the model while the app's own chat is changing it.
- Commit only when asked, with a one-line factual message. Never push unless asked.
