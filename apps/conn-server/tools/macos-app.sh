#!/bin/bash
# Wraps a macOS release folder (conn-server + sdk-host/) in a signed app bundle:
#
#   Conn Server.app/Contents/
#   ├── Info.plist          com.nckrtl.conn-server, LSUIElement (no Dock icon)
#   ├── MacOS/conn-server
#   └── Resources/          AppIcon.icns (Conn's macOS icon), sdk-host/
#
# Why: macOS privacy grants (Screen Recording, Files and Folders, ...) for a bare executable
# are keyed by its path, so each new install path asks again and shows no icon. A signed
# bundle is keyed by bundle id and team, so grants survive updates and show Conn's icon.
# The server finds sdk-host/ in ../Resources (conn-provider-support, installed_helper).
#
# Usage: tools/macos-app.sh --from <release folder> --out <dir> [--build <CFBundleVersion>]
#   CONN_SIGN_IDENTITY  codesign identity (default: the Developer ID Application identity)
# Prints the bundle path. Install it at ONE fixed path and replace it in place on updates.
set -euo pipefail

BUNDLE_ID="com.nckrtl.conn-server"
NAME="Conn Server"
IDENTITY="${CONN_SIGN_IDENTITY:-Developer ID Application: Nick Retel (9SVJ4SYB9B)}"
here="$(cd "$(dirname "$0")/.." && pwd)"
icon_png="$here/../../assets/conn/prod/conn-prod-macos-1024.png"

fail() { echo "macos-app: $*" >&2; exit 1; }
from="" out="" build=""
while (($#)); do
  case "$1" in
    --from) from="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --build) build="${2:?}"; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done
[[ -n "$from" && -n "$out" ]] || fail "usage: --from <release folder> --out <dir> [--build <version>]"
[[ "$(uname -s)" == Darwin ]] || fail "builds on macOS only"
[[ -x "$from/conn-server" ]] || fail "no conn-server in $from"
[[ -f "$from/sdk-host/index.mjs" ]] || fail "no sdk-host/index.mjs in $from"
[[ -f "$icon_png" ]] || fail "no icon at $icon_png"

version="$("$from/conn-server" --version | awk '{print $2}')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "unexpected --version output: $version"
build="${build:-$version}"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
app="$work/$NAME.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
ditto "$from/conn-server" "$app/Contents/MacOS/conn-server"
ditto "$from/sdk-host" "$app/Contents/Resources/sdk-host"

iconset="$work/AppIcon.iconset"; mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$icon_png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$icon_png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>conn-server</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$build</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist" >/dev/null

# Signing the bundle signs its main executable with the bundle id and seals Resources.
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$app"
codesign --verify --deep --strict "$app"
id="$(codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p')"
[[ "$id" == "$BUNDLE_ID" ]] || fail "signed identifier is $id, not $BUNDLE_ID"

mkdir -p "$out"
rm -rf "${out:?}/$NAME.app"
ditto "$app" "$out/$NAME.app"
echo "$out/$NAME.app"
