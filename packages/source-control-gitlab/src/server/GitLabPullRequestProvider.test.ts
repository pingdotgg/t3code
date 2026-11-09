import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import { gitLabViewerPermissions, make } from "./GitLabPullRequestProvider.ts";

it.effect.each(["merge", "disable-auto-merge"] as const)(
  "keeps reads and %s on the selected host when glab prefers another remote",
  (action) =>
    Effect.gen(function* () {
      const selectedHost = "gitlab.example.test:8443";
      const otherHost = "other.gitlab.example.test";
      const readHosts: string[] = [];
      const mergedHosts: string[] = [];
      const native = yield* GitLabCli.make.pipe(
        Effect.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) => {
                // glab prefers a remote named `gitlab` to `origin`. The checkout's
                // selected repository must still own every request and mutation.
                const host = input.env?.GITLAB_HOST ?? otherHost;
                const path = input.args[1];
                const mutation =
                  input.args[0] === "mr" || (input.args.includes("POST") && path !== "graphql");
                if (mutation) mergedHosts.push(host);
                else readHosts.push(host);
                const response = mutation
                  ? {}
                  : path === "graphql"
                    ? {
                        data: {
                          project: {
                            mergeRequests: {
                              nodes: [
                                { iid: "7", diffStatsSummary: { additions: 2, deletions: 1 } },
                              ],
                            },
                            mergeRequest: {
                              userPermissions: { adminMergeRequest: true },
                              diffStatsSummary: { fileCount: 1 },
                              diffStats: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
                            },
                          },
                        },
                      }
                    : path?.includes("merge_requests/")
                      ? {
                          iid: 7,
                          title: "Merge request 7",
                          web_url: `https://${host}/acme/web/-/merge_requests/7`,
                          source_branch: "feature",
                          target_branch: "main",
                          created_at: "2026-07-01T00:00:00Z",
                          updated_at: "2026-07-02T00:00:00Z",
                          user: { can_merge: true },
                          diff_refs: {
                            head_sha: "a".repeat(40),
                            base_sha: "b".repeat(40),
                            start_sha: "b".repeat(40),
                          },
                        }
                      : path === "user"
                        ? { username: "reviewer" }
                        : path?.includes("/labels?") || path?.includes("/users?")
                          ? []
                          : { merge_method: "merge", squash_option: "default_off" };
                return Effect.succeed(
                  TestSourceControlHost.processOutput(JSON.stringify(response)),
                );
              },
            },
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.make.pipe(
        Effect.provideService(GitLabCli.GitLabCli, native),
      );
      const provider = yield* make.pipe(
        Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
      );
      const reference = {
        cwd: "/repo",
        repository: "acme/web",
        host: selectedHost,
        number: 7,
      };
      const detail = yield* provider.getChangeRequest(reference);
      expect({ additions: detail.additions, deletions: detail.deletions }).toEqual({
        additions: 2,
        deletions: 1,
      });
      assert.isDefined(provider.getChangeRequestSummary);
      expect((yield* provider.getChangeRequestSummary(reference)).additions).toBe(2);
      assert.isDefined(provider.listChangeRequestStats);
      expect(
        yield* provider.listChangeRequestStats({ ...reference, changeRequests: [reference] }),
      ).toEqual([{ repository: reference.repository, number: 7, additions: 2, deletions: 1 }]);
      assert.isDefined(provider.getFileStats);
      expect(yield* provider.getFileStats(reference)).toEqual({
        files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
        truncated: false,
      });
      expect(yield* provider.getViewer(reference)).toBe("reviewer");
      assert.isDefined(provider.listRepositoryLabels);
      yield* provider.listRepositoryLabels(reference);
      assert.isDefined(provider.searchRepositoryAuthors);
      yield* provider.searchRepositoryAuthors(reference);
      yield* provider.runAction({ ...reference, action });

      expect(readHosts).toEqual(Array(action === "merge" ? 14 : 13).fill(selectedHost));
      expect({ url: detail.url, mutatedHosts: mergedHosts }).toEqual({
        url: `https://${selectedHost}/acme/web/-/merge_requests/7`,
        mutatedHosts: [selectedHost],
      });
    }),
);

describe("gitLabViewerPermissions", () => {
  it("offers everything to a viewer GitLab says can merge", () => {
    expect(
      gitLabViewerPermissions({
        viewerCanMerge: true,
        viewerCanDeleteBranch: true,
        viewerCanEditLabels: true,
      }),
    ).toEqual({
      actions: [
        "merge",
        "ready",
        "draft",
        "close",
        "reopen",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
        "delete-branch",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      maintainerEdits: false,
      labels: true,
      updateMethods: ["rebase"],
    });
  });

  it("keeps merge, now and later, from a viewer GitLab says cannot", () => {
    expect(gitLabViewerPermissions({ viewerCanMerge: false })).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      maintainerEdits: false,
      labels: false,
    });
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
    reviewerUsers: [],
  };

  it.effect.each(["getChangeRequestPreview", "getChangeRequestSummary"] as const)(
    "%s preserves merge request fields without fetching project settings or fork permissions",
    (operation) =>
      Effect.gen(function* () {
        const detailInputs: Array<{ readonly maintainerEdits?: boolean }> = [];
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              getMergeRequestDetail: (input) => {
                detailInputs.push(input);
                return Effect.succeed(detail);
              },
              getListStates: () => Effect.succeed(new Map()),

              listMergeRequestStats: () => Effect.succeed([]),
            }),
          ),
        );
        const read = provider[operation];
        assert.isDefined(read);
        expect(
          yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 }),
        ).toEqual(detail);
        expect(detailInputs.map((input) => input.maintainerEdits)).toEqual([false]);
      }),
  );

  const readWith = (
    divergence: { readonly divergedCommits?: number },
    stats: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listMergeRequestStats"] = () =>
      Effect.succeed([]),
  ) =>
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
          listMergeRequestStats: stats,
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

  it.effect("says nothing at all where GitLab counted nothing", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({});

      expect(changeRequest.baseComparison).toBe("unknown");
      expect(changeRequest.behindBy).toBeUndefined();
    }),
  );

  it.effect("fills in the line counts the REST detail leaves out", () =>
    Effect.gen(function* () {
      const changeRequest = yield* readWith({}, () =>
        Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
      );

      expect(changeRequest.additions).toBe(40);
      expect(changeRequest.deletions).toBe(2);
    }),
  );

  it.effect("reports an unauthenticated line count read instead of a detail without counts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readWith({}, () =>
          Effect.fail(
            new GitLabCli.GitLabCliAuthenticationError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: null,
            }),
          ),
        ),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "PullRequestProviderError", reason: "unauthenticated" },
      });
    }),
  );

  it.effect("gives linked threads line counts without reading the merge settings", () =>
    Effect.gen(function* () {
      const summary = yield* Effect.gen(function* () {
        const provider = yield* make;
        const read = provider.getChangeRequestSummary;
        if (read === undefined) return yield* Effect.die("summary read missing");
        return yield* read({ cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 });
      }).pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            getMergeRequestDetail: () => Effect.succeed(detail),
            getProjectMergeCapabilities: () => Effect.die("linked threads skip merge settings"),
            getListStates: () => Effect.succeed(new Map()),
            listMergeRequestStats: () =>
              Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
          }),
        ),
      );

      expect(summary.additions).toBe(40);
      expect(summary.deletions).toBe(2);
    }),
  );
});

describe("merge request reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
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
    reviewerUsers: [],
  };

  const countingProvider = Effect.gen(function* () {
    const calls = { detail: 0, mergeCapabilities: 0 };
    const host = { viewerCanMerge: true };
    const provider = yield* make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          listMergeRequestStats: () => Effect.succeed([]),
          getListStates: () => Effect.succeed(new Map()),
          getMergeRequestDetail: (input) =>
            Effect.sync(() => {
              calls.detail += 1;
              return { ...detail, number: input.number, viewerCanMerge: host.viewerCanMerge };
            }),
          getProjectMergeCapabilities: () =>
            Effect.sync(() => {
              calls.mergeCapabilities += 1;
              return { merge: true, squash: true, rebase: true };
            }),
          runMergeRequestAction: () => Effect.void,
          setLabels: () => Effect.void,
        }),
      ),
    );
    const checks = provider.getChangeRequestChecks;
    const forget = provider.forgetChangeRequestReads;
    if (checks === undefined || forget === undefined) {
      return yield* Effect.die("GitLab answers checks and forgets its reads");
    }
    return { provider, checks, forget, calls, host };
  });

  it.effect("asks for a project's merge methods once across its merge requests", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest({ ...reference, number: 8 });

      expect(calls.mergeCapabilities).toBe(1);
    }),
  );

  it.effect("answers checks from the merge request the detail just read", () =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* checks(reference);

      expect(calls.detail).toBe(1);

      const summary = provider.getChangeRequestSummary;
      assert.isDefined(summary);
      yield* summary(reference);
      expect(calls.detail).toBe(2);
    }),
  );

  it.effect.each([
    {
      write: "runAction",
      run: (provider: Effect.Success<typeof make>) =>
        provider.runAction({ ...reference, action: "ready" }),
    },
    {
      write: "setLabels",
      run: (provider: Effect.Success<typeof make>) =>
        provider.setLabels?.({ ...reference, labels: ["bug"], applied: true }) ?? Effect.void,
    },
  ])("reads a merge request again after $write", ({ run }) =>
    Effect.gen(function* () {
      const { provider, checks, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* run(provider);
      yield* checks(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect.each([{ cwd: "/other" }, { host: "other.gitlab.test" }])(
    "does not share reads with %j",
    (other) =>
      Effect.gen(function* () {
        const { provider, calls } = yield* countingProvider;

        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });
        yield* provider.getChangeRequest(reference);
        yield* provider.getChangeRequest({ ...reference, ...other });

        expect(calls).toEqual({ detail: 2, mergeCapabilities: 2 });
      }),
  );

  it.effect("reads a merge request again once a minute has passed", () =>
    Effect.gen(function* () {
      const { provider, calls } = yield* countingProvider;

      yield* provider.getChangeRequest(reference);
      yield* TestClock.adjust("61 seconds");
      yield* provider.getChangeRequest(reference);

      expect(calls.detail).toBe(2);
    }),
  );

  it.effect("answers viewer permissions from the host, not the page's read", () =>
    Effect.gen(function* () {
      const { provider, host } = yield* countingProvider;

      host.viewerCanMerge = false;
      yield* provider.getChangeRequest(reference);
      host.viewerCanMerge = true;
      const granted = yield* provider.getViewerPermissions(reference);
      host.viewerCanMerge = false;
      const revoked = yield* provider.getViewerPermissions(reference);

      expect(granted.actions).toContain("merge");
      expect(revoked.actions).not.toContain("merge");
    }),
  );

  it.effect("reads a merge request again once its reads are forgotten", () =>
    Effect.gen(function* () {
      const { provider, checks, forget, calls } = yield* countingProvider;
      const other = { ...reference, repository: "acme/api" };

      yield* provider.getChangeRequest(reference);
      yield* provider.getChangeRequest(other);
      yield* forget({ repository: "ACME/web", number: 7 });
      yield* checks(reference);
      yield* checks(other);
      expect(calls.detail).toBe(3);

      yield* forget({ repository: "acme/web" });
      yield* checks(reference);
      yield* forget();
      yield* checks(other);
      expect(calls.detail).toBe(5);
    }),
  );
});

describe("optional activity reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const comment = {
    id: "42",
    kind: "issue-comment" as const,
    author: null,
    body: "Keep this comment",
    createdAt: "2026-07-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const commit = {
    oid: "abc",
    messageHeadline: "Keep this commit",
    committedDate: "2026-07-01T00:00:00Z",
  };
  const webUrl = "https://git.acme.dev/acme/web/-/merge_requests/7";
  const currentRefs = { baseSha: "base2", startSha: "start2", headSha: "head2" };
  const reads = {
    getMergeRequestDetail: () =>
      Effect.succeed({
        number: 7,
        title: "Merge request 7",
        url: webUrl,
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
        reviewerUsers: [],
        diffRefs: currentRefs,
      }),
    listNotes: () => Effect.succeed({ comments: [comment], truncated: false }),
    listCommits: () => Effect.succeed([commit]),
    listDiscussions: () =>
      Effect.succeed({
        threads: [],
        diffRefsByThreadId: new Map(),
        overviewFindingIds: [],
        truncated: false,
      }),
    listReactions: () =>
      Effect.succeed({
        reactions: [],
        reactionsByNoteId: new Map(),
        editedAtByNoteId: new Map(),
        botLogins: new Set<string>(),
      }),
  };
  const context = {
    operation: "execute" as const,
    command: "glab" as const,
    cwd: "/w",
    cause: null,
  };

  it.effect.each([
    {
      operation: "listNotes",
      error: new GitLabCli.GitLabCliAuthenticationError(context),
      reason: "unauthenticated",
    },
    {
      operation: "listCommits",
      error: new GitLabCli.GitLabCliUnavailableError(context),
      reason: "missing-tool",
    },
  ] as const)(
    "reports $reason instead of successful partial activity",
    ({ operation, error, reason }) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              ...reads,
              [operation]: () => Effect.fail(error),
            }),
          ),
        );

        expect(yield* Effect.result(provider.getChangeRequestActivity(reference))).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PullRequestProviderError",
            provider: "gitlab",
            operation: "getChangeRequestActivity",
            reason,
            detail: error.detail,
            cause: error,
          },
        });
      }),
  );

  it.effect("turns the first note of an open overview discussion into a review finding", () =>
    Effect.gen(function* () {
      const finding = { ...comment, id: "10", body: "Mention the flag in the README" };
      const reply = { ...comment, id: "11", body: "Will do" };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listNotes: () =>
              Effect.succeed({ comments: [comment, finding, reply], truncated: false }),
            listDiscussions: () =>
              Effect.succeed({
                threads: [],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: ["10"],
                truncated: false,
              }),
          }),
        ),
      );

      const { comments } = yield* provider.getChangeRequestActivity(reference);

      expect(comments.map((item) => [item.id, item.kind])).toEqual([
        ["42", "issue-comment"],
        ["10", "review-comment"],
        ["11", "issue-comment"],
      ]);
    }),
  );

  it.effect("dates edited comments in the conversation and in threads", () =>
    Effect.gen(function* () {
      const editedAt = "2026-07-02T00:00:00Z";
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "src/a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [comment],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
            listReactions: () =>
              Effect.succeed({
                reactions: [],
                reactionsByNoteId: new Map(),
                editedAtByNoteId: new Map([[comment.id, editedAt]]),
                botLogins: new Set<string>(),
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);

      expect(activity.comments[0]?.editedAt).toBe(editedAt);
      expect(activity.reviewThreads[0]?.comments[0]?.editedAt).toBe(editedAt);
    }),
  );

  it.effect("links comments and thread comments to their note on the merge request page", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "src/a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [comment],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);

      expect(activity.comments[0]?.url).toBe(`${webUrl}#note_42`);
      expect(activity.reviewThreads[0]?.comments[0]?.url).toBe(`${webUrl}#note_42`);
    }),
  );

  it.effect("marks a thread outdated once the merge request's diff moves past it", () =>
    Effect.gen(function* () {
      let detailReads = 0;
      const thread = (id: string) => ({
        id,
        path: "src/a.ts",
        line: 3,
        side: "right" as const,
        isResolved: false,
        isOutdated: false,
        comments: [],
      });
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            getMergeRequestDetail: () =>
              Effect.map(reads.getMergeRequestDetail(), (detail) => ({
                ...detail,
                diffRefs: ++detailReads === 1 ? { ...currentRefs, headSha: "head1" } : currentRefs,
              })),
            listDiscussions: () =>
              Effect.succeed({
                threads: [thread("current"), thread("moved"), thread("unplaced")],
                diffRefsByThreadId: new Map([
                  ["current", currentRefs],
                  ["moved", { ...currentRefs, headSha: "head1" }],
                ]),
                overviewFindingIds: [],
                truncated: false,
              }),
          }),
        ),
      );

      const checks = provider.getChangeRequestChecks;
      if (!checks) throw new Error("missing getChangeRequestChecks");
      yield* checks(reference);
      const { reviewThreads } = yield* provider.getChangeRequestActivity(reference);
      expect(reviewThreads.map(({ id, isOutdated }) => [id, isOutdated])).toEqual([
        ["current", false],
        ["moved", true],
        ["unplaced", false],
      ]);
    }),
  );

  it.effect("keeps comments and commits when optional discussions, reactions and links fail", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: "/w",
                  operation: "listDiscussions",
                  cause: null,
                }),
              ),
            listReactions: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
            getMergeRequestDetail: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
          }),
        ),
      );

      expect(yield* provider.getChangeRequestActivity(reference)).toEqual({
        comments: [{ ...comment, reactions: [] }],
        commentCount: 1,
        commentsTruncated: true,
        reviewThreads: [],
        reactions: [],
        commits: [commit],
      });
    }),
  );

  it.effect("flags comments by bot authors as bots, in the conversation and in threads", () =>
    Effect.gen(function* () {
      const bot = { login: "project_1_bot_abc", name: "Review bot", avatarUrl: null };
      const human = { login: "julius", name: null, avatarUrl: null };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listNotes: () =>
              Effect.succeed({
                comments: [
                  { ...comment, author: bot },
                  { ...comment, id: "43", author: human },
                ],
                truncated: false,
              }),
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [
                      { id: "44", author: bot, body: "x", createdAt: comment.createdAt, url: null },
                    ],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
            listReactions: () =>
              Effect.succeed({
                reactions: [],
                reactionsByNoteId: new Map(),
                editedAtByNoteId: new Map(),
                botLogins: new Set([bot.login.toUpperCase()]),
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);
      expect(activity.comments.map((entry) => entry.author?.isBot)).toEqual([true, undefined]);
      expect(activity.reviewThreads[0]?.comments[0]?.author?.isBot).toBe(true);
    }),
  );
});

describe("review decisions", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const item = {
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
  };
  const detail = {
    ...item,
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    viewerCanMerge: true,
    reviewerIds: [],
    reviewerUsers: [],
  };
  const providerWith = (
    getListStates: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["getListStates"],
    overrides: Partial<GitLabPullRequestCli.GitLabPullRequestCli["Service"]> = {},
  ) =>
    make.pipe(
      Effect.provide(
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
          supportsGraphqlList: () => Effect.succeed(false),
          listMergeRequests: () =>
            Effect.succeed({
              items: [item, { ...item, number: 8 }],
              truncated: false,
              cursorAdvance: 2,
            }),
          ...overrides,
          getMergeRequestDetail: () => Effect.succeed(detail),
          getListStates,
          listMergeRequestStats: () =>
            Effect.succeed([{ repository: "acme/web", number: 7, additions: 40, deletions: 2 }]),
        }),
      ),
    );
  const listing = {
    cwd: "/w",
    repository: "acme/web",
    host: "gitlab.com",
    state: "open" as const,
    involvement: "all" as const,
    viewer: "julius",
    limit: 2,
  };

  it.effect(
    "puts GitLab's approval and pipeline state on listed and summarized merge requests",
    () =>
      Effect.gen(function* () {
        const provider = yield* providerWith((input) => {
          expect(input.host).toBe(reference.host);
          return Effect.succeed(
            new Map([
              [7, { reviewDecision: "approved" as const, checksState: "failing" as const }],
              [8, { reviewDecision: null, checksState: null }],
            ]),
          );
        });
        const listed = yield* provider.listChangeRequests(listing);
        assert.isDefined(provider.getChangeRequestSummary);
        const summary = yield* provider.getChangeRequestSummary(reference);

        expect(listed.items.map(({ reviewDecision }) => reviewDecision)).toEqual([
          "approved",
          null,
        ]);
        expect(listed.items.map(({ checksState }) => checksState)).toEqual(["failing", null]);
        expect(summary.reviewDecision).toBe("approved");
        expect(summary.checksState).toBe("failing");
        expect(summary.additions).toBe(40);
        expect(summary.deletions).toBe(2);
      }),
  );

  it.effect(
    "lists through GraphQL where the host takes it, using the states that read carried",
    () =>
      Effect.gen(function* () {
        const graphqlFlags: Array<boolean | undefined> = [];
        let versionReads = 0;
        const providerReading = (
          supportsGraphqlList: Effect.Effect<
            boolean,
            GitLabPullRequestCli.GitLabPullRequestCliError
          >,
        ) =>
          providerWith(() => Effect.die("a GraphQL page carries its own states"), {
            supportsGraphqlList: () => {
              versionReads += 1;
              return supportsGraphqlList;
            },
            listMergeRequests: (input) => {
              graphqlFlags.push(input.graphql);
              return Effect.succeed({
                items: [item],
                truncated: true,
                cursorAdvance: 1,
                resumeAfter: "eyJpZCI6IjcifQ",
                listStates: new Map([
                  [7, { reviewDecision: "changes-requested" as const, checksState: null }],
                ]),
              });
            },
          });
        const listedWith = (
          supportsGraphqlList: Effect.Effect<
            boolean,
            GitLabPullRequestCli.GitLabPullRequestCliError
          >,
        ) =>
          providerReading(supportsGraphqlList).pipe(
            Effect.flatMap((provider) => provider.listChangeRequests(listing)),
          );

        const listed = yield* listedWith(Effect.succeed(true));
        expect(listed).toMatchObject({ resumeAfter: "eyJpZCI6IjcifQ", truncated: true });
        expect(listed).not.toHaveProperty("listStates");
        expect(listed.items[0]?.reviewDecision).toBe("changes-requested");

        // An unreadable version leaves the list on REST rather than failing it, and stays known.
        const unreadable = yield* providerReading(
          Effect.fail(
            new GitLabPullRequestCli.GitLabMergeRequestReadError({
              command: "glab",
              cwd: "/w",
              operation: "supportsGraphqlList",
              cause: null,
            }),
          ),
        );
        versionReads = 0;
        yield* unreadable.listChangeRequests(listing);
        yield* unreadable.listChangeRequests(listing);
        expect(graphqlFlags).toEqual([true, false, false]);
        expect(versionReads).toBe(1);
      }),
  );

  it.effect("asks a host for its version once across checkouts of its projects", () =>
    Effect.gen(function* () {
      const versionReads: Array<string> = [];
      const provider = yield* providerWith(() => Effect.succeed(new Map()), {
        supportsGraphqlList: (input) =>
          Effect.sync(() => {
            versionReads.push(input.cwd);
            return true;
          }),
      });

      yield* provider.listChangeRequests({ ...listing, cwd: "/a", repository: "acme/web" });
      yield* provider.listChangeRequests({ ...listing, cwd: "/b", repository: "acme/docs" });

      expect(versionReads).toHaveLength(1);
    }),
  );

  describe("first pages of several projects", () => {
    const across = { ...listing, repositories: ["acme/web", "acme/docs"], limit: 99 };
    const readFirstPages = (
      listMergeRequestsInProjects: GitLabPullRequestCli.GitLabPullRequestCli["Service"]["listMergeRequestsInProjects"],
      input: Partial<
        Parameters<NonNullable<PullRequestProviderApi["listChangeRequestsInRepositories"]>>[0]
      > = {},
    ) =>
      providerWith(() => Effect.die("a GraphQL page carries its own states"), {
        supportsGraphqlList: () => Effect.succeed(true),
        listMergeRequestsInProjects,
      }).pipe(
        Effect.flatMap((provider) => {
          assert.isDefined(provider.listChangeRequestsInRepositories);
          return provider.listChangeRequestsInRepositories({ ...across, ...input });
        }),
      );

    it.effect("asks a host with one project for a whole page of its rows", () =>
      Effect.gen(function* () {
        const asked: Array<number> = [];
        yield* readFirstPages(
          (input) => {
            asked.push(input.first);
            return Effect.succeed([]);
          },
          { repositories: ["acme/web"] },
        );

        expect(asked).toEqual([99]);
      }),
    );

    it.effect("leaves out a failed read's projects, but fails on a rate limit", () =>
      Effect.gen(function* () {
        const failure = (
          error: GitLabCli.GitLabCliCommandError | GitLabCli.GitLabCliRateLimitError,
        ) =>
          readFirstPages(() => Effect.fail(error)).pipe(
            Effect.map((pages) => pages.map(({ repository }) => repository)),
            Effect.catch(({ reason }) => Effect.succeed(reason)),
          );
        const context = {
          operation: "execute" as const,
          command: "glab" as const,
          cwd: "/w",
          cause: null,
        };

        expect(yield* failure(new GitLabCli.GitLabCliCommandError(context))).toEqual([]);
        expect(yield* failure(new GitLabCli.GitLabCliRateLimitError(context))).toBe("rate-limited");
      }),
    );
  });

  it.effect.each([
    {
      failure: "a failed read",
      error: new GitLabPullRequestCli.GitLabMergeRequestReadError({
        command: "glab",
        cwd: "/w",
        operation: "getListStates",
        cause: null,
      }),
    },
    {
      failure: "a rate limit",
      error: new GitLabCli.GitLabCliRateLimitError({
        operation: "execute",
        command: "glab",
        cwd: "/w",
        cause: null,
      }),
    },
  ])("keeps rows and summaries with an unknown decision after $failure", ({ error }) =>
    Effect.gen(function* () {
      const provider = yield* providerWith(() => Effect.fail(error));
      const listed = yield* provider.listChangeRequests(listing);
      assert.isDefined(provider.getChangeRequestSummary);
      const summary = yield* provider.getChangeRequestSummary(reference);

      expect(listed.items.map(({ reviewDecision }) => reviewDecision)).toEqual([
        undefined,
        undefined,
      ]);
      expect(summary.reviewDecision).toBeUndefined();
    }),
  );
});
