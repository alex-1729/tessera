"""Named cases: synthetic single policies in `model/cases/<id>.json`."""

import dataclasses
import json
import math
from dataclasses import dataclass

import numpy as np

from tilekit.errors import TilekitError


@dataclass(frozen=True)
class Case:
    id: str
    name: str
    purpose: str
    model_point: dict
    params: dict  # overrides of Params defaults
    months: int | None
    file: str  # relative to the model dir


def _reject_constant(name):
    raise ValueError(f"{name} is not a number JSON allows; write a finite number")


def _check_finite(case_id, where, mapping):
    for key, value in mapping.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(value):
            raise TilekitError(f"Case '{case_id}': {where} '{key}' is {value}; only finite numbers are allowed")


def _read_case(path, model):
    try:
        data = json.loads(path.read_text(), parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise TilekitError(f"Case file {path.name} is not valid JSON: {exc}") from exc
    except ValueError as exc:  # NaN, Infinity or -Infinity
        raise TilekitError(f"Case file {path.name}: {exc}") from exc
    case_id = data.get("id", path.stem)
    if case_id != path.stem:
        raise TilekitError(f"Case file {path.name} has id '{case_id}'; the id must match the file name")
    if not isinstance(data.get("model_point"), dict):
        raise TilekitError(f"Case '{case_id}' has no 'model_point' object")
    if not isinstance(data.get("params", {}), dict):
        raise TilekitError(f"Case '{case_id}': 'params' must be an object")
    _check_finite(case_id, "model point field", data["model_point"])
    _check_finite(case_id, "parameter override", data.get("params", {}))
    return Case(
        id=case_id,
        name=data.get("name", case_id),
        purpose=data.get("purpose", ""),
        model_point=data["model_point"],
        params=data.get("params", {}),
        months=data.get("months"),
        file=path.relative_to(model.root).as_posix(),
    )


def load_cases(model):
    """Every case in `<model>/cases/*.json`, sorted by id."""
    folder = model.root / "cases"
    if not folder.is_dir():
        return []
    return [_read_case(path, model) for path in sorted(folder.glob("*.json"))]


def get_case(model, case_id):
    for case in load_cases(model):
        if case.id == case_id:
            return case
    raise TilekitError(f"No case '{case_id}'", {"cases": [c.id for c in load_cases(model)]})


def case_params(model, case):
    """The model's default Params with the case's overrides applied."""
    fields = {f.name for f in dataclasses.fields(model.params_class)}
    unknown = sorted(set(case.params) - fields)
    if unknown:
        raise TilekitError(f"Case '{case.id}' overrides unknown parameters: {unknown}")
    return dataclasses.replace(model.default_params(), **case.params)


def case_model_points(case):
    """The case's single model point as length-1 float64 arrays."""
    return {field: np.array([value], dtype=np.float64) for field, value in case.model_point.items()}


def case_months(model, case):
    return int(case.months) if case.months is not None else model.config.months


def cases_json(model):
    """The `tilekit cases` document."""
    return {
        "cases": [
            {
                "id": case.id,
                "name": case.name,
                "purpose": case.purpose,
                "model_point": case.model_point,
                "params": case.params,
                "months": case_months(model, case),
                "file": case.file,
            }
            for case in load_cases(model)
        ]
    }
