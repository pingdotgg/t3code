#!/usr/bin/env bash
# Build all Linux packages: server .deb/.rpm and desktop .deb/.rpm/.flatpak.
#
# Environment variables (all optional):
#   OUTPUT_DIR      - Output directory (default: <repo-root>/packaging-output)
#   VERSION         - Override version for all packages
#   ARCH            - App build arch: x64 (default) or arm64
#   DEB_ARCH        - Deb architecture label: amd64 (default) or arm64
#   RPM_ARCH        - RPM architecture label: x86_64 (default) or aarch64
#   FLATPAK_ARCH    - Flatpak arch: x86_64 (default) or aarch64
#   SKIP_BUILD      - Set to 1 to skip `bun run build` (reuse existing dist/)
#   BUILD_SERVER    - Set to 0 to skip server packages (default: 1)
#   BUILD_DESKTOP   - Set to 0 to skip desktop packages (default: 1)
#   BUILD_FLATPAK   - Set to 0 to skip Flatpak (default: 1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
export VERSION="${VERSION:-}"
export ARCH="${ARCH:-x64}"
export DEB_ARCH="${DEB_ARCH:-amd64}"
export RPM_ARCH="${RPM_ARCH:-x86_64}"
export FLATPAK_ARCH="${FLATPAK_ARCH:-x86_64}"
export SKIP_BUILD="${SKIP_BUILD:-0}"

BUILD_SERVER="${BUILD_SERVER:-1}"
BUILD_DESKTOP="${BUILD_DESKTOP:-1}"
BUILD_FLATPAK="${BUILD_FLATPAK:-1}"

mkdir -p "$OUTPUT_DIR"

echo "════════════════════════════════════════"
echo " T3 Code Linux package builder"
echo " Output: $OUTPUT_DIR"
echo " App arch: $ARCH  |  deb: $DEB_ARCH  |  rpm: $RPM_ARCH  |  flatpak: $FLATPAK_ARCH"
echo "════════════════════════════════════════"

if [ "$BUILD_SERVER" = "1" ]; then
  echo ""
  echo "── Server .deb ──────────────────────────"
  ARCH="$DEB_ARCH" bash "$SCRIPT_DIR/server/build-deb.sh"

  echo ""
  echo "── Server .rpm ──────────────────────────"
  # After the deb build, skip rebuilding (dist/ already present)
  SKIP_BUILD=1 bash "$SCRIPT_DIR/server/build-rpm.sh"
fi

if [ "$BUILD_DESKTOP" = "1" ]; then
  echo ""
  echo "── Desktop .deb ─────────────────────────"
  bash "$SCRIPT_DIR/desktop/build-deb.sh"

  echo ""
  echo "── Desktop .rpm ─────────────────────────"
  T3CODE_DESKTOP_SKIP_BUILD=1 bash "$SCRIPT_DIR/desktop/build-rpm.sh"

  if [ "$BUILD_FLATPAK" = "1" ]; then
    echo ""
    echo "── Desktop .flatpak ─────────────────────"
    # Reuse the .deb already in OUTPUT_DIR
    SKIP_DEB_BUILD=1 bash "$SCRIPT_DIR/desktop/build-flatpak.sh"
  fi
fi

echo ""
echo "════════════════════════════════════════"
echo " All packages written to: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"/*.{deb,rpm,flatpak} 2>/dev/null || true
echo "════════════════════════════════════════"
