import { describe, expect, it } from "vite-plus/test";

import {
  applyPullRequestDiffFold,
  createPullRequestDiffFoldState,
  isFileDiffCollapsed,
  withFileDiffFold,
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

describe("applyPullRequestDiffFold", () => {
  it.each([
    { before: null, after: "expanded", hiddenFold: true },
    { before: "folded", after: "expanded", hiddenFold: true },
    { before: "expanded", after: "folded", hiddenFold: false },
  ] as const)(
    "keeps hidden folds when switching from $before to $after",
    ({ before, after, hiddenFold }) => {
      const initial = createPullRequestDiffFoldState();
      const previous =
        before === null ? initial : applyPullRequestDiffFold(initial, before, null, null);
      const next = applyPullRequestDiffFold(
        {
          ...previous,
          choices: new Map([
            ["hidden-explicit", !hiddenFold],
            ["shown-source", after === "expanded"],
          ]),
        },
        after,
        null,
        [
          { key: "hidden-viewed", viewed: true, hidden: true },
          { key: "hidden-explicit", viewed: true, hidden: true },
          { key: "shown-test", viewed: true, hidden: false },
        ],
      );
      expect(isFileDiffCollapsed("hidden-viewed", next.testOverride, next.choices, false)).toBe(
        hiddenFold,
      );
      expect(isFileDiffCollapsed("hidden-explicit", next.testOverride, next.choices)).toBe(
        !hiddenFold,
      );
      expect(isFileDiffCollapsed("shown-test", next.testOverride, next.choices)).toBe(
        after === "folded",
      );
      expect(isFileDiffCollapsed("shown-source", next.sourceOverride, next.choices)).toBe(
        after === "folded",
      );
      expect(isFileDiffCollapsed("later-source", next.sourceOverride, next.choices)).toBe(
        after === "folded",
      );
      expect(isFileDiffCollapsed("later-test", next.testOverride, next.choices, true)).toBe(
        hiddenFold,
      );
    },
  );
});
