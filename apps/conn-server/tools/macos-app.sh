#!/bin/bash
# Wraps a macOS release folder (conn-server + sdk-host/) in a signed app bundle:
#
#   Conn Server.app/Contents/
#   ├── Info.plist          com.nckrtl.conn-server, LSUIElement (no Dock icon)
#   ├── MacOS/conn-server
#   └── Resources/          AppIcon.icns (Conn's macOS icon), sdk-host/
#
# Why: macOS privacy grants (Screen Recording, Files and Folders, ...) for a bare executable
# are keyed by its path, so each new install path asks again and shows no icon. The bundle
# gives the server a bundle id, a name and Conn's icon. Whether TCC then keys a launchd job's
# grants by bundle id, and keeps them across a rebuild, is not yet proven (DROP-IN.md).
# The server finds sdk-host/ in Contents/Resources (conn-provider-support, installed_helper).
# The launchd job that runs the bundle sets AssociatedBundleIdentifiers to the bundle id.
#
# Usage: tools/macos-app.sh --from <release folder> --out <dir> [--build <n[.n[.n]]>] [--commit <sha>]
#   --build   CFBundleVersion: one to three dot-separated integers (default: the server version)
#   --commit  the git commit the binary was built from, kept in ConnServerCommit
#   CONN_SIGN_IDENTITY  codesign identity (default: the Developer ID Application identity)
# Prints the bundle path. Install it at ONE fixed path and replace it in place on updates.
set -euo pipefail

BUNDLE_ID="com.nckrtl.conn-server"
NAME="Conn Server"
IDENTITY="${CONN_SIGN_IDENTITY:-Developer ID Application: Nick Retel (9SVJ4SYB9B)}"
here="$(cd "$(dirname "$0")/.." && pwd)"
icon_png="$here/../../assets/conn/prod/conn-prod-macos-1024.png"

fail() { echo "macos-app: $*" >&2; exit 1; }
from="" out="" build="" commit=""
while (($#)); do
  case "$1" in
    --from) from="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --build) build="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done
[[ -n "$from" && -n "$out" ]] || fail "usage: --from <release folder> --out <dir> [--build <n.n.n>] [--commit <sha>]"
[[ "$(uname -s)" == Darwin ]] || fail "builds on macOS only"
[[ -x "$from/conn-server" ]] || fail "no conn-server in $from"
[[ -f "$from/sdk-host/index.mjs" ]] || fail "no sdk-host/index.mjs in $from"
[[ -f "$icon_png" ]] || fail "no icon at $icon_png"

version="$("$from/conn-server" --version | awk '{print $2}')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "unexpected --version output: $version"
build="${build:-${version%%[-+]*}}"
# CFBundleVersion must parse as a build number (CFBundleGetVersionNumber), so no SHA in it.
[[ "$build" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "--build must be one to three dot-separated integers, not $build"
[[ -z "$commit" || "$commit" =~ ^[0-9a-f]{7,40}$ ]] || fail "--commit must be a hex git SHA, not $commit"

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
  <key>ConnServerCommit</key><string>$commit</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
plutil -lint "$app/Contents/Info.plist" >/dev/null
[[ -n "$commit" ]] || plutil -remove ConnServerCommit "$app/Contents/Info.plist"

# The regex above is only a first filter: Core Foundation decides. CFBundleGetVersionNumber
# returns 0 for a CFBundleVersion it cannot pack (e.g. 123456789.1.1 or 1.100.1).
packed="$(/usr/bin/python3 -I - "$app" <<'PY'
import ctypes, sys
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cf.CFURLCreateFromFileSystemRepresentation.restype = ctypes.c_void_p
cf.CFURLCreateFromFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_bool]
cf.CFBundleCreate.restype = ctypes.c_void_p
cf.CFBundleCreate.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
cf.CFBundleGetVersionNumber.restype = ctypes.c_uint32
cf.CFBundleGetVersionNumber.argtypes = [ctypes.c_void_p]
path = sys.argv[1].encode()
url = cf.CFURLCreateFromFileSystemRepresentation(None, path, len(path), True)
bundle = cf.CFBundleCreate(None, url) if url else None
if not bundle:
    sys.exit("CFBundleCreate failed")
print(cf.CFBundleGetVersionNumber(bundle))
PY
)" || fail "could not read the bundle version with Core Foundation"
[[ "$packed" =~ ^[0-9]+$ && "$packed" != 0 ]] \
  || fail "Core Foundation cannot parse CFBundleVersion $build (CFBundleGetVersionNumber returned ${packed:-nothing})"

# Signing the bundle signs its main executable with the bundle id and seals Resources.
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$app"
codesign --verify --deep --strict "$app"
id="$(codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p')"
[[ "$id" == "$BUNDLE_ID" ]] || fail "signed identifier is $id, not $BUNDLE_ID"

mkdir -p "$out"
rm -rf "${out:?}/$NAME.app"
ditto "$app" "$out/$NAME.app"
echo "$out/$NAME.app"
