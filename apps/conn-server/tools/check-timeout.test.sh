#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
. tools/check-timeout.sh
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
check_timeout 5 true
status=0
check_timeout 5 bash -c 'exit 7' || status=$?
[ "$status" -eq 7 ]
status=0
check_timeout 1 bash -c '
  trap "" TERM
  echo $$ >"$1/root"
  bash -c '\''trap "" TERM; echo $$ >"$1/child"; exec sleep 120'\'' _ "$1" &
  wait
' _ "$scratch" || status=$?
[ "$status" -eq 124 ]
for file in "$scratch/root" "$scratch/child"; do
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "Timeout left process $pid running" >&2
    exit 1
  fi
done
printf 'PASS: timeout killed the process group; exit codes preserved\n'
