import { describe, expect, it } from "vite-plus/test";

import { gitLabViewerPermissions } from "./GitLabPullRequestProvider.ts";

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      actions: ["merge", "ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      // GitLab says nothing about who may set a reviewer, and an unreported permission is granted.
      requestReviewers: true,
    });
  });

  it("keeps merge from a viewer GitLab says cannot", () => {
    // `user.can_merge` already accounts for the role, the approval rules and a protected target
    // branch, so it is the one answer here that does not have to be inferred.
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      requestReviewers: true,
    });
  });

  it("treats an author with read access as any other reader, which is all GitLab says", () => {
    // Its REST API names no relationship between the viewer and the merge request beyond
    // `can_merge`, so the four an author keeps stay offered to everyone rather than being taken
    // from the one person entitled to them.
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).actions).toEqual([
      "ready",
      "draft",
      "close",
      "reopen",
    ]);
  });
});
