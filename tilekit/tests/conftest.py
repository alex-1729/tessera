"""Build small throwaway models on disk for tilekit's tests."""

import json
import textwrap
import uuid

import pytest

PARAMS_SOURCE = '''
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Params:
    growth_pm: float = field(default=0.01, metadata={"label": "Growth per month", "format": "rate", "units": "per month"})
    cap: float = field(default=50.0, metadata={"label": "Cap", "format": "amount", "units": "currency"})
'''

INPUTS_SOURCE = '''
import numpy as np


def build_inputs(model_points, params, months):
    size = np.asarray(model_points["size"], dtype=np.float64)
    month = np.arange(1, months + 1, dtype=np.float64).reshape(months, 1, 1)
    return {"x": np.broadcast_to(month * size, (months, 1, size.shape[0])).astype(np.float64)}
'''

# A clean two-module model: a step module with a carried-forward state, and a summary module.
GOOD_STEP = '''
import numpy as np


def doubled(x):
    """Doubled x.

    x added to itself.

    Units: currency
    Format: amount
    """
    return x + x


def balance_eop(balance_bop, doubled, growth_pm, cap):
    """Closing balance.

    Opening balance grown, plus doubled x, capped.

    Timing: end of month
    Format: amount
    """
    grown = balance_bop * (1 + growth_pm)
    return np.minimum(grown + doubled, cap)
'''

GOOD_SUMMARY = '''
import numpy as np


def total_doubled(doubled):
    """Total doubled.

    Sum over all months.

    Format: amount
    """
    return np.sum(doubled, axis=0)
'''

GOOD_STATE = {"balance_bop": {"from": "balance_eop", "initial": 0.0, "label": "Opening balance", "format": "amount"}}

GOOD_MODULES = {
    "step_mod": {"source": GOOD_STEP, "layer": "A"},
    "summary_mod": {"source": GOOD_SUMMARY, "layer": "B", "timing": "summary"},
}


def _toml_value(value):
    return json.dumps(value)  # JSON strings, numbers and lists are valid TOML here


@pytest.fixture
def make_model(tmp_path):
    """make_model(modules, states=None, layers=("Inputs", "A", "B"), months=6, cases=None) -> model dir.

    `modules` maps module id to {"source", "layer", optional "timing"}. Each call gets a
    fresh package name so imports never collide between tests.
    """
    def make(modules=None, states=None, layers=("Inputs", "A", "B"), months=6, cases=None):
        modules = GOOD_MODULES if modules is None else modules
        states = GOOD_STATE if states is None else states
        package = f"tkmodel_{uuid.uuid4().hex[:12]}"
        root = tmp_path / package
        pkg_dir = root / "src" / package
        pkg_dir.mkdir(parents=True)
        (pkg_dir / "__init__.py").write_text('"""Temporary test model."""\n')
        (pkg_dir / "params.py").write_text(PARAMS_SOURCE)
        (pkg_dir / "inputs.py").write_text(INPUTS_SOURCE)

        toml = [
            "[model]",
            'name = "Temp"',
            f'package = "{package}"',
            f'params = "{package}.params:Params"',
            f'inputs = "{package}.inputs:build_inputs"',
            f"months = {months}",
            f"layers = {_toml_value(list(layers))}",
            "",
        ]
        for module_id, spec in modules.items():
            (pkg_dir / f"{module_id}.py").write_text(textwrap.dedent(spec["source"]))
            toml += [
                "[[module]]",
                f'id = "{module_id}"',
                f'title = "{module_id.title()}"',
                f'layer = "{spec["layer"]}"',
                f'python = "{package}.{module_id}"',
                f'timing = "{spec.get("timing", "step")}"',
                "",
            ]
        for name, spec in states.items():
            toml.append(f"[state.{name}]")
            toml += [f"{key} = {_toml_value(value)}" for key, value in spec.items()]
            toml.append("")
        toml += ["[input.x]", 'label = "X"', 'format = "amount"', ""]
        (root / "tilekit.toml").write_text("\n".join(toml))

        cases = {"one": {"id": "one", "name": "One", "purpose": "Size one.", "model_point": {"size": 1.0}}} \
            if cases is None else cases
        (root / "cases").mkdir()
        for case_id, case in cases.items():
            (root / "cases" / f"{case_id}.json").write_text(json.dumps(case))
        return root

    return make


REPO_ROOT = __import__("pathlib").Path(__file__).resolve().parents[2]


@pytest.fixture
def gridcraft_cli(monkeypatch):
    """Path of gridcraft-cli (exported as GRIDCRAFT_CLI); skips the test when it is not installed."""
    from tilekit.gridcraft import find_cli
    cli = find_cli(REPO_ROOT)
    if cli is None:
        pytest.skip("gridcraft-cli not found (vendor/gridcraft is not in git)")
    monkeypatch.setenv("GRIDCRAFT_CLI", str(cli))
    return cli
