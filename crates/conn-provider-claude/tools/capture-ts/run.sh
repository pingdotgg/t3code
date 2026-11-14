#!/usr/bin/env bash
# Regenerate testdata/ts/*.json with the TypeScript Claude adapter. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
repo="${CONN_MONOREPO:?set CONN_MONOREPO to a Conn monorepo checkout at conn.pin, after vp i}"
adapters="$repo/apps/server/src/orchestration-v2/Adapters"
# The copy's name carries this run's PID, so runs side by side on one checkout do not collide.
name="claudeCapture.$$.tmp.test.ts"
copy="$adapters/$name"

[ -d "$adapters" ] || { echo "CONN_MONOREPO=$repo has no apps/server Adapters directory" >&2; exit 1; }

export CAPTURE_CLI_DIR="${CAPTURE_CLI_DIR:-$crate/testdata/cli}"
export CAPTURE_OUT_DIR="${CAPTURE_OUT_DIR:-$crate/testdata/ts}"
mkdir -p "$CAPTURE_OUT_DIR"
CAPTURE_OUT_DIR="$(cd "$CAPTURE_OUT_DIR" && pwd)"
CAPTURE_CLI_DIR="$(cd "$CAPTURE_CLI_DIR" && pwd)"

trap 'rm -f "$copy"' EXIT
cp "$here/claudeCapture.test.ts" "$copy"
cd "$repo/apps/server"
node "$repo/node_modules/vite-plus/bin/vp" test run "src/orchestration-v2/Adapters/$name"
