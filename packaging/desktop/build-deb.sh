#!/usr/bin/env bash
# Build a .deb package for the T3 Code desktop app.
# Uses the upstream build-desktop-artifact.ts with electron-builder's deb target.
#
# Environment variables:
#   ARCH        - Build architecture: x64 (default) or arm64
#   OUTPUT_DIR  - Where to put the .deb (default: <repo-root>/packaging-output)
#   VERSION     - Override app version string
#
# Prerequisites:
#   bun, fakeroot, dpkg, electron-builder build deps (rpm, alien not needed for deb)
#   On Debian/Ubuntu: sudo apt install fakeroot dpkg-dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ARCH="${ARCH:-x64}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
VERSION="${VERSION:-}"

mkdir -p "$OUTPUT_DIR"

ARGS=(--platform linux --target deb --arch "$ARCH" --output-dir "$OUTPUT_DIR")
if [ -n "$VERSION" ]; then
  ARGS+=(--build-version "$VERSION")
fi

echo "[packaging/desktop] Building .deb (arch=$ARCH) → $OUTPUT_DIR"
cd "$REPO_ROOT"
exec node scripts/build-desktop-artifact.ts "${ARGS[@]}"
