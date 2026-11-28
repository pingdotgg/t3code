import { assert, describe, it } from "vite-plus/test";

import { getProjectFilePickerMatches, groupMatchRanges } from "./ProjectFilePicker.logic";

function pathsForQuery(entries: Parameters<typeof getProjectFilePickerMatches>[0], query: string) {
  return getProjectFilePickerMatches(entries, query).map(({ name, path }) => ({ name, path }));
}

describe("getProjectFilePickerMatches", () => {
  it("matches ordered characters while allowing skipped characters", () => {
    const fuzzyEntries = [
      { kind: "file", path: "src/TestFlags.tsx" },
      { kind: "file", path: "src/SubtestFlow.tsx" },
      { kind: "file", path: "src/useSubtestFlags.ts" },
      {
        kind: "file",
        path: "src/useSubtestFlags/useTabActivity.ts",
      },
    ] as const;

    assert.deepEqual(
      pathsForQuery(fuzzyEntries, "testf").map(({ name }) => name),
      ["TestFlags.tsx", "SubtestFlow.tsx", "useSubtestFlags.ts", "useTabActivity.ts"],
    );
    assert.deepEqual(getProjectFilePickerMatches(fuzzyEntries, "tsfl")[0], {
      name: "TestFlags.tsx",
      nameMatchIndices: [0, 2, 4, 5],
      path: "src/TestFlags.tsx",
      pathMatchIndices: [4, 6, 8, 9],
    });
  });

  it("normalizes path prefixes consistently with server search", () => {
    assert.deepEqual(
      getProjectFilePickerMatches([{ kind: "file", path: "src/index.ts" }], "@/src")[0]
        ?.pathMatchIndices,
      [0, 1, 2],
    );
  });

  it("maps highlights back to original characters when lowercasing expands them", () => {
    const entries = [{ kind: "file", path: "icons/İ-logo.svg" }] as const;
    const indices = (query: string) => {
      const match = getProjectFilePickerMatches(entries, query)[0];
      return [match?.nameMatchIndices, match?.pathMatchIndices];
    };

    assert.deepEqual(indices("logo"), [
      [2, 3, 4, 5],
      [8, 9, 10, 11],
    ]);
    assert.deepEqual(indices("İ"), [[0], [0, 6]]);
  });

  it("matches emoji by code point without splitting surrogate pairs", () => {
    const match = getProjectFilePickerMatches([{ kind: "file", path: "notes/📁-🔥.md" }], "🔥")[0];

    assert.deepEqual(match, {
      name: "📁-🔥.md",
      nameMatchIndices: [3, 4],
      path: "notes/📁-🔥.md",
      pathMatchIndices: [9, 10],
    });
  });

  it("maps emoji highlights accurately when lowercasing expands earlier characters", () => {
    const entries = [{ kind: "file", path: "notes/İ-📁-🔥.md" }] as const;

    assert.deepEqual(getProjectFilePickerMatches(entries, "🔥")[0], {
      name: "İ-📁-🔥.md",
      nameMatchIndices: [5, 6],
      path: "notes/İ-📁-🔥.md",
      pathMatchIndices: [11, 12],
    });
    assert.deepEqual(getProjectFilePickerMatches(entries, "İ🔥m")[0], {
      name: "İ-📁-🔥.md",
      nameMatchIndices: [0, 5, 6, 8],
      path: "notes/İ-📁-🔥.md",
      pathMatchIndices: [6, 11, 12, 14],
    });
  });
});

describe("groupMatchRanges", () => {
  it("groups contiguous indices into [start, end) ranges", () => {
    assert.deepEqual(groupMatchRanges([0, 1]), [[0, 2]]);
    assert.deepEqual(groupMatchRanges([0, 2, 4, 5]), [
      [0, 1],
      [2, 3],
      [4, 6],
    ]);
    assert.deepEqual(groupMatchRanges([]), []);
  });
});
