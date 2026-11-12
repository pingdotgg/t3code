import { expect, it } from "vite-plus/test";
import type { NativeReviewDiffRow } from "../../diffs/nativeReviewDiffSurface";
import { guideFocusedRows } from "./guideDiffFocus";

it("focuses a range that crosses diff sides in either direction", () => {
  const rows: NativeReviewDiffRow[] = [
    { kind: "file", id: "file", fileId: "f" },
    { kind: "line", id: "a", fileId: "f", oldLineNumber: 12 },
    { kind: "line", id: "b", fileId: "f", oldLineNumber: 13 },
    { kind: "line", id: "c", fileId: "f", newLineNumber: 12 },
    { kind: "line", id: "d", fileId: "f", newLineNumber: 13 },
    { kind: "line", id: "other", fileId: "other", newLineNumber: 13 },
  ];
  expect(
    guideFocusedRows(rows, "f", { side: "old", start: 12, endSide: "new", end: 13 }).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "c", "d"]);
  expect(
    guideFocusedRows(rows, "f", { side: "new", start: 13, endSide: "old", end: 12 }).map(
      (row) => row.id,
    ),
  ).toEqual(["a", "b", "c", "d"]);
  expect(
    guideFocusedRows(rows, "f", { side: "old", start: 12, end: 13 }).map((row) => row.id),
  ).toEqual(["a", "b"]);
  expect(guideFocusedRows(rows, "f", { side: "old", start: 99, endSide: "new", end: 13 })).toEqual(
    [],
  );
});
