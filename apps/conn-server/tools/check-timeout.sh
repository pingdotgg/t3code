#!/usr/bin/env bash

check_timeout() (
  set +e
  local limit="$1" marker child="" watchdog="" status
  shift
  marker="$(mktemp "${TMPDIR:-/tmp}/conn-timeout.XXXXXX")" || exit 1
  cleanup_timeout() {
    [ -z "$watchdog" ] || kill -KILL -- "-$watchdog" 2>/dev/null
    [ -z "$watchdog" ] || wait "$watchdog" 2>/dev/null
    [ -z "$child" ] || kill -KILL -- "-$child" 2>/dev/null
    rm -f "$marker"
  }
  trap cleanup_timeout EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Monitor mode gives each child its own process group on both macOS and Linux.
  set -m
  (set +m; "$@") &
  child=$!
  (
    set +m
    sleep "$limit"
    echo timeout >"$marker"
    kill -TERM -- "-$child" 2>/dev/null
    sleep 5
    kill -KILL -- "-$child" 2>/dev/null
  ) &
  watchdog=$!
  set +m
  wait "$child"
  status=$?
  if [ -s "$marker" ]; then
    wait "$watchdog"
    exit 124
  fi
  exit "$status"
)
