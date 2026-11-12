import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

/**
 * Claude expands one skill per message only when `/name` starts the text block.
 * Everything after the name, including newlines or a second `/x`, becomes `ARGUMENTS`.
 * https://github.com/anthropics/claude-code/issues/87113
 */

/** Match packages/shared/src/composerInlineTokens.ts so displayed chips and dispatched skills accept the same tokens. */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export type ClaudeSkillTarget = Pick<ServerProviderSkill, "path" | "userInvocationOnly">;

export interface ClaudeSkillDispatch {
  /** The whole prompt with mentions as `/name`, or `undefined` when the mention opens it. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
}

/**
 * `[$name](path)` picks one of several same-name files. The copy `/name` runs
 * keeps native dispatch; any other drops the sigil so Claude cannot run the
 * wrong copy, and points at the picked file instead.
 */
export function bindLinkedClaudeSkillMentions(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): string {
  // Tokens need a delimiter after them, and a prompt may end on a mention.
  const linked = collectComposerInlineTokens(`${prompt} `).flatMap((token) =>
    token.type === "skill" && token.path !== undefined ? [{ ...token, path: token.path }] : [],
  );
  let result = "";
  let cursor = 0;
  for (const mention of linked) {
    result += prompt.slice(cursor, mention.start);
    result +=
      skills.get(mention.value)?.path === mention.path
        ? `$${mention.value}`
        : `${mention.value} [The user invoked this skill. Follow the instructions at: ${mention.path}]`;
    cursor = mention.end;
  }
  return result + prompt.slice(cursor);
}

export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    const skill = skills.get(name);
    if (!skill) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, skill, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  // Only the final skill gets native expansion. Earlier user-only skills need
  // a fallback to their raw file because Claude's Skill tool refuses them.
  const annotated = new Set([last.name]);
  let promptWithInlineSlashes = "";
  let cursor = 0;
  for (const mention of mentions) {
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}/${mention.name}`;
    if (mention.skill.userInvocationOnly === true && !annotated.has(mention.name)) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
  };
}
