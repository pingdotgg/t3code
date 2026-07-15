#!/usr/bin/env bash
# Sync version from version.json to Info.plist
# Idempotent: can run multiple times safely
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$MAC_DIR/version.json"
PLIST_FILE="$MAC_DIR/Support/Info.plist"

# Check if version.json exists
if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Error: version.json not found at $VERSION_FILE" >&2
  exit 1
fi

# Check if Info.plist exists
if [[ ! -f "$PLIST_FILE" ]]; then
  echo "Error: Info.plist not found at $PLIST_FILE" >&2
  exit 1
fi

# Read version and buildNumber from version.json
# Using python3 for JSON parsing (available on all macOS systems)
VERSION=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['version'])")
BUILD_NUMBER=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['buildNumber'])")

echo "Syncing version $VERSION (build $BUILD_NUMBER) to Info.plist"

# Update CFBundleShortVersionString (user-visible version)
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST_FILE" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$PLIST_FILE"

# Update CFBundleVersion (build number)
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST_FILE" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $BUILD_NUMBER" "$PLIST_FILE"

echo "Version synced successfully"
