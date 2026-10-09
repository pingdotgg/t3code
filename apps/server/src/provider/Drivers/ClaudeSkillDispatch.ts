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
 * @module provider/Drivers/ClaudeSkillDispatch
 */

import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";

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
 * skill stay literal: a `$HOME` in prose must not become a command. Names
 * containing whitespace also stay literal because slash commands cannot
 * preserve them as one command name.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): ClaudeSkillDispatch | undefined {
  const mentions = collectComposerSkillTokens(prompt).flatMap((token) => {
    const name = token.value;
    // Native slash invocations separate the command name from arguments at whitespace.
    if (/\s/u.test(name) || !skillNames.has(name)) return [];
    return [{ name, start: token.start, end: token.end }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) =>
        `${text.slice(0, mention.start)}/${mention.name}${text.slice(mention.end)}`,
      leading,
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
