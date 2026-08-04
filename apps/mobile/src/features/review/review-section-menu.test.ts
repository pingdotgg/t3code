import { describe, expect, it } from "vite-plus/test";

import type { ReviewSectionItem, ReviewSectionKind } from "./reviewModel";
import { buildReviewSectionMenu } from "./review-section-menu";

function section(id: string, kind: ReviewSectionKind): ReviewSectionItem {
  return {
    id,
    kind,
    title: id,
    subtitle: null,
    diff: null,
    isLoading: false,
  };
}

describe("buildReviewSectionMenu", () => {
  it("exposes git scopes and the latest turn at the top level", () => {
    const turn28 = section("turn:28", "turn");
    const turn27 = section("turn:27", "turn");
    const workingTree = section("git:working-tree", "working-tree");
    const branchChanges = section("git:branch-range", "branch-range");
    const sinceFork = section("git:since-fork", "since-fork");

    expect(buildReviewSectionMenu([turn28, turn27, workingTree, branchChanges, sinceFork])).toEqual(
      {
        workingTree,
        branchChanges,
        sinceFork,
        latestTurn: turn28,
        turns: [turn28, turn27],
      },
    );
  });

  it("keeps unavailable scopes empty while data loads", () => {
    expect(buildReviewSectionMenu([])).toEqual({
      workingTree: null,
      branchChanges: null,
      sinceFork: null,
      latestTurn: null,
      turns: [],
    });
  });
});
