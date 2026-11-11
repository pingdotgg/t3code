import type { VcsStatusResult } from "@t3tools/contracts";
import { resolveQuickAction } from "@t3tools/client-runtime/state/vcs";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadGitViewablePr, resolveThreadGitViewPrItem } from "./threadGitMenu";

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

describe("thread git menu View PR row", () => {
  it("stays out when the quick action is already View PR", () => {
    const gitStatus = status({ pr: openPr });
    expect(resolveQuickAction(gitStatus, false).kind).toBe("open_pr");
    expect(
      resolveThreadGitViewPrItem(gitStatus, resolveThreadGitViewablePr(gitStatus, null), "open_pr"),
    ).toBeNull();
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
    expect(
      resolveThreadGitViewPrItem(
        gitStatus,
        resolveThreadGitViewablePr(gitStatus, null),
        "run_action",
      ),
    ).toEqual({ title: "View PR", subtitle: "PR #42" });
  });

  it("adds the linked PR beside Push & create PR for a branch without its own PR", () => {
    const gitStatus = status({ refName: "feature-b", aheadCount: 1 });
    const linked = { ...openPr, number: 7, headRef: "feature-a" };
    const quickAction = resolveQuickAction(gitStatus, false);
    expect(quickAction.label).toBe("Push & create PR");
    const viewable = resolveThreadGitViewablePr(gitStatus, linked);
    expect(viewable).toBe(linked);
    expect(resolveThreadGitViewPrItem(gitStatus, viewable, quickAction.kind)).toEqual({
      title: "View PR",
      subtitle: "PR #7",
    });
  });

  it("prefers the checkout's own open PR over a linked one", () => {
    const gitStatus = status({ pr: openPr });
    expect(resolveThreadGitViewablePr(gitStatus, { ...openPr, number: 7 })).toBe(gitStatus.pr);
  });

  it("omits the row when there is no open pull request", () => {
    expect(resolveThreadGitViewPrItem(status(), null, "show_hint")).toBeNull();
  });
});
