import { describe, expect, it } from "vite-plus/test";
import {
  buildChangesRows,
  changesAllFolderKeys,
  changesFileRowKey,
  changesFolderKeysIn,
  changesGroupOf,
  changesGroupPaths,
  changesListEmptyState,
  changesRowHeight,
  changesRowIndent,
  changesVisibleFileCount,
  CHANGES_GUTTER,
  CHANGES_INDENT_PER_LEVEL,
  CHANGES_ROW_HEIGHT,
  CONFLICT_ACTIONS_HEIGHT,
  DISCARD_CONFIRM_HEIGHT,
  isChangesFileRow,
  partiallyStagedPaths,
  type ChangesRow,
} from "./changesRows";
import type { WorkingCopyArea, WorkingCopyChange, WorkingCopyFile } from "./types";

// The row model is the ONLY source of row order for the changes list — the
// virtualizer, keyboard nav and shift-range select all index this array. Tree
// and flat used to be two different orders; these pin that they are one.

const file = (
  path: string,
  area: WorkingCopyArea = "unstaged",
  change: WorkingCopyChange = "modified",
): WorkingCopyFile => ({ path, area, change });

const EMPTY = new Set<string>();

const build = (over: Partial<Parameters<typeof buildChangesRows>[0]> = {}) =>
  buildChangesRows({
    files: [],
    viewMode: "flat",
    collapsedGroups: EMPTY,
    collapsedFolders: EMPTY,
    filter: "all",
    query: "",
    ...over,
  });

const kinds = (rows: ReadonlyArray<ChangesRow>) => rows.map((row) => `${row.kind}:${row.key}`);

describe("changesGroupOf / changesFileRowKey", () => {
  it("maps areas onto the three display groups", () => {
    expect(changesGroupOf(file("a", "conflicted"))).toBe("conflicted");
    expect(changesGroupOf(file("a", "staged"))).toBe("staged");
    expect(changesGroupOf(file("a", "unstaged"))).toBe("unstaged");
  });

  it("shows untracked files in the unstaged group — untracked is a change, not an area", () => {
    expect(changesGroupOf(file("a", "unstaged", "untracked"))).toBe("unstaged");
  });

  it("keys a row by group AND path — the same file can be in two groups", () => {
    expect(changesFileRowKey(file("src/a.ts", "staged"))).toBe("staged-src/a.ts");
    expect(changesFileRowKey(file("src/a.ts", "unstaged"))).toBe("unstaged-src/a.ts");
  });
});

describe("buildChangesRows — flat", () => {
  it("emits a header per non-empty group, in conflicted → staged → unstaged order", () => {
    const rows = build({
      files: [file("u.ts", "unstaged"), file("s.ts", "staged"), file("c.ts", "conflicted")],
    });
    expect(kinds(rows)).toEqual([
      "header:conflicted:head",
      "file:conflicted-c.ts",
      "header:staged:head",
      "file:staged-s.ts",
      "header:unstaged:head",
      "file:unstaged-u.ts",
    ]);
  });

  it("omits a group entirely when it has no files", () => {
    const rows = build({ files: [file("a.ts", "unstaged")] });
    expect(rows.map((row) => row.group)).toEqual(["unstaged", "unstaged"]);
  });

  it("one row per file, plus one header per group", () => {
    const files = Array.from({ length: 40 }, (_, index) => file(`src/f${index}.ts`));
    expect(build({ files })).toHaveLength(41);
  });

  it("keeps the header but drops the rows when a group is collapsed", () => {
    const rows = build({
      files: [file("s.ts", "staged"), file("u.ts", "unstaged")],
      collapsedGroups: new Set(["staged"]),
    });
    expect(kinds(rows)).toEqual([
      "header:staged:head",
      "header:unstaged:head",
      "file:unstaged-u.ts",
    ]);
    expect(rows[0]!.collapsed).toBe(true);
  });

  it("never collapses the conflicted group — it is the one thing you must act on", () => {
    const rows = build({
      files: [file("c.ts", "conflicted")],
      collapsedGroups: new Set(["conflicted", "staged", "unstaged"]),
    });
    expect(kinds(rows)).toEqual(["header:conflicted:head", "file:conflicted-c.ts"]);
  });

  it("emits an unmerged file as ONE conflicted row, never staged + unstaged", () => {
    // The staging-mid-merge bug: a `UU` record must not double-bucket.
    const rows = build({ files: [file("both.ts", "conflicted", "unmerged")] });
    expect(rows.filter(isChangesFileRow)).toHaveLength(1);
    expect(rows[0]!.detail).toBe("edit, then stage to mark resolved");
  });

  it("emits two rows for a path that is both staged and unstaged (MM)", () => {
    const rows = build({
      files: [file("mm.ts", "staged"), file("mm.ts", "unstaged")],
    });
    expect(kinds(rows.filter(isChangesFileRow))).toEqual([
      "file:staged-mm.ts",
      "file:unstaged-mm.ts",
    ]);
  });
});

describe("partiallyStagedPaths", () => {
  it("flags a path appearing in two groups", () => {
    expect([...partiallyStagedPaths([file("mm.ts", "staged"), file("mm.ts", "unstaged")])]).toEqual(
      ["mm.ts"],
    );
  });

  it("does not flag a path in only one group", () => {
    expect(partiallyStagedPaths([file("a.ts", "staged"), file("b.ts", "unstaged")]).size).toBe(0);
  });
});

describe("buildChangesRows — filtering", () => {
  const files = [
    file("src/a.ts", "unstaged", "modified"),
    file("src/b.ts", "unstaged", "added"),
    file("docs/c.md", "unstaged", "untracked"),
  ];

  it("status filter hides non-matching rows but keeps the header", () => {
    expect(kinds(build({ files, filter: "added" }))).toEqual([
      "header:unstaged:head",
      "file:unstaged-src/b.ts",
    ]);
  });

  it("the untracked filter selects the untracked change", () => {
    expect(kinds(build({ files, filter: "untracked" }))).toEqual([
      "header:unstaged:head",
      "file:unstaged-docs/c.md",
    ]);
  });

  it("the renamed filter also selects copies", () => {
    const renamed = [
      file("new.ts", "staged", "renamed"),
      file("copy.ts", "staged", "copied"),
      file("plain.ts", "staged", "modified"),
    ];
    expect(kinds(build({ files: renamed, filter: "renamed" }))).toEqual([
      "header:staged:head",
      "file:staged-new.ts",
      "file:staged-copy.ts",
    ]);
  });

  it("the header reports both the total and the visible count", () => {
    const rows = build({ files, filter: "added" });
    expect(rows[0]!.total).toBe(3);
    expect(rows[0]!.visible).toBe(1);
  });

  it("the text query is a case-insensitive substring of the full path", () => {
    expect(kinds(build({ files, query: "SRC/" }))).toEqual([
      "header:unstaged:head",
      "file:unstaged-src/a.ts",
      "file:unstaged-src/b.ts",
    ]);
  });

  it("when nothing matches at all, only headers remain — the section shows one banner", () => {
    expect(build({ files, query: "zzz" }).every((row) => row.kind === "header")).toBe(true);
  });

  it("a group filtered to nothing gets a placeholder when OTHER groups still have rows", () => {
    const rows = build({
      files: [file("src/a.ts", "staged", "modified"), file("src/b.ts", "unstaged", "added")],
      filter: "added",
    });
    expect(kinds(rows)).toEqual([
      "header:staged:head",
      "empty:staged:empty",
      "header:unstaged:head",
      "file:unstaged-src/b.ts",
    ]);
  });
});

describe("buildChangesRows — tree", () => {
  const files = [file("src/components/a.ts"), file("src/components/b.ts"), file("README.md")];

  it("emits folder rows with depth, files under them", () => {
    const rows = build({ files, viewMode: "tree" });
    expect(rows.map((row) => [row.kind, row.name ?? row.file?.path, row.depth])).toEqual([
      ["header", undefined, 0],
      // Single-child chains are compacted, so `src/components` is one row.
      ["folder", "src/components", 0],
      ["file", "src/components/a.ts", 1],
      ["file", "src/components/b.ts", 1],
      ["file", "README.md", 0],
    ]);
  });

  it("file rows keep the SAME key in both modes, so selection survives a mode switch", () => {
    const flat = build({ files })
      .filter(isChangesFileRow)
      .map((row) => row.key)
      .sort();
    const tree = build({ files, viewMode: "tree" })
      .filter(isChangesFileRow)
      .map((row) => row.key)
      .sort();
    expect(tree).toEqual(flat);
  });

  it("a collapsed folder hides its whole subtree", () => {
    const rows = build({
      files,
      viewMode: "tree",
      collapsedFolders: new Set(["unstaged:src/components"]),
    });
    expect(kinds(rows)).toEqual([
      "header:unstaged:head",
      "folder:unstaged:d:src/components",
      "file:unstaged-README.md",
    ]);
  });

  it("folder collapse is scoped per group — the same path in two groups is independent", () => {
    const rows = build({
      files: [file("src/a.ts", "staged"), file("src/b.ts", "unstaged")],
      viewMode: "tree",
      collapsedFolders: new Set(["staged:src"]),
    });
    expect(kinds(rows)).toEqual([
      "header:staged:head",
      "folder:staged:d:src",
      "header:unstaged:head",
      "folder:unstaged:d:src",
      "file:unstaged-src/b.ts",
    ]);
  });

  it("a folder row carries every visible file under it, for stage-folder", () => {
    const rows = build({ files, viewMode: "tree" });
    const folderRow = rows.find((row) => row.kind === "folder");
    expect(folderRow?.folderFiles).toEqual(["src/components/a.ts", "src/components/b.ts"]);
  });

  it("folder rows honour the filter — a folder whose files all filter out disappears", () => {
    expect(kinds(build({ files, viewMode: "tree", query: "README" }))).toEqual([
      "header:unstaged:head",
      "file:unstaged-README.md",
    ]);
  });

  it("changesFolderKeysIn enumerates the group-scoped collapse keys", () => {
    expect(changesFolderKeysIn(build({ files, viewMode: "tree" }))).toEqual([
      "unstaged:src/components",
    ]);
  });
});

describe("changesRowHeight", () => {
  const row = (over: Partial<ChangesRow>): ChangesRow => ({
    key: "k",
    kind: "file",
    group: "unstaged",
    depth: 0,
    ...over,
  });

  it("is a constant per non-file kind", () => {
    const options = { hasConflictActions: false, confirmingDiscardKey: null };
    expect(changesRowHeight(row({ kind: "header" }), options)).toBe(CHANGES_ROW_HEIGHT.header);
    expect(changesRowHeight(row({ kind: "folder" }), options)).toBe(CHANGES_ROW_HEIGHT.folder);
    expect(changesRowHeight(row({ kind: "empty" }), options)).toBe(CHANGES_ROW_HEIGHT.empty);
  });

  it("adds the conflict-actions bar only to conflicted rows", () => {
    const options = { hasConflictActions: true, confirmingDiscardKey: null };
    expect(changesRowHeight(row({ group: "conflicted" }), options)).toBe(
      CHANGES_ROW_HEIGHT.file + CONFLICT_ACTIONS_HEIGHT,
    );
    expect(changesRowHeight(row({}), options)).toBe(CHANGES_ROW_HEIGHT.file);
  });

  it("adds the inline discard confirm to exactly the row that owns it", () => {
    const options = { hasConflictActions: false, confirmingDiscardKey: "k" };
    expect(changesRowHeight(row({}), options)).toBe(
      CHANGES_ROW_HEIGHT.file + DISCARD_CONFIRM_HEIGHT,
    );
    expect(changesRowHeight(row({ key: "other" }), options)).toBe(CHANGES_ROW_HEIGHT.file);
  });
});

// ─── F-08 regression: a group header's bulk action is GROUP-SCOPED ──────────
//
// The panel's group header used to call `onDiscard([])`, which the panel
// re-expanded into `discard(null)` — the whole-working-copy rung. These pin
// that the paths a group header acts on can never reach outside its group.

describe("changesGroupPaths (F-08)", () => {
  const mixed: ReadonlyArray<WorkingCopyFile> = [
    file("staged-only.ts", "staged"),
    file("both.ts", "staged"),
    file("both.ts", "unstaged"),
    file("dirty.ts", "unstaged"),
    file("new.ts", "unstaged", "untracked"),
    file("conflict.ts", "conflicted", "unmerged"),
  ];
  const scope = { files: mixed, filter: "all" as const, query: "" };

  it("returns only that group's paths — never the whole working copy", () => {
    expect(changesGroupPaths(scope, "staged").toSorted()).toEqual(["both.ts", "staged-only.ts"]);
    expect(changesGroupPaths(scope, "unstaged").toSorted()).toEqual([
      "both.ts",
      "dirty.ts",
      "new.ts",
    ]);
    expect(changesGroupPaths(scope, "conflicted")).toEqual(["conflict.ts"]);
  });

  it("never widens: no group's paths cover every changed path", () => {
    const everyPath = new Set(mixed.map((entry) => entry.path));
    for (const group of ["staged", "unstaged", "conflicted"] as const) {
      const paths = changesGroupPaths(scope, group);
      expect(paths.length).toBeLessThan(everyPath.size);
    }
  });

  it("is never empty for a group that has files — an empty set is 'do nothing'", () => {
    expect(changesGroupPaths(scope, "unstaged").length).toBeGreaterThan(0);
  });

  it("honours the same filter and query the rows were built from", () => {
    expect(changesGroupPaths({ ...scope, filter: "untracked" }, "unstaged")).toEqual(["new.ts"]);
    expect(changesGroupPaths({ ...scope, query: "dirty" }, "unstaged")).toEqual(["dirty.ts"]);
  });

  it("dedupes a path that appears twice inside one group", () => {
    const scoped = {
      files: [file("a.ts", "unstaged"), file("a.ts", "unstaged", "typechange")],
      filter: "all" as const,
      query: "",
    };
    expect(changesGroupPaths(scoped, "unstaged")).toEqual(["a.ts"]);
  });

  it("answers empty for a group with no files, so the caller does nothing", () => {
    expect(changesGroupPaths({ files: [], filter: "all", query: "" }, "unstaged")).toEqual([]);
  });
});

describe("changesAllFolderKeys (F-14)", () => {
  const nested: ReadonlyArray<WorkingCopyFile> = [
    file("src/a/deep/one.ts"),
    file("src/a/deep/two.ts"),
    file("src/b/three.ts"),
    file("staged/x.ts", "staged"),
  ];
  const scope = { files: nested, filter: "all" as const, query: "" };

  it("includes folders hidden inside a collapsed parent, unlike changesFolderKeysIn(rows)", () => {
    const all = changesAllFolderKeys(scope, "unstaged");
    // Every key is namespaced to the group it came from.
    expect(all.every((key) => key.startsWith("unstaged:"))).toBe(true);
    expect(all.length).toBeGreaterThan(0);

    const visibleRows = build({
      files: nested,
      viewMode: "tree",
      collapsedFolders: new Set(["unstaged:src"]),
    });
    const visible = changesFolderKeysIn(visibleRows).filter((key) => key.startsWith("unstaged:"));
    // The old implementation could only ever collapse what was rendered.
    expect(all.length).toBeGreaterThan(visible.length);
  });

  it("is scoped to one group", () => {
    expect(changesAllFolderKeys(scope, "staged").every((key) => key.startsWith("staged:"))).toBe(
      true,
    );
    expect(changesAllFolderKeys({ files: [], filter: "all", query: "" }, "staged")).toEqual([]);
  });
});

// ─── Geometry (audit §8 / M1, M5) ──────────────────────────────────────────
//
// The row pitch and the gutter were both imported from another app's type
// scale: leaf rows (38) were taller than the folder rows (32) and the group
// headers (36) above them, so visual weight INCREASED going down the
// hierarchy, and the indent was 13px per level from an 8px base — a value off
// the 4px grid the rest of the app uses. These pin the shape of the fix, not
// the literals.

describe("changes list geometry", () => {
  it("puts every row kind on one pitch, so no leaf outweighs its own header", () => {
    const heights = Object.values(CHANGES_ROW_HEIGHT);
    expect(new Set(heights).size).toBe(1);
    expect(CHANGES_ROW_HEIGHT.file).toBeLessThanOrEqual(CHANGES_ROW_HEIGHT.header);
  });

  it("keeps every declared height on the 4px grid", () => {
    for (const height of [
      ...Object.values(CHANGES_ROW_HEIGHT),
      CONFLICT_ACTIONS_HEIGHT,
      DISCARD_CONFIRM_HEIGHT,
      CHANGES_GUTTER,
      CHANGES_INDENT_PER_LEVEL,
    ]) {
      expect(height % 4).toBe(0);
    }
  });

  it("indents from the panel's one gutter, one grid step per level", () => {
    expect(changesRowIndent(0)).toBe(CHANGES_GUTTER);
    expect(changesRowIndent(1)).toBe(CHANGES_GUTTER + CHANGES_INDENT_PER_LEVEL);
    expect(changesRowIndent(3)).toBe(CHANGES_GUTTER + 3 * CHANGES_INDENT_PER_LEVEL);
  });

  it("never indents a negative depth back out of the gutter", () => {
    expect(changesRowIndent(-2)).toBe(CHANGES_GUTTER);
  });
});

// ─── Empty-state selection (audit §8 / M7) ─────────────────────────────────
//
// The list used to render one 32px "Nothing here." row for both cases, so the
// user could not tell "your tree is clean" from "your filter excluded
// everything" — and the second case is the one with an action attached.

describe("changesListEmptyState", () => {
  it("says CLEAN when the working copy has no files at all", () => {
    expect(changesListEmptyState({ fileCount: 0, visibleFileCount: 0 })).toBe("clean");
  });

  it("says FILTERED when files exist but none survived the filter", () => {
    expect(changesListEmptyState({ fileCount: 12, visibleFileCount: 0 })).toBe("filtered");
  });

  it("says nothing at all when there are rows to draw", () => {
    expect(changesListEmptyState({ fileCount: 12, visibleFileCount: 3 })).toBeNull();
  });

  it("prefers CLEAN over FILTERED — an empty tree is not a filter problem", () => {
    // Both inputs are zero here; "clear the filter" would be useless advice.
    expect(changesListEmptyState({ fileCount: 0, visibleFileCount: 0 })).toBe("clean");
  });

  it("reads its visible count off the SAME rows the virtualizer renders", () => {
    const files = [file("a.ts"), file("b.ts", "staged"), file("c.ts")];
    const rows = buildChangesRows({
      files,
      viewMode: "flat",
      collapsedGroups: EMPTY,
      collapsedFolders: EMPTY,
      filter: "all",
      query: "",
    });
    expect(changesVisibleFileCount(rows)).toBe(3);
    expect(
      changesListEmptyState({
        fileCount: files.length,
        visibleFileCount: changesVisibleFileCount(rows),
      }),
    ).toBeNull();

    const filtered = buildChangesRows({
      files,
      viewMode: "flat",
      collapsedGroups: EMPTY,
      collapsedFolders: EMPTY,
      filter: "all",
      query: "no-such-path",
    });
    expect(changesVisibleFileCount(filtered)).toBe(0);
    expect(
      changesListEmptyState({
        fileCount: files.length,
        visibleFileCount: changesVisibleFileCount(filtered),
      }),
    ).toBe("filtered");
  });

  it("counts only file rows — headers and placeholders are not content", () => {
    const rows = buildChangesRows({
      files: [file("a.ts"), file("b.ts", "staged")],
      viewMode: "flat",
      collapsedGroups: EMPTY,
      collapsedFolders: EMPTY,
      filter: "untracked",
      query: "",
    });
    // Two group headers and their "no files match" placeholders survive.
    expect(rows.length).toBeGreaterThan(0);
    expect(changesVisibleFileCount(rows)).toBe(0);
  });
});
