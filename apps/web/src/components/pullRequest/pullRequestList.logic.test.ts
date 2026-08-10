import type { PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestQuery,
  mergePullRequestDiffStats,
  narrowPullRequestsToFilters,
  partitionPullRequestsWithPriority,
  readPullRequestListSnapshot,
  writePullRequestListSnapshot,
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

  it("does not treat a matching login on another host as the viewer", () => {
    // The same name on GitLab is a different account, and its viewer is unknown here.
    const mixed = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({
        number: 2,
        provider: "gitlab",
        host: "gitlab.com",
        author: { login: "Bilal", name: null, avatarUrl: null },
      }),
    ];
    expect(
      filterPullRequestsByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });

  it("leaves the superset untouched for All", () => {
    expect(filterPullRequestsByInvolvement(entries, VIEWERS, "all")).toHaveLength(3);
  });

  it("keeps two hosts of one provider kind as two accounts", () => {
    // A GitHub Enterprise install is a different account from github.com, so the viewer for
    // one must not claim authorship of the other's change requests.
    const mixed = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({
        number: 2,
        host: "github.acme.dev",
        author: { login: "Bilal", name: null, avatarUrl: null },
      }),
    ];
    expect(
      filterPullRequestsByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
  });
});

describe("pull request grouping", () => {
  it("buckets authored above review-requested and drops empty groups", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry({ number: 1, author: { login: "bilal", name: null, avatarUrl: null } }),
        entry({ number: 2, viewerReviewRequested: true }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => [group.key, group.entries.length])).toEqual([
      ["reviewRequested", 1],
      ["authored", 1],
    ]);
  });

  it("puts everything in Others when the viewer is unknown", () => {
    const groups = groupPullRequestsByInvolvement([entry({ number: 1 })], NO_VIEWERS);
    expect(groups.map((group) => group.key)).toEqual(["others"]);
  });

  it("counts an authored pull request once, even with a review request on it", () => {
    const groups = groupPullRequestsByInvolvement(
      [
        entry({
          number: 1,
          author: { login: "bilal", name: null, avatarUrl: null },
          viewerReviewRequested: true,
        }),
      ],
      VIEWERS,
    );
    expect(groups.map((group) => group.key)).toEqual(["authored"]);
  });
});

describe("pull request search", () => {
  const target = entry({
    number: 4711,
    title: "Restore sidebar actions",
    headBranch: "fix/sidebar",
  });

  it("matches the number with or without the leading hash", () => {
    expect(matchesPullRequestQuery(target, "#4711")).toBe(true);
    expect(matchesPullRequestQuery(target, "4711")).toBe(true);
  });

  it("matches title, branch and author case-insensitively", () => {
    expect(matchesPullRequestQuery(target, "SIDEBAR")).toBe(true);
    expect(matchesPullRequestQuery(target, "fix/side")).toBe(true);
    expect(matchesPullRequestQuery(target, "octocat")).toBe(true);
  });

  it("ignores surrounding whitespace and rejects non-matches", () => {
    expect(matchesPullRequestQuery(target, "   ")).toBe(true);
    expect(matchesPullRequestQuery(target, "kanban")).toBe(false);
  });
});

describe("carrying rows already read into filters nothing has answered yet", () => {
  const rows = [
    entry({ number: 1 }),
    entry({ number: 2, state: "merged" }),
    entry({ number: 3, state: "closed" }),
    entry({ number: 4, host: "github.acme.dev" }),
    entry({ number: 5, projectId: "project-2" as PullRequestListEntry["projectId"] }),
  ];
  const everything = { state: "all", projectId: undefined, host: undefined } as const;

  it("never lets a merged pull request sit under Open", () => {
    expect(
      narrowPullRequestsToFilters(rows, { ...everything, state: "open" }).map((row) => row.number),
    ).toEqual([1, 4, 5]);
  });

  it("keeps only the state that was asked for", () => {
    expect(
      narrowPullRequestsToFilters(rows, { ...everything, state: "merged" }).map(
        (row) => row.number,
      ),
    ).toEqual([2]);
  });

  it("narrows to one host, which two installs of one kind cannot share", () => {
    expect(
      narrowPullRequestsToFilters(rows, { ...everything, host: "github.acme.dev" }).map(
        (row) => row.number,
      ),
    ).toEqual([4]);
  });

  it("narrows to one project", () => {
    expect(
      narrowPullRequestsToFilters(rows, { ...everything, projectId: "project-2" }).map(
        (row) => row.number,
      ),
    ).toEqual([5]);
  });

  it("holds on to everything when nothing narrows it", () => {
    expect(narrowPullRequestsToFilters(rows, everything)).toEqual(rows);
  });
});

describe("resolveProjectScope", () => {
  const projects = [{ id: "p1" }, { id: "p2" }];

  it("keeps an id the environment has", () => {
    expect(resolveProjectScope("p2", projects, true)).toBe("p2");
  });

  it("drops an id from another environment", () => {
    expect(resolveProjectScope("p9", projects, false)).toBe("p9");
    expect(resolveProjectScope("p9", projects, true)).toBeUndefined();
  });

  it("drops an id once the environment is known to have no projects", () => {
    expect(resolveProjectScope("p9", [], true)).toBeUndefined();
  });

  it("keeps an id while the projects are still unknown", () => {
    // Dropping here would list every project for a moment before narrowing back down.
    expect(resolveProjectScope("p9", [], false)).toBe("p9");
  });
});

describe("ranking what a search found", () => {
  const row = (overrides: Partial<PullRequestListEntry> & { number?: number }) =>
    entry({ number: 1, ...overrides });

  it("puts the pull request whose title says it above one that merely mentions it", () => {
    const titled = row({
      number: 1,
      title: "Add the welcome wizard",
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const mentioned = row({
      number: 2,
      title: "Unrelated work",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    expect(
      rankPullRequestMatches([mentioned, titled], "welcome wizard").map((entry) => entry.number),
    ).toEqual([1, 2]);
  });

  it("finds the words in any order, which is how people type them", () => {
    // Substrings count, so "welcomes" answers "welcome" — a search is not a spelling test.
    expect(
      scorePullRequestMatch(row({ title: "The wizard that welcomes" }), "welcome wizard"),
    ).toBe(70);
    expect(
      scorePullRequestMatch(row({ title: "Wizard for the welcome flow" }), "welcome wizard"),
    ).toBe(70);
    // One of the two words is a mention, not an answer, and ranks under both.
    expect(scorePullRequestMatch(row({ title: "A wizard, of sorts" }), "welcome wizard")).toBe(30);
  });

  it("answers a number with the pull request that has it, and nothing else", () => {
    expect(scorePullRequestMatch(row({ number: 42 }), "#42")).toBe(100);
    expect(scorePullRequestMatch(row({ number: 42 }), "43")).toBe(0);
  });

  it("keeps recency where nothing tells two results apart", () => {
    const older = row({ number: 1, title: "no match here", updatedAt: "2026-07-01T00:00:00Z" });
    const newer = row({ number: 2, title: "none here either", updatedAt: "2026-08-01T00:00:00Z" });
    expect(rankPullRequestMatches([older, newer], "wizard").map((entry) => entry.number)).toEqual([
      2, 1,
    ]);
  });

  it("leaves a listing with no search in the order it arrived", () => {
    const first = row({ number: 1, updatedAt: "2026-07-01T00:00:00Z" });
    const second = row({ number: 2, updatedAt: "2026-08-01T00:00:00Z" });
    expect(rankPullRequestMatches([first, second], "  ")).toEqual([first, second]);
  });
});

describe("line counts that arrive after the rows", () => {
  const stats = new Map([["project-1 7", { additions: 42, deletions: 3 }]]);

  it("fills in a row whose host left the counts for later", () => {
    const row = entry({ number: 7, additions: 0, deletions: 0 });
    expect(withDiffStat(row, stats)).toEqual({ ...row, additions: 42, deletions: 3 });
  });

  it("leaves a row the host already counted alone", () => {
    const row = entry({ number: 7, additions: 1, deletions: 1 });
    expect(withDiffStat(row, stats)).toBe(row);
  });

  it("leaves a row whose counts have not arrived as it is", () => {
    const row = entry({ number: 9, additions: 0, deletions: 0 });
    expect(withDiffStat(row, stats)).toBe(row);
  });
});

describe("merging line counts across keyed stats queries", () => {
  it("keeps counts already held while a fresh batch says nothing about them", () => {
    const held = mergePullRequestDiffStats(new Map(), [
      { projectId: "project-1", number: 1, additions: 10, deletions: 2 },
      { projectId: "project-1", number: 2, additions: 5, deletions: 1 },
    ]);
    // A third row appeared; its batch is still pending and contributes nothing yet.
    const merged = mergePullRequestDiffStats(held, []);
    expect(merged.get("project-1 1")).toEqual({ additions: 10, deletions: 2 });
    expect(merged.get("project-1 2")).toEqual({ additions: 5, deletions: 1 });
  });

  it("replaces a count once its replacement arrives, keeping its neighbours", () => {
    const held = mergePullRequestDiffStats(new Map(), [
      { projectId: "project-1", number: 1, additions: 10, deletions: 2 },
    ]);
    const merged = mergePullRequestDiffStats(held, [
      { projectId: "project-1", number: 1, additions: 11, deletions: 2 },
      { projectId: "project-1", number: 3, additions: 7, deletions: 0 },
    ]);
    expect(merged.get("project-1 1")).toEqual({ additions: 11, deletions: 2 });
    expect(merged.get("project-1 3")).toEqual({ additions: 7, deletions: 0 });
  });

  it("does not mutate the map it was handed", () => {
    const held = new Map([["project-1 1", { additions: 1, deletions: 1 }]]);
    mergePullRequestDiffStats(held, [
      { projectId: "project-1", number: 1, additions: 2, deletions: 2 },
    ]);
    expect(held.get("project-1 1")).toEqual({ additions: 1, deletions: 1 });
  });
});

describe("partitioning with the hosts' own priority reads", () => {
  const authoredRow = (number: number, updatedAt: string) =>
    entry({ number, updatedAt, author: { login: "Bilal", name: null, avatarUrl: null } });

  it("keeps Others in feed order when a continuation lands an authored row already partitioned", () => {
    const older = entry({ number: 1, updatedAt: "2026-07-05T00:00:00Z" });
    const newer = entry({ number: 2, updatedAt: "2026-07-06T00:00:00Z" });
    const mine = authoredRow(3, "2026-07-04T00:00:00Z");
    // The authored partition already holds the row the continuation carries.
    const groups = partitionPullRequestsWithPriority([newer, older, mine], [mine], []);
    expect(groups.map((group) => group.key)).toEqual(["authored", "others"]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([2, 1]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([3]);
  });

  it("appends an authored row the partition page missed to Others rather than moving it up", () => {
    const shown = entry({ number: 1, updatedAt: "2026-07-06T00:00:00Z" });
    const olderMine = authoredRow(9, "2026-01-01T00:00:00Z");
    const groups = partitionPullRequestsWithPriority([shown, olderMine], [], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([1, 9]);
  });

  it("gives authored precedence over review-requested and orders partitions by recency", () => {
    const both = authoredRow(1, "2026-07-01T00:00:00Z");
    const requested = entry({
      number: 2,
      viewerReviewRequested: true,
      updatedAt: "2026-07-02T00:00:00Z",
    });
    const requestedOlder = entry({
      number: 3,
      viewerReviewRequested: true,
      updatedAt: "2026-06-02T00:00:00Z",
    });
    const groups = partitionPullRequestsWithPriority([], [both], [both, requestedOlder, requested]);
    expect(groups.map((group) => group.key)).toEqual(["reviewRequested", "authored"]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([2, 3]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([1]);
  });

  it("lets the feed's copy of a partitioned row replace the partition's", () => {
    const stale = authoredRow(1, "2026-07-01T00:00:00Z");
    const fresh = { ...stale, title: "Retitled" };
    const groups = partitionPullRequestsWithPriority([fresh], [stale], []);
    expect(groups[0]!.entries[0]!.title).toBe("Retitled");
  });
});

describe("the list snapshot across a reload", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  };
  const data = {
    entries: [entry({ number: 1 })],
    viewers: { "github.com": "Bilal" },
    providers: [],
    errors: [{ projectId: "project-1", message: "boom" }],
    truncated: true,
    nextCursors: { "pingdotgg/t3code": "cursor-1" },
  } as never;

  it("hydrates the retained rows so ghosts never replace them", () => {
    const storage = makeStorage();
    writePullRequestListSnapshot(storage, "env-1", { scope: "env-1:open:all::", data });
    const snapshot = readPullRequestListSnapshot(storage, "env-1");
    expect(snapshot?.scope).toBe("env-1:open:all::");
    expect(snapshot?.data.entries.map((item) => item.number)).toEqual([1]);
  });

  it("carries neither stale failures nor stale cursors", () => {
    const storage = makeStorage();
    writePullRequestListSnapshot(storage, "env-1", { scope: "s", data });
    const snapshot = readPullRequestListSnapshot(storage, "env-1");
    expect(snapshot?.data.errors).toEqual([]);
    expect(snapshot?.data.nextCursors).toEqual({});
  });

  it("answers nothing for another environment", () => {
    const storage = makeStorage();
    writePullRequestListSnapshot(storage, "env-1", { scope: "s", data });
    expect(readPullRequestListSnapshot(storage, "env-2")).toBeNull();
  });

  it("rejects a snapshot whose rows do not decode as entries", () => {
    const storage = makeStorage();
    storage.setItem(
      "t3.pullRequests.list:env-1",
      JSON.stringify({ scope: "s", data: { entries: [null] } }),
    );
    expect(readPullRequestListSnapshot(storage, "env-1")).toBeNull();
    storage.setItem(
      "t3.pullRequests.list:env-1",
      JSON.stringify({ scope: "s", data: { entries: [{ host: "github.com" }] } }),
    );
    expect(readPullRequestListSnapshot(storage, "env-1")).toBeNull();
  });

  it("shrugs off corrupt storage and no storage at all", () => {
    const storage = makeStorage();
    storage.setItem("t3.pullRequests.list:env-1", "{not json");
    expect(readPullRequestListSnapshot(storage, "env-1")).toBeNull();
    expect(readPullRequestListSnapshot(undefined, "env-1")).toBeNull();
  });
});
