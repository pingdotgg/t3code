#!/usr/bin/env bash
# Build an .rpm package for the T3 Code desktop app.
# Uses the upstream build-desktop-artifact.ts with electron-builder's rpm target.
#
# Environment variables:
#   ARCH        - Build architecture: x64 (default) or arm64
#   OUTPUT_DIR  - Where to put the .rpm (default: <repo-root>/packaging-output)
#   VERSION     - Override app version string
#
# Prerequisites:
#   bun, rpm-build
#   On Fedora/RHEL: sudo dnf install rpm-build
#   On Debian/Ubuntu: sudo apt install rpm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ARCH="${ARCH:-x64}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
VERSION="${VERSION:-}"

mkdir -p "$OUTPUT_DIR"

ARGS=(--platform linux --target rpm --arch "$ARCH" --output-dir "$OUTPUT_DIR")
if [ -n "$VERSION" ]; then
  ARGS+=(--build-version "$VERSION")
fi

echo "[packaging/desktop] Building .rpm (arch=$ARCH) → $OUTPUT_DIR"
cd "$REPO_ROOT"
exec node scripts/build-desktop-artifact.ts "${ARGS[@]}"
