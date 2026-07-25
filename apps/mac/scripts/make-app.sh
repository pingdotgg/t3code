#!/usr/bin/env bash
# Build SurgeCode.app without Xcode: SwiftPM binary + hand-assembled bundle.
# Usage: scripts/make-app.sh [--debug]
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Sync version from version.json to Info.plist before building
"$MAC_DIR/scripts/sync-version.sh"

CONFIG="release"
if [[ "${1:-}" == "--debug" ]]; then
  CONFIG="debug"
fi

# CMO was dropped after the Swift 6.2 toolchain on the CI runner (CLT 26.x)
# failed the merged release build with `<unknown>:0: error: circular
# reference` — a compiler bug the flag's own escape hatch anticipated; it is
# an optimization only. Local Swift 6.4 builds the same sources fine with
# CMO, so re-enable once CI ships a Swift >= 6.4 toolchain.
# LTO was evaluated and rejected: flaky with CLT-only linking.
SWIFT_FLAGS=()
if [[ "$CONFIG" == "release" ]]; then
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

SPARKLE_FRAMEWORK=""
PRODUCT_CONFIG="Release"
if [[ "$CONFIG" == "debug" ]]; then
  PRODUCT_CONFIG="Debug"
fi
for candidate in \
  "$MAC_DIR/.build/out/Products/$PRODUCT_CONFIG/Sparkle.framework" \
  "$MAC_DIR/.build/$CONFIG/Sparkle.framework"; do
  if [[ -d "$candidate" ]]; then
    SPARKLE_FRAMEWORK="$candidate"
    break
  fi
done

if [[ -z "$SPARKLE_FRAMEWORK" ]]; then
  echo "error: Sparkle.framework was not produced by SwiftPM" >&2
  exit 1
fi

rm -rf "$APP" "$MAC_DIR/dist/SergeCode.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$MAC_DIR/Support/Info.plist" "$APP/Contents/Info.plist"
cp "$MAC_DIR/Support/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$BIN" "$APP/Contents/MacOS/SergeCodeMac"
# Bundle.appResources (Support/Bundle+AppResources.swift) resolves the
# resource bundle via Bundle.main.resourceURL — it must stay directly under
# Contents/Resources. Do not move it; the toolchain-generated Bundle.module
# search paths are not honored anywhere in the app.
cp -R "$RESOURCE_BUNDLE" "$APP/Contents/Resources/"
cp -R "$SPARKLE_FRAMEWORK" "$APP/Contents/Frameworks/"

# SwiftPM leaves the executable's existing @loader_path rpath intact. Add the
# conventional app-bundle framework location so @rpath/Sparkle.framework/...
# resolves after Sparkle is embedded in Contents/Frameworks.
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/SergeCodeMac"

# Embed the standalone sidecar (Node runtime + built server bundle with its
# production node_modules) when a staging directory is present. Release builds
# assemble it via scripts/stage-sidecar.sh; SidecarKit prefers these bundled
# resources at runtime and only falls back to dev-checkout resolution
# (system node + apps/server/dist) when they are absent — which is the case
# for local dev builds that never run stage-sidecar.sh.
SIDECAR_STAGING="${SERGE_CODE_SIDECAR_STAGING:-$MAC_DIR/dist/sidecar}"
if [[ -x "$SIDECAR_STAGING/SergeCodeNode/node" && -f "$SIDECAR_STAGING/SergeCodeServer/bin.mjs" ]]; then
  echo "Embedding standalone sidecar from $SIDECAR_STAGING"
  mkdir -p "$APP/Contents/Resources/SergeCodeNode"
  cp "$SIDECAR_STAGING/SergeCodeNode/node" "$APP/Contents/Resources/SergeCodeNode/node"
  chmod +x "$APP/Contents/Resources/SergeCodeNode/node"
  cp -R "$SIDECAR_STAGING/SergeCodeServer" "$APP/Contents/Resources/"
elif [[ -e "$SIDECAR_STAGING/SergeCodeNode/node" || -e "$SIDECAR_STAGING/SergeCodeServer" ]]; then
  echo "error: incomplete sidecar staging at $SIDECAR_STAGING" >&2
  echo "       expected both SergeCodeNode/node (executable) and SergeCodeServer/bin.mjs;" >&2
  echo "       re-run scripts/stage-sidecar.sh or remove the staging directory" >&2
  exit 1
else
  echo "note: no staged sidecar at $SIDECAR_STAGING; building without the embedded Node/server" >&2
fi

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
  codesign --force --deep -s "$IDENTITY" "$APP"
else
  # Fall back to any local "Apple Development:" identity — still stable
  # across rebuilds (unlike ad-hoc), so TCC grants (Local Network, etc.)
  # survive. Parsed dynamically: don't hardcode a specific developer's name
  # or team ID here, since any contributor's keychain may have one.
  DEV_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep '"Apple Development:' | head -n1 | sed -E 's/.*"(Apple Development:[^"]*)".*/\1/' || true)"
  if [[ -n "$DEV_IDENTITY" ]]; then
    echo "note: '$IDENTITY' identity not found/trusted; using '$DEV_IDENTITY' instead" >&2
    codesign --force --deep -s "$DEV_IDENTITY" "$APP"
  else
    echo "note: no '$IDENTITY' or 'Apple Development:' identity found/trusted; falling back to ad-hoc signing" >&2
    echo "      ad-hoc signatures change on every rebuild, so macOS revokes this app's Local Network" >&2
    echo "      permission after every rebuild — LAN pairing to/from this Mac will fail until you" >&2
    echo "      re-grant it in System Settings > Privacy & Security > Local Network. Same applies to" >&2
    echo "      the Documents-folder TCC grant used by the node sidecar. See ARCHITECTURE.md." >&2
    codesign --force --deep -s - "$APP"
  fi
fi

echo "Built $APP"
