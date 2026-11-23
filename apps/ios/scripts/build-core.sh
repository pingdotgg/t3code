#!/usr/bin/env bash
# Builds conn-ffi for iOS device + simulator and packages ConnCore.xcframework for Swift/Xcode.
# Intended to run on a Mac with Xcode + iOS SDK installed (e.g. nick-vm).
set -euo pipefail

IOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_ROOT/../.." && pwd)"
GENERATED_DIR="$IOS_ROOT/ConnCore/Generated"
OUT_XCFRAMEWORK="$IOS_ROOT/build/ConnCore.xcframework"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"

IOS_TARGETS=(
  "aarch64-apple-ios"
  "aarch64-apple-ios-sim"
)

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required to install iOS Rust targets" >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is required to package ConnCore.xcframework" >&2
  exit 1
fi

if [[ ! -f "$GENERATED_DIR/conn_ffiFFI.h" || ! -f "$GENERATED_DIR/conn_ffiFFI.modulemap" ]]; then
  echo "Missing generated headers in $GENERATED_DIR; run apps/ios/scripts/ios-bindings.sh first" >&2
  exit 1
fi

# conn-ffi is a member of the repo-root crates/ workspace, which pins the toolchain.
cd "$REPO_ROOT"
TOOLCHAIN_BIN="$(dirname "$(rustup which cargo)")"
export PATH="$TOOLCHAIN_BIN:$PATH"

installed_targets="$(rustup target list --installed)"
for target in "${IOS_TARGETS[@]}"; do
  if ! grep -qx "$target" <<<"$installed_targets"; then
    echo "==> Installing Rust target $target"
    rustup target add "$target"
  fi
done

for target in "${IOS_TARGETS[@]}"; do
  echo "==> Building conn-ffi (release) for $target"
  CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release -p conn-ffi --lib --target "$target"
done

DEVICE_LIB="$TARGET_DIR/aarch64-apple-ios/release/libconn_ffi.a"
SIM_LIB="$TARGET_DIR/aarch64-apple-ios-sim/release/libconn_ffi.a"
for lib in "$DEVICE_LIB" "$SIM_LIB"; do
  if [[ ! -f "$lib" ]]; then
    echo "Expected static library missing at $lib" >&2
    exit 1
  fi
done

STAGE_HEADERS="$(mktemp -d "${TMPDIR:-/tmp}/conn-ffi-headers.XXXXXX")"
trap 'rm -rf "$STAGE_HEADERS"' EXIT
cp "$GENERATED_DIR/conn_ffiFFI.h" "$STAGE_HEADERS/"
cp "$GENERATED_DIR/conn_ffiFFI.modulemap" "$STAGE_HEADERS/module.modulemap"

mkdir -p "$(dirname "$OUT_XCFRAMEWORK")"
rm -rf "$OUT_XCFRAMEWORK"

echo "==> Packaging $OUT_XCFRAMEWORK"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIB" -headers "$STAGE_HEADERS" \
  -library "$SIM_LIB" -headers "$STAGE_HEADERS" \
  -output "$OUT_XCFRAMEWORK"

echo "==> Built $OUT_XCFRAMEWORK"
