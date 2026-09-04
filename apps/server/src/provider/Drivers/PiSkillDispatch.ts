/** Turn a T3 `$skill` mention into Pi's native `/skill:name` command. */

// Keep word-like text and a second `$` from being treated as mention boundaries,
// while allowing punctuation around a valid skill token. Dots are part of skill
// names, but a terminal dot is also common sentence punctuation; the matcher
// trims that punctuation below when it is not itself a discovered skill name.
const SKILL_MENTION_PATTERN =
  /(^|[^\p{L}\p{M}\p{N}\p{Pc}$])\$([\p{L}\p{N}][\p{L}\p{M}\p{N}\p{Pc}:.-]*)(?=$|[^\p{L}\p{M}\p{N}\p{Pc}$])/gu;

function rewritePiSkillMention(
  text: string,
  mention: { readonly name: string; readonly start: number; readonly end: number },
): string {
  const trailing = text.slice(mention.end);
  // A punctuation delimiter must stay prose, but a space keeps Pi from parsing
  // it as part of the earlier inline `/skill:name` command.
  const separator = trailing.length > 0 && !/^\s/u.test(trailing) ? " " : "";
  return `${text.slice(0, mention.start)}/skill:${mention.name}${separator}${trailing}`;
}

export interface PiSkillDispatch {
  readonly commandText: string;
  readonly skillName: string;
}

export function planPiSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): PiSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const rawName = match[2] ?? "";
    let name = rawName;
    while (/[.:_-]$/u.test(name) && !skillNames.has(name)) {
      name = name.slice(0, -1);
    }
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: start + name.length + 1 }];
  });
  const selected = mentions.at(-1);
  if (!selected) return undefined;

  const leading = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) => rewritePiSkillMention(text, mention),
      prompt.slice(0, selected.start),
    )
    .trimEnd();
  const trailing = prompt.slice(selected.end).trimStart();
  const argumentsText = [leading, trailing].filter((part) => part.length > 0).join(" ");

  return {
    commandText: `/skill:${selected.name}${argumentsText ? ` ${argumentsText}` : ""}`,
    skillName: selected.name,
  };
}
