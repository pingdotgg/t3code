/** Digits past two in the list's widest marker (`String` keeps a negative marker's minus sign). */
export function orderedListMarkerExtraDigits(start: unknown, itemCount: number): number {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const first = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const last = first + Math.max(itemCount - 1, 0);
  return Math.max(String(first).length, String(last).length, 2) - 2;
}
