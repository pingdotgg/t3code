// A typed straight apostrophe finds a curly one: iOS keyboards type "’".
const foldCharacters = (text: string) => text.replace(/ς/g, "σ").replace(/[‘’]/g, "'");

function foldThreadSearchCase(text: string): string {
  const lowered = foldCharacters(text.toLowerCase());
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    // Lowercasing İ adds a combining dot. Drop that expansion to preserve source offsets.
    const loweredCharacter = foldCharacters(character.toLowerCase()).replace("i\u0307", "i");
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

interface ThreadSearchRange {
  readonly start: number;
  readonly end: number;
}

function scanThreadSearchOccurrences(
  text: string,
  query: string,
  ranges?: ThreadSearchRange[],
): number {
  if (text.length === 0 || query.length === 0) return 0;

  const foldedText = foldThreadSearchCase(text);
  const foldedQuery = foldThreadSearchCase(query);
  // Search snippets collapse whitespace. Match a single space between words
  // against the original run, while allowing explicit indentation queries.
  const parts = foldedQuery.split(/(?<=\S) (?=\S)/);
  if (parts.length > 1) {
    const phrase = new RegExp(
      parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
      "g",
    );
    let count = 0;
    for (const match of foldedText.matchAll(phrase)) {
      ranges?.push({ start: match.index, end: match.index + match[0].length });
      count += 1;
    }
    return count;
  }

  let count = 0;
  let cursor = 0;

  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    ranges?.push({ start: offset, end: offset + foldedQuery.length });
    count += 1;
    cursor = offset + foldedQuery.length;
  }
  return count;
}

export function countThreadSearchOccurrences(text: string, query: string): number {
  return scanThreadSearchOccurrences(text, query);
}

export function findThreadSearchRanges(text: string, query: string): ThreadSearchRange[] {
  const ranges: ThreadSearchRange[] = [];
  scanThreadSearchOccurrences(text, query, ranges);
  return ranges;
}
