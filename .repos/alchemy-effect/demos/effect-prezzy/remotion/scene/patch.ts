import { diffLines } from "diff";
import type { Colors } from "./highlight.ts";

/** One editor line of a patch: unchanged, added (green) or removed (red). */
export interface Row {
  kind: "same" | "add" | "del";
  text: string;
  /** Token colour per character. */
  colors: string[];
  /** Line number in the file after the patch (removed lines have none). */
  number?: number;
}

export interface PatchView {
  rows: Row[];
  /** First and last changed row, to scroll the edit into view. */
  first: number;
  last: number;
  /** The biggest run of changed rows, `[first, last]`: shown when the whole edit doesn't fit. */
  main: [number, number];
}

const splitLines = (value: string) => {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** The file as editor rows: the whole `after`, with removed `before` lines interleaved. */
export const patchView = (
  before: string,
  after: string,
  beforeColors: Colors,
  afterColors: Colors,
): PatchView => {
  const rows: Row[] = [];
  let b = 0;
  let a = 0;
  let number = 1;
  let first = -1;
  let last = -1;
  for (const change of diffLines(before, after)) {
    for (const text of splitLines(change.value)) {
      if (change.removed) {
        rows.push({ kind: "del", text, colors: beforeColors.slice(b, b + text.length) });
        b += text.length + 1;
      } else if (change.added) {
        rows.push({
          kind: "add",
          text,
          colors: afterColors.slice(a, a + text.length),
          number: number++,
        });
        a += text.length + 1;
      } else {
        rows.push({
          kind: "same",
          text,
          colors: afterColors.slice(a, a + text.length),
          number: number++,
        });
        a += text.length + 1;
        b += text.length + 1;
      }
      if (change.added || change.removed) {
        if (first < 0) first = rows.length - 1;
        last = rows.length - 1;
      }
    }
  }
  let main: [number, number] = [Math.max(0, first), Math.max(0, first)];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === "same") continue;
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.kind !== "same") j++;
    if (j - i > main[1] - main[0]) main = [i, j];
    i = j;
  }
  return { rows, first: Math.max(0, first), last: Math.max(0, last), main };
};

/** A file with nothing changing. */
export const staticView = (text: string, colors: Colors): PatchView =>
  patchView(text, text, colors, colors);
