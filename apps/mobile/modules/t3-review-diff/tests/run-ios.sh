#!/bin/bash
set -euo pipefail
module_dir=$(cd "$(dirname "$0")/.." && pwd)
sdk=$(xcrun --sdk macosx --show-sdk-path)
compiler=$(xcrun --find swiftc)
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
# Keep the real content view and helpers; the Expo bridge is not needed by this harness.
python3 - "$module_dir" "$output/main.swift" <<'PYTHON'
import sys
from pathlib import Path
module = Path(sys.argv[1])
source = (module / "ios/T3ReviewDiffView.swift").read_text()
source = source.replace("import ExpoModulesCore\n", "")
# Count entry into the real decoder without replacing the production queue or lifecycle.
row_decode = "try JSONDecoder().decode([ReviewDiffNativeRow].self, from: data)"
assert source.count(row_decode) == 1
source = source.replace(row_decode, "try decodeRowsForTest(data)")
stubs = """
public final class AppContext {}
open class ExpoView: UIView {
  public required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
  @available(*, unavailable)
  public required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
}
final class EventDispatcher {
  var onEvent: (([String: Any]) -> Void)?
  func callAsFunction(_ payload: [String: Any]) { onEvent?(payload) }
}
"""
# Expo alone is stubbed; keep the real scroll container as well as the content view.
Path(sys.argv[2]).write_text(source + "\n" + stubs + "\n"
                            + (module / "tests/ios/main.swift").read_text() + "\n"
                            + (module / "tests/ios/anchor.swift").read_text() + "\n"
                            + (module / "tests/ios/row-decode.swift").read_text() + "\n"
                            + (module / "tests/ios/geometry.swift").read_text())
PYTHON
"$compiler" -O -target "$(uname -m)-apple-ios16.1-macabi" -sdk "$sdk" \
  -module-cache-path "$output/module-cache" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  "$module_dir/ios/ReviewDiffCodeLayout.swift" "$output/main.swift" \
  -o "$output/layout-tests"
"$output/layout-tests"
