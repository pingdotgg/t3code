/**
 * OmpSkillDispatch — turns `$skill` mentions from the composer into the
 * invocation omp actually runs.
 *
 * The composer inserts `$name` for every provider. omp has no `$` syntax: it
 * exposes each discovered skill as a `/skill:<name>` command and recognizes
 * that token even when it sits inside ordinary prose, which was verified over
 * ACP against omp/18.1.18 (`/skill:tdd` came back with the skill's content
 * loaded). Unlike Claude Code there is no last-text-block rule and no
 * one-command-per-message limit, so every known mention is rewritten in place
 * and the surrounding prose is left untouched.
 *
 * A mention that names no discovered skill stays literal: `$HOME` in prose
 * must not become a command.
 *
 * @module provider/Drivers/OmpSkillDispatch
 */

/**
 * Kept in sync with the composer's own skill-token regex
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/**
 * Rewrite every `$name` mention of a discovered skill as `/skill:name`.
 * Returns `undefined` when the prompt carries no known mention, in which case
 * it must go out unchanged.
 */
export function rewriteOmpSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string | undefined {
  if (skillNames.size === 0) return undefined;
  let rewritten = false;
  const result = prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) => {
    if (!skillNames.has(name)) return match;
    rewritten = true;
    return `${prefix}/skill:${name}`;
  });
  return rewritten ? result : undefined;
}
