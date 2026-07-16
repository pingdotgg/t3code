# 002 — Give the working pill and pending cards symmetric exits (mobile)

- **Status**: TODO
- **Commit**: 774d2f560
- **Severity**: MEDIUM
- **Category**: Physicality & origin (asymmetric enter/exit)
- **Estimated scope**: 1 file, ~3 lines

## Problem

In `ThreadDetailScreen`, the `WorkingDurationPill` enters with `bannerDrop()` and the pending approval / user-input cards enter with `materialize()` — but both are removed by a ternary flipping to `null`, so they vanish in a single frame. The pill's disappearance _is_ the "turn finished" moment; the card's disappearance is the response to the user approving. Entering animated + exiting snapped is exactly the asymmetric-dismissal seam: surfaces should leave the way they arrived (or at least gracefully).

```tsx
// apps/mobile/src/features/threads/ThreadDetailScreen.tsx:516 — current
{props.activeWorkStartedAt &&
!threadHealth?.stalled &&
props.selectedThread.session?.status !== "waiting" ? (
  <Animated.View entering={bannerDrop()}>
    <WorkingDurationPill startedAt={props.activeWorkStartedAt} />
  </Animated.View>
) : null}

{props.activePendingApproval || props.activePendingUserInput ? (
  <Animated.View
    entering={materialize()}
    className="gap-3 px-4 pb-3"
    style={{ flexShrink: 0 }}
  >
```

## Target

Both `Animated.View`s gain `exiting={FadeOut.duration(150)}`. A quick fade-out (no movement) is the right exit: it doesn't compete with the assistant message settling at the same moment, it matches the app's established 200-in / 150-out convention, and it is Reduce-Motion-safe by construction (opacity only — fades are this app's accessible remainder, per the policy comment in `src/lib/motion.ts`).

```tsx
// target
<Animated.View entering={bannerDrop()} exiting={FadeOut.duration(150)}>
  <WorkingDurationPill startedAt={props.activeWorkStartedAt} />
</Animated.View>
...
<Animated.View
  entering={materialize()}
  exiting={FadeOut.duration(150)}
  className="gap-3 px-4 pb-3"
  style={{ flexShrink: 0 }}
>
```

## Repo conventions to follow

- Motion tokens live in `apps/mobile/src/lib/motion.ts`; entering presets `bannerDrop()`/`materialize()` come from there and stay unchanged.
- The exit convention exemplar — `apps/mobile/src/features/threads/GitActionProgressOverlay.tsx:47-49`:
  ```tsx
  <Animated.View
    entering={FadeIn.duration(200)}
    exiting={FadeOut.duration(150)}
  ```
- `ThreadDetailScreen.tsx:24` already imports from reanimated: `import Animated, { runOnJS } from "react-native-reanimated";` — extend that import.

## Steps

1. `apps/mobile/src/features/threads/ThreadDetailScreen.tsx:24` — change the import to:
   ```tsx
   import Animated, { FadeOut, runOnJS } from "react-native-reanimated";
   ```
2. Same file, `WorkingDurationPill` wrapper (~line 518): add `exiting={FadeOut.duration(150)}` to the `Animated.View`.
3. Same file, pending approval/user-input wrapper (~line 525): add `exiting={FadeOut.duration(150)}` to that `Animated.View`.

## Boundaries

- Do NOT touch the entering presets, `motion.ts`, `WorkingDurationPill`, or the card components.
- Do NOT add exit _movement_ (no SlideOut/translate) — fade only, 150ms exactly.
- Do NOT wrap anything inside `ThreadFeed`'s recycled list rows — these two wrappers live in the composer overlay area, outside the list; if you find they are inside a recycled list row, STOP and report.
- If the code doesn't match the excerpts (drift since commit 774d2f560), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir apps/mobile typecheck` (script: `tsc --noEmit`) passes, then `vp check` and `vp run typecheck` pass (repository requirement before any work counts as complete).
- **Feel check** (simulator or device, real agent turn or mocked state):
  - Let a turn finish: the working pill fades out over ~150ms instead of blinking away; the assistant message settling underneath is not obscured.
  - Approve a pending approval: the card fades out; tapping approve twice quickly never leaves a ghost card or replays the entrance.
  - Enable iOS Reduce Motion: entrances lose their drift/scale (spring collapses via `ReduceMotion.System`), exits still fade.
- **Done when**: both wrappers have `exiting={FadeOut.duration(150)}`, typecheck passes, and exits read as symmetric with entries.
