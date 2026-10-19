import { describe, expect, it } from "vite-plus/test";
import {
  allowedMergeMethods,
  allowedUpdateMethods,
  canPerformPullRequestAction,
  mergeSummary,
  mergeUnavailableReason,
  ALL_PR_ACTIONS,
} from "./pullRequestActions";

type Detail = Parameters<typeof allowedMergeMethods>[0];

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    capabilities: {
      actions: ALL_PR_ACTIONS,
      mergeMethods: ["merge", "squash", "rebase"],
      updateMethods: ["merge", "rebase"],
    },
    viewerPermissions: { actions: ALL_PR_ACTIONS, updateMethods: ["merge"] },
    mergeCapabilities: { merge: true, squash: true, rebase: false },
    ...overrides,
  };
}

describe("mobile pull request actions", () => {
  it("offers branch updates only through strategies supported by the provider and account", () => {
    expect(allowedUpdateMethods(detail())).toEqual(["merge"]);
    expect(canPerformPullRequestAction(detail(), "update-branch")).toBe(true);
    const unsupported = detail({ viewerPermissions: { actions: ALL_PR_ACTIONS } });
    expect(allowedUpdateMethods(unsupported)).toEqual([]);
    expect(canPerformPullRequestAction(unsupported, "update-branch")).toBe(false);
    const disallowed = detail({
      viewerPermissions: { actions: ALL_PR_ACTIONS, updateMethods: ["rebase"] },
      capabilities: { actions: ALL_PR_ACTIONS, mergeMethods: ["squash"], updateMethods: ["merge"] },
    });
    expect(canPerformPullRequestAction(disallowed, "update-branch")).toBe(false);
  });
  it("offers workflow approval only for reported pending approvals", () => {
    expect(canPerformPullRequestAction(detail(), "approve-workflows")).toBe(false);
    expect(
      canPerformPullRequestAction(detail({ workflowApprovalsRequired: 2 }), "approve-workflows"),
    ).toBe(true);
    expect(
      canPerformPullRequestAction(detail({ workflowApprovalsRequired: 0 }), "approve-workflows"),
    ).toBe(false);
  });
  it("offers only merge strategies allowed by both the provider and repository", () => {
    expect(allowedMergeMethods(detail())).toEqual(["merge", "squash"]);
    const pr = detail({ capabilities: { actions: ALL_PR_ACTIONS, mergeMethods: ["merge"] } });
    expect(allowedMergeMethods(pr)).toEqual(["merge"]);
    expect(mergeSummary(pr, true)).toBe("Merge · auto-merge off");
  });

  it("requires both provider support and account permission", () => {
    expect(
      canPerformPullRequestAction(detail({ viewerPermissions: { actions: [] } }), "merge"),
    ).toBe(false);
    expect(
      canPerformPullRequestAction(
        detail({ capabilities: { actions: [], mergeMethods: ["merge"] } }),
        "merge",
      ),
    ).toBe(false);
    expect(mergeUnavailableReason(detail(), false)).toContain("read-only");
  });

  it("turns drafts into ready PRs before allowing a merge", () => {
    const draft = detail({ isDraft: true });
    expect(canPerformPullRequestAction(draft, "merge")).toBe(false);
    expect(canPerformPullRequestAction(draft, "ready")).toBe(true);
    expect(canPerformPullRequestAction(draft, "draft")).toBe(false);
    expect(canPerformPullRequestAction(detail(), "ready")).toBe(false);
    expect(canPerformPullRequestAction(detail(), "draft")).toBe(true);
  });

  it("blocks a conflicting PR's immediate merge and explains why", () => {
    const pr = detail({ mergeability: "conflicting" });
    expect(canPerformPullRequestAction(pr, "merge")).toBe(false);
    expect(mergeUnavailableReason(pr, true)).toContain("conflicts");
    expect(mergeSummary(pr, true)).toBe("Has conflicts");
  });

  it("offers the reverse lifecycle action after a close", () => {
    const closed = detail({ state: "closed" });
    expect(canPerformPullRequestAction(closed, "close")).toBe(false);
    expect(canPerformPullRequestAction(closed, "merge")).toBe(false);
    expect(canPerformPullRequestAction(closed, "reopen")).toBe(true);
    expect(canPerformPullRequestAction(detail(), "reopen")).toBe(false);
  });

  it("does not reopen a merged PR, but can offer a revert", () => {
    const merged = detail({ state: "merged" });
    expect(canPerformPullRequestAction(merged, "reopen")).toBe(false);
    expect(canPerformPullRequestAction(merged, "merge")).toBe(false);
    expect(canPerformPullRequestAction(merged, "revert")).toBe(true);
    expect(mergeSummary(merged, true)).toBe("Merged");
  });

  it("offers disable auto-merge only when armed, and enable only when explicitly off", () => {
    const armed = detail({ autoMergeEnabled: true });
    expect(canPerformPullRequestAction(armed, "enable-auto-merge")).toBe(false);
    expect(canPerformPullRequestAction(armed, "disable-auto-merge")).toBe(true);
    expect(canPerformPullRequestAction(detail(), "enable-auto-merge")).toBe(true);
    expect(canPerformPullRequestAction(detail(), "disable-auto-merge")).toBe(false);
    const unknown = detail({ autoMergeEnabled: undefined });
    expect(canPerformPullRequestAction(unknown, "enable-auto-merge")).toBe(false);
    expect(mergeSummary(unknown, true)).toBe("Squash");
  });

  it("offers deleting the source branch only once merged or closed on a host that supports it", () => {
    const capabilities = { ...detail().capabilities, deleteBranch: true };
    expect(canPerformPullRequestAction(detail({ capabilities }), "delete-branch")).toBe(false);
    for (const state of ["merged", "closed"] as const) {
      expect(canPerformPullRequestAction(detail({ state, capabilities }), "delete-branch")).toBe(
        true,
      );
      expect(canPerformPullRequestAction(detail({ state }), "delete-branch")).toBe(false);
    }
    const refused = detail({ state: "merged", capabilities, viewerPermissions: { actions: [] } });
    expect(canPerformPullRequestAction(refused, "delete-branch")).toBe(false);
  });

  it("cannot merge when the repository has disabled every offered strategy", () => {
    const pr = detail({ mergeCapabilities: { merge: false, squash: false, rebase: false } });
    expect(canPerformPullRequestAction(pr, "merge")).toBe(false);
    expect(canPerformPullRequestAction(pr, "enable-auto-merge")).toBe(false);
    expect(mergeUnavailableReason(pr, true)).toContain("no available merge methods");
  });
});
