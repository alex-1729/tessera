# House standards for designing a model

A model is designed whole before anything is built: every module and function, what each reads, the carried values, the reconciliations and the cases, proposed with `propose_design` and agreed by the user. These apply to every model; a model's own `standards.md` wins where the two disagree. The tools enforce the rules marked (checked).

## The spine

Every model has the same modules, in this order, so that a reviewer who knows one model knows where to look in the next. A design that departs from it is shown with a warning (checked).

| Module id | Title | Runs | Holds |
|---|---|---|---|
| `decrements` | Decrements | each month | Rates per year, rates per month, the numbers leaving, closing units |
| `policy_values` | Policy values | each month | The product's own roll-forwards (account value, a sum assured with bonuses, a benefit base) and what feeds them, nothing else. Only when the product has one |
| `per_unit_items` | Per-unit cash items | each month | Every premium, benefit, charge, expense and commission, per policy in force or per event, and everything worked out to price them |
| `cash_flows` | Cash flows | each month | Each per-unit item times units or a decrement, and the net. Nothing else |
| `reserves` | Reserves | backward | The reserve per policy in force, and in total |
| `results` | Results | once, at the end | The total and the present value of each cash flow line |

- **A unit is one policy issued.** `units_bop` is the share still in force at the start of the month.
- **Decrements read only inputs and carried values**, never this month's functions from a later module. A decrement that depends on the policy's value (a dynamic lapse) reads last month's value, carried forward.
- **Names are fixed.** Decrements: `units_bop`, then for each cause `<cause>_rate_pa`, `<cause>_rate_pm` and `<cause>_units`, then `units_eop`, with the reconciliation `units_reconcile`. Per-unit cash items: each line is `<line>_pu` (`premium_pu`, `death_benefit_pu`, `maintenance_expense_pu`). Cash flows: `<line>_cf` for each `<line>_pu`, and `net_cashflow`. Reserves: `reserve_pu` and `reserve_eop`. Results: `total_<line>` and `pv_<line>`.
- **Pricing a benefit happens in per-unit cash items**, not in policy values. A surrender value's charge, market value adjustment and floor are functions of `per_unit_items` ending in `surrender_benefit_pu`; `policy_values` stops at the account value and the free amount. Only `per_unit_items` and the reserve use the `_pu` ending.
- **Cash flows is mechanical.** `<line>_cf` reads `<line>_pu` and `units_bop`, `units_eop` or a `<cause>_units`. The one exception is a payment made whether or not the policy is in force (an annuity's certain period): it is weighted by policies issued, and says so in an `Assumed:` line.
- **Per-unit cash items never read this month's reserve.** A surrender value that depends on the reserve reads last month's, carried forward, or a tabulated value.
- **Results discount with `tk.npv`.** `results` holds one monthly discount rate (`discount_rate_pm`) and each `pv_<line>` is `tk.npv` of that rate and the line. No discount factor series anywhere else.
- **Reserves value guaranteed benefits on a guaranteed basis.** Where the projection credits or pays something that is not guaranteed (a renewal rate set from the market, a bonus not yet declared), the reserve works from its own guaranteed value, in the `reserves` module, not from the projected one.
- **Reserves run backward**: the reserve at the end of a month is worked out from the month after it (`timing: backward`), so the greatest present value over future surrender dates is a recursion from the last month to the first.

## Modules

- **One reviewer question per module.** "What is the policy worth", "who leaves", "what cash moves". The purpose is one sentence; if it needs two, it is two modules.
- **One roll-forward per module**, with its reconciliation in the same module (checked: every carried value has one). Two carried values share a module only when they cannot be reviewed apart, such as an account value and the amount withdrawn from it this year.
- **Per-policy amounts stay apart from weighting** (checked). Amounts per policy in force are worked out in their own modules; in-force and decrements in theirs. Only a module marked `weights: true` multiplies one by the other: `cash_flows`, and `reserves` for the reserve in total.
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
