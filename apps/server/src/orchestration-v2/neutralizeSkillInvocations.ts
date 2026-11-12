const WORD_JOINER = "\u2060";
// Any currency sign before a name: Claude's dispatch and Codex's native mention parser both read these.
const SKILL_SIGIL = /\p{Sc}(?=[a-zA-Z0-9:_-]*[a-zA-Z])/gu;
const LEADING_SLASH_COMMAND = /^(\s*)\/(?=[a-zA-Z])/u;

/** Keeps another agent's skill mentions as text so the recipient's provider does not run them. */
export function neutralizeSkillInvocations(text: string): string {
  return text
    .replace(SKILL_SIGIL, `$&${WORD_JOINER}`)
    .replace(LEADING_SLASH_COMMAND, `$1${WORD_JOINER}/`);
}
