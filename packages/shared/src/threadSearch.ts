import { EXACT_PHRASE_GAP } from "./paletteSearch.ts";

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

  // Search snippets collapse whitespace. Use the same gap limit as quoted
  // search so a wider gap in the message cannot take the selected occurrence.
  const phrase = foldThreadSearchCase(query)
    .split(/(?<=\S) (?=\S)/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(`\\s{1,${EXACT_PHRASE_GAP}}`);
  let count = 0;
  for (const match of foldThreadSearchCase(text).matchAll(new RegExp(phrase, "g"))) {
    ranges?.push({ start: match.index, end: match.index + match[0].length });
    count += 1;
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
