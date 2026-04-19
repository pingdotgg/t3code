#!/usr/bin/env bash
# Build a Flatpak bundle for the T3 Code desktop app.
#
# Strategy:
#   1. Build the .deb using the upstream build script (electron-builder).
#   2. Extract the .deb into packaging/desktop/flatpak/app-content/ (gitignored).
#   3. Run flatpak-builder using packaging/desktop/flatpak/org.t3tools.T3Code.yml,
#      which copies the Electron app resources from app-content/ and uses the
#      Electron binary provided by org.electronjs.Electron2.BaseApp.
#   4. Export a single .flatpak bundle to OUTPUT_DIR.
#
# Environment variables:
#   ARCH            - App arch: x64 (default) or arm64
#   FLATPAK_ARCH    - Flatpak arch: x86_64 (default) or aarch64
#   OUTPUT_DIR      - Where to put the .flatpak bundle (default: <repo-root>/packaging-output)
#   VERSION         - Override app version string
#   SKIP_DEB_BUILD  - Set to 1 to reuse an existing .deb in OUTPUT_DIR
#
# Prerequisites:
#   bun, flatpak, flatpak-builder, org.freedesktop.Sdk//24.08,
#   org.electronjs.Electron2.BaseApp//24.08
#
#   Install runtimes:
#     flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
#     flatpak install flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08
#     flatpak install flathub org.electronjs.Electron2.BaseApp//24.08
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FLATPAK_DIR="$SCRIPT_DIR/flatpak"
APP_CONTENT_DIR="$FLATPAK_DIR/app-content"

ARCH="${ARCH:-x64}"
FLATPAK_ARCH="${FLATPAK_ARCH:-x86_64}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
VERSION="${VERSION:-}"
SKIP_DEB_BUILD="${SKIP_DEB_BUILD:-0}"

mkdir -p "$OUTPUT_DIR"

# ── Step 1: build .deb ───────────────────────────────────────────────────────
if [ "$SKIP_DEB_BUILD" = "1" ]; then
  echo "[packaging/desktop/flatpak] Skipping .deb build (SKIP_DEB_BUILD=1)"
else
  DEB_ARGS=(--platform linux --target deb --arch "$ARCH" --output-dir "$OUTPUT_DIR")
  if [ -n "$VERSION" ]; then
    DEB_ARGS+=(--build-version "$VERSION")
  fi
  echo "[packaging/desktop/flatpak] Building .deb..."
  cd "$REPO_ROOT"
  node scripts/build-desktop-artifact.ts "${DEB_ARGS[@]}"
fi

DEB_FILE=$(ls "$OUTPUT_DIR"/T3-Code-*.deb 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$DEB_FILE" ]; then
  echo "ERROR: No .deb found in $OUTPUT_DIR. Build it first or set SKIP_DEB_BUILD=0." >&2
  exit 1
fi
echo "[packaging/desktop/flatpak] Using: $DEB_FILE"

# ── Step 2: extract .deb into flatpak/app-content/ ───────────────────────────
echo "[packaging/desktop/flatpak] Extracting .deb..."
rm -rf "$APP_CONTENT_DIR"
mkdir -p "$APP_CONTENT_DIR"
dpkg-deb -x "$DEB_FILE" "$APP_CONTENT_DIR"

# Sanity check
if [ ! -d "$APP_CONTENT_DIR/usr/lib" ]; then
  echo "ERROR: Unexpected .deb layout — /usr/lib not found after extraction." >&2
  exit 1
fi

# ── Step 3: flatpak-builder ───────────────────────────────────────────────────
BUILD_DIR="$(mktemp -d --tmpdir t3code-flatpak-build.XXXXXXXX)"
REPO_DIR="$OUTPUT_DIR/flatpak-repo"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "[packaging/desktop/flatpak] Running flatpak-builder (arch=$FLATPAK_ARCH)..."
flatpak-builder \
  --arch="$FLATPAK_ARCH" \
  --repo="$REPO_DIR" \
  --force-clean \
  --disable-rofiles-fuse \
  "$BUILD_DIR" \
  "$FLATPAK_DIR/org.t3tools.T3Code.yml"

# ── Step 4: export single-file bundle ────────────────────────────────────────
BUNDLE="$OUTPUT_DIR/T3Code-${FLATPAK_ARCH}.flatpak"
echo "[packaging/desktop/flatpak] Exporting bundle → $BUNDLE"
flatpak build-bundle \
  --arch="$FLATPAK_ARCH" \
  "$REPO_DIR" \
  "$BUNDLE" \
  org.t3tools.T3Code

echo "[packaging/desktop/flatpak] Done: $BUNDLE"
