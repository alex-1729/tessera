import numpy as np
import pytest

from tilekit import TilekitError, load_model
from tilekit.engine import initial_state, make_step, project
from tilekit.trace import trace_json


def test_project_shapes_state_and_summary(make_model):
    model = load_model(make_model())
    params = model.default_params()
    results = project(model, {"size": np.array([1.0, 2.0])}, params, 6)

    for name in ["x", "balance_bop", "doubled", "balance_eop"]:
        assert results[name].shape == (6, 1, 2)
    assert results["total_doubled"].shape == (1, 2)

    # x_t = t * size; doubled = 2x; balance_eop = min(balance_bop * 1.01 + doubled, 50)
    balance, expected = 0.0, []
    for t in range(1, 7):
        balance = min(balance * 1.01 + 2 * t, 50.0)
        expected.append(balance)
    np.testing.assert_allclose(results["balance_eop"][:, 0, 0], expected, rtol=0, atol=1e-12)
    np.testing.assert_allclose(results["balance_bop"][1:], results["balance_eop"][:-1])
    assert results["balance_bop"][0, 0, 0] == 0.0
    np.testing.assert_allclose(results["total_doubled"], [[42.0, 84.0]])


def test_step_is_pure(make_model):
    model = load_model(make_model())
    step = make_step(model)
    state = initial_state(model, 1)
    inputs_t = {"x": np.array([[3.0]])}
    params = model.default_params()
    first = step(state, inputs_t, params)
    second = step(state, inputs_t, params)
    assert first[1]["balance_eop"] == second[1]["balance_eop"] == 6.0
    assert state["balance_bop"][0, 0] == 0.0
    assert inputs_t["x"][0, 0] == 3.0
    with pytest.raises(TypeError):
        first[0]["balance_bop"] = 1.0


def test_missing_input_series(make_model):
    model = load_model(make_model())
    model.build_inputs = lambda model_points, params, months: {}
    with pytest.raises(TilekitError, match="did not return input series 'x'"):
        project(model, {"size": np.array([1.0])}, model.default_params(), 3)


def test_trace_document(make_model):
    cases = {"big": {"id": "big", "name": "Big", "purpose": "Size two, higher cap.",
                     "model_point": {"size": 2.0}, "params": {"cap": 1000.0}, "months": 4}}
    model = load_model(make_model(cases=cases))
    data = trace_json(model, "big")
    assert data["case"] == "big" and data["months"] == 4
    assert data["params"] == {"growth_pm": 0.01, "cap": 1000.0}
    assert data["series"]["x"] == [2.0, 4.0, 6.0, 8.0]
    assert all(type(v) is float for v in data["series"]["balance_eop"])
    assert data["summary"] == {"total_doubled": 40.0}
    assert data["branches"] == {"balance_eop": {"min: first": 4, "min: second": 0}}


def test_unknown_param_override(make_model):
    cases = {"bad": {"id": "bad", "name": "Bad", "purpose": "", "model_point": {"size": 1.0},
                     "params": {"nope": 1.0}}}
    model = load_model(make_model(cases=cases))
    with pytest.raises(TilekitError, match="unknown parameters"):
        trace_json(model, "bad")
