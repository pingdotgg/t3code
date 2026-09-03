/**
 * CodexSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * typed `skill` input the Codex app server loads.
 *
 * The composer inserts `$name` for every provider. The Codex app server takes
 * that as prose, and a skill that only the user may start
 * (`allow_implicit_invocation: false`) is absent from the catalog the model
 * sees, so the prompt names a skill the model cannot reach. Verified against
 * Codex 0.152.1 by pointing it at a recording model endpoint: only a
 * `{ type: "skill", name, path }` input item makes the app server inject the
 * SKILL.md body into the turn; plain text and `mention` items do not. The item
 * goes out beside the text, so the user's words are kept as written.
 *
 * The same run showed the app server dropping skill items from input that
 * steers a turn already running, so the item only lands on a turn Codex starts
 * fresh. That limit is Codex's own and nothing here works around it.
 *
 * @module provider/Drivers/CodexSkillDispatch
 */

/**
 * Same token shape the timeline chip recognises on a sent message
 * (`apps/web/src/components/chat/SkillInlineText.tsx`) and that Claude
 * dispatch uses, so a rendered chip and a dispatched skill are always the same
 * set. End of text counts as a boundary because the composer trims the prompt
 * on send: a skill picked last arrives as `$name` with nothing after it. The
 * editor's own regex (`packages/shared/src/composerInlineTokens.ts`) wants
 * trailing whitespace only because the picker inserts one while typing.
 */
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const SKILL_MENTION_TEST = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;

export interface CodexSkillInput {
  readonly name: string;
  readonly path: string;
}

/** Cheap gate for the catalog read: a prompt with no `$name` token needs none. */
export function hasCodexSkillMention(prompt: string): boolean {
  return SKILL_MENTION_TEST.test(prompt);
}

/**
 * Every discovered, enabled skill the prompt names, once each in first-mention
 * order. Mentions that name nothing discovered stay literal: a `$HOME` in prose
 * must not become an invocation.
 */
export function resolveCodexSkillMentions(
  prompt: string,
  skills: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
  }>,
): ReadonlyArray<CodexSkillInput> {
  const pathByName = new Map<string, string>();
  for (const skill of skills) {
    if (skill.enabled && !pathByName.has(skill.name)) pathByName.set(skill.name, skill.path);
  }
  const resolved = new Map<string, string>();
  for (const match of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2] ?? "";
    const path = pathByName.get(name);
    if (path !== undefined && !resolved.has(name)) resolved.set(name, path);
  }
  return Array.from(resolved, ([name, path]) => ({ name, path }));
}
