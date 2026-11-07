import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  ProjectId,
  type PullRequestSummary,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveLinkedThreadPullRequestReference,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function mergedFeaturePr(): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    baseRef: "main",
    headRef: "feature/current",
    state: "merged",
  };
}

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    state,
    headBranch: "feature/current",
    baseBranch: "main",
    updatedAt,
  };
}

describe("shared pull request state", () => {
  it("never lets a stale open response regress a merged observation", () => {
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");
    const staleOpen = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");

    expect(newestPullRequestSummary(merged, staleOpen)).toBe(merged);
  });

  it("accepts a newer open state after a closed pull request is reopened", () => {
    const closed = pullRequestSummary("closed", "2026-09-03T01:00:00.000Z");
    const reopened = pullRequestSummary("open", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(closed, reopened)).toBe(reopened);
  });
});

describe("linked pull request metadata", () => {
  const projectId = ProjectId.make("project-1");
  const current: ThreadPullRequestLink = {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number: 122,
    url: "https://github.com/pingdotgg/t3code/pull/122",
    source: "manual",
    linkedAt: "2026-10-24T00:00:00.000Z",
    snapshot: null,
    stack: null,
  };
  const snapshot: NonNullable<ThreadPullRequestLink["snapshot"]> = {
    title: "Feature PR",
    state: "open",
    headBranch: "feature/current",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-10-24T00:00:00.000Z",
    syncedAt: "2026-10-24T00:00:00.000Z",
  };

  it.each([
    {
      name: "fetches the current PR when its snapshot is missing",
      projectId,
      snapshot: null,
      expected: { projectId, host: current.host, repository: current.repository, number: 122 },
    },
    {
      name: "uses a loaded snapshot without another metadata request",
      projectId,
      snapshot,
      expected: null,
    },
    {
      name: "does not route a current PR through a missing project",
      projectId: null,
      snapshot: null,
      expected: null,
    },
  ])("$name", ({ projectId, snapshot, expected }) => {
    expect(
      resolveLinkedThreadPullRequestReference({
        current: { ...current, snapshot },
        projectId,
        supportsLinks: true,
        linkedPullRequest: {
          projectId: ProjectId.make("old-project"),
          repository: "another/repository",
          number: 99,
          url: "https://github.com/another/repository/pull/99",
        },
      }),
    ).toEqual(expected);
  });
});

describe("resolveDisplayedThreadPr", () => {
  const featureBranch = "feature/current";
  const mergedPr = mergedFeaturePr();
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };
  const provider = {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  };

  it("shows a linked pull request when the checkout has a different branch", () => {
    const input = {
      threadBranch: "feature/other",
      gitStatus: status({ refName: "feature/other", pr: null }),
      linkedPullRequest,
      linkedPullRequestStatus: { pr: mergedPr, sourceControlProvider: provider },
    };

    expect(resolveDisplayedThreadPr(input)).toEqual(mergedPr);
    expect(resolveDisplayedThreadPrProvider(input)).toEqual(provider);
  });

  it("never attaches a PR reported by main to the feature thread", () => {
    const mainPr = {
      number: 99,
      title: "Unrelated main PR",
      url: "https://github.com/pingdotgg/t3code/pull/99",
      baseRef: "develop",
      headRef: "main",
      state: "merged" as const,
    };
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
      }),
    ).toBeNull();
  });
});
