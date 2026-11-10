import type { ServerProviderSkill } from "@t3tools/contracts";

export function matchesSlashSkillQuery(skill: ServerProviderSkill, query: string): boolean {
  if (!skill.enabled) return false;
  const normalizedQuery = query.toLowerCase();
  const skillQuery =
    normalizedQuery === "skill"
      ? ""
      : normalizedQuery.startsWith("skill:")
        ? normalizedQuery.slice("skill:".length)
        : normalizedQuery;
  if (!skillQuery) return true;
  return [skill.name, skill.displayName, skill.shortDescription, skill.description].some((value) =>
    value?.toLowerCase().includes(skillQuery),
  );
}
