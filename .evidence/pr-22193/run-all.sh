#!/usr/bin/env bash
# Records rows on both builds in parallel: run-all.sh <before-worktree> <after-worktree> [outDir] [rows...]
set -u
here="$(cd "$(dirname "$0")" && pwd)"
before="$1"; after="$2"; out="${3:-/tmp/ev-22193}"; shift 3 || shift $#
rows=("${@:-R1a R1d R1e R2a R3a R1f R1b R1c R2b}")
for row in ${rows[@]}; do
  node "$here/run-row.mjs" "$row" before "$before" "$out" > "$out/$row-before.out" 2>&1 &
  b=$!
  node "$here/run-row.mjs" "$row" after "$after" "$out" > "$out/$row-after.out" 2>&1 &
  a=$!
  wait $b; echo "$row before exit=$?"
  wait $a; echo "$row after exit=$?"
done
