interface SourceLineList {
  readonly props: { readonly data?: { readonly length: number } | null };
  scrollToIndex(params: { index: number; animated: boolean; viewPosition: number }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
}

const RETRY_DELAY_MS = 100;
const MAX_RETRIES = 5;
const VIEW_POSITION = 0.3;

// Wrapped rows have no getItemLayout. VirtualizedList fails a jump past its highest measured
// row and silently estimates an unmeasured row below it, so re-aim until the budget runs out.
export function createSourceLineScroll() {
  let list: SourceLineList | null = null;
  let target: number | null = null;
  let retries = 0;
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
    target = null;
  };

  const retry = () => {
    if (retries >= MAX_RETRIES) {
      target = null;
      return;
    }
    retries += 1;
    const timer = setTimeout(attempt, RETRY_DELAY_MS);
    cancelPending = () => clearTimeout(timer);
  };

  const attempt = () => {
    cancelPending = null;
    if (target === null || !list || target >= (list.props.data?.length ?? 0)) {
      target = null;
      return;
    }
    list.scrollToIndex({ index: target, animated: false, viewPosition: VIEW_POSITION });
    // A failed jump has already scheduled its retry.
    if (cancelPending === null) retry();
  };

  return {
    scrollToLine(nextList: SourceLineList | null, index: number) {
      cancel();
      list = nextList;
      if (!Number.isInteger(index) || index < 0) return;
      target = index;
      retries = 0;
      const frame = requestAnimationFrame(attempt);
      cancelPending = () => cancelAnimationFrame(frame);
    },
    onScrollToIndexFailed(info: {
      index: number;
      averageItemLength: number;
      highestMeasuredFrameIndex: number;
    }) {
      if (info.index !== target || !list) return;
      list.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      retry();
    },
    cancel,
  };
}

// One selectable text view reports no per-line layout, so a line is placed by its share of the
// measured text height. Unwrapped rows are exact; wrapped rows are estimated from columns.
// Null means the line is already in view at the resting offset, which iOS sets below the header.
export function selectableSourceLineOffset(params: {
  readonly lines: ReadonlyArray<string>;
  readonly index: number;
  readonly textTop: number;
  readonly textHeight: number;
  readonly columns: number | null;
  readonly contentHeight: number;
  readonly viewportHeight: number;
}): number | null {
  const { columns } = params;
  let rowsAbove = 0;
  let rows = 0;
  for (const [index, line] of params.lines.entries()) {
    const lineRows =
      columns === null || columns < 1 ? 1 : Math.max(1, Math.ceil(line.length / columns));
    if (index < params.index) rowsAbove += lineRows;
    rows += lineRows;
  }
  const lineTop = params.textTop + (params.textHeight * rowsAbove) / Math.max(1, rows);
  const offset = Math.min(
    lineTop - params.viewportHeight * VIEW_POSITION,
    params.contentHeight - params.viewportHeight,
  );
  return offset > 0 ? offset : null;
}
