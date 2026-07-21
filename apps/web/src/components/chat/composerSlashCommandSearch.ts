import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

function scoreSlashCommandItem(
  item: Extract<
    ComposerCommandItem,
    { type: "slash-command" | "provider-slash-command" | "custom-slash-command" }
  >,
  query: string,
): number | null {
  const primaryValue =
    item.type === "slash-command"
      ? item.command.toLowerCase()
      : (item.command.displayName ?? item.command.name).toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    ...(item.type === "slash-command"
      ? []
      : [
          scoreQueryMatch({
            value: item.description.toLowerCase(),
            query,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
        ]),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<
    Extract<
      ComposerCommandItem,
      { type: "slash-command" | "provider-slash-command" | "custom-slash-command" }
    >
  >,
  query: string,
): Array<
  Extract<
    ComposerCommandItem,
    { type: "slash-command" | "provider-slash-command" | "custom-slash-command" }
  >
> {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: item.id,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
