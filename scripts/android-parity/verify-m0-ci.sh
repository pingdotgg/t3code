#!/usr/bin/env bash
# Automated M0 gate (step s09) — unblocks s10 when completion_mode=automated.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> M0 CI gate: contracts + relay + mobile registration tests"

vp check
vpr typecheck

vp test run packages/contracts
vp test run infra/relay

# Mobile agent-awareness tests (Android paths after s05-s06)
if [[ -d apps/mobile/src/features/agent-awareness ]]; then
  vp test run apps/mobile/src/features/agent-awareness
fi

echo "==> M0 CI gate PASS"
echo "Set loop-state.json gates.m0_staging=pass_ci to continue (automated completion_mode)"