import { useLayoutEffect, useState } from "react";
import { LinearTransition, ReduceMotion } from "react-native-reanimated";

export const THREAD_SIDEBAR_ROW_LAYOUT = LinearTransition.duration(180).reduceMotion(
  ReduceMotion.System,
);

export function threadListShelfExpansionKey(input: {
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
}): string {
  return `${input.workingShelfExpanded}:${input.snoozedShelfExpanded}:${input.settledShelfExpanded}`;
}

/**
 * Shelf inserts would run a layout transition on every revealed row; skip the transition for that
 * commit (same idea as the web sidebar), then restore it for ordinary list moves.
 */
export function useThreadListShelfLayoutAnimation(
  shelfExpansionKey: string,
  animation: typeof THREAD_SIDEBAR_ROW_LAYOUT = THREAD_SIDEBAR_ROW_LAYOUT,
) {
  const [committedKey, setCommittedKey] = useState(shelfExpansionKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-enables row layout animation after a shelf expand/collapse commit that must not animate
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Marks the expand/collapse commit as done so later list moves can animate again.
    setCommittedKey(shelfExpansionKey);
  }, [shelfExpansionKey]);
  return committedKey === shelfExpansionKey ? animation : undefined;
}
