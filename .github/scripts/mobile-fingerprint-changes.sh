#!/usr/bin/env bash
set -euo pipefail

base_sha=$(git rev-parse HEAD^1)
paths=$(git diff --no-renames --name-only "$base_sha" HEAD -- \
  apps/mobile/ packages/client-runtime/ packages/contracts/ packages/shared/ \
  assets/ scripts/ patches/ package.json pnpm-lock.yaml pnpm-workspace.yaml \
  .github/workflows/mobile-fingerprint-check.yml \
  .github/scripts/mobile-fingerprint-changes.sh)

echo "base_sha=$base_sha" >> "$GITHUB_OUTPUT"
if [[ -n "$paths" ]]; then
  echo "Native fingerprint inputs changed:"
  printf '%s\n' "$paths"
  echo "relevant=true" >> "$GITHUB_OUTPUT"
else
  echo "No native fingerprint inputs changed. Clearing any stale native change label."
  echo "relevant=false" >> "$GITHUB_OUTPUT"
  echo "No native fingerprint inputs changed; the PR is OTA-compatible." >> "$GITHUB_STEP_SUMMARY"
fi
