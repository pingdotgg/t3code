export interface ComposerPullRequestMatch {
  readonly number: number;
  readonly projectId: string;
  readonly repository: string;
  readonly updatedAt: string;
}

/**
 * Pull requests matching the numeric fragment typed after `#`, de-duplicated. An exact number
 * match always outranks a substring match so the result limit can never drop the pull request
 * the user typed in full; the rest stay newest first.
 */
export function filterComposerPullRequestMatches<Entry extends ComposerPullRequestMatch>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly projectId: string;
  readonly repository: string;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<Entry> {
  const repository = input.repository.trim().toLowerCase();
  const matchingEntries = input.entries.filter(
    (entry) =>
      entry.projectId === input.projectId &&
      entry.repository.trim().toLowerCase() === repository &&
      String(entry.number).includes(input.query),
  );
  const uniqueEntries = new Map<number, Entry>();
  for (const entry of matchingEntries) {
    if (!uniqueEntries.has(entry.number)) {
      uniqueEntries.set(entry.number, entry);
    }
  }
  const isExactMatch = (entry: Entry) => String(entry.number) === input.query;
  // `.sort()` on a copy, not `.toSorted()`: this runs on Hermes, which has no ES2023 array
  // methods, and reaching for one here crashed the composer as the suggestions loaded.
  return [...uniqueEntries.values()]
    .sort((left, right) => {
      const exactness = Number(isExactMatch(right)) - Number(isExactMatch(left));
      return exactness !== 0 ? exactness : right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, input.limit);
}
