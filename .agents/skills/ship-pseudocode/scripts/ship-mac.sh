#!/usr/bin/env bash
# Signed, notarized, stapled macOS DMG for the PseudoCode fork, plus the darwin-arm64 t3 CLI
# archive and SHA256SUMS that SSH installs and `t3 update` download from the same release.
#
#   ship-mac.sh
#
# Needs a Developer ID Application identity in the login keychain and a notarytool keychain
# profile. See ../ROTATION.md to set both up. No secret is named on any command line.
set -euo pipefail

if [ "$#" -gt 0 ]; then
  echo "ship-mac.sh takes no arguments; the fork ships arm64 only." >&2
  exit 1
fi
ARCH=arm64
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

ROOT="$(repo_root)"
cd "$ROOT"
require_main_head
COMMIT="$(git rev-parse HEAD)"
setup_path "$ROOT"
load_env_local "$ROOT"
require_vars T3CODE_APP_NAME T3CODE_APP_ICON T3CODE_DESKTOP_UPDATE_REPOSITORY

PROFILE="${APPLE_KEYCHAIN_PROFILE:-pseudocode}"
export APPLE_KEYCHAIN_PROFILE="$PROFILE"

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "No Developer ID Application identity in the keychain. See ROTATION.md." >&2
  exit 1
fi

LOG="$(mktemp -t pseudocode-mac)"
echo "Building $T3CODE_APP_NAME for $ARCH. Log: $LOG"
vp run dist:desktop:artifact --platform mac --target dmg --arch "$ARCH" --signed --verbose \
  2>&1 | tee "$LOG"

if grep -q "skipped macOS notarization" "$LOG"; then
  echo >&2
  echo "Build finished but was NOT notarized: no notarytool profile named '$PROFILE'." >&2
  echo "Create it with the step 6 command in ROTATION.md, then re-run." >&2
  exit 1
fi

# electron-builder stamps artifacts with the *server* package version, so the
# tag and the filenames both come from that file or they disagree.
VERSION="$(node -p "require('./apps/server/package.json').version")"
TAG="pseudocode-v$VERSION"

# Name each artifact by version rather than picking the newest match: release/
# is not cleaned between runs and an older build's files are still sitting there.
DMG="release/$T3CODE_APP_NAME-$VERSION-$ARCH.dmg"
ZIP="release/$T3CODE_APP_NAME-$VERSION-$ARCH.zip"
MOUNT="$(mktemp -d)"
cleanup() { hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; }
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"

echo
echo "Verifying $(basename "$APP")"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl --assess --verbose=4 --type exec "$APP"

cleanup
trap - EXIT

# SSH installs and `t3 update` fetch SHA256SUMS and t3-<version>-<platform> from this release
# tag. Only darwin-arm64 builds on a Mac: Linux archives need a Linux host (ldd, dpkg,
# patchelf, libatomic) and Windows needs cargo-xwin, so those hosts get a clear "no archive"
# error instead of a download.
CLI_DIR=release/cli
CLI_ARCHIVE="$CLI_DIR/t3-$VERSION-darwin-arm64.tar.gz"
CLI_SUMS="$CLI_DIR/SHA256SUMS"
CLI_LOG="$(mktemp -t pseudocode-cli)"
RESOURCE_MONITOR_DIR="$(mktemp -d)"
mkdir -p "$RESOURCE_MONITOR_DIR/darwin-arm64"
cp native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor \
  "$RESOURCE_MONITOR_DIR/darwin-arm64/"

echo
echo "Building the t3 CLI archive. Log: $CLI_LOG"
node apps/server/scripts/cli.ts build-exe 2>&1 | tee "$CLI_LOG"
T3CODE_CLI_MAC_SIGN_IDENTITY="$(security find-identity -v -p codesigning |
  sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)" \
  node scripts/build-cli-archive.ts --platform mac --arch arm64 --version "$VERSION" \
  --resource-monitor-dir "$RESOURCE_MONITOR_DIR" --output-dir "$CLI_DIR" 2>&1 | tee -a "$CLI_LOG"
rm -rf "$RESOURCE_MONITOR_DIR"

# A bare executable cannot be stapled, so Apple's online ticket is the only proof; without it
# macOS kills t3 on first run on another machine.
if ! grep -q "Notarized t3" "$CLI_LOG"; then
  echo "The t3 CLI archive was NOT notarized. See $CLI_LOG." >&2
  exit 1
fi
node scripts/smoke-cli-archive.ts --archive "$CLI_ARCHIVE" --expect-version "$VERSION"
(cd "$CLI_DIR" && shasum -a 256 "$(basename "$CLI_ARCHIVE")" > SHA256SUMS)

# Publish after verification, never before: an unnotarized DMG on a release page
# is worse than no DMG, because macOS refuses to open it and the download looks
# like the product is broken.

# Publish to the same repo the shipped app polls, and name it explicitly: this
# worktree has an `upstream` remote and `gh` resolves to it by default.
REPO="$T3CODE_DESKTOP_UPDATE_REPOSITORY"

# "Check for updates" needs more than the DMG. electron-updater reads
# `latest-mac.yml` to learn the version, then downloads the zip, so a release
# holding only a DMG looks to the app like no release at all.
ASSETS=(release/latest-mac.yml "$DMG" "$DMG.blockmap" "$ZIP" "$ZIP.blockmap" "$CLI_ARCHIVE" "$CLI_SUMS")
for asset in "${ASSETS[@]}"; do
  if [ ! -f "$asset" ]; then
    echo "Missing update artifact: $asset" >&2
    echo "The build produced no update metadata, which means" >&2
    echo "T3CODE_DESKTOP_UPDATE_REPOSITORY was not set when electron-builder ran." >&2
    exit 1
  fi
done

# Deliberately not `v$VERSION`. The release workflow triggers on `v*.*.*` and
# cannot produce a usable artifact for this fork, so a tag in that shape starts
# a run that is guaranteed to fail. See the skill's CI section.
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Adding $VERSION $ARCH artifacts to $TAG"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
else
  # A draft, pinned to the built commit: going live is a separate, approved step, and the tag
  # GitHub creates on publish lands on the commit that produced these files.
  echo "Creating draft release $TAG"
  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$REPO" \
    --draft \
    --target "$COMMIT" \
    --title "PseudoCode $VERSION" \
    --notes "Desktop build and t3 CLI for macOS arm64. Signed and notarized."
fi

echo
echo "Shipped: $DMG"
echo "Draft: $(gh release view "$TAG" --repo "$REPO" --json url --jq .url)"
echo "Publish once approved: gh release edit $TAG --repo $REPO --draft=false --latest"
