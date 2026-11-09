import type { ServerProviderSkill } from "@t3tools/contracts";

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

function matchSkillMentions(prompt: string, skills: ReadonlyMap<string, ClaudeSkillTarget>) {
  return [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    const skill = skills.get(name);
    if (!skill) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, skill, start, end: (match.index ?? 0) + match[0].length }];
  });
}

// Claude's Skill tool refuses user-only skills, so any mention Claude will not
// expand natively points at the skill's raw file instead.
function inlineSkillMentions(
  prompt: string,
  mentions: ReturnType<typeof matchSkillMentions>,
  nativelyExpanded: string | undefined,
): string {
  const annotated = new Set(nativelyExpanded === undefined ? [] : [nativelyExpanded]);
  let text = "";
  let cursor = 0;
  for (const mention of mentions) {
    text += `${prompt.slice(cursor, mention.start)}/${mention.name}`;
    if (mention.skill.userInvocationOnly === true && !annotated.has(mention.name)) {
      text += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  return `${text}${prompt.slice(cursor)}`.trimEnd();
}

export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = matchSkillMentions(prompt, skills);
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }
  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0
        ? inlineSkillMentions(prompt, mentions, last.name)
        : undefined,
    commandText: `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
  };
}

/** Tool results never expand skills, so an answer only names them for the agent to run. */
export function rewriteClaudeSkillMentionsInAnswer(
  answer: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): string {
  // A leading `/name` invokes a skill in the composer, so it counts here too.
  const leadingSlash = /^(\s*)\/(?=\S)/.exec(answer);
  if (leadingSlash) {
    const asMention = `${leadingSlash[1]}$${answer.slice(leadingSlash[0].length)}`;
    const mentions = matchSkillMentions(asMention, skills);
    if (mentions[0]?.start === leadingSlash[1]?.length) {
      return inlineSkillMentions(asMention, mentions, undefined);
    }
  }
  const mentions = matchSkillMentions(answer, skills);
  return mentions.length === 0 ? answer : inlineSkillMentions(answer, mentions, undefined);
}
