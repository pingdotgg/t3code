#!/usr/bin/env bash
# Stage the standalone server sidecar for embedding into SurgeCode.app.
#
# Assembles <staging>/ (default: apps/mac/dist/sidecar/) with:
#   SergeCodeNode/node     official darwin Node binary (pinned, checksum-verified)
#   SergeCodeServer/       apps/server bundle (bin.mjs + chunks) plus a
#                          production-only node_modules (via `pnpm deploy`)
#
# make-app.sh embeds whatever it finds in this staging directory, so run this
# before make-app.sh for release builds. Dev builds skip staging entirely and
# keep resolving node/dist against the local checkout at runtime.
#
# Env overrides:
#   SERGE_CODE_SIDECAR_STAGING  staging directory (default: apps/mac/dist/sidecar)
#   SERGE_CODE_NODE_VERSION     Node version to stage (default: pinned below)
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MAC_DIR/../.." && pwd)"

# Pinned Node 24 LTS (Krypton): satisfies apps/server engines
# (^22.16 || ^23.11 || >=24.10) and stays on the Active LTS line.
NODE_VERSION="${SERGE_CODE_NODE_VERSION:-24.18.0}"

STAGING="${SERGE_CODE_SIDECAR_STAGING:-$MAC_DIR/dist/sidecar}"
NODE_OUT="$STAGING/SergeCodeNode"
SERVER_OUT="$STAGING/SergeCodeServer"

case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *)
    echo "error: unsupported host arch $(uname -m) for the staged Node runtime" >&2
    exit 1
    ;;
esac

if [[ ! -f "$REPO_ROOT/apps/server/dist/bin.mjs" ]]; then
  echo "error: apps/server/dist/bin.mjs is missing; run 'vp run build:server' first" >&2
  exit 1
fi

# --- Node runtime -----------------------------------------------------------
if [[ -x "$NODE_OUT/node" ]] && [[ "$("$NODE_OUT/node" --version 2>/dev/null || true)" == "v$NODE_VERSION" ]]; then
  echo "Node runtime v$NODE_VERSION already staged at $NODE_OUT/node"
else
  TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  echo "Downloading $DIST_URL/$TARBALL"
  curl --fail --location --silent --show-error -o "$WORK/$TARBALL" "$DIST_URL/$TARBALL"
  curl --fail --location --silent --show-error -o "$WORK/SHASUMS256.txt" "$DIST_URL/SHASUMS256.txt"

  EXPECTED_SHASUM="$(awk -v f="$TARBALL" '$2 == f { print $1 }' "$WORK/SHASUMS256.txt")"
  if [[ -z "$EXPECTED_SHASUM" ]]; then
    echo "error: no SHA-256 entry for $TARBALL in SHASUMS256.txt" >&2
    exit 1
  fi
  ACTUAL_SHASUM="$(shasum -a 256 "$WORK/$TARBALL" | awk '{ print $1 }')"
  if [[ "$EXPECTED_SHASUM" != "$ACTUAL_SHASUM" ]]; then
    echo "error: SHA-256 mismatch for $TARBALL" >&2
    echo "  expected: $EXPECTED_SHASUM" >&2
    echo "  actual:   $ACTUAL_SHASUM" >&2
    exit 1
  fi

  tar -xzf "$WORK/$TARBALL" -C "$WORK"
  EXTRACTED_NODE="$WORK/node-v${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node"
  if [[ ! -x "$EXTRACTED_NODE" ]]; then
    echo "error: tarball did not contain an executable bin/node" >&2
    exit 1
  fi

  rm -rf "$NODE_OUT"
  mkdir -p "$NODE_OUT"
  cp "$EXTRACTED_NODE" "$NODE_OUT/node"
  chmod +x "$NODE_OUT/node"

  STAGED_VERSION="$("$NODE_OUT/node" --version)"
  if [[ "$STAGED_VERSION" != "v$NODE_VERSION" ]]; then
    echo "error: staged node reports $STAGED_VERSION, expected v$NODE_VERSION" >&2
    exit 1
  fi
  echo "Staged Node $STAGED_VERSION at $NODE_OUT/node"
fi

# --- Server payload ---------------------------------------------------------
# bin.mjs is bundled but externalizes its runtime dependencies, so the app
# must ship a production-only node_modules next to it. `pnpm deploy --legacy`
# materializes exactly that (workspace prod deps are bundled into dist by
# `vp pack`, so only registry deps land here). --legacy is required because
# the workspace does not set inject-workspace-packages=true.
# CI runners (setup-vp) don't put pnpm itself on PATH; fall back to
# corepack, which ships with Node and resolves pnpm from the root
# packageManager field.
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(corepack pnpm)
fi
DEPLOY_DIR="$(mktemp -d)/deploy"
echo "Deploying production server payload with pnpm deploy"
(cd "$REPO_ROOT" && "${PNPM[@]}" --filter t3 deploy --prod --legacy "$DEPLOY_DIR")

rm -rf "$SERVER_OUT"
mkdir -p "$SERVER_OUT"
cp -R "$DEPLOY_DIR/dist/." "$SERVER_OUT/"
cp -R "$DEPLOY_DIR/node_modules" "$SERVER_OUT/"
cp "$DEPLOY_DIR/package.json" "$SERVER_OUT/"

# Native deps ship prebuilds for every platform; the app only runs on this
# one, so drop the rest (~60 MB as of node-pty 1.1 / bufferutil / utf-8-validate).
PRUNE_PATTERNS=(-path "*/prebuilds/win32-*" -o -path "*/prebuilds/linux-*" -o -path "*/prebuilds/android-*")
if [[ "$NODE_ARCH" == "arm64" ]]; then
  PRUNE_PATTERNS+=(-o -path "*/prebuilds/darwin-x64")
else
  PRUNE_PATTERNS+=(-o -path "*/prebuilds/darwin-arm64")
fi
find "$SERVER_OUT/node_modules" -type d \( "${PRUNE_PATTERNS[@]}" \) -prune -exec rm -rf {} + 2>/dev/null || true

# pnpm legacy deploy leaves a dangling self-link (.pnpm/node_modules/t3) for
# the workspace package itself; broken symlinks make `codesign --deep --strict`
# fail with a misleading "No such file or directory", so drop any danglers.
find "$SERVER_OUT" -type l ! -exec test -e {} \; -delete

# Sanity check: the staged payload must actually boot under the staged node.
"$NODE_OUT/node" "$SERVER_OUT/bin.mjs" --version >/dev/null
echo "Staged server payload at $SERVER_OUT ($(du -sh "$SERVER_OUT" | awk '{ print $1 }'))"
echo "Sidecar staging complete: $STAGING"
