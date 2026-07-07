#!/usr/bin/env bash
# Run before saying "Start android parity implementation".
# Requires scratch/android-parity/ on this machine (gitignored; not in remote).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> Android parity preflight"

python3 scripts/validate-plan.py scratch/android-parity/implementation.md

for f in scratch/android-parity/AGENT-LOOP.md scratch/android-parity/implementation.md \
  scratch/android-parity/loop-config.json scripts/android-parity/gate.sh; do
  test -f "$f" || { echo "missing $f" >&2; exit 1; }
done

if [[ ! -f scratch/android-parity/loop-state.json ]]; then
  cp scratch/android-parity/loop-state.template.json scratch/android-parity/loop-state.json
  echo "Created loop-state.json from template"
fi

if command -v gh >/dev/null 2>&1; then
  gh auth status >/dev/null 2>&1 && echo "gh: authenticated" || echo "gh: not authenticated (PR creation may fail)"
fi

echo "==> Preflight OK — ready to start at $(jq -r .current_step scratch/android-parity/loop-state.json 2>/dev/null || echo s01)"