export const INCREMENTAL_TEXT_COMPLETION_INTERVAL_MS = 24;

export function splitTextForIncrementalCompletion(text: string): string[] {
  return Array.from(text);
}

export function getIncrementalTextCompletionStart(currentText: string, nextText: string): number {
  const currentCharacters = splitTextForIncrementalCompletion(currentText);
  const nextCharacters = splitTextForIncrementalCompletion(nextText);
  const maxSharedLength = Math.min(currentCharacters.length, nextCharacters.length);

  let sharedLength = 0;
  while (
    sharedLength < maxSharedLength &&
    currentCharacters[sharedLength] === nextCharacters[sharedLength]
  ) {
    sharedLength += 1;
  }

  return sharedLength;
}
