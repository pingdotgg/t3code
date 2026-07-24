const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=$|\s|[,.!?])/g;
const SKILL_TOKEN_TEST_REGEX = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=$|\s|[,.!?])/;

export interface InlineSkillToken {
  readonly name: string;
  readonly rawText: string;
  readonly start: number;
}

export function parseInlineSkillTokens(text: string): ReadonlyArray<InlineSkillToken> {
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
