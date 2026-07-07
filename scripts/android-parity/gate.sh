#!/usr/bin/env bash
# Android parity per-PR gate — mirrors CI where practical.
# Usage: gate.sh [--quick]
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

QUICK=false
if [[ "${1:-}" == "--quick" ]]; then
  QUICK=true
fi

echo "==> vp check"
vp check

echo "==> vpr typecheck (CI parity)"
vpr typecheck

if $QUICK; then
  echo "==> quick gate OK"
  exit 0
fi

echo "==> vp run test"
vp run test

echo "==> vp run build:desktop (CI parity)"
vp run build:desktop

BASE="${ANDROID_PARITY_DIFF_BASE:-}"
if [[ -z "$BASE" ]]; then
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    BASE="origin/main"
  elif git rev-parse --verify main >/dev/null 2>&1; then
    BASE="main"
  else
    BASE="HEAD~1"
  fi
fi
CHANGED="$(git diff --name-only "$BASE"...HEAD 2>/dev/null || git diff --name-only HEAD~1...HEAD 2>/dev/null || true)"

if echo "$CHANGED" | grep -qE '^apps/mobile/'; then
  echo "==> mobile iOS regression (FORCE_* dogfood)"
  EXPO_PUBLIC_FORCE_JS_REVIEW=1 EXPO_PUBLIC_FORCE_NITRO_MARKDOWN=1 \
    vp test run apps/mobile
fi

if echo "$CHANGED" | grep -qE 'apps/mobile/modules/.*\.(kt|swift)'; then
  echo "==> vp run lint:mobile"
  vp run lint:mobile
fi

if echo "$CHANGED" | grep -qE '^apps/mobile/|app\.config|modules/'; then
  if [[ -d apps/mobile ]]; then
    echo "==> npx expo-doctor (apps/mobile)"
    (cd apps/mobile && npx expo-doctor)
  fi
fi

echo "==> gate OK"