/** Save the row at the current offset; a virtualizer's cached visible range can lag a fling. */
export function resolveWorkGroupScrollAnchor(state: {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly scroll: number;
  readonly positionAtIndex: (index: number) => number | undefined;
}) {
  if (state.data.length === 0 || !Number.isFinite(state.scroll)) return undefined;
  const scrollOffset = Math.max(0, state.scroll);
  let low = 0;
  let high = state.data.length - 1;
  let index = 0;
  let rowTop = state.positionAtIndex(0);
  if (rowTop === undefined || !Number.isFinite(rowTop)) return undefined;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const top = state.positionAtIndex(middle);
    if (top === undefined || !Number.isFinite(top)) return undefined;
    if (top <= scrollOffset) {
      index = middle;
      rowTop = top;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    rowId: state.data[index]!.id,
    offsetWithinRow: Math.max(0, scrollOffset - rowTop),
    scrollOffset,
  };
}
