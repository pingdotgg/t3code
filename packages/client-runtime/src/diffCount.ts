const DIFF_COUNT_FORMAT = new Intl.NumberFormat();

/** Formats a diff line count with the viewer's digit grouping, so `83065` reads `83,065`. */
export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}
