import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { IssueLink } from "@t3tools/contracts";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
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

  it.effect("reads checks without fetching project settings", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
          }),
        ),
      );
      const read = provider.getChangeRequestChecks;
      if (read === undefined) return yield* Effect.die("checks read missing");
      expect(
        yield* read({ cwd: "/w", repository: "group/subgroup/web", host: "gitlab.com", number: 7 }),
      ).toEqual({ state: "open", checks: [] });
    }),
  );

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
          listLinkedIssues: () => Effect.succeed({ links: [], truncated: false }),
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

describe("getChangeRequest linked issues", () => {
  const issue = (number: number, closesIssue: boolean): IssueLink => ({
    repository: "acme/web",
    number,
    title: `Issue ${number}`,
    url: `https://gitlab.com/acme/web/-/issues/${number}`,
    state: "open",
    closesIssue,
  });

  const detailWith = (body: string) => ({
    number: 7,
    title: "Open an issue beside a thread",
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
    body,
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
  });

  const layerWith = (input: {
    readonly body: string;
    readonly linked: ReadonlyArray<IssueLink>;
    readonly listCitedIssues: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"];
  }) =>
    Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
      getMergeRequestDetail: () => Effect.succeed(detailWith(input.body)),
      getProjectMergeCapabilities: () =>
        Effect.succeed({ merge: true, squash: true, rebase: false }),
      listLinkedIssues: () => Effect.succeed({ links: input.linked, truncated: false }),
      listCitedIssues: input.listCitedIssues,
    });

  const read = Effect.gen(function* () {
    const provider = yield* make;
    return yield* provider.getChangeRequest({
      cwd: "/w",
      repository: "acme/web",
      host: "gitlab.com",
      number: 7,
    });
  });

  it.effect("adds an issue the description only cites, from this project alone", () => {
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    return read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues.map((link) => [link.number, link.closesIssue])).toEqual([
          [12, true],
          [34, false],
        ]);
        // GitLab's issues endpoint is per project, and one read is the whole budget here.
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual([34]);
      }),
      Effect.provide(
        layerWith({
          body: "Closes #12. Part of #34 and of acme/tools#9.",
          linked: [issue(12, true)],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("applies the citation cap after removing other projects", () => {
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([issue(34, false)]));
    const external = Array.from({ length: 10 }, (_, index) => `group/tools#${index + 1}`).join(" ");

    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual([34]);
        expect(detail.linkedIssues.map((link) => link.number)).toEqual([34]);
      }),
      Effect.provide(
        layerWith({
          body: `${external} then #34`,
          linked: [],
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect.each([
    { count: 10, linkedCount: 0 },
    { count: 11, linkedCount: 0 },
    { count: 20, linkedCount: 10 },
  ])("caps only unlinked citations and reports overflow (%j)", ({ count, linkedCount }) => {
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const linked = numbers.slice(0, linkedCount).map((number) => issue(number, true));
    const citedNumbers = numbers.slice(linkedCount, linkedCount + 10);
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed(citedNumbers.map((number) => issue(number, false))));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).toHaveBeenCalledTimes(1);
        expect(listCitedIssues.mock.calls[0]?.[0].numbers).toEqual(citedNumbers);
        expect(detail.linkedIssues.map((link) => link.number)).toEqual(
          numbers.slice(0, linkedCount + 10),
        );
        expect(detail.linkedIssuesTruncated).toBe(count - linkedCount > 10);
      }),
      Effect.provide(
        layerWith({
          body: numbers.map((number) => "#" + number).join(" "),
          linked,
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("asks nothing when more than ten citations are already host links", () => {
    const linked = Array.from({ length: 11 }, (_, index) => issue(index + 1, true));
    const listCitedIssues = vi.fn<
      GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
    >(() => Effect.succeed([]));
    return read.pipe(
      Effect.map((detail) => {
        expect(listCitedIssues).not.toHaveBeenCalled();
        expect(detail.linkedIssues).toEqual(linked);
        expect(detail.linkedIssuesTruncated).toBe(false);
      }),
      Effect.provide(
        layerWith({
          body: linked.map((link) => "#" + link.number).join(" "),
          linked,
          listCitedIssues,
        }),
      ),
    );
  });

  it.effect("drops a reference GitLab answered nothing for", () =>
    read.pipe(
      Effect.map((detail) => expect(detail.linkedIssues).toEqual([])),
      Effect.provide(
        layerWith({
          body: "Part of #404.",
          linked: [],
          listCitedIssues: () => Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect.each(["listLinkedIssues", "listCitedIssues"] as const)(
    "propagates a rate limit from %s and stops later citation reads",
    (operation) =>
      Effect.gen(function* () {
        const rateLimit = new GitLabCli.GitLabCliRateLimitError({
          operation: "execute",
          command: "glab",
          cwd: "/w",
          cause: new Error("429 Too Many Requests"),
        });
        const listCitedIssues = vi.fn<
          GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listCitedIssues"]
        >(() => Effect.fail(rateLimit));
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              getMergeRequestDetail: () => Effect.succeed(detailWith("Part of #34.")),
              getProjectMergeCapabilities: () =>
                Effect.succeed({ merge: true, squash: true, rebase: false }),
              listLinkedIssues: () =>
                operation === "listLinkedIssues"
                  ? Effect.fail(rateLimit)
                  : Effect.succeed({ links: [], truncated: false }),
              listCitedIssues,
            }),
          ),
        );
        const result = yield* provider
          .getChangeRequest({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 })
          .pipe(Effect.result);

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.reason, "rate-limited");
          assert.strictEqual(result.failure.operation, "getChangeRequest");
          assert.strictEqual(result.failure.cause, rateLimit);
        }
        expect(listCitedIssues).toHaveBeenCalledTimes(operation === "listLinkedIssues" ? 0 : 1);
      }),
  );

  it.effect("keeps the host's own links when the lookup fails", () =>
    read.pipe(
      Effect.map((detail) => {
        expect(detail.linkedIssues).toEqual([issue(12, true)]);
        expect(detail.linkedIssuesTruncated).toBe(true);
      }),
      Effect.provide(
        layerWith({
          body: "Part of #34.",
          linked: [issue(12, true)],
          listCitedIssues: () =>
            Effect.fail(
              new GitLabPullRequestCli.GitLabMergeRequestReadError({
                command: "glab",
                cwd: "/w",
                operation: "listCitedIssues",
                cause: new Error("404 Project Not Found"),
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("keeps citation links when the host link read fails", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detailWith("Part of #34.")),
            getProjectMergeCapabilities: () =>
              Effect.succeed({ merge: true, squash: true, rebase: false }),
            listLinkedIssues: () =>
              Effect.fail(
                new GitLabCli.GitLabCliCommandError({
                  operation: "execute",
                  command: "glab",
                  cwd: "/w",
                  cause: new Error("404 Project Not Found"),
                }),
              ),
            listCitedIssues: () => Effect.succeed([issue(34, false)]),
          }),
        ),
      );
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "gitlab.com",
        number: 7,
      });

      expect(detail.linkedIssues).toEqual([issue(34, false)]);
      expect(detail.linkedIssuesTruncated).toBe(true);
    }),
  );
});

describe("getChangeRequestActivity fallback errors", () => {
  it.effect.each(["listNotes", "listCommits", "listDiscussions", "listReactions"] as const)(
    "propagates a rate limit from %s and keeps ordinary failures partial",
    (operation) =>
      Effect.gen(function* () {
        for (const ErrorType of [
          GitLabCli.GitLabCliRateLimitError,
          GitLabCli.GitLabCliCommandError,
        ]) {
          const error = new ErrorType({
            operation: "execute",
            command: "glab",
            cwd: "/w",
            cause: new Error("request failed"),
          });
          const provider = yield* make.pipe(
            Effect.provide(
              Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
                listNotes: () => Effect.succeed({ comments: [], truncated: false }),
                listCommits: () => Effect.succeed([]),
                listDiscussions: () => Effect.succeed({ threads: [], truncated: false }),
                listReactions: () =>
                  Effect.succeed({ reactions: [], reactionsByNoteId: new Map() }),
                [operation]: () => Effect.fail(error),
              }),
            ),
          );
          const result = yield* provider
            .getChangeRequestActivity({
              cwd: "/w",
              repository: "acme/web",
              host: "gitlab.com",
              number: 7,
            })
            .pipe(Effect.result);

          assert.strictEqual(
            result._tag,
            ErrorType === GitLabCli.GitLabCliRateLimitError ? "Failure" : "Success",
          );
          if (result._tag === "Failure") {
            assert.strictEqual(result.failure.reason, "rate-limited");
            assert.strictEqual(result.failure.operation, "getChangeRequestActivity");
            assert.strictEqual(result.failure.cause, error);
          }
        }
      }),
  );
});
