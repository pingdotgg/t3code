#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIMULATOR_ID="${T3_SWIFT_SIMULATOR_ID:-}"
DERIVED_DATA_ROOT="${RUNNER_TEMP:-${APP_DIR}/.derivedData}"
DERIVED_DATA_PATH="${T3_SWIFT_DERIVED_DATA_PATH:-${DERIVED_DATA_ROOT}/swift-ios-ci}"

die() {
  printf '[swift-ios-ci] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd awk
require_cmd xcodebuild
require_cmd xcrun

if [[ -z "${SIMULATOR_ID}" ]]; then
  # simctl groups devices by runtime. Keeping the last available iPhone picks
  # the newest installed iOS runtime without coupling CI to a device model.
  SIMULATOR_ID="$(
    xcrun simctl list devices available \
      | awk '
          /^[[:space:]]+iPhone/ {
            line = $0
            while (match(line, /\([[:xdigit:]-]+\)/)) {
              value = substr(line, RSTART + 1, RLENGTH - 2)
              if (value ~ /^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$/) {
                candidate = value
              }
              line = substr(line, RSTART + RLENGTH)
            }
          }
          END { print candidate }
        '
  )"
fi

[[ -n "${SIMULATOR_ID}" ]] || die "no available iPhone simulator was found"

printf '[swift-ios-ci] Xcode: %s\n' "$(xcodebuild -version | tr '\n' ' ')"
printf '[swift-ios-ci] simulator: %s\n' "${SIMULATOR_ID}"

xcodebuild test \
  -project "${APP_DIR}/T3Code.xcodeproj" \
  -scheme T3Code \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=${SIMULATOR_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -maximum-concurrent-test-simulator-destinations 1 \
  -parallel-testing-enabled NO \
  -collect-test-diagnostics never \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 30 \
  -maximum-test-execution-time-allowance 60 \
  -only-testing:T3CodeTests \
  CODE_SIGNING_ALLOWED=NO
