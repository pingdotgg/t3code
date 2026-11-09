/**
 * End-alignment spacer above the first row. LegendList adds this so short chats
 * sit on the composer; non-zero means visible white space above the turns.
 */
export function threadFeedAlignEndPadding(input: {
  readonly firstItemPosition: number;
  readonly headerSize: number;
  readonly stylePaddingTop: number;
}): number {
  return Math.max(0, input.firstItemPosition - input.headerSize - input.stylePaddingTop);
}

/** False until LegendList has a measurable frame and content size. */
export function threadFeedLayoutReady(input: {
  readonly contentLength: number;
  readonly scrollLength: number;
}): boolean {
  return input.scrollLength > 0 && input.contentLength > 0;
}

/**
 * Underfilled when messages do not fill the visible band: end-alignment spacer,
 * first row still below the header, content shorter than the frame, or the page
 * cannot scroll (LegendList often folds end-align spacer into contentLength so
 * a short chat looks "full" while white space remains above the turns).
 */
export function threadFeedUnderfillsViewport(input: {
  readonly contentLength: number;
  readonly scrollLength: number;
  readonly alignItemsAtEndPadding?: number;
  /** `positionAtIndex(0) - scroll` — where the first row sits in the viewport. */
  readonly firstItemScreenOffset?: number;
  /** Top inset covering the navigation header. */
  readonly contentInsetStart?: number;
}): boolean {
  if ((input.alignItemsAtEndPadding ?? 0) > 1) {
    return true;
  }
  const start = input.contentInsetStart ?? 0;
  if (
    input.firstItemScreenOffset !== undefined &&
    input.scrollLength > 0 &&
    input.firstItemScreenOffset > start + 8
  ) {
    return true;
  }
  if (input.scrollLength <= 0 || input.contentLength <= 0) {
    return false;
  }
  const contentWithoutEndAlign =
    input.contentLength - Math.max(0, input.alignItemsAtEndPadding ?? 0);
  if (contentWithoutEndAlign < input.scrollLength) {
    return true;
  }
  // End-aligned short pages report contentLength ≈ scrollLength; a near-zero
  // scroll range still means the reader cannot reach past the fold.
  return Math.max(0, input.contentLength - input.scrollLength) < 8;
}

export function shouldAutoloadEarlierHistory(input: {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly contentLength: number;
  readonly scrollLength: number;
  readonly alignItemsAtEndPadding?: number;
  readonly firstItemScreenOffset?: number;
  readonly contentInsetStart?: number;
  /** Skip while a jump-to-message path already owns paging. */
  readonly jumpToMessageActive?: boolean;
  /** Skip while the reader is dragging or coasting. */
  readonly userScrollSessionActive?: boolean;
}): boolean {
  if (input.jumpToMessageActive) return false;
  if (input.userScrollSessionActive) return false;
  if (!input.hasMoreHistory || input.loading || input.error !== null) return false;
  if (!threadFeedLayoutReady(input)) return false;
  return threadFeedUnderfillsViewport(input);
}

/**
 * Show Load earlier only once the page is past the fold. Estimated item sizes
 * can briefly look "full" on open; require a first row at the header band and
 * real scroll overflow so the control does not flash under the title.
 */
export function shouldShowLoadEarlierControl(input: {
  readonly hasMoreHistory: boolean;
  readonly error: string | null;
  readonly underfillsViewport: boolean;
  readonly layoutReady?: boolean;
  /** `contentLength - scrollLength`. */
  readonly scrollRange?: number;
  readonly firstItemScreenOffset?: number;
  readonly contentInsetStart?: number;
}): boolean {
  if (input.error !== null) return true;
  if (!input.hasMoreHistory) return false;
  if (input.underfillsViewport) return false;
  if (input.layoutReady === false) return false;
  const start = input.contentInsetStart ?? 0;
  if (input.firstItemScreenOffset === undefined || input.firstItemScreenOffset > start + 8) {
    return false;
  }
  if ((input.scrollRange ?? 0) < 24) return false;
  return true;
}
