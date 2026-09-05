#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEVICE_ID="${T3_SWIFT_DEVICE_ID:-${1:-}}"
DEVELOPMENT_TEAM="${T3_SWIFT_DEVELOPMENT_TEAM:-${2:-}}"
CONFIGURATION="${T3_SWIFT_CONFIGURATION:-Debug}"
DERIVED_DATA_PATH="${T3_SWIFT_DERIVED_DATA_PATH:-${APP_DIR}/.derivedData/device}"

die() {
  printf '[swift-ios-device] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd awk
require_cmd mktemp
require_cmd plutil
require_cmd xcodebuild
require_cmd xcrun

[[ "${CONFIGURATION}" == "Debug" || "${CONFIGURATION}" == "Release" ]] || die \
  "T3_SWIFT_CONFIGURATION must be Debug or Release"

if [[ "${CONFIGURATION}" == "Debug" ]]; then
  BUNDLE_IDENTIFIER="com.t3tools.t3code.swiftui.dev"
else
  BUNDLE_IDENTIFIER="com.t3tools.t3code.swiftui"
fi
WIDGET_BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER}.widgets"
SHARE_BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER}.sharing"

[[ -z "${T3_SWIFT_BUNDLE_IDENTIFIER:-}" || "${T3_SWIFT_BUNDLE_IDENTIFIER}" == "${BUNDLE_IDENTIFIER}" ]] || die \
  "custom bundle identifiers are unsupported; select the Debug or Release identity with T3_SWIFT_CONFIGURATION"

bundle_identifier_for_target() {
  local target="$1"
  xcodebuild -showBuildSettings \
    -project "${APP_DIR}/T3Code.xcodeproj" \
    -target "${target}" \
    -configuration "${CONFIGURATION}" \
    | awk '$1 == "PRODUCT_BUNDLE_IDENTIFIER" && $2 == "=" { print $3; exit }'
}

verify_bundle_identifiers() {
  local host widgets share
  host="$(bundle_identifier_for_target T3Code)"
  widgets="$(bundle_identifier_for_target T3CodeWidgets)"
  share="$(bundle_identifier_for_target T3CodeShare)"
  [[ "${host}" == "${BUNDLE_IDENTIFIER}" ]] || die \
    "host bundle identifier resolved to '${host}'"
  [[ "${widgets}" == "${WIDGET_BUNDLE_IDENTIFIER}" ]] || die \
    "widget bundle identifier resolved to '${widgets}'"
  [[ "${share}" == "${SHARE_BUNDLE_IDENTIFIER}" ]] || die \
    "share bundle identifier resolved to '${share}'"
  printf '[swift-ios-device] bundle identifiers: %s, %s, %s\n' \
    "${host}" "${widgets}" "${share}"
}

if [[ "${T3_SWIFT_VERIFY_BUNDLE_IDENTIFIERS_ONLY:-0}" == "1" ]]; then
  verify_bundle_identifiers
  exit 0
fi

[[ -n "${DEVICE_ID}" ]] || die \
  "set T3_SWIFT_DEVICE_ID to a CoreDevice identifier or UDID from 'xcrun devicectl list devices --columns UDID'"
[[ -n "${DEVELOPMENT_TEAM}" ]] || die \
  "set T3_SWIFT_DEVELOPMENT_TEAM to your Apple Developer team ID"

build_settings=(
  "DEVELOPMENT_TEAM=${DEVELOPMENT_TEAM}"
)

DEVICE_JSON="$(mktemp -t t3-swift-devices.XXXXXX)"
trap 'unlink "${DEVICE_JSON}" 2>/dev/null || true' EXIT
xcrun devicectl list devices --json-output "${DEVICE_JSON}" --quiet >/dev/null
DESTINATION_ID="$(
  xcrun swift "${SCRIPT_DIR}/resolve-device-udid.swift" "${DEVICE_JSON}" "${DEVICE_ID}"
)" || die "could not resolve device '${DEVICE_ID}' to an Xcode destination UDID"

for key in \
  T3CODE_CLERK_PUBLISHABLE_KEY \
  T3CODE_CLERK_JWT_TEMPLATE \
  T3CODE_RELAY_URL; do
  value="${!key:-}"
  if [[ -n "${value}" ]]; then
    build_settings+=("${key}=${value}")
  fi
done

if [[ -n "${T3_SWIFT_VERSION:-}" ]]; then
  build_settings+=("MARKETING_VERSION=${T3_SWIFT_VERSION}")
fi
if [[ -n "${T3_SWIFT_BUILD_NUMBER:-}" ]]; then
  build_settings+=("CURRENT_PROJECT_VERSION=${T3_SWIFT_BUILD_NUMBER}")
fi

printf '[swift-ios-device] building %s for %s\n' "${BUNDLE_IDENTIFIER}" "${DESTINATION_ID}"
xcodebuild build \
  -project "${APP_DIR}/T3Code.xcodeproj" \
  -scheme T3Code \
  -configuration "${CONFIGURATION}" \
  -destination "platform=iOS,id=${DESTINATION_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  "${build_settings[@]}"

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos/T3Code.app"
[[ -d "${APP_PATH}" ]] || die "built app was not found at ${APP_PATH}"

actual_host="$(plutil -extract CFBundleIdentifier raw -o - "${APP_PATH}/Info.plist")"
actual_widgets="$(
  plutil -extract CFBundleIdentifier raw -o - \
    "${APP_PATH}/PlugIns/T3CodeWidgets.appex/Info.plist"
)"
actual_share="$(
  plutil -extract CFBundleIdentifier raw -o - \
    "${APP_PATH}/PlugIns/T3CodeShare.appex/Info.plist"
)"
[[ "${actual_host}" == "${BUNDLE_IDENTIFIER}" ]] || die \
  "built host bundle identifier is '${actual_host}'"
[[ "${actual_widgets}" == "${WIDGET_BUNDLE_IDENTIFIER}" ]] || die \
  "built widget bundle identifier is '${actual_widgets}'"
[[ "${actual_share}" == "${SHARE_BUNDLE_IDENTIFIER}" ]] || die \
  "built share bundle identifier is '${actual_share}'"

printf '[swift-ios-device] installing %s\n' "${APP_PATH}"
xcrun devicectl device install app --device "${DESTINATION_ID}" "${APP_PATH}"

printf '[swift-ios-device] launching %s\n' "${BUNDLE_IDENTIFIER}"
if ! launch_output="$(
  xcrun devicectl device process launch \
    --device "${DESTINATION_ID}" \
    "${BUNDLE_IDENTIFIER}" 2>&1
)"; then
  printf '%s\n' "${launch_output}" >&2
  if [[ "${launch_output}" == *"BSErrorCodeDescription = Locked"* ]]; then
    printf '[swift-ios-device] installed; unlock the device to launch the app\n'
    exit 0
  fi
  exit 1
fi
printf '%s\n' "${launch_output}"
