const AUTHORED_AT = /\\[!-/:-@[-`{-~]|&#0{0,5}64;|&#[xX]0{0,4}40;|&commat;|@/gu;

export function authoredMentionOffsets(value: string, authored: string) {
  // Align every @, including escapes and entities, before matching usernames.
  // Searching by username confuses an encoded mention with a later literal one.
  const authoredAts = [...authored.matchAll(AUTHORED_AT)].filter(
    (match) => match[0] === "@" || match[0] === "\\@" || match[0].startsWith("&"),
  );
  const renderedAts = [...value.matchAll(/@/gu)];
  if (authoredAts.length !== renderedAts.length) return new Map<number, number>();
  return new Map(
    renderedAts.flatMap((match, index) => {
      const sourceAt = authoredAts[index]!;
      return sourceAt[0] === "@" ? [[match.index, sourceAt.index] as const] : [];
    }),
  );
}
