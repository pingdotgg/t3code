# 004 — Give PR-created / merge success the delight tier (mac)

- **Status**: TODO
- **Commit**: 774d2f560
- **Severity**: LOW
- **Category**: Missed opportunity (delight budget on rare success)
- **Estimated scope**: 1 file, ~10 lines

## Problem

The VCS outcome banner ("PR created", "Merged", push results) is a rare, high-emotion success moment, but it enters with the same generic `Motion.reveal` + `Motion.banner` as any status change — the delight budget the motion system reserves for exactly this (`Motion.delight`, documented "a one-shot accent for rare successful state transitions") goes unused.

```swift
// apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift:126 — current
            if let outcome = model.lastGitActionOutcome(for: threadID) {
                outcomeBanner(outcome)
                    .transition(Motion.banner)
            }

            Divider()
        }
        .animation(Motion.reveal, value: model.lastGitActionOutcome(for: threadID))
```

```swift
// apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift:304 — current (banner icon)
    private func outcomeBanner(_ outcome: GitActionOutcome) -> some View {
        HStack(spacing: 8) {
            Image(systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(outcome.success ? .green : .red)
```

## Target

Success outcomes animate in on `Motion.delight` (`.spring(duration: 0.40, bounce: 0.18)`); failures keep the sober `Motion.reveal`. The checkmark gets the app's established completion-beat symbol effect, Reduce-Motion-gated.

```swift
// target — animation selection (line ~133)
        .animation(
            model.lastGitActionOutcome(for: threadID)?.success == true
                ? Motion.delight
                : Motion.reveal,
            value: model.lastGitActionOutcome(for: threadID)
        )
```

```swift
// target — banner icon inside outcomeBanner(_:)
            let icon = Image(systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(outcome.success ? .green : .red)
            if Motion.reduceMotion {
                icon
            } else {
                icon.symbolEffect(.bounce, value: outcome)
            }
```

Keep `.transition(Motion.banner)` unchanged — the drop-from-edge shape is right; only the curve driving it changes.

## Repo conventions to follow

- All curves come from `apps/mac/Sources/SergeCodeMac/Theme/Motion.swift`; `Motion.delight` is defined there (line ~71) for exactly this purpose. No inline springs.
- The completion-beat exemplar — `apps/mac/Sources/SergeCodeMac/UI/Chat/SubagentTaskComponents.swift:168-177`:
  ```swift
  if Motion.reduceMotion {
      icon
  } else {
      // Completion beat: only a live transition into success bounces.
      icon.symbolEffect(.bounce, value: task.state == .completed)
  }
  ```
- `GitActionOutcome` is `Hashable` (`Model/Entities.swift:1206`), so it can be a `symbolEffect` value directly.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` (~line 133): replace `.animation(Motion.reveal, value: model.lastGitActionOutcome(for: threadID))` with the conditional-curve version above. Leave the adjacent `.animation(Motion.ambient, value: status)` untouched.
2. Same file, `outcomeBanner(_:)` (~line 304): restructure the `Image` per the target — bind it to a local `let icon`, then branch on `Motion.reduceMotion`, applying `.symbolEffect(.bounce, value: outcome)` only in the non-reduced branch.

## Boundaries

- Do NOT change `.transition(Motion.banner)`, the banner's layout, text, "Open PR" button, or dismiss button.
- Do NOT make failures bouncy — `Motion.reveal` and the plain icon for `outcome.success == false` (the `.bounce` value only changes when `outcome` changes; that is acceptable).
- Do NOT touch `Motion.swift`.
- If the code doesn't match the excerpts (drift since commit 774d2f560), STOP and report.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds.
- **Feel check** (`apps/mac:verify` skill with mock backend, or live git action):
  - Create a PR / merge: the banner arrives with a soft spring settle (one gentle overshoot, ~400ms), noticeably warmer than other banners but not cartoonish.
  - Force a failed push: the banner arrives with the standard crisp reveal — no bounce anywhere.
  - Known limitation to confirm rather than fight: `.symbolEffect(.bounce, value:)` fires on *value change*, so the checkmark may not bounce on the banner's very first insertion (the delight spring carries that beat); it bounces when a new success replaces a visible outcome. If this reads as inconsistent in the feel check, report it — do not add workarounds like delayed state toggles.
  - Reduce Motion on: banner fades in (transition collapses to opacity), no spring, no symbol bounce.
- **Done when**: success and failure visibly diverge in motion tone, Reduce Motion shows plain fades, and the build passes.
