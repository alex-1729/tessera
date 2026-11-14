#!/bin/sh
# Downloads the pinned GridCraft release (CLI and web build) into vendor/gridcraft
# and verifies it against the release's SHA256SUMS.txt.
# The web build downloaded here is the unpatched upstream one (cells in Ubuntu-Light, no bold or
# italic); scripts/build-gridcraft-web.sh replaces it with the Open Sans build from vendor-patches/.
set -eu
VERSION="${GRIDCRAFT_VERSION:-0.19.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/gridcraft"
BASE="https://github.com/storytold/gridcraft/releases/download/v$VERSION"
CLI="gridcraft-cli-$VERSION-macos-universal.zip"
WEB="gridcraft-web-$VERSION.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
for f in "$CLI" "$WEB" SHA256SUMS.txt; do curl -fsSLO "$BASE/$f"; done
grep -E " ($CLI|$WEB)\$" SHA256SUMS.txt | shasum -a 256 -c -
unzip -oq "$CLI" && unzip -oq "$WEB"
rm -rf "$DEST" && mkdir -p "$DEST"
mv "gridcraft-cli-$VERSION-macos-universal" "$DEST/cli"
mv "gridcraft-web-$VERSION" "$DEST/web"
cp SHA256SUMS.txt "$DEST/"
echo "$VERSION" > "$DEST/VERSION"
echo "GridCraft $VERSION installed in $DEST"
