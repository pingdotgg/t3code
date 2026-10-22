import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";

export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll" | "disclosure-settled";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

export interface ThreadWorkGroupScrollPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly contentHeight: number;
}

export function resolveThreadWorkGroupInitialScroll(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadWorkGroupScrollPosition | undefined,
) {
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  return index >= 0 && position ? { index, viewOffset: -position.offsetWithinRow } : undefined;
}

export function shouldFollowThreadWorkGroupAppend(input: {
  readonly previousRows: ReadonlyArray<{ readonly id: string }>;
  readonly rows: ReadonlyArray<{ readonly id: string }>;
  readonly previousContentHeight: number;
  readonly contentHeight: number;
  readonly viewportHeight: number;
  readonly scrollOffset: number;
  readonly detailsChanged: boolean;
  readonly userScrolling: boolean;
}) {
  return (
    !input.detailsChanged &&
    !input.userScrolling &&
    input.contentHeight > input.previousContentHeight &&
    input.rows.length > input.previousRows.length &&
    input.previousRows.every((row, index) => row.id === input.rows[index]?.id) &&
    input.previousContentHeight - input.viewportHeight - input.scrollOffset <= 1
  );
}

export function resolveThreadFeedSubmissionAnchor<AnchorId>(input: {
  readonly currentAnchorMessageId: AnchorId | null;
  readonly submittedMessageId: AnchorId;
  readonly hasStartedTurn: boolean;
  readonly hasUserMessage: boolean;
  readonly queuedMessageCount: number;
  readonly deliveryDeferred: boolean;
}): AnchorId | null {
  if (input.deliveryDeferred || input.hasStartedTurn || input.hasUserMessage) {
    return null;
  }

  if (input.currentAnchorMessageId !== null) {
    return input.currentAnchorMessageId;
  }

  return input.queuedMessageCount > 0 ? null : input.submittedMessageId;
}

export function resolveThreadFeedLiveFollow(
  current: boolean,
  event: ThreadFeedLiveFollowEvent,
): boolean {
  switch (event.type) {
    case "reset":
      return true;
    case "user-scroll-begin":
      return false;
    case "user-scroll-end":
      return event.userScrollSessionActive ? event.isAtEnd : current;
    case "disclosure-settled":
      return !event.userScrollSessionActive && event.isAtEnd;
    case "scroll":
      if (event.userScrollSessionActive) {
        return false;
      }
      if (event.isAtEnd) {
        return true;
      }
      return current;
  }
}

/** The LegendList state a width reflow reads before rows re-measure and after they settle. */
export interface ThreadFeedReflowListState {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly scroll: number;
  readonly isWithinMaintainScrollAtEndThreshold: boolean;
  readonly indexByKey: (key: string) => number | undefined;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizes: ReadonlyMap<string, number>;
}

export interface ThreadFeedReflowLayout {
  /** List padding and header; row positions start below them. */
  readonly rowsTop: number;
  /** The top of the viewport covered by the navigation header. */
  readonly headerInset: number;
}

export interface ThreadFeedReflowRowAnchor {
  readonly key: string;
  readonly offsetWithinRow: number;
  readonly size: number;
}

/** A feed that follows keeps the end through a reflow; a reader keeps the row they are in. */
export type ThreadFeedReflowAnchor = "end" | ThreadFeedReflowRowAnchor;

function readingLine(state: ThreadFeedReflowListState, layout: ThreadFeedReflowLayout) {
  return state.scroll + layout.headerInset - layout.rowsTop;
}

export function resolveThreadFeedReflowAnchor(
  state: ThreadFeedReflowListState,
  layout: ThreadFeedReflowLayout,
  following: boolean,
): ThreadFeedReflowAnchor | null {
  // Follow alone is not enough: a status-bar tap scrolls to the top without a drag, so it
  // leaves follow on while the reader is far from the end.
  if (following && state.isWithinMaintainScrollAtEndThreshold) return "end";
  const line = readingLine(state, layout);
  // A reader at the top of the thread stays there without help.
  if (line <= 0) return null;
  const row = resolveWorkGroupScrollAnchor({
    data: state.data,
    scroll: line,
    positionAtIndex: state.positionAtIndex,
  });
  const size = row ? state.sizes.get(row.rowId) : undefined;
  return row && size ? { key: row.rowId, offsetWithinRow: row.offsetWithinRow, size } : null;
}

function resolveReflowAnchorPoint(
  anchor: ThreadFeedReflowRowAnchor,
  state: ThreadFeedReflowListState,
) {
  const index = state.indexByKey(anchor.key);
  const top = index === undefined ? undefined : state.positionAtIndex(index);
  const size = state.sizes.get(anchor.key);
  if (index === undefined || top === undefined || size === undefined) return null;
  // Rewrapped text grows with its row, so the reader's line sits at the same share of the
  // row rather than the same pixel offset into it.
  return { index, top, offsetWithinRow: (anchor.offsetWithinRow * size) / anchor.size };
}

/** The scroll offset that puts the reader's line back under the header at the current sizes. */
export function resolveThreadFeedReflowOffset(
  anchor: ThreadFeedReflowRowAnchor,
  state: ThreadFeedReflowListState,
  layout: ThreadFeedReflowLayout,
): number | undefined {
  const point = resolveReflowAnchorPoint(anchor, state);
  return point
    ? point.top + point.offsetWithinRow - layout.headerInset + layout.rowsTop
    : undefined;
}

export function resolveThreadFeedReflowScroll(
  anchor: ThreadFeedReflowRowAnchor,
  state: ThreadFeedReflowListState,
  layout: ThreadFeedReflowLayout,
): { readonly index: number; readonly viewOffset: number } | null {
  const point = resolveReflowAnchorPoint(anchor, state);
  if (!point) return null;
  if (Math.abs(readingLine(state, layout) - (point.top + point.offsetWithinRow)) < 1) return null;
  return { index: point.index, viewOffset: layout.headerInset - point.offsetWithinRow };
}
