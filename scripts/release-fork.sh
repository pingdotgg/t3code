#!/usr/bin/env bash
# Builds this fork's Linux AppImage and publishes it as a GitHub release. Builds from this script
# read their update feed from that repository, so the installed app offers each new release.
#
# Usage: scripts/release-fork.sh [patch|minor|major|X.Y.Z]   (default: patch)
# The fork keeps its own semver in ./fork-version, apart from upstream's package versions, so
# upstream merges never conflict with it and every release sorts after the last one.
set -euo pipefail

repo="${T3CODE_DESKTOP_UPDATE_REPOSITORY:-KLI31/t3code}"
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty; commit or stash first." >&2
  exit 1
fi

current=$(cat fork-version)
IFS=. read -r major minor patch <<<"$current"
case "${1:-patch}" in
  patch) version="$major.$minor.$((patch + 1))" ;;
  minor) version="$major.$((minor + 1)).0" ;;
  major) version="$((major + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) version="$1" ;;
  *) echo "Unknown bump: $1" >&2; exit 1 ;;
esac

if gh release view "v$version" --repo "$repo" >/dev/null 2>&1; then
  echo "v$version is already released." >&2
  exit 1
fi

upstream=$(node -p 'require("./apps/desktop/package.json").version')
out="release/$version"

T3CODE_DESKTOP_UPDATE_REPOSITORY="$repo" node scripts/build-desktop-artifact.ts \
  --platform linux --target AppImage --arch x64 \
  --build-version "$version" --output-dir "$out"

echo "$version" >fork-version
git commit -q -m "chore(release): v$version" fork-version
git push -q origin HEAD

shopt -s nullglob
assets=("$out"/*.AppImage "$out"/*.blockmap "$out"/latest-linux.yml)
gh release create "v$version" --repo "$repo" --target "$(git rev-parse HEAD)" --latest \
  --title "v$version" --notes "Fork build of $(git rev-parse --short HEAD) on upstream $upstream." \
  "${assets[@]}"

echo "Published v$version to https://github.com/$repo/releases"
