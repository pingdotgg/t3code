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
MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$MAC_DIR/version.json"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Error: version.json not found at $VERSION_FILE" >&2
  exit 1
fi

# Read current version
CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['version'])")
CURRENT_BUILD=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['buildNumber'])")

echo "Current version: $CURRENT_VERSION (build $CURRENT_BUILD)"

# Parse version components
# Handle versions like "1.2.3" or "1.2.3-alpha.1"
if [[ "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-([a-z]+)\.([0-9]+))?$ ]]; then
  MAJOR="${BASH_REMATCH[1]}"
  MINOR="${BASH_REMATCH[2]}"
  PATCH="${BASH_REMATCH[3]}"
  PRERELEASE_LABEL="${BASH_REMATCH[5]}"
  PRERELEASE_NUM="${BASH_REMATCH[6]}"
else
  echo "Error: Invalid version format: $CURRENT_VERSION" >&2
  exit 1
fi

# Calculate new version based on bump type
case "$BUMP_TYPE" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  patch)
    PATCH=$((PATCH + 1))
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  prerelease)
    if [[ -n "$PRERELEASE_LABEL" ]]; then
      # Increment existing prerelease
      PRERELEASE_NUM=$((PRERELEASE_NUM + 1))
      NEW_VERSION="$MAJOR.$MINOR.$PATCH-$PRERELEASE_LABEL.$PRERELEASE_NUM"
    else
      # Start new prerelease (patch + alpha.1)
      PATCH=$((PATCH + 1))
      NEW_VERSION="$MAJOR.$MINOR.$PATCH-alpha.1"
    fi
    ;;
  *)
    echo "Error: Invalid bump type: $BUMP_TYPE" >&2
    echo "Must be one of: major, minor, patch, prerelease" >&2
    exit 1
    ;;
esac

# Increment build number
NEW_BUILD=$((CURRENT_BUILD + 1))

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
TAG="v$NEW_VERSION"
git tag "$TAG"

echo ""
echo "✓ Version bumped to $NEW_VERSION (build $NEW_BUILD)"
echo "✓ Created commit and tag $TAG"
echo ""
echo "To push changes, run:"
echo "  git push && git push --tags"
echo ""
echo "This will trigger the release workflow to build and publish the release."
