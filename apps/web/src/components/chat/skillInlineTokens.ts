const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?![a-zA-Z0-9:_-])/g;
const SKILL_TOKEN_TEST_REGEX = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?![a-zA-Z0-9:_-])/;

export interface InlineSkillToken {
  name: string;
  rawText: string;
  start: number;
}

export function parseInlineSkillTokens(text: string): InlineSkillToken[] {
  const tokens: InlineSkillToken[] = [];

  // matchAll clones the global RegExp, so repeated calls do not share lastIndex state.
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2];
    if (!name) continue;
    tokens.push({
      name,
      rawText: `$${name}`,
      start: (match.index ?? 0) + prefix.length,
    });
  }

  return tokens;
}

export function hasInlineSkillToken(text: string): boolean {
  return SKILL_TOKEN_TEST_REGEX.test(text);
}
