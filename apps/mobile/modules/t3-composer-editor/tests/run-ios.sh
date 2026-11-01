#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
# Compile the real UITextView and clipboard helpers without the Expo bridge.
python3 - "$module_dir" "$output/main.swift" <<'PYTHON'
import sys
from pathlib import Path
module = Path(sys.argv[1])
editor = (module / "ios/T3ComposerEditorView.swift").read_text().split("public final class T3ComposerEditorView:")[0]
clipboard = (module / "ios/T3ComposerEditorModule.swift").read_text().split('@ExpoModule("T3ComposerEditor")')[0]
source = (editor + "\n" + clipboard).replace("import ExpoModulesCore\n", "")
Path(sys.argv[2]).write_text(source + "\n" + (module / "tests/ios/main.swift").read_text())
PYTHON
xcrun swiftc -target "$(uname -m)-apple-ios16.4-macabi" -sdk "$sdk" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  "$output/main.swift" -o "$output/composer-tests"
"$output/composer-tests"
