/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  if (!Number.isNaN(difference)) return difference;
  return left < right ? -1 : left > right ? 1 : 0;
}
