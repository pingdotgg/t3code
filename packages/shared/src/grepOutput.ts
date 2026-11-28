export interface GrepOutputResult {
  readonly fileName: string;
  readonly line?: number;
  readonly preview?: string;
}

// Search results ride the timeline wire, so matched text shares one budget; later matches keep
// their file and line without the text.
const PREVIEW_BUDGET_CHARS = 8_000;
const NOTE_MAX_CHARS = 500;

const SUMMARY_LINE = /^(?:Found \d+ (?:match|file)|No (?:files|matches) found)/i;
const NOTE_LINE = /^\(.*\)$/;
const FILE_HEADING = /^File: (.+)$/;
// OpenCode and Gemini put a space after the colon; ripgrep's `--heading` lines start right after it.
const NUMBERED_LINE = /^\s*(?:(?:Line |L)(\d+): ?|(\d+):)(.*)$/;
const CONTEXT_LINE = /^\s*\d+-/;
const PATH_LINE_TEXT = /^(\S.*?):(\d+):(.*)$/;
const COLON_HEADING = /^(\S.*):$/;
const OPENCODE_NUMBERED_LINE = /^\s+Line \d+:/;
const RIPGREP_NUMBERED_LINE = /^\d+:/;

/**
 * Grep tool text as one result per matched line, from ripgrep's `path:line:text` and `--heading`
 * forms, OpenCode's `path:` / `Line N: text`, and Gemini's `File: path` / `LN: text`. Returns
 * undefined unless every line fits, so listings, errors, and prose stay as the provider wrote them.
 * Parenthesized notes such as truncation warnings stay, as one line-less result on `root`.
 */
export function parseGrepOutput(
  output: string,
  root: string,
): ReadonlyArray<GrepOutputResult> | undefined {
  const matches: Array<{ fileName: string; line: number; text: string }> = [];
  const notes: string[] = [];
  let file: string | undefined;
  let ripgrepFormat: "heading" | "inline" | undefined;
  const lines = output.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      // ripgrep separates file groups with a blank line. OpenCode also uses blanks within a group.
      if (ripgrepFormat === "heading") file = undefined;
      continue;
    }
    if (trimmed === "--" || trimmed === "---" || SUMMARY_LINE.test(trimmed)) continue;
    const heading = FILE_HEADING.exec(trimmed);
    if (heading) {
      file = heading[1];
      ripgrepFormat = undefined;
      continue;
    }
    const numbered = file === undefined ? null : NUMBERED_LINE.exec(line);
    if (file !== undefined && numbered) {
      const lineNumber = numbered[1] ?? numbered[2];
      matches.push({ fileName: file, line: Number(lineNumber), text: numbered[3] ?? "" });
      continue;
    }
    // ripgrep context lines (`N-text`) can't be told apart from a file named like one.
    if (file !== undefined && CONTEXT_LINE.test(line)) return undefined;
    const nextLine = lines[index + 1] ?? "";
    // `dir/a:12:b.txt:` is both an inline match and an OpenCode heading; an indented `Line N:` next decides.
    const colonHeading = COLON_HEADING.exec(line.trimEnd());
    const inline =
      colonHeading && OPENCODE_NUMBERED_LINE.test(nextLine) ? null : PATH_LINE_TEXT.exec(line);
    if (ripgrepFormat !== "inline" && RIPGREP_NUMBERED_LINE.test(nextLine)) {
      // Two inline rows can also look like a bare heading and its numbered match.
      if (
        ripgrepFormat === undefined &&
        PATH_LINE_TEXT.test(nextLine) &&
        PATH_LINE_TEXT.test(trimmed)
      ) {
        return undefined;
      }
      file = line;
      ripgrepFormat = "heading";
      continue;
    }
    if (inline) {
      ripgrepFormat = "inline";
      matches.push({ fileName: inline[1] ?? "", line: Number(inline[2]), text: inline[3] ?? "" });
      continue;
    }
    if (colonHeading) {
      file = colonHeading[1];
      ripgrepFormat = undefined;
      continue;
    }
    if (NOTE_LINE.test(trimmed)) {
      notes.push(trimmed);
      continue;
    }
    // With no numbered match after it, only a space-free bare path can be a heading.
    if (!/\s/.test(line.trimEnd())) {
      file = line;
      ripgrepFormat = undefined;
      continue;
    }
    return undefined;
  }
  if (matches.length === 0 || matches.some((match) => match.line < 1 || !match.fileName.trim())) {
    return undefined;
  }
  const note = notes.join("\n").slice(0, NOTE_MAX_CHARS);
  let budget = PREVIEW_BUDGET_CHARS - note.length;
  const results: GrepOutputResult[] = matches.map((match) => {
    const fits = match.text.length <= budget;
    if (fits) budget -= match.text.length;
    return { fileName: match.fileName, line: match.line, ...(fits ? { preview: match.text } : {}) };
  });
  return note ? [...results, { fileName: root, preview: note }] : results;
}
