import type { PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
  mergePullRequestDiffStats,
  narrowPullRequestsToFilters,
  partitionPullRequestsWithPriority,
  rankPullRequestMatches,
  scorePullRequestMatch,
  withDiffStat,
  resolveProjectScope,
} from "./pullRequestList.logic";

const VIEWERS = { "github.com": "Bilal" } as const;
const NO_VIEWERS = {} as const;

function entry(overrides: Partial<PullRequestListEntry> & Pick<PullRequestListEntry, "number">) {
  return {
    provider: "github",
    host: "github.com",
    projectId: "project-1",
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    title: "Add the pull requests page",
    url: `https://github.com/pingdotgg/t3code/pull/${overrides.number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/branch-${overrides.number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  } as PullRequestListEntry;
}

describe("pull request involvement filtering", () => {
  const entries = [
    entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
    entry({ number: 2, viewerReviewRequested: true }),
    entry({ number: 3 }),
  ];

  it("matches the viewer's own pull requests case-insensitively", () => {
    expect(
      filterPullRequestsByInvolvement(entries, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("returns nothing for Authored when the viewer is unknown", () => {
    expect(filterPullRequestsByInvolvement(entries, NO_VIEWERS, "authored")).toEqual([]);
  });

  it("uses the server-computed review-request flag for Reviewing", () => {
    expect(
      filterPullRequestsByInvolvement(entries, VIEWERS, "reviewing").map((item) => item.number),
    ).toEqual([2]);
  });
});

describe("grouping", () => {
  it("puts authored ahead of review-requested when a row is both", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry({
          number: 1,
          author: { login: "Bilal", name: null, avatarUrl: null },
          viewerReviewRequested: true,
        }),
        entry({ number: 2, viewerReviewRequested: true }),
        entry({ number: 3 }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => [group.key, group.entries.map((item) => item.number)])).toEqual([
      ["reviewRequested", [2]],
      ["authored", [1]],
      ["others", [3]],
    ]);
  });
});

describe("query matching", () => {
  it("matches number, title, repository, branch and author", () => {
    const row = entry({ number: 42, title: "Fix the login wizard" });
    expect(matchesPullRequestQuery(row, "42")).toBe(true);
    expect(matchesPullRequestQuery(row, "#42")).toBe(true);
    expect(matchesPullRequestQuery(row, "wizard")).toBe(true);
    expect(matchesPullRequestQuery(row, "missing")).toBe(false);
  });
});

describe("narrowing and ranking", () => {
  it("drops rows that no longer match the state filter", () => {
    expect(
      narrowPullRequestsToFilters(
        [entry({ number: 1, state: "open" }), entry({ number: 2, state: "merged" })],
        { state: "open", projectId: undefined, host: undefined },
      ).map((item) => item.number),
    ).toEqual([1]);
  });

  it("ranks an exact title above a host-only match", () => {
    const rows = [
      entry({ number: 1, title: "Unrelated", updatedAt: "2026-07-03T00:00:00Z" }),
      entry({ number: 2, title: "Welcome wizard", updatedAt: "2026-07-01T00:00:00Z" }),
    ];
    expect(scorePullRequestMatch(rows[1]!, "welcome wizard")).toBe(90);
    expect(rankPullRequestMatches(rows, "welcome wizard")[0]?.number).toBe(2);
  });
});

describe("diff stats", () => {
  it("fills missing line counts without overwriting ones the listing already had", () => {
    const withCounts = entry({ number: 1, additions: 4, deletions: 1 });
    const without = entry({ number: 2, additions: 0, deletions: 0 });
    const stats = mergePullRequestDiffStats(new Map(), [
      { projectId: "project-1", number: 2, additions: 9, deletions: 3 },
    ]);
    expect(withDiffStat(withCounts, stats).additions).toBe(4);
    expect(withDiffStat(without, stats)).toMatchObject({ additions: 9, deletions: 3 });
  });
});

describe("priority partitions", () => {
  it("keeps authored rows out of the reviewing bucket", () => {
    const authored = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
    ];
    const reviewing = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({ number: 2, viewerReviewRequested: true }),
    ];
    const feed = [...authored, entry({ number: 3 })];
    expect(
      partitionPullRequestsWithPriority(feed, authored, reviewing).map((group) => [
        group.key,
        group.entries.map((item) => item.number),
      ]),
    ).toEqual([
      ["reviewRequested", [2]],
      ["authored", [1]],
      ["others", [3]],
    ]);
  });
});

describe("project scope", () => {
  it("keeps an unknown id until projects are known, then drops it", () => {
    expect(resolveProjectScope("missing", [{ id: "a" }], false)).toBe("missing");
    expect(resolveProjectScope("missing", [{ id: "a" }], true)).toBeUndefined();
    expect(resolveProjectScope("a", [{ id: "a" }], true)).toBe("a");
  });
});
