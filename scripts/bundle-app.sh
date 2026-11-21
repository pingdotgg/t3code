#!/usr/bin/env bash
# Wraps a built conn-app binary in a minimal macOS .app bundle, so it launches like a normal
# app: Dock icon, activation when its window is clicked, keyboard focus. An unbundled binary
# started from a shell never becomes the active app on macOS.
#
#   scripts/bundle-app.sh [debug|release]     -> target/<profile>/Conn GPUI.app
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-debug}"
BIN="$ROOT/target/$PROFILE/conn-app"
APP="$ROOT/target/$PROFILE/Conn GPUI.app"
[[ -x "$BIN" ]] || { echo "missing $BIN; build conn-app first" >&2; exit 1; }
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/conn-app"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>conn-app</string>
  <key>CFBundleIdentifier</key><string>dev.conn.gpui</string>
  <key>CFBundleName</key><string>Conn GPUI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
echo "$APP"
