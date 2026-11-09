// A "Show 1 more" row is as tall as the row it hides, so show that row instead.
export function visibleRowCount(total: number, limit: number): number {
  return total === limit + 1 ? total : Math.min(limit, total);
}
