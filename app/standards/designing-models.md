# House standards for designing a model

A model is designed whole before anything is built: every module and function, what each reads, the carried values, the reconciliations and the cases, proposed with `propose_design` and agreed by the user. These apply to every model; a model's own `standards.md` wins where the two disagree. The tools enforce the rules marked (checked).

## Modules

- **One reviewer question per module.** "What is the policy worth", "who leaves", "what cash moves". The purpose is one sentence; if it needs two, it is two modules.
- **One roll-forward per module**, with its reconciliation in the same module (checked: every carried value has one). Two carried values share a module only when they cannot be reviewed apart, such as an account value and the amount withdrawn from it this year.
- **Per-policy amounts stay apart from weighting** (checked). Amounts per policy in force are worked out in their own modules; in-force and decrements in theirs. Only the module marked `weights: true`, normally the cash flows, multiplies one by the other.
- **Modules are listed in calculation order and read only from earlier ones** (checked). A layer never reads from a later layer: the liability knows nothing of a treaty, assets or results.
- **A narrow interface.** A module hands on a few quantities. When other modules read most of its functions, it is cut in the wrong place.
- **A placeholder is one function.** A simplification to be replaced later (a reserve set equal to the surrender value) sits in a single function, so replacing it touches nothing else.

## Functions

- **A quantity a reviewer would recognise and could work by hand**, named with the actuarial term: `surrender_charge`, not `adj_factor_2`.
- **One step each** (checked): `choose` between values, `convert` a rate or basis, `apply` a rate or charge, `limit` with a cap or floor, `combine` by adding or netting. A floor is separate from the value it floors.

  Like this: `csv_before_floor` (combine), then `cash_surrender_value` (limit). Not one function that nets the charge and applies the floor.
- **Each convention in one place.** One function converts each rate; the decrement order is stated once. Nothing is worked out twice: a second function that needs a value reads the first.
- **Every cash flow line is its own signed function**, and the net is a plain sum of them.
- **Work backward from the results** (checked: nothing unread). Name the results first, then the cash flow lines, then what feeds them. A function that nothing reads and that is not a result does not belong.
- **Every branch has a case that takes it** (checked). Cases are designed with the functions: each `choose` or `limit` function lists its branches and the case that takes each.
- **Timing is stated once for the model**, as the order of events within a month, and each function says where in that order it sits.
- **Inputs are data** (checked: field, lookup or time). A rate path, an inflation factor or anything else with a choice in it is a function or a table, never a formula hidden in an input.

## Keeping to the design

Later drafts of modules and functions are compared with the agreed design and say where they depart. A departure is allowed when the work shows the design was wrong: say why in the draft's summary, and propose the design again when the change is more than a function or two.
