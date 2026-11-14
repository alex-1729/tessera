"""A signed-off tile's workbook is its regression test: the recorded values must still be what Python gives.

`review/tiles/<tile>/expected.json` is written at sign-off. Entries whose stamp is out of date are skipped
(the sign-off is stale); a current entry whose recorded values differ from Python fails.
"""

from pathlib import Path

import pytest

from tilekit.review import check_expected

MODEL_DIR = Path(__file__).resolve().parents[1]


def _signed_tiles():
    folder = MODEL_DIR / "review" / "tiles"
    return sorted(p.parent.name for p in folder.glob("*/expected.json")) if folder.is_dir() else []


@pytest.mark.parametrize("tile", _signed_tiles() or [None])
def test_signed_off_tile_values_unchanged(model, tile):
    if tile is None:
        return  # nothing signed off yet
    result = check_expected(model, tile, tolerance=1e-9)
    if result["status"] == "stale":
        pytest.skip("sign-off is stale")
    assert result["status"] == "ok", result["mismatches"]
