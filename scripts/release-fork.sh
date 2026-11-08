#!/usr/bin/env bash
# Builds this fork's Linux AppImage and publishes it as a GitHub release. Builds from this script
# read their update feed from that repository, so the installed app offers each new release.
set -euo pipefail

repo="${T3CODE_DESKTOP_UPDATE_REPOSITORY:-KLI31/t3code}"
cd "$(dirname "$0")/.."

# A "-mono.<UTC minute>" suffix stays on the stable feed and sorts after every earlier fork build.
base=$(node -p 'require("./apps/desktop/package.json").version')
version="${base}-mono.$(date -u +%Y%m%d%H%M)"
out="release/$version"

T3CODE_DESKTOP_UPDATE_REPOSITORY="$repo" node scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --build-version "$version" --output-dir "$out"

shopt -s nullglob
assets=("$out"/*.AppImage "$out"/*.blockmap "$out"/latest-linux.yml)
gh release create "v$version" --repo "$repo" --target "$(git rev-parse HEAD)" --latest \
  --title "v$version" --notes "Fork build of $(git rev-parse --short HEAD) on upstream $base." \
  "${assets[@]}"

echo "Published v$version to https://github.com/$repo/releases"
