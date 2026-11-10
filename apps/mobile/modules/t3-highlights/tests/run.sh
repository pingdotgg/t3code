#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
c++ -std=c++20 -O2 -Wall -Wextra -I "$module_dir/cpp" \
  "$module_dir/cpp/Utf16ToUtf8.cpp" "$module_dir/tests/utf16-to-utf8.cpp" -o "$output/utf16-to-utf8"
"$output/utf16-to-utf8"
