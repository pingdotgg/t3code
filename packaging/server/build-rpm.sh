#!/usr/bin/env bash
# Build an .rpm package for the T3 Code server / CLI (the `t3` command).
#
# See build-deb.sh for details on the packaging strategy.
#
# Install layout inside the package:
#   /usr/lib/t3-server/dist/          ← compiled JS
#   /usr/lib/t3-server/node_modules/  ← production dependencies
#   /usr/bin/t3                       ← launcher
#
# Environment variables:
#   OUTPUT_DIR   - Where to put the .rpm (default: <repo-root>/packaging-output)
#   VERSION      - Override package version (default: from apps/server/package.json)
#   RPM_ARCH     - RPM architecture label: x86_64 (default) or aarch64
#   SKIP_BUILD   - Set to 1 to skip `bun run build` and reuse existing dist/
#
# Prerequisites:
#   bun (>=1.3.11), node (>=22), npm, rpm-build
#   On Fedora/RHEL: sudo dnf install rpm-build
#   On Debian/Ubuntu: sudo apt install rpm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
RPM_ARCH="${RPM_ARCH:-x86_64}"
SKIP_BUILD="${SKIP_BUILD:-0}"

mkdir -p "$OUTPUT_DIR"

# ── Read version ──────────────────────────────────────────────────────────────
VERSION="${VERSION:-$(node -p "require('$REPO_ROOT/apps/server/package.json').version")}"
echo "[packaging/server] Version: $VERSION"

# ── Step 1: build ─────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = "1" ]; then
  echo "[packaging/server] Skipping build (SKIP_BUILD=1)"
else
  echo "[packaging/server] Building server + web..."
  cd "$REPO_ROOT"
  bun run build:desktop
fi

SERVER_DIST="$REPO_ROOT/apps/server/dist"
if [ ! -f "$SERVER_DIST/bin.mjs" ]; then
  echo "ERROR: $SERVER_DIST/bin.mjs not found. Run 'bun run build' first." >&2
  exit 1
fi

# ── Step 2: resolve catalog: deps and install ─────────────────────────────────
echo "[packaging/server] Resolving production dependencies..."

INSTALL_DIR="$(mktemp -d --tmpdir t3server-rpm-install.XXXXXXXX)"

node --input-type=module << 'RESOLVE_SCRIPT' > "$INSTALL_DIR/package.json"
import { readFileSync } from 'fs';
const root   = JSON.parse(readFileSync(process.env.REPO_ROOT + '/package.json', 'utf8'));
const server = JSON.parse(readFileSync(process.env.REPO_ROOT + '/apps/server/package.json', 'utf8'));
const catalog = root.workspaces?.catalog ?? {};

const deps = {};
for (const [pkg, ver] of Object.entries(server.dependencies ?? {})) {
  deps[pkg] = (ver === 'catalog:' || ver.startsWith('catalog:')) ? (catalog[pkg] ?? ver) : ver;
}

const out = {
  name: server.name,
  version: process.env.VERSION,
  private: true,
  type: server.type,
  dependencies: deps,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
RESOLVE_SCRIPT

echo "[packaging/server] Installing production dependencies..."
cd "$INSTALL_DIR"
npm install --production --legacy-peer-deps --no-fund --loglevel=warn

# ── Step 3: assemble the staging tree ────────────────────────────────────────
echo "[packaging/server] Assembling package tree..."
STAGE="$(mktemp -d --tmpdir t3server-rpm-stage.XXXXXXXX)"
trap 'rm -rf "$INSTALL_DIR" "$STAGE"' EXIT

mkdir -p "$STAGE/usr/lib/t3-server" "$STAGE/usr/bin"

cp -r "$SERVER_DIST"/. "$STAGE/usr/lib/t3-server/dist/"
cp -r "$INSTALL_DIR/node_modules" "$STAGE/usr/lib/t3-server/node_modules"

cat > "$STAGE/usr/bin/t3" << 'LAUNCHER'
#!/bin/sh
exec node /usr/lib/t3-server/dist/bin.mjs "$@"
LAUNCHER
chmod 0755 "$STAGE/usr/bin/t3"

# ── Step 4: rpmbuild ──────────────────────────────────────────────────────────
RPM_TOPDIR="$(mktemp -d --tmpdir t3server-rpmbuild.XXXXXXXX)"
trap 'rm -rf "$INSTALL_DIR" "$STAGE" "$RPM_TOPDIR"' EXIT
mkdir -p "$RPM_TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# Place the staging tree where the spec file expects it
cp -r "$STAGE/." "$RPM_TOPDIR/SOURCES/t3-server-stage/"
cp "$SCRIPT_DIR/rpm/t3-server.spec" "$RPM_TOPDIR/SPECS/"

echo "[packaging/server] Running rpmbuild (arch=$RPM_ARCH)..."
rpmbuild \
  --define "_topdir $RPM_TOPDIR" \
  --define "_version $VERSION" \
  --target "$RPM_ARCH" \
  -bb "$RPM_TOPDIR/SPECS/t3-server.spec"

RPM_FILE=$(find "$RPM_TOPDIR/RPMS" -name "*.rpm" | head -1)
if [ -z "$RPM_FILE" ]; then
  echo "ERROR: rpmbuild did not produce an .rpm file." >&2
  exit 1
fi

DEST="$OUTPUT_DIR/$(basename "$RPM_FILE")"
cp "$RPM_FILE" "$DEST"
echo "[packaging/server] Done: $DEST"
