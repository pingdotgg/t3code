---
name: verify
description: Verify apps/mac UI changes at runtime without Xcode, screen-recording, or accessibility permissions, using the mock backend and the in-process UIProbe self-capture hook.
---

# Verify apps/mac changes

No Xcode on this machine; screen capture (`screencapture`) and AppleScript
accessibility are NOT granted, so drive the app in-process instead.

## Build + launch (mock backend, no server needed)

```bash
swift build --package-path apps/mac
SERGECODE_UI_PROBE=/tmp/sergecode-probe apps/mac/.build/debug/SergeCodeMac --mock
```

- `--mock` / `SERGECODE_MOCK=1` swaps in `MockBackend` (threads, diffs,
  approvals, plan fixtures) — see `Sources/SergeCodeMac/Model/MockBackend.swift`.
- `SERGECODE_UI_PROBE=<dir>` (DEBUG builds only) activates
  `Sources/SergeCodeMac/Support/UIProbe.swift`: selects the first thread,
  writes window PNGs into `<dir>` via in-process `cacheDisplay` (no TCC
  prompt), scrolls the diff panel's NSScrollView programmatically, logs
  `UIProbe:` lines to stdout, then quits itself. Extend that file to drive
  new flows; keep it `#if DEBUG`.

## Reading the PNGs

NSVisualEffectView / vibrancy regions (sidebar, inspector list chrome,
selected List rows) render BLACK in offscreen `cacheDisplay` captures.
That is a capture artifact, not an app bug — judge opaque regions
(diff text, chat over scenery photo) and geometry, not material colors.

## Gotchas

- `swift test` dyld failure "Library not loaded: @rpath/Testing.framework":
  CLT keeps the swift-testing runtime outside every dyld search path and
  `DYLD_FRAMEWORK_PATH` is SIP-stripped. Bake rpaths at link time:
  ```bash
  swift test --package-path apps/mac \
    -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
    -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
    -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
  ```
- The inspector column is 300–480pt wide: any side-by-side split inside it
  overflows. Keep inspector panes vertically stacked.
- App self-terminates after the probe; no cleanup needed.
