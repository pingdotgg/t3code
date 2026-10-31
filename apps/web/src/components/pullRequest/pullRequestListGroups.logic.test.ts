import { SourceControlProviderKind } from "@t3tools/contracts";
import type { PullRequestListEntry, PullRequestListResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { pullRequestGroups } from "./pullRequestListGroups.logic";

const VIEWERS = { "github.com": "Bilal" } as const;

const GITHUB: PullRequestListResult["providers"][number] = {
  host: "github.com",
  kind: SourceControlProviderKind.make("github"),
  searchesOnHost: true,
  projectCount: 1,
  configured: true,
  detail: null,
};

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

describe("pullRequestGroups text search", () => {
  it("keeps loaded rows that match the text locally when the host search misses them", () => {
    const toast = entry({ number: 26895, title: "Threads show a completed toast" });
    const toastFixture = entry({ number: 26897, title: "Toast fixtures cover retries" });
    const cursor = entry({ number: 26908, title: "Cursor no longer adds attribution" });
    const hostOnly = entry({ number: 26777, title: "Notifications match the body text" });

    const { entries } = pullRequestGroups({
      // GitHub matches whole tokens, so its answer for "toa" omits the "Toast fixtures" row.
      known: [toast, hostOnly],
      baseline: [toast, toastFixture, cursor],
      providers: [GITHUB],
      viewers: VIEWERS,
      involvement: "all",
      localFilters: {},
      hasLocalFilters: false,
      text: "toa",
      answeredLocally: true,
      baselineEmpty: false,
      held: undefined,
      authored: undefined,
      reviewing: undefined,
      partitionsWanted: false,
    });

    expect(entries.map((row) => row.number).toSorted((left, right) => left - right)).toEqual([
      26777, 26895, 26897,
    ]);
  });

  it("lists loaded matches after the host's answer, narrowed by the typed filters", () => {
    const hosted = entry({
      number: 1,
      title: "Toast",
      author: { login: "bilal", name: null, avatarUrl: null },
    });
    const mine = entry({
      number: 2,
      title: "Toaster",
      author: { login: "bilal", name: null, avatarUrl: null },
    });
    const theirs = entry({ number: 3, title: "Toasted" });

    const { entries } = pullRequestGroups({
      known: [hosted],
      baseline: [theirs, mine, hosted],
      providers: [GITHUB],
      viewers: VIEWERS,
      involvement: "all",
      localFilters: { author: "bilal" },
      hasLocalFilters: true,
      text: "toa",
      answeredLocally: true,
      baselineEmpty: false,
      held: undefined,
      authored: undefined,
      reviewing: undefined,
      partitionsWanted: false,
    });

    expect(entries.map((row) => row.number)).toEqual([1, 2]);
  });
});
