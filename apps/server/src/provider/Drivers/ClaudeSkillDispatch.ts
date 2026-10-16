/**
 * ClaudeSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * slash invocation Claude Code actually runs.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not, and treats it as prose. Claude Code's only user-side
 * invocation is a text block whose first character is `/`: the harness
 * expands `/name args` into the SKILL.md body, and every character after the
 * name (newlines included) arrives as `ARGUMENTS`. Verified against the CLI in
 * stream-json mode, which is what the Agent SDK uses:
 *
 *  - The check runs on the LAST text block of the message. Earlier text
 *    blocks are preserved verbatim, and image blocks may sit before it.
 *  - Leading whitespace, or a `/name` that starts a later line of the same
 *    block, is literal text.
 *  - Only one skill expands per message; a second `/x` becomes argument text
 *    (anthropics/claude-code#87113). The model still starts the rest through
 *    its Skill tool when it reads `/name` in the prompt, so earlier mentions
 *    are rewritten to `/name` inline.
 *
 * So one mention anywhere in the prompt becomes a guaranteed invocation, and
 * the user's text on either side is kept in order.
 *
 * The model's Skill tool refuses a skill that opts out of model invocation
 * (`disable-model-invocation`), so an earlier mention of one would dead-end in
 * "ask the user to run it". Those mentions also carry the skill's file path and
 * say the user invoked it, which lets the model read and follow it.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/**
 * What the dispatcher needs to know about one discovered skill.
 * `userInvocationOnly` marks a skill the model may not start itself.
 */
export interface ClaudeSkillTarget {
  readonly path: string;
  readonly userInvocationOnly?: boolean;
}

export interface ClaudeSkillDispatch {
  /** Text before the dispatched mention, or `undefined` when it opens the prompt. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` mention that names a known skill.
 * Returns `undefined` when there is nothing to dispatch, in which case the
 * prompt should go out unchanged. Mentions that do not match a discovered
 * skill stay literal: a `$HOME` in prose must not become a command.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skills.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  // A skill named twice is annotated once, and the last skill needs no note
  // because the CLI expands it itself.
  const annotated = new Set([last.name]);
  const inlineSlash = (name: string): string => {
    const skill = skills.get(name);
    if (skill?.userInvocationOnly !== true || annotated.has(name)) {
      return `/${name}`;
    }
    annotated.add(name);
    return `/${name} [The user invoked this skill. Follow the instructions at: ${skill.path}]`;
  };
  // Built front to back so the note lands on a skill's first mention, then
  // spliced back to front so earlier offsets stay valid.
  const replacements = mentions.slice(0, -1).map((mention) => inlineSlash(mention.name));
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention, index) =>
        `${text.slice(0, mention.start)}${replacements[index]}${text.slice(mention.end)}`,
      leading,
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
