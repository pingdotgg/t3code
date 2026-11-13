#!/usr/bin/env bash
# Regenerate testdata/ts/*.json with the TypeScript Claude adapter. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
repo="${CONN_MONOREPO:-/Users/nckrtl/apps/conn}"
adapters="$repo/apps/server/src/orchestration-v2/Adapters"
copy="$adapters/claudeCapture.test.ts"

[ -d "$adapters" ] || { echo "CONN_MONOREPO=$repo has no apps/server Adapters directory" >&2; exit 1; }
[ ! -e "$copy" ] || { echo "$copy already exists; refusing to overwrite it" >&2; exit 1; }

export CAPTURE_CLI_DIR="${CAPTURE_CLI_DIR:-$crate/testdata/cli}"
export CAPTURE_OUT_DIR="${CAPTURE_OUT_DIR:-$crate/testdata/ts}"
mkdir -p "$CAPTURE_OUT_DIR"
CAPTURE_OUT_DIR="$(cd "$CAPTURE_OUT_DIR" && pwd)"
CAPTURE_CLI_DIR="$(cd "$CAPTURE_CLI_DIR" && pwd)"

trap 'rm -f "$copy"' EXIT
cp "$here/claudeCapture.test.ts" "$copy"
cd "$repo/apps/server"
vp test run src/orchestration-v2/Adapters/claudeCapture.test.ts
