/**
 * DevinSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * `@skills:name` invocation Devin actually runs.
 *
 * The composer inserts `$name` for every provider. Devin does not parse that
 * token; Devin's documented user-side invocation is `@skills:<name>` (see
 * docs.devin.ai/product-guides/skills). Unlike Claude Code — which requires a
 * slash command as the first character of the last text block — Devin accepts
 * the mention inline, so dispatch is a plain token substitution and the text
 * around it survives untouched.
 *
 * The same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`) is reused here, so a
 * rendered chip and a dispatched skill are always the same set. Unknown dollar
 * tokens stay literal: a `$HOME` in prose must not become a command, and a
 * token glued to other text (`5$implement`) is not a mention.
 *
 * @module provider/Drivers/DevinSkillDispatch
 */

const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface DevinSkillDispatch {
  /** The prompt with every known `$name` mention rewritten to `@skills:name`. */
  readonly prompt: string;
  /** The last skill name dispatched, for diagnostics. */
  readonly skillName: string;
}

/**
 * Rewrite every known `$skill` mention in `prompt` to `@skills:<name>`,
 * preserving surrounding text and trailing arguments. Returns `undefined`
 * when no known skill is mentioned, in which case the prompt goes out
 * unchanged. Mentions that do not match a discovered skill stay literal: a
 * `$HOME` in prose must not become a command, and a path-like token is never
 * inferred to be a skill.
 */
export function planDevinSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): DevinSkillDispatch | undefined {
  let dispatched = "";
  let lastIndex = 0;
  let dispatchedAny = false;
  let lastSkillName = "";

  for (const match of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) {
      continue;
    }
    const leading = match[1] ?? "";
    const tokenStart = (match.index ?? 0) + leading.length;

    dispatched += prompt.slice(lastIndex, tokenStart) + `@skills:${name}`;
    lastIndex = tokenStart + name.length + 1;
    dispatchedAny = true;
    lastSkillName = name;
  }

  if (!dispatchedAny) {
    return undefined;
  }
  return { prompt: dispatched + prompt.slice(lastIndex), skillName: lastSkillName };
}

/**
 * Whether `prompt` carries any `$skill`-shaped token at all. The adapter uses
 * this to skip discovery entirely on ordinary turns — the CLI probe only runs
 * when a candidate token exists, so prompts without a mention never pay for it.
 */
export function hasCandidateSkillMention(prompt: string): boolean {
  for (const _ of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    return true;
  }
  return false;
}
