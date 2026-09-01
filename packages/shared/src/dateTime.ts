/** Compare date-time strings by absolute time, with stable handling for malformed stored values. */
export function compareDateTimeStrings(left: string, right: string): number {
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  const leftIsValid = !Number.isNaN(leftTimestamp);
  const rightIsValid = !Number.isNaN(rightTimestamp);

  if (leftIsValid !== rightIsValid) return leftIsValid ? 1 : -1;
  if (leftIsValid) return leftTimestamp - rightTimestamp;
  return left < right ? -1 : left > right ? 1 : 0;
}
