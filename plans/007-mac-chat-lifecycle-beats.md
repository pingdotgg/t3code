# 007 — Tool-row lifecycle beats and chat card polish (mac)

- **Status**: DONE
- **Commit**: c9013c976
- **Severity**: MEDIUM
- **Category**: Missed opportunities / cohesion (terminal-state beats, hover, arrival)
- **Estimated scope**: 6 files, ~45 lines

## Problem

Six verified rough edges in the chat timeline, all at moments the user is watching:

1. **Running affordances hard-cut at completion.** `ShimmerBorderModifier` (`LiveActivityMotion.swift:20`) renders `if isActive { … }` with no `.transition`, so the rotating gradient border vanishes in one frame when a tool finishes; `PulseGlowModifier` (`LiveActivityMotion.swift:95-102`) structurally swaps `content.phaseAnimator([0.55, 1.0])` for plain `content`, so a chip caught mid-dip jumps from ~0.55 to 1.0 opacity.
2. **Failure gets the quietest terminal beat.** `ChatTimelineRow.swift:781-783` fires `.successRipple(fire: displayState == .succeeded)` and the status badge (`:934`) bounces only on `.succeeded`; a failed tool — the stream's highest-information event — gets only a red tint recolor.
3. **Tool-row hover timestamp pops.** `ChatTimelineRow.swift:815-821` inserts `TranscriptTimestamp` in an overlay with no `.transition`, while the identical bubble timestamp (`:335`) fades via `.transition(.opacity)`; the `.animation(Motion.feedback, value: isHovering)` at `:823` can't animate an insertion that has no transition.
4. **Plan strip content arrives with a pop.** `PlanProgressStrip` mounts its shell on run start (`ChatScreen.swift:52-57`, eased by the `selectedThreadIsActive` key at `:105`), but `planProgress` going nil→value mid-run is keyed to nothing, so the strip's full height pops in above the composer (`PlanProgressStrip.swift:18-38`, `.transition(Motion.banner)` never fires).
5. **Plan strip live text hard-swaps.** The collapsed strip's current-step title (`PlanProgressStrip.swift:61-67`) has no `.contentTransition`, and the `completed/total` count's `.numericText()` (`:59-60`) has no keyed animation behind it.
6. **Decision cards double-fire their entrance.** `ApprovalCard.swift:71` and `UsageLimitCard.swift:114` carry `.entrance(.card)` and also receive `.entrance(.row)` from the timeline `ForEach` (`ChatTimelineScrollView.swift:162`); both `EntranceModifier`s fire, so travel adds (16pt vs the designed 8) and opacity/scale multiply. These cards render only in the timeline (sole call sites: `ChatTimelineRow.swift:164,172,185`; `PlanCard` has no internal entrance — the intended pattern).
7. **Attachment preview sheet pops spinner→image.** `ChatAttachmentPreviewSheet`'s `.task` (`ChatTimelineRow.swift:527-537`) sets `image`/`phase` with no animation, while the thumbnail for the same image deliberately crossfades (`:471-479`, comment: "Crossfade the spinner into the decoded image").

## Target

```swift
// target — LiveActivityMotion.swift shimmer: fade the border out on completion
content.overlay {
    if isActive {
        shimmerContent          // the existing RM-stroke / TimelineView branches, grouped
            .transition(.opacity)   // rides the row's .animation(Motion.ambient, value: displayState)
    }
}

// target — LiveActivityMotion.swift pulse glow: stay mounted so deactivation
// animates from the current dip back to 1.0 instead of hard-cutting
if Motion.reduceMotion {
    content
} else {
    content.phaseAnimator(isActive ? [0.55, 1.0] : [1.0]) { view, opacity in
        view.opacity(opacity)
    }
}

// target — LiveActivityMotion.swift: generalize the ripple with a color and
// add a failure counterpart (same Motion.burst timing, red ring)
private struct OutcomeRippleModifier: ViewModifier {
    let fire: Bool
    let cornerRadius: CGFloat
    let color: Color
    // …body identical to today's SuccessRippleModifier, but strokes `color`…
}
func successRipple(fire: Bool, cornerRadius: CGFloat) -> some View { /* color: AlpineTheme.statusSuccess */ }
func failureRipple(fire: Bool, cornerRadius: CGFloat) -> some View { /* color: .red */ }
```

```swift
// target — ChatTimelineRow.swift ToolEventRow, after the existing .successRipple(...)
.failureRipple(fire: displayState == .failed, cornerRadius: TranscriptMetrics.iconColumn * 0.32)

// target — ChatTimelineRow.swift statusBadge (~:934): terminal bounce on success OR failure
badge.symbolEffect(.bounce, value: displayState == .succeeded || displayState == .failed)
// (update the :918-921 doc comment: "a success bounces once" → "a terminal success or failure bounces once")

// target — ChatTimelineRow.swift hover timestamp overlay (~:816-820)
if isHovering, let at {
    TranscriptTimestamp(date: at)
        .transition(.opacity)
        .padding(.top, 9)
        .padding(.trailing, hasExpandableContent ? 28 : 12)
}
```

```swift
// target — ChatScreen.swift, immediately after line 105
// The strip's content arrives mid-run (the plan lands after the run starts),
// which `selectedThreadIsActive` doesn't cover — ease that flip too.
.animation(
    Motion.structure,
    value: model.selectedThreadID.flatMap { model.threadState($0)?.planProgress } != nil
)
```

```swift
// target — PlanProgressStrip.swift count (~:56-60)
Text("\(completed)/\(progress.steps.count)")
    .font(.caption.monospacedDigit())
    .foregroundStyle(.secondary)
    .contentTransition(
        Motion.reduceMotion ? .identity : .numericText())
    .animation(Motion.ambient, value: completed)

// target — PlanProgressStrip.swift current-step title (~:61-67)
Text(current.title)
    .font(.callout)
    .foregroundStyle(.secondary)
    .lineLimit(1)
    .truncationMode(.tail)
    .contentTransition(
        Motion.reduceMotion ? .identity : .opacity)
    .animation(Motion.ambient, value: current.title)
    .transition(Motion.rise)
```

```swift
// target — ApprovalCard.swift:68-71 and UsageLimitCard.swift:113-114
// DELETE the trailing `.entrance(.card)` line in both; adjust the comments to
// note the timeline ForEach's `.entrance(.row)` is the single entrance.

// target — ChatTimelineRow.swift ChatAttachmentPreviewSheet .task (~:527-537)
.task(id: attachment.id) {
    phase = .loading
    image = nil
    do {
        let url = try await model.attachmentImageURL(id: attachment.id)
        let loaded = try await loadNSImage(from: url)
        // Crossfade the spinner into the decoded image, mirroring the
        // thumbnail's load(); the ZStack frame is fixed, so this stays
        // a render-only opacity change.
        withAnimation(Motion.reveal) {
            image = loaded
            phase = .loaded
        }
    } catch {
        withAnimation(Motion.reveal) {
            phase = .failed
        }
    }
}
```

## Repo conventions to follow

- All curves from `Theme/Motion.swift`: `Motion.ambient` for status/opacity eases, `Motion.reveal` for content arrival, `Motion.burst` for the ripple. No inline curves, no new durations.
- Ripple gating stays exactly as today: false→true edge only, `consumed` latch, `Motion.profile.allowsDecorativeEffects` gate — only the stroke color is new.
- Exemplar for the completion-beat branch: `SubagentTaskComponents.swift:168-177`.
- Exemplar for the image crossfade: `ChatTimelineRow.swift:463-480` (`load()`).

## Steps

1. `apps/mac/Sources/SergeCodeMac/UI/Chat/LiveActivityMotion.swift` — group the shimmer's two branches and add `.transition(.opacity)`; convert `PulseGlowModifier` to the always-mounted single-phase form; rename `SuccessRippleModifier` → `OutcomeRippleModifier` with a `color: Color` stored property used in `strokeBorder`, and update the `successRipple` / add the `failureRipple` View extensions (doc comments mirror the existing style).
2. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatTimelineRow.swift` — add `.failureRipple(...)` after `.successRipple(...)` (~:783); widen the badge bounce value (~:934) and update its doc comment; add `.transition(.opacity)` to the hover timestamp (~:817); apply the preview-sheet `.task` change (~:527-537).
3. `apps/mac/Sources/SergeCodeMac/UI/Chat/ChatScreen.swift` — add the plan-progress `.animation(Motion.structure, value:)` line after line 105 with the Target comment.
4. `apps/mac/Sources/SergeCodeMac/UI/Chat/PlanProgressStrip.swift` — apply the count and title Target snippets.
5. `apps/mac/Sources/SergeCodeMac/UI/Chat/ApprovalCard.swift:68-71` and `apps/mac/Sources/SergeCodeMac/UI/Chat/UsageLimitCard.swift:109-114` — remove `.entrance(.card)` and reword the adjacent comments to say the timeline row entrance owns arrival.

## Boundaries

- Do NOT change `Motion.swift`, the entrance system, or `EntrancePolicy`.
- Do NOT change what `displayState` means or when `fire` edges occur; hydrated already-complete rows must never replay ripples (the `consumed` latch stays).
- Do NOT animate the shimmer's _appearance_ differently — only its disappearance fades (appearance timing is unchanged, it just gains a transition that also covers appear; that is acceptable and simpler).
- Keep the failure ripple a single restrained ring — no new vocabulary beyond the color parameter.
- If the pulse-glow single-phase change misbehaves in the feel check (visible restart pop), revert just that modifier to the current structural swap and report.
- If a step doesn't match the code you find (drift since commit c9013c976), STOP and report instead of improvising.

## Verification

- **Mechanical**: `swift build --package-path apps/mac` succeeds, then `vp check` and `vp run typecheck` pass.
- **Feel check** (mock backend + UIProbe per `apps/mac/.claude/skills/verify`, or a live thread):
  - Let a tool finish: the shimmer border fades out over ~0.2s instead of vanishing; the icon chip never jumps in opacity.
  - Force a failing tool (e.g. a command that exits non-zero): a single red ring ripples once on the failure edge and the badge bounces once — same visual weight as success.
  - Hover a tool row: the timestamp fades in/out like message-bubble timestamps.
  - Start a run that emits a plan: the strip glides in above the composer (no one-frame shove); as steps complete, the count ticks with numericText and the current-step title crossfades.
  - Watch an approval card and a usage-limit card arrive: single 8pt rise, matching sibling rows (no deeper 16pt travel).
  - Open an image attachment: the spinner crossfades into the image.
  - Reduce Motion on: no ripple, no bounce, no pulse; fades only.
- **Done when**: all six rough edges animate as targeted and the build passes.
