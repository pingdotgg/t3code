import { describe, expect, it } from "vite-plus/test";
import { guideFocusedRows } from "./guideDiffFocus";

describe("guide diff focus", () => {
  const rows = [
    { id: "old", kind: "line" as const, fileId: "a", oldLineNumber: 10, change: "delete" as const },
    { id: "new", kind: "line" as const, fileId: "a", newLineNumber: 20, change: "add" as const },
    { id: "context", kind: "line" as const, fileId: "a", oldLineNumber: 11, newLineNumber: 21 },
    { id: "other", kind: "line" as const, fileId: "b", newLineNumber: 20 },
  ];
  it("uses the requested side and includes both range boundaries only in the target file", () => {
    expect(
      guideFocusedRows(rows, "a", { side: "old", start: 10, end: 11 }).map((r) => r.id),
    ).toEqual(["old", "context"]);
    expect(
      guideFocusedRows(rows, "a", { side: "new", start: 20, end: 21 }).map((r) => r.id),
    ).toEqual(["new", "context"]);
  });
  it("does not select unrelated rows while a later file is loading", () => {
    expect(guideFocusedRows(rows, undefined, { side: "new", start: 20, end: 21 })).toEqual([]);
    expect(guideFocusedRows(rows, "a", undefined)).toEqual([]);
  });
});
