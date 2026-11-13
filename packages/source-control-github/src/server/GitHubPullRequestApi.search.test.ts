import {
  Deferred,
  Effect,
  GitHubPullRequestApi,
  GitHubPullRequestProvider,
  GitHubRequestPolicy,
  KnownWorkflowRuns,
  actionState,
  assert,
  branchToDelete,
  coreResponse,
  crossRepositoryDetail,
  encodeJson,
  expect,
  heads,
  layer,
  mergeMessage,
  mockedExecute,
  output,
  queryAt,
  restCallsTo,
  route,
  sourceBranch,
  variablesOf,
  workflowApprovalRoutes,
  workflowRuns,
} from "./GitHubPullRequestApi-fixtures.testkit.ts";

layer("GitHubPullRequestApi.layer", (it) => {
  it.effect.each([
    {
      description: "base-only write",
      basePermission: "WRITE",
      sourcePermission: "READ",
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
    {
      description: "source-only write",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: { id: "REF" },
      expected: true,
      actionAllowed: true,
    },
    {
      description: "a deleted branch",
      basePermission: "READ",
      sourcePermission: "WRITE",
      headRef: null,
      expected: false,
      actionAllowed: true,
    },
    {
      description: "an unavailable source repository",
      basePermission: "WRITE",
      sourcePermission: null,
      headRef: { id: "REF" },
      expected: false,
      actionAllowed: false,
    },
  ])(
    "uses source branch access in both permission reads for $description",
    ({ basePermission, sourcePermission, headRef, expected, actionAllowed }) =>
      Effect.gen(function* () {
        const answer = coreResponse({
          headRepository:
            sourcePermission === null
              ? null
              : { nameWithOwner: "acme/web", viewerPermission: sourcePermission },
          headRef,
        });
        answer.data.repository.viewerPermission = basePermission;
        mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const input = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
        expect((yield* cli.getViewerAccess(input)).canDeleteBranch).toBe(actionAllowed);
        expect((yield* cli.getPullRequestDetail(input)).viewerAccess.canDeleteBranch).toBe(
          expected,
        );
        expect(variablesOf("ViewerPermissions")).toHaveLength(1);
        expect(variablesOf("PullRequestCore")).toHaveLength(1);
      }),
  );

  it.effect("preserves the actual source fork name in provider detail", () =>
    Effect.gen(function* () {
      const answer = coreResponse({
        state: "MERGED",
        isCrossRepository: true,
        headRepository: { nameWithOwner: "contributor/web-fork", viewerPermission: "WRITE" },
        headRef: { id: "REF" },
      });
      mockedExecute.mockReturnValue(Effect.succeed(output(encodeJson(answer))));
      const provider = yield* GitHubPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      expect(detail.headRepositoryNameWithOwner).toBe("contributor/web-fork");
      expect(detail.viewerPermissions.actions).toContain("delete-branch");
      expect(queryAt(0)).toContain("headRepository{nameWithOwner viewerPermission}");
    }),
  );

  it.effect.each(["MERGED", "CLOSED"])("deletes the exact remote fork branch of a %s PR", (state) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete({ state })],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.enterprise.test",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("PullRequestBranchToDelete")).toEqual([
        { owner: "acme", name: "web", number: 7 },
      ]);
      expect(variablesOf("PullRequestSourceBranch")).toEqual([
        { repositoryId: "FORK_REPO", ref: "refs/heads/feat/delete" },
      ]);
      expect(variablesOf("updateRefs(")).toEqual([
        {
          input: {
            repositoryId: "FORK_REPO",
            refUpdates: [
              {
                name: "refs/heads/feat/delete",
                beforeOid: "abc123",
                afterOid: "0000000000000000000000000000000000000000",
              },
            ],
          },
        },
      ]);
      expect(mockedExecute.mock.calls.at(-1)?.[0].host).toBe("github.enterprise.test");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
    }),
  );

  it.effect.each([
    { description: "an open PR", head: { state: "OPEN" }, source: {} },
    { description: "the base branch", head: { headRefName: "main" }, source: {} },
    {
      description: "the default branch",
      head: {},
      source: { defaultBranchRef: { name: "feat/delete" } },
    },
    {
      description: "a changed branch",
      head: {},
      source: { ref: { target: { __typename: "Commit", oid: "new-commit" } } },
    },
  ])("refuses to delete $description", ({ head, source }) =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete(head)],
        [
          "PullRequestSourceBranch",
          source === null ? { data: { node: null } } : sourceBranch(source),
        ],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubBranchDeletionRefusedError");
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("accepts an already deleted source branch", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch({ ref: null })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "delete-branch",
      });
      expect(variablesOf("updateRefs(")).toEqual([]);
    }),
  );

  it.effect("keeps the source branch when GitHub refuses deletion", () =>
    Effect.gen(function* () {
      route(
        ["PullRequestBranchToDelete", branchToDelete()],
        ["PullRequestSourceBranch", sourceBranch()],
      );
      const answer = mockedExecute.getMockImplementation()!;
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql" && call.query.includes("updateRefs(")
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: call.host,
                operation: call.operation,
                status: 422,
              }),
            )
          : answer(call),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      expect(variablesOf("closePullRequest(")).toEqual([]);
    }),
  );

  it.effect.each(["merge", "enable-auto-merge"] as const)(
    "removes agent credits from the proposed message for %s",
    (action) =>
      Effect.gen(function* () {
        route(
          [
            "query PullRequestMergeMessage",
            mergeMessage(
              "Details\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
            ),
          ],
          ["query PullRequestActionState", actionState()],
        );
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action,
          mergeMethod: "squash",
          removeAgentCreditsOnMerge: true,
        });
        expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("SQUASH");
        expect(
          variablesOf(action === "merge" ? "mergePullRequest(" : "enablePullRequestAutoMerge("),
        ).toEqual([
          {
            input: {
              pullRequestId: "PR_7",
              mergeMethod: "SQUASH",
              expectedHeadOid: "abc123",
              commitBody: "Details\n\nCo-authored-by: Alice <alice@example.com>",
            },
          },
        ]);
      }),
  );

  it.effect.each([
    {
      description: "an unchanged message",
      body: "Details\n\nCo-authored-by: Alice <alice@example.com>",
      queued: false,
    },
    {
      description: "a merge queue",
      body: "Co-authored-by: Claude <noreply@anthropic.com>",
      queued: true,
    },
  ] as const)("keeps GitHub's default message for $description", ({ body, queued }) =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", mergeMessage(body, queued)],
        ["query PullRequestActionState", actionState({ isMergeQueueEnabled: queued })],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("query PullRequestMergeMessage")[0]?.["method"]).toBe("MERGE");
      expect(variablesOf(queued ? "enablePullRequestAutoMerge(" : "mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "MERGE" } },
      ]);
    }),
  );

  it.effect("passes an explicitly empty body when the proposed message only credits an agent", () =>
    Effect.gen(function* () {
      route(
        [
          "query PullRequestMergeMessage",
          mergeMessage("Co-authored-by: Claude <noreply@anthropic.com>"),
        ],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "merge",
        removeAgentCreditsOnMerge: true,
      });
      expect(variablesOf("mergePullRequest(")).toEqual([
        {
          input: {
            pullRequestId: "PR_7",
            mergeMethod: "MERGE",
            expectedHeadOid: "abc123",
            commitBody: "",
          },
        },
      ]);
    }),
  );

  it.effect("refuses to merge when the proposed message cannot be read", () =>
    Effect.gen(function* () {
      route(
        ["query PullRequestMergeMessage", { data: { repository: { pullRequest: null } } }],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* Effect.result(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          removeAgentCreditsOnMerge: true,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("merges at once when auto-merge is asked of a pull request that is ready now", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState({ mergeStateStatus: "CLEAN" })]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });

      expect(variablesOf("mergePullRequest(")).toEqual([
        { input: { pullRequestId: "PR_7", mergeMethod: "SQUASH" } },
      ]);
      expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
    }),
  );

  it.effect("does not approve action-required runs for a same-repository pull request", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                number: 7,
                title: "Pull request 7",
                url: "https://github.com/acme/web/pull/7",
                headRefName: "feat/page",
                headRefOid: "abc123",
                isCrossRepository: false,
                headRepositoryOwner: { __typename: "Organization", login: "acme" },
                baseRefName: "main",
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-02T00:00:00Z",
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("finds and approves every workflow waiting on a maintainer", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7]), workflowRuns([10, 11]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      yield* cli.runPullRequestAction({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        action: "approve-workflows",
      });

      expect(variablesOf("PullRequestHeads")[0]).toEqual({
        owner: "acme",
        name: "web",
        head: "feat/page",
      });
      expect(restCallsTo("actions/runs?")[0]?.path).toBe(
        "repos/acme/web/actions/runs?head_sha=abc123&branch=feat%2Fpage&event=pull_request&status=action_required&per_page=100&page=1",
      );
      expect(restCallsTo("/approve").map((call) => [call.method, call.path])).toEqual([
        ["POST", "repos/acme/web/actions/runs/10/approve"],
        ["POST", "repos/acme/web/actions/runs/11/approve"],
      ]);
      assert.strictEqual(restCallsTo("actions/runs?").length, 3);
    }),
  );

  it.effect("counts revalidated runs that wait on a maintainer as GitHub reports them", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7]), workflowRuns([]));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const runs = yield* cli
        .listWorkflowRunsRequiringApproval({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          headSha: "abc123",
          headBranch: "feat/page",
          headRepositoryOwner: "octocat",
          isCrossRepository: true,
        })
        .pipe(
          Effect.provideService(KnownWorkflowRuns, {
            headSha: "abc123",
            runs: [
              {
                id: 10,
                status: "completed",
                conclusion: "action_required",
                head_branch: "feat/page",
              },
              { id: 11, status: "completed", conclusion: "success", head_branch: "feat/page" },
            ],
          }),
        );

      expect(runs.map((run) => run.id)).toEqual([10]);
      assert.strictEqual(restCallsTo("actions/runs?").length, 0);
    }),
  );

  it.effect("refuses a stale workflow approval after the pull request head changes", () =>
    Effect.gen(function* () {
      let detailReads = 0;
      workflowApprovalRoutes(
        () => crossRepositoryDetail(++detailReads === 1 ? "abc123" : "def456"),
        heads([7]),
        workflowRuns([10]),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadChangedError",
        number: 7,
      });
      assert.strictEqual(detailReads, 2);
      expect(restCallsTo("/approve")).toEqual([]);
    }),
  );

  it.effect("reads workflow runs and their pull request scope concurrently", () =>
    Effect.gen(function* () {
      const headsStarted = yield* Deferred.make<void>();
      const runsStarted = yield* Deferred.make<void>();
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql"
          ? Deferred.succeed(headsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(runsStarted)),
              Effect.as(output(encodeJson(heads([7])))),
            )
          : Deferred.succeed(runsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(headsStarted)),
              Effect.as(output(encodeJson(workflowRuns([10])))),
            ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const runs = yield* cli.listWorkflowRunsRequiringApproval({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        headSha: "abc123",
        headBranch: "feat/page",
        headRepositoryOwner: "octocat",
        isCrossRepository: true,
      });

      expect(runs).toEqual([{ id: 10, name: "build", url: "https://example.com/10" }]);
    }),
  );

  it.effect("refuses workflow approval when one head belongs to several pull requests", () =>
    Effect.gen(function* () {
      workflowApprovalRoutes(() => crossRepositoryDetail(), heads([7, 8]), workflowRuns([]));
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
        reason: "head-not-unique",
        number: 7,
        observedCount: 2,
        limit: 1_000,
      });
      expect(error.message).toContain("instead of uniquely matching #7");
    }),
  );

  it.effect("refuses workflow approval when the head list stops before its end", () =>
    Effect.gen(function* () {
      const repeating = heads([7]);
      repeating.data.repository.pullRequests.pageInfo = {
        hasNextPage: true,
        endCursor: "same",
      } as never;
      workflowApprovalRoutes(() => crossRepositoryDetail(), repeating, workflowRuns([]));
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
        reason: "head-list-truncated",
      });
    }),
  );

  it.effect("refuses workflow approval when GitHub omits the head repository", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson(
              coreResponse({
                number: 7,
                title: "Pull request 7",
                url: "https://github.com/acme/web/pull/7",
                headRefName: "feat/page",
                headRefOid: "abc123",
                isCrossRepository: true,
                headRepositoryOwner: null,
                baseRefName: "main",
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-02T00:00:00Z",
              }),
            ),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "approve-workflows",
        }),
      );

      expect(error).toMatchObject({
        _tag: "GitHubWorkflowApprovalHeadUnavailableError",
        number: 7,
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
});
