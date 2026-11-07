import { useMemo } from "react";
import type { EdgeInsets } from "react-native-safe-area-context";

/** Same inset numbers keep the same object so SafeAreaInsetsContext does not fan out. */
export function useStableEdgeInsets(insets: EdgeInsets): EdgeInsets {
  const { top, right, bottom, left } = insets;
  return useMemo(() => ({ top, right, bottom, left }), [top, right, bottom, left]);
}

export function useStableEdgeInsetsOverride(
  insets: EdgeInsets,
  override: Partial<EdgeInsets> | null,
): EdgeInsets {
  const top = override?.top ?? insets.top;
  const right = override?.right ?? insets.right;
  const bottom = override?.bottom ?? insets.bottom;
  const left = override?.left ?? insets.left;
  return useMemo(() => ({ top, right, bottom, left }), [top, right, bottom, left]);
}
