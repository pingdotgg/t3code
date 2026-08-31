/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  return Number.isNaN(difference) ? left.localeCompare(right) : difference;
}
