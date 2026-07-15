#!/usr/bin/env bash
# Update appcast.xml with a new release entry
# Usage: ./update-appcast.sh VERSION DOWNLOAD_URL FILE_SIZE SIGNATURE
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 VERSION DOWNLOAD_URL FILE_SIZE SIGNATURE" >&2
  echo "Example: $0 0.1.0-alpha.1 https://github.com/.../SurgeCode.zip 12345678 MC0CF..." >&2
  exit 1
fi

VERSION="$1"
DOWNLOAD_URL="$2"
FILE_SIZE="$3"
SIGNATURE="$4"

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPCAST_FILE="$MAC_DIR/Support/appcast.xml"

if [[ ! -f "$APPCAST_FILE" ]]; then
  echo "Error: appcast.xml not found at $APPCAST_FILE" >&2
  exit 1
fi

# Get current date in RFC 822 format
PUB_DATE=$(date -R)

# Create new item entry
NEW_ITEM="    <item>
      <title>Version $VERSION</title>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <pubDate>$PUB_DATE</pubDate>
      <enclosure url=\"$DOWNLOAD_URL\"
                 sparkle:version=\"$VERSION\"
                 sparkle:shortVersionString=\"$VERSION\"
                 length=\"$FILE_SIZE\"
                 type=\"application/octet-stream\"
                 sparkle:edSignature=\"$SIGNATURE\" />
      <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>
    </item>"

# Insert new item after the <language>en</language> line
# Using a temporary file for safe editing
TMP_FILE=$(mktemp)

# Use awk to insert the new item after the comment line
awk -v item="$NEW_ITEM" '
  /<!-- CI will inject release items here -->/ {
    print
    print item
    next
  }
  { print }
' "$APPCAST_FILE" > "$TMP_FILE"

# Replace original file
mv "$TMP_FILE" "$APPCAST_FILE"

echo "Updated appcast.xml with version $VERSION"
