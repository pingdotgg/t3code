export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      // LegendList's isWithinMaintainScrollAtEndThreshold: inside the
      // maintain-at-end tolerance. Re-arming accepts it because a swipe back
      // to the live edge usually rests a few pixels short of the exact end,
      // in space the end inset covers; the tolerance only ever re-arms
      // follow, never breaks it.
      readonly nearEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll";
      readonly isAtEnd: boolean;
      readonly nearEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "disclosure-settled";
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
    case "user-scroll-begin":
      return false;
    case "user-scroll-end":
      return event.userScrollSessionActive ? event.isAtEnd || event.nearEnd : current;
    case "disclosure-settled":
      return !event.userScrollSessionActive && event.isAtEnd;
    case "scroll":
      if (event.userScrollSessionActive) {
        return false;
      }
      if (event.isAtEnd || event.nearEnd) {
        return true;
      }
      return current;
  }
}
