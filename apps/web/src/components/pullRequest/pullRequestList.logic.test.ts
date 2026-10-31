import { SourceControlProviderKind } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestListEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestHostActions,
  largestPullRequestReadCount,
  pullRequestQuickActions,
  filterPullRequestsByInvolvement,
  findProjectForRepository,
  findScopedProject,
  mergePullRequestLists,
  pullRequestEntryKey,
  groupPullRequestsByInvolvement,
  pullRequestStatsBatches,
  pullRequestStatsKeysToRequest,
  pullRequestStatsRefreshBatches,
  mergePullRequestDiffStats,
  partitionPullRequestsWithPriority,
  pullRequestAuthorChoices,
  selectedPullRequestAuthor,
  pullRequestLabelChoices,
  rankPullRequestMatches,
  rankPullRequestsBlockedOnAuthor,
  rankPullRequestsByMergeReadiness,
  sortPullRequestGroups,
  resolveQueryEnvironmentIds,
  resolveSelectedEnvironmentId,
  type EnvironmentPullRequestEntry,
  applyPullRequestOverrides,
  reusePullRequestEntries,
  settlePullRequestOverrides,
} from "./pullRequestList.logic";
import {
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";

const VIEWERS = { "github.com": "Bilal" } as const;

function entry(
  overrides: Partial<EnvironmentPullRequestEntry> & Pick<PullRequestListEntry, "number">,
) {
  return {
    environmentId: "env-1",
    provider: SourceControlProviderKind.make("github"),
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
});

describe("pull request involvement filtering", () => {
  it("does not treat a matching login on another host as the viewer", () => {
    const mixed = [
      entry({ number: 1, author: { login: "Bilal", name: null, avatarUrl: null } }),
      entry({
        number: 2,
        provider: SourceControlProviderKind.make("gitlab"),
        host: "gitlab.com",
        author: { login: "Bilal", name: null, avatarUrl: null },
      }),
    ];
    expect(
      filterPullRequestsByInvolvement(mixed, VIEWERS, "authored").map((item) => item.number),
    ).toEqual([1]);
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

  // regression: #9453 authored pull requests were not prioritized
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
});

describe("blocked-on-me ranking", () => {
  it("ranks authored work by how surely it is the author's to unblock, newest first within a tier", () => {
    const conflict = entry({
      number: 1,
      mergeability: "conflicting",
      checksState: "failing",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const olderFailing = entry({
      number: 2,
      checksState: "failing",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const changesRequested = entry({
      number: 3,
      reviewDecision: "changes-requested",
      checksState: "failing",
      updatedAt: "2026-08-02T00:00:00Z",
    });
    const approved = entry({ number: 4, checksState: "passing", reviewDecision: "approved" });
    const draft = entry({ number: 5, isDraft: true, checksState: "passing" });
    const waiting = entry({ number: 6 });
    const merged = entry({ number: 7, state: "merged", updatedAt: "2026-08-01T00:00:00Z" });
    const newerClosed = entry({ number: 8, state: "closed", updatedAt: "2026-08-03T00:00:00Z" });
    const newerFailing = entry({
      number: 9,
      checksState: "failing",
      updatedAt: "2026-08-03T00:00:00Z",
    });

    expect(
      rankPullRequestsBlockedOnAuthor([
        waiting,
        merged,
        olderFailing,
        draft,
        approved,
        changesRequested,
        newerClosed,
        conflict,
        newerFailing,
      ]).map((row) => row.number),
    ).toEqual([1, 3, 9, 2, 5, 6, 4, 8, 7]);
  });
});

describe("partitioning with the hosts' own priority reads", () => {
  const authoredRow = (number: number, updatedAt: string) =>
    entry({ number, updatedAt, author: { login: "Bilal", name: null, avatarUrl: null } });

  it("keeps Others in feed order when a continuation lands an authored row already partitioned", () => {
    const older = entry({ number: 1, updatedAt: "2026-07-05T00:00:00Z" });
    const newer = entry({ number: 2, updatedAt: "2026-07-06T00:00:00Z" });
    const mine = authoredRow(3, "2026-07-04T00:00:00Z");
    const groups = partitionPullRequestsWithPriority([newer, older, mine], [mine], []);
    expect(groups.map((group) => group.key)).toEqual(["authored", "others"]);
    expect(groups[1]!.entries.map((item) => item.number)).toEqual([2, 1]);
    expect(groups[0]!.entries.map((item) => item.number)).toEqual([3]);
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
});

describe("remembered pull request list controls", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  };

  // regression: #9188 corrupt stored list controls broke the page
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

  // regression: #6490 one environment's error showed on every environment
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
              kind: SourceControlProviderKind.make("github"),
              searchesOnHost: false,
              projectCount: 2,
              configured: false,
              detail: "Not signed in.",
            },
          ],
        }),
      ],
    ]);
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
});

describe("the project an id names", () => {
  const projects = [
    { id: "project-1", environmentId: ENV_1 },
    { id: "project-1", environmentId: ENV_2 },
    { id: "project-2", environmentId: ENV_2 },
  ];

  it("answers a bare id only where one server has it", () => {
    expect(findScopedProject(projects, null, "project-2")?.environmentId).toBe(ENV_2);
    expect(findScopedProject(projects, null, "project-1")).toBeUndefined();
  });
});

describe("which environments a listing should ask", () => {
  const ENV_3 = "env-3" as EnvironmentId;
  const environmentIds = [ENV_1, ENV_2, ENV_3];

  it("asks only the environments that actually hold an ambiguous bare id, never a third that doesn't", () => {
    const projects = [
      { id: "project-1", environmentId: ENV_1 },
      { id: "project-1", environmentId: ENV_2 },
    ];
    expect(
      resolveQueryEnvironmentIds(environmentIds, projects, undefined, "project-1", true),
    ).toEqual([ENV_1, ENV_2]);
  });
});

describe("the server a saved selection names", () => {
  const known = new Set([ENV_1, ENV_2]);

  it("resolves to nothing yet for a server that is known but not ready, rather than falling back", () => {
    expect(resolveSelectedEnvironmentId(ENV_2, known, ENV_1)).toBe(ENV_2);
  });
});

describe("the priority groups against a paginated feed", () => {
  const authoredRow = (number: number, updatedAt: string) =>
    entry({ number, updatedAt, author: { login: "Bilal", name: null, avatarUrl: null } });

  it("shows every authored row the host reported, not only the ones the feed page holds", () => {
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

describe("pull request list overrides", () => {
  const entry = (number: number, state: "open" | "closed" | "merged") =>
    ({
      host: "github.com",
      repository: "pingdotgg/t3code",
      number,
      state,
      isDraft: false,
      updatedAt: "2026-07-01T00:00:00Z",
      labels: [],
    }) as unknown as PullRequestListEntry;
  const key = (row: { number: number }) => `#${row.number}`;

  it("writes the override over the row and drops it from a list whose state it left", () => {
    const rows = [entry(1, "open"), entry(2, "open")];
    const overrides = new Map([
      ["#1", { state: "closed" as const, updatedAt: "2026-07-03T00:00:00Z", token: 1, at: 0 }],
    ]);
    expect(
      applyPullRequestOverrides(rows, overrides, key, "open").map((row) => row.number),
    ).toEqual([2]);
    const all = applyPullRequestOverrides(rows, overrides, key, "all");
    expect(all.map((row) => [row.number, row.state])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    expect(applyPullRequestOverrides(rows, new Map(), key, "open")).toBe(rows);
  });

  it("keeps a confirmed close hidden when its override is cleared", () => {
    const at = 1_000_000;
    const rows = [entry(1, "closed"), entry(2, "open"), entry(3, "merged")];
    const overrides = new Map([
      ["#1", { state: "closed" as const, updatedAt: "2026-07-03T00:00:00Z", token: 1, at }],
    ]);
    const settled = settlePullRequestOverrides(overrides, rows, key, at + 5_000);
    expect(settled.size).toBe(0);
    expect(applyPullRequestOverrides(rows, settled, key, "open").map((row) => row.number)).toEqual([
      2,
    ]);
  });
});

describe("pull request list override settlement", () => {
  const entry = (number: number, state: "open" | "closed" | "merged") =>
    ({ number, state, isDraft: false, labels: [] }) as unknown as PullRequestListEntry;
  const key = (row: { number: number }) => `#${row.number}`;

  it("keeps an override until an answer agrees with it", () => {
    const at = 1_000_000;
    const closed = { state: "closed" as const, updatedAt: "2026-07-03T00:00:00Z", token: 1, at };
    const overrides = new Map([["#1", closed]]);
    expect(settlePullRequestOverrides(overrides, [entry(1, "open")], key, at + 5_000)).toBe(
      overrides,
    );
    expect(settlePullRequestOverrides(overrides, [entry(2, "open")], key, at + 5_000).size).toBe(1);
    expect(settlePullRequestOverrides(overrides, [entry(1, "closed")], key, at + 5_000).size).toBe(
      0,
    );
    expect(settlePullRequestOverrides(overrides, [entry(1, "open")], key, at + 90_000).size).toBe(
      0,
    );
  });

  it("does not hand back the old order when only the order changed", () => {
    const previous = [entry(1, "open"), entry(2, "open")];
    const swapped = reusePullRequestEntries(previous, [entry(2, "open"), entry(1, "open")], key);
    expect(swapped).not.toBe(previous);
    expect(swapped.map((row) => row.number)).toEqual([2, 1]);
  });
});

describe("pull request quick actions", () => {
  const summary = (host: string, kind: string, actions?: ReadonlyArray<PullRequestAction>) => ({
    host,
    kind: SourceControlProviderKind.make(kind),
    searchesOnHost: true,
    projectCount: 1,
    configured: true,
    detail: null,
    ...(actions === undefined ? {} : { actions }),
  });

  it("offers what each host reports, and the host's own set when a server reports none", () => {
    const actionsOf = pullRequestHostActions([
      summary("bitbucket.org", "bitbucket", ["merge", "close"]),
      summary("github.com", "github"),
      summary("gitlab.com", "gitlab"),
    ]);
    const bitbucket = actionsOf({
      host: "bitbucket.org",
      provider: SourceControlProviderKind.make("bitbucket"),
    });
    expect(pullRequestQuickActions({ state: "closed", isDraft: false }, bitbucket)).toEqual([]);
    const github = actionsOf({
      host: "github.com",
      provider: SourceControlProviderKind.make("github"),
    });
    expect(pullRequestQuickActions({ state: "open", isDraft: true }, github)).toEqual([
      "close",
      "ready",
    ]);
    const gitlab = actionsOf({
      host: "gitlab.com",
      provider: SourceControlProviderKind.make("gitlab"),
    });
    expect(pullRequestQuickActions({ state: "open", isDraft: false }, gitlab)).toEqual([]);
  });
});

describe("refresh page size", () => {
  const twoPagesAcrossFourRepositories = (provider: "github" | "gitlab") =>
    ["a", "b", "c", "d"].flatMap((name) =>
      Array.from({ length: 198 }, (_, index) =>
        entry({
          number: index + 1,
          provider: SourceControlProviderKind.make(provider),
          repository: `pingdotgg/${name}`,
        }),
      ),
    );

  it("asks each repository for its own rows where repositories are read one at a time", () => {
    expect(largestPullRequestReadCount(twoPagesAcrossFourRepositories("gitlab"))).toBe(198);
  });

  // regression: #19403 refreshes were not bounded by each tracker read
  it("asks for the whole host where one search reads every repository", () => {
    expect(largestPullRequestReadCount(twoPagesAcrossFourRepositories("github"))).toBe(792);
  });
});

describe("findProjectForRepository", () => {
  it("resolves Azure bare names using matching project and environment scope", () => {
    const azure = (id: string, environmentId: string, path: string) => ({
      id,
      environmentId,
      repositoryIdentity: {
        canonicalKey: `dev.azure.com/${path}`,
        locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "" },
        provider: SourceControlProviderKind.make("azure-devops"),
        displayName: path,
        owner: "contoso",
        name: path.split("/").at(-1)!,
      },
    });
    const payments = azure("p1", ENV_1, "contoso/payments/_git/api");
    const billing = azure("p2", ENV_1, "contoso/billing/_git/api");
    const remoteBilling = azure("p2", ENV_2, "contoso/billing/_git/api");
    const unrelated = azure("p3", ENV_2, "contoso/billing/_git/web");
    const projects = [payments, billing, remoteBilling, unrelated];

    expect(findProjectForRepository(projects, { repository: "api" })).toBe(payments);
    expect(
      findProjectForRepository(projects, {
        repository: "api",
        scopedProjectId: "p2",
        scopedEnvironmentId: ENV_2,
      }),
    ).toBe(remoteBilling);
    expect(
      findProjectForRepository(projects, {
        repository: "api",
        scopedProjectId: "p3",
        scopedEnvironmentId: ENV_2,
      }),
    ).toBe(payments);
  });

  it("keeps repository matches on the selected environment when project IDs overlap", () => {
    const project = (id: string, environmentId: string, repository: string) => ({
      id,
      environmentId,
      repositoryIdentity: {
        canonicalKey: `github.com/${repository}`,
        locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "" },
        provider: SourceControlProviderKind.make("github"),
        displayName: repository,
      },
    });
    const unrelated = project("p1", ENV_1, "acme/web");
    const local = project("p2", ENV_1, "acme/api");
    const remote = project("p1", ENV_2, "acme/api");
    const projects = [unrelated, local, remote];

    expect(findProjectForRepository(projects, { repository: "acme/api" })).toBe(local);
    expect(
      findProjectForRepository(projects, {
        repository: "acme/api",
        selectedEnvironmentId: ENV_2,
      }),
    ).toBe(remote);
    expect(
      findProjectForRepository(projects, {
        repository: "acme/web",
        selectedEnvironmentId: ENV_2,
      }),
    ).toBeUndefined();
    expect(
      findProjectForRepository(projects, {
        repository: "acme/api",
        selectedEnvironmentId: "env-connecting",
      }),
    ).toBeUndefined();
  });
});

describe("filter picker choices", () => {
  const actor = (login: string, name: string | null = null) => ({ login, name, avatarUrl: null });

  it("offers authors the host found that no loaded row carries, after the loaded ones", () => {
    const loaded = [
      { actor: actor("julius", "Julius"), count: 4, mergedCount: 3 },
      { actor: actor("theo"), count: 1, mergedCount: 0 },
    ];

    const choices = pullRequestAuthorChoices(
      loaded,
      [actor("Julius"), actor("juliana", "Juliana")],
      "jul",
    );

    expect(choices.map((choice) => [choice.actor.login, choice.count])).toEqual([
      ["julius", 4],
      ["juliana", 0],
    ]);
  });

  it("keeps showing an author picked from the host's search once the search clears", () => {
    const loaded = [{ actor: actor("julius"), count: 4, mergedCount: 3 }];
    const hosted = [actor("Juliana", "Juliana")];

    expect(selectedPullRequestAuthor(loaded, hosted, "juliana")?.actor).toEqual(
      actor("Juliana", "Juliana"),
    );
    expect(selectedPullRequestAuthor(loaded, [], "juliana")?.actor.login).toBe("juliana");
    expect(selectedPullRequestAuthor(loaded, hosted, "JULIUS")?.count).toBe(4);
    expect(selectedPullRequestAuthor(loaded, hosted, undefined)).toBeUndefined();
  });

  it("puts the host's authors after the first loaded matches rather than after all of them", () => {
    const loaded = Array.from({ length: 40 }, (_, index) => ({
      actor: actor(`dev-${index}`),
      count: 1,
      mergedCount: 0,
    }));

    const choices = pullRequestAuthorChoices(loaded, [actor("dev-from-host")], "dev");

    expect(choices.slice(0, 30).map((choice) => choice.actor.login)).toContain("dev-from-host");
  });

  it("keeps a loaded label's count when only the host's search found it", () => {
    const loaded = [{ name: "size:XL", color: "d93f0b", count: 7 }];

    const choices = pullRequestLabelChoices(
      loaded,
      [
        { name: "size:XL", color: "d93f0b" },
        { name: "bug", color: null },
      ],
      "xl-ish",
    );

    expect(choices).toEqual([
      { name: "size:XL", color: "d93f0b", count: 7 },
      { name: "bug", color: null, count: 0 },
    ]);
  });
});
