import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PULL_REQUEST_DIFF_FOLDS,
  foldAllPullRequestDiffs,
  isFileDiffCollapsed,
  withFileDiffFold,
  withPullRequestDiffFold,
  type DiffFoldGroup,
} from "./pullRequestDiffFold.ts";

describe("isFileDiffCollapsed", () => {
  it("collapses saved viewed files on reopening and when a later read marks them viewed", () => {
    const overrides = new Map<string, boolean>();
    expect(isFileDiffCollapsed("a.ts", null, overrides, false)).toBe(false);
    expect(isFileDiffCollapsed("a.ts", null, overrides, true)).toBe(true);
    expect(isFileDiffCollapsed("a.ts", null, overrides, false)).toBe(false);
  });

  it("preserves individual choices while viewed state and loaded pages change", () => {
    const overrides = new Map([
      ["a.ts", false],
      ["b.ts", true],
    ]);
    expect(isFileDiffCollapsed("a.ts", null, overrides, true)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", null, overrides, false)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, overrides, true)).toBe(true);
    expect(isFileDiffCollapsed("d.ts", null, overrides, false)).toBe(false);
  });

  it("respects expand all and fold all, including later pages and individual exceptions", () => {
    const overrides = new Map<string, boolean>();
    expect(isFileDiffCollapsed("a.ts", "expanded", overrides, true)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "folded", overrides, false)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", "folded", new Map([["c.ts", false]]), true)).toBe(false);
    expect(isFileDiffCollapsed("d.ts", "expanded", new Map([["d.ts", true]]), false)).toBe(true);
  });
});

describe("withFileDiffFold", () => {
  it("records or clears a choice and keeps the same map when nothing changes", () => {
    const folded = withFileDiffFold(new Map(), "a.ts", true);
    expect(folded.get("a.ts")).toBe(true);
    expect(withFileDiffFold(folded, "a.ts", true)).toBe(folded);
    expect(withFileDiffFold(folded, "a.ts", false).get("a.ts")).toBe(false);
    expect(withFileDiffFold(folded, "a.ts", undefined).has("a.ts")).toBe(false);
  });
});

describe("foldAllPullRequestDiffs", () => {
  it.each([
    { override: "expanded", testsHidden: false },
    { override: "expanded", testsHidden: true },
    { override: "folded", testsHidden: false },
    { override: "folded", testsHidden: true },
  ] as const)("$override with tests hidden: $testsHidden", ({ override, testsHidden }) => {
    const bulk = override === "folded";
    let folds = withPullRequestDiffFold(EMPTY_PULL_REQUEST_DIFF_FOLDS, false, (choices) =>
      withFileDiffFold(choices, "source", !bulk),
    );
    folds = withPullRequestDiffFold(folds, true, (choices) =>
      withFileDiffFold(withFileDiffFold(choices, "hidden-test", !bulk), "revealed-test", !bulk),
    );
    const next = foldAllPullRequestDiffs(
      folds,
      override,
      testsHidden ? { shownKeys: ["revealed-test"] } : null,
    );
    const collapsed = (group: DiffFoldGroup, key: string, viewed = false) =>
      isFileDiffCollapsed(key, group.override, group.choices, viewed);

    expect(collapsed(next.source, "source")).toBe(bulk);
    expect(collapsed(next.source, "later-source", !bulk)).toBe(bulk);
    expect(collapsed(next.test, "revealed-test")).toBe(bulk);
    // A hidden test keeps its own choice, or its live Viewed mark when it has none.
    expect(collapsed(next.test, "hidden-test")).toBe(testsHidden ? !bulk : bulk);
    expect(collapsed(next.test, "later-test", !bulk)).toBe(testsHidden ? !bulk : bulk);
  });
});
