interface SourceLineList {
  readonly props: { readonly data?: { readonly length: number } | null };
  scrollToIndex(params: { index: number; animated: boolean; viewPosition: number }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
}

const RETRY_DELAY_MS = 100;
const MAX_RETRIES = 5;

// Wrapped rows have no getItemLayout. VirtualizedList fails a jump past its highest measured row
// and ends its content there, so the native scroll clamps an estimated jump to the measured rows.
// Reserve the estimate below them, re-aim when the list lays out, and refine once it accepts.
export function createSourceLineScroll(reserveTail: (length: number) => void) {
  let list: SourceLineList | null = null;
  let target: number | null = null;
  let retries = 0;
  let highestMeasured = -1;
  let awaitingLayout = false;
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
    awaitingLayout = false;
    target = null;
    reserveTail(0);
  };

  const retry = () => {
    if (retries >= MAX_RETRIES) {
      cancel();
      return;
    }
    retries += 1;
    const timer = setTimeout(attempt, RETRY_DELAY_MS);
    cancelPending = () => clearTimeout(timer);
  };

  const attempt = () => {
    cancelPending = null;
    awaitingLayout = false;
    if (target === null || !list || target >= (list.props.data?.length ?? 0)) {
      cancel();
      return;
    }
    list.scrollToIndex({ index: target, animated: false, viewPosition: 0.3 });
    if (!awaitingLayout) retry();
  };

  return {
    scrollToLine(nextList: SourceLineList | null, index: number) {
      cancel();
      list = nextList;
      if (!Number.isInteger(index) || index < 0) return;
      target = index;
      retries = 0;
      highestMeasured = -1;
      const frame = requestAnimationFrame(attempt);
      cancelPending = () => cancelAnimationFrame(frame);
    },
    onScrollToIndexFailed(info: {
      index: number;
      averageItemLength: number;
      highestMeasuredFrameIndex: number;
    }) {
      if (info.index !== target || !list) return;
      // A failure that measured no new rows spends the budget; leaving awaitingLayout unset ends it.
      const progressed = info.highestMeasuredFrameIndex > highestMeasured;
      highestMeasured = info.highestMeasuredFrameIndex;
      if (!progressed && retries >= MAX_RETRIES) return;
      if (!progressed) retries += 1;
      const offset = info.averageItemLength * info.index;
      reserveTail(offset);
      list.scrollToOffset({ offset, animated: false });
      awaitingLayout = true;
    },
    onContentSizeChange() {
      if (awaitingLayout) attempt();
    },
    cancel,
  };
}
