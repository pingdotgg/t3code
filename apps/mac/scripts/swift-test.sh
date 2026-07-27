#!/usr/bin/env bash
# Run the macOS app's Swift tests with the flags this toolchain actually needs.
#
# On a machine with only Command Line Tools installed — which is the normal
# state for an agent worktree — a bare `swift test --package-path apps/mac`
# fails three separate ways before a single test runs:
#
#   1. "external macro implementation type 'TestingMacros.SourceLocationMacro'
#      could not be found" — swift-testing's macro plugin is not on the default
#      plugin search path.
#   2. "Library not loaded: @rpath/lib_TestingInterop.dylib" — the Testing
#      framework's interop library is not on the test bundle's rpath.
#   3. "Library not loaded: @rpath/Sparkle.framework/..." — SergeCodeMacTests
#      links Sparkle, which lives in the build products directory.
#
# Every one of those is a toolchain-layout problem, not a code problem, and the
# incantation that works differs between Command Line Tools and a full Xcode.
# Resolving it here means agents run `pnpm run test:mac` and get a result.
#
# Usage:
#   apps/mac/scripts/swift-test.sh                       # whole suite
#   apps/mac/scripts/swift-test.sh --filter SidebarTests # one suite
#
# Any arguments are forwarded to `swift test`.
set -euo pipefail

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Toolchain layout is derived from the compiler that will actually be used, so
# this works under Command Line Tools, a full Xcode, and DEVELOPER_DIR
# overrides alike.
SWIFT_BIN="$(xcrun --find swift)"
TOOLCHAIN_USR="$(cd "$(dirname "$SWIFT_BIN")/.." && pwd)"
DEVELOPER_DIR_RESOLVED="$(xcode-select -p)"

EXTRA_ARGS=()

add_plugin_path() {
  local candidate="$1"
  if [[ -d "$candidate" ]]; then
    EXTRA_ARGS+=(-Xswiftc -plugin-path -Xswiftc "$candidate")
  fi
}

add_rpath() {
  local candidate="$1"
  if [[ -d "$candidate" ]]; then
    EXTRA_ARGS+=(-Xlinker -rpath -Xlinker "$candidate")
  fi
}

# (1) swift-testing's macro plugins.
add_plugin_path "$TOOLCHAIN_USR/lib/swift/host/plugins/testing"

# (2) Testing.framework and the interop dylib it dlopens. Command Line Tools
# keeps them under Library/Developer; Xcode keeps them on the platform.
add_rpath "$DEVELOPER_DIR_RESOLVED/Library/Developer/Frameworks"
add_rpath "$DEVELOPER_DIR_RESOLVED/Library/Developer/usr/lib"
add_rpath "$DEVELOPER_DIR_RESOLVED/Platforms/MacOSX.platform/Developer/Library/Frameworks"

# (3) Frameworks vendored into the build products directory, notably Sparkle.
BIN_PATH="$(swift build --package-path "$MAC_DIR" --show-bin-path 2>/dev/null | tail -1)"
if [[ -n "$BIN_PATH" ]]; then
  add_rpath "$BIN_PATH"
fi

# The suites share process-wide static caches (TimelineDisplayCache,
# StreamingMarkdownCache) and are all @MainActor, so parallel execution
# interleaves them at await points and one suite's resetForTesting() lands
# inside another's assertions. `Release macOS App` and `macOS build check` both
# pass --no-parallel; match them unless the caller asks otherwise.
PARALLELISM=(--no-parallel)
for arg in "$@"; do
  if [[ "$arg" == "--parallel" || "$arg" == "--no-parallel" ]]; then
    PARALLELISM=()
    break
  fi
done

exec swift test \
  --package-path "$MAC_DIR" \
  ${PARALLELISM[@]+"${PARALLELISM[@]}"} \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  "$@"
