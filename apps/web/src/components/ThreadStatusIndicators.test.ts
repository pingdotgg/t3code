import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  settledPrHoverColorClass,
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
      }),
    ).toBe(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus,
        snapshot: undefined,
      }),
    ).toEqual(provider);
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
      }),
    ).toEqual(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus: mainStatus,
        snapshot: cached as ThreadChangeRequestSnapshot,
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
      }),
    ).toBeNull();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
      }),
    ).toBeUndefined();
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
      }),
    ).toEqual(closedPr);
  });

  it("rejects a snapshot stored for another branch", () => {
    const otherBranchSnapshot = snapshotFor("feature/other", mergedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: otherBranchSnapshot,
      }),
    ).toBeNull();
  });

  it("clears the snapshot when returning to the matching branch with no PR", () => {
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: featureBranch, pr: null }),
      }),
    ).toBeNull();
  });

  it("does not erase a terminal snapshot when VCS data is missing", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
      }),
    ).toEqual(mergedPr);
  });

  it("keeps effectiveSettled true for a retained merged PR after a main checkout", () => {
    const matchingStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });
    const cached = nextThreadChangeRequestSnapshot({
      threadBranch: featureBranch,
      gitStatus: matchingStatus,
    });
    expect(cached).not.toBeNull();
    expect(cached).not.toBeUndefined();

    const mainStatus = status({ refName: "main", pr: null, isDefaultRef: true });
    const displayed = resolveDisplayedThreadPr({
      threadBranch: featureBranch,
      gitStatus: mainStatus,
      snapshot: cached as ThreadChangeRequestSnapshot,
    });
    expect(displayed?.state).toBe("merged");

    const shell = {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Feature thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: featureBranch,
      worktreePath: null,
      latestTurn: null,
      session: null,
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      latestUserMessageAt: "2026-04-09T00:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } as OrchestrationThreadShell;

    expect(
      effectiveSettled(shell, {
        now: "2026-04-10T00:00:00.000Z",
        autoSettleAfterDays: null,
        changeRequestState: displayed?.state ?? null,
      }),
    ).toBe(true);
  });
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
