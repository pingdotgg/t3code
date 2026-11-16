import type { FileDiffMetadata } from "@pierre/diffs/types";

const RENDERED_LINE_LENGTH = 10_000;
// Covers the marker, so a clamped line that is parsed again stays as it is.
const CLAMP_SLACK = 100;

type DiffLines = Pick<FileDiffMetadata, "additionLines" | "deletionLines">;

const fullLinesByClampedLines = new WeakMap<ReadonlyArray<string>, string[]>();
// Pierre builds a hydrated file's line arrays itself, and may hydrate a copy of the file it
// loaded contents for onto another object. Its copies keep own properties, so the full lines
// ride on the file and live exactly as long as it does. A symbol stays out of worker messages.
const fullLinesOfHydratedFile = Symbol("fullLinesOfHydratedFile");
type HydratableFile = FileDiffMetadata & { [fullLinesOfHydratedFile]?: DiffLines | undefined };

function isLong(line: string): boolean {
  return line.length > RENDERED_LINE_LENGTH + CLAMP_SLACK;
}

function clampLine(line: string): string {
  if (!isLong(line)) return line;
  const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const lastKept = line.charCodeAt(RENDERED_LINE_LENGTH - 1);
  const splitsSurrogatePair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  const kept = RENDERED_LINE_LENGTH - (splitsSurrogatePair ? 1 : 0);
  const hidden = line.length - ending.length - kept;
  return `${line.slice(0, kept)} … ${hidden} more characters not shown${ending}`;
}

function clampLines(lines: string[]): string[] {
  if (!lines.some(isLong)) return lines;
  const clamped = lines.map(clampLine);
  fullLinesByClampedLines.set(clamped, lines);
  return clamped;
}

/**
 * Blink freezes for most of a minute serializing a very long line into the accessibility tree,
 * so rendered lines are cut. Line counts and hunks are untouched.
 */
export function clampLongDiffLines(file: FileDiffMetadata): FileDiffMetadata {
  const additionLines = clampLines(file.additionLines);
  const deletionLines = clampLines(file.deletionLines);
  return additionLines === file.additionLines && deletionLines === file.deletionLines
    ? file
    : { ...file, additionLines, deletionLines };
}

/** The lines of `file` as they are in the source, for anything that leaves the diff view. */
export function getFullDiffLines(file: HydratableFile): DiffLines {
  const hydrated = file.isPartial ? undefined : file[fullLinesOfHydratedFile];
  return {
    additionLines:
      fullLinesByClampedLines.get(file.additionLines) ??
      hydrated?.additionLines ??
      file.additionLines,
    deletionLines:
      fullLinesByClampedLines.get(file.deletionLines) ??
      hydrated?.deletionLines ??
      file.deletionLines,
  };
}

/** Cuts the lines of contents loaded to hydrate `file`, and keeps the full ones on it. */
export function clampHydrationLines(file: HydratableFile, lines: DiffLines): DiffLines {
  const additionLines = clampLines(lines.additionLines);
  const deletionLines =
    lines.deletionLines === lines.additionLines ? additionLines : clampLines(lines.deletionLines);
  const clamped = additionLines !== lines.additionLines || deletionLines !== lines.deletionLines;
  // Set even when nothing was cut, so a copy overwrites what an abandoned load left behind.
  file[fullLinesOfHydratedFile] = clamped ? lines : undefined;
  return clamped ? { additionLines, deletionLines } : lines;
}
