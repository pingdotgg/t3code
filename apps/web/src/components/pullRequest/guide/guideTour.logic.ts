import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestReviewGuideExcerpt, PullRequestReviewGuideStop } from "@t3tools/contracts";

/** One step forward or back, held to the tour's first and last stops. */
export function stepTourPosition(current: number, delta: 1 | -1, stopCount: number): number {
  return Math.max(Math.min(current + delta, stopCount - 1), 0);
}

/** The stop's files in reading order: the excerpted ones first, then the rest it owns. */
export function stopFilePaths(stop: PullRequestReviewGuideStop): ReadonlyArray<string> {
  return [
    ...new Set([
      ...stop.excerpts.map((excerpt) => excerpt.path),
      ...stop.files.map((file) => file.path),
    ]),
  ];
}

/** The rail's second line for a stop. */
export function stopSubline(stop: PullRequestReviewGuideStop): string {
  const count = stopFilePaths(stop).length;
  if (count === 0) return "Context, no code";
  return count === 1 ? "1 file" : `${count} files`;
}

/** A note's marker: A, B, C… in the order the guide lists them, numbers past Z. */
function noteMarker(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** One rendered line of a file's diff, with where it sits on each side. */
export interface DiffRow {
  readonly kind: "context" | "addition" | "deletion";
  /** Line number on the old side, null for an added line. */
  readonly oldLine: number | null;
  /** Line number on the new side, null for a removed line. */
  readonly newLine: number | null;
  /** The next line number on each side when this row is reached, for hunk headers. */
  readonly oldAt: number;
  readonly newAt: number;
  readonly text: string;
  /** Which hunk of the file the row came from; rows from two hunks are not adjacent. */
  readonly hunk: number;
}

/** Every line of a parsed file diff as the unified view lists it. */
export function fileDiffRows(file: FileDiffMetadata): ReadonlyArray<DiffRow> {
  const rows: DiffRow[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    let oldAt = hunk.deletionStart;
    let newAt = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            kind: "context",
            oldLine: oldAt,
            newLine: newAt,
            oldAt,
            newAt,
            text: file.additionLines[content.additionLineIndex + offset] ?? "",
            hunk: hunkIndex,
          });
          oldAt += 1;
          newAt += 1;
        }
        continue;
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({
          kind: "deletion",
          oldLine: oldAt,
          newLine: null,
          oldAt,
          newAt,
          text: file.deletionLines[content.deletionLineIndex + offset] ?? "",
          hunk: hunkIndex,
        });
        oldAt += 1;
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          kind: "addition",
          oldLine: null,
          newLine: newAt,
          oldAt,
          newAt,
          text: file.additionLines[content.additionLineIndex + offset] ?? "",
          hunk: hunkIndex,
        });
        newAt += 1;
      }
    }
  });
  return rows;
}

/**
 * The rows an excerpt covers. Its range is in one side's line numbers, so the other side's half
 * of a replacement at either edge comes along: an excerpt starting on an added line also shows
 * the lines it replaced, which is what makes it read as a change rather than as new code.
 */
export function excerptRows(
  rows: ReadonlyArray<DiffRow>,
  excerpt: Pick<PullRequestReviewGuideExcerpt, "side" | "start" | "end">,
): ReadonlyArray<DiffRow> {
  const lineOf = (row: DiffRow) => (excerpt.side === "new" ? row.newLine : row.oldLine);
  const inRange = (row: DiffRow) => {
    const line = lineOf(row);
    return line !== null && line >= excerpt.start && line <= excerpt.end;
  };
  let first = rows.findIndex(inRange);
  if (first === -1) return [];
  let last = rows.findLastIndex(inRange);
  const sameHunk = (index: number, anchor: number) => rows[index]?.hunk === rows[anchor]?.hunk;
  if (excerpt.side === "new" && rows[first]?.kind === "addition") {
    while (first > 0 && rows[first - 1]?.kind === "deletion" && sameHunk(first - 1, first)) {
      first -= 1;
    }
  }
  if (excerpt.side === "old" && rows[last]?.kind === "deletion") {
    while (
      last < rows.length - 1 &&
      rows[last + 1]?.kind === "addition" &&
      sameHunk(last + 1, last)
    ) {
      last += 1;
    }
  }
  return rows.slice(first, last + 1);
}

const ROW_PREFIX = { context: " ", addition: "+", deletion: "-" } as const;

/**
 * A unified patch of just these rows, so the shared diff renderer can draw a slice of a file
 * with its real line numbers instead of a second diff view being written for excerpts.
 */
export function rowsToPatch(
  path: string,
  previousPath: string,
  rows: ReadonlyArray<DiffRow>,
): string {
  if (rows.length === 0) return "";
  const lines = [
    `diff --git a/${previousPath} b/${path}`,
    `--- a/${previousPath}`,
    `+++ b/${path}`,
  ];
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1]?.hunk === rows[start]?.hunk) end += 1;
    const group = rows.slice(start, end + 1);
    const head = group[0]!;
    const oldCount = group.filter((row) => row.oldLine !== null).length;
    const newCount = group.filter((row) => row.newLine !== null).length;
    // Git names the line before an empty side, so a pure insertion after line 9 is `-9,0`.
    const oldStart = oldCount === 0 ? Math.max(head.oldAt - 1, 0) : head.oldAt;
    const newStart = newCount === 0 ? Math.max(head.newAt - 1, 0) : head.newAt;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of group) lines.push(`${ROW_PREFIX[row.kind]}${row.text.replace(/\r?\n$/, "")}`);
    start = end + 1;
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The old side an excerpt expands against: the new file with only the excerpt's lines put back
 * as they were. The renderer fills the code around a hunk from both files and needs them to
 * agree outside it, which the real old file does not wherever another hunk changed lines. Only
 * the lines the reader can expand into are read, and those are the new file's, so the code
 * around the excerpt shows as it reads after the change. Null when the excerpt spans hunks.
 */
export function excerptExpansionOldContents(
  newContents: string,
  rows: ReadonlyArray<DiffRow>,
): string | null {
  const head = rows[0];
  if (head === undefined || rows.some((row) => row.hunk !== head.hunk)) return null;
  const newLines = newContents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = head.newAt - 1;
  const newCount = rows.filter((row) => row.newLine !== null).length;
  // The old side keeps its own numbering, so its prefix is as long as the old file's: trimmed
  // from the front, or padded there with lines no expansion reaches.
  const oldBefore = head.oldAt - 1;
  const prefix = newLines.slice(0, before);
  const oldPrefix =
    oldBefore >= prefix.length
      ? [...Array.from({ length: oldBefore - prefix.length }, () => "\n"), ...prefix]
      : prefix.slice(prefix.length - oldBefore);
  const oldRows = rows
    .filter((row) => row.oldLine !== null)
    .map((row) => (row.text.endsWith("\n") ? row.text : `${row.text}\n`));
  return [...oldPrefix, ...oldRows, ...newLines.slice(before + newCount)].join("");
}

/** A stop's notes lettered in guide order, with the excerpt lines each one marks. */
export interface LetteredNote<Note> {
  readonly marker: string;
  readonly note: Note;
}

/**
 * Letters a stop's notes and groups them by the excerpt line they sit on. A note outside every
 * excerpt keeps its letter in the list; it just has no line to mark.
 */
export function letterStopNotes(stop: PullRequestReviewGuideStop) {
  const lettered = stop.notes.map((note, index) => ({ marker: noteMarker(index), note }));
  const byExcerpt = stop.excerpts.map((excerpt) => {
    const lines = new Map<number, Array<{ marker: string; title: string }>>();
    for (const { marker, note } of lettered) {
      if (note.path !== excerpt.path || note.line < excerpt.start || note.line > excerpt.end) {
        continue;
      }
      const entry = { marker, title: note.title };
      const list = lines.get(note.line);
      if (list === undefined) lines.set(note.line, [entry]);
      else list.push(entry);
    }
    return [...lines].map(([line, markers]) => ({ line, markers }));
  });
  return { lettered, byExcerpt };
}
