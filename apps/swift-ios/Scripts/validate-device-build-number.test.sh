#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VALIDATE="$SCRIPT_DIR/validate-device-build-number.sh"
RESOLVE="$SCRIPT_DIR/resolve-installed-build-number.swift"
FIXTURE="$SCRIPT_DIR/Fixtures/installed-apps.json"

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
expect_acceptance "legacy nonnumeric installed build" 22 old

resolved="$(xcrun swift "$RESOLVE" "$FIXTURE" com.t3tools.t3code.swiftui.dev)"
[ "$resolved" = 21 ] || {
  printf 'expected installed build 21, got %s\n' "$resolved" >&2
  exit 1
}

missing="$(xcrun swift "$RESOLVE" "$FIXTURE" com.example.missing)"
[ -z "$missing" ] || {
  printf 'expected no build for a missing app, got %s\n' "$missing" >&2
  exit 1
}

if xcrun swift "$RESOLVE" "$FIXTURE" com.example.missing-version >/dev/null 2>&1; then
  printf 'expected an installed app without a build number to fail resolution\n' >&2
  exit 1
fi

if xcrun swift "$RESOLVE" "$FIXTURE" com.example.empty-version >/dev/null 2>&1; then
  printf 'expected an installed app with an empty build number to fail resolution\n' >&2
  exit 1
fi

printf 'device build-number validation tests passed\n'
