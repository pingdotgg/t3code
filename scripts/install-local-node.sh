#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_RAW="$(tr -d '[:space:]' < "$ROOT_DIR/.node-version")"
VERSION="${VERSION_RAW#v}"
DIST_VERSION="v${VERSION}"

case "$(uname -s)" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

FILE="node-${DIST_VERSION}-${OS}-${ARCH}.tar.xz"
BASE_URL="https://nodejs.org/dist/${DIST_VERSION}"
DOWNLOAD_DIR="$ROOT_DIR/.local/downloads"
INSTALL_DIR="$ROOT_DIR/.local/node-${DIST_VERSION}-${OS}-${ARCH}"
SYMLINK_PATH="$ROOT_DIR/.local/node"
ARCHIVE_PATH="$DOWNLOAD_DIR/$FILE"
SHASUMS_PATH="$DOWNLOAD_DIR/SHASUMS256.txt"

mkdir -p "$DOWNLOAD_DIR"

if [ ! -f "$ARCHIVE_PATH" ]; then
  curl -L --fail -o "$ARCHIVE_PATH" "$BASE_URL/$FILE"
fi

if [ ! -f "$SHASUMS_PATH" ]; then
  curl -L --fail -o "$SHASUMS_PATH" "$BASE_URL/SHASUMS256.txt"
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DOWNLOAD_DIR" && grep "  $FILE$" SHASUMS256.txt | sha256sum -c -)
elif command -v shasum >/dev/null 2>&1; then
  EXPECTED="$(grep "  $FILE$" "$SHASUMS_PATH" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch for $FILE" >&2
    exit 1
  fi
else
  echo "Warning: no sha256 tool found; skipping checksum verification" >&2
fi

rm -rf "$INSTALL_DIR"
tar -xJf "$ARCHIVE_PATH" -C "$ROOT_DIR/.local"
ln -sfn "$(basename "$INSTALL_DIR")" "$SYMLINK_PATH"

"$SYMLINK_PATH/bin/node" -v
