import type { ServerProviderSkill } from "@t3tools/contracts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name"> & { readonly displayName?: string | null | undefined },
): string {
  return skill.displayName?.trim() || skill.name;
}

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export function* matchInlineSkills<Skill extends InlineSkill>(
  text: string,
  skills: readonly Skill[],
) {
  const byName = new Map<string, Skill | undefined>();
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2] ?? "";
    if (!byName.has(name)) {
      byName.set(
        name,
        skills.find((candidate) => candidate.name === name),
      );
    }
    const skill = byName.get(name);
    if (!skill) continue;
    const start = match.index + (match[1]?.length ?? 0);
    yield { start, end: match.index + match[0].length, skill, rawText: `$${name}` };
  }
}
