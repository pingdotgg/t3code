export interface NativeReviewVisibleRange {
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
}

export function createReviewDiffHighlightScheduler(
  request: (range: NativeReviewVisibleRange) => void,
) {
  let requestedRange: NativeReviewVisibleRange = { firstRowIndex: 0, lastRowIndex: 80 };
  let visibleRange = requestedRange;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    requestedRange = visibleRange;
    request(visibleRange);
  };

  return {
    update(nextRange: NativeReviewVisibleRange) {
      if (
        nextRange.firstRowIndex === visibleRange.firstRowIndex &&
        nextRange.lastRowIndex === visibleRange.lastRowIndex
      ) {
        return;
      }
      visibleRange = nextRange;
      cancel();
      // Accumulate small scroll events relative to the last request, not each other.
      const movedRows =
        Math.abs(nextRange.firstRowIndex - requestedRange.firstRowIndex) +
        Math.abs(nextRange.lastRowIndex - requestedRange.lastRowIndex);
      if (movedRows >= 20) {
        flush();
      } else if (movedRows > 0) {
        // Cover the final viewport even when scrolling stops below the threshold.
        timer = setTimeout(flush, 150);
      }
    },
    reset() {
      cancel();
      requestedRange = { firstRowIndex: 0, lastRowIndex: 80 };
      visibleRange = requestedRange;
    },
    cancel,
  };
}
