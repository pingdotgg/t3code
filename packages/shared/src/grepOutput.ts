export interface GrepOutputResult {
  readonly fileName: string;
  readonly line?: number;
  readonly preview?: string;
}

// Search results ride the timeline wire, so matched text shares one budget; later matches keep
// their file and line without the text.
const PREVIEW_BUDGET_CHARS = 8_000;

const SUMMARY_LINE = /^(?:Found \d+ (?:match|file)|No (?:files|matches) found)/i;
const NOTE_LINE = /^\(.*\)$/;
const FILE_HEADING = /^File: (.+)$/;
const NUMBERED_LINE = /^\s*(?:Line |L)?(\d+): ?(.*)$/;
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
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed === "--" || trimmed === "---" || SUMMARY_LINE.test(trimmed)) continue;
    const heading = FILE_HEADING.exec(trimmed);
    if (heading) {
      file = heading[1];
      continue;
    }
    const numbered = file === undefined ? null : NUMBERED_LINE.exec(line);
    if (file !== undefined && numbered) {
      matches.push({ fileName: file, line: Number(numbered[1]), text: numbered[2] ?? "" });
      continue;
    }
    const inline = PATH_LINE_TEXT.exec(line);
    if (inline) {
      matches.push({ fileName: inline[1] ?? "", line: Number(inline[2]), text: inline[3] ?? "" });
      continue;
    }
    const colonHeading = COLON_HEADING.exec(line);
    if (colonHeading) {
      file = colonHeading[1];
      continue;
    }
    if (NOTE_LINE.test(trimmed)) {
      notes.push(trimmed);
      continue;
    }
    // ripgrep --heading prints the bare path above its numbered lines.
    if (!/\s/.test(line)) {
      file = line;
      continue;
    }
    return undefined;
  }
  if (matches.length === 0) return undefined;
  let budget = PREVIEW_BUDGET_CHARS;
  const results: GrepOutputResult[] = matches.flatMap((match) => {
    if (match.line < 1 || !match.fileName.trim()) return [];
    const fits = match.text.length <= budget;
    if (fits) budget -= match.text.length;
    return [
      { fileName: match.fileName, line: match.line, ...(fits ? { preview: match.text } : {}) },
    ];
  });
  return notes.length === 0 ? results : [...results, { fileName: root, preview: notes.join("\n") }];
}
