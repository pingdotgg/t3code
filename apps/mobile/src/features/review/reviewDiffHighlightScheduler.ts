export interface NativeReviewVisibleRange {
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
}

export function createReviewDiffHighlightScheduler(
  request: (range: NativeReviewVisibleRange) => void,
) {
  let requestedRange: NativeReviewVisibleRange | undefined;
  let visibleRange = requestedRange;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    requestedRange = visibleRange;
    if (visibleRange) request(visibleRange);
  };

  return {
    update(nextRange: NativeReviewVisibleRange) {
      if (
        nextRange.firstRowIndex === visibleRange?.firstRowIndex &&
        nextRange.lastRowIndex === visibleRange.lastRowIndex
      ) {
        return;
      }
      visibleRange = nextRange;
      cancel();
      if (!requestedRange) {
        // Native publishes a pre-jump range and its initial destination together.
        // Yield once so the destination wins before sending an unabortable source RPC.
        timer = setTimeout(flush, 0);
        return;
      }
      const movedRows =
        Math.abs(nextRange.firstRowIndex - requestedRange.firstRowIndex) +
        Math.abs(nextRange.lastRowIndex - requestedRange.lastRowIndex);
      if (movedRows >= 20) {
        flush();
      } else if (movedRows > 0) {
        timer = setTimeout(flush, 150);
      }
    },
    reset() {
      cancel();
      const previousRange = visibleRange;
      requestedRange = undefined;
      visibleRange = requestedRange;
      return previousRange;
    },
    cancel,
  };
}
