#!/usr/bin/env bash
set -euo pipefail

# Build T3 Code desktop DMG and install it to /Applications.
#
# Usage:
#   ./scripts/install-local.sh            # build + install
#   ./scripts/install-local.sh --skip-build  # install from existing release/

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$REPO_ROOT/release"
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
  echo "==> Cleaning old release artifacts..."
  rm -rf "$RELEASE_DIR"

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

# ── Kill running instance ──────────────────────────────────────────
if pgrep -f "T3 Code" >/dev/null 2>&1; then
  echo "==> Closing running T3 Code..."
  pkill -f "T3 Code" 2>/dev/null || true
  sleep 2
fi

# ── Mount DMG ──────────────────────────────────────────────────────
echo "==> Mounting DMG..."
MOUNT_OUTPUT=$(hdiutil attach "$DMG_FILE" -nobrowse -noverify -noautoopen)
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep -o '/Volumes/.*' | head -1)

if [ -z "$MOUNT_POINT" ]; then
  echo "ERROR: Failed to mount $DMG_FILE"
  echo "hdiutil output: $MOUNT_OUTPUT"
  exit 1
fi

echo "==> Mounted at: $MOUNT_POINT"

# ── Locate .app inside DMG ─────────────────────────────────────────
SOURCE_APP=""
for entry in "$MOUNT_POINT"/*.app; do
  if [ -d "$entry" ]; then
    SOURCE_APP="$entry"
    break
  fi
done

if [ -z "$SOURCE_APP" ]; then
  echo "ERROR: No .app found inside DMG"
  echo "DMG contents:"
  ls -la "$MOUNT_POINT"
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  exit 1
fi

APP_BASENAME="$(basename "$SOURCE_APP")"
TARGET_APP="$INSTALL_DIR/$APP_BASENAME"

echo "==> Found app: $APP_BASENAME"

# ── Replace existing app ──────────────────────────────────────────
if [ -d "$TARGET_APP" ]; then
  echo "==> Removing existing $TARGET_APP..."
  rm -rf "$TARGET_APP"
fi

echo "==> Copying to $TARGET_APP..."
cp -R "$SOURCE_APP" "$TARGET_APP"

# ── Cleanup ────────────────────────────────────────────────────────
echo "==> Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true

echo "==> Done! $APP_BASENAME installed to $INSTALL_DIR"
