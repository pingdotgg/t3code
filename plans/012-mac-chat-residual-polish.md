# 012 — Residual chat polish: settle cue, live text crossfades, hover parity (mac)

- **Status**: DONE
- **Commit**: c9013c976 (authored); applied after the rebase onto `c0e157d37`
- **Severity**: LOW
- **Category**: Easing & duration / cohesion / accessibility
- **Estimated scope**: 4 files, ~15 lines

## Problem

Five LOW findings from the same audit that produced plans 006–011; they were
presented in the findings table but did not fit any plan's file seam, so they
were collected here:

1. **Stream-end settle cue flickers** — `MarkdownContent.swift:832`: the 60%
   opacity dip was a bare assignment (instant), only the restore eased.
2. **Reasoning rows snap on in-place rewrites** — `ChatTimelineRow.swift`
   `ReasoningRow`: `Text(text)` had no `.contentTransition`; task progress
   streams replace the text in place.
3. **Agent-log subtitle crossfade was dead mid-run** — `DelegatedTaskCard.swift:97`:
   `.contentTransition(.opacity)` was driven only by `.animation(value: task.state)`,
   which doesn't change while the task runs and the subtitle churns.
4. **Message-action press scale ignored Reduce Motion** — `MessageActions.swift:81`:
   `.scaleEffect(configuration.isPressed ? 0.94 : 1)` ungated.
5. **`ToolGroupRow` had no hover response** — the most-clicked disclosure row
   in the transcript was inert while every sibling row reacts to hover.

## Target (as applied)

1. Dip eases in on the feedback curve: `withAnimation(Motion.feedback) { streamSettleOpacity = 0.6 }`; restore unchanged (`withDeferredAnimation(Motion.reveal)`).
2. Reasoning text: `.contentTransition(Motion.reduceMotion ? .identity : .opacity)` + `.animation(Motion.ambient, value: text)`.
3. Subtitle: `.animation(Motion.ambient, value: subtitle)` on the Text (keyed on the content, not the task state).
4. `.scaleEffect(configuration.isPressed && !Motion.reduceMotion ? 0.94 : 1)`.
5. `ToolGroupRow` card fill lifts `.quaternary.opacity(0.4 → 0.55)` on hover via `@UIState isHovering` + `.animation(Motion.feedback, value: isHovering)`.

## Verification

- `swift build --package-path apps/mac` clean; `vp check` / `vp run typecheck` pass.
- Feel: stream a reply and watch the end-of-stream dip ease rather than flicker;
  watch a reasoning row and a delegated-task subtitle crossfade on updates;
  hover a "Ran N tools" group; press a message-action icon under Reduce Motion
  (no scale, brightness feedback stays).
