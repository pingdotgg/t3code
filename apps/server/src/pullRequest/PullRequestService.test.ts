import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistence from "effect/unstable/persistence/Persistence";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import { GitHubApiUsageLive, GitHubApiUsage } from "../gitHubUsage/GitHubApiUsage.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

const project: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "Web",
  workspaceRoot: "/workspace/web",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: "github",
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T00:00:00Z",
};

const teamRequestedChange: ProviderChangeRequest = {
  number: 42,
  title: "Review me",
  url: "https://github.com/acme/web/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feature/review",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T01:00:00Z",
  reviewRequestLogins: [],
  hasTeamReviewRequest: true,
  labels: [],
};

const detailedChange: ProviderChangeRequestDetail = {
  ...teamRequestedChange,
  body: "Description",
  changedFiles: 3,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewerPermissions: {
    actions: ["merge", "ready", "draft", "close", "reopen"],
    comment: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: true,
  },
};

function provider(): PullRequestProviderApi {
  return providerWith();
}

function providerWith(overrides: Partial<PullRequestProviderApi> = {}): PullRequestProviderApi {
  return {
    kind: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge", "squash", "rebase"],
      search: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getViewer: () => Effect.succeed("bilal"),
    listChangeRequests: () =>
      Effect.succeed({ items: [teamRequestedChange], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    submitReview: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    ...overrides,
  };
}

function makeService(
  input: {
    readonly project?: OrchestrationProjectShell;
    readonly provider?: PullRequestProviderApi;
    readonly readCache?: PullRequestReadCache.PullRequestReadCache["Service"];
  } = {},
) {
  const readCacheLayer =
    input.readCache === undefined
      ? Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(Persistence.layerKvs),
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        )
      : Layer.succeed(PullRequestReadCache.PullRequestReadCache, input.readCache);
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders([input.provider ?? provider()])),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [input.project ?? project],
              threads: [],
              updatedAt: "2026-08-10T00:00:00Z",
            }),
        }),
        readCacheLayer,
      ),
    ),
  );
}

it.effect("records cache-served reads separately from outbound traffic", () =>
  Effect.gen(function* () {
    const readCacheLayer = Layer.effect(
      PullRequestReadCache.PullRequestReadCache,
      PullRequestReadCache.make,
    ).pipe(
      Layer.provide(Persistence.layerKvs),
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(NodeServices.layer),
    );
    const live = (() => {
      const deps = Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders([provider()])),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [],
              updatedAt: "2026-08-10T00:00:00Z",
            }),
        }),
        readCacheLayer,
        // One shared instance: the same layer object below is memoized into
        // a single store for both the service and the report reader.
        GitHubApiUsageLive,
      );
      return Layer.mergeAll(PullRequestService.layer.pipe(Layer.provide(deps)), GitHubApiUsageLive);
    })();
    const program = Effect.gen(function* () {
      const service = yield* PullRequestService.PullRequestService;
      const usage = yield* GitHubApiUsage;
      // The fake provider never touches `gh`, so the miss records nothing and
      // the TTL hit records a cache-served read with zero invocations.
      yield* service.list({ state: "open" });
      yield* service.list({ state: "open" });
      return yield* usage.report({ window: "5m" });
    }).pipe(Effect.provide(live));
    const report = yield* program;
    assert.strictEqual(report.totals.invocations, 0);
    assert.strictEqual(report.totals.servedFromCache, 1);
    assert.strictEqual(report.totals.httpRequests, 0);
    assert.strictEqual(report.byFeature[0]?.key, "list");
    assert.strictEqual(report.byFeature[0]?.cacheHits, 1);
  }),
);

it.effect("marks a team request only on a server-selected Reviewing result", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const all = yield* service.list({ state: "open", involvement: "all" });
    const reviewing = yield* service.list({ state: "open", involvement: "reviewing" });

    assert.strictEqual(all.entries[0]?.viewerReviewRequested, false);
    assert.strictEqual(reviewing.entries[0]?.viewerReviewRequested, true);
  }),
);

it.effect("refuses a mutation that names a repository outside the selected project", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const error = yield* service
      .comment({
        projectId: project.id,
        repository: "attacker/repository",
        number: 42,
        body: "Please merge this.",
      })
      .pipe(Effect.flip);

    if (error._tag !== "PullRequestOperationError") {
      assert.fail(`Expected PullRequestOperationError, got ${error._tag}`);
    }
    assert.strictEqual(error.operation, "resolveRepository");
  }),
);

it.effect("returns large diff slices intact without retaining them in either cache", () =>
  Effect.gen(function* () {
    let reads = 0;
    const patch = "\u{1f4bb}".repeat(140_000);
    const service = yield* makeService({
      provider: providerWith({
        getDiff: () =>
          Effect.sync(() => {
            reads += 1;
            return { patch, truncated: false, nextCursor: "2" };
          }),
      }),
    });
    const reference = { projectId: project.id, repository: "acme/web", number: 1 };

    for (const input of [
      reference,
      { ...reference, cursor: "2" },
      { ...reference, commit: "a".repeat(40) },
    ]) {
      const before = reads;
      assert.deepStrictEqual(yield* service.diff(input), {
        patch,
        truncated: false,
        nextCursor: "2",
      });
      assert.deepStrictEqual(yield* service.diff(input), {
        patch,
        truncated: false,
        nextCursor: "2",
      });
      assert.strictEqual(reads, before + 2);
    }
  }),
);

it.effect("caches a small replacement after releasing a large diff", () =>
  Effect.gen(function* () {
    let reads = 0;
    const largePatch = "x".repeat(300_000);
    const service = yield* makeService({
      provider: providerWith({
        getDiff: () =>
          Effect.sync(() => {
            reads += 1;
            return {
              patch: reads === 1 ? largePatch : "@@ small replacement",
              truncated: false,
              nextCursor: null,
            };
          }),
      }),
    });
    const reference = { projectId: project.id, repository: "acme/web", number: 1 };

    assert.strictEqual((yield* service.diff(reference)).patch, largePatch);
    assert.strictEqual((yield* service.diff(reference)).patch, "@@ small replacement");
    assert.strictEqual((yield* service.diff(reference)).patch, "@@ small replacement");
    assert.strictEqual(reads, 2);
  }),
);

it.effect("scopes viewer discovery to the project's GitHub host", () =>
  Effect.gen(function* () {
    const viewerInputs: Array<{ readonly cwd: string; readonly host: string }> = [];
    const enterpriseProject: OrchestrationProjectShell = {
      ...project,
      workspaceRoot: "/workspace/enterprise",
      repositoryIdentity: {
        ...project.repositoryIdentity!,
        canonicalKey: "github.example.test/acme/web",
      },
    };
    const service = yield* makeService({
      project: enterpriseProject,
      provider: providerWith({
        getViewer: (input) => {
          viewerInputs.push(input);
          return Effect.succeed("enterprise-user");
        },
      }),
    });

    yield* service.list({ state: "open" });

    assert.deepStrictEqual(viewerInputs, [
      { cwd: "/workspace/enterprise", host: "github.example.test" },
    ]);
  }),
);

it.effect("reuses detail counts for later list stats reads", () =>
  Effect.gen(function* () {
    let statsCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequest: () => Effect.succeed(detailedChange),
        listChangeRequestStats: () => {
          statsCalls += 1;
          return Effect.succeed([
            { repository: "acme/web", number: 42, additions: 1, deletions: 0 },
          ]);
        },
      }),
    });

    yield* service.detail(reference);
    const stats = yield* service.listStats({ refs: [reference] });

    assert.strictEqual(statsCalls, 0);
    assert.deepStrictEqual(stats.stats, [
      { projectId: project.id, repository: "acme/web", number: 42, additions: 1, deletions: 0 },
    ]);
  }),
);

it.effect("serves stale list stats while refreshing an expired batch", () =>
  Effect.gen(function* () {
    let statsCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        listChangeRequestStats: () =>
          Effect.sync(() => {
            statsCalls += 1;
            return [{ repository: "acme/web", number: 42, additions: 1, deletions: 0 }];
          }),
      }),
    });

    const first = yield* service.listStats({ refs: [reference] });
    assert.strictEqual(statsCalls, 1);

    yield* TestClock.adjust("61 seconds");
    const second = yield* service.listStats({ refs: [reference] });
    assert.deepStrictEqual(second, first);

    yield* Effect.yieldNow;
    assert.strictEqual(statsCalls, 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("coalesces concurrent stale reads into one host request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let statsCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        listChangeRequestStats: () => {
          statsCalls += 1;
          const result = [
            { repository: "acme/web", number: 42, additions: statsCalls, deletions: 0 },
          ];
          return statsCalls === 1
            ? Effect.succeed(result)
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(result),
              );
        },
      }),
    });

    const initial = yield* service.listStats({ refs: [reference] });
    assert.strictEqual(statsCalls, 1);
    yield* TestClock.adjust("61 seconds");
    assert.deepStrictEqual(yield* service.listStats({ refs: [reference] }), initial);
    yield* Effect.yieldNow;
    yield* Deferred.await(started);

    const concurrent = yield* Effect.all(
      [service.listStats({ refs: [reference] }), service.listStats({ refs: [reference] })],
      { concurrency: 2 },
    );
    assert.deepStrictEqual(concurrent, [initial, initial]);
    assert.strictEqual(statsCalls, 2);

    yield* Deferred.succeed(release, undefined);
    yield* Effect.yieldNow;
    assert.strictEqual(statsCalls, 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not extend a stale detail window with background refreshes", () =>
  Effect.gen(function* () {
    let detailCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequest: () =>
          Effect.sync(() => {
            detailCalls += 1;
            return { ...detailedChange, title: `Review ${detailCalls}` };
          }),
      }),
    });

    assert.strictEqual((yield* service.detail(reference)).title, "Review 1");
    for (let expectedFreshRead = 2; expectedFreshRead <= 5; expectedFreshRead += 1) {
      yield* TestClock.adjust("61 seconds");
      const stale = yield* service.detail(reference);
      assert.strictEqual(stale.title, `Review ${expectedFreshRead - 1}`);
      yield* Effect.yieldNow;
      assert.strictEqual(detailCalls, expectedFreshRead);
    }

    // Background refreshes cannot restart the five-minute stale window. This read must wait for
    // the host instead of returning the last background value immediately.
    yield* TestClock.adjust("61 seconds");
    const fresh = yield* service.detail(reference);
    assert.strictEqual(detailCalls, 6);
    assert.strictEqual(fresh.title, "Review 6");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("invalidates the affected persisted read keys exactly once per mutation", () =>
  Effect.gen(function* () {
    const invalidatedKeys: Array<ReadonlyArray<string> | undefined> = [];
    const readCache = PullRequestReadCache.PullRequestReadCache.of({
      get: (_key, lookup) => lookup,
      invalidate: (key) =>
        Effect.sync(() => {
          invalidatedKeys.push(key);
        }),
    });
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({ readCache });

    yield* service.comment({ ...reference, body: "First write." });
    yield* service.submitReview({
      ...reference,
      verdict: "comment",
      body: "Second write.",
      comments: [],
    });

    assert.strictEqual(invalidatedKeys.length, 2);
    assert.deepStrictEqual(
      invalidatedKeys.map((keys) => keys?.length),
      [2, 2],
    );

    const failedService = yield* makeService({
      readCache,
      provider: providerWith({
        comment: () =>
          Effect.fail(
            new PullRequestProviderError({
              provider: "github",
              operation: "comment",
              reason: "failed",
              detail: "The comment was rejected.",
            }),
          ),
      }),
    });
    yield* failedService.comment({ ...reference, body: "Rejected write." }).pipe(Effect.flip);
    assert.strictEqual(invalidatedKeys.length, 3);

    yield* service.invalidate({ reference });
    yield* service.invalidate({});
    assert.strictEqual(invalidatedKeys.length, 5);
    assert.strictEqual(invalidatedKeys[3]?.length, 2);
    assert.isUndefined(invalidatedKeys[4]);
  }),
);

it.effect("keeps another pull request's persisted detail warm after a mutation", () => {
  const readCacheLayer = Layer.effect(
    PullRequestReadCache.PullRequestReadCache,
    PullRequestReadCache.make,
  ).pipe(
    Layer.provide(Persistence.layerKvs),
    Layer.provide(KeyValueStore.layerMemory),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    let detailCalls = 0;
    const readCache = yield* PullRequestReadCache.PullRequestReadCache;
    const serviceProvider = providerWith({
      getChangeRequest: () =>
        Effect.sync(() => {
          detailCalls += 1;
          return detailedChange;
        }),
    });
    const firstService = yield* makeService({ provider: serviceProvider, readCache });
    const secondService = yield* makeService({ provider: serviceProvider, readCache });
    const first = { projectId: project.id, repository: "acme/web", number: 42 };
    const second = { ...first, number: 43 };

    yield* firstService.detail(first);
    yield* firstService.detail(second);
    assert.strictEqual(detailCalls, 2);

    yield* firstService.comment({ ...first, body: "Refresh only this change request." });
    yield* secondService.detail(second);
    assert.strictEqual(detailCalls, 2);

    yield* secondService.detail(first);
    assert.strictEqual(detailCalls, 3);
  }).pipe(Effect.provide(readCacheLayer));
});

it.effect("keeps listings cached for mutations that only change one pull request", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    let activityCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        listChangeRequests: () => {
          listCalls += 1;
          return Effect.succeed({
            items: [teamRequestedChange],
            truncated: false,
            continues: true,
          });
        },
        getChangeRequestActivity: () => {
          activityCalls += 1;
          return Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [
              {
                id: "thread-on-pr",
                path: "src/file.ts",
                line: 1,
                side: "right",
                isResolved: false,
                isOutdated: false,
                comments: [],
              },
            ],
            commits: [],
          });
        },
      }),
    });

    const assertReferenceInvalidated = (expectedActivityCalls: number) =>
      Effect.gen(function* () {
        yield* service.list({ state: "open" });
        assert.strictEqual(listCalls, 1);
        yield* service.activity(reference);
        assert.strictEqual(activityCalls, expectedActivityCalls);
      });

    yield* service.list({ state: "open" });
    yield* service.activity(reference);
    assert.strictEqual(listCalls, 1);
    assert.strictEqual(activityCalls, 1);

    yield* service.comment({ ...reference, body: "Please update this." });
    yield* assertReferenceInvalidated(2);

    yield* service.submitReview({
      ...reference,
      verdict: "comment",
      body: "Please update this.",
      comments: [],
    });
    yield* assertReferenceInvalidated(3);

    yield* service.replyToThread({
      ...reference,
      threadId: "thread-on-pr",
      body: "Resolved in the latest commit.",
    });
    yield* assertReferenceInvalidated(4);

    yield* service.setThreadResolution({
      ...reference,
      threadId: "thread-on-pr",
      resolved: true,
    });
    yield* assertReferenceInvalidated(5);

    yield* service.requestReviewers({
      ...reference,
      reviewers: [{ id: "reviewer", kind: "user" }],
      requested: true,
    });
    yield* assertReferenceInvalidated(6);

    yield* service.runAction({ ...reference, action: "close" });
    yield* service.list({ state: "open" });
    yield* service.activity(reference);
    assert.strictEqual(listCalls, 2);
    assert.strictEqual(activityCalls, 7);
  }),
);

it.effect(
  "answers a conversation poll inside the client's refresh interval without spending a host read",
  () =>
    Effect.gen(function* () {
      let activityCalls = 0;
      const reference = { projectId: project.id, repository: "acme/web", number: 42 };
      const service = yield* makeService({
        provider: providerWith({
          getChangeRequestActivity: () => {
            activityCalls += 1;
            return Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            });
          },
        }),
      });

      yield* service.activity(reference);
      assert.strictEqual(activityCalls, 1);

      // The focused detail panel re-reads its conversation every 30s. A cache shorter than that
      // interval is read exactly once and then misses forever, so each poll becomes a fresh host
      // read — a conversation read is the most expensive one on the page, because it walks review
      // threads and their comments.
      yield* TestClock.adjust("31 seconds");
      yield* service.activity(reference);
      assert.strictEqual(activityCalls, 1);

      // A second surface opening the same conversation inside the window must not spend anything.
      yield* TestClock.adjust("5 seconds");
      yield* service.activity(reference);
      assert.strictEqual(activityCalls, 1);

      // Past both cache layers it does refresh, or the conversation would never update. The
      // persisted layer holds a read for a minute, so the refresh lands after that.
      yield* TestClock.adjust("30 seconds");
      yield* service.activity(reference);
      assert.strictEqual(activityCalls, 2);
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("holds a rate-limit failure briefly instead of calling gh on every read", () =>
  Effect.gen(function* () {
    let detailCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequest: () => {
          detailCalls += 1;
          return Effect.fail(
            new PullRequestProviderError({
              provider: "github",
              operation: "getChangeRequest",
              reason: "failed",
              detail:
                "GitHub API rate limit exceeded. Pull-request reads are paused briefly and resume on their own.",
            }),
          );
        },
      }),
    });

    const first = yield* service.detail(reference).pipe(Effect.flip);
    assert.strictEqual(first._tag, "PullRequestOperationError");
    assert.strictEqual(detailCalls, 1);

    // The second read shares the held failure: no new `gh` call.
    const second = yield* service.detail(reference).pipe(Effect.flip);
    assert.strictEqual(second._tag, "PullRequestOperationError");
    assert.strictEqual(detailCalls, 1);

    // Past the cooldown the next read tries the host again.
    yield* TestClock.adjust("61 seconds");
    yield* Effect.yieldNow;
    const third = yield* service.detail(reference).pipe(Effect.flip);
    assert.strictEqual(third._tag, "PullRequestOperationError");
    assert.strictEqual(detailCalls, 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not hold ordinary failures", () =>
  Effect.gen(function* () {
    let detailCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequest: () => {
          detailCalls += 1;
          return Effect.fail(
            new PullRequestProviderError({
              provider: "github",
              operation: "getChangeRequest",
              reason: "failed",
              detail: "GitHub CLI returned an unreadable getChangeRequest response.",
            }),
          );
        },
      }),
    });

    yield* service.detail(reference).pipe(Effect.flip);
    yield* service.detail(reference).pipe(Effect.flip);
    assert.strictEqual(detailCalls, 2);
  }),
);

it.effect("mutates only review threads proven to belong to the selected pull request", () =>
  Effect.gen(function* () {
    const replies: string[] = [];
    const resolutions: string[] = [];
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequestActivity: () =>
          Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [
              {
                id: "thread-on-pr",
                path: "src/file.ts",
                line: 1,
                side: "right",
                isResolved: false,
                isOutdated: false,
                comments: [],
              },
            ],
            commits: [],
          }),
        replyToThread: (input) => {
          replies.push(input.threadId);
          return Effect.void;
        },
        setThreadResolution: (input) => {
          resolutions.push(input.threadId);
          return Effect.void;
        },
      }),
    });

    yield* service.replyToThread({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      body: "Resolved in the latest commit.",
    });
    yield* service.setThreadResolution({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      resolved: true,
    });

    const replyError = yield* service
      .replyToThread({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        body: "This must not be sent.",
      })
      .pipe(Effect.flip);
    const resolutionError = yield* service
      .setThreadResolution({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        resolved: true,
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(replies, ["thread-on-pr"]);
    assert.deepStrictEqual(resolutions, ["thread-on-pr"]);
    assert.strictEqual(replyError._tag, "PullRequestOperationError");
    assert.strictEqual(resolutionError._tag, "PullRequestOperationError");
  }),
);
