export const DEFAULT_THREAD_TITLE = "New thread";

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

/**
 * Title for a thread forked from `sourceTitle`, following the Codex app's
 * convention: the first fork reuses the source title with " (1)", the next
 * gets " (2)", and so on. The counter is derived from the titles already in
 * the project so it survives renames and deletions of earlier forks. A
 * trailing "(n)" is treated as a fork suffix only when the source is itself a
 * fork, so a user title such as "Release (2024)" keeps its parenthetical.
 */
export function forkThreadTitle(
  sourceTitle: string,
  existingTitles: ReadonlyArray<string>,
  options: { readonly sourceIsFork: boolean },
): string {
  const trimmed = sourceTitle.trim();
  const base =
    (options.sourceIsFork ? trimmed.replace(/ \(\d+\)$/, "") : trimmed) || DEFAULT_THREAD_TITLE;
  const taken = new Set(existingTitles.map((title) => title.trim()));
  let index = 1;
  while (taken.has(`${base} (${index})`)) {
    index += 1;
  }
  return `${base} (${index})`;
}
