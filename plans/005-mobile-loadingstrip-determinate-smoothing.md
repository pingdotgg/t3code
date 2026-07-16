# 005 — Smooth the determinate LoadingStrip (mobile)

- **Status**: TODO
- **Commit**: 774d2f560
- **Severity**: LOW
- **Category**: Missed opportunity (state indication)
- **Estimated scope**: 1 file, ~25 lines

## Problem

`LoadingStrip`'s indeterminate variant animates on the UI thread, but the determinate variant sets its fill width directly from props — progress jumps between values in single-frame steps instead of flowing.

```tsx
// apps/mobile/src/components/LoadingStrip.tsx:78 — current
export function LoadingStrip(props: { readonly progress?: number }) {
  if (props.progress === undefined) {
    return <IndeterminateLoadingStrip />;
  }

  const clampedProgress = Math.min(1, Math.max(0, props.progress));

  return (
    <LoadingStripFrame>
      <View
        className="h-full rounded-r-full bg-primary"
        style={{ width: `${clampedProgress * 100}%` }}
      />
    </LoadingStripFrame>
  );
}
```

## Target

A `DeterminateLoadingStrip` component that eases the fill toward each new progress value with `MOTION_AMBIENT` (`withTiming`, 300ms, `Easing.inOut(Easing.ease)`, `ReduceMotion.System`) — the token designated for "passive drift — status tints, progress".

```tsx
// target — new component in the same file
function DeterminateLoadingStrip(props: { readonly progress: number }) {
  const clampedProgress = Math.min(1, Math.max(0, props.progress));
  const animatedProgress = useSharedValue(clampedProgress);

  useEffect(() => {
    animatedProgress.value = withTiming(clampedProgress, MOTION_AMBIENT);
  }, [animatedProgress, clampedProgress]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${animatedProgress.value * 100}%`,
  }));

  return (
    <LoadingStripFrame>
      <Animated.View className="h-full rounded-r-full bg-primary" style={fillStyle} />
    </LoadingStripFrame>
  );
}

export function LoadingStrip(props: { readonly progress?: number }) {
  if (props.progress === undefined) {
    return <IndeterminateLoadingStrip />;
  }
  return <DeterminateLoadingStrip progress={props.progress} />;
}
```

Note on the transform-and-opacity-only rule: this animates `width`, which is normally a finding — but the strip is a 2px-high, absolutely-positioned, `pointerEvents="none"` bar whose only child is the fill; its layout affects nothing else, and the existing indeterminate variant already animates `width` in its `useAnimatedStyle` (line ~66). Consistency and simplicity win here; do not convert to a `scaleX` transform (it would distort the `rounded-r-full` end cap).

## Repo conventions to follow

- Motion tokens live in `apps/mobile/src/lib/motion.ts`; import `MOTION_AMBIENT` from there (defined at line ~46). Never inline a duration/easing.
- The file already imports `Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming }` from `react-native-reanimated` and `useEffect` from React — extend those imports as needed, remove nothing used by the indeterminate variant.
- `MOTION_AMBIENT` carries `ReduceMotion.System`: under Reduce Motion the width snaps, which is the correct degraded behavior — no extra gating needed.

## Steps

1. `apps/mobile/src/components/LoadingStrip.tsx` — add `import { MOTION_AMBIENT } from "../lib/motion";` (match the relative-path style of the file's existing imports).
2. Add the `DeterminateLoadingStrip` component above the exported `LoadingStrip`, per the target.
3. Replace the exported `LoadingStrip`'s determinate branch with `return <DeterminateLoadingStrip progress={props.progress} />;`.

## Boundaries

- Do NOT touch `IndeterminateLoadingStrip` or `LoadingStripFrame`.
- Do NOT change the `LoadingStrip` public prop shape (`progress?: number`).
- Do NOT switch to `scaleX`, `LinearGradient`, or any new dependency.
- If the file doesn't match the excerpt (drift since commit 774d2f560), STOP and report.

## Verification

- **Mechanical**: `pnpm --dir apps/mobile typecheck` passes.
- **Feel check**: trigger a determinate progress flow (git action with progress) or temporarily drive `<LoadingStrip progress={x}/>` with stepped values in a scratch screen:
  - Progress flows between steps over ~300ms instead of jumping.
  - Rapid successive updates retarget smoothly (withTiming retargets from the current value; no restart-from-zero).
  - Progress arriving at 1 then unmounting doesn't flash backward.
  - iOS Reduce Motion on: width updates snap (allowed) and nothing errors.
- **Done when**: determinate fill eases with `MOTION_AMBIENT`, indeterminate behavior is byte-for-byte unchanged, and typecheck passes.
