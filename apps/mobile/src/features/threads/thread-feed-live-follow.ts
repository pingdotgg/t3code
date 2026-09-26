export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
      readonly scroll: number;
      // The offset at which the session's drag took hold of a following feed,
      // or null when the session started away from the end.
      readonly heldEndScroll: number | null;
    }
  | {
      readonly type: "disclosure-settled";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

// LegendList's own at-end tolerance.
const HELD_END_EPSILON_PX = 1;

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
}): AnchorId | null {
  if (input.hasStartedTurn || input.hasUserMessage) {
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
    case "user-scroll-end":
      // Still following means the session never left the end, even if the
      // feed grew below it while the drag held end maintenance off.
      return event.userScrollSessionActive ? current || event.isAtEnd : current;
    case "disclosure-settled":
      return !event.userScrollSessionActive && event.isAtEnd;
    case "scroll":
      // A drag suspends end maintenance instead of pausing follow, so touching
      // down at the end, or pulling past it, does not read as scrolling away.
      // Only a drag that actually leaves the end pauses; reaching the end again
      // mid-drag re-arms only once the session is over. Streamed rows can move
      // the end away from a held drag, so leaving is measured from the offset
      // where the drag took hold, not from the end itself.
      if (event.userScrollSessionActive) {
        const heldInPlace =
          event.heldEndScroll !== null && event.scroll >= event.heldEndScroll - HELD_END_EPSILON_PX;
        return current && (event.isAtEnd || heldInPlace);
      }
      if (event.isAtEnd) {
        return true;
      }
      return current;
  }
}
