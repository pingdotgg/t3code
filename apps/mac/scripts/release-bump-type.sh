#!/usr/bin/env bash
# Resolve the semver bump type for an automated release from a merged PR's
# labels. Kept as a tiny standalone script (with tests in
# scripts/release-bump-type.test.ts) because it sits on the only path that
# tags and ships releases.
#
# Usage: ./release-bump-type.sh "label1 label2 ..."
# Prints one of: major | minor | patch
#
# Rules: release:major wins over release:minor, which wins over
# release:patch; no qualifier (including a bare "release" label) means a
# bug-fix-scale change and defaults to patch.
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [space-separated labels]" >&2
  exit 1
fi

# Pad with spaces so exact-label matching works at the string edges.
case " ${1:-} " in
  *" release:major "*) echo "major" ;;
  *" release:minor "*) echo "minor" ;;
  *" release:patch "*) echo "patch" ;;
  *) echo "patch" ;;
esac
