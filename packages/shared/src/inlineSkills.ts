import type { ServerProviderSkill } from "@t3tools/contracts";

import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

/** `path` tells same-name skills apart when a message links one by its SKILL.md. */
export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName"> & {
  readonly path?: string | undefined;
};

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

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export function* matchInlineSkills(text: string, skills: readonly InlineSkill[]) {
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2] ?? "";
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) continue;
    const start = match.index + (match[1]?.length ?? 0);
    yield { start, end: match.index + match[0].length, skill, rawText: `$${name}` };
  }
}

/**
 * Markdown parses a linked skill mention, `[$name](…/SKILL.md)`, as a link.
 * Given that link's source, returns the skill its chip shows, or null for any other link.
 */
export function resolveLinkedInlineSkill(
  source: string,
  skills: readonly InlineSkill[],
): InlineSkill | null {
  if (!source.startsWith("[$")) return null;
  const token = collectComposerInlineTokens(`${source} `)[0];
  if (token?.type !== "skill" || token.path === undefined || token.end !== source.length) {
    return null;
  }
  return (
    skills.find((candidate) => candidate.path === token.path) ??
    skills.find((candidate) => candidate.name === token.value) ?? { name: token.value }
  );
}
