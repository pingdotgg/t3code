import { insertRankedSearchResult, normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreSavedSnippetItem } from "./composerSavedSnippetSearch";
import { scoreSlashCommandItem } from "./composerSlashCommandSearch";

type SlashMenuItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "saved-snippet" }
>;

export function searchSlashMenuItems(
  items: ReadonlyArray<SlashMenuItem>,
  query: string,
): SlashMenuItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{ item: SlashMenuItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const score =
      item.type === "saved-snippet"
        ? scoreSavedSnippetItem(item, normalizedQuery)
        : scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    const tieBreaker =
      item.type === "saved-snippet"
        ? `0\u0000${item.snippet.id}`
        : item.type === "slash-command"
          ? `1\u0000${item.command}`
          : `2\u0000${item.command.name}\u0000${item.provider}`;
    insertRankedSearchResult(ranked, { item, score, tieBreaker }, Number.POSITIVE_INFINITY);
  }

  return ranked.map((entry) => entry.item);
}
