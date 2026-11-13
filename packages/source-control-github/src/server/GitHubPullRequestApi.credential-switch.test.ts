import {
  Deferred,
  Effect,
  Fiber,
  GitHubPullRequestApi,
  GitHubRequestPolicy,
  NODE_ID_QUERY,
  Redacted,
  Result,
  TestClock,
  assert,
  callAt,
  encodeJson,
  expect,
  lastPage,
  layer,
  listUnreadableRepository,
  matches,
  mockedAppToken,
  mockedCredential,
  mockedExecute,
  nodeIdAnswer,
  output,
  pathAt,
  pullRequestInput,
  pullRequests,
  queryAt,
  rows,
  variablesOf,
  varsAt,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("turns maintainer edits off without rewriting the pull request's text", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          output(
            encodeJson(
              call.kind === "graphql" && matches(call, NODE_ID_QUERY) ? nodeIdAnswer("PR_7") : {},
            ),
          ),
        ),
      );
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* api.updatePullRequest({ ...pullRequestInput, maintainerCanModify: false });
      expect(variablesOf("mutation UpdatePullRequest")).toEqual([
        { pullRequestId: "PR_7", maintainerCanModify: false },
      ]);
    }),
  );

  it.effect.each(["mixed", "merges", "unavailable"] as const)(
    "reads stats only for displayed non-merge commits (%s)",
    (kind) =>
      Effect.gen(function* () {
        const oids = kind === "merges" ? ["merge"] : ["regular", "merge"];
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    pullRequest: {
                      author: null,
                      comments: { nodes: [], pageInfo: lastPage },
                      reviews: { nodes: [], pageInfo: lastPage },
                      commits: {
                        nodes: oids.map((oid) => ({
                          commit: {
                            id: "node-" + oid,
                            oid,
                            messageHeadline: oid,
                            committedDate: "2026-07-05T00:00:00Z",
                            parents: { totalCount: oid === "merge" ? 2 : 1 },
                            authors: { nodes: [] },
                          },
                        })),
                      },
                    },
                  },
                },
              }),
            ),
          ),
        );
        if (kind === "unavailable") {
          mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}", false, false, {}, 503)));
        } else if (kind !== "merges") {
          mockedExecute.mockReturnValueOnce(
            Effect.succeed(
              output(
                encodeJson({
                  data: {
                    nodes: [{ __typename: "Commit", oid: "regular", additions: 18, deletions: 7 }],
                  },
                }),
              ),
            ),
          );
        }
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const activity = yield* cli.getPullRequestActivity(pullRequestInput);
        expect(activity.commits.map((commit) => commit.oid)).toEqual(oids);
        expect(activity.commits.find((commit) => commit.oid === "merge")).not.toHaveProperty(
          "additions",
        );
        expect(activity.commits.find((commit) => commit.oid === "merge")).not.toHaveProperty(
          "deletions",
        );
        if (kind === "mixed") {
          expect(activity.commits[0]).toMatchObject({ additions: 18, deletions: 7 });
        } else if (kind === "unavailable") {
          expect(activity.commits[0]).not.toHaveProperty("additions");
        }
        expect(variablesOf("PullRequestCommitStats")).toEqual(
          kind === "merges" ? [] : [{ ids: ["node-regular"] }],
        );
        expect(mockedExecute).toHaveBeenCalledTimes(kind === "merges" ? 1 : 2);
      }),
  );

  it.effect("loads the complete hover card with one GraphQL request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Fast previews",
                    url: "https://github.example/acme/web/pull/7",
                    state: "MERGED",
                    isDraft: false,
                    createdAt: "2026-07-01T00:00:00Z",
                    author: {
                      __typename: "User",
                      login: "octocat",
                      name: "Octo Cat",
                      avatarUrl: "https://github.example/avatar.png",
                    },
                  },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const preview = yield* cli.getPullRequestPreview({
        cwd: "/w",
        repository: "acme/web",
        host: "github.example",
        number: 7,
      });
      expect(preview).toEqual({
        number: 7,
        title: "Fast previews",
        url: "https://github.example/acme/web/pull/7",
        state: "merged",
        isDraft: false,
        createdAt: "2026-07-01T00:00:00Z",
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://github.example/avatar.png",
        },
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(callAt(0)).toMatchObject({ kind: "graphql", host: "github.example" });
    }),
  );

  it.effect("coalesces concurrent identity verification for the same host and credential", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(() =>
        Effect.yieldNow.pipe(Effect.as(output('{"id":123,"login":"viewer"}'))),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          cli.getRoutingIdentity({ cwd: "/w", host: "github.identity-flight.test" }),
        ),
        { concurrency: 4 },
      );
      expect(results).toEqual(
        Array.from({ length: 4 }, () => ({ accountId: "123", viewer: "viewer" })),
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(pathAt(0)).toBe("user");
    }),
  );

  it.effect(
    "lets another identity reader continue when the first verification is interrupted",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        let verifications = 0;
        mockedExecute.mockImplementation(() =>
          Effect.gen(function* () {
            if (++verifications === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Effect.never;
            }
            return output('{"id":123,"login":"viewer"}');
          }),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", host: "github.identity-cancel.test" };
        const first = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const second = yield* cli.getRoutingIdentity(input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        expect(yield* Fiber.join(second)).toEqual({ accountId: "123", viewer: "viewer" });
        expect(verifications).toBe(2);
      }),
  );

  it.effect("reads linked pull requests on one host together, filed back by position", () =>
    Effect.gen(function* () {
      const node = (number: number) => ({
        number,
        title: `Pull request ${number}`,
        url: `https://github.com/acme/web/pull/${number}`,
        author: {
          __typename: "User",
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
        },
        baseRefName: "main",
        headRefName: `feat/${number}`,
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        latestReviews: {
          nodes: [{ state: "APPROVED", author: { __typename: "User", login: "reviewer" } }],
        },
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        updatedAt: "2026-08-24T12:34:56.000Z",
        mergedAt: null,
        closedAt: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      });
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                _0_repository: { pullRequest: node(7) },
                _1_repository: { pullRequest: node(8) },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const reads = yield* Effect.forEach(
        [7, 8],
        (number) =>
          cli.getPullRequestSummary({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number,
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const [seven, eight] = yield* Fiber.join(reads);

      assert.deepStrictEqual(
        {
          number: seven?.number,
          state: seven?.state,
          headBranch: seven?.headBranch,
          author: seven?.author?.login,
          changedFiles: seven?.changedFiles,
          reviewDecision: seven?.reviewDecision,
          checksState: seven?.checksState,
          mergeability: seven?.mergeability,
        },
        {
          number: 7,
          state: "open",
          headBranch: "feat/7",
          author: "octocat",
          changedFiles: 2,
          reviewDecision: "approved",
          checksState: "passing",
          mergeability: "mergeable",
        },
      );
      assert.strictEqual(eight?.headBranch, "feat/8");
      expect(mockedExecute).toHaveBeenCalledOnce();
      expect(queryAt(0)).toContain(
        "_0_repository:repository(owner:$_0_owner name:$_0_name){pullRequest(number:$_0_number)",
      );
      expect(varsAt(0)).toMatchObject({
        _0_owner: "acme",
        _0_name: "web",
        _0_number: 7,
        _0_stacks: true,
        _1_number: 8,
      });
    }),
  );

  it.effect(
    "fails only the pull request GitHub cannot find, and answers the rest of its batch",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              encodeJson({
                data: {
                  _0_repository: { pullRequest: null },
                  _1_repository: {
                    pullRequest: {
                      number: 8,
                      title: "Still here",
                      url: "https://github.com/acme/web/pull/8",
                      author: null,
                      baseRefName: "main",
                      headRefName: "feat/eight",
                      state: "OPEN",
                      isDraft: false,
                      mergeable: "MERGEABLE",
                      reviewDecision: null,
                      latestReviews: { nodes: [] },
                      additions: 1,
                      deletions: 1,
                      changedFiles: 1,
                      updatedAt: "2026-08-24T12:34:56.000Z",
                      mergedAt: null,
                      closedAt: null,
                      commits: { nodes: [] },
                      stack: null,
                      stackEntry: null,
                    },
                  },
                },
                errors: [
                  {
                    type: "NOT_FOUND",
                    path: ["_0_repository", "pullRequest"],
                    message: "Could not resolve to a PullRequest with the number of 7.",
                  },
                ],
              }),
            ),
          ),
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

        const reads = yield* Effect.forEach(
          [7, 8],
          (number) =>
            cli
              .getPullRequestSummary({
                cwd: "/w",
                repository: "acme/web",
                host: "github.com",
                number,
              })
              .pipe(Effect.result),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 millis");
        const [seven, eight] = yield* Fiber.join(reads);

        expect(Result.isFailure(seven!) ? seven.failure._tag : null).toBe("GitHubApiNotFoundError");
        expect(Result.isSuccess(eight!) ? eight.success.headBranch : null).toBe("feat/eight");
        expect(mockedExecute).toHaveBeenCalledOnce();
        expect(callAt(0)).toMatchObject({ kind: "graphql", partial: true });
      }),
  );

  it.effect("reads the stack a pull request is in through the stacks preview, on its host", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson([
              {
                id: 42,
                number: 3,
                url: "https://api.github.com/repos/acme/web/stacks/3",
                base: { ref: "main" },
                pull_requests: [
                  {
                    number: 6,
                    head: { ref: "feat/one" },
                    state: "closed",
                    merged_at: "2026-09-02",
                  },
                  { number: 7, head: { ref: "feat/two" }, state: "open", merged_at: null },
                ],
              },
            ]),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "ghe.example.com",
        number: 7,
      });

      assert.deepStrictEqual(stack, {
        id: "42",
        number: 3,
        url: "https://api.github.com/repos/acme/web/stacks/3",
        base: "main",
        layers: [
          { number: 6, headBranch: "feat/one", state: "merged" },
          { number: 7, headBranch: "feat/two", state: "open" },
        ],
      });
      expect(callAt(0)).toMatchObject({
        kind: "rest",
        host: "ghe.example.com",
        path: "repos/acme/web/stacks?pull_request=7",
      });
    }),
  );

  it.effect("revalidates a polled stack, per credential, so an unchanged one costs no quota", () =>
    Effect.gen(function* () {
      const listing = encodeJson([
        {
          number: 4,
          url: "https://api.github.com/repos/acme/poll/stacks/4",
          base: { ref: "main" },
          pull_requests: [
            { number: 9, head: { ref: "feat/nine" }, state: "open", merged_at: null },
          ],
        },
      ]);
      const read = Effect.flatMap(GitHubPullRequestApi.GitHubPullRequestApi, (cli) =>
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/poll",
          host: "github.com",
          number: 9,
        }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(listing, false, false, { etag: 'W/"v1"' })),
      );
      const first = yield* read;
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("", false, false, {}, 304)));
      const second = yield* read;
      mockedCredential.mockImplementationOnce(() =>
        Effect.succeed({ token: Redacted.make("other"), fingerprint: "github.com:other" }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(listing)));
      yield* read;

      assert.deepStrictEqual(second, first);
      expect(callAt(0)).not.toHaveProperty("ifNoneMatch");
      expect(callAt(1)).toMatchObject({ ifNoneMatch: 'W/"v1"' });
      // Another account never revalidates the first account's answer.
      expect(callAt(2)).not.toHaveProperty("ifNoneMatch");
    }),
  );

  it.effect("reads a host that refuses the stacks preview as not stacked", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiNotFoundError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const stack = yield* cli.getPullRequestStack({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isNull(stack);
    }),
  );

  it.effect("does not read a refused credential as an unstacked pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiAuthenticationError({
            host: "github.com",
            operation: "getPullRequestStack",
          }),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );

      assert.strictEqual(error._tag, "GitHubApiAuthenticationError");
    }),
  );

  it.effect("preserves transient stack failures instead of reporting no stack", () =>
    Effect.gen(function* () {
      const failure = new GitHubRequestPolicy.GitHubApiResponseError({
        host: "github.com",
        operation: "getPullRequestStack",
        status: 503,
      });
      mockedExecute.mockReturnValueOnce(Effect.fail(failure));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.getPullRequestStack({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
        }),
      );
      assert.strictEqual(error, failure);
    }),
  );

  it.effect("reports truncation from the extra row, counted before decoding", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequests(11, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.strictEqual(batch.items.length, 10);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("reports truncation when GitHub repeats a cursor before the page is full", () =>
    Effect.gen(function* () {
      const repeating = output(
        encodeJson({
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "same" },
              nodes: rows(100, 1),
            },
          },
        }),
      );
      mockedExecute.mockReturnValue(Effect.succeed(repeating));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 250,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("names the credential GitHub would not return a repository to", () =>
    Effect.gen(function* () {
      // The saved token is replaced mid-read; every request still goes out with the one named.
      const saved = yield* listUnreadableRepository(
        { token: "first", source: "settings" },
        { token: "replaced", source: "settings" },
      );
      expect(saved.error.accessHint).toContain("saved GitHub token");
      assert.isAbove(saved.sentWith.length, 1);
      for (const authorization of saved.sentWith) expect(authorization).toContain("first");

      // The policy hands what the app cannot see to the gh login, which GitHub refuses too.
      mockedAppToken.mockReturnValue(Effect.succeedSome("app"));
      const app = { token: "app", source: "app" } as const;
      const gh = { token: "personal", source: "gh" } as const;
      const retried = yield* listUnreadableRepository(app, gh);
      expect(retried.error.accessHint).toContain("gh login");
      expect(retried.sentWith).toEqual(["Bearer app", "Bearer app", "Bearer personal"]);

      // With no gh login when the app is refused, the app made the last request; a login that
      // turns up afterwards is not named.
      const appOnly = yield* listUnreadableRepository(app, undefined, gh);
      assert.isUndefined(appOnly.error.accessHint);
      expect(appOnly.sentWith).toEqual(["Bearer app", "Bearer app"]);
    }),
  );
});
