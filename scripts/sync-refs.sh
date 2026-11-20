#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="$ROOT/references.pin"
REF_DIR="$ROOT/.refs/threadbear"

PIN="$(grep '^threadbear=' "$PIN_FILE" | cut -d= -f2)"
if [[ -z "$PIN" ]]; then
  echo "error: threadbear pin missing from $PIN_FILE" >&2
  exit 1
fi

mkdir -p "$ROOT/.refs"

if [[ ! -d "$REF_DIR/.git" ]]; then
  echo "==> cloning mikecann/threadbear into .refs/threadbear"
  git clone --depth 1 --branch main https://github.com/mikecann/threadbear.git "$REF_DIR"
fi

CURRENT="$(git -C "$REF_DIR" rev-parse HEAD)"
if [[ "$CURRENT" != "$PIN" ]]; then
  echo "==> fetching pinned commit $PIN"
  git -C "$REF_DIR" fetch --depth 1 origin "$PIN"
  git -C "$REF_DIR" checkout --detach "$PIN"
fi

echo "==> .refs/threadbear ready at $(git -C "$REF_DIR" rev-parse --short HEAD)"
