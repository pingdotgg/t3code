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
    statusRefName: "feature/test",
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    changeRequestLookup: { _tag: "succeeded" },
    ...overrides,
  };
}

describe("change request certainty", () => {
  it.each([
    { _tag: "pending" as const },
    {
      _tag: "failed" as const,
      provider: "github" as const,
      reason: "lookup_failed" as const,
    },
  ])("never creates a PR while lookup is $._tag", (changeRequestLookup) => {
    const ahead = status({ aheadCount: 1, changeRequestLookup });
    const dirty = status({ hasWorkingTreeChanges: true, changeRequestLookup });

    expect(resolveQuickAction(ahead, false).action).toBe("push");
    expect(resolveQuickAction(dirty, false).action).toBe("commit_push");
    expect(buildMenuItems(ahead, false).find((item) => item.id === "pr")?.disabled).toBe(true);
  });

  it("allows creation after a successful lookup confirms absence", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false).action).toBe("create_pr");
  });

  it("keeps a cached open PR actionable when lookup fails", () => {
    const gitStatus = status({
      pr: {
        number: 42,
        title: "Existing PR",
        url: "https://example.com/pr/42",
        baseRef: "main",
        headRef: "feature/test",
        state: "open",
      },
      changeRequestLookup: {
        _tag: "failed",
        provider: "github",
        reason: "lookup_failed",
      },
    });

    expect(resolveQuickAction(gitStatus, false).kind).toBe("open_pr");
  });
});
