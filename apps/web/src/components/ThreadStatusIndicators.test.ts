import { SourceControlProviderKind } from "@t3tools/contracts";
import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
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
