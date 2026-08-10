#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VALIDATE="$SCRIPT_DIR/validate-device-build-number.sh"

expect_acceptance() {
  label=$1
  shift
  if ! /bin/sh "$VALIDATE" "$@" >/dev/null 2>&1; then
    printf 'expected acceptance: %s\n' "$label" >&2
    exit 1
  fi
}

expect_rejection() {
  label=$1
  shift
  if /bin/sh "$VALIDATE" "$@" >/dev/null 2>&1; then
    printf 'expected rejection: %s\n' "$label" >&2
    exit 1
  fi
}

expect_acceptance "first install" 1 ""
expect_acceptance "monotonic upgrade" 22 21
expect_rejection "missing requested build" "" 21
expect_rejection "nonnumeric requested build" next 21
expect_rejection "equal installed build" 21 21
expect_rejection "older installed build" 20 21
expect_rejection "nonnumeric installed build" 22 old

printf 'device build-number validation tests passed\n'
