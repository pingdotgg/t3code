// A typed straight apostrophe finds a curly one: iOS keyboards type "’".
const foldCharacters = (text: string) => text.replace(/ς/g, "σ").replace(/[‘’]/g, "'");

function foldThreadSearchCase(text: string): string {
  const lowered = foldCharacters(text.toLowerCase());
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    const loweredCharacter = foldCharacters(character.toLowerCase());
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

function scanThreadSearchOccurrences(text: string, query: string, offsets?: number[]): number {
  if (text.length === 0 || query.length === 0) return 0;

  const foldedText = foldThreadSearchCase(text);
  const foldedQuery = foldThreadSearchCase(query);
  let count = 0;
  let cursor = 0;

  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    offsets?.push(offset);
    count += 1;
    cursor = offset + foldedQuery.length;
  }
  return count;
}

export function countThreadSearchOccurrences(text: string, query: string): number {
  return scanThreadSearchOccurrences(text, query);
}

export function findThreadSearchOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  scanThreadSearchOccurrences(text, query, offsets);
  return offsets;
}
