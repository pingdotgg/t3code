/**
 * Claude Code's only user-side invocation is a text block whose first character
 * is `/`: the harness expands `/name args` into the SKILL.md body, and every
 * character after the name (newlines included) arrives as `ARGUMENTS`. Only one
 * skill expands per message; a second `/x` becomes argument text
 *    (anthropics/claude-code#87113).
 */

import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";

export interface ClaudeSkillDispatch {
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

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
