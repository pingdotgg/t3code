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
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "--" || trimmed === "---" || SUMMARY_LINE.test(trimmed)) continue;
    const heading = FILE_HEADING.exec(trimmed);
    if (heading) {
      file = heading[1];
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
    const inline = PATH_LINE_TEXT.exec(line);
    if (inline) {
      matches.push({ fileName: inline[1] ?? "", line: Number(inline[2]), text: inline[3] ?? "" });
      continue;
    }
    const colonHeading = COLON_HEADING.exec(line.trimEnd());
    if (colonHeading) {
      file = colonHeading[1];
      continue;
    }
    if (NOTE_LINE.test(trimmed)) {
      notes.push(trimmed);
      continue;
    }
    // ripgrep --heading prints the bare path above its numbered lines.
    if (!/\s/.test(line.trimEnd())) {
      file = line.trimEnd();
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
