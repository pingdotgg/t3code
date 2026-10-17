import { ProviderDriverKind } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

/**
 * The composer links a skill pick to its file, `[$name](…/SKILL.md)`, when
 * another skill shares the name. Providers invoke skills by name and would run
 * whichever same-name skill they resolve first, so Codex gets a structured
 * skill input (CodexAdapterV2) and every other provider gets the link spelled
 * out (spellOutLinkedSkillMentions).
 */
export interface LinkedSkillMention {
  readonly name: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export function collectLinkedSkillMentions(text: string): ReadonlyArray<LinkedSkillMention> {
  // Tokens need a delimiter after them; a sent prompt may end on a mention.
  return collectComposerInlineTokens(`${text} `).flatMap((token) =>
    token.type === "skill" && token.path !== undefined
      ? [{ name: token.value, path: token.path, start: token.start, end: token.end }]
      : [],
  );
}

/** `text` with each mention, in order, replaced by `replacement(mention)`. */
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

/**
 * For providers that invoke skills by name: each link becomes the bare name,
 * so no adapter dispatches it by name, plus an instruction to follow the
 * picked file.
 */
export function expandLinkedSkillMentions(text: string): string {
  const mentions = collectLinkedSkillMentions(text);
  if (mentions.length === 0) return text;
  const body = replaceLinkedSkillMentions(text, mentions, (mention) => mention.name);
  const skillByPath = new Map(mentions.map((mention) => [mention.path, mention.name]));
  const instructions = [...skillByPath].map(
    ([path, name]) =>
      `The user invoked the \`${name}\` skill defined in ${path}. Read that file and follow its instructions, not those of any other skill named \`${name}\`.`,
  );
  return `${body}\n\n${instructions.join("\n")}`;
}

export function spellOutLinkedSkillMentions<
  Input extends { readonly message: { readonly text: string } },
>(driver: ProviderDriverKind, input: Input): Input {
  if (driver === CODEX_DRIVER) return input;
  const text = expandLinkedSkillMentions(input.message.text);
  return text === input.message.text ? input : { ...input, message: { ...input.message, text } };
}
