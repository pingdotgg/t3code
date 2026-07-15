#!/usr/bin/env bash
# Build SurgeCode.app without Xcode: SwiftPM binary + hand-assembled bundle.
# Usage: scripts/make-app.sh [--debug]
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="release"
if [[ "${1:-}" == "--debug" ]]; then
  CONFIG="debug"
fi

# Cross-module optimization lets the app target inline/specialize across
# T3Kit/SidecarKit (hot JSON decode + diff paths cross those boundaries).
# LTO was evaluated and rejected: flaky with CLT-only linking. If a beta-SDK
# compiler chokes on CMO, drop the flag — it is an optimization only.
SWIFT_FLAGS=()
if [[ "$CONFIG" == "release" ]]; then
  SWIFT_FLAGS+=(-Xswiftc -cross-module-optimization)
  # Skip dSYM generation: on some machines the post-link dsymutil step
  # deadlocks inside CFBundleCreate (stuck in _CFIterateDirectory ->
  # open$NOCANCEL with zero CPU progress), hanging the build forever.
  SWIFT_FLAGS+=(-debug-info-format none)
fi
# ${arr[@]+...} guard: bash 3.2 (macOS default) treats expanding an empty
# array as an unbound variable under `set -u`, which would break --debug.
swift build --package-path "$MAC_DIR" -c "$CONFIG" ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"}

BIN="$MAC_DIR/.build/$CONFIG/SergeCodeMac"
RESOURCE_BUNDLE="$MAC_DIR/.build/$CONFIG/SergeCodeMac_SergeCodeMac.bundle"
APP="$MAC_DIR/dist/SurgeCode.app"

ICON="$MAC_DIR/Support/AppIcon.icns"
if [[ "$CONFIG" == "debug" ]]; then
  ICON="$MAC_DIR/Support/AppIcon-Dev.icns"
fi

rm -rf "$APP" "$MAC_DIR/dist/SergeCode.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$MAC_DIR/Support/Info.plist" "$APP/Contents/Info.plist"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
cp "$BIN" "$APP/Contents/MacOS/SergeCodeMac"
cp -R "$RESOURCE_BUNDLE" "$APP/Contents/Resources/"

# Prefer a stable signing identity when present: TCC permissions (Documents
# -folder access for the node sidecar, and the macOS 15+ Local Network
# privacy grant used by desktop-to-desktop pairing) are keyed to the code
# identity, and an ad-hoc signature changes every rebuild — which both
# drops previously granted access and leaves the sidecar's file opens
# hanging in the TCC prompt path when launched via Finder/`open`. Create
# the dedicated identity once (see ARCHITECTURE.md "Build without Xcode")
# and every rebuild keeps its grants.
IDENTITY="SergeCode Dev Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  codesign --force -s "$IDENTITY" "$APP"
else
  # Fall back to any local "Apple Development:" identity — still stable
  # across rebuilds (unlike ad-hoc), so TCC grants (Local Network, etc.)
  # survive. Parsed dynamically: don't hardcode a specific developer's name
  # or team ID here, since any contributor's keychain may have one.
  DEV_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep '"Apple Development:' | head -n1 | sed -E 's/.*"(Apple Development:[^"]*)".*/\1/')"
  if [[ -n "$DEV_IDENTITY" ]]; then
    echo "note: '$IDENTITY' identity not found/trusted; using '$DEV_IDENTITY' instead" >&2
    codesign --force -s "$DEV_IDENTITY" "$APP"
  else
    echo "note: no '$IDENTITY' or 'Apple Development:' identity found/trusted; falling back to ad-hoc signing" >&2
    echo "      ad-hoc signatures change on every rebuild, so macOS revokes this app's Local Network" >&2
    echo "      permission after every rebuild — LAN pairing to/from this Mac will fail until you" >&2
    echo "      re-grant it in System Settings > Privacy & Security > Local Network. Same applies to" >&2
    echo "      the Documents-folder TCC grant used by the node sidecar. See ARCHITECTURE.md." >&2
    codesign --force -s - "$APP"
  fi
fi

echo "Built $APP"
