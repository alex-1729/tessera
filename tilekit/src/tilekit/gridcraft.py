"""Find and drive GridCraft's headless command line (`gridcraft-cli`)."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from tilekit.errors import TilekitError

CLI_RELATIVE = Path("vendor/gridcraft/cli/gridcraft-cli")


def find_cli(start=None):
    """The gridcraft-cli path: $GRIDCRAFT_CLI, else vendor/gridcraft/cli/gridcraft-cli found walking up from `start`.

    Returns None when it cannot be found.
    """
    env = os.environ.get("GRIDCRAFT_CLI")
    if env:
        path = Path(env).expanduser()
        return path if path.is_file() else None
    here = Path(start or Path.cwd()).resolve()
    for folder in [here, *here.parents]:
        candidate = folder / CLI_RELATIVE
        if candidate.is_file():
            return candidate
    return None


def require_cli(start=None):
    cli = find_cli(start)
    if cli is None:
        env = os.environ.get("GRIDCRAFT_CLI")
        where = f"GRIDCRAFT_CLI={env} is not a file" if env else \
            f"set GRIDCRAFT_CLI or put it at {CLI_RELATIVE} in a folder above the model"
        raise TilekitError(f"gridcraft-cli not found ({where})", {"searched_from": str(start)})
    return cli


class GridCraft:
    """Runs scripts of GridCraft commands; each command is `{"command": id, "params": {...}}`."""

    def __init__(self, cli):
        self.cli = Path(cli)

    def _call(self, args, timeout=600):
        result = subprocess.run([str(self.cli), *args], capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            raise TilekitError("gridcraft-cli failed", {"args": args, "stderr": result.stderr.strip()[-4000:],
                                                       "stdout": result.stdout.strip()[-2000:]})
        return result.stdout

    def info(self, path):
        return json.loads(self._call(["info", str(path), "--json"]))

    def run(self, commands, out, source=None):
        """Run `commands` (on `source` if given, else a new workbook) and save to `out`.

        Returns the parsed result lines, one dict per command that printed a result.
        """
        with tempfile.TemporaryDirectory(prefix="tilekit-") as tmp:
            script = Path(tmp) / "script.jsonl"
            script.write_text("".join(json.dumps(c) + "\n" for c in commands))
            args = ["run", "--script", str(script), "--out", str(out)]
            if source is not None:
                args[1:1] = ["--in", str(source)]
            stdout = self._call(args)
        results = []
        for line in stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    results.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return results
