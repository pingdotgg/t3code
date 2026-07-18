export interface TextMatch {
  start: number;
  end: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findAllMatches(text: string, query: string): TextMatch[] {
  if (!query || !text) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: TextMatch[] = [];
  let pos = 0;
  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    matches.push({ start: pos, end: pos + lowerQuery.length });
    pos += 1;
  }
  return matches;
}

/** Wraps all occurrences of `query` in `text` with `<mark>` tags. */
export function highlightHtml(text: string, query: string): string {
  if (!query || !text) return text;
  const escaped = escapeRegex(query);
  return text.replace(new RegExp(`(${escaped})`, "gi"), '<mark class="search-highlight">$1</mark>');
}
