#!/bin/sh
set -eu

requested=${1:-}
installed=${2:-}

case "$requested" in
  ''|*[!0-9]*)
    printf '[swift-ios-device] error: T3_SWIFT_BUILD_NUMBER must be a positive integer\n' >&2
    exit 1
    ;;
esac

[ "$requested" -gt 0 ] || {
  printf '[swift-ios-device] error: T3_SWIFT_BUILD_NUMBER must be greater than zero\n' >&2
  exit 1
}

[ -n "$installed" ] || exit 0

case "$installed" in
  *[!0-9]*)
    printf '[swift-ios-device] warning: installed app has nonnumeric build number %s; skipping comparison\n' \
      "$installed" >&2
    exit 0
    ;;
esac

[ "$requested" -gt "$installed" ] || {
  printf '[swift-ios-device] error: requested build %s must be newer than installed build %s\n' \
    "$requested" "$installed" >&2
  exit 1
}
