import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildMenuItems, resolveQuickAction } from "./gitActions.ts";

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

describe("pull request creation preference", () => {
  it("removes PR creation from the action menu", () => {
    expect(buildMenuItems(status(), false, true, false).map((item) => item.label)).toEqual([
      "Commit",
      "Push",
    ]);
    expect(buildMenuItems(status(), false).map((item) => item.label)).toContain("Create PR");
  });

  it.each([true, false])("commits and pushes with hasUpstream=%s", (hasUpstream) => {
    expect(
      resolveQuickAction(
        status({ hasWorkingTreeChanges: true, hasUpstream }),
        false,
        false,
        true,
        false,
      ),
    ).toEqual({
      label: "Commit & push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
  });

  it.each([true, false])("pushes without creating a PR with hasUpstream=%s", (hasUpstream) => {
    expect(
      resolveQuickAction(status({ aheadCount: 1, hasUpstream }), false, false, true, false),
    ).toEqual({
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "push",
    });
  });

  it("preserves access to existing pull requests", () => {
    const gitStatus = status({
      pr: {
        number: 1,
        title: "Existing PR",
        url: "https://example.com/pull/1",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
    });
    expect(buildMenuItems(gitStatus, false, true, false).at(-1)?.kind).toBe("open_pr");
    expect(resolveQuickAction(gitStatus, false, false, true, false).kind).toBe("open_pr");
  });

  it("restores PR creation when enabled", () => {
    expect(
      resolveQuickAction(status({ hasWorkingTreeChanges: true }), false, false, true, true).action,
    ).toBe("commit_push_pr");
  });
});
