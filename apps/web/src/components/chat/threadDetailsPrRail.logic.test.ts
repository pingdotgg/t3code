import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prRailBlocker, prRailItems, threadDetailsPrGroups } from "./threadDetailsPrRail.logic";

function link(
  number: number,
  headBranch: string,
  baseBranch: string,
  snapshot: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestLink {
  const at = `2026-01-01T00:00:${String(number % 60).padStart(2, "0")}.000Z`;
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: at,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch,
      baseBranch,
      isDraft: false,
      updatedAt: at,
      syncedAt: at,
      ...snapshot,
    },
    stack: null,
  };
}

function stackOf(size: number) {
  return Array.from({ length: size }, (_, index) =>
    link(index + 1, `layer-${index + 1}`, index === 0 ? "staging" : `layer-${index}`),
  );
}

const shape = (items: ReturnType<typeof prRailItems>) =>
  items.map((item) => (item.kind === "fold" ? `…${item.count}` : item.link.number));

describe("threadDetailsPrGroups", () => {
  it("puts the current stack first, tip on top, and names its base", () => {
    const layers = stackOf(3);
    const other = link(9, "unrelated", "main");
    const { current, others } = threadDetailsPrGroups([other, ...layers], layers[1]!);
    expect(current?.layers.map((entry) => entry.number)).toEqual([3, 2, 1]);
    expect(current?.base).toBe("staging");
    expect(others.map((group) => group.layers.map((entry) => entry.number))).toEqual([[9]]);
  });

  it("keeps sibling pull requests on one base branch out of a rail", () => {
    const base = link(1, "layer-1", "staging");
    const left = link(2, "left", "layer-1");
    const right = link(3, "right", "layer-1");
    const { current, others } = threadDetailsPrGroups([base, left, right], right);
    expect(current?.layers.map((entry) => entry.number)).toEqual([3]);
    expect(others.map((group) => group.layers.map((entry) => entry.number))).toEqual([[1], [2]]);
  });
});

describe("prRailItems", () => {
  it("shows a short stack whole", () => {
    const layers = stackOf(5).toReversed();
    expect(shape(prRailItems(layers, layers[0]!, false))).toEqual([5, 4, 3, 2, 1]);
  });

  it("keeps the tip, the base, and the layers around the current one", () => {
    const layers = stackOf(20).toReversed();
    const current = layers.find((entry) => entry.number === 10)!;
    expect(shape(prRailItems(layers, current, false))).toEqual([
      20,
      19,
      "…6",
      12,
      11,
      10,
      9,
      8,
      "…5",
      2,
      1,
    ]);
  });

  it("folds the middle of a stack the thread is not on", () => {
    const layers = stackOf(13).toReversed();
    expect(shape(prRailItems(layers, null, false))).toEqual([13, 12, "…9", 2, 1]);
  });

  it("never folds a single layer", () => {
    const layers = stackOf(7).toReversed();
    const current = layers.find((entry) => entry.number === 6)!;
    expect(shape(prRailItems(layers, current, false))).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("shows every layer once unfolded", () => {
    const layers = stackOf(13).toReversed();
    expect(prRailItems(layers, null, true)).toHaveLength(13);
  });
});

describe("prRailBlocker", () => {
  it("names the lowest unmerged layer that stops the stack from merging", () => {
    const layers = [
      link(4, "d", "c", { checksState: "failing" }),
      link(3, "c", "b", { mergeability: "conflicting" }),
      link(2, "b", "a", { checksState: "passing" }),
      link(1, "a", "main", { state: "merged", checksState: "failing" }),
    ];
    expect(prRailBlocker(layers)).toEqual({ link: layers[1], reason: "conflicting" });
  });

  it("finds nothing when every unmerged layer can merge", () => {
    expect(
      prRailBlocker([link(2, "b", "a", { checksState: "pending" }), link(1, "a", "main")]),
    ).toBe(null);
  });
});
