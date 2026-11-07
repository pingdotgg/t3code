import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  requiresActiveRunConfirmation,
  buildMenuItems,
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

describe("resolveQuickAction", () => {
  it("offers a change request for a pushed branch ahead of the default branch", () => {
    expect(resolveQuickAction(status({ aheadOfDefaultCount: 1 }), false)).toMatchObject({
      label: "Create PR",
      disabled: false,
      action: "create_pr",
    });
    expect(resolveQuickAction(status({ aheadOfDefaultCount: 1 }), false, true).disabled).toBe(true);
  });

  it("keeps the full action for changes but claims nothing else before remote state loads", () => {
    const pending = { isRemoteStatusPending: true, hasUpstream: false };
    expect(
      resolveQuickAction(status({ ...pending, hasWorkingTreeChanges: true }), false),
    ).toMatchObject({ label: "Commit, push & PR", disabled: false, action: "commit_push_pr" });
    expect(resolveQuickAction(status(pending), false)).toMatchObject({
      disabled: true,
      hint: "Waiting for remote status.",
    });
    const [, pushItem] = buildMenuItems(status(pending), false);
    expect(
      getGitActionDisabledReason({
        item: pushItem!,
        gitStatus: status(pending),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Waiting for remote status.");
  });
});

describe("requiresActiveRunConfirmation", () => {
  it.each([
    { action: "commit", running: true, expected: true },
    { action: "commit_push", running: true, expected: true },
    { action: "commit_push_pr", running: true, expected: true },
    { action: "push", running: true, expected: false },
    { action: "create_pr", running: true, expected: false },
    { action: "commit", running: false, expected: false },
  ] as const)("$action running=$running", (row) => {
    expect(requiresActiveRunConfirmation(row.action, row.running)).toBe(row.expected);
  });
});

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
