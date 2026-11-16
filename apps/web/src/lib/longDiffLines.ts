import type { FileDiffMetadata } from "@pierre/diffs/types";

// A ~1M-character line wraps into tens of thousands of inline text boxes; with accessibility on,
// Blink serializes each one and the renderer hangs for close to a minute.
export const MAX_RENDERED_DIFF_LINE_LENGTH = 10_000;
const MARKER_ROOM = 64;

function clampLine(line: string): string {
  const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const body = line.slice(0, line.length - ending.length);
  if (body.length <= MAX_RENDERED_DIFF_LINE_LENGTH) return line;
  // Room for the marker keeps a clamped line within the limit, so reparsing it is a no-op.
  const keep = MAX_RENDERED_DIFF_LINE_LENGTH - MARKER_ROOM;
  // Never split a surrogate pair, which would render as a replacement character.
  const lastKept = body.charCodeAt(keep - 1);
  const cut = lastKept >= 0xd800 && lastKept <= 0xdbff ? keep - 1 : keep;
  const hidden = (body.length - cut).toLocaleString("en-US");
  return `${body.slice(0, cut)} … ${hidden} more characters not shown${ending}`;
}

function clampLines(lines: ReadonlyArray<string>): string[] | null {
  if (lines.every((line) => line.length <= MAX_RENDERED_DIFF_LINE_LENGTH)) return null;
  return lines.map(clampLine);
}

// Same object when nothing is clamped, so render caches keep their keys.
export function clampFileDiffLongLines(file: FileDiffMetadata): FileDiffMetadata {
  const additionLines = clampLines(file.additionLines);
  const deletionLines = clampLines(file.deletionLines);
  if (additionLines === null && deletionLines === null) return file;
  return {
    ...file,
    additionLines: additionLines ?? file.additionLines,
    deletionLines: deletionLines ?? file.deletionLines,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:clamped` } : {}),
  };
}

export function clampLongLinesInContents(contents: string): string {
  if (contents.length <= MAX_RENDERED_DIFF_LINE_LENGTH) return contents;
  const clamped = clampLines(contents.split(/(?<=\n)/));
  return clamped === null ? contents : clamped.join("");
}
