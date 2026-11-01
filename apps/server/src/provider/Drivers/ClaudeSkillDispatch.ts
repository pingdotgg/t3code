import { claudeSkillVariantQualifiedName } from "@t3tools/provider-core/server/skillDirectives";
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

export interface ClaudeSkillDispatchPolicyEntry {
  readonly skillName: string;
  readonly mode: "variant" | "off";
}

export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
  skillPolicy: ReadonlyArray<ClaudeSkillDispatchPolicyEntry> = [],
): ClaudeSkillDispatch | undefined {
  const policyByName = new Map(skillPolicy.map((entry) => [entry.skillName, entry.mode]));
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    const skill = skills.get(name);
    if (!skill) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const mode = policyByName.get(name);
    return [
      {
        name,
        skill,
        start,
        end: (match.index ?? 0) + match[0].length,
        nativeName:
          mode === "off" ? null : mode === "variant" ? claudeSkillVariantQualifiedName(name) : name,
      },
    ];
  });
  const last = mentions.findLast((mention) => mention.nativeName !== null);
  if (last?.nativeName == null) {
    return undefined;
  }

  // Only the final skill gets native expansion. Earlier user-only skills need
  // a fallback to their raw file because Claude's Skill tool refuses them.
  const annotated = new Set([last.name]);
  let promptWithInlineSlashes = "";
  let cursor = 0;
  for (const mention of mentions) {
    const replacement =
      mention.nativeName === null
        ? prompt.slice(mention.start, mention.end)
        : `/${mention.nativeName}`;
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}${replacement}`;
    if (
      mention.nativeName === mention.name &&
      mention.skill.userInvocationOnly === true &&
      !annotated.has(mention.name)
    ) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  return {
    leadingText:
      prompt.slice(0, last.start).trim().length > 0 ? promptWithInlineSlashes : undefined,
    commandText: `/${last.nativeName}${prompt.slice(last.end)}`.trimEnd(),
  };
}
