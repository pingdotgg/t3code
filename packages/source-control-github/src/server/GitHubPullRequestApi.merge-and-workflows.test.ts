import {
  Effect,
  GitHubPullRequestApi,
  GitHubQuota,
  GitHubRequestPolicy,
  NODE_ID_QUERY,
  Redacted,
  SUBJECT_SCOPE_QUERY,
  SourceControlRateLimit,
  assert,
  callAt,
  diffRefused,
  emptyList,
  emptySearch,
  encodeJson,
  expect,
  graphqlQuota,
  heads,
  layer,
  mockedCredential,
  mockedExecute,
  nodeIdAnswer,
  output,
  pathAt,
  pullRequestFiles,
  pullRequestMergeBase,
  pullRequestRefs,
  queryAt,
  route,
  searchOfCall,
  subjectScope,
  variablesOf,
  workflowRuns,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect("surfaces a workflow run list beyond the safe approval bound", () =>
    Effect.gen(function* () {
      let runPages = 0;
      mockedExecute.mockImplementation((call) => {
        if (call.kind === "graphql") return Effect.succeed(output(encodeJson(heads([7]))));
        const page = runPages++;
        return Effect.succeed(
          output(
            encodeJson(
              workflowRuns(Array.from({ length: 100 }, (_, index) => page * 100 + index + 1)),
            ),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalRefusedError",
        reason: "run-list-truncated",
        number: 7,
        observedCount: 1_100,
        limit: 1_000,
      });
      expect(error.message).toContain("more than 1000 workflow runs");
      assert.strictEqual(runPages, 11);
    }),
  );

  it.effect("sends a comment body as a variable, never inside the document", () =>
    Effect.gen(function* () {
      route([NODE_ID_QUERY, nodeIdAnswer("PR_7")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.commentOnPullRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        body: "Looks good.",
      });

      expect(variablesOf("addComment(")).toEqual([{ subjectId: "PR_7", body: "Looks good." }]);
      expect(queryAt(mockedExecute.mock.calls.length - 1)).not.toContain("Looks good.");
    }),
  );

  it.effect("names the host on every repository it addresses", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          call.kind === "graphql" && call.operationName === "PullRequestList"
            ? emptyList()
            : emptySearch(),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      assert.isAbove(mockedExecute.mock.calls.length, 0);
      expect(new Set(mockedExecute.mock.calls.map(([call]) => call.host))).toEqual(
        new Set(["github.acme.dev"]),
      );
      expect(searchOfCall(0)).toContain("repo:acme/web");
    }),
  );

  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      assert.strictEqual(callAt(1).host, "github.acme.dev");
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("reads a named commit from the commit endpoint rather than the whole diff", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(`{"files":${pullRequestFiles(2, 1)}}`)),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 1);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      assert.strictEqual(
        pathAt(0),
        "repos/acme/web/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0?per_page=100&page=1",
      );
    }),
  );

  it.effect("refuses a commit that is not a sha rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "../../pulls/8/files",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCommitError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("expands a new file from a root commit without requiring a parent", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(encodeJson({ sha: "a1b2c3d", parents: [] }))),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("root contents\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "a1b2c3d",
        changeType: "new",
        oldPath: "src/root.ts",
        newPath: "src/root.ts",
      });

      expect(contents).toEqual({ oldContents: "", newContents: "root contents\n" });
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      assert.strictEqual(pathAt(0), "repos/acme/web/commits/a1b2c3d");
      assert.strictEqual(pathAt(1), "repos/acme/web/contents/src/root.ts?ref=a1b2c3d");
    }),
  );

  it.effect("expands a pull request file from its merge base, not the moved base tip", () =>
    Effect.gen(function* () {
      const answers: Record<string, string> = {
        "repos/acme/web/pulls/7": pullRequestRefs,
        "repos/acme/web/compare/a1b2c3d...b1c2d3e?per_page=1&page=2": pullRequestMergeBase,
        "repos/acme/web/contents/src/a.ts?ref=a1b2c3d": "base tip\n",
        "repos/acme/web/contents/src/a.ts?ref=c1d2e3f": "merge base\n",
        "repos/acme/web/contents/src/a.ts?ref=b1c2d3e": "head\n",
      };
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(output(call.kind === "rest" ? (answers[call.path] ?? "") : "")),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        changeType: "change",
        oldPath: "src/a.ts",
        newPath: "src/a.ts",
      });

      expect(contents).toEqual({ oldContents: "merge base\n", newContents: "head\n" });
    }),
  );

  it.effect("reports unusable diff revisions as a structured error", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not-a-sha\tstill-not-a-sha\n")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          commit: "a1b2c3d",
          changeType: "change",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffRevisionsUnavailableError");
      if (error._tag === "GitHubDiffRevisionsUnavailableError") {
        assert.strictEqual(error.number, 7);
        assert.strictEqual(error.commit, "a1b2c3d");
      }
    }),
  );

  it.effect("reports undecodable diff file contents as binary", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestMergeBase)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("binary�contents", false, true)));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiffFileContents({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          changeType: "deleted",
          oldPath: "assets/logo.png",
          newPath: "assets/logo.png",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffFileContentsUnavailableError");
      if (error._tag === "GitHubDiffFileContentsUnavailableError") {
        assert.strictEqual(error.path, "assets/logo.png");
        assert.strictEqual(error.reason, "binary");
      }
    }),
  );

  it.effect("returns valid text containing a literal replacement character", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestRefs)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestMergeBase)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("before�after")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const contents = yield* cli.getPullRequestDiffFileContents({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        changeType: "deleted",
        oldPath: "docs/encoding.md",
        newPath: "docs/encoding.md",
      });

      assert.strictEqual(contents.oldContents, "before�after");
    }),
  );

  it.effect("ends the diff on a page with no files rather than asking for it again", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("[]")));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "4",
      });

      assert.strictEqual(diff.patch, "");
      assert.isNull(diff.nextCursor);
    }),
  );

  it.effect("reports the refused diff when the files API cannot answer either", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("not json")));
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

  it.effect("verifies a REST-forbidden account through GraphQL with the pinned credential", () =>
    Effect.gen(function* () {
      const input = { cwd: "/w", host: "github.identity-fallback.test" };
      const original = {
        token: Redacted.make("original-token"),
        fingerprint: `${input.host}:original`,
      };
      mockedCredential.mockReturnValue(Effect.succeed(original));
      mockedExecute.mockImplementation((call) =>
        Effect.gen(function* () {
          expect(yield* SourceControlRateLimit.CredentialScope).toBe(original.fingerprint);
          if (call.kind === "rest") {
            expect(call.path).toBe("user");
            expect(yield* GitHubRequestPolicy.PinnedGitHubCredential).toMatchObject({
              host: input.host,
              credentialFingerprint: original.fingerprint,
            });
            mockedCredential.mockReturnValue(
              Effect.succeed({
                token: Redacted.make("replacement-token"),
                fingerprint: `${input.host}:replacement`,
              }),
            );
            return yield* new GitHubRequestPolicy.GitHubApiResponseError({
              host: input.host,
              operation: "getRoutingIdentity",
              status: 403,
              githubErrors: ["Resource not accessible by integration"],
            });
          }
          expect(call.host).toBe(input.host);
          expect(call.authorization).toBe("Bearer original-token");
          expect(call.query).toMatch(/viewer\s*\{/);
          expect(call.query).toContain("databaseId");
          expect(call.query).toContain("login");
          return output(
            '{"data":{"viewer":{"databaseId":789,"login":"acme-app[bot]"}}}',
            false,
            false,
            graphqlQuota(0),
          );
        }),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota
        .observe(input.host, graphqlQuota(1))
        .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, original.fingerprint));
      const identity = { accountId: "789", viewer: "acme-app[bot]" };
      expect(yield* cli.getRoutingIdentity(input)).toEqual(identity);

      mockedCredential.mockReturnValue(Effect.succeed(original));
      expect(yield* cli.getRoutingIdentity(input)).toEqual(identity);
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      const exhausted = yield* quota
        .admit(input.host, "graphql")
        .pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, original.fingerprint),
          Effect.flip,
        );
      expect(exhausted._tag).toBe("SourceControlRateLimitPausedError");
      yield* quota
        .admit(input.host, "graphql")
        .pipe(
          Effect.provideService(
            SourceControlRateLimit.CredentialScope,
            `${input.host}:replacement`,
          ),
        );
    }),
  );

  it.effect("rejects a null GraphQL account id without caching it", () =>
    Effect.gen(function* () {
      const input = { cwd: "/w", host: "github.identity-null.test" };
      const forbidden = new GitHubRequestPolicy.GitHubApiResponseError({
        host: input.host,
        operation: "getRoutingIdentity",
        status: 403,
      });
      mockedExecute
        .mockReturnValueOnce(Effect.fail(forbidden))
        .mockReturnValueOnce(
          Effect.succeed(output('{"data":{"viewer":{"databaseId":null,"login":"acme-app[bot]"}}}')),
        )
        .mockReturnValueOnce(Effect.fail(forbidden))
        .mockReturnValueOnce(
          Effect.succeed(output('{"data":{"viewer":{"databaseId":789,"login":"acme-app[bot]"}}}')),
        );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* cli.getRoutingIdentity(input).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubViewerLoginUnavailableError");
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "789",
        viewer: "acme-app[bot]",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(4);
    }),
  );

  it.effect.each([
    new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.identity-auth-error.test",
      operation: "getRoutingIdentity",
    }),
    new GitHubRequestPolicy.GitHubApiResponseError({
      host: "github.identity-server-error.test",
      operation: "getRoutingIdentity",
      status: 500,
    }),
  ])("preserves $_tag from REST identity verification without trying GraphQL", (error) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.fail(error));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      expect(yield* cli.getRoutingIdentity({ cwd: "/w", host: error.host }).pipe(Effect.flip)).toBe(
        error,
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(callAt(0)).toMatchObject({ kind: "rest", path: "user" });
    }),
  );

  it.effect("reuses verified credentials offline and refuses an unverified replacement", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const input = { cwd: "/w", host: "github.identity-cache.test" };
      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-a"), fingerprint: `${host}:a` }),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":123,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });

      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "123",
        viewer: "maria-rcks",
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);

      mockedCredential.mockImplementation((host) =>
        Effect.succeed({ token: Redacted.make("test-credential-b"), fingerprint: `${host}:b` }),
      );
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiResponseError({
            host: "github.com",
            operation: "getRoutingIdentity",
            status: 502,
          }),
        ),
      );
      const failure = yield* cli.getRoutingIdentity(input).pipe(Effect.flip);
      expect(failure._tag).toBe("GitHubApiResponseError");
      expect(String(failure)).not.toContain("test-credential-b");
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"id":456,"login":"maria-rcks"}')));
      expect(yield* cli.getRoutingIdentity(input)).toEqual({
        accountId: "456",
        viewer: "maria-rcks",
      });
    }),
  );

  it.effect("confirms a given subject belongs to the named pull request, then reacts to it", () =>
    Effect.gen(function* () {
      route([SUBJECT_SCOPE_QUERY, subjectScope("IC_1", "PR_kwDOA")]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.setReaction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        subjectId: "IC_1",
        content: "heart",
        reacted: true,
      });

      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(variablesOf(SUBJECT_SCOPE_QUERY)).toEqual([
        { owner: "acme", name: "web", number: 7, subjectId: "IC_1" },
      ]);
      expect(variablesOf("addReaction(")).toEqual([{ subjectId: "IC_1", content: "HEART" }]);
    }),
  );

  it.effect("refuses a given subject that belongs to a different pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                repository: { pullRequest: { id: "PR_thisOne" } },
                node: {
                  __typename: "IssueComment",
                  id: "IC_99",
                  pullRequest: { id: "PR_someOtherOne" },
                },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.setReaction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          subjectId: "IC_99",
          content: "heart",
          reacted: true,
        }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );
});
