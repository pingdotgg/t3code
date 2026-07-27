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
- `SERGECODE_UI_PROBE_SCENARIO=<name>` runs one focused scenario instead of
  the default sweep. `sidebar-menus` synthesizes a right-click on *every* row
  of the sidebar table — scrolling to reach rows below the fold, and failing
  the run if one never gets there — and asserts each opens an Alpine popover
  (never an `NSMenu`). It seeds a settled session — failing the run if it
  cannot — and opens the settled disclosure via `.uiProbeToggleSection` so all
  four menu variants exist: project, thread/settle, thread/unsettle,
  settled-disclosure. The reveal is keyed on the model having a settled
  session, not on what the first walk saw, and the receiver unions rather than
  toggles (a toggle closed the disclosure on redelivery). Captures land
  as `menu-p<pass>-row<N>.png` plus a `-content` version; judge the
  `-content` one, since the window's theme frame carries the system glass rim
  that `cacheDisplay` turns into a saturated halo.
- Success is the final `UIProbe: done` line with no `FAIL=` suffix. Soft
  check failures and the watchdog timeout both report as
  `UIProbe: done FAIL=<reasons>`; a failed capture prints
  `UIProbe: FAIL encode|write ...` instead of `UIProbe: wrote ...`.
- The probe self-terminates after 300 s if an await wedges (live-backend
  runs can stall on the sidecar). Override with
  `SERGECODE_UI_PROBE_TIMEOUT=<seconds>`.
- `SERGECODE_PLAYFUL_MOTION=0` (DEBUG only) renders every playful surface —
  the live activity dock's aurora orb, the auto-review pet — in its opt-out
  presentation for the whole run, so the fallbacks can be captured. Re-run
  the probe with it to check both sides of that branch. It never writes the
  stored preference.
  - Do NOT try to reach the fallback by flipping `PlayfulMotionPreferences`
    mid-run instead: the change notification fires and the policy re-resolves
    (logged `surfaces=false`), but the offscreen `cacheDisplay` capture is
    taken before SwiftUI flushes the resulting update, so the PNG still shows
    the old presentation and the capture silently lies. Same trap for any
    other state a probe mutates on an already-mounted view — set it before
    the first render.

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
  swift test --package-path apps/mac --no-parallel \
    -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
    -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
    -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib \
    -Xlinker -rpath -Xlinker '@loader_path/../../..'
  ```
  `--no-parallel` matches CI: the timeline caches are process-wide statics, so
  one suite's `resetForTesting()` can land inside another suite's counter
  assertions and flake `AppModelTimelineEvictionTests`. Parallelism buys
  nothing here — the MainActor tests already serialize on the main thread.
  The third rpath is what lets the app test bundle find
  `Sparkle.framework` next to it in `Products/Debug`; without it
  `SergeCodeMacTests` dies with "Failed to open test bundle" and only the
  T3Kit/SidecarKit suites run — while the command still looks like it passed.
- The inspector column is 300–480pt wide: any side-by-side split inside it
  overflows. Keep inspector panes vertically stacked.
- App self-terminates after the probe; no cleanup needed.
