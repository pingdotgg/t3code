import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveThreadPullRequestChains } from "@t3tools/shared/threadPullRequests";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestListLines } from "./pullRequestListLines";

function link(
  number: number,
  head: string,
  base: string,
  updatedAt: string,
  stack: ThreadPullRequestLink["stack"] = null,
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: head,
      baseBranch: base,
      isDraft: false,
      updatedAt,
      syncedAt: updatedAt,
    },
    stack,
  };
}

describe("pullRequestListLines", () => {
  it("sorts unrelated PRs numerically instead of by activity", () => {
    const numbers = [11265, 10236, 10368, 10237, 10234, 10235, 10233, 999];
    const chains = resolveThreadPullRequestChains(
      numbers.map((number, index) =>
        link(number, `pr-${number}`, "main", `2026-01-01T${10 + index}:00:00Z`),
      ),
    );
    const original = chains.map((chain) => chain.layers.map((entry) => entry.number));
    expect(pullRequestListLines(chains, "number").map((line) => line.link.number)).toEqual([
      11265, 10368, 10237, 10236, 10235, 10234, 10233, 999,
    ]);
    expect(chains.map((chain) => chain.layers.map((entry) => entry.number))).toEqual(original);
  });

  it("orders by highest PR number and keeps a stack together under its base layer", () => {
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(1, "a", "main", "2026-01-01T10:00:00Z"),
        link(12, "b", "a", "2026-01-01T08:00:00Z"),
        link(9, "solo", "main", "2026-01-01T11:00:00Z"),
        link(5, "old", "main", "2026-01-01T09:00:00Z"),
      ]),
      "number",
    );
    expect(lines.map((line) => [line.link.number, line.depth, line.stack?.size ?? null])).toEqual([
      // The stack's highest number is #12, so the whole stack outranks #9.
      [1, 0, 2],
      [12, 1, null],
      [9, 0, null],
      [5, 0, null],
    ]);
  });

  it("defaults to latest activity and can switch back from number order", () => {
    const chains = resolveThreadPullRequestChains([
      link(1, "a", "main", "2026-01-01T10:00:00Z"),
      link(2, "b", "a", "2026-01-01T12:00:00Z"),
      link(9, "solo", "main", "2026-01-01T11:00:00Z"),
    ]);
    expect(pullRequestListLines(chains).map((line) => line.link.number)).toEqual([1, 2, 9]);
    expect(pullRequestListLines(chains, "number").map((line) => line.link.number)).toEqual([
      9, 1, 2,
    ]);
    expect(pullRequestListLines(chains, "activity").map((line) => line.link.number)).toEqual([
      1, 2, 9,
    ]);
  });

  it("marks native stacks on their base layer", () => {
    const stack = {
      kind: "native" as const,
      id: "1",
      number: 1,
      url: "https://github.com/acme/web/stacks/1",
      base: "main",
      layers: [
        { number: 3, headBranch: "x", state: "open" as const },
        { number: 4, headBranch: "y", state: "open" as const },
      ],
    };
    const lines = pullRequestListLines(
      resolveThreadPullRequestChains([
        link(4, "y", "x", "2026-01-01T10:00:00Z", stack),
        link(3, "x", "main", "2026-01-01T10:00:00Z", stack),
      ]),
    );
    expect(lines.map((line) => [line.link.number, line.depth, line.stack?.kind ?? null])).toEqual([
      [3, 0, "native"],
      [4, 1, null],
    ]);
  });
});
