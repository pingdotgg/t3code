#!/usr/bin/env bash
#
# Build the arm64 macOS Dev app directly and install it into /Applications,
# replacing any previous Dev installation. The default fast path skips DMG/ZIP
# creation; pass --dmg when validating the release artifact path.
#
# Usage:
#   scripts/install-t3-dev.sh              # build + install + launch Dev
#   scripts/install-t3-dev.sh --no-build   # reuse the existing unpacked Dev app
#   scripts/install-t3-dev.sh --no-launch  # skip the open at the end
#   scripts/install-t3-dev.sh --dmg        # build and install through a Dev DMG
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_FLAVOR="dev"
APP_NAME="T3 Code (Dev)"
ARTIFACT_GLOB="T3-Code-Dev-*-arm64.dmg"
APP_BUNDLE="${APP_NAME}.app"
INSTALL_DEST="/Applications/${APP_BUNDLE}"
RELEASE_DIR="${REPO_ROOT}/release"

DO_BUILD=1
DO_LAUNCH=1
USE_DMG=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --no-launch) DO_LAUNCH=0 ;;
    --dmg) USE_DMG=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "arm64" ]]; then
  echo "Warning: host arch is ${HOST_ARCH}; this script builds an arm64 DMG." >&2
fi

log() { printf '\n[install-t3-dev] %s\n' "$*"; }

log "Quitting any running ${APP_NAME} instance..."
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
# Wait only as long as needed for a clean exit, then force-kill stragglers.
for _ in {1..20}; do
  if ! pgrep -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
pkill -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1 || true

if [[ "$DO_BUILD" -eq 1 ]]; then
  if [[ "$USE_DMG" -eq 1 ]]; then
    log "Building ${APP_FLAVOR} arm64 DMG..."
    rm -f "${RELEASE_DIR}"/T3-Code-Dev-*-arm64.dmg \
          "${RELEASE_DIR}"/T3-Code-Dev-*-arm64.dmg.blockmap \
          "${RELEASE_DIR}"/T3-Code-Dev-*-arm64.zip \
          "${RELEASE_DIR}"/T3-Code-Dev-*-arm64.zip.blockmap
    ( cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --flavor "$APP_FLAVOR" )
  else
    log "Building unpacked ${APP_FLAVOR} arm64 app..."
    rm -rf "${RELEASE_DIR}/${APP_BUNDLE}"
    ( cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --flavor "$APP_FLAVOR" )
  fi
fi

MOUNT_POINT=""
cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -force -quiet || true
  fi
}
trap cleanup EXIT

if [[ "$USE_DMG" -eq 1 ]]; then
  DMG_PATH="$(ls -t "${RELEASE_DIR}"/${ARTIFACT_GLOB} 2>/dev/null | head -n 1 || true)"
  if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
    echo "No arm64 DMG found in ${RELEASE_DIR}." >&2
    echo "Re-run without --no-build to produce one." >&2
    exit 1
  fi
  log "Using DMG: ${DMG_PATH}"
  log "Mounting DMG..."
  ATTACH_OUTPUT="$(hdiutil attach -nobrowse -readonly -plist "$DMG_PATH")"
  MOUNT_POINT="$(printf '%s' "$ATTACH_OUTPUT" \
    | /usr/bin/awk '/<string>\/Volumes\//{ sub(/.*<string>/,""); sub(/<\/string>.*/,""); print; exit }')"
  if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
    echo "Failed to determine DMG mount point." >&2
    exit 1
  fi
  log "Mounted at: ${MOUNT_POINT}"
  SRC_APP="${MOUNT_POINT}/${APP_BUNDLE}"
else
  SRC_APP="${RELEASE_DIR}/${APP_BUNDLE}"
  log "Using unpacked app: ${SRC_APP}"
fi

if [[ ! -d "$SRC_APP" ]]; then
  echo "Source app not found at ${SRC_APP}." >&2
  ls -la "$MOUNT_POINT" >&2
  exit 1
fi

log "Replacing ${INSTALL_DEST}..."
rm -rf "$INSTALL_DEST"
ditto "$SRC_APP" "$INSTALL_DEST"

log "Clearing quarantine attributes..."
xattr -dr com.apple.quarantine "$INSTALL_DEST" 2>/dev/null || true

INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${INSTALL_DEST}/Contents/Info.plist" 2>/dev/null || echo 'unknown')"
log "Installed ${APP_NAME} v${INSTALLED_VERSION}"

if [[ "$DO_LAUNCH" -eq 1 ]]; then
  log "Launching..."
  open "$INSTALL_DEST"
fi

log "Done."
