/**
 * Digits past two in the list's widest marker — the multiplier for the
 * `--chat-markdown-ol-marker-extra` CSS variable.
 */
export function orderedListMarkerExtraDigits(start: number | undefined, itemCount: number): number {
  const firstMarker = start ?? 1;
  const lastMarker = firstMarker + Math.max(itemCount - 1, 0);
  // Raw HTML can set a negative `start`, where the first marker is the widest
  // and its minus sign takes a character of its own.
  const markerLength = (value: number) => String(Math.abs(value)).length + (value < 0 ? 1 : 0);
  return Math.max(Math.max(markerLength(firstMarker), markerLength(lastMarker)) - 2, 0);
}
