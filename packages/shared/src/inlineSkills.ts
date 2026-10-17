import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerSkillTokens, serializeComposerSkillToken } from "./composerInlineTokens.ts";

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function* matchInlineSkills(text: string, skills: readonly InlineSkill[]) {
  for (const { value: name, start, end } of collectComposerSkillTokens(text)) {
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    yield { start, end, skill, rawText: serializeComposerSkillToken(name) };
  }
}
