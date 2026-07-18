const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface InlineSkillToken {
  name: string;
  rawText: string;
  start: number;
}

export function parseInlineSkillTokens(text: string): InlineSkillToken[] {
  const tokens: InlineSkillToken[] = [];

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    tokens.push({
      name,
      rawText: `$${name}`,
      start: (match.index ?? 0) + prefix.length,
    });
  }

  return tokens;
}
