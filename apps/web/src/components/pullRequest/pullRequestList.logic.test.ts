import type { EnvironmentId, ProjectId, PullRequestListEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPullRequestsByInvolvement,
  findScopedProject,
  mergePullRequestLists,
  pullRequestEntryKey,
  pullRequestEnvironmentSetKey,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  parsePullRequestQuery,
  pullRequestStatsBatches,
  pullRequestStatsKeysToRequest,
  pullRequestStatsRefreshBatches,
  pullRequestStatsRequestBatches,
  mergePullRequestDiffStats,
  narrowPullRequestsToFilters,
  partitionPullRequestsWithPriority,
  readPullRequestListSnapshot,
  writePullRequestListSnapshot,
  rankPullRequestMatches,
  rankPullRequestsByMergeReadiness,
  scorePullRequestMatch,
  sortPullRequestGroups,
  retainVisiblePullRequestStatsBatches,
  withDiffStat,
  resolveProjectScope,
  resolveQueryEnvironmentIds,
  resolveSelectedEnvironmentId,
  type EnvironmentPullRequestEntry,
} from "./pullRequestList.logic";
import {
  pullRequestListPreferences,
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";

const VIEWERS = { "github.com": "Bilal" } as const;
const NO_VIEWERS = {} as const;

function entry(
  overrides: Partial<EnvironmentPullRequestEntry> & Pick<PullRequestListEntry, "number">,
) {
  return {
    environmentId: "env-1",
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
  } as EnvironmentPullRequestEntry;
}

describe("visible pull request line-count targets", () => {
  it("reuses counts supplied by the listing and only requests missing counts", () => {
    const entries = [
      entry({ number: 1, additions: 12, deletions: 0 }),
      entry({ number: 2, additions: 0, deletions: 7 }),
      entry({ number: 3, additions: 0, deletions: 0 }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const keys = pullRequestStatsKeysToRequest(
      entriesByKey,
      new Set(entries.map(pullRequestEntryKey)),
      [],
      new Map(),
    );

    expect(pullRequestStatsBatches(entriesByKey, keys)[0]?.input.refs).toEqual([
      { projectId: "project-1", repository: "pingdotgg/t3code", number: 3 },
    ]);
  });

  it("does not request a row again after its received batch is pruned", () => {
    const entries = [
      entry({ additions: 0, deletions: 0, number: 1 }),
      entry({ additions: 0, deletions: 0, number: 2 }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const firstKey = pullRequestEntryKey(entries[0]!);
    const secondKey = pullRequestEntryKey(entries[1]!);
    const completedStats = mergePullRequestDiffStats(new Map(), [
      {
        environmentId: ENV_1,
        projectId: "project-1",
        number: 1,
        additions: 1,
        deletions: 1,
      },
    ]);

    const keys = pullRequestStatsKeysToRequest(
      entriesByKey,
      new Set([firstKey, secondKey]),
      [],
      completedStats,
    );
    expect([...keys]).toEqual([secondKey]);
    expect(pullRequestStatsBatches(entriesByKey, keys)[0]?.input.refs).toEqual([
      { projectId: "project-1", repository: "pingdotgg/t3code", number: 2 },
    ]);
  });

  it("drops historical rows after a long scroll so refresh stays bounded to the viewport", () => {
    const entries = Array.from({ length: 500 }, (_, index) =>
      entry({ additions: 0, deletions: 0, number: index + 1 }),
    );
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const batches = entries.map(
      (item) => pullRequestStatsBatches(entriesByKey, new Set([pullRequestEntryKey(item)]))[0]!,
    );
    const visibleKeys = new Set(entries.slice(-12).map(pullRequestEntryKey));

    const retained = retainVisiblePullRequestStatsBatches(batches, visibleKeys);
    expect(retained).toHaveLength(12);
    expect(retained.flatMap((batch) => batch.input.refs.map((ref) => ref.number))).toEqual(
      entries.slice(-12).map((item) => item.number),
    );
  });

  it("keeps every per-environment batch within the stats contract limit", () => {
    const entries = Array.from({ length: 501 }, (_, index) =>
      entry({ additions: 0, deletions: 0, number: index + 1 }),
    );
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const batches = pullRequestStatsBatches(
      entriesByKey,
      new Set(entries.map(pullRequestEntryKey)),
    );

    expect(batches.map((batch) => batch.input.refs.length)).toEqual([500, 1]);
    expect(batches.flatMap((batch) => [...batch.keys])).toEqual(entries.map(pullRequestEntryKey));
  });

  it("selects visible rows for date modes and every uncached row for size modes", () => {
    const entries = [
      entry({ additions: 0, deletions: 0, number: 1 }),
      entry({ additions: 0, deletions: 0, number: 2 }),
      entry({ additions: 0, deletions: 0, number: 3, environmentId: "env-2" as EnvironmentId }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const [firstKey, secondKey] = entries.map(pullRequestEntryKey);
    const cachedStats = mergePullRequestDiffStats(new Map(), [
      {
        environmentId: ENV_1,
        projectId: "project-1",
        number: 1,
        additions: 1,
        deletions: 1,
      },
    ]);

    const visible = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: new Set([firstKey!, secondKey!]),
      policy: "visible",
      activeBatches: [],
      statsByRow: cachedStats,
    });
    expect(visible.flatMap((batch) => batch.input.refs.map((ref) => ref.number))).toEqual([2]);

    const eager = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: new Set([firstKey!]),
      policy: "eager",
      activeBatches: [],
      statsByRow: cachedStats,
    });
    expect(eager.map((batch) => batch.environmentId)).toEqual([ENV_1, "env-2"]);
    expect(eager.flatMap((batch) => batch.input.refs.map((ref) => ref.number))).toEqual([2, 3]);
  });

  it("refreshes only visible rows unless size sorting needs every loaded row", () => {
    const entries = [
      entry({ additions: 0, deletions: 0, number: 1 }),
      entry({ additions: 0, deletions: 0, number: 2 }),
      entry({ additions: 0, deletions: 0, number: 3 }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const visibleKeys = new Set([pullRequestEntryKey(entries[1]!)]);
    const cachedStats = mergePullRequestDiffStats(
      new Map(),
      entries.map((item) => ({
        environmentId: ENV_1,
        projectId: item.projectId,
        number: item.number,
        additions: item.additions,
        deletions: item.deletions,
      })),
    );

    const visible = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: visibleKeys,
      policy: "visible",
      activeBatches: [],
      statsByRow: cachedStats,
      refresh: true,
    });
    expect(visible[0]?.input.refs.map((ref) => ref.number)).toEqual([2]);

    const eager = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: visibleKeys,
      policy: "eager",
      activeBatches: [],
      statsByRow: cachedStats,
      refresh: true,
    });
    expect(eager[0]?.input.refs.map((ref) => ref.number)).toEqual([1, 2, 3]);
  });

  it("ignores a late refresh after the filter or stats policy changes", () => {
    const entries = [
      entry({ additions: 0, deletions: 0, number: 1 }),
      entry({ additions: 0, deletions: 0, number: 2 }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const visibleKeys = new Set([pullRequestEntryKey(entries[1]!)]);
    const requestedScope = { key: "open", policy: "visible" } as const;
    const refresh = (currentScope: { key: string; policy: "visible" | "eager" }) =>
      pullRequestStatsRefreshBatches({
        requestedScope,
        currentScope,
        entriesByKey,
        candidateKeys: visibleKeys,
        statsByRow: new Map(),
      });

    expect(refresh(requestedScope)?.[0]?.input.refs.map((ref) => ref.number)).toEqual([2]);
    expect(refresh({ key: "closed", policy: "visible" })).toBeNull();
    expect(refresh({ key: "open", policy: "eager" })).toBeNull();
  });

  it("does not add request batches again while rows are active or cached", () => {
    const entries = [
      entry({ additions: 0, deletions: 0, number: 1 }),
      entry({ additions: 0, deletions: 0, number: 2 }),
    ];
    const entriesByKey = new Map(entries.map((item) => [pullRequestEntryKey(item), item]));
    const first = pullRequestStatsRequestBatches({
      entriesByKey,
      candidateKeys: new Set(),
      policy: "eager",
      activeBatches: [],
      statsByRow: new Map(),
    });

    expect(
      pullRequestStatsRequestBatches({
        entriesByKey,
        candidateKeys: new Set(),
        policy: "eager",
        activeBatches: first,
        statsByRow: new Map(),
      }),
    ).toEqual([]);

    const cachedStats = mergePullRequestDiffStats(
      new Map(),
      entries.map((item) => ({
        environmentId: ENV_1,
        projectId: item.projectId,
        number: item.number,
        additions: item.additions,
        deletions: item.deletions,
      })),
    );
    expect(
      pullRequestStatsRequestBatches({
        entriesByKey,
        candidateKeys: new Set(entries.map(pullRequestEntryKey)),
        policy: "visible",
        activeBatches: [],
        statsByRow: cachedStats,
      }),
    ).toEqual([]);
  });
});

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
      ["authored", 1],
      ["reviewRequested", 1],
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

describe("narrowing rows by the filters a host may not have applied", () => {
  const rows = [
    entry({ number: 1 }),
    entry({ number: 2, isDraft: true }),
    entry({ number: 3, reviewDecision: "approved" }),
    entry({
      number: 4,
      labels: [{ name: "Needs design", color: null }],
      author: { login: "Hubot", name: null, avatarUrl: null },
      reviewDecision: "changes-requested",
    }),
  ];
  const narrow = (filters: Parameters<typeof matchesPullRequestFilters>[1]) =>
    rows.filter((row) => matchesPullRequestFilters(row, filters)).map((row) => row.number);

  it("keeps or drops drafts as asked", () => {
    expect(narrow({ draft: "only" })).toEqual([2]);
    expect(narrow({ draft: "hide" })).toEqual([1, 3, 4]);
  });

  it("keeps the review state that was asked for, and no reviews means none at all", () => {
    expect(narrow({ review: "approved" })).toEqual([3]);
    expect(narrow({ review: "changes-requested" })).toEqual([4]);
    expect(narrow({ review: "none" })).toEqual([1, 2]);
  });

  it("matches labels and authors however either was capitalized", () => {
    expect(narrow({ labels: [["needs DESIGN"]] })).toEqual([4]);
    expect(narrow({ excludedLabels: ["needs design"] })).toEqual([1, 2, 3]);
    expect(narrow({ author: "hubot" })).toEqual([4]);
  });

  it("resolves author:me to the given viewer, case-insensitively", () => {
    const mine = entry({ number: 30, author: { login: "Bilal", name: null, avatarUrl: null } });
    const theirs = entry({ number: 31, author: { login: "Hubot", name: null, avatarUrl: null } });
    expect(matchesPullRequestFilters(mine, { author: "me" }, "bilal")).toBe(true);
    expect(matchesPullRequestFilters(theirs, { author: "me" }, "bilal")).toBe(false);
  });

  it("resolves author:@me the same way as author:me", () => {
    const mine = entry({ number: 32, author: { login: "Bilal", name: null, avatarUrl: null } });
    const theirs = entry({ number: 33, author: { login: "Hubot", name: null, avatarUrl: null } });
    expect(matchesPullRequestFilters(mine, { author: "@me" }, "Bilal")).toBe(true);
    expect(matchesPullRequestFilters(theirs, { author: "@me" }, "Bilal")).toBe(false);
  });

  it("compares author:me against the literal name when there is no viewer", () => {
    const literalMe = entry({ number: 34, author: { login: "me", name: null, avatarUrl: null } });
    const someoneElse = entry({
      number: 35,
      author: { login: "Bilal", name: null, avatarUrl: null },
    });
    expect(matchesPullRequestFilters(literalMe, { author: "me" })).toBe(true);
    expect(matchesPullRequestFilters(someoneElse, { author: "me" })).toBe(false);
  });

  it("takes a group of labels as an either-or", () => {
    const sized = [
      entry({ number: 10, labels: [{ name: "size:S", color: null }] }),
      entry({ number: 11, labels: [{ name: "size:XS", color: null }] }),
      entry({ number: 12, labels: [{ name: "size:L", color: null }] }),
    ];
    const kept = (labels: ReadonlyArray<ReadonlyArray<string>>) =>
      sized.filter((row) => matchesPullRequestFilters(row, { labels })).map((row) => row.number);

    expect(kept([["size:S", "size:XS"]])).toEqual([10, 11]);
    expect(kept([["size:XXL"]])).toEqual([]);
  });

  it("takes two groups as an and, each satisfied on its own", () => {
    const row = entry({
      number: 20,
      labels: [
        { name: "size:S", color: null },
        { name: "bug", color: null },
      ],
    });
    expect(matchesPullRequestFilters(row, { labels: [["size:S", "size:XS"], ["bug"]] })).toBe(true);
    // The second group holds nothing this row carries, so the first one satisfied is not enough.
    expect(matchesPullRequestFilters(row, { labels: [["size:S"], ["wip"]] })).toBe(false);
  });

  it("holds on to every row for a filter no row carries the answer to", () => {
    expect(narrow({ checks: "passing" })).toEqual([1, 2, 3, 4]);
  });
});

describe("reading qualifiers out of a typed query", () => {
  it("keeps quoted values whole and separates negation", () => {
    expect(parsePullRequestQuery('label:"needs design" -label:wip Fix the parser')).toEqual({
      text: "Fix the parser",
      filters: { labels: [["needs design"]], excludedLabels: ["wip"] },
    });
  });

  it("reads a comma-separated list as one group either name satisfies", () => {
    expect(parsePullRequestQuery("label:size:S,size:XS").filters.labels).toEqual([
      ["size:S", "size:XS"],
    ]);
  });

  it("keeps the spaces in a quoted name of a list, and drops an empty part", () => {
    expect(parsePullRequestQuery('label:"needs design","wip"').filters.labels).toEqual([
      ["needs design", "wip"],
    ]);
    expect(parsePullRequestQuery("label:a,,b").filters.labels).toEqual([["a", "b"]]);
  });

  it("excludes every name of a negated list", () => {
    expect(parsePullRequestQuery("-label:a,b").filters).toEqual({ excludedLabels: ["a", "b"] });
  });

  it("makes each label qualifier its own group, so the groups are an AND", () => {
    expect(parsePullRequestQuery("label:bug label:a,b").filters.labels).toEqual([
      ["bug"],
      ["a", "b"],
    ]);
  });

  it("reads the scalar qualifiers in GitHub's own spelling", () => {
    expect(
      parsePullRequestQuery("author:octocat DRAFT:false review:changes_requested status:failure")
        .filters,
    ).toEqual({
      author: "octocat",
      draft: "hide",
      review: "changes-requested",
      checks: "failing",
    });
  });

  it("leaves an unknown value and a stray colon as text, and reads an unknown key as a label", () => {
    const parsed = parsePullRequestQuery("milestone:v2 draft:maybe status: parser");
    expect(parsed.filters).toEqual({ labels: [["milestone:v2"]] });
    // A known key whose value it does not take is text, so "status:" itself stays findable.
    expect(parsed.text).toBe("draft:maybe status: parser");
  });

  it("reads a quoted name holding a comma as the one label it is", () => {
    expect(parsePullRequestQuery('label:"needs,triage"').filters.labels).toEqual([
      ["needs,triage"],
    ]);
    expect(parsePullRequestQuery('-label:"needs,triage"').filters.excludedLabels).toEqual([
      "needs,triage",
    ]);
  });

  it("cuts a typed query back to what the contract carries", () => {
    const many = Array.from({ length: 14 }, (_, index) => `l${index}`).join(",");
    const long = "x".repeat(240);
    const parsed = parsePullRequestQuery(`label:${many} label:${long} author:${long}`);
    expect(parsed.filters.labels?.[0]).toHaveLength(10);
    expect(parsed.filters.labels?.[1]).toEqual(["x".repeat(200)]);
    expect(parsed.filters.author).toBe("x".repeat(200));
  });

  it("cuts a namespaced label after its key is prefixed on", () => {
    const parsed = parsePullRequestQuery(`size:${"x".repeat(240)}`);
    expect(parsed.filters.labels).toEqual([[`size:${"x".repeat(240)}`.slice(0, 200)]]);
  });

  it("answers an empty query with an empty everything", () => {
    expect(parsePullRequestQuery("   ")).toEqual({ text: "", filters: {} });
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

describe("default merge-readiness ranking", () => {
  it("puts ready work first, finished work after open work, and every conflict last", () => {
    const conflict = entry({
      number: 1,
      mergeability: "conflicting",
      checksState: "passing",
      reviewDecision: "approved",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    const other = entry({
      number: 2,
      checksState: "pending",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const green = entry({
      number: 3,
      checksState: "passing",
      reviewDecision: "review-required",
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const approved = entry({
      number: 4,
      checksState: "passing",
      reviewDecision: "approved",
      additions: 1_000,
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const draft = entry({
      number: 5,
      isDraft: true,
      checksState: "passing",
      reviewDecision: "approved",
      updatedAt: "2026-09-02T00:00:00Z",
    });
    const finished = entry({
      number: 6,
      state: "merged",
      checksState: "passing",
      reviewDecision: "approved",
      updatedAt: "2026-09-03T00:00:00Z",
    });

    expect(
      rankPullRequestsByMergeReadiness([conflict, other, green, approved, draft, finished]).map(
        (row) => row.number,
      ),
    ).toEqual([4, 3, 5, 2, 6, 1]);
  });

  it("uses recency when readiness and diff size tie", () => {
    const older = entry({ number: 1, checksState: "passing" });
    const newer = entry({
      number: 2,
      checksState: "passing",
      updatedAt: "2026-08-01T00:00:00Z",
    });

    expect(rankPullRequestsByMergeReadiness([older, newer]).map((row) => row.number)).toEqual([
      2, 1,
    ]);
  });

  it("ranks smaller measured diffs first within a readiness tier as counts arrive", () => {
    const larger = entry({
      number: 1,
      checksState: "passing",
      reviewDecision: "approved",
      additions: 1,
      deletions: 49,
      updatedAt: "2026-09-01T00:00:00Z",
    });
    const smaller = entry({
      number: 2,
      checksState: "passing",
      reviewDecision: "approved",
      additions: 3,
      deletions: 2,
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const unknown = entry({
      number: 3,
      checksState: "passing",
      reviewDecision: "approved",
      additions: 0,
      deletions: 0,
      updatedAt: "2026-09-02T00:00:00Z",
    });

    expect(
      rankPullRequestsByMergeReadiness([larger, unknown, smaller]).map((row) => row.number),
    ).toEqual([2, 1, 3]);
    expect(
      rankPullRequestsByMergeReadiness([
        larger,
        { ...unknown, additions: 1, deletions: 0 },
        smaller,
      ]).map((row) => row.number),
    ).toEqual([3, 2, 1]);
  });

  it("distinguishes measured empty diffs from missing counts when sorting groups", () => {
    const unknown = entry({ number: 1, additions: 0, deletions: 0 });
    const measured = entry({ number: 2 });
    const empty = entry({ number: 3, additions: 0, deletions: 0 });
    const groups = [
      { key: "others", label: "Others", entries: [unknown, measured, empty] },
    ] as const;

    const sorted = sortPullRequestGroups(groups, "ready", "", (row) => row.number !== 1);

    expect(sorted[0]!.entries.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(sortPullRequestGroups(groups, "ready", "sidebar", (row) => row.number !== 1)).toEqual(
      groups,
    );
  });

  it("keeps authored work first and ranks each group by readiness", () => {
    const authoredWaiting = entry({ number: 1, checksState: "pending" });
    const authoredReady = entry({
      number: 2,
      checksState: "passing",
      reviewDecision: "approved",
    });
    const otherReady = entry({
      number: 3,
      checksState: "passing",
      reviewDecision: "approved",
    });
    const sorted = sortPullRequestGroups(
      [
        { key: "authored", label: "Authored", entries: [authoredWaiting, authoredReady] },
        { key: "others", label: "Others", entries: [otherReady] },
      ],
      "ready",
      "",
    );

    expect(sorted.map((group) => group.key)).toEqual(["authored", "others"]);
    expect(sorted.flatMap((group) => group.entries).map((row) => row.number)).toEqual([2, 1, 3]);
  });

  it.each([
    ["updated", [1, 2]],
    ["newest", [2, 1]],
    ["oldest", [1, 2]],
    ["largest", [1, 2]],
    ["smallest", [2, 1]],
  ] as const)("keeps authored first while applying the %s sort inside groups", (sort, order) => {
    const olderLarger = entry({
      number: 1,
      additions: 20,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const newerSmaller = entry({
      number: 2,
      additions: 2,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const sorted = sortPullRequestGroups(
      [
        { key: "authored", label: "Authored", entries: [olderLarger, newerSmaller] },
        { key: "others", label: "Others", entries: [entry({ number: 3 })] },
      ],
      sort,
      "",
    );

    expect(sorted.map((group) => group.key)).toEqual(["authored", "others"]);
    expect(sorted[0]!.entries.map((row) => row.number)).toEqual(order);
  });
});

describe("line counts that arrive after the rows", () => {
  const stats = new Map([["env-1 project-1 7", { additions: 42, deletions: 3 }]]);

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
      { environmentId: "env-1", projectId: "project-1", number: 1, additions: 10, deletions: 2 },
      { environmentId: "env-1", projectId: "project-1", number: 2, additions: 5, deletions: 1 },
    ]);
    // A third row appeared; its batch is still pending and contributes nothing yet.
    const merged = mergePullRequestDiffStats(held, []);
    expect(merged.get("env-1 project-1 1")).toEqual({ additions: 10, deletions: 2 });
    expect(merged.get("env-1 project-1 2")).toEqual({ additions: 5, deletions: 1 });
  });

  it("replaces a count once its replacement arrives, keeping its neighbours", () => {
    const held = mergePullRequestDiffStats(new Map(), [
      { environmentId: "env-1", projectId: "project-1", number: 1, additions: 10, deletions: 2 },
    ]);
    const merged = mergePullRequestDiffStats(held, [
      { environmentId: "env-1", projectId: "project-1", number: 1, additions: 11, deletions: 2 },
      { environmentId: "env-1", projectId: "project-1", number: 3, additions: 7, deletions: 0 },
    ]);
    expect(merged.get("env-1 project-1 1")).toEqual({ additions: 11, deletions: 2 });
    expect(merged.get("env-1 project-1 3")).toEqual({ additions: 7, deletions: 0 });
  });

  it("does not mutate the map it was handed", () => {
    const held = new Map([["env-1 project-1 1", { additions: 1, deletions: 1 }]]);
    mergePullRequestDiffStats(held, [
      { environmentId: "env-1", projectId: "project-1", number: 1, additions: 2, deletions: 2 },
    ]);
    expect(held.get("env-1 project-1 1")).toEqual({ additions: 1, deletions: 1 });
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
    expect(groups.map((group) => group.key)).toEqual(["authored", "reviewRequested"]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([1]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([2, 3]);
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

  it("caps the accumulated rows but keeps the whole host set", () => {
    // The page keeps growing as the reader scrolls, so what gets written is the accumulated
    // list rather than one round's answer — capped at the one page a cold start needs, while
    // the hosts it was read from (which do not grow with the page) are kept in full.
    const storage = makeStorage();
    const manyEntries = Array.from({ length: 120 }, (_, index) => entry({ number: index + 1 }));
    const viewers = { "github.com": "Bilal", "gitlab.com": "Bilal" };
    const providers = [
      {
        host: "github.com",
        kind: "github",
        searchesOnHost: true,
        projectCount: 1,
        configured: true,
        detail: null,
      },
      {
        host: "gitlab.com",
        kind: "gitlab",
        searchesOnHost: true,
        projectCount: 1,
        configured: true,
        detail: null,
      },
    ];
    const accumulated = {
      entries: manyEntries,
      viewers,
      providers,
      errors: [],
      truncated: true,
      nextCursors: {},
    } as never;
    writePullRequestListSnapshot(storage, "env-1", { scope: "s", data: accumulated });
    const snapshot = readPullRequestListSnapshot(storage, "env-1");
    expect(snapshot?.data.entries).toHaveLength(99);
    expect(snapshot?.data.viewers).toEqual(viewers);
    expect(snapshot?.data.providers).toEqual(providers);
  });
});

describe("remembered pull request list controls", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  };

  it("restores every filter and the selected sort", () => {
    const storage = makeStorage();
    const preferences = {
      involvement: "reviewing",
      state: "merged",
      environmentId: "env-1" as EnvironmentId,
      projectId: "project-1" as ProjectId,
      host: "github.com",
      q: "workflow",
      draft: "hide",
      review: "approved",
      checks: "passing",
      author: "octocat",
      labels: ["bug", "priority"],
      sort: "largest",
    } as const;

    writePullRequestListPreferences(preferences, storage);
    expect(readPullRequestListPreferences(storage)).toEqual(preferences);
  });

  it("omits the default sort from storage", () => {
    expect(
      pullRequestListPreferences({
        involvement: "all",
        state: "open",
        sort: "ready",
      }),
    ).toEqual({ involvement: "all", state: "open" });
  });

  it("keeps an explicit recency sort", () => {
    expect(
      pullRequestListPreferences({ involvement: "all", state: "open", sort: "updated" }),
    ).toEqual({ involvement: "all", state: "open", sort: "updated" });
  });

  it("falls back to the default controls when storage is corrupt", () => {
    const storage = makeStorage();
    storage.setItem("t3.pullRequests.preferences", "{not json");
    expect(readPullRequestListPreferences(storage)).toEqual({ involvement: "all", state: "open" });
  });

  it("falls back when browser policy denies storage", () => {
    const denied = {
      getItem: () => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("storage denied");
      },
    };
    expect(readPullRequestListPreferences(denied)).toEqual({ involvement: "all", state: "open" });
    expect(() =>
      writePullRequestListPreferences({ involvement: "all", state: "open" }, denied),
    ).not.toThrow();
  });
});

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;

describe("merging the environments' own listings", () => {
  const answer = (
    overrides: Partial<Parameters<typeof mergePullRequestLists>[0][number][1]> = {},
  ) =>
    ({
      viewers: { "github.com": "Bilal" },
      providers: [
        {
          host: "github.com",
          kind: "github",
          searchesOnHost: true,
          projectCount: 1,
          configured: true,
          detail: null,
        },
      ],
      entries: [],
      errors: [],
      truncated: false,
      nextCursors: {},
      ...overrides,
    }) as Parameters<typeof mergePullRequestLists>[0][number][1];

  it("answers nothing until an environment has", () => {
    expect(mergePullRequestLists([])).toBeNull();
  });

  it("tags every row with the environment that read it, newest first", () => {
    const merged = mergePullRequestLists([
      [ENV_1, answer({ entries: [entry({ number: 1, updatedAt: "2026-07-01T00:00:00Z" })] })],
      [ENV_2, answer({ entries: [entry({ number: 2, updatedAt: "2026-08-01T00:00:00Z" })] })],
    ]);
    expect(merged?.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [ENV_2, 2],
      [ENV_1, 1],
    ]);
  });

  it("tells two environments' copies of one pull request apart", () => {
    const row = entry({ number: 4 });
    expect(pullRequestEntryKey({ ...row, environmentId: ENV_1 })).not.toBe(
      pullRequestEntryKey({ ...row, environmentId: ENV_2 }),
    );
  });

  it("keeps project errors scoped to the environment that reported them", () => {
    const error = {
      projectId: "project-1" as ProjectId,
      projectTitle: "Web",
      message: "Not signed in",
    } as const;
    const merged = mergePullRequestLists([
      [ENV_1, answer({ errors: [error] })],
      [ENV_2, answer()],
    ]);

    expect(merged?.errors).toEqual([{ ...error, environmentId: ENV_1 }]);
  });

  it("folds a host reached from two environments into one switcher row", () => {
    const merged = mergePullRequestLists([
      [ENV_1, answer()],
      [
        ENV_2,
        answer({
          providers: [
            {
              host: "github.com",
              kind: "github",
              searchesOnHost: false,
              projectCount: 2,
              configured: false,
              detail: "Not signed in.",
            },
          ],
        }),
      ],
    ]);
    // Readable because one environment could read it, but narrowed locally because the other
    // answers unsearched.
    expect(merged?.providers).toEqual([
      {
        host: "github.com",
        kind: "github",
        searchesOnHost: false,
        projectCount: 3,
        configured: true,
        detail: null,
      },
    ]);
  });

  it("keeps each environment's continuation to itself", () => {
    const merged = mergePullRequestLists([
      [ENV_1, answer({ nextCursors: { "github.com pingdotgg/t3code": "cursor-1" } })],
      [ENV_2, answer()],
    ]);
    expect(merged?.nextCursors).toEqual({
      [ENV_1]: { "github.com pingdotgg/t3code": "cursor-1" },
    });
  });

  it("reads the same key whichever order the environments connected in", () => {
    expect(pullRequestEnvironmentSetKey(["env-2", "env-1"])).toBe(
      pullRequestEnvironmentSetKey(["env-1", "env-2"]),
    );
  });
});

describe('who "I" am, per server', () => {
  const answer = (viewers: Record<string, string>, entries: ReadonlyArray<PullRequestListEntry>) =>
    ({
      viewers,
      providers: [],
      entries,
      errors: [],
      truncated: false,
      nextCursors: {},
    }) as Parameters<typeof mergePullRequestLists>[0][number][1];
  const byBilal = { login: "Bilal", name: null, avatarUrl: null };

  it("does not let one server's account decide who authored another server's rows", () => {
    // Both servers reach github.com, signed in as different people. Folded into one host-keyed
    // record, whichever answered last spoke for both — and every row of the reader's own work
    // was filed under Others.
    const merged = mergePullRequestLists([
      [ENV_1, answer({ "github.com": "Bilal" }, [entry({ number: 1, author: byBilal })])],
      [ENV_2, answer({ "github.com": "Octocat" }, [entry({ number: 2, author: byBilal })])],
    ])!;

    const groups = groupPullRequestsByInvolvement(merged.entries, merged.viewers);
    expect(
      groups.find((group) => group.key === "authored")?.entries.map((row) => row.number),
    ).toEqual([1]);
    expect(
      filterPullRequestsByInvolvement(merged.entries, merged.viewers, "authored").map(
        (row) => row.number,
      ),
    ).toEqual([1]);
  });

  it("still reads a single server's host-keyed viewers, which is what a snapshot carries", () => {
    expect(
      filterPullRequestsByInvolvement(
        [entry({ number: 1, author: byBilal })],
        { "github.com": "Bilal" },
        "authored",
      ).map((row) => row.number),
    ).toEqual([1]);
  });

  it("names the servers with more rows and no cursor to reach them by", () => {
    const merged = mergePullRequestLists([
      [
        ENV_1,
        { ...answer({}, []), truncated: true, nextCursors: { "github.com acme/web": "cursor-1" } },
      ],
      [ENV_2, { ...answer({}, []), truncated: true }],
    ])!;

    expect(merged.truncatedEnvironments).toEqual([ENV_1, ENV_2]);
    expect(Object.keys(merged.nextCursors)).toEqual([ENV_1]);
  });
});

describe("the project an id names", () => {
  const projects = [
    { id: "project-1", environmentId: ENV_1 },
    { id: "project-1", environmentId: ENV_2 },
    { id: "project-2", environmentId: ENV_2 },
  ];

  it("takes the server it was given", () => {
    expect(findScopedProject(projects, ENV_2, "project-1")?.environmentId).toBe(ENV_2);
  });

  it("answers a bare id only where one server has it", () => {
    expect(findScopedProject(projects, null, "project-2")?.environmentId).toBe(ENV_2);
    // Two servers hold this id: narrowing to either would be a coin toss the reader cannot see.
    expect(findScopedProject(projects, null, "project-1")).toBeUndefined();
  });

  it("answers nothing for a server that does not have it", () => {
    expect(findScopedProject(projects, ENV_1, "project-2")).toBeUndefined();
  });
});

describe("which environments a listing should ask", () => {
  const ENV_3 = "env-3" as EnvironmentId;
  const environmentIds = [ENV_1, ENV_2, ENV_3];

  it("asks only the owning server once the project is unambiguous", () => {
    const projects = [{ id: "project-1", environmentId: ENV_2 }];
    expect(
      resolveQueryEnvironmentIds(
        environmentIds,
        projects,
        { environmentId: ENV_2 },
        "project-1",
        true,
      ),
    ).toEqual([ENV_2]);
  });

  it("asks every environment when there is no project narrowing at all", () => {
    expect(resolveQueryEnvironmentIds(environmentIds, [], undefined, undefined, true)).toEqual(
      environmentIds,
    );
  });

  it("asks only the environments that actually hold an ambiguous bare id, never a third that doesn't", () => {
    const projects = [
      { id: "project-1", environmentId: ENV_1 },
      { id: "project-1", environmentId: ENV_2 },
    ];
    // Two servers can genuinely hold the same project id string; the third holds no such project
    // and asking it would return an unrelated project's rows rather than an honest empty answer.
    expect(
      resolveQueryEnvironmentIds(environmentIds, projects, undefined, "project-1", true),
    ).toEqual([ENV_1, ENV_2]);
  });

  it("asks nothing for a bare id no environment holds", () => {
    const projects = [{ id: "project-1", environmentId: ENV_1 }];
    expect(
      resolveQueryEnvironmentIds(environmentIds, projects, undefined, "project-9", true),
    ).toEqual([]);
  });

  it("asks every environment while the servers have not said what they hold yet", () => {
    // Nothing matches the id because nothing has been read yet, which is not the same answer as
    // no server holding it: reading none of them would show an empty page for a project that is
    // there.
    expect(resolveQueryEnvironmentIds(environmentIds, [], undefined, "project-1", false)).toEqual(
      environmentIds,
    );
  });

  it("keeps the single-environment case unchanged", () => {
    const projects = [{ id: "project-1", environmentId: ENV_1 }];
    expect(resolveQueryEnvironmentIds([ENV_1], projects, undefined, "project-1", true)).toEqual([
      ENV_1,
    ]);
  });
});

describe("the server a saved selection names", () => {
  const known = new Set([ENV_1, ENV_2]);

  it("resolves to nothing yet for a server that is known but not ready, rather than falling back", () => {
    // ENV_2 is in the catalog (still connecting, say) but not the fallback; a caller that then
    // looks a project up under ENV_2 finds none rather than one belonging to the fallback server.
    expect(resolveSelectedEnvironmentId(ENV_2, known, ENV_1)).toBe(ENV_2);
  });

  it("falls back for a server the workspace genuinely no longer has", () => {
    const goneServer = "env-gone" as EnvironmentId;
    expect(resolveSelectedEnvironmentId(goneServer, known, ENV_1)).toBe(ENV_1);
  });

  it("falls back to nothing when no server names a fallback either", () => {
    const goneServer = "env-gone" as EnvironmentId;
    expect(resolveSelectedEnvironmentId(goneServer, known, null)).toBeNull();
  });

  it("uses the fallback outright when nothing was named", () => {
    expect(resolveSelectedEnvironmentId(undefined, known, ENV_1)).toBe(ENV_1);
    expect(resolveSelectedEnvironmentId(undefined, known, null)).toBeNull();
  });
});

describe("colon-namespaced labels typed as a search", () => {
  it("reads an unknown key as the label it almost always is", () => {
    expect(parsePullRequestQuery("size:XXL").filters.labels).toEqual([["size:XXL"]]);
    expect(parsePullRequestQuery("vouch:trusted").filters.labels).toEqual([["vouch:trusted"]]);
    expect(parsePullRequestQuery("size:XXL").text).toBe("");
  });

  it("reads the key as the namespace of every bare name in its list", () => {
    expect(parsePullRequestQuery("size:S,XS").filters.labels).toEqual([["size:S", "size:XS"]]);
  });

  it("leaves a name that already carries its own namespace alone", () => {
    // `size:S,size:XS` is the same pair written out; prefixing again would ask for `size:size:XS`.
    expect(parsePullRequestQuery("size:S,size:XS").filters.labels).toEqual([["size:S", "size:XS"]]);
  });

  it("excludes one the same way", () => {
    expect(parsePullRequestQuery("-size:XXL").filters.excludedLabels).toEqual(["size:XXL"]);
    expect(parsePullRequestQuery("-size:S,XS").filters.excludedLabels).toEqual([
      "size:S",
      "size:XS",
    ]);
  });

  it("keeps a quoted token as text, which is the way back to a literal search", () => {
    const parsed = parsePullRequestQuery('"size:XXL"');
    expect(parsed.filters.labels).toBeUndefined();
    expect(parsed.text).toBe('"size:XXL"');
  });

  it("reads a hyphenated namespace as a label too", () => {
    expect(parsePullRequestQuery("priority-1:high").filters.labels).toEqual([["priority-1:high"]]);
    expect(parsePullRequestQuery("priority-1:high").text).toBe("");
  });

  it("leaves a pasted link alone rather than naming a label after its scheme", () => {
    const parsed = parsePullRequestQuery("https://github.com/pingdotgg/t3code/pull/1");
    expect(parsed.filters.labels).toBeUndefined();
    expect(parsed.text).toBe("https://github.com/pingdotgg/t3code/pull/1");
  });

  it("mixes with the keys it does know, and with plain words", () => {
    const parsed = parsePullRequestQuery("area:web draft:true wizard label:bug");
    expect(parsed.filters).toEqual({ labels: [["area:web"], ["bug"]], draft: "only" });
    expect(parsed.text).toBe("wizard");
  });

  it("shares the ceiling with the labels typed as labels", () => {
    const many = Array.from({ length: 12 }, (_, index) => `area:${index}`).join(" ");
    expect(parsePullRequestQuery(many).filters.labels).toHaveLength(10);
  });
});

describe("the priority groups against a paginated feed", () => {
  const authoredRow = (number: number, updatedAt: string) =>
    entry({ number, updatedAt, author: { login: "Bilal", name: null, avatarUrl: null } });

  it("shows every authored row the host reported, not only the ones the feed page holds", () => {
    // The feed is one page ordered by recency, so on a busy repository it can hold exactly one of
    // somebody's own pull requests while the rest sit further down the host's list. The Authored
    // group comes from its own server-filtered read for that reason: grouping the page instead
    // leaves the older ones under Others, or off the page altogether.
    const newest = authoredRow(6039, "2026-08-11T08:00:00Z");
    const older = [
      authoredRow(5499, "2026-08-10T17:00:00Z"),
      authoredRow(5544, "2026-08-10T16:00:00Z"),
    ];
    const feed = [newest, entry({ number: 6123, updatedAt: "2026-08-11T09:00:00Z" })];

    const groups = partitionPullRequestsWithPriority(feed, [newest, ...older], []);

    expect(
      groups.find((group) => group.key === "authored")?.entries.map((row) => row.number),
    ).toEqual([6039, 5499, 5544]);
    expect(
      groups.find((group) => group.key === "others")?.entries.map((row) => row.number),
    ).toEqual([6123]);
  });
});
