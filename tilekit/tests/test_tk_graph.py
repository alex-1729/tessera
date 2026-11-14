import pytest

from tilekit import TilekitError, load_model
from tilekit.graph import graph_json


def doc(label="Thing", fmt="amount"):
    return f'"""{label}.\n\n    Spec.\n\n    Format: {fmt}\n    """'


def test_good_model_graph(make_model):
    model = load_model(make_model())
    graph = model.graph
    assert graph.order == ("doubled", "balance_eop", "total_doubled")
    assert graph.kinds["x"] == "input"
    assert graph.kinds["growth_pm"] == "param"
    assert graph.kinds["balance_bop"] == "state"
    assert graph.used_by["doubled"] == ["balance_eop", "total_doubled"]
    assert ("doubled", "total_doubled") in graph.edges

    data = graph_json(model)
    step, summary = data["modules"]
    assert step["tiles"] == ["doubled", "balance_eop"]
    assert step["inputs"] == ["x", "growth_pm", "cap", "balance_bop"]
    assert step["feeds"] == ["summary_mod"] and step["fed_by"] == []
    assert summary["inputs"] == ["doubled"] and summary["fed_by"] == ["step_mod"]
    assert summary["timing"] == "summary"

    q = data["quantities"]
    assert q["balance_eop"]["label"] == "Closing balance"
    assert q["balance_eop"]["expression"] == "np.minimum(grown + doubled, cap)"
    assert q["balance_eop"]["source"]["file"].endswith("step_mod.py")
    assert q["balance_eop"]["source"]["file"].startswith("src/")
    assert q["balance_eop"]["source"]["code"].startswith("def balance_eop(")
    assert q["balance_eop"]["formula"] == "=MIN({balance_bop}*(1+growth_pm)+{doubled},cap)"
    assert q["balance_eop"]["translatable"] is True
    assert q["balance_eop"]["branches"] == ["min: first", "min: second"]
    assert q["growth_pm"] == {"kind": "param", "label": "Growth per month", "format": "rate",
                              "units": "per month", "value": 0.01, "used_by": ["balance_eop"]}
    assert q["balance_bop"]["from"] == "balance_eop" and q["balance_bop"]["initial"] == 0.0
    assert q["x"]["kind"] == "input"


def test_unresolved_name(make_model):
    source = f"def bad(x, nowhere):\n    {doc()}\n    return x + nowhere\n"
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states={}))
    with pytest.raises(TilekitError, match="Unresolved argument names: 'nowhere' in bad") as err:
        model.graph
    assert err.value.detail == [{"tile": "bad", "arg": "nowhere", "line": 1}]


def test_duplicate_tile_in_two_modules(make_model):
    source = f"def same(x):\n    {doc()}\n    return x\n"
    model = load_model(make_model({"m1": {"source": source, "layer": "A"},
                                   "m2": {"source": source, "layer": "A"}}, states={}))
    with pytest.raises(TilekitError, match="defined more than once: same"):
        model.graph


def test_tile_named_like_a_param(make_model):
    source = f"def cap(x):\n    {doc()}\n    return x\n"
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states={}))
    with pytest.raises(TilekitError, match="defined more than once: cap") as err:
        model.graph
    assert len(err.value.detail[0]["defined_as"]) == 2


def test_cycle(make_model):
    source = (f"def first(second):\n    {doc()}\n    return second\n\n\n"
              f"def second(first):\n    {doc()}\n    return first\n")
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states={}))
    with pytest.raises(TilekitError, match="Cycle between tiles") as err:
        model.graph
    assert set(err.value.detail["cycle"]) == {"first", "second"}


def test_loop_through_state_is_not_a_cycle(make_model):
    source = f"def level_eop(level_bop, x):\n    {doc()}\n    return level_bop + x\n"
    states = {"level_bop": {"from": "level_eop", "initial": 0.0, "label": "Opening level", "format": "amount"}}
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states=states))
    assert model.graph.order == ("level_eop",)


def test_state_from_unknown_tile(make_model):
    states = {"ghost_bop": {"from": "ghost_eop", "initial": 0.0, "label": "Ghost", "format": "amount"}}
    source = f"def d(x):\n    {doc()}\n    return x\n"
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states=states))
    with pytest.raises(TilekitError, match="not a tile"):
        model.graph


def test_private_and_imported_functions_are_not_tiles(make_model):
    source = ("import numpy as np\nfrom numpy import minimum\n\n\n"
              f"def _helper(x):\n    return x\n\n\ndef only(x):\n    {doc()}\n    return x\n")
    model = load_model(make_model({"m": {"source": source, "layer": "A"}}, states={}))
    assert [t.name for t in model.tiles] == ["only"]


def test_bad_config_layer(make_model):
    source = f"def only(x):\n    {doc()}\n    return x\n"
    with pytest.raises(TilekitError, match="unknown layer"):
        load_model(make_model({"m": {"source": source, "layer": "Nowhere"}}, states={}))
