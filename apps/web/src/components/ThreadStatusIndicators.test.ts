import { ProjectId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  settledPrHoverColorClass,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
} from "./ThreadStatusIndicators";

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

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when thread branch metadata is missing", () => {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("shows the PR when the live checkout matches the stored thread branch", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus,
      }),
    ).toBe(gitStatus.pr);
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
    kind: "github" as const,
    name: "GitHub",
    baseUrl: "https://github.com",
  };

  it("returns the live merged PR when the checkout matches the feature branch", () => {
    const gitStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus,
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBe(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus,
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(provider);
  });

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

  it("retains a local terminal snapshot when thread metadata follows the new branch", () => {
    const otherBranchSnapshot = snapshotFor("feature/other", mergedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: otherBranchSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
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

  it("clears an open snapshot when a local checkout moves to a different branch", () => {
    const openSnapshot = snapshotFor(featureBranch, { ...mergedPr, state: "open" });

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
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

  it("retains a merged PR after a main checkout", () => {
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
    expect(cached).not.toBeNull();
    expect(cached).not.toBeUndefined();

    const mainStatus = status({ refName: "main", pr: null, isDefaultRef: true });
    const displayed = resolveDisplayedThreadPr({
      threadBranch: "main",
      gitStatus: mainStatus,
      snapshot: cached as ThreadChangeRequestSnapshot,
      retainTerminalOnBranchMismatch: true,
    });
    expect(displayed?.state).toBe("merged");
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

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });
});
