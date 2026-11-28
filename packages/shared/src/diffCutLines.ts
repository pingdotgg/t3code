// A withheld file's diff line the server cut short ends in this note, which clients style apart.
const CUT_LINE_NOTE = / …\[[\d,]+ more characters\]$/;

export function cutLineNote(omittedCharacters: number): string {
  return ` …[${omittedCharacters.toLocaleString("en-US")} more characters]`;
}

/** Where a cut line's note starts, past its leading space, or null for a whole line. */
export function cutLineNoteStart(line: string): number | null {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!content.endsWith("more characters]")) return null;
  const note = CUT_LINE_NOTE.exec(content);
  return note === null ? null : note.index + 1;
}

export function hasCutLines(patch: string): boolean {
  return new RegExp(CUT_LINE_NOTE.source, "m").test(patch);
}
