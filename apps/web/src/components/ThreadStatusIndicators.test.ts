import { EnvironmentId, type VcsStatusAccumulatedResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeThreadPrLifecycleSnapshot,
  prStatusIndicator,
  resolveThreadPr,
  resolveThreadPrLifecycleState,
  resolveVisibleVcsStatusTarget,
  settledPrHoverColorClass,
  threadPrLifecycleSnapshot,
  threadPrLifecycleTargetKey,
  type ThreadPrLifecycleSnapshot,
} from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("env-1");
const targetKeyA = threadPrLifecycleTargetKey({ environmentId, cwd: "/repo-a" });
const targetKeyB = threadPrLifecycleTargetKey({ environmentId, cwd: "/repo-b" });
if (targetKeyA === null || targetKeyB === null) throw new Error("Expected lifecycle target keys");

function status(overrides: Partial<VcsStatusAccumulatedResult> = {}): VcsStatusAccumulatedResult {
  return {
    isRepo: true,
    remoteStatusKnown: true,
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

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
      }),
    ).toBeUndefined();
  });

  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeUndefined();
  });

  it("treats missing thread branch metadata as a known PR absence", () => {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("treats a non-repository snapshot as a known PR absence", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus: status({ isRepo: false, remoteStatusKnown: false, pr: null }),
      }),
    ).toBeNull();
  });

  it("leaves PR lifecycle state untouched while remote status is unknown", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus: status({ remoteStatusKnown: false }),
      }),
    ).toBeUndefined();
  });

  it("reports a known absence only for the matching observed branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus: status({ pr: null }),
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

describe("resolveVisibleVcsStatusTarget", () => {
  it("releases a row status target while its containing sidebar is hidden", () => {
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: false,
        shouldSubscribe: true,
        environmentId,
        cwd: "/repo",
      }),
    ).toBeNull();
  });

  it("retains a visible row target only when its row requires status", () => {
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: true,
        shouldSubscribe: true,
        environmentId,
        cwd: "/repo",
      }),
    ).toEqual({ environmentId, input: { cwd: "/repo" } });
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: true,
        shouldSubscribe: false,
        environmentId,
        cwd: "/repo",
      }),
    ).toBeNull();
  });
});

describe("thread PR lifecycle snapshots", () => {
  it("binds remote uncertainty to the locally observed ref", () => {
    expect(
      threadPrLifecycleSnapshot(
        status({ refName: "feature/b", remoteStatusKnown: false, pr: null }),
        targetKeyB,
      ),
    ).toEqual({ targetKey: targetKeyB, refName: "feature/b", state: undefined });
  });

  it("treats a local non-repository result as a known no-PR state", () => {
    expect(
      threadPrLifecycleSnapshot(
        status({ isRepo: false, refName: null, remoteStatusKnown: false, pr: null }),
        targetKeyA,
        "feature/a",
      ),
    ).toEqual({ targetKey: targetKeyA, refName: "feature/a", state: null });
  });

  it("invalidates a known ref A state when local status moves to ref B", () => {
    const next = mergeThreadPrLifecycleSnapshot(
      { targetKey: targetKeyA, refName: "feature/a", state: "merged" },
      { targetKey: targetKeyA, refName: "feature/b", state: undefined },
    );

    expect(next).toEqual({ targetKey: targetKeyA, refName: "feature/b", state: undefined });
    expect(resolveThreadPrLifecycleState(next, "feature/b", targetKeyA)).toBeUndefined();
  });

  it("preserves a known state through same-ref remote uncertainty", () => {
    expect(
      mergeThreadPrLifecycleSnapshot(
        { targetKey: targetKeyA, refName: "feature/a", state: "open" },
        { targetKey: targetKeyA, refName: "feature/a", state: undefined },
      ),
    ).toEqual({ targetKey: targetKeyA, refName: "feature/a", state: "open" });
  });

  it("uses a lifecycle state only when it is bound to the thread branch", () => {
    const snapshot: ThreadPrLifecycleSnapshot = {
      targetKey: targetKeyA,
      refName: "feature/a",
      state: "merged",
    };

    expect(resolveThreadPrLifecycleState(snapshot, "feature/a", targetKeyA)).toBe("merged");
    expect(resolveThreadPrLifecycleState(snapshot, "feature/b", targetKeyA)).toBeUndefined();
  });

  it("treats a branchless thread as a known no-PR lifecycle without a snapshot", () => {
    expect(resolveThreadPrLifecycleState(undefined, null, null)).toBeNull();
  });

  it("rejects a same-ref lifecycle state from a different environment cwd target", () => {
    const snapshot: ThreadPrLifecycleSnapshot = {
      targetKey: targetKeyA,
      refName: "feature/shared",
      state: "merged",
    };

    expect(resolveThreadPrLifecycleState(snapshot, "feature/shared", targetKeyB)).toBeUndefined();
    expect(
      mergeThreadPrLifecycleSnapshot(snapshot, {
        targetKey: targetKeyB,
        refName: "feature/shared",
        state: undefined,
      }),
    ).toEqual({ targetKey: targetKeyB, refName: "feature/shared", state: undefined });
  });

  it("normalizes cwd exactly like status atom identity", () => {
    expect(threadPrLifecycleTargetKey({ environmentId, cwd: "  /repo-a  " })).toBe(targetKeyA);
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
