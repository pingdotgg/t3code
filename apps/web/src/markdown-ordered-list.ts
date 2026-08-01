/**
 * Digits past two in the list's widest marker — the multiplier for the
 * `--chat-markdown-ol-marker-extra` CSS variable.
 */
export function orderedListMarkerExtraDigits(start: number | undefined, itemCount: number): number {
  const lastMarker = (start ?? 1) + Math.max(itemCount - 1, 0);
  return Math.max(String(Math.abs(lastMarker)).length - 2, 0);
}
