#!/usr/bin/env bash
# Regenerates src/model_catalog.json from the T3 server's bundled Claude model catalog.
#   CONN_MONOREPO=/path/to/conn ./run.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
repo="${CONN_MONOREPO:-/Users/nckrtl/.t3/headless/worktrees/conn/conn-server-monorepo}"
copy="$repo/apps/server/src/claudeCatalogDump.test.ts"
[ ! -e "$copy" ] || { echo "$copy already exists; refusing to overwrite it" >&2; exit 1; }
trap 'rm -f "$copy"' EXIT
cp "$here/claudeCatalogDump.test.ts" "$copy"
cd "$repo/apps/server"
CATALOG_OUT="$crate/src/model_catalog.json" vp test run src/claudeCatalogDump.test.ts
