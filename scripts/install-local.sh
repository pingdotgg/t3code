#!/usr/bin/env bash
set -euo pipefail

# Build T3 Code desktop DMG and install it to /Applications.
#
# Usage:
#   ./scripts/install-local.sh            # build + install
#   ./scripts/install-local.sh --skip-build  # install from existing release/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$REPO_ROOT/release"
APP_NAME="T3 Code (Alpha).app"
INSTALL_DIR="/Applications"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Build ──────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building desktop DMG..."
  cd "$REPO_ROOT"
  bun run dist:desktop:dmg
fi

# ── Find DMG ───────────────────────────────────────────────────────
DMG_FILE=$(find "$RELEASE_DIR" -maxdepth 1 -name "*.dmg" -type f | sort -r | head -1)

if [ -z "$DMG_FILE" ]; then
  echo "ERROR: No .dmg file found in $RELEASE_DIR"
  exit 1
fi

echo "==> Found DMG: $(basename "$DMG_FILE")"

# ── Mount DMG ──────────────────────────────────────────────────────
MOUNT_POINT=$(hdiutil attach "$DMG_FILE" -nobrowse -noverify -noautoopen 2>/dev/null | grep "/Volumes/" | awk -F'\t' '{print $NF}')

if [ -z "$MOUNT_POINT" ]; then
  echo "ERROR: Failed to mount $DMG_FILE"
  exit 1
fi

echo "==> Mounted at: $MOUNT_POINT"

# ── Locate .app inside DMG ─────────────────────────────────────────
SOURCE_APP=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d | head -1)

if [ -z "$SOURCE_APP" ]; then
  echo "ERROR: No .app found inside DMG"
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  exit 1
fi

APP_BASENAME="$(basename "$SOURCE_APP")"
TARGET_APP="$INSTALL_DIR/$APP_BASENAME"

# ── Kill running instance ──────────────────────────────────────────
if pgrep -f "$APP_BASENAME" >/dev/null 2>&1; then
  echo "==> Closing running $APP_BASENAME..."
  pkill -f "$APP_BASENAME" 2>/dev/null || true
  sleep 1
fi

# ── Replace existing app ──────────────────────────────────────────
if [ -d "$TARGET_APP" ]; then
  echo "==> Removing existing $TARGET_APP..."
  rm -rf "$TARGET_APP"
fi

echo "==> Installing to $TARGET_APP..."
cp -R "$SOURCE_APP" "$TARGET_APP"

# ── Cleanup ────────────────────────────────────────────────────────
echo "==> Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true

echo "==> Done! $APP_BASENAME installed to $INSTALL_DIR"
