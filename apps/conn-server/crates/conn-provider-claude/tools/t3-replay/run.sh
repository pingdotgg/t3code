#!/usr/bin/env bash
# Replays the T3 server's own Claude transcripts against ClaudeSession (fake SDK host, no CLI,
# no model). See README.md.
#   ./run.sh [scenario...]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
# The Conn monorepo root: the same tree, after `vp i` there.
repo="$(cd "$here/../../../../../.." && pwd)"
fixtures="$repo/apps/server/src/orchestration-v2/testkit/fixtures"
[ -d "$fixtures" ] || { echo "no testkit fixtures under $repo" >&2; exit 1; }
out="$(mktemp -d "${TMPDIR:-/tmp}/conn-t3-replay.XXXXXX")"
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
trap 'rm -rf "$out" "$sealed_home"' EXIT
# Cargo reads ~/.gitconfig through HOME: it builds with a throwaway HOME of its own.
cargo_home="$sealed_home/cargo-home"
mkdir -p "$cargo_home"
cargo_env=(HOME="$cargo_home" CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)
binary="$(env "${cargo_env[@]}" CONN_CHECK_BINARIES="${CONN_CHECK_BINARIES:-}" node "$root/tools/check-binaries.mjs" conn-provider-claude t3_replay)"
# Each scenario's runtime policy, from T3's own fixture table (runs from $out: the monorepo
# gets no new file).
(cd "$out" && sealed node "$here/policies.mjs" "$repo") > "$out/policies.json"
sealed "$binary" "$fixtures" "$here/fake-host.mjs" "$here/scenarios.json" "$out/policies.json" "$out" "$@"
