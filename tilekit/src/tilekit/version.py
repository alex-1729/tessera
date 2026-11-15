"""The tooling's version, and where a model in its own repository fetches the tooling from.

A model pins the tooling to a tag of this repository in its `pyproject.toml`, so its sign-offs are tied to a known
version of the translator and checks, and upgrading is a visible change in the model repo.
"""

import os
import tomllib
from pathlib import Path

VERSION = "0.2.0"  # keep equal to `version` in tilekit/pyproject.toml (a test checks this)
TAG_PREFIX = "tilekit-v"
REPO = "https://github.com/alex-1729/tessera"
SUBDIRECTORY = "tilekit"


def tag(version=VERSION):
    return TAG_PREFIX + version


def repo():
    """The repository a new model fetches the tooling from; `TILEKIT_TOOLING_REPO` overrides the default."""
    return os.environ.get("TILEKIT_TOOLING_REPO") or REPO


def git_source():
    """The `[tool.uv.sources]` entry that pins a model to this version."""
    return {"git": repo(), "tag": tag(), "subdirectory": SUBDIRECTORY}


def tooling_info(model_dir):
    """How the model at `model_dir` gets the tooling, compared with the version that is running.

    `source` is `git` (pinned to a tag, branch or commit of a repository), `path` (a folder on this machine),
    `other` (declared some other way) or `none` (no pyproject.toml, or no tilekit source in it). `pinned` is the
    version when the model names one of this tooling's version tags, else None. `match` is true when the pinned
    version is the running one, and for `path` and `none`, where there is nothing to disagree with.
    """
    info = {"running": VERSION, "source": "none", "pinned": None, "ref": None, "match": True}
    pyproject = Path(model_dir) / "pyproject.toml"
    try:
        source = tomllib.loads(pyproject.read_text())["tool"]["uv"]["sources"]["tilekit"]
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError):
        return info
    if not isinstance(source, dict):
        return {**info, "source": "other"}
    if "path" in source:
        return {**info, "source": "path", "ref": str(source["path"])}
    if "git" in source:
        ref = source.get("tag") or source.get("rev") or source.get("branch")
        pinned = ref[len(TAG_PREFIX):] if isinstance(ref, str) and ref.startswith(TAG_PREFIX) else None
        return {**info, "source": "git", "ref": ref, "pinned": pinned, "match": pinned == VERSION}
    return {**info, "source": "other"}
