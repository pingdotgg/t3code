#!/usr/bin/env bash
# Build SergeCode.app without Xcode: SwiftPM binary + hand-assembled bundle.
# Usage: scripts/make-app.sh [--debug]
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="release"
if [[ "${1:-}" == "--debug" ]]; then
  CONFIG="debug"
fi

swift build --package-path "$MAC_DIR" -c "$CONFIG"

BIN="$MAC_DIR/.build/$CONFIG/SergeCodeMac"
APP="$MAC_DIR/dist/SergeCode.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$MAC_DIR/Support/Info.plist" "$APP/Contents/Info.plist"
cp "$BIN" "$APP/Contents/MacOS/SergeCodeMac"

# Ad-hoc sign so the app launches under Gatekeeper locally.
codesign --force -s - "$APP"

echo "Built $APP"
