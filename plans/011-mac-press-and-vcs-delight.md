# 011 — Press feedback scale + VCS success delight (executes re-baselined 001 & 004)

- **Status**: DONE
- **Commit**: c9013c976
- **Severity**: MEDIUM
- **Category**: Physicality & origin (press feedback) / missed opportunity (delight budget)
- **Estimated scope**: 2 files, ~12 lines, plus status flips in plans/001 and plans/004

## Problem

This plan re-baselines and executes plans **001** and **004**, which drifted:

- **001 (press feedback)** is _partially_ implemented: both custom ButtonStyles already animate the pressed fill via `.animation(Motion.feedback, value: configuration.isPressed)` (`ChatFollowUpBar.swift:233`, `VcsToolbar.swift:681`), but neither has the plan's core deliverable — the Reduce-Motion-gated press **scale**. Fills also drifted (both now `AlpineTheme.accent.opacity(configuration.isPressed ? 0.72 : 1)` with `AlpineTheme.forest` labels): keep the drifted fills, add only the scale.
- **004 (VCS success delight)** is _fully unimplemented_: `VcsToolbar.swift:92` is still unconditional `.animation(Motion.reveal, value: model.lastGitActionOutcome(for: threadID))`, and `outcomeBanner` (`:626-629`) has no `.symbolEffect(.bounce)`. The VCS outcome banner is a rare, high-emotion success moment using the generic reveal instead of the reserved `Motion.delight` tier.

## Target

```swift
// target — ChatFollowUpBar.swift NatureActionButtonStyle (~:221-234) and
// VcsToolbar.swift VcsMergePillButtonStyle (~:669-682): insert ONE line
// immediately before the existing `.animation(Motion.feedback, value: configuration.isPressed)`:
.scaleEffect(configuration.isPressed && !Motion.reduceMotion ? 0.97 : 1)
```

```swift
// target — VcsToolbar.swift:92 — success takes the delight spring, failures stay sober
.animation(
    model.lastGitActionOutcome(for: threadID)?.success == true
        ? Motion.delight
        : Motion.reveal,
    value: model.lastGitActionOutcome(for: threadID)
)
```

```swift
// target — VcsToolbar.swift outcomeBanner(_:) icon (~:626-629)
let icon = Image(systemName: outcome.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
    .foregroundStyle(outcome.success ? .green : .red)
if Motion.reduceMotion || !outcome.success {
    icon
} else {
    icon.symbolEffect(.bounce, value: outcome)
}
```

Keep `.transition(Motion.banner)` unchanged — only the curve driving it changes. Failures must never bounce.

## Repo conventions to follow

- All curves from `Theme/Motion.swift`: `Motion.feedback` (press, 0.14s strong ease-out), `Motion.delight` (`.spring(duration: 0.40, bounce: 0.18)`, reserved for rare success), `Motion.reveal` (default arrival). No inline curves.
- Scale band 0.95–0.98 per the motion audit; 0.97 matches `EmptyStateView.swift:162`.
- Reduce Motion: scale skipped entirely (fill-opacity change remains as accessible feedback); `Motion.delight`/`Motion.reveal` already collapse internally.
- Completion-beat exemplar: `SubagentTaskComponents.swift:168-177`. `GitActionOutcome` is `Hashable` (`Model/Entities.swift:1206`), so it can be a `symbolEffect` value directly.

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatFollowUpBar.swift` — in `NatureActionButtonStyle.makeBody`, insert the `.scaleEffect(...)` line before the existing `.animation(Motion.feedback, …)` (line ~233).
2. `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` — same insertion in `VcsMergePillButtonStyle.makeBody` (line ~681).
3. `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift:92` — replace the unconditional `.animation(Motion.reveal, value: …)` with the conditional Target. Leave the adjacent `.animation(Motion.ambient, value: status)` untouched.
4. `apps/mac/Sources/SergeCodeMac/UI/Shell/VcsToolbar.swift` — restructure the `outcomeBanner(_:)` icon per the Target (~:626-629).
5. `plans/001-mac-press-feedback-buttonstyles.md` and `plans/004-mac-vcs-success-delight.md` — set Status to `DONE (re-baselined at c9013c976, executed via plan 011)`.

## Boundaries

- Do NOT change the pressed fill values (`AlpineTheme.accent.opacity(0.72 : 1)`) or any layout/padding/shadow.
- Do NOT make failures bouncy — `Motion.reveal` and the plain-icon branch for `outcome.success == false`.
- Do NOT touch `Motion.swift`, `.transition(Motion.banner)`, the banner's text, or the "Open PR"/dismiss buttons.
- Do NOT add scale values other than 0.97.
- If the code doesn't match the excerpts (further drift since c9013c976), STOP and report.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass.
- **Feel check**:
  - Press and hold a follow-up action button under a finished turn, and the merge pill: settles to 97% scale with a fast-then-soft ease; release returns on the same 0.14s curve — no spring, no overshoot. Rapid clicks retarget smoothly.
  - Create a PR / merge: the banner arrives with a soft spring settle (~400ms, one gentle overshoot); the checkmark plays a one-shot bounce when a new success replaces a visible outcome. (Known limitation from plan 004: `.symbolEffect(.bounce, value:)` fires on value _change_, so the very first insertion may not bounce — the delight spring carries that beat. Confirm, don't fight it.)
  - Force a failure (e.g. failed push): sober `Motion.reveal`, plain xmark, no bounce — including a failure replacing a visible success.
  - Reduce Motion on: no scale on press (fill still dims), banner fades in, no symbol bounce.
- **Done when**: press scale and success/failure motion divergence are visible as targeted, plans 001/004 are marked DONE, and the build passes.
