import { useLayoutEffect, useRef } from "react";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    left.optimisticMessages === right.optimisticMessages &&
    left.anchoredMessages === right.anchoredMessages &&
    left.attachmentUrlById === right.attachmentUrlById &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}

/**
 * Timeline entries for a thread, derived from the previous projection so
 * unchanged rows keep their identity and memoized rows skip rendering. A new
 * thread starts from scratch.
 */
export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  const committed = useRef<{
    threadKey: string | null;
    projection: TimelineEntriesProjection;
  } | null>(null);
  // This ref is only an identity-reuse cache: deriving without it produces the
  // same timeline. Read the last commit, and publish only after this one commits.
  /* oxlint-disable react/refs -- Previous projections optimize identity reuse, not rendered content. */
  const previous = committed.current?.threadKey === threadKey ? committed.current.projection : null;
  const projection =
    previous !== null && sameInput(previous.input, input)
      ? previous
      : deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
  // Inputs may be freshly allocated each render. Cache committed projections
  // without scheduling another render, and never retain an abandoned render.
  useLayoutEffect(() => {
    committed.current = { threadKey, projection };
  });
  return projection.entries;
  /* oxlint-enable react/refs */
}
