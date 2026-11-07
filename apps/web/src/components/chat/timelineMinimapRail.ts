function lowerBound(rowIndices: ReadonlyArray<number>, rowIndex: number) {
  let start = 0;
  let end = rowIndices.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (rowIndices[middle]! < rowIndex) start = middle + 1;
    else end = middle;
  }
  return start;
}

export function resolveTimelineMinimapMarkers(
  rowIndices: ReadonlyArray<number>,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
) {
  if (visibleStart == null || visibleEnd == null) {
    return { start: 0, end: 0, currentIndex: null };
  }
  const start = lowerBound(rowIndices, visibleStart);
  const end = Math.max(start, lowerBound(rowIndices, visibleEnd + 1));
  // Prefer the first visible user message, otherwise the turn being read.
  const currentIndex = start < end ? start : start > 0 ? start - 1 : null;
  return { start, end, currentIndex };
}
