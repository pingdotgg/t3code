# 003 — Animate ErrorBanner mount/unmount (mobile)

- **Status**: TODO
- **Commit**: 774d2f560
- **Severity**: MEDIUM
- **Category**: Missed opportunity (preventing a jarring change)
- **Estimated scope**: 1 file, ~5 lines

## Problem

`ErrorBanner` is a static `View`. Six call sites mount/unmount it conditionally (`{error ? <ErrorBanner .../> : null}` in `ConnectionsNewRouteScreen.tsx:239`, `AddProjectScreen.tsx:565,637,720,804`, `PullRequestReviewScreen.tsx:200`), so errors pop into the layout in a single frame and vanish the same way — the exact "teleporting state" seam, on a surface whose whole job is to draw calm attention.

```tsx
// apps/mobile/src/components/ErrorBanner.tsx — current (entire file)
import { View } from "react-native";

import { AppText as Text } from "./AppText";
export function ErrorBanner(props: { readonly message: string }) {
  return (
    <View className="rounded-2xl border border-rose-300/70 bg-rose-100/80 px-3.5 py-3 dark:border-rose-400/28 dark:bg-rose-500/12">
      <Text className="font-t3-medium text-sm text-rose-700 dark:text-rose-300">
        {props.message}
      </Text>
    </View>
  );
}
```

## Target

The banner's root becomes an `Animated.View` with the app's banner entrance and the standard 150ms fade exit. Fixing it inside the component upgrades all six call sites at once; reanimated runs `exiting` automatically when the parent's conditional unmounts the component.

```tsx
// target (entire file)
import Animated, { FadeOut } from "react-native-reanimated";

import { bannerDrop } from "../lib/motion";
import { AppText as Text } from "./AppText";
export function ErrorBanner(props: { readonly message: string }) {
  return (
    <Animated.View
      entering={bannerDrop()}
      exiting={FadeOut.duration(150)}
      className="rounded-2xl border border-rose-300/70 bg-rose-100/80 px-3.5 py-3 dark:border-rose-400/28 dark:bg-rose-500/12"
    >
      <Text className="font-t3-medium text-sm text-rose-700 dark:text-rose-300">
        {props.message}
      </Text>
    </Animated.View>
  );
}
```

`bannerDrop()` (from `apps/mobile/src/lib/motion.ts:92`) = opacity 0→1 over 240ms `Easing.out(Easing.ease)` + translateY −8→0 on the `MOTION_SNAP` spring (280ms, dampingRatio 1, `ReduceMotion.System`). Do not re-implement it inline — import it.

## Repo conventions to follow

- Entering presets live in `apps/mobile/src/lib/motion.ts`; `bannerDrop()` is the designated banner/pill entrance.
- Exit convention exemplar: `apps/mobile/src/features/threads/GitActionProgressOverlay.tsx:47-49` uses `exiting={FadeOut.duration(150)}`.
- uniwind `className` works on `Animated.View` the same as `View` (see `GitActionProgressOverlay.tsx` for an Animated.View in the same codebase).

## Boundaries

- Do NOT touch the six call sites — the fix is entirely inside `ErrorBanner.tsx`.
- Do NOT change the banner's styling classes or the `message` prop shape.
- Do NOT use `rise()`/`materialize()` — `bannerDrop()` is the semantically correct preset for a banner.
- If `ErrorBanner.tsx` doesn't match the excerpt (drift since commit 774d2f560), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir apps/mobile typecheck` passes.
- **Feel check**: in the Add Project flow, submit an invalid path (or force any error state):
  - The banner drops in from 8px above with a fade — it does not shove surrounding content abruptly (the layout shift still happens; the drop+fade bridges it).
  - When the error clears, the banner fades out over 150ms.
  - Trigger error → clear → error rapidly: no doubled banners, no replayed entrance mid-exit.
  - iOS Reduce Motion on: no drop movement (spring collapses via `ReduceMotion.System`), fade in/out remains.
- **Done when**: all six call sites show animated enter/exit with zero call-site changes, and typecheck passes.
