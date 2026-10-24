#!/bin/sh
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
cat "$module_dir/ios/ComposerTextDirection.swift" \
  "$module_dir/tests/ComposerTextDirectionCheck.swift" > "$work_dir/main.swift"
swift "$work_dir/main.swift"
