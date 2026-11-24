#!/usr/bin/env bash
# Build, sign, notarize, and publish HYR Code, the HYRMedia hardened build, for macOS arm64.
# Needs the HYRMedia Developer ID certificate in a keychain. Notarizes with an App Store
# Connect API key when APPLE_API_KEY_PATH, APPLE_API_KEY_ID, and APPLE_API_ISSUER are set,
# otherwise with the local asc login.
#
# Usage: release.sh [--version X.Y.Z] [--no-publish] [checkout]
#   checkout     HYR Code checkout to build (default: this repository)
#   --version    release version (default: the fork's latest release + 1 patch)
#   --no-publish build, sign, and notarize only; skip the tag and GitHub release
#
# hardened.patch is applied only while the build runs, and reverted on exit. It:
# - sets bundle ID com.hyrmedia.t3code.litellm, Electron profile t3code-hardened,
#   and data home ~/.t3-hyr, so the app never shares state with T3 Code or its Nightly
# - turns off telemetry (product events, identity file reads, relay traces),
#   T3 Connect (relay, tunnels), guest share links, and the model manifest
#   fetch from upstream. LAN and Tailscale access stay
#   available and are off until the user turns them on in Settings.
# Installed copies check github.com/$REPO releases for updates.
set -euo pipefail

REPO="HYRMedia-LLC/t3code"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT="$(cd "$TOOLS/../.." && pwd)"
OUT_ROOT="${T3_HARDENED_OUT:-$HOME/t3-fork-release/out}"
VERSION=""
PUBLISH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --no-publish) PUBLISH=0; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) CHECKOUT="$1"; shift ;;
  esac
done

cd "$CHECKOUT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "The checkout has uncommitted changes. Commit them first." >&2
  exit 1
fi
security find-identity -v -p codesigning | grep -q "Developer ID Application: HYRMedia" ||
  { echo "Developer ID Application certificate not found in the keychain." >&2; exit 1; }

LAST_TAG="$(gh release list -R "$REPO" --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName // ""')"
if [[ -z "$VERSION" ]]; then
  base="${LAST_TAG#v}"
  [[ -n "$base" ]] || base="$(node -p 'require("./apps/desktop/package.json").version')"
  IFS=. read -r major minor patch <<<"$base"
  VERSION="$major.$minor.$((patch + 1))"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  { echo "Version must be X.Y.Z (the updater compares plain versions): $VERSION" >&2; exit 1; }
TAG="v$VERSION"
COMMIT="$(git rev-parse HEAD)"
if [[ $PUBLISH -eq 1 ]] && gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists on $REPO." >&2
  exit 1
fi
echo "Building $TAG from $(git log --oneline -1)"

trap 'git checkout -- .' EXIT
git apply "$TOOLS/hardened.patch" ||
  { echo "hardened.patch no longer applies; upstream changed a patched file. Update the patch." >&2; exit 1; }
if [[ -e .env || -e .env.local ]]; then
  echo "Remove .env/.env.local first: the build would bake its values into the app." >&2
  exit 1
fi

export PATH="$CHECKOUT/node_modules/.bin:$PATH"
rm -rf release
# Cloud, relay, and telemetry settings must never reach the build.
env -u ELECTRON_RUN_AS_NODE -u GITHUB_REPOSITORY \
  -u T3CODE_CLERK_PUBLISHABLE_KEY -u T3CODE_CLERK_JWT_TEMPLATE -u T3CODE_CLERK_CLI_OAUTH_CLIENT_ID \
  -u T3CODE_RELAY_URL -u VITE_T3CODE_RELAY_URL -u T3CODE_POSTHOG_KEY -u T3CODE_POSTHOG_HOST \
  -u T3CODE_RELAY_CLIENT_OTLP_TRACES_URL -u T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET \
  -u T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN -u VITE_RELAY_OTLP_TRACES_URL \
  -u VITE_RELAY_OTLP_TRACES_DATASET -u VITE_RELAY_OTLP_TRACES_TOKEN \
  T3CODE_DESKTOP_UPDATE_REPOSITORY="$REPO" \
  vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version "$VERSION"
git checkout -- .
trap - EXIT

ZIP_NAME="HYR-Code-$VERSION-arm64.zip"
OUT="$OUT_ROOT/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT/app"
ditto -x -k "release/$ZIP_NAME" "$OUT/app"
APP="$(ls -d "$OUT"/app/*.app)"
[[ -f "$APP/Contents/Resources/app-update.yml" ]] ||
  { echo "The build has no update feed (app-update.yml)." >&2; exit 1; }
grep -q "owner: ${REPO%/*}" "$APP/Contents/Resources/app-update.yml" ||
  { echo "The update feed does not point at $REPO." >&2; exit 1; }

OSX_SIGN="$(ls -d "$CHECKOUT"/node_modules/.pnpm/@electron+osx-sign@2.*/node_modules/@electron/osx-sign | tail -1)"
node "$TOOLS/sign.mjs" "$OSX_SIGN" "$APP"
codesign --verify --deep --strict "$APP"

ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
  xcrun notarytool submit "$OUT/notarize.zip" --wait --output-format json \
    --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" |
    tee "$OUT/notarization.json"
else
  asc notarization submit --file "$OUT/notarize.zip" --wait --output json | tee "$OUT/notarization.json"
fi
grep -q '"status": *"Accepted"' "$OUT/notarization.json" ||
  { echo "Notarization was not accepted. See: xcrun notarytool log <id>" >&2; exit 1; }
rm "$OUT/notarize.zip"
xcrun stapler staple "$APP"
spctl -a -t exec "$APP"

# The updater checks this hash, so the manifest must describe the final, stapled zip.
ditto -c -k --keepParent "$APP" "$OUT/$ZIP_NAME"
sha512="$(openssl dgst -sha512 -binary "$OUT/$ZIP_NAME" | base64)"
size="$(stat -f %z "$OUT/$ZIP_NAME")"
cat >"$OUT/latest-mac.yml" <<EOF
version: $VERSION
files:
  - url: $ZIP_NAME
    sha512: $sha512
    size: $size
path: $ZIP_NAME
sha512: $sha512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF
cp "$TOOLS/hardened.patch" "$OUT/hardened.patch"
(cd "$OUT" && shasum -a 256 "$ZIP_NAME" latest-mac.yml hardened.patch >SHA256SUMS)

if [[ $PUBLISH -eq 0 ]]; then
  echo "Built $OUT/$ZIP_NAME (not published)."
  exit 0
fi

SHORT="$(git rev-parse --short "$COMMIT")"
cat >"$OUT/notes.md" <<EOF
Daily macOS arm64 release of the HYRMedia Hardened build, based on [$SHORT](https://github.com/$REPO/commit/$COMMIT), synced with upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

Telemetry, T3 Connect, relay tunnels, and guest links are disabled. Remote access is available only over LAN or Tailscale, and is off until you turn it on in Settings. The app uses the bundled model list and stores data in \`~/.t3-hyr\`.

The app is signed and notarized by HYRMedia, LLC. Install the arm64 ZIP, or use the app update feature. \`hardened.patch\` contains the build changes. \`SHA256SUMS\` covers the release assets.
${LAST_TAG:+
[Full source changes](https://github.com/$REPO/compare/$LAST_TAG...$TAG)}
EOF

git tag -a "$TAG" -m "HYR Code $VERSION" "$COMMIT"
git push origin "$TAG"
gh release create "$TAG" -R "$REPO" --verify-tag --latest \
  --title "HYR Code $VERSION" \
  --notes-file "$OUT/notes.md" \
  "$OUT/$ZIP_NAME" "$OUT/latest-mac.yml" "$OUT/hardened.patch" "$OUT/SHA256SUMS"
echo "Published https://github.com/$REPO/releases/tag/$TAG"
