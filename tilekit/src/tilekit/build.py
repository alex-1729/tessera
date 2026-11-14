"""The `build` command: (re)build stored workbooks that are missing or stale."""

import json
import logging
import time
from pathlib import Path

from tilekit.cases import get_case, load_cases
from tilekit.errors import TilekitError
from tilekit.gridcraft import GridCraft, require_cli
from tilekit.stamps import model_stamp, module_stamp, tile_stamp
from tilekit.workbook import (CaseData, build_model, build_module, build_tile, content_digest, default_case_id,
                              file_stat, model_paths, module_paths, review_dir, tile_paths, write_json)

log = logging.getLogger("tilekit")


def stored_stamp(xlsx, sidecar):
    """The stamp in an existing sidecar, or None when the workbook or sidecar is missing."""
    if not xlsx.exists() or not sidecar.exists():
        return None
    try:
        return json.loads(sidecar.read_text()).get("stamp")
    except (json.JSONDecodeError, OSError):
        return None


def _cache_path(xlsx):
    """The digest cache of the review folder holding `xlsx` (or of the workbook's own folder elsewhere)."""
    for parent in xlsx.parents:
        if parent.name == "review":
            return parent / ".cache" / "content.json"
    return xlsx.parent / ".content-cache.json"


def content_current(xlsx, document):
    """True when the stored workbook's generated sheets are exactly what the build wrote.

    The sidecar records the content digest and the file's mtime and size at build time. When the file is
    unchanged on disk the answer is immediate; otherwise the digest is recomputed from the xlsx (cached by mtime
    and size in `review/.cache/content.json`). A sidecar without a digest counts as changed.
    """
    xlsx = Path(xlsx)
    want = (document or {}).get("content_digest")
    if not want or not xlsx.is_file():
        return False
    stat = file_stat(xlsx)
    if document.get("content_stat") == stat:
        return True
    cache_file = _cache_path(xlsx)
    key = str(xlsx.resolve())
    try:
        cache = json.loads(cache_file.read_text())
    except (OSError, json.JSONDecodeError):
        cache = {}
    hit = cache.get(key)
    if isinstance(hit, dict) and hit.get("stat") == stat:
        digest = hit.get("digest")
    else:
        try:
            digest = content_digest(xlsx)
        except Exception:  # an unreadable workbook is not current
            digest = None
        cache[key] = {"stat": stat, "digest": digest}
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            ignore = cache_file.parent / ".gitignore"
            if cache_file.parent.name == ".cache" and not ignore.exists():
                ignore.write_text("*\n")
            write_json(cache_file, cache)
        except OSError:
            pass
    return digest == want


def workbook_state(xlsx, sidecar):
    """(stored stamp or None, sidecar document or None, content current)."""
    stamp = stored_stamp(xlsx, sidecar)
    if stamp is None:
        return None, None, False
    try:
        document = json.loads(Path(sidecar).read_text())
    except (OSError, json.JSONDecodeError):
        return None, None, False
    return stamp, document, content_current(xlsx, document)


def build(model, tile=None, module=None, whole_model=False, case=None, force=False, gridcraft=None):
    """Build the requested workbooks (everything when no target is given), skipping up-to-date ones.

    `case` picks the case of the model workbook (default: the model's default case).
    Returns `{"built": [...], "skipped": [...]}`.
    """
    graph = model.graph
    model_case = case or default_case_id(model)
    get_case(model, model_case)  # raises for an unknown case
    everything = not (tile or module or whole_model)

    targets = []  # (kind, name, paths, stamp)
    if tile:
        if tile not in graph.tiles:
            raise TilekitError(f"Unknown tile '{tile}'", {"tiles": list(graph.order)})
        if graph.tiles[tile].doc.not_built:
            raise TilekitError(f"Tile '{tile}' is marked `Status: not built`; it has no workbook until it is built")
        targets.append(("tile", tile, tile_paths(model, tile), lambda t=tile: tile_stamp(model, t)))
    if module:
        model.config.module(module)
        targets.append(("module", module, module_paths(model, module), lambda m=module: module_stamp(model, m)))
    if everything:
        for name in graph.order:
            if graph.tiles[name].doc.not_built:
                continue  # a spec without an implementation: no workbook until it is built
            targets.append(("tile", name, tile_paths(model, name), lambda t=name: tile_stamp(model, t)))
        for item in model.config.modules:
            if graph.modules[item.id].tiles:
                targets.append(("module", item.id, module_paths(model, item.id),
                                lambda m=item.id: module_stamp(model, m)))
    if everything or whole_model:
        targets.append(("model", model_case, model_paths(model, model_case), lambda: model_stamp(model, model_case)))

    todo, skipped = [], []
    for kind, name, (xlsx, sidecar), make_stamp in targets:
        stamp = make_stamp()
        stored, _, content_ok = workbook_state(xlsx, sidecar)
        if not force and stored == stamp and content_ok:
            skipped.append({"kind": kind, "name": name if kind != "model" else model.config.name,
                            **({"case": name} if kind == "model" else {}),
                            "workbook": _relative(model, xlsx), "reason": "up to date"})
        else:
            todo.append((kind, name, xlsx, stamp))

    built = []
    if todo:
        gridcraft = gridcraft or GridCraft(require_cli(model.root))
        datas = {}

        def data_for(case_id):
            if case_id not in datas:
                datas[case_id] = CaseData(model, get_case(model, case_id))
            return datas[case_id]

        all_cases = [c.id for c in load_cases(model)]
        if not all_cases:
            raise TilekitError("The model has no cases; add one to cases/")
        for kind, name, xlsx, stamp in todo:
            started = time.monotonic()
            log.info("building %s %s", kind, name)
            if kind == "tile":
                document = build_tile(model, gridcraft, name, [data_for(c) for c in all_cases], stamp)
            elif kind == "module":
                document = build_module(model, gridcraft, name, [data_for(c) for c in all_cases], stamp)
            else:
                document = build_model(model, gridcraft, data_for(name), stamp)
            built.append({
                "kind": kind,
                "name": name if kind != "model" else model.config.name,
                **({"case": name} if kind == "model" else {}),
                "workbook": _relative(model, xlsx),
                "checks_pass": document["checks_pass"],
                "max_abs_difference": document["max_abs_difference"],
                "seconds": round(time.monotonic() - started, 3),
            })
    return {"built": built, "skipped": skipped}


def _relative(model, path):
    try:
        return path.relative_to(model.root).as_posix()
    except ValueError:
        return str(path)
