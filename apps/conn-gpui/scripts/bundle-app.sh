#!/usr/bin/env bash
# Wraps a built conn-app binary in a signed macOS .app bundle so it launches like a normal
# app (Dock icon, activation, keyboard focus, `conn://` URLs) and satisfies Vault's
# `--conn-bridge` caller signature check (`com.nckrtl.conn.dev` signed by team `9SVJ4SYB9B`,
# matching `apps/desktop/scripts/electron-launcher.mjs`).
#
#   scripts/bundle-app.sh [debug|release] [--install]
#
# With `--install`, installs the signed bundle to `/Applications/Conn GPUI.app` so sandboxed
# macOS apps like Vault (`Vault --conn-bridge`) can verify its code signature on disk.
# Override signing with `CONN_DEV_SIGNING_IDENTITY` (`-` forces ad-hoc signing).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-debug}"
INSTALL=0
if [[ "${2:-}" == "--install" || "${CONN_INSTALL_APPLICATIONS:-0}" == "1" ]]; then
  INSTALL=1
fi
BIN="$ROOT/target/$PROFILE/conn-app"
APP="$ROOT/target/$PROFILE/Conn GPUI.app"
TEAM_ID="${CONN_APPLE_TEAM_ID:-9SVJ4SYB9B}"

if [[ "$PROFILE" == "release" ]]; then
  BUNDLE_ID="${CONN_BUNDLE_ID:-com.nckrtl.conn}"
  URL_SCHEME="conn"
else
  BUNDLE_ID="${CONN_BUNDLE_ID:-com.nckrtl.conn.dev}"
  URL_SCHEME="conn-dev"
fi

[[ -x "$BIN" ]] || { echo "missing $BIN; build conn-app first" >&2; exit 1; }
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/conn-app"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>conn-app</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Conn GPUI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>${BUNDLE_ID}</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${URL_SCHEME}</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

pick_signing_identity() {
  if [[ -n "${CONN_DEV_SIGNING_IDENTITY:-}" ]]; then
    echo "$CONN_DEV_SIGNING_IDENTITY"
    return
  fi
  local hash
  hash="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -v team="(${TEAM_ID})" '/Developer ID Application:/ && index($0, team) { print $2; exit }')"
  if [[ -n "$hash" ]]; then
    echo "$hash"
  else
    echo "-"
  fi
}

IDENTITY="$(pick_signing_identity)"
# Sign without hardened runtime in debug so CEF's on-demand framework dlopen works cleanly,
# while still satisfying Vault's team + bundle-identifier code requirement.
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --timestamp=none "$APP/Contents/MacOS/conn-app"
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --timestamp=none "$APP"

if [[ "$INSTALL" == "1" ]]; then
  DEST="/Applications/Conn GPUI.app"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "$DEST"
else
  echo "$APP"
fi
