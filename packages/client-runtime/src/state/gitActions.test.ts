import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  requiresForcePushConfirmation,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const gitLab = {
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
};

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

describe("git action copy", () => {
  it("says PR for a GitHub ref", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false).label).toBe("Push & create PR");
    expect(resolveQuickAction(status({ pr: openPr }), false).label).toBe("View PR");
    const [, , prItem] = buildMenuItems(status(), false);
    expect(prItem?.label).toBe("Create PR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("says MR for a GitLab ref", () => {
    expect(resolveQuickAction(status({ ...gitLab, aheadCount: 1 }), false).label).toBe(
      "Push & create MR",
    );
    expect(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
    ).toBe("Commit, push & MR");
    expect(resolveQuickAction(status({ ...gitLab, pr: openPr }), false).label).toBe("View MR");
    const [, , prItem] = buildMenuItems(status(gitLab), false);
    expect(prItem?.label).toBe("Create MR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(gitLab),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in an MR.");
    const dirtyItems = buildMenuItems(status({ ...gitLab, hasWorkingTreeChanges: true }), false);
    expect(dirtyItems.find((item) => item.id === "pr")).toMatchObject({
      disabled: false,
      action: "commit_push_pr",
      label: "Commit, push & create MR",
    });
    expect(dirtyItems.find((item) => item.id === "push")).toMatchObject({
      disabled: false,
      action: "commit_push",
      label: "Commit & push",
    });
    for (const refName of [null, "main"]) {
      const items = buildMenuItems(
        status({
          ...gitLab,
          refName,
          isDefaultRef: refName === "main",
          hasWorkingTreeChanges: true,
        }),
        false,
      );
      expect(items[0]).toMatchObject({ id: "branch", disabled: false, action: "create_branch" });
      expect(items.find((item) => item.id === "push")).toMatchObject({
        disabled: false,
        featureBranch: true,
      });
      expect(items.find((item) => item.id === "pr")).toMatchObject({
        disabled: false,
        featureBranch: true,
      });
    }
  });

  it("names the host's change request in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("gitlab").changeRequest,
      }).continueLabel,
    ).toBe("Commit, push & create MR");
  });
});

const divergedStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/rebased",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 1,
  pr: null,
};

describe("diverged git actions", () => {
  it("opens force-push confirmation as the primary action", () => {
    expect(resolveQuickAction(divergedStatus, false)).toEqual({
      label: "Push",
      disabled: false,
      kind: "open_push_dialog",
    });
  });

  it("enables the Push menu item for clean rewritten history", () => {
    expect(buildMenuItems(divergedStatus, false).find((item) => item.id === "push")).toMatchObject({
      disabled: false,
      dialogAction: "push",
    });
    expect(requiresForcePushConfirmation(divergedStatus)).toBe(true);
  });
});
