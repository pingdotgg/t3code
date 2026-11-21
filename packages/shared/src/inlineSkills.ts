import type { ServerProviderSkill } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "./composerInlineTokens.ts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name"> & { readonly displayName?: string | null | undefined },
): string {
  return skill.displayName?.trim() || skill.name;
}

export function* matchInlineSkills<Skill extends InlineSkill>(
  text: string,
  skills: readonly Skill[],
) {
  const byName = new Map<string, Skill | undefined>();
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
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
