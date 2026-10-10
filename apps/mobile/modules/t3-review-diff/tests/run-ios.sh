#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
compiler=$(xcrun --find swiftc)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
"$compiler" -O -target "$(uname -m)-apple-ios16.1-macabi" -sdk "$sdk" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  "$module_dir/ios/ReviewDiffCodeLayout.swift" "$module_dir/tests/ios/main.swift" \
  -o "$output/layout-tests"
"$output/layout-tests"
