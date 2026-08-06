export interface ThreadSubtitleSource {
  readonly title: string;
  readonly subtitle?: string | null | undefined;
}

/** Return only a useful, non-duplicative generated subtitle for display. */
export function displayThreadSubtitle(thread: ThreadSubtitleSource): string | null {
  const subtitle = thread.subtitle?.replace(/\s+/g, " ").trim();
  if (!subtitle) return null;
  return subtitle.localeCompare(thread.title.trim(), undefined, { sensitivity: "accent" }) === 0
    ? null
    : subtitle;
}

export function threadSubtitleMatches(
  thread: ThreadSubtitleSource,
  normalizedQuery: string,
): boolean {
  const subtitle = displayThreadSubtitle(thread);
  return subtitle !== null && subtitle.toLocaleLowerCase().includes(normalizedQuery);
}
