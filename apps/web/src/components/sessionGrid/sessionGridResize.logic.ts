export type SessionGridResizeAxis = "columns" | "rows";

export function equalSessionGridTrackSizes(count: number): number[] {
  return Array.from({ length: Math.max(1, Math.floor(count)) }, () => 1);
}

export function resolveSessionGridTrackSizes(
  sizes: readonly number[] | null | undefined,
  count: number,
): number[] {
  const resolvedCount = Math.max(1, Math.floor(count));
  if (
    sizes?.length !== resolvedCount ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  ) {
    return equalSessionGridTrackSizes(resolvedCount);
  }
  return [...sizes];
}

export function sessionGridTrackTemplate(sizes: readonly number[]): string {
  return sizes.map((size) => `minmax(0, ${Math.max(0.1, size)}fr)`).join(" ");
}

export function resizeSessionGridTrackBoundary(input: {
  readonly sizes: readonly number[];
  readonly boundaryIndex: number;
  readonly deltaPx: number;
  readonly availableSizePx: number;
  readonly minimumTrackSizePx: number;
}): number[] {
  const { sizes, boundaryIndex, deltaPx, availableSizePx, minimumTrackSizePx } = input;
  const leadingSize = sizes[boundaryIndex];
  const trailingSize = sizes[boundaryIndex + 1];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (
    leadingSize === undefined ||
    trailingSize === undefined ||
    total <= 0 ||
    !Number.isFinite(deltaPx) ||
    !Number.isFinite(availableSizePx) ||
    availableSizePx <= 0
  ) {
    return [...sizes];
  }

  const pairSize = leadingSize + trailingSize;
  const requestedLeadingSize = leadingSize + (deltaPx / availableSizePx) * total;
  const requestedMinimumSize = (Math.max(0, minimumTrackSizePx) / availableSizePx) * total;
  const minimumSize = Math.min(requestedMinimumSize, pairSize / 2);
  const nextLeadingSize = Math.min(
    pairSize - minimumSize,
    Math.max(minimumSize, requestedLeadingSize),
  );
  const next = [...sizes];
  next[boundaryIndex] = nextLeadingSize;
  next[boundaryIndex + 1] = pairSize - nextLeadingSize;
  return next;
}

export function sessionGridTrackBoundaryPositions(input: {
  readonly sizes: readonly number[];
  readonly gapPx: number;
}): Array<{
  readonly boundaryKey: string;
  readonly percentage: number;
  readonly offsetPx: number;
}> {
  const { sizes, gapPx } = input;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0 || sizes.length <= 1) return [];

  const totalGapPx = Math.max(0, gapPx) * (sizes.length - 1);
  let accumulated = 0;
  return sizes.slice(0, -1).map((size, boundaryIndex) => {
    accumulated += size;
    const fraction = accumulated / total;
    return {
      boundaryKey: `track-boundary:${boundaryIndex}`,
      percentage: fraction * 100,
      // The percentage applies to the whole grid. Correct it so the handle
      // lands in the centre of the fixed-size CSS gap between flexible tracks.
      offsetPx: boundaryIndex * Math.max(0, gapPx) + Math.max(0, gapPx) / 2 - fraction * totalGapPx,
    };
  });
}
