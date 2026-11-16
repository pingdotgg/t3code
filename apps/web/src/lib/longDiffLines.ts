import type { FileDiffMetadata } from "@pierre/diffs/types";

const RENDERED_LINE_LENGTH = 10_000;
// Covers the marker, so a clamped line that is parsed again stays as it is.
const CLAMP_SLACK = 100;

type DiffLines = Pick<FileDiffMetadata, "additionLines" | "deletionLines">;

const fullLinesByClampedLines = new WeakMap<ReadonlyArray<string>, string[]>();
// Pierre builds a hydrated file's line arrays itself, and may hydrate another object than the
// one it loaded contents for. Its cache key is all that links the two; whole files stay bounded.
const HYDRATED_FILE_LIMIT = 20;
const fullLinesByHydratedCacheKey = new Map<string, DiffLines>();

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
export function getFullDiffLines(file: FileDiffMetadata): DiffLines {
  const hydrated =
    file.isPartial || file.cacheKey === undefined
      ? undefined
      : fullLinesByHydratedCacheKey.get(file.cacheKey);
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

/** Cuts the lines of contents loaded to hydrate `file`, and keeps the full ones for it. */
export function clampHydrationLines(file: FileDiffMetadata, lines: DiffLines): DiffLines {
  if (file.cacheKey === undefined) return lines;
  const additionLines = clampLines(lines.additionLines);
  const deletionLines =
    lines.deletionLines === lines.additionLines ? additionLines : clampLines(lines.deletionLines);
  if (additionLines === lines.additionLines && deletionLines === lines.deletionLines) return lines;

  const hydratedCacheKey = `${file.cacheKey}:hydrated`;
  fullLinesByHydratedCacheKey.delete(hydratedCacheKey);
  fullLinesByHydratedCacheKey.set(hydratedCacheKey, lines);
  if (fullLinesByHydratedCacheKey.size > HYDRATED_FILE_LIMIT) {
    for (const oldest of fullLinesByHydratedCacheKey.keys()) {
      fullLinesByHydratedCacheKey.delete(oldest);
      break;
    }
  }
  return { additionLines, deletionLines };
}
