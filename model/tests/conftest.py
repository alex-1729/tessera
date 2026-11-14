from pathlib import Path

import pytest

from tilekit import load_model

MODEL_DIR = Path(__file__).resolve().parents[1]


def case_ids():
    """Every case in `cases/*.json`, whatever exists (a promoted or newly added case is included)."""
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
    """named_case("high_charge") -> the id, or skips the test with a reason when that case file is absent."""
    def need(case_id):
        if case_id not in case_ids():
            pytest.skip(f"needs the case '{case_id}' (cases/{case_id}.json), which is not in this model")
        return case_id
    return need
