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
PROBE_DIR=$(mktemp -d /tmp/sergecode-probe.XXXXXX)
SERGECODE_UI_PROBE="$PROBE_DIR" apps/mac/.build/debug/SergeCodeMac --mock
```

Use a fresh `mktemp -d` directory every run: several agents drive this repo
from separate worktrees at once, and a shared fixed path means one run reads
another's PNGs (or a crashed run's leftovers). The probe echoes
`UIProbe: dir <path>` so the captures in stdout are self-identifying.

- `--mock` / `SERGECODE_MOCK=1` swaps in `MockBackend` (threads, diffs,
  approvals, plan fixtures) — see `Sources/SergeCodeMac/Model/MockBackend.swift`.
- `SERGECODE_UI_PROBE=<dir>` (DEBUG builds only) activates
  `Sources/SergeCodeMac/Support/UIProbe.swift`: selects the first thread,
  writes window PNGs into `<dir>` via in-process `cacheDisplay` (no TCC
  prompt), scrolls the diff panel's NSScrollView programmatically, logs
  `UIProbe:` lines to stdout, then quits itself. Extend that file to drive
  new flows; keep it `#if DEBUG`.
- Success is the final `UIProbe: done` line with no `FAIL=` suffix. Soft
  check failures and the watchdog timeout both report as
  `UIProbe: done FAIL=<reasons>`; a failed capture prints
  `UIProbe: FAIL encode|write ...` instead of `UIProbe: wrote ...`.
- The probe self-terminates after 300 s if an await wedges (live-backend
  runs can stall on the sidecar). Override with
  `SERGECODE_UI_PROBE_TIMEOUT=<seconds>`.

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
    -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib \
    -Xlinker -rpath -Xlinker '@loader_path/../../..'
  ```
  The third rpath is what lets the app test bundle find
  `Sparkle.framework` next to it in `Products/Debug`; without it
  `SergeCodeMacTests` dies with "Failed to open test bundle" and only the
  T3Kit/SidecarKit suites run — while the command still looks like it passed.
- The inspector column is 300–480pt wide: any side-by-side split inside it
  overflows. Keep inspector panes vertically stacked.
- App self-terminates after the probe; no cleanup needed.
