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

  it("offers request changes only to an eligible reviewer", () => {
    expect(
      gitLabViewerPermissions({ viewerCanMerge: true, canRequestChanges: true }).verdicts,
    ).toContain("request-changes");
    expect(
      gitLabViewerPermissions({ viewerCanMerge: true, canRequestChanges: false }).verdicts,
    ).not.toContain("request-changes");
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
          getRequestChangesViewer: () => Effect.succeed(null),
          getProjectMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: true }),
        }),
      ),
    );

  for (const viewer of [null, "bilal", "octocat"]) {
    it.effect(`gates request changes on host support and reviewer assignment: ${viewer}`, () =>
      Effect.gen(function* () {
        const provider = yield* make;
        const input = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
        const capabilities = yield* provider.getCapabilities!(input);
        const result = yield* provider.getChangeRequest(input);
        const permissions = yield* provider.getViewerPermissions(input);
        expect(capabilities.review.verdicts.includes("request-changes")).toBe(viewer !== null);
        expect(result.viewerPermissions?.verdicts.includes("request-changes")).toBe(
          viewer === "octocat",
        );
        expect(permissions.verdicts.includes("request-changes")).toBe(viewer === "octocat");
      }).pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getRequestChangesViewer: () => Effect.succeed(viewer),
            getMergeRequestDetail: () =>
              Effect.succeed({
                ...detail,
                reviewers: [{ login: "octocat", avatarUrl: null, name: null }],
              }),
            getProjectMergeCapabilities: () =>
              Effect.succeed({ merge: true, squash: true, rebase: true }),
          }),
        ),
      ),
    );
  }

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

  it.effect("keeps the discussion id when editing a thread comment", () =>
    Effect.gen(function* () {
      const provider = yield* providerWith;
      assert.isDefined(provider.updateComment);

      yield* provider.updateComment({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
        commentId: "42",
        threadId: "discussion",
        kind: "review-comment",
        body: "Reworded.",
      });

      expect(updateNote).toHaveBeenCalledWith({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        noteId: "42",
        discussionId: "discussion",
        body: "Reworded.",
      });
    }),
  );
});

describe("comment links", () => {
  it.effect("links notes and discussion replies to their own anchors on the source host", () =>
    Effect.gen(function* () {
      const comment = {
        id: "5",
        kind: "review-comment" as const,
        author: null,
        body: "Please check this.",
        createdAt: "2026-07-02T00:00:00Z",
        url: null,
        path: "src/app.ts",
        reviewState: null,
      };
      const reply = { ...comment, id: "6", body: "Updated.", createdAt: "2026-07-03T00:00:00Z" };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            listNotes: () => Effect.succeed({ comments: [reply], truncated: true }),
            listCommits: () => Effect.succeed([]),
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "discussion",
                    path: "src/app.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [comment, reply],
                  },
                ],
                truncated: false,
              }),
            listReactions: () => Effect.succeed({ reactions: [], reactionsByNoteId: new Map() }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        host: "gitlab.example.com:8443",
        repository: "team/sub group/web",
        number: 7,
      });

      const links = [
        "https://gitlab.example.com:8443/team/sub%20group/web/-/merge_requests/7#note_5",
        "https://gitlab.example.com:8443/team/sub%20group/web/-/merge_requests/7#note_6",
      ];
      expect(activity.comments.map((item) => item.url)).toEqual(links);
      expect(activity.commentCount).toBe(2);
      expect(activity.reviewThreads[0]?.comments.map((item) => item.url)).toEqual(links);
    }),
  );
});
