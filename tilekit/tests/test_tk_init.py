import json
import subprocess
import sys
import tomllib
import uuid
from pathlib import Path

import pytest

from tilekit.cli import main
from tilekit.init import init_model


def run(capsys, *argv):
    code = main(list(argv))
    return code, json.loads(capsys.readouterr().out)


def fresh_package():
    return f"tkinit_{uuid.uuid4().hex[:12]}"


def test_init_writes_a_model(tmp_path, capsys):
    target = tmp_path / "level_term"
    package = fresh_package()
    code, doc = run(capsys, "init", "--model", str(target), "--name", "Level term", "--package", package)
    assert code == 0
    assert doc == {"created": str(target.resolve()), "package": package, "next": "uv sync"}
    for relative in ["pyproject.toml", ".python-version", "tilekit.toml", f"src/{package}/__init__.py",
                     f"src/{package}/params.py", f"src/{package}/inputs.py", "cases/base.json",
                     "tests/conftest.py", "tests/test_model.py", "review/.gitkeep"]:
        assert (target / relative).is_file(), relative

    config = tomllib.loads((target / "tilekit.toml").read_text())["model"]
    assert config == {"name": "Level term", "package": package, "params": f"{package}.params:Params",
                      "inputs": f"{package}.inputs:build_inputs", "months": 120, "default_case": "base",
                      "layers": ["Inputs", "Liability", "Results"]}
    project = tomllib.loads((target / "pyproject.toml").read_text())
    assert "numpy>=2.0" in project["project"]["dependencies"]
    assert any(d.startswith("pytest") for d in project["dependency-groups"]["dev"])
    source = project["tool"]["uv"]["sources"]["tilekit"]
    assert (target / source["path"] / "pyproject.toml").is_file()  # relative to the new directory
    assert not Path(source["path"]).is_absolute()
    assert json.loads((target / "cases" / "base.json").read_text())["id"] == "base"


def test_init_default_package_from_name(tmp_path):
    doc = init_model(tmp_path / "m", "Level Term 2026")
    assert doc["package"] == "level_term_2026"


@pytest.mark.parametrize("package", ["1abc", "has-dash", "class", "with space", ""])
def test_init_refuses_bad_package(tmp_path, capsys, package):
    code, doc = run(capsys, "init", "--model", str(tmp_path / "m"), "--name", "X", "--package", package)
    assert code == 1 and "not a valid package name" in doc["error"]["message"]
    assert not (tmp_path / "m").exists()


def test_init_refuses_a_non_empty_directory(tmp_path, capsys):
    (tmp_path / "m").mkdir()
    (tmp_path / "m" / "notes.txt").write_text("keep")
    code, doc = run(capsys, "init", "--model", str(tmp_path / "m"), "--name", "X")
    assert code == 1 and "not empty" in doc["error"]["message"]
    assert sorted(p.name for p in (tmp_path / "m").iterdir()) == ["notes.txt"]


def test_init_accepts_an_empty_directory(tmp_path, capsys):
    (tmp_path / "m").mkdir()
    code, doc = run(capsys, "init", "--model", str(tmp_path / "m"), "--name", "X", "--package", fresh_package())
    assert code == 0 and (tmp_path / "m" / "tilekit.toml").is_file()


def test_init_needs_a_name(tmp_path, capsys):
    code, doc = run(capsys, "init", "--model", str(tmp_path / "m"))
    assert code == 1 and "--name" in doc["error"]["message"]


def test_every_command_works_on_a_fresh_model(tmp_path, capsys, gridcraft_cli):
    target = tmp_path / "fresh"
    run(capsys, "init", "--model", str(target), "--name", "Fresh", "--package", fresh_package())
    root = str(target)

    code, graph = run(capsys, "graph", "--model", root)
    assert code == 0 and graph["modules"] == [] and graph["order"] == []
    assert graph["quantities"]["months_per_year"]["kind"] == "param"
    assert graph["quantities"]["month"]["kind"] == "input"

    code, check = run(capsys, "check", "--model", root)
    assert code == 0 and check["counts"] == {"error": 0, "warning": 0}

    code, cases = run(capsys, "cases", "--model", root)
    assert code == 0 and [c["id"] for c in cases["cases"]] == ["base"]

    code, trace = run(capsys, "trace", "--model", root, "--case", "base")
    assert code == 0 and trace["series"]["month"][:3] == [1.0, 2.0, 3.0] and len(trace["series"]["month"]) == 120

    code, status = run(capsys, "status", "--model", root)
    assert code == 0 and status["tiles"] == {} and status["modules"] == {}
    assert status["counts"]["tiles"]["total"] == 0

    code, built = run(capsys, "build", "--model", root)
    assert code == 0 and [b["kind"] for b in built["built"]] == ["model"] and built["built"][0]["checks_pass"]

    code, status = run(capsys, "status", "--model", root)
    assert code == 0 and status["model"]["state"] == "built" and status["model"]["workbook_current"]


def test_the_fresh_models_own_tests_pass(tmp_path, capsys):
    target = tmp_path / "fresh"
    package = fresh_package()
    run(capsys, "init", "--model", str(target), "--name", "Fresh", "--package", package)
    result = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], cwd=target,
                            capture_output=True, text=True, env={**__import__("os").environ,
                                                                  "PYTHONPATH": str(target / "src")})
    assert result.returncode == 0, result.stdout + result.stderr
    assert "1 passed" in result.stdout


def test_init_writes_a_gitignore(tmp_path, capsys):
    main(["init", "--model", str(tmp_path / "m"), "--name", "Ignore me"])
    capsys.readouterr()
    lines = (tmp_path / "m" / ".gitignore").read_text().split()
    for want in (".venv/", "__pycache__/", "real-data/", "review/.cache/", "review/**/log.jsonl",
                 "review/model/chat.jsonl", "review/drafts/", "review/requests/"):
        assert want in lines
