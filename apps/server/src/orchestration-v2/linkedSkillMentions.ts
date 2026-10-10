import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import * as Schema from "effect/Schema";

/**
 * The composer links a skill pick to its file, `[$name](…/SKILL.md)`, when
 * another skill shares the name. Before a turn reaches a provider, every link
 * must name a skill that provider reported. Name-based dispatch would run
 * whichever same-name skill a provider resolves first, so Codex gets a
 * structured skill input (CodexAdapterV2) and every other provider gets the
 * link spelled out (expandLinkedSkillMentions).
 */
export interface LinkedSkillMention {
  readonly name: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export class UnavailableSkillMentionError extends Schema.TaggedError<UnavailableSkillMentionError>()(
  "UnavailableSkillMentionError",
  { name: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `The \`${this.name}\` skill at ${this.path} is not available to this provider. Pick it again from the skill menu and resend.`;
  }
}

/** Fenced blocks and backtick spans, where a link is literal text, not a pick. */
function markdownCodeRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let fence: { readonly start: number; readonly marker: string } | undefined;
  let outsideStart = 0;
  const addSpans = (start: number, end: number) => {
    for (const span of text.slice(start, end).matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      ranges.push([start + span.index, start + span.index + span[0].length]);
    }
  };
  for (const line of text.matchAll(/^.*(?:\n|$)/gm)) {
    if (line[0].length === 0) break;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line[0])?.[1];
    if (fence === undefined && marker !== undefined) {
      addSpans(outsideStart, line.index);
      fence = { start: line.index, marker };
    } else if (
      fence !== undefined &&
      marker !== undefined &&
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      line[0].trim() === marker
    ) {
      ranges.push([fence.start, line.index + line[0].length]);
      fence = undefined;
      outsideStart = line.index + line[0].length;
    }
  }
  if (fence === undefined) addSpans(outsideStart, text.length);
  else ranges.push([fence.start, text.length]);
  return ranges;
}

export function collectLinkedSkillMentions(text: string): ReadonlyArray<LinkedSkillMention> {
  // Tokens need a delimiter after them; a sent prompt may end on a mention.
  const tokens = collectComposerInlineTokens(`${text} `);
  if (!tokens.some((token) => token.type === "skill" && token.path !== undefined)) return [];
  const code = markdownCodeRanges(text);
  return tokens.flatMap((token) =>
    token.type === "skill" &&
    token.path !== undefined &&
    !code.some(([start, end]) => token.start >= start && token.start < end)
      ? [{ name: token.value, path: token.path, start: token.start, end: token.end }]
      : [],
  );
}

/** The first link that names no enabled, user-invocable skill of the provider. */
export function findUnavailableSkillMention(
  mentions: ReadonlyArray<LinkedSkillMention>,
  skills: ReadonlyArray<ServerProviderSkill>,
): UnavailableSkillMentionError | undefined {
  const mention = mentions.find(
    (candidate) =>
      !skills.some(
        (skill) =>
          skill.path === candidate.path &&
          skill.name === candidate.name &&
          skill.enabled &&
          skill.userInvocable !== false,
      ),
  );
  return mention === undefined
    ? undefined
    : new UnavailableSkillMentionError({ name: mention.name, path: mention.path });
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
 * picked file. Codex instead gets structured skill inputs (CodexAdapterV2).
 */
export function expandLinkedSkillMentions(
  text: string,
  mentions: ReadonlyArray<LinkedSkillMention>,
): string {
  if (mentions.length === 0) return text;
  const body = replaceLinkedSkillMentions(text, mentions, (mention) => mention.name);
  const skillByPath = new Map(mentions.map((mention) => [mention.path, mention.name]));
  const instructions = [...skillByPath].map(
    ([path, name]) =>
      `The user invoked the \`${name}\` skill defined in ${path}. Read that file and follow its instructions, not those of any other skill named \`${name}\`.`,
  );
  return `${body}\n\n${instructions.join("\n")}`;
}
