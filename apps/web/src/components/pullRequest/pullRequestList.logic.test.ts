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
import { ENV_1, entry } from "./pullRequestList.logic.testkit";
const VIEWERS = { "github.com": "Bilal" } as const;

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
