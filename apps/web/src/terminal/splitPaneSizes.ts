export type TerminalSplitDirection = "horizontal" | "vertical";

/** Minimum pane extent in CSS px along the split axis. "horizontal" = side-by-side columns (width), "vertical" = stacked rows (height). */
export const MIN_TERMINAL_PANE_PX: Readonly<Record<TerminalSplitDirection, number>> = Object.freeze(
  { horizontal: 160, vertical: 64 },
);

/** Equal fractions for `count` panes (count <= 0 returns []). */
export function equalPaneSizes(count: number): number[] {
  if (count <= 0) return [];
  const fraction = 1 / count;
  return Array.from({ length: count }, () => fraction);
}

/**
 * Returns usable sizes for `count` panes: when `sizes` is undefined, has a different length,
 * or contains a non-finite / <= 0 entry, returns equalPaneSizes(count). Otherwise returns a
 * NEW array normalized so it sums to exactly 1 (divide each by the sum).
 */
export function resolvePaneSizes(sizes: readonly number[] | undefined, count: number): number[] {
  if (!sizes || sizes.length !== count) {
    return equalPaneSizes(count);
  }

  for (const size of sizes) {
    if (!Number.isFinite(size) || size <= 0) {
      return equalPaneSizes(count);
    }
  }

  const sum = sizes.reduce((a, b) => a + b, 0);
  return Array.from(sizes, (size) => size / sum);
}

/** Raises undersized panes to the minimum fraction while preserving a total size of 1. */
export function constrainPaneSizes(
  sizes: readonly number[],
  containerPx: number,
  minPanePx: number,
): number[] {
  if (containerPx <= 0 || sizes.length <= 1) return Array.from(sizes);

  const minFraction = minPanePx / containerPx;
  if (sizes.length * minFraction >= 1) return equalPaneSizes(sizes.length);
  if (sizes.every((size) => size >= minFraction)) return Array.from(sizes);

  const totalExcess = sizes.reduce((total, size) => total + Math.max(0, size - minFraction), 0);
  const availableExcess = 1 - sizes.length * minFraction;
  const result = sizes.map((size) =>
    size <= minFraction
      ? minFraction
      : minFraction + ((size - minFraction) / totalExcess) * availableExcess,
  );
  const correction = 1 - result.reduce((total, size) => total + size, 0);
  const correctionIndex = result.findIndex((size) => size > minFraction);
  result[correctionIndex] = (result[correctionIndex] ?? 0) + correction;
  return result;
}

/**
 * Moves the boundary between pane `handleIndex` and pane `handleIndex + 1` by `deltaPx`
 * (positive = towards the end, i.e. pane handleIndex grows). Only those two panes change;
 * their combined fraction is preserved. Each of the two is clamped to at least
 * minPanePx / containerPx, but if the pair is too small for both minimums the min fraction
 * becomes half of the pair's total. Returns a NEW array (never mutates input). If
 * containerPx <= 0, handleIndex is out of range (must be 0..sizes.length-2), or deltaPx is
 * not finite, return a copy of `sizes` unchanged.
 */
export function resizeAdjacentPanes(input: {
  readonly sizes: readonly number[];
  readonly handleIndex: number;
  readonly deltaPx: number;
  readonly containerPx: number;
  readonly minPanePx: number;
}): number[] {
  const { sizes, handleIndex, deltaPx, containerPx, minPanePx } = input;

  const isValidHandleIndex = handleIndex >= 0 && handleIndex < sizes.length - 1;
  if (containerPx <= 0 || !isValidHandleIndex || !Number.isFinite(deltaPx)) {
    return Array.from(sizes);
  }

  const result = Array.from(sizes);
  const minFraction = minPanePx / containerPx;
  const deltaFraction = deltaPx / containerPx;

  const leftIndex = handleIndex;
  const rightIndex = handleIndex + 1;

  const leftSize = result[leftIndex] ?? 0;
  const rightSize = result[rightIndex] ?? 0;
  const combined = leftSize + rightSize;

  let newLeft = leftSize + deltaFraction;
  let newRight = combined - newLeft;

  if (combined < 2 * minFraction) {
    const halfCombined = combined / 2;
    newLeft = halfCombined;
    newRight = halfCombined;
  } else {
    newLeft = Math.max(minFraction, Math.min(newLeft, combined - minFraction));
    newRight = combined - newLeft;
  }

  result[leftIndex] = newLeft;
  result[rightIndex] = newRight;

  return result;
}

/** CSS grid template for the sizes: each entry `minmax(0, <fraction>fr)` joined by a space. Use the fraction with at most 6 decimal places (trim trailing zeros is not required). */
export function paneGridTemplate(sizes: readonly number[]): string {
  return sizes
    .map((size) => {
      const rounded = Math.round(size * 1000000) / 1000000;
      return `minmax(0, ${rounded}fr)`;
    })
    .join(" ");
}

/** Cumulative offsets (fractions 0..1) of each internal boundary: length sizes.length - 1. e.g. [0.25, 0.25, 0.5] -> [0.25, 0.5]. */
export function paneBoundaryOffsets(sizes: readonly number[]): number[] {
  const result: number[] = [];
  let cumulative = 0;

  for (let i = 0; i < sizes.length - 1; i++) {
    const size = sizes[i] ?? 0;
    cumulative += size;
    result.push(cumulative);
  }

  return result;
}

/** Internal pane boundaries rounded to whole CSS pixels for the given container extent. */
export function panePixelBoundaries(sizes: readonly number[], containerPx: number): number[] {
  return paneBoundaryOffsets(sizes).map((offset) => Math.round(offset * containerPx));
}

/**
 * Returns pane fractions whose internal boundaries land on whole CSS pixels. This keeps terminal
 * canvases and their borders aligned while a split is dragged.
 */
export function snapPaneSizesToWholePixels(
  sizes: readonly number[],
  containerPx: number,
): number[] {
  if (containerPx <= 0 || sizes.length <= 1) return Array.from(sizes);

  const boundaryCount = sizes.length - 1;
  const boundaries = panePixelBoundaries(sizes, containerPx);
  let previous = 0;

  for (let index = 0; index < boundaries.length; index++) {
    const upper = Math.ceil(containerPx) - (boundaryCount - index);
    const boundary = boundaries[index] ?? previous + 1;
    boundaries[index] = Math.max(previous + 1, Math.min(boundary, upper));
    previous = boundaries[index]!;
  }

  const result = boundaries.map((boundary, index) => {
    const previousBoundary = boundaries[index - 1] ?? 0;
    return (boundary - previousBoundary) / containerPx;
  });
  const allocated = result.reduce((total, size) => total + size, 0);
  result.push(1 - allocated);
  return result;
}
