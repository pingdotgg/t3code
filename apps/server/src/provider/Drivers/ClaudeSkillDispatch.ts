// Claude Code expands only the last text block, with `/name` at its start.
// Everything after the command name, including other commands, is argument text.

// Match the chip syntax in packages/shared/src/composerInlineTokens.ts.
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

const LEADING_SLASH_COMMAND_PATTERN = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/u;

export interface ClaudeSkillDispatch {
  /** The whole rewritten prompt when dispatching a skill from within the request. */
  readonly leadingText: string | undefined;
  /** The leading command or last skill invocation, sent as the last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const promptWithInlineSlashes = mentions
    .reduceRight(
      (text, mention) =>
        `${text.slice(0, mention.start)}/${mention.name}${text.slice(mention.end)}`,
      prompt,
    )
    .trimEnd();

  // Preserve /goal and known slash skills without mistaking root paths for commands.
  const leadingCommandName = LEADING_SLASH_COMMAND_PATTERN.exec(prompt)?.[1];
  if (leadingCommandName === "goal" || (leadingCommandName && skillNames.has(leadingCommandName))) {
    return {
      leadingText: undefined,
      commandText: promptWithInlineSlashes,
      skillName: last.name,
    };
  }

  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
    skillName: last.name,
  };
}
