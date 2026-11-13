import {
  Effect,
  GitHubPullRequestApi,
  SourceControlRateLimit,
  TestClock,
  assert,
  checkContextsPage,
  checkRun,
  coreResponse,
  diffRefused,
  encodeJson,
  expect,
  graphqlQuota,
  layer,
  mockedExecute,
  output,
  pathAt,
  pullRequestFiles,
  pullRequestInput,
  refusedReviewer,
  refusedReviewerResponse,
  reviewThreadsPage,
  thread,
  threadComments,
  threadCommentsPage,
  variablesOf,
  varsAt,
  type PullRequestRead,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect.each([
    {
      name: "check path",
      errors: [
        {
          ...refusedReviewer,
          path: ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
        },
      ],
    },
    { name: "HTTP 403", errors: [refusedReviewer], status: 403 },
    {
      name: "GraphQL rate limit",
      errors: [refusedReviewer, { message: "API rate limit exceeded", type: "RATE_LIMITED" }],
      tag: "GitHubApiRateLimitError",
    },
  ])("does not retry a reviewer refusal with $name", ({ name, errors, status = 200, tag }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson(status === 401 ? { message: "Bad credentials" } : { data: null, errors }),
            false,
            false,
            {},
            status,
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const reads: ReadonlyArray<PullRequestRead> = [
        cli.getPullRequestDetail,
        cli.listReviewThreadComments,
      ];
      for (const [index, read] of reads.entries()) {
        const error = yield* read({
          ...pullRequestInput,
          host: `github-${name.replaceAll(" ", "-")}-${index}.test`,
        }).pipe(Effect.asVoid, Effect.flip);
        expect(error._tag).toBe(tag ?? "GitHubApiResponseError");
        if (error._tag === "GitHubApiResponseError")
          expect(error).toMatchObject({ status, githubErrors: errors.map((e) => e.message) });
        expect(mockedExecute).toHaveBeenCalledTimes(index + 1);
      }
    }),
  );

  it.effect.each([false, true])(
    "keeps thread cursors and reviewers after a refusal (later page: %s)",
    (later) =>
      Effect.gen(function* () {
        if (later)
          mockedExecute.mockReturnValueOnce(
            Effect.succeed(
              output(
                reviewThreadsPage([thread("T1", "c1")], "next", [
                  {
                    __typename: "User",
                    login: "prior",
                    name: null,
                    avatarUrl: "https://avatars/prior",
                  },
                ]),
              ),
            ),
          );
        mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T2", "c2")], "last"))),
        );
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(reviewThreadsPage([thread("T3", "c3")], null))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.listReviewThreadComments(pullRequestInput);
        const conversation = yield* read;
        expect(
          variablesOf("ReviewThreads").map((v) => [v["after"], v["requestedReviewers"]]),
        ).toEqual(
          later
            ? [
                [null, 50],
                ["next", 50],
                ["next", 0],
                ["last", 0],
              ]
            : [
                [null, 50],
                [null, 0],
                ["last", 0],
              ],
        );
        expect(conversation.comments.map((c) => c.id)).toEqual(
          later ? ["c1", "c2", "c3"] : ["c2", "c3"],
        );
        expect(conversation.reviewers.map((r) => r.login)).toEqual(later ? ["prior"] : []);
        expect(conversation.truncated).toBe(false);

        mockedExecute.mockReturnValueOnce(Effect.succeed(output(reviewThreadsPage([], null))));
        yield* read;
        expect(variablesOf("ReviewThreads").at(-1)).toMatchObject({
          after: null,
          requestedReviewers: 50,
        });
      }),
  );

  it.effect("decodes reviewers, labels and workflow checks without another detail read", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                baseRef: null,
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { __typename: "User", login: "reviewer", name: null } },
                    {
                      requestedReviewer: {
                        __typename: "Team",
                        slug: "maintainers",
                        combinedSlug: "octo/maintainers",
                        teamName: "Maintainers",
                        teamAvatarUrl: "https://avatars.githubusercontent.com/t/1",
                      },
                    },
                  ],
                },
                labels: { nodes: [{ name: "bug", color: "ff0000" }] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "SUCCESS",
                                checkSuite: { workflowRun: { workflow: { name: "linux" } } },
                              }),
                              checkRun({
                                name: "build",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                checkSuite: { workflowRun: { workflow: { name: "windows" } } },
                              }),
                            ],
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      },
                    },
                  ],
                },
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const detail = yield* cli.getPullRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(detail.comparison).toBeNull();
      expect(detail.reviewRequestLogins).toEqual(["reviewer"]);
      expect(detail.hasTeamReviewRequest).toBe(true);
      expect(detail.reviewRequestTeams).toEqual([
        {
          login: "octo/maintainers",
          name: "Maintainers",
          avatarUrl: "https://avatars.githubusercontent.com/t/1",
        },
      ]);
      expect(detail.labels).toEqual([{ name: "bug", color: "ff0000" }]);
      expect(detail.checks).toHaveLength(2);
      expect(detail.checksState).toBe("failing");
    }),
  );

  it.effect.each([false, true])(
    "reads every check when the combined response has another page (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson(
                coreResponse({
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                checkRun({
                                  name: "first",
                                  status: "COMPLETED",
                                  conclusion: "SUCCESS",
                                }),
                              ],
                              pageInfo: { hasNextPage: true, endCursor: "c1" },
                            },
                          },
                        },
                      },
                    ],
                  },
                }),
              ),
            ),
          ),
        );
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              checkContextsPage(
                [
                  checkRun({ name: "first", status: "COMPLETED", conclusion: "SUCCESS" }),
                  checkRun({ name: "last", status: "COMPLETED", conclusion: "FAILURE" }),
                ],
                null,
              ),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const read = cli.getPullRequestDetail(pullRequestInput);
        const detail = yield* read;
        expect(detail.reviewRequestLogins).toEqual([]);
        expect(detail.reviewRequestTeams).toEqual([]);
        expect(detail.hasTeamReviewRequest).toBe(false);
        if (refused)
          expect(variablesOf("PullRequestCore").map((v) => v["requestedReviewers"])).toEqual([
            100, 0,
          ]);
        expect(detail.checks).toHaveLength(2);
        expect(detail.checksState).toBe("failing");
        expect(detail.checksTruncated).toBe(false);
        // The whole rollup is walked from its start, so no check is counted twice or skipped.
        expect(variablesOf("CheckContexts")).toEqual([expect.objectContaining({ number: 7 })]);
        expect(variablesOf("CheckContexts")[0]).not.toHaveProperty("after");
        expect(mockedExecute).toHaveBeenCalledTimes(refused ? 3 : 2);

        if (refused) {
          mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(coreResponse()))));
          yield* read;
          expect(variablesOf("PullRequestCore").at(-1)).toMatchObject({ requestedReviewers: 100 });
        }
      }),
  );

  it.effect.each([false, true])(
    "refuses to combine checks from different head revisions (reviewer refusal: %s)",
    (refused) =>
      Effect.gen(function* () {
        if (refused) mockedExecute.mockReturnValueOnce(refusedReviewerResponse());
        const response = coreResponse({
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [],
                      pageInfo: { hasNextPage: true },
                    },
                  },
                },
              },
            ],
          },
        });
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(encodeJson(response))));
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(checkContextsPage([], null, "new-head"))),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const error = yield* Effect.flip(
          cli.getPullRequestDetail({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
          }),
        );
        expect(error._tag).toBe("GitHubPullRequestReadError");
      }),
  );

  it.effect("preserves the reserve for automatic detail reads and allows manual checks", () =>
    Effect.gen(function* () {
      const response = coreResponse();
      mockedExecute.mockReturnValue(
        Effect.succeed(output(encodeJson(response), false, false, graphqlQuota(499))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.core-reserve.test",
        number: 7,
      };
      yield* cli.getPullRequestDetail(input);
      const error = yield* Effect.flip(cli.getPullRequestDetail(input));
      expect(error._tag).toBe("SourceControlRateLimitPausedError");
      expect(mockedExecute).toHaveBeenCalledOnce();
      yield* cli
        .getPullRequestDetail(input)
        .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("fails a files page too large to read rather than calling the diff whole", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1), true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error, diffRefused);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
      expect(slice.patch).toContain("src/file1.ts");
      expect(slice.patch).not.toContain("diff --git a/a b/a");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("follows the cursor to the review threads the first page left behind", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_1", "c1")], "Y3Vyc29yOjE"))),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(reviewThreadsPage([thread("PRRT_2", "c2")], null))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(varsAt(0)["after"]).toBeNull();
      expect(varsAt(1)["after"]).toBe("Y3Vyc29yOjE");
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      assert.isFalse(conversation.truncated);
    }),
  );

  it.effect("stops at the thread bound and says the conversation was cut short", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              "Y3Vyc29yOjE",
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 10);
      assert.isTrue(conversation.truncated);
      assert.isTrue(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("leaves a long thread paged until the reader asks for more", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            reviewThreadsPage(
              [{ ...thread("PRRT_1", "c1"), comments: threadComments(["c1"], "Y3Vyc29yOjI", 3) }],
              null,
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const conversation = yield* cli.listReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(conversation.comments.map((comment) => comment.id)).toEqual(["c1"]);
      expect(conversation.reviewThreads[0]).toMatchObject({
        commentCount: 3,
        nextCommentsCursor: "Y3Vyc29yOjI",
      });
      assert.isTrue(conversation.truncated);
      assert.isFalse(conversation.reviewThreadsTruncated);
    }),
  );

  it.effect("reads one requested page from a review thread cursor", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["c2", "c3"], null, 3))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const page = yield* cli.getReviewThreadComments({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        threadId: "PRRT_1",
        cursor: "Y3Vyc29yOjI",
      });

      expect(varsAt(0)).toMatchObject({
        owner: "acme",
        name: "web",
        number: 7,
        threadId: "PRRT_1",
        after: "Y3Vyc29yOjI",
      });
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(page.comments.map((comment) => comment.id)).toEqual(["c2", "c3"]);
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("refuses a review thread from another pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(threadCommentsPage(["foreign"], null, 1, "PR_8"))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getReviewThreadComments({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          threadId: "PRRT_FOREIGN",
          cursor: "Y3Vyc29yOjI",
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
    }),
  );

  it.effect("stops GraphQL reads at the protected reserve until reset", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: false,
                  rebaseMergeAllowed: true,
                  autoMergeAllowed: true,
                  viewerPermission: "READ",
                  pullRequest: {
                    viewerCanUpdate: true,
                    viewerDidAuthor: true,
                    headRepository: null,
                  },
                },
              },
            }),
            false,
            false,
            graphqlQuota(499),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      } as const;

      yield* cli.getViewerAccess(input);

      const error = yield* Effect.flip(cli.getViewerAccess(input));

      assert.strictEqual(error._tag, "SourceControlRateLimitPausedError");
      if (error._tag !== "SourceControlRateLimitPausedError") return;
      assert.strictEqual(error.host, "github.com");
      assert.strictEqual(error.retryAt, Date.parse("2099-08-13T14:00:00Z"));
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      yield* TestClock.setTime(Date.parse("2100-01-01T00:00:00Z"));
    }),
  );

  it.effect("reads who may review and who already has in one request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  assignableUsers: {
                    pageInfo: { hasNextPage: false },
                    nodes: ["bilal", "octocat", "hubot"].map((login) => ({
                      login,
                      name: null,
                      avatarUrl: `https://avatars/${login}`,
                    })),
                  },
                  pullRequest: {
                    author: { __typename: "User", login: "bilal" },
                    reviewRequests: {
                      nodes: [
                        {
                          requestedReviewer: {
                            __typename: "User",
                            login: "octocat",
                            name: null,
                            avatarUrl: "https://avatars/octocat",
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      expect(varsAt(0)).toMatchObject({ owner: "acme", name: "web", number: 7 });
      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        ["octocat", true],
        ["hubot", false],
      ]);
    }),
  );
});
