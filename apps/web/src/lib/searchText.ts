export interface HighlightSegment {
  key: string;
  text: string;
  highlighted: boolean;
}

export function findTextOccurrences(
  text: string,
  query: string,
): Array<{ start: number; end: number }> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const normalizedText = text.toLocaleLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let startIndex = 0;

  while (startIndex < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, startIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push({ start: matchIndex, end: matchIndex + normalizedQuery.length });
    startIndex = matchIndex + normalizedQuery.length;
  }

  return matches;
}

export function buildHighlightSegments(
  text: string,
  occurrences: readonly { start: number; end: number }[],
): HighlightSegment[] {
  if (occurrences.length === 0) {
    return [{ key: "0:end:0", text, highlighted: false }];
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (const occurrence of occurrences) {
    if (occurrence.start > cursor) {
      segments.push({
        key: `${cursor}:${occurrence.start}:0`,
        text: text.slice(cursor, occurrence.start),
        highlighted: false,
      });
    }

    if (occurrence.end > occurrence.start) {
      segments.push({
        key: `${occurrence.start}:${occurrence.end}:1`,
        text: text.slice(occurrence.start, occurrence.end),
        highlighted: true,
      });
    }

    cursor = occurrence.end;
  }

  if (cursor < text.length) {
    segments.push({
      key: `${cursor}:${text.length}:0`,
      text: text.slice(cursor),
      highlighted: false,
    });
  }

  return segments;
}

export function createSearchSnippet(text: string, start: number, end: number, radius = 54): string {
  let prefixStart = Math.max(0, start - radius);
  if (prefixStart > 0) {
    const nearestWordBoundary = text.lastIndexOf(" ", prefixStart);
    if (nearestWordBoundary >= 0 && nearestWordBoundary < start) {
      prefixStart = nearestWordBoundary + 1;
    }
  }

  const suffixEnd = Math.min(text.length, end + radius);
  const prefix = text.slice(prefixStart, start).trimStart();
  const match = text.slice(start, end);
  const suffix = text.slice(end, suffixEnd).trimEnd();

  return `${prefixStart > 0 ? "…" : ""}${prefix}${match}${suffix}${suffixEnd < text.length ? "…" : ""}`;
}
