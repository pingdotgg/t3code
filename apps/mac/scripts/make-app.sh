#!/usr/bin/env bash
# Build SurgeCode.app without Xcode: SwiftPM binary + hand-assembled bundle.
# Usage: scripts/make-app.sh [--debug]
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="release"
if [[ "${1:-}" == "--debug" ]]; then
  CONFIG="debug"
fi

swift build --package-path "$MAC_DIR" -c "$CONFIG"

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

# Prefer the stable self-signed identity when present: TCC permissions
# (Documents-folder access for the node sidecar) are keyed to the code
# identity, and an ad-hoc signature changes every rebuild — which both
# drops previously granted access and leaves the sidecar's file opens
# hanging in the TCC prompt path when launched via Finder/`open`. Create
# the identity once (see ARCHITECTURE.md "Build without Xcode") and every
# rebuild keeps its grant.
IDENTITY="SergeCode Dev Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  codesign --force -s "$IDENTITY" "$APP"
else
  echo "note: '$IDENTITY' identity not found/trusted; falling back to ad-hoc signing" >&2
  echo "      (TCC grants reset on every rebuild — see ARCHITECTURE.md)" >&2
  codesign --force -s - "$APP"
fi

echo "Built $APP"
