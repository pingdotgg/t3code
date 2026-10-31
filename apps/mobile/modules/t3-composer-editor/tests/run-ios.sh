#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
# Exercise the real UIKit editor without loading the Expo bridge.
python3 - "$module_dir" "$output/main.swift" <<'PYTHON'
import sys
from pathlib import Path
module = Path(sys.argv[1])
source = (module / "ios/T3ComposerEditorView.swift").read_text().replace("import ExpoModulesCore\n", "")
stubs = """

public final class AppContext {}
open class ExpoView: UIView {
  public required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
  @available(*, unavailable)
  public required init?(coder: NSCoder) { fatalError() }
}
final class EventDispatcher { func callAsFunction(_ payload: [String: Any] = [:]) {} }
enum T3ComposerClipboard {
  static func write(text: String, fragment: String) {}
  static func read() -> [String: String] { [:] }
}
"""
Path(sys.argv[2]).write_text(source + "\n" + stubs + "\n" + (module / "tests/ios/main.swift").read_text())
PYTHON
xcrun swiftc -O -target "$(uname -m)-apple-ios16.4-macabi" -sdk "$sdk" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  "$output/main.swift" -o "$output/composer-tests"
"$output/composer-tests"
