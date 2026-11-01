import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  adjacentFileKey,
  adjacentUnviewedFileKey,
  cursorFromSelectedRange,
  cursorSelectedRange,
  type DiffRow,
  nearestGapExpansion,
  stepRow,
  topToBottomRange,
  visibleDiffRows,
} from "./diffReviewCursor";

const lines = (count: number, edit: (line: number) => string) =>
  Array.from({ length: count }, (_, index) => `${edit(index + 1)}\n`).join("");

// Changes lines 8 and 22 of 30: hunks keep 4 context lines, leaving hidden gaps of 3 lines
// above, 5 between, and 4 after.
const fileDiff = parseDiffFromFile(
  { name: "a.ts", contents: lines(30, (line) => `line ${line}`) },
  {
    name: "a.ts",
    contents: lines(30, (line) => (line === 8 || line === 22 ? `changed ${line}` : `line ${line}`)),
  },
);
const NO_EXPANSIONS = new Map();
const unified = visibleDiffRows(fileDiff, "unified", NO_EXPANSIONS);
const split = visibleDiffRows(fileDiff, "split", NO_EXPANSIONS);
const rowAt = (rows: ReadonlyArray<DiffRow>, lineNumber: number, side = "additions") =>
  rows.find((row) => row.lineNumber === lineNumber && row.side === side)!;

describe("visibleDiffRows", () => {
  it("lists deletions and additions as separate unified rows and paired split rows", () => {
    expect(unified.map((row) => `${row.side[0]}${row.lineNumber}`)).toEqual(
      ["a4", "a5", "a6", "a7", "d8", "a8", "a9", "a10", "a11", "a12"].concat([
        "a18",
        "a19",
        "a20",
        "a21",
        "d22",
        "a22",
        "a23",
        "a24",
        "a25",
        "a26",
      ]),
    );
    expect(split.map((row) => `${row.side[0]}${row.lineNumber}`)).toEqual(
      ["a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"].concat([
        "a18",
        "a19",
        "a20",
        "a21",
        "a22",
        "a23",
        "a24",
        "a25",
        "a26",
      ]),
    );
    expect(split[4]).toMatchObject({ deletionLineNumber: 8, additionLineNumber: 8 });
    expect(unified[0]).toMatchObject({ hunkIndex: 0, hiddenBefore: 3 });
    expect(rowAt(unified, 18)).toMatchObject({ hunkIndex: 1, hiddenBefore: 5 });
    expect(unified.at(-1)).toMatchObject({ hiddenAfter: 4 });
  });

  it("includes expanded context and shrinks the remaining gap", () => {
    const rows = visibleDiffRows(fileDiff, "unified", new Map([[1, { fromStart: 2, fromEnd: 0 }]]));
    expect(rowAt(rows, 13)).toMatchObject({ hunkIndex: 1, hiddenBefore: 0 });
    expect(rowAt(rows, 14)).toBeDefined();
    expect(rowAt(rows, 18)).toMatchObject({ hiddenBefore: 3 });
    expect(nearestGapExpansion(fileDiff, rows, rowAt(rows, 12), "below")).toEqual({
      hunkIndex: 1,
      direction: "up",
    });
  });
});

describe("stepRow", () => {
  it("stops at the first and last row", () => {
    expect(stepRow(unified, unified[0]!, -1)).toBe(unified[0]);
    expect(stepRow(unified, unified[0]!, 1)).toBe(unified[1]);
    expect(stepRow(unified, unified.at(-1)!, 1)).toBe(unified.at(-1));
  });

  it("finds a context row from either side", () => {
    expect(stepRow(split, { lineNumber: 4, side: "deletions" }, 1)).toBe(split[1]);
  });
});

describe("nearestGapExpansion", () => {
  it.each([
    [5, "above", { hunkIndex: 0, direction: "down" }],
    [9, "above", { hunkIndex: 0, direction: "down" }],
    [5, "below", { hunkIndex: 1, direction: "up" }],
    [20, "above", { hunkIndex: 1, direction: "down" }],
    [20, "below", { hunkIndex: 2, direction: "up" }],
    [26, "below", { hunkIndex: 2, direction: "up" }],
  ] as const)("from line %i %s reveals %o", (lineNumber, toward, expansion) => {
    expect(nearestGapExpansion(fileDiff, unified, rowAt(unified, lineNumber), toward)).toEqual(
      expansion,
    );
  });

  it("finds nothing once the file is fully shown", () => {
    const expanded = new Map(
      [0, 1, 2].map((hunkIndex) => [hunkIndex, { fromStart: 1_000_000, fromEnd: 0 }]),
    );
    const rows = visibleDiffRows(fileDiff, "unified", expanded);
    expect(rows).toHaveLength(32);
    expect(nearestGapExpansion(fileDiff, rows, rowAt(rows, 1), "below")).toBeNull();
    expect(nearestGapExpansion(fileDiff, rows, rowAt(rows, 30), "above")).toBeNull();
  });
});

describe("cursor selections", () => {
  const file = { fileKey: "a", filePath: "a.ts" };

  it("orders a selection made upward top to bottom across sides", () => {
    const range = cursorSelectedRange({
      mode: "select",
      ...file,
      anchor: { lineNumber: 11, side: "additions" },
      head: { lineNumber: 8, side: "deletions" },
    });
    expect(range).toEqual({ start: 11, side: "additions", end: 8, endSide: "deletions" });
    expect(topToBottomRange(range!, unified)).toEqual({
      start: 8,
      side: "deletions",
      end: 11,
      endSide: "additions",
    });
  });

  it("reads a single line as line mode and a range as a selection", () => {
    expect(cursorFromSelectedRange(file, { start: 6, side: "additions", end: 6 })).toEqual({
      mode: "line",
      ...file,
      row: { lineNumber: 6, side: "additions" },
    });
    expect(
      cursorFromSelectedRange(file, { start: 8, side: "deletions", end: 9, endSide: "additions" }),
    ).toEqual({
      mode: "select",
      ...file,
      anchor: { lineNumber: 8, side: "deletions" },
      head: { lineNumber: 9, side: "additions" },
    });
  });
});

describe("file navigation", () => {
  const keys = ["a", "b", "c", "d"];

  it("starts at the first file and stops at the ends", () => {
    expect(adjacentFileKey(keys, null, -1)).toBe("a");
    expect(adjacentFileKey(keys, "a", -1)).toBe("a");
    expect(adjacentFileKey(keys, "c", 1)).toBe("d");
    expect(adjacentFileKey(keys, "d", 1)).toBe("d");
  });

  it("wraps to the next unviewed file and skips viewed ones", () => {
    const viewed = new Set(["a", "d"]);
    const isViewed = (key: string) => viewed.has(key);
    expect(adjacentUnviewedFileKey(keys, "c", 1, isViewed)).toBe("b");
    expect(adjacentUnviewedFileKey(keys, "b", -1, isViewed)).toBe("c");
    expect(adjacentUnviewedFileKey(keys, null, 1, isViewed)).toBe("b");
    expect(adjacentUnviewedFileKey(keys, null, -1, isViewed)).toBe("c");
    expect(adjacentUnviewedFileKey(keys, "a", 1, () => true)).toBeNull();
  });
});
