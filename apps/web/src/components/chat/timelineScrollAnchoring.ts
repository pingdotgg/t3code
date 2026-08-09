export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineLiveFollowState {
  readonly threadKey: string;
  readonly enabled: boolean;
}

export interface TimelineRouteEpoch {
  readonly threadKey: string;
}

export interface TimelineAnchorState<Message> {
  readonly threadKey: string | null;
  readonly messageId: Message | null;
}

export function clearTimelineAnchor<Message>(
  state: TimelineAnchorState<Message>,
): TimelineAnchorState<Message> {
  return state.messageId === null ? state : { ...state, messageId: null };
}

export function resolveTimelineRouteEpoch(
  current: TimelineRouteEpoch,
  threadKey: string,
): TimelineRouteEpoch {
  return current.threadKey === threadKey ? current : { threadKey };
}

export function resolveTimelineLiveFollowEnabled(
  state: TimelineLiveFollowState,
  threadKey: string,
): boolean {
  return state.threadKey === threadKey ? state.enabled : true;
}

export function updateTimelineLiveFollowState(
  state: TimelineLiveFollowState,
  threadKey: string,
  enabled: boolean,
): TimelineLiveFollowState {
  return state.threadKey === threadKey && state.enabled === enabled
    ? state
    : { threadKey, enabled };
}

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

export function getAnchoredTurnEndRevealOffset(
  input: Parameters<typeof getAnchoredTurnMetrics>[0],
): number | null {
  const metrics = getAnchoredTurnMetrics(input);
  return metrics && metrics.scrollDeltaToRevealEnd > 1
    ? input.state.scroll + metrics.scrollDeltaToRevealEnd
    : null;
}
