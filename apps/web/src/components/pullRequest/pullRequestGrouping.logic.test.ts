import {
  ProjectId,
  SourceControlProviderKind,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  poolPullRequestGroups,
  regroupPullRequests,
  slicePullRequestGroups,
} from "./pullRequestGrouping.logic";
import type { PullRequestGroup } from "./pullRequestList.logic";

const NOW = Date.parse("2026-07-20T12:00:00Z");

function entry(
  number: number,
  overrides: Partial<PullRequestListEntry> = {},
): PullRequestListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project-1"),
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    observedAt: 1,
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

const one = (entries: ReadonlyArray<PullRequestListEntry>): PullRequestGroup[] => [
  { key: "others", label: "", entries },
];
const numbers = (entries: ReadonlyArray<PullRequestListEntry>) =>
  entries.map((item) => item.number);
const keys = (groups: ReadonlyArray<{ readonly key: string }>) => groups.map((group) => group.key);

describe("regroupPullRequests", () => {
  it("restores global recency and search order when pooling involvement groups", () => {
    const groups: PullRequestGroup[] = [
      {
        key: "authored",
        label: "Authored",
        entries: [entry(1, { updatedAt: "2026-07-01T00:00:00Z", title: "exact" })],
      },
      { key: "others", label: "Others", entries: [entry(2)] },
    ];
    expect(numbers(poolPullRequestGroups(groups, "")[0]?.entries ?? [])).toEqual([2, 1]);
    expect(numbers(poolPullRequestGroups(groups.toReversed(), "exact")[0]?.entries ?? [])).toEqual([
      1, 2,
    ]);
  });
  it("keeps the involvement groups as given", () => {
    const groups: PullRequestGroup[] = [
      { key: "authored", label: "Authored", entries: [entry(1)] },
      { key: "others", label: "Others", entries: [entry(2)] },
    ];

    expect(regroupPullRequests(groups, "involvement", "none", NOW)).toEqual(groups);
  });

  it("pools everything into one unheaded group for no grouping", () => {
    const groups: PullRequestGroup[] = [
      { key: "authored", label: "Authored", entries: [entry(1)] },
      { key: "others", label: "Others", entries: [entry(2)] },
    ];

    const grouped = regroupPullRequests(groups, "none", "none", NOW);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.label).toBe("");
    expect(numbers(grouped[0]?.entries ?? [])).toEqual([1, 2]);
    expect(regroupPullRequests(groups, "none", "state", NOW)[0]?.subgroups).toBeUndefined();
  });

  it("groups by repository alphabetically and keeps the incoming order inside a group", () => {
    const grouped = regroupPullRequests(
      one([
        entry(1, { repository: "b/repo" }),
        entry(2, { repository: "a/repo" }),
        entry(3, { repository: "b/repo" }),
      ]),
      "repository",
      "none",
      NOW,
    );

    expect(grouped.map((group) => group.label)).toEqual(["a/repo", "b/repo"]);
    expect(numbers(grouped[1]?.entries ?? [])).toEqual([1, 3]);
    expect(
      regroupPullRequests(one([entry(1, { baseBranch: "Main" }), entry(2)]), "base", "none", NOW),
    ).toHaveLength(2);
  });

  it("orders states, reviews and checks by urgency rather than by name", () => {
    const states = [
      entry(1, { state: "closed" }),
      entry(2, { state: "merged" }),
      entry(3, { state: "open" }),
    ];
    expect(keys(regroupPullRequests(one(states), "state", "none", NOW))).toEqual([
      "open",
      "merged",
      "closed",
    ]);

    const reviewed = [
      entry(4),
      entry(5, { reviewDecision: "approved" }),
      entry(6, { reviewDecision: "changes-requested" }),
    ];
    expect(keys(regroupPullRequests(one(reviewed), "review", "none", NOW))).toEqual([
      "approved",
      "changes-requested",
      "none",
    ]);

    const checked = [
      entry(7, { checksState: "passing" }),
      entry(8),
      entry(9, { checksState: "failing" }),
    ];
    expect(keys(regroupPullRequests(one(checked), "checks", "none", NOW))).toEqual([
      "failing",
      "passing",
      "none",
    ]);
  });

  it("splits drafts from ready rows and merge conflicts from mergeable ones", () => {
    const rows = [entry(1, { isDraft: true }), entry(2), entry(3, { mergeability: "conflicting" })];

    expect(keys(regroupPullRequests(one(rows), "draft", "none", NOW))).toEqual(["ready", "draft"]);
    expect(keys(regroupPullRequests(one(rows), "mergeability", "none", NOW))).toEqual([
      "conflicting",
      "mergeable",
    ]);
  });

  it("buckets by age and puts an unreadable date in the oldest bucket", () => {
    const rows = [
      entry(1, { updatedAt: "2026-07-20T11:00:00Z" }),
      entry(2, { updatedAt: "2026-07-17T00:00:00Z" }),
      entry(3, { updatedAt: "2026-07-01T00:00:00Z" }),
      entry(4, { updatedAt: "2025-01-01T00:00:00Z" }),
      entry(5, { updatedAt: "not a date" }),
    ];

    const grouped = regroupPullRequests(one(rows), "updated", "none", NOW);

    expect(keys(grouped)).toEqual(["today", "week", "month", "older"]);
    expect(numbers(grouped[3]?.entries ?? [])).toEqual([4, 5]);
  });

  it("lists a row once, under its first label alphabetically, and unlabelled rows last", () => {
    const rows = [
      entry(1, {
        labels: [
          { name: "zeta", color: null },
          { name: "Beta", color: null },
        ],
      }),
      entry(2),
      entry(3, { labels: [{ name: "beta", color: null }] }),
    ];

    const grouped = regroupPullRequests(one(rows), "label", "none", NOW);

    expect(grouped.map((group) => group.label)).toEqual(["Beta", "No label"]);
    expect(numbers(grouped[0]?.entries ?? [])).toEqual([1, 3]);
    expect(grouped.flatMap((group) => group.entries)).toHaveLength(3);
  });

  it("puts rows without an author last", () => {
    const rows = [
      entry(1, { author: null }),
      entry(2, { author: { login: "ana", name: null, avatarUrl: null } }),
    ];

    expect(
      regroupPullRequests(one(rows), "author", "none", NOW).map((group) => group.label),
    ).toEqual(["ana", "Unknown author"]);
  });

  it("splits each group again for a sub-grouping and keeps every row once", () => {
    const rows = [
      entry(1, { repository: "a/repo", state: "merged" }),
      entry(2, { repository: "a/repo", state: "open" }),
      entry(3, { repository: "b/repo", state: "open" }),
      entry(4, { repository: "a/repo", state: "open" }),
    ];

    const grouped = regroupPullRequests(one(rows), "repository", "state", NOW);

    expect(grouped.map((group) => group.label)).toEqual(["a/repo", "b/repo"]);
    expect(keys(grouped[0]?.subgroups ?? [])).toEqual(["open", "merged"]);
    // A group's rows follow its sub-group order, so the list reads top to bottom as it shows.
    expect(numbers(grouped[0]?.entries ?? [])).toEqual([2, 4, 1]);
    expect(grouped.flatMap((group) => group.entries)).toHaveLength(4);
    expect(
      grouped.flatMap(
        (group) => group.subgroups?.flatMap((subgroup) => subgroup.entries) ?? group.entries,
      ),
    ).toEqual(grouped.flatMap((group) => group.entries));
    const sliced = slicePullRequestGroups(grouped, 2);
    expect(sliced).toHaveLength(1);
    expect(numbers(sliced[0]?.entries ?? [])).toEqual([2, 4]);
    expect(sliced[0]?.subgroups?.map((subgroup) => numbers(subgroup.entries))).toEqual([[2, 4]]);
    expect(
      slicePullRequestGroups(grouped, 3)[0]?.subgroups?.map((subgroup) =>
        numbers(subgroup.entries),
      ),
    ).toEqual([[2, 4], [1]]);
    expect(slicePullRequestGroups(grouped, 4)).toEqual(grouped);
    expect(slicePullRequestGroups(grouped, 0)).toEqual([]);
  });

  it("applies a sub-grouping inside each involvement group", () => {
    const groups: PullRequestGroup[] = [
      { key: "authored", label: "Authored", entries: [entry(1, { isDraft: true }), entry(2)] },
      { key: "others", label: "Others", entries: [entry(3)] },
    ];

    const grouped = regroupPullRequests(groups, "involvement", "draft", NOW);

    expect(keys(grouped)).toEqual(["authored", "others"]);
    expect(keys(grouped[0]?.subgroups ?? [])).toEqual(["ready", "draft"]);
  });

  it("ignores a sub-grouping that repeats the grouping or is involvement", () => {
    const rows = [entry(1), entry(2)];

    expect(regroupPullRequests(one(rows), "state", "state", NOW)[0]?.subgroups).toBeUndefined();
    expect(
      regroupPullRequests(one(rows), "state", "involvement", NOW)[0]?.subgroups,
    ).toBeUndefined();
  });
});
