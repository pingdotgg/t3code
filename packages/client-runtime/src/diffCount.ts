const DIFF_COUNT_FORMAT = new Intl.NumberFormat();

export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}
