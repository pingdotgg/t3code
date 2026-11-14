#!/usr/bin/env bash
# Regenerates src/model_catalog.json from the T3 server's bundled Claude model catalog.
#   CONN_MONOREPO=/path/to/conn ./run.sh [--check]
# --check writes to a temp file and exits 1 when src/model_catalog.json differs from it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
repo="${CONN_MONOREPO:?set CONN_MONOREPO to a Conn monorepo checkout at conn.pin, after vp i}"
copy="$repo/apps/server/src/claudeCatalogDump.test.ts"
target="$crate/src/model_catalog.json"
out="$target"
scratch=""
if [ "${1:-}" = "--check" ]; then
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-claude-catalog.XXXXXX")"
  out="$scratch/model_catalog.json"
fi
[ ! -e "$copy" ] || { echo "$copy already exists; refusing to overwrite it" >&2; exit 1; }
trap 'rm -f "$copy"; [ -z "$scratch" ] || rm -rf "$scratch"' EXIT
cp "$here/claudeCatalogDump.test.ts" "$copy"
(cd "$repo/apps/server" && CATALOG_OUT="$out" node "$repo/node_modules/vite-plus/bin/vp" test run src/claudeCatalogDump.test.ts)
if [ -n "$scratch" ]; then
  if cmp -s "$out" "$target"; then
    echo "model_catalog.json is current"
  else
    echo "src/model_catalog.json is out of date: run tools/gen-catalog/run.sh" >&2
    exit 1
  fi
fi
