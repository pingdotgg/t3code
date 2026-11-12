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
# Instrument the real full-token decoder and accepted publication only.
start = source.index("        let decodedTokens = try JSONDecoder().decode(")
end = source.index("        DispatchQueue.main.async", start)
decode = source[start:end]
source = source[:start] + decode.replace("try JSONDecoder().decode(", "try decodeTokensForTest(") + source[end:]
publish = "          self.contentView.tokensByRowId = decodedTokens"
assert source.count(publish) == 1
source = source.replace(publish, publish + "\n          tokenDecodeProbe.publish()")
# Include the accepted malformed-current fallback in publication counts.
start = source.index("  func setTokensJson(")
end = source.index("  func setTokensPatchJson(", start)
method = source[start:end]
fallback = "          self.contentView.tokensByRowId = [:]"
assert method.count(fallback) == 1
source = source[:start] + method.replace(fallback, fallback + "\n          tokenDecodeProbe.publish()") + source[end:]
# Count the actual lookup's row visits only in the compiled test copy.
needle = """  private func resolvedFileId(for row: ReviewDiffNativeRow) -> String {
    row.resolvedFileId
  }"""
if source.count(needle) != 1:
    raise RuntimeError("Header lookup instrumentation seam changed")
source = source.replace(needle, """  private func resolvedFileId(for row: ReviewDiffNativeRow) -> String {
    HeaderLookupReads.record(row)
    return row.resolvedFileId
  }""")
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
                            + (module / "tests/ios/token-decode.swift").read_text() + "\n"
                            + (module / "tests/ios/geometry.swift").read_text())
PYTHON
"$compiler" -O -target "$(uname -m)-apple-ios16.1-macabi" -sdk "$sdk" \
  -module-cache-path "$output/module-cache" \
  -F "$sdk/System/iOSSupport/System/Library/Frameworks" \
  "$module_dir/ios/ReviewDiffCodeLayout.swift" "$output/main.swift" \
  -o "$output/layout-tests"
"$output/layout-tests"
