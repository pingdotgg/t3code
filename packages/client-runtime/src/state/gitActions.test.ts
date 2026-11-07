import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MERGE_REQUEST_TERMINOLOGY, PULL_REQUEST_TERMINOLOGY } from "../sourceControlClients.ts";
import {
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

  it("says PR for a GitLab ref by default", () => {
    expect(resolveQuickAction(status({ ...gitLab, aheadCount: 1 }), false).label).toBe(
      "Push & create PR",
    );
    expect(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
    ).toBe("Commit, push & PR");
    expect(resolveQuickAction(status({ ...gitLab, pr: openPr }), false).label).toBe("View PR");
    const [, , prItem] = buildMenuItems(status(gitLab), false);
    expect(prItem?.label).toBe("Create PR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(gitLab),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("uses the supplied terminology in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: PULL_REQUEST_TERMINOLOGY,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: MERGE_REQUEST_TERMINOLOGY,
      }).continueLabel,
    ).toBe("Commit, push & create MR");
  });
});
