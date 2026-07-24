import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

type ComposerSkillCommandItem = Extract<ComposerCommandItem, { readonly type: "skill" }>;

function skillCommandItem(skill: ServerProviderSkill): ComposerSkillCommandItem {
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    skill,
    label: skill.displayName ?? skill.name,
    description: skill.shortDescription ?? skill.description ?? "",
  };
}

export function buildComposerSkillItems(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
): Array<ComposerSkillCommandItem> {
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const normalizedQuery = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\$+/,
  });

  if (!normalizedQuery) {
    return enabledSkills.slice(0, 20).map(skillCommandItem);
  }

  const ranked: Array<{
    item: ServerProviderSkill;
    score: number;
    tieBreaker: string;
  }> = [];
  for (const skill of enabledSkills) {
    const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query: normalizedQuery,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: skill.shortDescription?.toLowerCase() ?? "",
        query: normalizedQuery,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? "",
        query: normalizedQuery,
        exactBase: 30,
        prefixBase: 32,
        boundaryBase: 34,
        includesBase: 36,
      }),
    ].filter((score): score is number => score !== null);

    if (scores.length > 0) {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}`,
        },
        20,
      );
    }
  }

  return ranked.map(({ item }) => skillCommandItem(item));
}
