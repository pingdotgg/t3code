#!/usr/bin/env bash
# Bump version according to semver rules
# Usage: ./version-bump.sh [major|minor|patch|prerelease]
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [major|minor|patch|prerelease]" >&2
  echo "  major:      1.0.0 -> 2.0.0" >&2
  echo "  minor:      1.0.0 -> 1.1.0" >&2
  echo "  patch:      1.0.0 -> 1.0.1" >&2
  echo "  prerelease: 1.0.0 -> 1.0.1-alpha.1 (or increment alpha.N)" >&2
  exit 1
fi

BUMP_TYPE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$MAC_DIR/version.json"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Error: version.json not found at $VERSION_FILE" >&2
  exit 1
fi

# Read current version for display
CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['version'])")
CURRENT_BUILD=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['buildNumber'])")

echo "Current version: $CURRENT_VERSION (build $CURRENT_BUILD)"

# Compute next version via the shared compute-only script
BUMP_OUTPUT="$("$SCRIPT_DIR/compute-version.sh" "$BUMP_TYPE")"
NEW_VERSION=$(sed -n 's/^version=//p' <<< "$BUMP_OUTPUT")
NEW_BUILD=$(sed -n 's/^buildNumber=//p' <<< "$BUMP_OUTPUT")
TAG=$(sed -n 's/^tag=//p' <<< "$BUMP_OUTPUT")

echo "New version: $NEW_VERSION (build $NEW_BUILD)"

# Update version.json
cat > "$VERSION_FILE" <<EOF
{
  "version": "$NEW_VERSION",
  "buildNumber": "$NEW_BUILD"
}
EOF

# Create git commit
git add "$VERSION_FILE"
git commit -m "chore: bump version to $NEW_VERSION" --no-verify

# Create git tag
git tag "$TAG"

echo ""
echo "✓ Version bumped to $NEW_VERSION (build $NEW_BUILD)"
echo "✓ Created commit and tag $TAG"
echo ""
echo "To push changes, run:"
echo "  git push && git push --tags"
echo ""
echo "Merging the version bump into main will trigger the release workflow"
echo "to build and publish the release automatically."
