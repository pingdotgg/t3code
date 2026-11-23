#!/usr/bin/env bash
# Generates Swift bindings (Swift source, C header, modulemap) from the host conn-ffi library
# into apps/ios/ConnCore/Generated/.
set -euo pipefail

IOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_ROOT/../.." && pwd)"
OUT_DIR="$IOS_ROOT/ConnCore/Generated"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"

# conn-ffi is a member of the repo-root crates/ workspace.
cd "$REPO_ROOT"

echo "==> Building host conn-ffi cdylib"
CARGO_TARGET_DIR="$TARGET_DIR" cargo build -p conn-ffi --lib

case "$(uname -s)" in
  Darwin) LIB_EXT="dylib" ;;
  Linux)  LIB_EXT="so" ;;
  *)
    echo "Unsupported host OS: $(uname -s)" >&2
    exit 1
    ;;
esac

LIB_PATH="$TARGET_DIR/debug/libconn_ffi.$LIB_EXT"
if [[ ! -f "$LIB_PATH" ]]; then
  echo "Expected compiled library not found at $LIB_PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.swift "$OUT_DIR"/*.h "$OUT_DIR"/*.modulemap

echo "==> Generating Swift bindings into $OUT_DIR"
CARGO_TARGET_DIR="$TARGET_DIR" cargo run -p conn-ffi --features bindgen --bin uniffi-bindgen -- \
  generate \
  --library "$LIB_PATH" \
  --language swift \
  --out-dir "$OUT_DIR"

echo "==> Generated files:"
ls -la "$OUT_DIR"
