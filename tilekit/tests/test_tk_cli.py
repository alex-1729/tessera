import json

import pytest

from tilekit.cli import COMMANDS, main


def run(capsys, *argv):
    code = main(list(argv))
    out = capsys.readouterr().out
    return code, json.loads(out)


def test_graph_cases_trace_check(make_model, capsys):
    root = str(make_model())
    code, graph = run(capsys, "graph", "--model", root)
    assert code == 0 and set(graph) >= {"model", "layers", "modules", "quantities", "order"}

    code, cases = run(capsys, "cases", "--model", root)
    assert code == 0 and [c["id"] for c in cases["cases"]] == ["one"]

    code, trace = run(capsys, "trace", "--model", root, "--case", "one")
    assert code == 0 and len(trace["series"]["balance_eop"]) == 6

    code, check = run(capsys, "check", "--model", root)
    assert code == 0 and check["counts"] == {"error": 0, "warning": 0}


def test_errors_are_json(make_model, capsys):
    root = str(make_model())
    code, doc = run(capsys, "trace", "--model", root, "--case", "missing")
    assert code == 1 and "No case 'missing'" in doc["error"]["message"]

    code, doc = run(capsys, "graph", "--model", "/nonexistent/model")
    assert code == 1 and "tilekit.toml" in doc["error"]["message"]

    code, doc = run(capsys, "no-such-command")
    assert code == 1 and "error" in doc


def test_every_contract_command_is_registered():
    assert set(COMMANDS) == {"graph", "cases", "trace", "check", "build", "status", "queue", "signoff", "reconfirm",
                             "export", "test", "run", "runs", "policies", "promote", "sample-portfolio", "init"}
