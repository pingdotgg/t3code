import type { ServerProviderSkill } from "@t3tools/contracts";
import { scoreQueryMatch } from "@t3tools/shared/searchRanking";

/** Lower is better; `null` when the skill does not match. */
export function scoreSlashSkillQuery(skill: ServerProviderSkill, query: string): number | null {
  if (!skill.enabled) return null;
  const normalizedQuery = query.toLowerCase();
  const skillQuery =
    normalizedQuery === "skill"
      ? ""
      : normalizedQuery.startsWith("skill:")
        ? normalizedQuery.slice("skill:".length)
        : normalizedQuery;
  if (!skillQuery) return 0;
  const scores = [
    scoreQueryMatch({
      value: skill.name.toLowerCase(),
      query: skillQuery,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: skill.displayName?.toLowerCase() ?? "",
      query: skillQuery,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
    }),
    scoreQueryMatch({
      value: skill.shortDescription?.toLowerCase() ?? "",
      query: skillQuery,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: skill.description?.toLowerCase() ?? "",
      query: skillQuery,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
  ].filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}
