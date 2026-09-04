/** Turn a T3 `$skill` mention into Pi's native `/skill:name` command. */

const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface PiSkillDispatch {
  readonly commandText: string;
  readonly skillName: string;
}

export function planPiSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): PiSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: start + name.length + 1 }];
  });
  const selected = mentions.at(-1);
  if (!selected) return undefined;

  const leading = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) => `${text.slice(0, mention.start)}/skill:${text.slice(mention.start + 1)}`,
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
