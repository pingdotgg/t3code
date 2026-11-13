#!/usr/bin/env bash
# Replays the T3 server's own Claude transcripts against ClaudeSession (fake SDK host, no CLI,
# no model). See README.md.
#   CONN_MONOREPO=/path/to/conn ./run.sh [scenario...]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
repo="${CONN_MONOREPO:?set CONN_MONOREPO to a Conn monorepo checkout at conn.pin, after vp i}"
fixtures="$repo/apps/server/src/orchestration-v2/testkit/fixtures"
[ -d "$fixtures" ] || { echo "no testkit fixtures under $repo" >&2; exit 1; }
out="$(mktemp -d "${TMPDIR:-/tmp}/conn-t3-replay.XXXXXX")"
trap 'rm -rf "$out"' EXIT
(cd "$root" && cargo build -q -p conn-provider-claude --example t3_replay)
"$root/target/debug/examples/t3_replay" "$fixtures" "$here/fake-host.mjs" "$here/scenarios.json" "$out" "$@"
