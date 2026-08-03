import type { WorkingCopyFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChangesRows,
  CHANGES_ROW_HEIGHT,
  type ChangesRow,
} from "~/lib/sourceControl/changesRows";

import {
  EMPTY_CHANGES_SELECTION,
  actionTargetRows,
  changesRowOffsets,
  focusableRowKeys,
  moveChangesFocus,
  reconcileSelection,
  selectRowRange,
  selectSingleRow,
  stickyChangesGroup,
  targetPaths,
  toggleRowSelection,
} from "./changesSelection.logic";

const HEIGHTS = { hasConflictActions: false, confirmingDiscardKey: null } as const;

function file(
  path: string,
  area: WorkingCopyFile["area"] = "unstaged",
  change: WorkingCopyFile["change"] = "modified",
): WorkingCopyFile {
  return { path, area, change };
}

function rowsOf(files: ReadonlyArray<WorkingCopyFile>): ReadonlyArray<ChangesRow> {
  return buildChangesRows({
    files,
    viewMode: "flat",
    collapsedGroups: new Set(),
    collapsedFolders: new Set(),
    filter: "all",
    query: "",
  });
}

const THREE = rowsOf([file("a.ts"), file("b.ts"), file("c.ts")]);

describe("focusableRowKeys", () => {
  it("skips headers, folders and placeholders", () => {
    const keys = focusableRowKeys(THREE);
    expect(keys).toEqual(["unstaged-a.ts", "unstaged-b.ts", "unstaged-c.ts"]);
  });

  it("walks tree-mode folders in display order", () => {
    const rows = buildChangesRows({
      files: [file("src/z.ts"), file("src/a.ts"), file("top.ts")],
      viewMode: "tree",
      collapsedGroups: new Set(),
      collapsedFolders: new Set(),
      filter: "all",
      query: "",
    });
    const keys = focusableRowKeys(rows);
    expect(keys).toHaveLength(3);
    // Whatever the tree order is, the keyboard order must equal the row order.
    const rowOrder = rows.filter((row) => row.kind === "file").map((row) => row.key);
    expect(keys).toEqual(rowOrder);
  });
});

describe("moveChangesFocus", () => {
  it("moves next and previous", () => {
    expect(moveChangesFocus(THREE, "unstaged-a.ts", "next")).toBe("unstaged-b.ts");
    expect(moveChangesFocus(THREE, "unstaged-b.ts", "previous")).toBe("unstaged-a.ts");
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(moveChangesFocus(THREE, "unstaged-c.ts", "next")).toBe("unstaged-c.ts");
    expect(moveChangesFocus(THREE, "unstaged-a.ts", "previous")).toBe("unstaged-a.ts");
  });

  it("jumps to first and last", () => {
    expect(moveChangesFocus(THREE, "unstaged-b.ts", "first")).toBe("unstaged-a.ts");
    expect(moveChangesFocus(THREE, "unstaged-b.ts", "last")).toBe("unstaged-c.ts");
  });

  it("recovers when the focused row was staged away under the cursor", () => {
    expect(moveChangesFocus(THREE, "unstaged-gone.ts", "next")).toBe("unstaged-a.ts");
    expect(moveChangesFocus(THREE, "unstaged-gone.ts", "previous")).toBe("unstaged-c.ts");
  });

  it("returns null on an empty list", () => {
    expect(moveChangesFocus(rowsOf([]), null, "next")).toBeNull();
  });
});

describe("selection", () => {
  it("plain select replaces the selection and re-anchors", () => {
    const selection = selectSingleRow("unstaged-b.ts");
    expect([...selection.selectedKeys]).toEqual(["unstaged-b.ts"]);
    expect(selection.anchorKey).toBe("unstaged-b.ts");
  });

  it("toggle adds and removes without disturbing the rest", () => {
    let selection = selectSingleRow("unstaged-a.ts");
    selection = toggleRowSelection(selection, "unstaged-c.ts");
    expect([...selection.selectedKeys].sort()).toEqual(["unstaged-a.ts", "unstaged-c.ts"]);
    selection = toggleRowSelection(selection, "unstaged-a.ts");
    expect([...selection.selectedKeys]).toEqual(["unstaged-c.ts"]);
  });

  it("toggling the last row off clears focus", () => {
    const selection = toggleRowSelection(selectSingleRow("unstaged-a.ts"), "unstaged-a.ts");
    expect(selection.focusedKey).toBeNull();
    expect(selection.selectedKeys.size).toBe(0);
  });

  it("shift-range covers display order, in either direction", () => {
    const anchored = selectSingleRow("unstaged-c.ts");
    const range = selectRowRange(THREE, anchored, "unstaged-a.ts");
    expect([...range.selectedKeys].sort()).toEqual([
      "unstaged-a.ts",
      "unstaged-b.ts",
      "unstaged-c.ts",
    ]);
    expect(range.anchorKey).toBe("unstaged-c.ts");
  });

  it("shift-range spans groups, because the range is over what is displayed", () => {
    const rows = rowsOf([file("s.ts", "staged"), file("u1.ts"), file("u2.ts")]);
    const range = selectRowRange(rows, selectSingleRow("staged-s.ts"), "unstaged-u2.ts");
    expect(range.selectedKeys.size).toBe(3);
  });

  it("shift with no anchor degrades to a single select", () => {
    const range = selectRowRange(THREE, EMPTY_CHANGES_SELECTION, "unstaged-b.ts");
    expect([...range.selectedKeys]).toEqual(["unstaged-b.ts"]);
  });

  it("shift onto a row that is not in the list is a no-op", () => {
    const before = selectSingleRow("unstaged-a.ts");
    expect(selectRowRange(THREE, before, "unstaged-zzz.ts")).toBe(before);
  });
});

describe("reconcileSelection", () => {
  it("keeps identity when nothing changed, so an idle refresh does not re-render", () => {
    const selection = selectSingleRow("unstaged-a.ts");
    expect(reconcileSelection(selection, THREE)).toBe(selection);
  });

  it("drops keys whose rows disappeared", () => {
    const selection = selectRowRange(THREE, selectSingleRow("unstaged-a.ts"), "unstaged-c.ts");
    const after = reconcileSelection(selection, rowsOf([file("a.ts")]));
    expect([...after.selectedKeys]).toEqual(["unstaged-a.ts"]);
    expect(after.focusedKey).toBeNull();
  });
});

describe("actionTargetRows", () => {
  it("is the whole multi-selection when focus is inside it", () => {
    const selection = selectRowRange(THREE, selectSingleRow("unstaged-a.ts"), "unstaged-c.ts");
    expect(targetPaths(actionTargetRows(THREE, selection))).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("is just the focused row when the selection is a single row", () => {
    const selection = selectSingleRow("unstaged-b.ts");
    expect(targetPaths(actionTargetRows(THREE, selection))).toEqual(["b.ts"]);
  });

  it("is empty with no focus", () => {
    expect(actionTargetRows(THREE, EMPTY_CHANGES_SELECTION)).toEqual([]);
  });

  it("dedupes a path present in two groups (an MM record)", () => {
    const rows = rowsOf([file("x.ts", "staged"), file("x.ts", "unstaged")]);
    const selection = selectRowRange(rows, selectSingleRow("staged-x.ts"), "unstaged-x.ts");
    expect(targetPaths(actionTargetRows(rows, selection))).toEqual(["x.ts"]);
  });
});

describe("geometry", () => {
  // fork: f4 redesign — derived from the declared constants, never from
  // literals: the pitch was re-scaled in the §8 re-layout and a test that
  // hard-codes 36/38 asserts the old type scale rather than the invariant.
  it("offsets accumulate the declared heights in row order", () => {
    const offsets = changesRowOffsets(THREE, HEIGHTS);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(CHANGES_ROW_HEIGHT.header);
    expect(offsets[2]).toBe(CHANGES_ROW_HEIGHT.header + CHANGES_ROW_HEIGHT.file);
  });

  it("pins nothing while the first header is still on screen", () => {
    expect(stickyChangesGroup(THREE, HEIGHTS, 0)).toBeNull();
    expect(stickyChangesGroup(THREE, HEIGHTS, CHANGES_ROW_HEIGHT.header - 1)).toBeNull();
  });

  it("pins the group once its own header has scrolled fully out", () => {
    expect(stickyChangesGroup(THREE, HEIGHTS, CHANGES_ROW_HEIGHT.header)).toBe("unstaged");
    expect(stickyChangesGroup(THREE, HEIGHTS, 200)).toBe("unstaged");
  });

  it("hands the pin over at the next group header", () => {
    const rows = rowsOf([file("s.ts", "staged"), file("u.ts")]);
    // staged header at 0, staged file below it, unstaged header below that.
    expect(stickyChangesGroup(rows, HEIGHTS, 40)).toBe("staged");
    expect(stickyChangesGroup(rows, HEIGHTS, 120)).toBe("unstaged");
  });
});
