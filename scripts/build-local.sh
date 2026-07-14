#!/usr/bin/env bash
# Build the local backend sidecar and native macOS app bundle from this checkout.
#
# Usage:
#   scripts/build-local.sh [--debug|--release]
#
# Outputs:
#   apps/server/dist/bin.mjs
#   apps/mac/dist/SurgeCode.app
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FLAG=()
case "${1:-}" in
  "") ;;
  --debug)
    CONFIG_FLAG=(--debug)
    ;;
  --release)
    ;;
  -h|--help)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "error: unknown argument: $1" >&2
    echo "usage: scripts/build-local.sh [--debug|--release]" >&2
    exit 64
    ;;
esac

run_vp() {
  if command -v vp >/dev/null 2>&1; then
    vp "$@"
    return
  fi
  if command -v pnpm >/dev/null 2>&1; then
    pnpm exec vp "$@"
    return
  fi
  echo "error: could not find 'vp' or 'pnpm' on PATH" >&2
  echo "Install dependencies first (for example: pnpm install), then retry." >&2
  exit 127
}

if [[ ! -f package.json || ! -d apps/server || ! -d apps/mac ]]; then
  echo "error: scripts/build-local.sh must be run from a SergeCode checkout" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "error: node_modules is missing. Run 'pnpm install' (or 'vp install') first." >&2
  exit 1
fi

echo "==> Building backend sidecar"
run_vp run build:server

BACKEND_ENTRY="$ROOT_DIR/apps/server/dist/bin.mjs"
if [[ ! -f "$BACKEND_ENTRY" ]]; then
  echo "error: backend build did not produce $BACKEND_ENTRY" >&2
  exit 1
fi

echo "==> Building native macOS app bundle"
"$ROOT_DIR/apps/mac/scripts/make-app.sh" ${CONFIG_FLAG[@]+"${CONFIG_FLAG[@]}"}

APP_BUNDLE="$ROOT_DIR/apps/mac/dist/SurgeCode.app"
if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "error: macOS build did not produce $APP_BUNDLE" >&2
  exit 1
fi

cat <<SUMMARY

Build complete.
Backend: $BACKEND_ENTRY
App:     $APP_BUNDLE

Open it with:
  open "$APP_BUNDLE"
SUMMARY
