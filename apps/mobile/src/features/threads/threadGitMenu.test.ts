import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { resolveQuickAction } from "@t3tools/client-runtime/state/vcs";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadGitViewPrItem } from "./threadGitMenu";

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

const openPr = {
  number: 42,
  title: "Feature",
  url: "https://github.com/t3tools/t3code/pull/42",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

describe("resolveThreadGitViewPrItem", () => {
  it("stays out when the quick action is already View PR", () => {
    const gitStatus = status({ pr: openPr });
    expect(resolveQuickAction(gitStatus, false).kind).toBe("open_pr");
    expect(resolveThreadGitViewPrItem(gitStatus, "open_pr")).toBeNull();
  });

  it("keeps View PR in the first git menu when the quick action is Commit & push", () => {
    const gitStatus = status({
      pr: openPr,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    });
    expect(resolveQuickAction(gitStatus, false).kind).toBe("run_action");
    expect(resolveThreadGitViewPrItem(gitStatus, "run_action")).toEqual({
      title: "View PR",
      subtitle: "PR #42",
    });
  });

  it("says View MR for a GitLab open change request", () => {
    const gitStatus = status({
      pr: openPr,
      aheadCount: 1,
      sourceControlProvider: {
        kind: SourceControlProviderKind.make("gitlab"),
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      },
    });
    expect(resolveThreadGitViewPrItem(gitStatus, "run_action")).toEqual({
      title: "View MR",
      subtitle: "MR #42",
    });
  });

  it("omits the row when there is no open pull request", () => {
    expect(resolveThreadGitViewPrItem(status(), "show_hint")).toBeNull();
  });
});
