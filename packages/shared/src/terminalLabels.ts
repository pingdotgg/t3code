export function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = terminalNumber(terminalId);
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

/** Append a UUID when metadata is unavailable to avoid reusing unseen host sessions. */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  uniqueSuffix?: string,
): string {
  const usedNumbers = new Set(existingTerminalIds.map(terminalNumber));
  let nextIndex = 1;
  while (usedNumbers.has(String(nextIndex))) {
    nextIndex += 1;
  }

  return `term-${nextIndex}${uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`}`;
}
