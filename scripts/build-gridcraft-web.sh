#!/bin/sh
# Builds GridCraft's web build from source with two patches (vendor-patches/): Open Sans embedded,
# and defined names coloured and outlined in formulas like cell references; installs it into
# vendor/gridcraft/web. The unpatched download from fetch-gridcraft.sh is kept once as
# vendor/gridcraft/web-prebuilt; to go back to it: rm -rf vendor/gridcraft/web &&
# mv vendor/gridcraft/web-prebuilt vendor/gridcraft/web.
#
# Needs: rustup's stable toolchain with the wasm32-unknown-unknown target and
# trunk 0.21.14 (cargo install trunk --version 0.21.14 --locked), in ~/.cargo/bin or on PATH.
# The first build takes 10-20 minutes; trunk fetches wasm-bindgen and wasm-opt itself.
set -eu
TAG="v0.19.1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor/gridcraft-src"
PATCHES="$ROOT/vendor-patches/gridcraft-$TAG-open-sans.patch $ROOT/vendor-patches/gridcraft-$TAG-name-highlight.patch"
FONTS="$ROOT/vendor-patches/fonts/open-sans"
DEST="$ROOT/vendor/gridcraft"
PATH="$HOME/.cargo/bin:$PATH"
export PATH

command -v trunk >/dev/null || { echo "error: trunk not found (cargo install trunk --version 0.21.14 --locked)" >&2; exit 1; }

# 1. Source at the pinned tag.
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/storytold/gridcraft.git "$SRC"
fi

# 2. The patches, in order (each skipped when already applied), and the fonts the first embeds.
for PATCH in $PATCHES; do
  if git -C "$SRC" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "already applied: $(basename "$PATCH")"
  else
    git -C "$SRC" apply "$PATCH"
  fi
done
mkdir -p "$SRC/crates/ui-egui/fonts-open-sans"
cp "$FONTS"/OpenSans-Regular.ttf "$FONTS"/OpenSans-Bold.ttf "$FONTS"/OpenSans-Italic.ttf \
   "$FONTS"/OpenSans-BoldItalic.ttf "$FONTS"/OFL.txt "$SRC/crates/ui-egui/fonts-open-sans/"

# 3. Build exactly as upstream's packaging/web/package.sh does.
rm -rf "$SRC/dist/web"
(cd "$SRC/apps/gridcraft-web" && trunk build --release --dist "$SRC/dist/web" --public-url ./)

# 4. Assemble the site with the files package.sh adds, plus the Open Sans licence and a note.
STAGE="$DEST/web-new"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$SRC/dist/web/." "$STAGE/"
cp "$SRC/packaging/web/_headers" "$SRC/packaging/web/.htaccess" "$STAGE/"
cp "$SRC/packaging/web/README.md" "$STAGE/HOSTING.md"
for f in README.md LICENSE LICENSE-MIT LICENSE-APACHE COPYRIGHT NOTICE ATTRIBUTION.md; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$STAGE/"; fi
done
cp "$FONTS/OFL.txt" "$STAGE/OFL.txt"
cat > "$STAGE/PATCHED.md" <<EOF
# Patched GridCraft web build

Built from storytold/gridcraft tag $TAG with two patches: one embeds Open Sans (Regular, Bold,
Italic, Bold Italic; SIL OFL 1.1, see OFL.txt) so cells set to "Open Sans" draw in it with real
bold and italic; the other colours defined names that refer to a cell or range in the formula
being edited and outlines their ranges on the grid, as cell references are. Everything else is
upstream $TAG. Rebuild with scripts/build-gridcraft-web.sh (patches in vendor-patches/). The unpatched release build is kept in ../web-prebuilt.
EOF

# 5. Install, keeping the unpatched release build once.
if [ -d "$DEST/web" ]; then
  if [ ! -d "$DEST/web-prebuilt" ] && [ ! -f "$DEST/web/PATCHED.md" ]; then
    mv "$DEST/web" "$DEST/web-prebuilt"
  else
    rm -rf "$DEST/web"
  fi
fi
mv "$STAGE" "$DEST/web"
echo "patched GridCraft web build installed in $DEST/web"
ls -l "$DEST"/web/*.wasm
