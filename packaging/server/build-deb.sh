#!/usr/bin/env bash
# Build a .deb package for the T3 Code server / CLI (the `t3` command).
#
# The server is a Node.js app bundled with tsdown. External deps (node-pty,
# effect, @effect/*, etc.) are NOT inlined, so we do a production `npm install`
# in a scratch directory with a catalog-resolved package.json and bundle
# the resulting node_modules alongside the dist files.
#
# Install layout inside the package:
#   /usr/lib/t3-server/dist/          ← compiled JS (bin.mjs, bin.cjs, client/)
#   /usr/lib/t3-server/node_modules/  ← production dependencies
#   /usr/bin/t3                       ← launcher: exec node /usr/lib/t3-server/dist/bin.mjs
#
# Environment variables:
#   OUTPUT_DIR   - Where to put the .deb (default: <repo-root>/packaging-output)
#   VERSION      - Override package version (default: taken from apps/server/package.json)
#   ARCH         - deb architecture label: amd64 (default) or arm64
#   SKIP_BUILD   - Set to 1 to skip `bun run build` and reuse existing dist/
#
# Prerequisites:
#   bun (>=1.3.11), node (>=22), npm, dpkg-deb, fakeroot
#   On Debian/Ubuntu: sudo apt install fakeroot dpkg-dev
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/packaging-output}"
ARCH="${ARCH:-amd64}"
SKIP_BUILD="${SKIP_BUILD:-0}"

mkdir -p "$OUTPUT_DIR"

# ── Read version from server package.json ────────────────────────────────────
VERSION="${VERSION:-$(node -p "require('$REPO_ROOT/apps/server/package.json').version")}"
echo "[packaging/server] Version: $VERSION"

# ── Step 1: build the monorepo (server + web) ────────────────────────────────
if [ "$SKIP_BUILD" = "1" ]; then
  echo "[packaging/server] Skipping build (SKIP_BUILD=1)"
else
  echo "[packaging/server] Building server + web..."
  cd "$REPO_ROOT"
  bun run build:desktop  # builds contracts, shared, web, server, desktop (no-op for desktop JS is fine)
fi

SERVER_DIST="$REPO_ROOT/apps/server/dist"
if [ ! -f "$SERVER_DIST/bin.mjs" ]; then
  echo "ERROR: $SERVER_DIST/bin.mjs not found. Run 'bun run build' first." >&2
  exit 1
fi

# ── Step 2: resolve catalog: entries and create a standalone install dir ─────
echo "[packaging/server] Resolving production dependencies..."

INSTALL_DIR="$(mktemp -d --tmpdir t3server-install.XXXXXXXX)"
trap 'rm -rf "$INSTALL_DIR"' EXIT

# Write a package.json with concrete versions (no catalog: references) so that
# npm install works outside the Bun workspace context.
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
STAGE="$(mktemp -d --tmpdir t3server-stage.XXXXXXXX)"
trap 'rm -rf "$INSTALL_DIR" "$STAGE"' EXIT

INSTALL_PREFIX="$STAGE/usr"
mkdir -p "$INSTALL_PREFIX/lib/t3-server" "$INSTALL_PREFIX/bin"

# Copy compiled dist (includes bin.mjs, bin.cjs, client/, sourcemaps)
cp -r "$SERVER_DIST"/. "$INSTALL_PREFIX/lib/t3-server/dist/"

# Copy resolved node_modules
cp -r "$INSTALL_DIR/node_modules" "$INSTALL_PREFIX/lib/t3-server/node_modules"

# Launcher script
cat > "$INSTALL_PREFIX/bin/t3" << 'LAUNCHER'
#!/bin/sh
exec node /usr/lib/t3-server/dist/bin.mjs "$@"
LAUNCHER
chmod 0755 "$INSTALL_PREFIX/bin/t3"

# ── Step 4: write DEBIAN control files ───────────────────────────────────────
DEBIAN_DIR="$STAGE/DEBIAN"
mkdir -p "$DEBIAN_DIR"

INSTALLED_SIZE=$(du -sk "$INSTALL_PREFIX" | cut -f1)

cat > "$DEBIAN_DIR/control" << CONTROL
Package: t3-server
Version: $VERSION
Architecture: $ARCH
Maintainer: T3 Tools <support@t3.gg>
Installed-Size: $INSTALLED_SIZE
Depends: nodejs (>= 22)
Section: devel
Priority: optional
Homepage: https://t3.chat
Description: T3 Code server and CLI
 The t3 command-line tool that powers T3 Code — an AI coding assistant.
 Includes the HTTP server and CLI front-end. Requires Node.js >= 22.
CONTROL

# ── Step 5: build the .deb ───────────────────────────────────────────────────
DEB_NAME="t3-server_${VERSION}_${ARCH}.deb"
DEB_PATH="$OUTPUT_DIR/$DEB_NAME"

echo "[packaging/server] Building $DEB_NAME..."
fakeroot dpkg-deb --build "$STAGE" "$DEB_PATH"

echo "[packaging/server] Done: $DEB_PATH"
