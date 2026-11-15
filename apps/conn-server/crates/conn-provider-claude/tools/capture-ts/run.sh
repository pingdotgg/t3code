#!/usr/bin/env bash
# Regenerate testdata/ts/*.json with the TypeScript Claude adapter. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
# The Conn monorepo root: the same tree, after `vp i` there.
repo="$(cd "$here/../../../../../.." && pwd)"
adapters="$repo/apps/server/src/orchestration-v2/Adapters"
# The copy's name carries this run's PID, so runs side by side on one checkout do not collide.
name="claudeCapture.$$.tmp.test.ts"
copy="$adapters/$name"

[ -d "$adapters" ] || { echo "$repo has no apps/server Adapters directory" >&2; exit 1; }

export CAPTURE_CLI_DIR="${CAPTURE_CLI_DIR:-$crate/testdata/cli}"
export CAPTURE_OUT_DIR="${CAPTURE_OUT_DIR:-$crate/testdata/ts}"
mkdir -p "$CAPTURE_OUT_DIR"
CAPTURE_OUT_DIR="$(cd "$CAPTURE_OUT_DIR" && pwd)"
CAPTURE_CLI_DIR="$(cd "$CAPTURE_CLI_DIR" && pwd)"

# Sealed: T3's code runs with a throwaway HOME and only what node needs from the shell, so it
# finds no real ~/.claude and no ANTHROPIC_*, CLAUDE_* or token variable.
sealed_home="$(mktemp -d "${TMPDIR:-/tmp}/conn-claude-sealed.XXXXXX")"
# Under the canary (tools/check.sh), its Node hook and logs pass the seal; nothing else does.
canary_env=()
if [ -n "${CONN_CANARY_ROOT:-}" ]; then
  canary_env=(NODE_OPTIONS="${NODE_OPTIONS:-}" CONN_CANARY_ROOT="$CONN_CANARY_ROOT"
    CONN_NETWORK_LOG="${CONN_NETWORK_LOG:-}" CONN_CANARY_NODE_NETWORK_LOG="${CONN_CANARY_NODE_NETWORK_LOG:-}")
fi
sealed() { env -i PATH="$PATH" HOME="$sealed_home" SHELL=/bin/sh TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C}" ${canary_env[@]+"${canary_env[@]}"} "$@"; }
trap 'rm -f "$copy"; rm -rf "$sealed_home"' EXIT
cp "$here/claudeCapture.test.ts" "$copy"
cd "$repo/apps/server"
sealed CAPTURE_CLI_DIR="$CAPTURE_CLI_DIR" CAPTURE_OUT_DIR="$CAPTURE_OUT_DIR" ${CAPTURE_LOG_DIR:+CAPTURE_LOG_DIR="$CAPTURE_LOG_DIR"} \
  node "$repo/node_modules/vite-plus/bin/vp" test run "src/orchestration-v2/Adapters/$name"
