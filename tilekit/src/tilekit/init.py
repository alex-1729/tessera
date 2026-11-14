"""`tilekit init`: write a minimal, valid, runnable model directory with no modules yet."""

import json
import keyword
import os
import re
from pathlib import Path

import tilekit
from tilekit.errors import TilekitError

LAYERS = ("Inputs", "Liability", "Results")


def _tilekit_project():
    """The tilekit project directory (holds its pyproject.toml), or None when tilekit is installed as a wheel."""
    root = Path(tilekit.__file__).resolve().parents[2]
    pyproject = root / "pyproject.toml"
    if pyproject.is_file() and 'name = "tilekit"' in pyproject.read_text():
        return root
    return None


def _default_package(name):
    words = re.findall(r"[a-z0-9]+", name.lower())
    package = "_".join(words) or "model"
    return package if not package[0].isdigit() else "model_" + package


def _toml_string(text):
    return json.dumps(text)  # a JSON string is a valid TOML basic string


def _pyproject(name, package, target):
    project = _tilekit_project()
    lines = [
        "[project]",
        f"name = {_toml_string(package.replace('_', '-'))}",
        'version = "0.1.0"',
        f"description = {_toml_string(name + ', built from reviewable tiles')}",
        'requires-python = ">=3.12"',
        "dependencies = [",
        '    "numpy>=2.0",',
        '    "tilekit",',
        "]",
        "",
    ]
    if project is not None:
        relative = Path(os.path.relpath(project, target)).as_posix()
        lines += ["[tool.uv.sources]", f"tilekit = {{ path = {_toml_string(relative)}, editable = true }}", ""]
    lines += [
        "[build-system]",
        'requires = ["uv_build>=0.13.7,<0.14.0"]',
        'build-backend = "uv_build"',
        "",
        "[dependency-groups]",
        "dev = [",
        '    "pytest>=8.0",',
        "]",
        "",
    ]
    return "\n".join(lines)


def _tilekit_toml(name, package):
    return "\n".join([
        "[model]",
        f"name = {_toml_string(name)}",
        f"package = {_toml_string(package)}",
        f'params = "{package}.params:Params"',
        f'inputs = "{package}.inputs:build_inputs"',
        "months = 120",
        'default_case = "base"',
        f"layers = [{', '.join(_toml_string(layer) for layer in LAYERS)}]",
        "",
        "# Modules are added as [[module]] blocks: id, title, layer, python (and optional timing = \"summary\").",
        "",
        "# ---------------------------------------------------------------- input series (built by build_inputs)",
        "",
        "[input.month]",
        'label = "Month number"',
        'format = "integer"',
        "",
    ])


def _init_source(name):
    return f'''"""{name}, written as tiles for review with tilekit.

Conventions
-----------
Period
    Monthly. Months are numbered 1..N; `tilekit.toml` sets N (120 by default).
    Decrements happen at the end of the month, in the order the model states.
Suffixes
    `_bop` / `_eop`: value at the beginning / end of the month.
    `_pa` / `_pm`: annual / monthly rate.
    `_total`: summed over policies; every other amount is per policy.
Sign
    Inflows to the insurer are positive.
Precision
    float64 throughout.
Shapes
    Input series built by `inputs.build_inputs` have shape (months, n_scen, n_pol).
    Inside a monthly step every array has shape (n_scen, n_pol). One
    deterministic scenario is used, so n_scen = 1. Tiles use elementwise NumPy
    so they also work on plain scalars.
Literals
    Calculation code uses no literals except 0 and 1; parameters live in the
    frozen `params.Params` dataclass.
"""
'''


PARAMS_SOURCE = '''"""Model parameters: one frozen dataclass, each field labelled for the review workbooks."""

from dataclasses import dataclass, field


def _param(default, label, format, units):
    return field(default=default, metadata={"label": label, "format": format, "units": units})


@dataclass(frozen=True)
class Params:
    months_per_year: int = _param(12, "Months per year", "integer", "months")
'''

INPUTS_SOURCE = '''"""Inputs layer: turn model points, parameters and assumption tables into monthly input series, once, before the loop.

This is the only place that reads a table or does a lookup. Every series is aligned to
the projection grid here, so nothing is looked up inside the time loop.
"""

import csv
from pathlib import Path

import numpy as np

ASSUMPTIONS = Path(__file__).resolve().parents[2] / "assumptions"


def monthly_rate_from_annual(rate_pa, months_per_year):
    """The monthly rate that compounds to `rate_pa` over a year: (1 + rate_pa)^(1/months_per_year) - 1.

    This is the model's one annual-to-monthly conversion. A probability of decrement
    converts through it too: q_pm = -monthly_rate_from_annual(-q_pa) = 1 - (1 - q_pa)^(1/12),
    which assumes a constant force of decrement over the year.
    """
    return (1 + rate_pa) ** (1 / months_per_year) - 1


def load_table(path):
    """{column name: 1-D float64 array} from a CSV with a header row (lines starting # are comments)."""
    with Path(path).open(newline="") as handle:
        rows = [row for row in csv.reader(handle) if row and not row[0].lstrip().startswith("#")]
    header, values = rows[0], np.array(rows[1:], dtype=np.float64)
    return {name.strip(): values[:, i] for i, name in enumerate(header)}


def lookup(keys, table_keys, table_values):
    """Exact-match lookup of every key (like Excel's INDEX/MATCH with match type 0); raises if any key is missing."""
    position = np.clip(np.searchsorted(table_keys, keys), 0, len(table_keys) - 1)
    found = table_keys[position] == keys
    if not np.all(found):
        missing = np.unique(np.asarray(keys)[~found])
        raise ValueError(f"keys not in the table: {missing.tolist()}")
    return table_values[position]


def build_inputs(model_points, params, months):
    """Input series of shape (months, 1, n_pol).

    model_points: dict of 1-D arrays, one per model-point field.

    month: 1..months.
    """
    n_pol = max((np.atleast_1d(values).shape[0] for values in model_points.values()), default=1)
    shape = (months, 1, n_pol)

    # model-point fields

    month = np.arange(1, months + 1, dtype=np.float64).reshape(months, 1, 1)

    # input series

    series = {
        "month": month,
    }
    return {name: np.broadcast_to(np.asarray(values, dtype=np.float64), shape).copy() for name, values in series.items()}
'''

CONFTEST_SOURCE = '''from pathlib import Path

import pytest

from tilekit import load_model

MODEL_DIR = Path(__file__).resolve().parents[1]


def case_ids():
    """Every case in `cases/*.json`, whatever exists."""
    return sorted(p.stem for p in (MODEL_DIR / "cases").glob("*.json"))


def pytest_generate_tests(metafunc):
    """A test that takes `case_id` (and does not parametrise it itself) runs once per case file."""
    if "case_id" in metafunc.fixturenames and not any(m.name == "parametrize" and "case_id" in m.args[0]
                                                      for m in metafunc.definition.iter_markers()):
        metafunc.parametrize("case_id", case_ids())


@pytest.fixture(scope="session")
def model():
    return load_model(MODEL_DIR)


@pytest.fixture
def named_case():
    """named_case("x") -> the id, or skips the test with a reason when that case file is absent."""
    def need(case_id):
        if case_id not in case_ids():
            pytest.skip(f"needs the case '{case_id}' (cases/{case_id}.json), which is not in this model")
        return case_id
    return need
'''

TEST_MODEL_SOURCE = '''"""The model loads, its graph builds and the rule check is clean."""

from tilekit.checks import checks_json
from tilekit.graph import graph_json


def test_model_loads_and_check_is_clean(model):
    assert graph_json(model)["model"]["name"]
    assert checks_json(model)["counts"]["error"] == 0
'''


def _base_case():
    return {
        "id": "base",
        "name": "Base",
        "purpose": "A typical policy. Model-point fields are added as the inputs are defined.",
        "model_point": {},
        "params": {},
    }


def init_model(directory, name, package=None):
    """Create a new model directory; returns {"created", "package", "next"}."""
    if not name or not str(name).strip():
        raise TilekitError("init needs --name \"Model name\"")
    name = str(name).strip()
    package = package if package is not None else _default_package(name)
    if not isinstance(package, str) or not package.isidentifier() or not package.isascii() \
            or keyword.iskeyword(package):
        raise TilekitError(f"'{package}' is not a valid package name; use letters, digits and underscores, "
                           "not starting with a digit")
    target = Path(directory).expanduser().resolve()
    if target.exists():
        if not target.is_dir():
            raise TilekitError(f"{target} exists and is not a directory")
        if any(target.iterdir()):
            raise TilekitError(f"{target} exists and is not empty; init needs a new or empty directory")

    files = {
        "pyproject.toml": _pyproject(name, package, target),
        ".python-version": "3.12\n",
        "tilekit.toml": _tilekit_toml(name, package),
        f"src/{package}/__init__.py": _init_source(name),
        f"src/{package}/params.py": PARAMS_SOURCE,
        f"src/{package}/inputs.py": INPUTS_SOURCE,
        "cases/base.json": json.dumps(_base_case(), indent=2) + "\n",
        "tests/conftest.py": CONFTEST_SOURCE,
        "tests/test_model.py": TEST_MODEL_SOURCE,
        "review/.gitkeep": "",
    }
    for relative, text in files.items():
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return {"created": str(target), "package": package, "next": "uv sync"}
