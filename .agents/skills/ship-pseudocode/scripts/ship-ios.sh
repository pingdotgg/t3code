#!/usr/bin/env bash
# Archive, export, and upload a PseudoCode TestFlight build.
#
#   ship-ios.sh
#
# Bumps T3CODE_IOS_BUILD_NUMBER in .env.local first, because App Store Connect rejects a build
# number it has already seen. Needs the App Store Connect .p8 at ~/.appstoreconnect/private_keys/
# and an Admin-role key; see ../ROTATION.md.
set -euo pipefail
# CocoaPods crashes without a UTF-8 locale, and expo prebuild still exits 0 when it does.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

ROOT="$(repo_root)"
cd "$ROOT"
setup_path "$ROOT"
load_env_local "$ROOT"
require_vars T3CODE_APP_NAME T3CODE_IOS_BUNDLE_ID T3CODE_IOS_TEAM_ID \
  T3CODE_ASC_KEY_ID T3CODE_ASC_ISSUER_ID

KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${T3CODE_ASC_KEY_ID}.p8"
if [ ! -f "$KEY_PATH" ]; then
  echo "No App Store Connect key at $KEY_PATH. See ROTATION.md step 6." >&2
  exit 1
fi

NEXT=$(( ${T3CODE_IOS_BUILD_NUMBER:-0} + 1 ))
if grep -q '^T3CODE_IOS_BUILD_NUMBER=' .env.local; then
  sed -i '' -E "s/^T3CODE_IOS_BUILD_NUMBER=.*/T3CODE_IOS_BUILD_NUMBER=$NEXT/" .env.local
else
  printf '\nT3CODE_IOS_BUILD_NUMBER=%s\n' "$NEXT" >> .env.local
fi
export T3CODE_IOS_BUILD_NUMBER="$NEXT"

APP="$T3CODE_APP_NAME"
cd apps/mobile
mkdir -p build

echo "Prebuilding $APP build $NEXT for $T3CODE_IOS_BUNDLE_ID"
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 vp exec expo prebuild --clean --platform ios

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>method</key><string>app-store-connect</string>
    <key>teamID</key><string>$T3CODE_IOS_TEAM_ID</string>
    <key>uploadSymbols</key><true/>
  </dict>
</plist>
PLIST

AUTH=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$T3CODE_ASC_KEY_ID"
  -authenticationKeyIssuerID "$T3CODE_ASC_ISSUER_ID"
)

# The team is passed on the command line, not left to the generated project.
# Expo writes appleTeamId onto the app target only, so the share extension and
# the widgets target archive without one and fail to sign.
echo "Archiving"
xcodebuild -workspace "ios/$APP.xcworkspace" -scheme "$APP" \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath "build/$APP.xcarchive" \
  DEVELOPMENT_TEAM="$T3CODE_IOS_TEAM_ID" "${AUTH[@]}" archive

ARCHIVED=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' \
  "build/$APP.xcarchive/Info.plist")
if [ "$ARCHIVED" != "$NEXT" ]; then
  echo "Archive carries build $ARCHIVED, expected $NEXT. Stopping before upload." >&2
  exit 1
fi

echo "Exporting"
xcodebuild -exportArchive -archivePath "build/$APP.xcarchive" \
  -exportOptionsPlist build/ExportOptions.plist -exportPath build/export "${AUTH[@]}"

echo "Uploading build $NEXT"
xcrun altool --upload-app -f "build/export/$APP.ipa" -t ios \
  --apiKey "$T3CODE_ASC_KEY_ID" --apiIssuer "$T3CODE_ASC_ISSUER_ID"

echo
echo "Uploaded build $NEXT. Apple processes it for 5 to 15 minutes before it appears in TestFlight."
