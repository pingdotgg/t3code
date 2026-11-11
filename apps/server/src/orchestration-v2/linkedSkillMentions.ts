import { ProviderDriverKind } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

interface LinkedSkillMention {
  readonly name: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export function collectLinkedSkillMentions(text: string): ReadonlyArray<LinkedSkillMention> {
  // Tokens need a delimiter after them; a sent prompt may end on a mention.
  return collectComposerInlineTokens(`${text} `).flatMap((token) =>
    token.type === "skill" && token.path !== undefined
      ? [{ name: token.value, path: token.path, start: token.start, end: token.end }]
      : [],
  );
}

export function replaceLinkedSkillMentions(
  text: string,
  mentions: ReadonlyArray<LinkedSkillMention>,
  replacement: (mention: LinkedSkillMention) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const mention of mentions) {
    result += text.slice(cursor, mention.start) + replacement(mention);
    cursor = mention.end;
  }
  return result + text.slice(cursor);
}

// Remove the sigil so a provider cannot dispatch a different same-name skill.
// A link to the file the provider's plain `$name` already runs stays a native mention.
export function expandLinkedSkillMentions(
  text: string,
  isNative: (mention: LinkedSkillMention) => boolean = () => false,
): string {
  const mentions = collectLinkedSkillMentions(text);
  if (mentions.length === 0) return text;
  const body = replaceLinkedSkillMentions(text, mentions, (mention) =>
    isNative(mention) ? `$${mention.name}` : mention.name,
  );
  const skillByPath = new Map(
    mentions.filter((mention) => !isNative(mention)).map((mention) => [mention.path, mention.name]),
  );
  if (skillByPath.size === 0) return body;
  const instructions = [...skillByPath].map(
    ([path, name]) =>
      `The user invoked the \`${name}\` skill defined in ${path}. Read that file and follow its instructions, not those of any other skill named \`${name}\`.`,
  );
  return `${body}\n\n${instructions.join("\n")}`;
}

export function spellOutLinkedSkillMentions<
  Input extends { readonly message: { readonly text: string } },
>(driver: ProviderDriverKind, input: Input, steering: boolean): Input {
  // Codex reads structured skill inputs at turn start but ignores them on turn/steer.
  if (driver === CODEX_DRIVER && !steering) return input;
  // Claude's adapter knows which copy its native `/name` runs and expands links itself.
  if (driver === CLAUDE_DRIVER) return input;
  const text = expandLinkedSkillMentions(input.message.text);
  return text === input.message.text ? input : { ...input, message: { ...input.message, text } };
}
