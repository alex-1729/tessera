"""Model parameters: one frozen dataclass, each field labelled for the review workbooks."""

from dataclasses import dataclass, field


def _param(default, label, format, units):
    return field(default=default, metadata={"label": label, "format": format, "units": units})


@dataclass(frozen=True)
class Params:
    allocation_rate: float = _param(0.97, "Allocation rate", "percent", "proportion of premium")
    amc_pm: float = _param(0.000625, "AMC per month", "rate", "proportion of units per month")
    amc_cap_units: float = _param(25.0, "AMC cap", "units", "units per policy per month")
    unit_growth_pa: float = _param(0.05, "Unit growth per year", "percent", "proportion per year")
    initial_unit_price: float = _param(1.25, "Initial unit price", "units", "currency per unit")
    months_per_year: int = _param(12, "Months per year", "integer", "months")
    lapse_rate_pa: float = _param(0.06, "Lapse rate per year", "percent", "proportion of policies per year")
    expense_pm: float = _param(2.0, "Maintenance expense per month", "amount", "currency per policy per month")
    acquisition_cost: float = _param(150.0, "Acquisition cost", "amount", "currency per policy, paid once")
    discount_rate_pa: float = _param(0.07, "Discount rate per year", "percent", "proportion per year")
    quota_share: float = _param(0.5, "Quota share ceded", "percent", "proportion of the death strain")
    reinsurance_loading: float = _param(0.1, "Reinsurance premium loading", "percent",
                                        "proportion of the expected ceded death strain")
