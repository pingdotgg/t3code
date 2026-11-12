import { describe, expect, it } from "vite-plus/test";
import {
  reviewTreeActionFiles,
  reviewTreeRowKey,
  selectReviewTreeRows,
  type ReviewTreeRow,
  type ReviewTreeSelection,
} from "./reviewFileTreeSelection.ts";

const row = (
  path: string,
  kind: "file" | "folder" = "file",
  scope: "staged" | "unstaged" = "unstaged",
): ReviewTreeRow => ({ path, kind, scope });
const files = ["src/a.ts", "src/b.ts", "src/nested/c.ts", "src/library/d.ts", "tests/a.test.ts"];
const visible = [
  row("src", "folder"),
  row(files[0]!),
  row(files[1]!),
  row("src/nested", "folder"),
  row(files[2]!),
  row("tests", "folder"),
  row(files[4]!),
];
const empty: ReviewTreeSelection = { rows: [], anchor: null };
const click = (current: ReviewTreeSelection, at: number, toggle = false, range = false) =>
  selectReviewTreeRows(current, visible, visible[at]!, { toggle, range });

describe("Git tree selection", () => {
  it("adds and removes separate files with the command modifier, then replaces them on an ordinary click", () => {
    const first = click(empty, 1);
    const added = click(first, 2, true);
    expect(reviewTreeActionFiles(files, added.rows, visible[2]!)).toEqual(["src/a.ts", "src/b.ts"]);
    const removed = click(added, 1, true);
    expect(reviewTreeActionFiles(files, removed.rows, visible[2]!)).toEqual(["src/b.ts"]);
    expect(click(removed, 6).rows).toEqual([visible[6]]);
    expect(first.rows).toEqual([visible[1]]);
  });

  it("extends and contracts a visible range using the original anchor in either direction", () => {
    const first = click(empty, 1);
    const range = click(first, 4, false, true);
    expect(range.rows).toEqual(visible.slice(1, 5));
    expect(reviewTreeActionFiles(files, range.rows, visible[4]!)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/nested/c.ts",
    ]);
    expect(click(range, 2, false, true).rows).toEqual(visible.slice(1, 3));
    expect(click(click(empty, 4), 1, false, true).rows).toEqual(visible.slice(1, 5));
  });

  it("command-shift adds a range without discarding separately selected rows", () => {
    const separate = click(click(empty, 6), 1, true);
    const range = click(separate, 2, true, true);
    expect(reviewTreeActionFiles(files, range.rows, visible[2]!)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "tests/a.test.ts",
    ]);
  });

  it("includes every child of a collapsed folder and deduplicates explicit child selection", () => {
    const selected = [row("src", "folder"), row("src/a.ts"), row("tests/a.test.ts")];
    expect(reviewTreeActionFiles(files, selected, row("src", "folder"))).toEqual(files);
    // A child action of the selected folder acts on the same full selection.
    expect(reviewTreeActionFiles(files, selected, row("src/nested/c.ts"))).toEqual(files);
  });

  it("keeps folder boundaries exact and gives an unselected row its own action", () => {
    const inventory = ["src/lib/a.ts", "src/library/b.ts", "src/lib/deep/c.ts"];
    const folder = row("src/lib", "folder");
    expect(reviewTreeActionFiles(inventory, [folder], folder)).toEqual([
      "src/lib/a.ts",
      "src/lib/deep/c.ts",
    ]);
    expect(reviewTreeActionFiles(inventory, [folder], row("src/library/b.ts"))).toEqual([
      "src/library/b.ts",
    ]);
  });

  it("restricts actions to their Git section even when a range crosses both sections", () => {
    const staged = row("src/a.ts", "file", "staged");
    const unstaged = row("src/b.ts");
    const across = selectReviewTreeRows(
      { rows: [staged], anchor: staged },
      [staged, unstaged],
      unstaged,
      { toggle: false, range: true },
    );
    expect(reviewTreeActionFiles(files, across.rows, unstaged)).toEqual(["src/b.ts"]);
    expect(reviewTreeActionFiles(files, across.rows, staged)).toEqual(["src/a.ts"]);
    expect(reviewTreeRowKey(staged)).not.toBe(reviewTreeRowKey(row("src/a.ts")));
  });

  it("retains top-level all-files actions regardless of the current selection", () => {
    expect(reviewTreeActionFiles(files, [row("src/a.ts")], null)).toEqual(files);
  });

  it("ignores files removed by staging and safely reanchors when an anchor is no longer visible", () => {
    const selected = [row("src/a.ts"), row("src/b.ts")];
    expect(reviewTreeActionFiles(["src/b.ts"], selected, row("src/b.ts"))).toEqual(["src/b.ts"]);
    expect(
      selectReviewTreeRows({ rows: selected, anchor: row("removed.ts") }, visible, visible[2]!, {
        toggle: false,
        range: true,
      }),
    ).toEqual({ rows: [visible[2]], anchor: visible[2] });
  });
});
