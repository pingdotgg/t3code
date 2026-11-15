#!/usr/bin/env bash
# Regenerates src/model_catalog.json from the T3 server's bundled Claude model catalog.
#   ./run.sh [--check]
# --check writes to a temp file and exits 1 when src/model_catalog.json differs from it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
# The Conn monorepo root: the same tree, after `vp i` there.
repo="$(cd "$here/../../../../../.." && pwd)"
# The copy's name carries this run's PID, so runs side by side on one checkout do not collide.
name="claudeCatalogDump.$$.tmp.test.ts"
copy="$repo/apps/server/src/$name"
target="$crate/src/model_catalog.json"
out="$target"
scratch=""
if [ "${1:-}" = "--check" ]; then
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-claude-catalog.XXXXXX")"
  out="$scratch/model_catalog.json"
fi
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
trap 'rm -f "$copy"; rm -rf "$sealed_home"; [ -z "$scratch" ] || rm -rf "$scratch"' EXIT
cp "$here/claudeCatalogDump.test.ts" "$copy"
(cd "$repo/apps/server" && sealed CATALOG_OUT="$out" node "$repo/node_modules/vite-plus/bin/vp" test run "src/$name")
if [ -n "$scratch" ]; then
  if cmp -s "$out" "$target"; then
    echo "model_catalog.json is current"
  else
    echo "src/model_catalog.json is out of date: run tools/gen-catalog/run.sh" >&2
    exit 1
  fi
fi
