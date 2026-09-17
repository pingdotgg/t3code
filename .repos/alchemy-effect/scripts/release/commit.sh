#!/usr/bin/env bash
set -euo pipefail

if [[ "$CHANNEL" == "tag" ]]; then
  echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
  exit 0
fi

tag="v${VERSION}"
git config user.email "alchemy-version-bot[bot]@users.noreply.github.com"
git config user.name "alchemy-version-bot[bot]"
bun scripts/release/release-notes.ts "$tag"
mapfile -t package_jsons < <(jq -r '.[] | "\(.dir)/package.json"' release-packages.json)
git add "${package_jsons[@]}" pnpm-lock.yaml CHANGELOG.md
if ! git diff --cached --quiet; then
  git commit -m "chore(release): ${VERSION}"
fi
if ! git rev-parse --verify "refs/tags/${tag}" >/dev/null 2>&1; then
  git tag -a "$tag" -m "Release ${tag}"
fi
git push origin HEAD
if ! git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
  git push origin "refs/tags/${tag}"
fi
echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
