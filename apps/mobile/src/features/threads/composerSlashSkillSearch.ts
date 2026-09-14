import type { ServerProviderSkill } from "@t3tools/contracts";

function matchesSkillQueryForm(skill: ServerProviderSkill, queryForm: string): boolean {
  const normalizedQuery = queryForm.toLowerCase();
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

/**
 * `queryForms` holds what was typed followed by its keyboard layout variants,
 * expanded once for the whole menu; any form matching is a hit.
 */
export function matchesSlashSkillQuery(
  skill: ServerProviderSkill,
  queryForms: ReadonlyArray<string>,
): boolean {
  if (!skill.enabled) return false;
  return queryForms.some((queryForm) => matchesSkillQueryForm(skill, queryForm));
}
