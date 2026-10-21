import { SourceControlProviderKind } from "@t3tools/contracts";
import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import {
  nextThreadChangeRequestSnapshot,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  threadChangeRequestSnapshotsEqual,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
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

function snapshotFor(
  branch: string,
  pr: NonNullable<VcsStatusResult["pr"]>,
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"],
): ThreadChangeRequestSnapshot {
  return { branch, pr, sourceControlProvider };
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

describe("resolveThreadPr", () => {
  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeNull();
  });
});

describe("resolveDisplayedThreadPr + nextThreadChangeRequestSnapshot", () => {
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
    const linkedPullRequestStatus = {
      pr: mergedPr,
      sourceControlProvider: provider,
    };

    expect(
      resolveDisplayedThreadPr({
        threadBranch: "feature/other",
        gitStatus: status({ refName: "feature/other", pr: null }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: false,
        linkedPullRequest,
        linkedPullRequestStatus,
      }),
    ).toEqual(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: "feature/other",
        gitStatus: status({ refName: "feature/other", pr: null }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: false,
        linkedPullRequest,
        linkedPullRequestStatus,
      }),
    ).toEqual(provider);
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: "feature/other",
        gitStatus: status({ refName: "feature/other", pr: null }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: false,
        linkedPullRequest,
        linkedPullRequestStatus,
      }),
    ).toEqual({
      branch: "feature/other",
      pr: mergedPr,
      sourceControlProvider: provider,
      linkedPullRequest,
    });
  });

  it("keeps a matching linked pull request snapshot while its status reloads", () => {
    const snapshot = {
      ...snapshotFor(featureBranch, mergedPr, provider),
      linkedPullRequest,
    };

    expect(
      resolveDisplayedThreadPr({
        threadBranch: null,
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: false,
        linkedPullRequest,
        linkedPullRequestStatus: null,
      }),
    ).toEqual(mergedPr);
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: null,
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: false,
        linkedPullRequest,
        linkedPullRequestStatus: null,
      }),
    ).toBeUndefined();
  });

  it("clears an old snapshot when a different pull request is linked", () => {
    const snapshot = {
      ...snapshotFor(featureBranch, mergedPr, provider),
      linkedPullRequest: { ...linkedPullRequest, number: 41 },
    };

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: true,
        linkedPullRequest,
        linkedPullRequestStatus: null,
      }),
    ).toBeNull();
  });

  it("removes a linked pull request snapshot after the link is cleared", () => {
    const snapshot = {
      ...snapshotFor(featureBranch, mergedPr, provider),
      linkedPullRequest,
    };

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("after caching a merged PR, resolves main status back to the cached feature PR", () => {
    const matchingStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });
    const cached = nextThreadChangeRequestSnapshot({
      threadBranch: featureBranch,
      gitStatus: matchingStatus,
      snapshot: undefined,
      retainTerminalOnBranchMismatch: true,
    });
    expect(cached).toEqual(snapshotFor(featureBranch, mergedPr, provider));

    const mainStatus = status({
      refName: "main",
      isDefaultRef: true,
      pr: {
        number: 99,
        title: "Unrelated main PR",
        url: "https://github.com/pingdotgg/t3code/pull/99",
        baseRef: "main",
        headRef: "main",
        state: "open",
      },
      sourceControlProvider: provider,
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: mainStatus,
        snapshot: cached as ThreadChangeRequestSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus: mainStatus,
        snapshot: cached as ThreadChangeRequestSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(provider);
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
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("does not show a cached open PR across a branch mismatch", () => {
    const openSnapshot = snapshotFor(featureBranch, {
      ...mergedPr,
      state: "open",
      title: "Still open",
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("retains a cached closed PR across a branch mismatch", () => {
    const closedPr = { ...mergedPr, state: "closed" as const, title: "Closed feature" };
    const closedSnapshot = snapshotFor(featureBranch, closedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: closedSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(closedPr);
  });

  it("does not retain or display a terminal PR when a worktree switches branches", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);
    const mismatchedStatus = status({ refName: "feature/other", pr: null });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeUndefined();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeNull();
  });

  it("retains a terminal snapshot when a local thread and status move to a branch with no PR", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("clears an open snapshot when a local thread moves to a branch with no PR", () => {
    const openSnapshot = snapshotFor(featureBranch, { ...mergedPr, state: "open" });

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("clears a retained snapshot when the thread branch is cleared", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
  });

  it("does not erase a terminal snapshot when VCS data is missing", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("shows the last matching PR snapshot while its live status lease is released", () => {
    const openPr = { ...mergedPr, state: "open" as const };
    const input = {
      threadBranch: featureBranch,
      gitStatus: null,
      snapshot: snapshotFor(featureBranch, openPr, provider),
      retainTerminalOnBranchMismatch: false,
    };
    expect(resolveDisplayedThreadPr(input)).toEqual(openPr);
    expect(resolveDisplayedThreadPrProvider(input)).toEqual(provider);
    expect(resolveDisplayedThreadPr({ ...input, threadBranch: "feature/other" })).toBeNull();
    expect(
      resolveDisplayedThreadPr({
        ...input,
        snapshot: { ...input.snapshot, linkedPullRequest },
      }),
    ).toBeNull();
  });

  it("refreshes a cached snapshot when a pull request becomes ready", () => {
    const readyPr = { ...mergedPr, state: "open" as const };
    const draftPr = { ...readyPr, isDraft: true };

    expect(
      threadChangeRequestSnapshotsEqual(
        snapshotFor(featureBranch, draftPr),
        snapshotFor(featureBranch, readyPr),
      ),
    ).toBe(false);
  });
});

describe("threadChangeRequestSnapshotsAtom", () => {
  it.effect("retains snapshots while sidebar and chat consumers are unmounted", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const threadKey = "environment-1:thread-1";
      const snapshot = snapshotFor("feature/current", mergedFeaturePr());

      const unmount = registry.mount(threadChangeRequestSnapshotsAtom);
      registry.set(threadChangeRequestSnapshotsAtom, new Map([[threadKey, snapshot]]));
      unmount();

      yield* Effect.yieldNow;

      const remount = registry.mount(threadChangeRequestSnapshotsAtom);
      expect(registry.get(threadChangeRequestSnapshotsAtom).get(threadKey)).toEqual(snapshot);

      remount();
      registry.dispose();
    }),
  );
});
