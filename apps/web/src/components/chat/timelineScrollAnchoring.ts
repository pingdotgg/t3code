import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, RunId } from "@t3tools/contracts";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

/** Opening a thread establishes a baseline; only later runs get new-turn framing. */
export function observeTimelineRun(
  previous: TimelineRunObservation | null,
  input: TimelineRunObservation & {
    readonly queued: boolean;
    readonly messageId: MessageId | null;
  },
): { observation: TimelineRunObservation; anchorMessageId: MessageId | null } {
  const observation = {
    threadKey: input.threadKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.threadKey !== input.threadKey || !previous.hydrated) {
    return { observation, anchorMessageId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.messageId === null
  ) {
    return { observation: previous, anchorMessageId: null };
  }
  return { observation, anchorMessageId: input.messageId };
}
import type { RunAttemptId } from "@t3tools/contracts";

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * Whether the timeline's real rows extend past the viewport left above the
 * composer. The list's own content length includes the composer inset
 * spacer, so this measures from the last row instead. Unknown row geometry
 * or an unmeasured viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

export interface RememberedTimelineDisclosures {
  readonly runs: ReadonlySet<RunId>;
  readonly workGroups: ReadonlySet<string>;
  readonly attempts: ReadonlySet<RunAttemptId>;
  readonly workGroupState: {
    scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
    expandedEntries: Set<string>;
  };
}

// Scoped thread keys keep separate environments independent. Bound the session cache.
const rememberedTimelineDisclosures = new Map<string, RememberedTimelineDisclosures>();

export function readTimelineDisclosures(threadKey: string) {
  return rememberedTimelineDisclosures.get(threadKey);
}

export function rememberTimelineDisclosures(
  threadKey: string,
  disclosures: RememberedTimelineDisclosures,
) {
  rememberedTimelineDisclosures.delete(threadKey);
  rememberedTimelineDisclosures.set(threadKey, disclosures);
  if (rememberedTimelineDisclosures.size > 100) {
    const oldest = rememberedTimelineDisclosures.keys().next().value;
    if (oldest !== undefined) rememberedTimelineDisclosures.delete(oldest);
  }
}

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});

export function cancelTimelineProgrammaticScroll(list: LegendListRef | null): void {
  const node = list?.getScrollableNode();
  const offset = node?.scrollTop;
  if (typeof offset === "number") {
    // Clear an active native index target before cancelling queued requests.
    void list?.scrollToOffset({ offset, animated: false });
  }
  void list?.scrollToItem({ item: TIMELINE_SCROLL_CANCEL_SENTINEL, animated: false });
  // An instant same-position write also stops a browser smooth scroll.
  if (node && typeof offset === "number") node.scrollTop = offset;
}

export function observeTimelineScrollNavigation(
  node: HTMLElement,
  isFollowingEnd: () => boolean,
  onManualNavigation: () => void,
  getManagedOffset: () => number | undefined,
): () => void {
  let previousOffset = node.scrollTop;
  const handleScroll = () => {
    const offset = node.scrollTop;
    const height = node.scrollHeight;
    const viewport = node.clientHeight;
    // Layout changes may clamp the old offset; only movement beyond that is navigation.
    const clampedPreviousOffset = Math.min(previousOffset, Math.max(0, height - viewport));
    const movedAway = offset < clampedPreviousOffset - 1 && height - viewport - offset > 40;
    previousOffset = offset;
    if (movedAway && isFollowingEnd()) {
      // Legend records its own position correction before applying the DOM scroll.
      const managedOffset = getManagedOffset();
      if (managedOffset === undefined || Math.abs(offset - managedOffset) > 1) {
        onManualNavigation();
      }
    }
  };
  // Observe navigation before the virtualizer handles the event and schedules follow.
  node.addEventListener("scroll", handleScroll, { capture: true, passive: true });
  return () => node.removeEventListener("scroll", handleScroll, true);
}
