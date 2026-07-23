# Motion Everywhere (SER-144) — Design

## Context

SER-144 asks that no UI in the native macOS app ever appear instantly. Every
change — whether the user caused it or an agent event did — should animate in.

The app already has a motion system. `Theme/Motion.swift` holds seven curves and
six transitions, all gated on macOS Reduce Motion, with roughly 160 call sites.
The 2026-07-13 motion refinement design established that vocabulary and, for
performance, deliberately removed animation from several paths: per-keystroke
composer layout, streaming token deltas, initial history hydration, thread
selection, and full-collection refreshes.

SER-144 partially reverses that decision. Hydration and navigation must animate.
Typing and streaming deltas must not — animating those is what caused the typing
lag, scroll judder, and blanked `LazyVStack` frames the earlier pass fixed.

Scope is `apps/mac` only. The Expo/React Native companion has no motion system
and is out of scope for this work.

## Goals

- Every surface that presents content animates its arrival.
- Restored history and thread/pane switches animate, with a bounded stagger.
- Interactive controls have consistent hover and press feedback.
- No regression in typing latency, scroll stability, or streaming smoothness.
- Reduce Motion still produces a visible, non-instant change.

## Non-goals

- Redesigning layout, color, typography, or the Liquid Glass treatment.
- Animating per-keystroke composer layout or streaming token growth.
- Animating programmatic scroll anchoring.
- Changing `Motion.swift`'s existing curves or transitions.
- Touching the mobile app, the server, or provider behavior.
- A CI lint guardrail for future views (considered, deferred).

## Architecture

Two new files under `apps/mac/Sources/SergeCodeMac/Theme/`, composing on top of
the existing `Motion` enum rather than replacing it.

### `EntrancePolicy.swift` — pure policy

No SwiftUI imports, mirroring how `MotionProfile` already separates testable
policy from SwiftUI tokens.

```swift
struct EntrancePolicy: Equatable, Sendable {
    let reduceMotion: Bool

    let staggerStep = 0.028   // seconds between adjacent siblings
    let maxStaggered = 8      // delay clamps past this index

    func delay(forIndex index: Int) -> Double
}
```

`delay(forIndex:)` returns `0` when `reduceMotion` is true, and otherwise
`min(index, maxStaggered) * staggerStep`. The clamp matters: without it a
restored thread with 200 rows would ripple for nearly six seconds. Clamped, the
longest stagger is 224 ms regardless of list length.

### `Entrance.swift` — SwiftUI layer

- `enum EntranceRole { case row, card, pane, control }`. Each role maps to an
  existing `Motion` curve and an offset amount. No new curves are introduced.
- `.entrance(_ role: EntranceRole, index: Int = 0)` — a view modifier that plays
  a one-shot opacity and offset animation the first time that view identity
  appears, delayed by `EntrancePolicy.delay(forIndex:)`.
- `entranceSuppressed` — an environment value letting a container disable
  entrance for its subtree. Reuses the conditions behind
  `ChatTimelineScrollView`'s existing `suppressLayoutAnimation`.

Per `apps/mac/CLAUDE.md`, the modifier stores its played/not-played flag in
`@UIState` (never `@State`), and `entranceSuppressed` uses a manual
`EnvironmentKey` conformance (never `@Entry`). Both are Xcode-only compiler
macros under this SDK and would break the command-line build.

### Why local state, not a transition

`.entrance` animates the view's own opacity and offset from local state. It is
deliberately **not** implemented as a SwiftUI `.transition`.

A transition only plays when the *parent* animates the insertion. That is
exactly what `ChatTimelineScrollView` suppresses (`.animation(revealAnimation,
value: displayItems.count)` plus a `transaction` that clears the animation) to
stop the `LazyVStack` re-measuring realized rows mid-stream. Building entrance
on transitions would require re-enabling parent layout animation and would
reintroduce the judder and blank frames.

Local per-view state animates a row in without any parent layout animation, so
no sibling is re-measured. This is what lets hydration animate while the
performance carve-outs stay intact.

## Surface Behavior

### Chat timeline

- Restored history: rows get `.entrance(.row, index:)` using their position in
  the first realized layout pass. Stagger clamps at index 8. Plays once per
  thread mount.
- Live appended rows: `.entrance(.row)` at index 0 — no delay, just the rise.
  The existing `Motion.rise` transition stays for the settled-thread case.
- Unchanged: programmatic `scrollTo` still lands instantly under
  `transaction.disablesAnimations`; streaming token deltas are still unanimated;
  tool-regroup identity swaps mid-run stay suppressed via `entranceSuppressed`.

### Navigation and panes

- `ThreadDetailView`, `InspectorPanel`, and the `ContentView` detail column take
  `.entrance(.pane)` keyed on thread identity, so switching threads settles
  instead of hard-cutting.
- `ContentView` already animates the empty/populated boundary. Extend it to the
  populated-to-populated switch.

### Cards with no motion today

`ApprovalCard`, `UsageLimitCard`, the `PlanCard` detail body, and
`SubagentInnerThreadView` rows take `.entrance(.card)` or `.entrance(.row,
index:)`. `ApprovalCard` is the most visible defect today: an agent permission
prompt materializes instantly in the middle of the transcript.

### Lists

`SidebarView` groups, `ChangesTimelineView` entries, `DiffReviewView` file rows,
and `PullRequestReviewView` sections take `.entrance(.row, index:)` on first
render. Per-row insertion and removal keeps `Motion.reveal` scoped to the row,
never to the whole collection.

### Chrome and occasional scenes

`SettingsScene` tab bodies, `AutoReviewSettingsTab`, `ScenerySettingsTab`,
`AboutView`, and `NewSessionSheet` content take `.entrance(.pane)`. Native sheet
and popover presentation motion is left to the system; custom content does not
layer a second animation on top.

### Controls

Sweep `AlpineControls`, `ProviderIcon`, `ToolbarChrome`, `ComposerControls`, and
`VcsToolbar` for interactive elements missing hover and press feedback.
`SidebarView` already shows the intended pattern
(`.animation(Motion.feedback, value: isHovering)`); it should be universal.

### Explicitly still instant

Per-keystroke composer layout, streaming text growth, programmatic scroll
anchoring, and keyboard-initiated send. These carry over unchanged from the
2026-07-13 design.

## Accessibility

- With Reduce Motion on, `EntrancePolicy` returns zero delay and the modifier
  drops its offset, leaving a short opacity fade. The result is still not an
  instant pop, so SER-144's intent survives while movement is removed.
- Entrance is decorative. No control's availability, focus, or hit-testing
  depends on an animation having completed.
- Hover-driven motion stays pointer-only and never attaches to keyboard focus.

## Performance

- Entrance state is per-view and local, so it never triggers a parent layout
  animation or a sibling re-measure.
- Stagger delay is clamped, bounding total entrance time independent of list
  length.
- Each entrance plays once per view identity and does not replay on scroll,
  re-render, or rehydration.
- `entranceSuppressed` disables the subtree during streaming and structural
  regroups, preserving the existing suppression behavior.

## Testing

Automated:

- New `EntrancePolicyTests` alongside `MotionTests`: delay progression, the
  index clamp, zeroing under Reduce Motion, and play-once semantics.
- `swift build --package-path apps/mac`.
- `swift test --package-path apps/mac` with the swift-testing plugin path and
  the two runtime rpaths documented in `apps/mac/CLAUDE.md`.
- `vp check` and `vp run typecheck`.

Manual:

- Use the `apps/mac:verify` skill (mock backend plus the in-process UIProbe
  self-capture hook) to confirm entrance on hydration, thread switch, and
  approval card arrival.
- Repeat with Reduce Motion enabled.
- Watch for typing lag, scroll instability, blank `LazyVStack` frames, or
  entrance replaying on scroll. Any of those is a failure.

## Acceptance Criteria

- No surface listed in Surface Behavior appears without animation.
- Restored history and thread switches animate, with stagger clamped to 8 steps.
- Typing, streaming deltas, and scroll anchoring remain unanimated.
- Reduce Motion yields a fade with no offset and no delay.
- Entrance never replays for the same view identity.
- Native build and tests, `vp check`, and `vp run typecheck` all pass.

## Version Impact

None. This is rolling/pending work; `apps/mac/version.json` is not modified and
no release artifacts are produced.
