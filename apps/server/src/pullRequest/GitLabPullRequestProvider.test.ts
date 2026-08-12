import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: true })).toEqual({
      // Arming a merge for later and taking the arming back answer to the same `can_merge`.
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve"],
      // GitLab says nothing about who may set a reviewer, and an unreported permission is granted.
      requestReviewers: true,
      // Rebase and nothing else: GitLab cannot merge a target branch into a source branch, so
      // offering the choice would be offering something no request could carry out.
      updateMethods: ["rebase"],
    });
  });

  it("keeps merge, now and later, from a viewer GitLab says cannot", () => {
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

  it("names no way of updating a branch it will not let this viewer update", () => {
    // The action and the strategy behind it go together: a button offered with nothing to press
    // it with, or a strategy left standing next to a withheld button, is a half-refusal.
    expect(gitLabViewerPermissions({ viewerCanMerge: false }).updateMethods).toBeUndefined();
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

describe("getChangeRequest base freshness", () => {
  const detail = {
    number: 7,
    title: "Merge request 7",
    url: "https://gitlab.com/acme/web/-/merge_requests/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  };

  const readWith = (divergence: { readonly divergedCommits?: number }) =>
    Effect.gen(function* () {
      const provider = yield* make;
      return yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });
    }).pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          getMergeRequestDetail: () => Effect.succeed({ ...detail, ...divergence }),
          getProjectMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: true }),
        }),
      ),
    );

  it.effect("reads a counted divergence as a branch that has fallen behind", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 3 });

      expect(changeRequest.baseComparison).toBe("behind");
      expect(changeRequest.behindBy).toBe(3);
    }),
  );

  it.effect("reads a divergence of none as a branch that is current", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({ divergedCommits: 0 });

      expect(changeRequest.baseComparison).toBe("up-to-date");
      expect(changeRequest.behindBy).toBe(0);
    }),
  );

  it.effect("says nothing at all where GitLab counted nothing", () =>
    Effect.gen(function* () {
      // An install too old to answer has to leave the page silent rather than let it claim the
      // branch is current, which is the one wrong thing this banner could say.
      const changeRequest = yield* readWith({});

      expect(changeRequest.baseComparison).toBe("unknown");
      expect(changeRequest.behindBy).toBeUndefined();
    }),
  );
});

describe("rewriting what has already been said", () => {
  const updateMergeRequest = vi.fn(() => Effect.void);
  const updateNote = vi.fn(() => Effect.void);

  const providerWith = make.pipe(
    Effect.provide(
      Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({ updateMergeRequest, updateNote }),
    ),
  );

  it.effect("sends only the half of the merge request the reader rewrote", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateChangeRequest);

      yield* provider.updateChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        body: "What this changes.",
      });

      // GitLab calls it the description, and the title stays out of the request entirely.
      expect(updateMergeRequest).toHaveBeenCalledWith({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        description: "What this changes.",
      });
    }),
  );

  it.effect("rewrites a positioned comment through the same note as any other", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateComment);

      yield* provider.updateComment({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        commentId: "42",
        kind: "review-comment",
        body: "Reworded.",
      });

      expect(updateNote).toHaveBeenCalledWith({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        noteId: "42",
        body: "Reworded.",
      });
    }),
  );
});
