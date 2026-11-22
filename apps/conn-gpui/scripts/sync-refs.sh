#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="$ROOT/references.pin"

sync_repo() {
  local key="$1"
  local url="$2"
  local dir="$ROOT/.refs/$key"
  local pin
  pin="$(grep "^${key}=" "$PIN_FILE" | cut -d= -f2)"
  if [[ -z "$pin" ]]; then
    echo "error: ${key} pin missing from $PIN_FILE" >&2
    exit 1
  fi

  mkdir -p "$ROOT/.refs"

  if [[ ! -d "$dir/.git" ]]; then
    echo "==> cloning $url into .refs/$key"
    git clone --depth 1 "$url" "$dir"
  fi

  local current
  current="$(git -C "$dir" rev-parse HEAD)"
  if [[ "$current" != "$pin" ]]; then
    echo "==> fetching pinned commit $pin for $key"
    git -C "$dir" fetch --depth 1 origin "$pin"
    git -C "$dir" checkout --detach "$pin"
  fi

  echo "==> .refs/$key ready at $(git -C "$dir" rev-parse --short HEAD)"
}

sync_repo threadbear "https://github.com/mikecann/threadbear.git"
sync_repo rune "https://github.com/anomalyco/rune.git"
