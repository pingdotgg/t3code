import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { checkpointDiffRange, diffFileListRows } from "./DiffPanel.logic";

function file(name: string, hunks: Array<[additions: number, deletions: number]>) {
  return {
    name,
    hunks: hunks.map(([additionLines, deletionLines]) => ({ additionLines, deletionLines })),
  } as unknown as FileDiffMetadata;
}

describe("checkpointDiffRange", () => {
  it("diffs one turn against the checkpoint before it", () => {
    expect(checkpointDiffRange(3, false)).toEqual({ fromTurnCount: 2, toTurnCount: 3 });
    expect(checkpointDiffRange(0, false)).toEqual({ fromTurnCount: 0, toTurnCount: 0 });
  });

  it("diffs all turns against the thread's first checkpoint", () => {
    expect(checkpointDiffRange(3, true)).toEqual({ fromTurnCount: 0, toTurnCount: 3 });
  });

  it("has no range before a turn is selected", () => {
    expect(checkpointDiffRange(undefined, true)).toBeNull();
  });
});

describe("diffFileListRows", () => {
  it("sums each file's hunks and keeps diff order", () => {
    expect(
      diffFileListRows(
        [
          file("src/b.ts", [
            [2, 1],
            [3, 0],
          ]),
          file("src/a.ts", [[0, 4]]),
        ],
        new Map(),
      ),
    ).toEqual([
      { path: "src/b.ts", additions: 5, deletions: 1 },
      { path: "src/a.ts", additions: 0, deletions: 4 },
    ]);
  });

  it("merges a path split across entries, such as a file replaced by a symlink", () => {
    expect(diffFileListRows([file("x", [[1, 0]]), file("x", [[0, 2]])], new Map())).toEqual([
      { path: "x", additions: 1, deletions: 2 },
    ]);
  });

  it("takes a not yet loaded file's stat from the source metadata", () => {
    const stats = new Map([["big.ts", { additions: 900, deletions: 12 }]]);
    expect(diffFileListRows([file("big.ts", [])], stats)).toEqual([
      { path: "big.ts", additions: 900, deletions: 12 },
    ]);
  });
});
