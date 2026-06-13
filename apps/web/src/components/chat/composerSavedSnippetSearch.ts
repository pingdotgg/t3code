import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

/**
 * Score a saved-snippet menu item against a normalized query.
 *
 * Scoring is intentionally a touch looser than `composerSlashCommandSearch`
 * — snippets are user-authored so the "trigger" is more often typed-from-
 * memory than scanned from the menu. We match on the trigger slug first,
 * then the title, then the description. Body is intentionally not scored
 * (long bodies would dominate ranking with substring hits).
 */
export function scoreSavedSnippetItem(
  item: Extract<ComposerCommandItem, { type: "saved-snippet" }>,
  query: string,
): number | null {
  const trigger = item.snippet.id.toLowerCase();
  const title = item.snippet.title.toLowerCase();
  const description = (item.snippet.description ?? "").toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: trigger,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_"],
    }),
    scoreQueryMatch({
      value: title,
      query,
      exactBase: 10,
      prefixBase: 12,
      boundaryBase: 14,
      includesBase: 16,
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

/**
 * Rank saved-snippet menu items against a slash command query.
 *
 * `query` is the raw text after the leading `/` (the same string the
 * existing slash command search consumes). Returns items in display
 * order: best match first, ties broken by title, then by id.
 */
export function searchSavedSnippetItems(
  items: ReadonlyArray<Extract<ComposerCommandItem, { type: "saved-snippet" }>>,
  query: string,
): Array<Extract<ComposerCommandItem, { type: "saved-snippet" }>> {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: Extract<ComposerCommandItem, { type: "saved-snippet" }>;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSavedSnippetItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: `2\u0000${item.snippet.id}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
