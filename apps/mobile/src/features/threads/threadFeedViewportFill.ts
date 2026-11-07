/**
 * A thread page underfills when its measured content is shorter than the list
 * viewport. LegendList's contentLength already includes the composer end inset,
 * so comparing to scrollLength matches "not enough content to scroll".
 */
export function threadFeedUnderfillsViewport(input: {
  readonly contentLength: number;
  readonly scrollLength: number;
}): boolean {
  if (input.scrollLength <= 0 || input.contentLength <= 0) {
    return false;
  }
  return input.contentLength < input.scrollLength;
}

export function shouldAutoloadEarlierHistory(input: {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly contentLength: number;
  readonly scrollLength: number;
  /** Skip while a jump-to-message path already owns paging. */
  readonly jumpToMessageActive?: boolean;
  /** Skip while the reader is dragging or coasting. */
  readonly userScrollSessionActive?: boolean;
}): boolean {
  if (input.jumpToMessageActive) return false;
  if (input.userScrollSessionActive) return false;
  if (!input.hasMoreHistory || input.loading || input.error !== null) return false;
  return threadFeedUnderfillsViewport(input);
}
