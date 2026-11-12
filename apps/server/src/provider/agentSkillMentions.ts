import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

const WORD_JOINER = "\u2060";
// Codex parses `$name` after any non-name character; Claude's dispatch accepts any currency sign.
const SIGIL_MENTION = /(?<![a-zA-Z0-9:_-])(\p{Sc})([a-zA-Z0-9][a-zA-Z0-9:_-]*)/gu;
const LEADING_COMMAND = /^(\s*)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)/u;

/** An agent wrote it and no user asked for it, so a skill it names must not run. */
export function isAgentWrittenMessage(
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy" | "scheduledTaskId">,
): boolean {
  return message.createdBy === "agent" && message.scheduledTaskId === undefined;
}

/** Breaks mentions of the recipient's own skills; every other `$word` or `/word` is left alone. */
export function neutralizeSkillMentions(text: string, isSkill: (name: string) => boolean): string {
  return text
    .replace(SIGIL_MENTION, (match, sigil: string, name: string) =>
      isSkill(name) ? `${sigil}${WORD_JOINER}${name}` : match,
    )
    .replace(LEADING_COMMAND, (match, space: string, name: string) =>
      isSkill(name) ? `${space}${WORD_JOINER}/${name}` : match,
    );
}
