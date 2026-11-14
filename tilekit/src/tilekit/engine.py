"""The projection engine: a step composed from the step tiles, and the one driver that owns the time loop."""

from types import MappingProxyType

import numpy as np

from tilekit.errors import TilekitError


def _read_only(value):
    """The value as an array nobody can write to (tiles get read-only inputs, state and earlier outputs)."""
    array = np.asarray(value)
    if array.flags.writeable:
        array = array.view()
        array.setflags(write=False)
    return array


def _call(tile, lookup):
    return _read_only(tile.func(*(lookup(arg) for arg in tile.args)))


def make_step(model):
    """Return a pure `step(state, inputs_t, params) -> (state_next, outputs_t)`.

    `state` maps each carried-forward state name to its opening value this month;
    `inputs_t` maps each input series name to this month's slice. The step only
    resolves argument names and calls the step tiles in dependency order; it does
    no arithmetic of its own. Both returned mappings are read-only.
    """
    graph = model.graph
    tiles = [graph.tiles[name] for name in graph.step_order()]
    kinds = graph.kinds
    states = model.config.states

    def step(state, inputs_t, params):
        outputs = {}

        def lookup(name):
            kind = kinds[name]
            if kind == "tile":
                return outputs[name]
            if kind == "state":
                return _read_only(state[name])
            if kind == "input":
                return _read_only(inputs_t[name])
            return getattr(params, name)

        for tile in tiles:
            outputs[tile.name] = _call(tile, lookup)
        state_next = MappingProxyType({s.name: outputs[s.source] for s in states})
        return state_next, MappingProxyType(outputs)

    return step


def initial_state(model, n_pol):
    """Opening state for month 1: each state's `initial` value, shape (1, n_pol)."""
    return MappingProxyType({s.name: _read_only(np.full((1, n_pol), s.initial, dtype=np.float64))
                             for s in model.config.states})


def build_inputs(model, model_points, params, months):
    """Call the model's `build_inputs` and check every declared input series is there with the right shape."""
    n_pol = _policy_count(model_points)
    inputs = model.build_inputs(model_points, params, months)
    expected = (months, 1, n_pol)
    for item in model.config.input_series:
        if item.name not in inputs:
            raise TilekitError(f"build_inputs did not return input series '{item.name}'")
        shape = np.shape(inputs[item.name])
        if shape != expected:
            raise TilekitError(f"Input series '{item.name}' has shape {shape}; expected {expected}")
    return inputs


def _policy_count(model_points):
    lengths = {len(np.atleast_1d(v)) for v in model_points.values()}
    if len(lengths) != 1:
        raise TilekitError("Model-point fields must all have the same length", {"lengths": sorted(lengths)})
    return lengths.pop()


def project(model, model_points, params, months):
    """Run the projection for `months` months.

    Returns a dict of every quantity: input series, opening states and step tiles as
    arrays of shape (months, n_scen, n_pol); summary tiles as (n_scen, n_pol).
    """
    n_pol = _policy_count(model_points)
    inputs = build_inputs(model, model_points, params, months)
    graph = model.graph
    step = make_step(model)
    step_names = graph.step_order()
    state_names = [s.name for s in model.config.states]
    input_names = [i.name for i in model.config.input_series]

    state = initial_state(model, n_pol)
    rows = {name: [] for name in [*input_names, *state_names, *step_names]}
    for t in range(months):
        inputs_t = MappingProxyType({name: inputs[name][t] for name in input_names})
        for name in state_names:
            rows[name].append(state[name])
        for name in input_names:
            rows[name].append(inputs_t[name])
        state, outputs = step(state, inputs_t, params)
        for name in step_names:
            rows[name].append(outputs[name])

    # a tile that reads only parameters returns a scalar; broadcast so every series has the same shape
    results = {
        name: np.stack([np.broadcast_to(v, (1, n_pol)) for v in values]).astype(np.float64)
        if values else np.zeros((0, 1, n_pol))
        for name, values in rows.items()
    }

    for name in graph.summary_order():
        tile = graph.tiles[name]

        def lookup(arg):
            if graph.kinds[arg] == "param":
                return getattr(params, arg)
            return _read_only(results[arg])

        # a ratio to zero or an IRR with no root is a legitimate NaN/inf result (Excel shows #DIV/0!, #NUM!)
        with np.errstate(divide="ignore", invalid="ignore"):
            value = _call(tile, lookup)
        results[name] = np.broadcast_to(value, (1, n_pol)).astype(np.float64)
    return results
