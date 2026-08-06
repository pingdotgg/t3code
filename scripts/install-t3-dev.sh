#!/usr/bin/env bash
#
# Build the host-native macOS Dev app directly and install it into /Applications,
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
case "$HOST_ARCH" in
  arm64) BUILD_ARCH="arm64" ;;
  x86_64) BUILD_ARCH="x64" ;;
  *)
    echo "Unsupported macOS architecture: ${HOST_ARCH}" >&2
    exit 1
    ;;
esac
ARTIFACT_GLOB="T3-Code-Dev-*-${BUILD_ARCH}.dmg"
LOCK_PATH="${T3CODE_DEV_REBUILD_LOCK_PATH:-${HOME}/Library/Caches/t3code-dev/rebuild.lock}"
MOUNT_POINT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -force -quiet || true
  fi
  if [[ -L "$LOCK_PATH" && "$(readlink "$LOCK_PATH" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK_PATH"
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOCK_PATH")"
while ! ln -s "$$" "$LOCK_PATH" 2>/dev/null; do
  LOCK_PID="$(readlink "$LOCK_PATH" 2>/dev/null || true)"
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Another T3 Code Dev rebuild is already running (PID ${LOCK_PID})." >&2
    exit 1
  fi

  STALE_LOCK_PATH="${LOCK_PATH}.stale.$$.$RANDOM"
  if mv "$LOCK_PATH" "$STALE_LOCK_PATH" 2>/dev/null; then
    rm -f "$STALE_LOCK_PATH"
  fi
done

if [[ -n "${T3CODE_DEV_REBUILD_LOG_PATH:-}" ]]; then
  mkdir -p "$(dirname "$T3CODE_DEV_REBUILD_LOG_PATH")"
  : > "$T3CODE_DEV_REBUILD_LOG_PATH"
  exec > >(/usr/bin/awk -v path="$T3CODE_DEV_REBUILD_LOG_PATH" -v max_bytes=10485760 '
    BEGIN { written = 0; truncated = 0 }
    {
      line = $0 ORS
      if (written + length(line) <= max_bytes) {
        printf "%s", line >> path
        written += length(line)
      } else if (!truncated) {
        printf "\n[install-t3-dev] Log truncated after %d bytes.\n", max_bytes >> path
        truncated = 1
      }
    }
  ') 2>&1
fi

log() { printf '\n[install-t3-dev] %s\n' "$*"; }

if [[ "$DO_BUILD" -eq 1 ]]; then
  if [[ "$USE_DMG" -eq 1 ]]; then
    log "Building ${APP_FLAVOR} ${BUILD_ARCH} DMG..."
    rm -f "${RELEASE_DIR}"/T3-Code-Dev-*-"${BUILD_ARCH}".dmg \
      "${RELEASE_DIR}"/T3-Code-Dev-*-"${BUILD_ARCH}".dmg.blockmap \
      "${RELEASE_DIR}"/T3-Code-Dev-*-"${BUILD_ARCH}".zip \
      "${RELEASE_DIR}"/T3-Code-Dev-*-"${BUILD_ARCH}".zip.blockmap
    ( cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch "$BUILD_ARCH" --flavor "$APP_FLAVOR" )
  else
    log "Building unpacked ${APP_FLAVOR} ${BUILD_ARCH} app..."
    rm -rf "${RELEASE_DIR}/${APP_BUNDLE}"
    ( cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$BUILD_ARCH" --flavor "$APP_FLAVOR" )
  fi
fi

if [[ "$USE_DMG" -eq 1 ]]; then
  DMG_PATH="$(ls -t "${RELEASE_DIR}"/${ARTIFACT_GLOB} 2>/dev/null | head -n 1 || true)"
  if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
    echo "No ${BUILD_ARCH} DMG found in ${RELEASE_DIR}." >&2
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

log "Quitting any running ${APP_NAME} instance..."
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
for _ in {1..50}; do
  if ! pgrep -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if pgrep -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1; then
  echo "${APP_NAME} did not quit; close it and retry." >&2
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
