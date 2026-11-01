import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreProviderSkill } from "../../providerSkillSearch";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

export function expandGoalSubcommands(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
  objective: string | null,
): SlashSearchItem[] {
  if (!/^goal(?:\s|$)/i.test(query)) return [...items];
  return items.flatMap((item): SlashSearchItem[] => {
    if (
      item.type !== "provider-slash-command" ||
      item.command.name !== "goal" ||
      (item.provider !== "codex" && item.provider !== "claudeAgent")
    )
      return [item];
    const commands = [
      ...(objective === null ? [] : [{ name: "edit", description: "Edit the current goal" }]),
      ...(item.provider === "codex"
        ? [
            { name: "pause", description: "Pause the current goal" },
            { name: "resume", description: "Resume the current goal" },
          ]
        : []),
      { name: "clear", description: "Remove the current goal" },
    ];
    const prefix = query.slice("goal".length).trim().toLowerCase();
    return [
      item,
      ...commands
        .filter(({ name }) => name.startsWith(prefix))
        .map(({ name, description }) => ({
          ...item,
          id: `${item.id}:${name}`,
          command: { name: `goal ${name}`, description },
          label: `/goal ${name}`,
          description,
          ...(name === "edit" ? { replacementText: `/goal ${objective}` } : {}),
        })),
    ];
  });
}

/** Provider commands, `/side` and `/btw` work only at the message start. */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
): SlashSearchItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter(
    (item) =>
      item.type === "skill" ||
      (item.type === "slash-command" && item.command !== "side" && item.command !== "btw"),
  );
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    if (query === "skill") {
      return 0;
    }
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const skillScore = skillQuery ? scoreProviderSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) {
      return skillScore;
    }
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }

  const primaryValue =
    item.type === "slash-command" ? item.command.toLowerCase() : item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

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

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ }).replace(
    /^goal[\t ]+/,
    "goal ",
  );
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: SlashSearchItem;
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
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : item.type === "provider-slash-command"
              ? `1\u0000${item.command.name}\u0000${item.provider}`
              : `2\u0000${item.skill.name}\u0000${item.provider}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
