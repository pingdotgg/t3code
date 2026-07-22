import { ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { changeRequestLookupWarning } from "./ThreadStatusIndicators.logic";
import { ThreadWorktreeIndicator } from "./ThreadStatusIndicators";

const failedStatus: VcsStatusResult = {
  isRepo: true,
  sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/sidebar-indicator",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  statusRefName: "feature/sidebar-indicator",
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  changeRequestLookup: {
    _tag: "failed",
    provider: "github",
    reason: "authentication_required",
  },
};

describe("changeRequestLookupWarning", () => {
  it("returns actionable provider copy for the matching thread branch", () => {
    expect(changeRequestLookupWarning("feature/sidebar-indicator", failedStatus)).toBe(
      "PR status unavailable: authentication required.",
    );
  });

  it("does not leak warnings across branches", () => {
    expect(changeRequestLookupWarning("feature/other", failedStatus)).toBeNull();
  });

  it("keeps the refresh warning when a cached open PR remains actionable", () => {
    expect(
      changeRequestLookupWarning("feature/sidebar-indicator", {
        ...failedStatus,
        pr: {
          number: 42,
          title: "Cached open PR",
          url: "https://example.com/pr/42",
          baseRef: "main",
          headRef: "feature/sidebar-indicator",
          state: "open",
        },
      }),
    ).toBe("PR status unavailable: authentication required.");
  });
});

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
