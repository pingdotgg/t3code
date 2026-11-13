import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerSettings } from "@t3tools/contracts";
import * as ServerSettingsService from "../serverSettings.ts";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

import {
  project,
  changeRequest,
  hostedChangeRequest,
  requestFailed,
  makeService,
  batchedChangeRequest,
} from "./PullRequestService-fixtures.testkit.ts";

it.effect("a refresh or a finished turn drops the provider's own change request reads", () =>
  Effect.gen(function* () {
    const forgotten: Array<{ readonly repository: string; readonly number?: number } | undefined> =
      [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          forgetChangeRequestReads: (scope) => Effect.sync(() => void forgotten.push(scope)),
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    yield* service.invalidate({ reference });
    yield* service.refreshAfterTurn(reference.projectId);
    yield* service.invalidate({});

    assert.deepStrictEqual(forgotten, [
      { repository: "acme/web", number: 1 },
      undefined,
      undefined,
    ]);
  }),
);
it.effect("a read during a refresh cannot keep the provider's old change request", () =>
  Effect.gen(function* () {
    let hostTitle = "old";
    let held: string | undefined;
    let gate:
      | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
      | undefined;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          getChangeRequest: () =>
            Effect.sync(() => {
              held ??= hostTitle;
              return { ...hostedChangeRequest("body"), title: held };
            }),
          forgetChangeRequestReads: () =>
            Effect.gen(function* () {
              if (gate !== undefined) {
                yield* Deferred.succeed(gate.entered, undefined);
                yield* Deferred.await(gate.release);
              }
              held = undefined;
            }),
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const refreshWithReadInBetween = (refresh: Effect.Effect<void>) =>
      Effect.gen(function* () {
        gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
        const running = yield* refresh.pipe(Effect.forkChild());
        yield* Deferred.await(gate.entered);
        yield* service.detail(reference);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(running);
        gate = undefined;
      });

    assert.strictEqual((yield* service.detail(reference)).title, "old");
    hostTitle = "after turn";
    yield* refreshWithReadInBetween(service.refreshAfterTurn(reference.projectId));
    assert.strictEqual((yield* service.detail(reference)).title, "after turn");

    hostTitle = "after refresh";
    yield* refreshWithReadInBetween(service.invalidate({ reference }));
    assert.strictEqual((yield* service.detail(reference)).title, "after refresh");
  }),
);
it.effect("close and reopen notify subscribed readers after invalidating their cached state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let hostCalls = 0;
      let state: "open" | "closed" = "open";
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              Effect.succeed({ ...changeRequest(1, "2026-09-16T00:00:00.000Z"), state }),
            runAction: (input) =>
              Effect.sync(() => {
                state = input.action === "close" ? "closed" : "open";
              }),
            listChangeRequests: () => {
              hostCalls += 1;
              return Effect.succeed({ items: [], truncated: false, continues: false });
            },
          }),
        ],
      });

      yield* service.refreshAfterTurn(reference.projectId);
      yield* service.list({ state: "open" });
      assert.strictEqual((yield* service.summary(reference)).state, "open");
      for (const action of ["close", "reopen"] as const) {
        const refreshed = yield* service.subscribeRefreshes.pipe(
          Stream.drop(1),
          Stream.take(1),
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              yield* service.list({ state: "open" });
              return yield* service.summary(reference);
            }),
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* service.runAction({ ...reference, action });
        assert.strictEqual(
          Option.getOrThrow(yield* Fiber.join(refreshed)).state,
          action === "close" ? "closed" : "open",
        );
      }
      assert.strictEqual(hostCalls, 3);
    }),
  ),
);
it.effect("reads a host's repositories in one search, and files the rows back under each", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
          listChangeRequestsAcross: (input) => {
            asked.push(input.repositories);
            return Effect.succeed({
              items: [
                batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z"),
                batchedChangeRequest(2, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
              ],
              truncated: false,
            });
          },
        }),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [changeRequest(3, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [["pingdotgg/t3code", "acme/web"]]);
    assert.deepStrictEqual(separately, ["group/project"]);
    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 1],
        ["p1", 2],
        ["p3", 3],
      ],
    );
  }),
);
it.effect("carries every repository of a slice on from the oldest row in it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
        project({ id: "p3", title: "docs", workspaceRoot: "/c", repository: "acme/docs" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [
                batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z"),
                batchedChangeRequest(2, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
                batchedChangeRequest(3, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
              unresolved: ["acme/docs"],
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.isTrue(result.truncated);
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|2",
      "github.com acme/web": "2026-07-02T00:00:00Z|2|3",
    });
  }),
);
it.effect("carries a slice on without sending the rows it already sent", () =>
  Effect.gen(function* () {
    const cursors: Array<unknown> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestsAcross: (input) => {
            cursors.push(input.cursor);
            return Effect.succeed({
              items: [
                batchedChangeRequest(3, "acme/web", "2026-07-02T00:00:00Z"),
                batchedChangeRequest(4, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { "github.com acme/web": "2026-07-02T00:00:00Z|1|3" },
    });

    assert.deepStrictEqual(cursors, [{ updatedBefore: "2026-07-02T00:00:00Z", delivered: 1 }]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [4],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com acme/web": "2026-07-02T00:00:00Z|2|3,4",
    });
  }),
);
it.effect("reads a workspace larger than one search in chunks, and merges them", () =>
  Effect.gen(function* () {
    const asked: Array<number> = [];
    const service = yield* makeService({
      projects: Array.from({ length: 101 }, (_, index) =>
        project({
          id: `p${index}`,
          title: `repo ${index}`,
          workspaceRoot: `/w${index}`,
          repository: `acme/repo${index}`,
        }),
      ),
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestsAcross: (input) => {
            asked.push(input.repositories.length);
            return Effect.succeed({
              items: input.repositories.map((repository, index) =>
                batchedChangeRequest(index + 1, repository, "2026-07-02T00:00:00Z"),
              ),
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [100, 1]);
    assert.strictEqual(result.entries.length, 101);
  }),
);
it.effect("asks on its own for a repository a search could not vouch for", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return repository === "acme/docs"
              ? Effect.fail(requestFailed)
              : Effect.succeed({ items: [], truncated: false, continues: true });
          },
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z")],
              truncated: false,
              unresolved: ["acme/docs"],
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(separately, ["acme/docs"]);
    assert.deepStrictEqual(result.errors, [
      {
        projectId: "p2" as ProjectId,
        projectTitle: "docs",
        message: "acme/docs could not be read.",
      },
    ]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1],
    );
  }),
);
it.effect("believes a search's silence about a repository it vouches for", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(separately, []);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1],
    );
  }),
);
it.effect("fills in the line counts for the rows it is given", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestStats: (input) => {
            asked.push(input.changeRequests);
            return Effect.succeed([
              { repository: "acme/web", number: 1, additions: 12, deletions: 3 },
            ]);
          },
        }),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab")),
      ],
    });

    const result = yield* service.listStats({
      refs: [
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 },
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 2 },
        { projectId: "p2" as ProjectId, repository: "group/project", number: 3 },
        { projectId: "p1" as ProjectId, repository: "evil/repo", number: 4 },
      ],
    });

    assert.deepStrictEqual(asked, [
      [
        { repository: "acme/web", number: 1 },
        { repository: "acme/web", number: 2 },
      ],
    ]);
    assert.deepStrictEqual(result.stats, [
      {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        additions: 12,
        deletions: 3,
      },
    ]);
  }),
);
it.effect("reads the fresh diff when detail or summary discovers a changed revision", () =>
  Effect.gen(function* () {
    const summaryStarted = yield* Deferred.make<void>();
    const releaseSummary = yield* Deferred.make<void>();
    let revision = "2026-07-02T00:00:00Z";
    let patch = "old patch";
    let diffCalls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.sync(() => ({ ...hostedChangeRequest("body"), updatedAt: revision })),
          getChangeRequestSummary: () =>
            Effect.gen(function* () {
              const result = changeRequest(1, revision);
              yield* Deferred.succeed(summaryStarted, undefined);
              yield* Deferred.await(releaseSummary);
              return result;
            }),
          getDiff: () =>
            Effect.sync(() => {
              diffCalls += 1;
              return { patch, truncated: false, nextCursor: null };
            }),
        }),
      ],
    });

    const coldSummary = yield* service.summary(reference).pipe(Effect.forkChild());
    yield* Deferred.await(summaryStarted);
    yield* service.detail(reference);
    assert.strictEqual((yield* service.diff(reference)).patch, "old patch");
    revision = "2026-07-02T00:01:00Z";
    patch = "new patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.detail(reference);
    yield* Effect.yieldNow;
    assert.strictEqual((yield* service.detail(reference)).updatedAt, revision);
    yield* Deferred.succeed(releaseSummary, undefined);
    yield* Fiber.join(coldSummary);
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, "new patch");
    assert.strictEqual(diffCalls, 2);

    revision = "2026-07-02T00:02:00Z";
    patch = "summary-discovered patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, patch);
    assert.strictEqual(diffCalls, 3);
  }),
);
it.effect("keeps routed reads separate when the GitHub account changes", () =>
  Effect.gen(function* () {
    for (const operation of ["summary", "detail", "checks", "diff", "filesViewed"] as const) {
      let failing = false;
      let calls = 0;
      const read = () =>
        Effect.suspend(() => {
          calls += 1;
          return failing
            ? Effect.fail(requestFailed)
            : Effect.succeed(hostedChangeRequest("account A content"));
        });
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities: {
              ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
              viewedFiles: "host",
            },
            getFilesViewed: () =>
              read().pipe(
                Effect.as({
                  files: [{ path: "private.ts", state: "viewed" as const }],
                  truncated: false,
                }),
              ),
            getChangeRequestSummary: read,
            getChangeRequestChecks: read,
            getChangeRequest: read,
            getDiff: () =>
              read().pipe(
                Effect.as({ patch: "private patch", truncated: false, nextCursor: null }),
              ),
          }),
        ],
      });
      const readOperation = (input: Parameters<typeof service.diff>[0]) =>
        // @effect-diagnostics-next-line unnecessaryEffectGen:off - the generator unifies the per-operation union of Effect types, which Effect.asVoid cannot infer through.
        Effect.gen(function* () {
          yield* service[operation](input);
        });
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      yield* readOperation({ ...reference, expectedAccountId: "101" });
      failing = true;

      for (const allowStale of [false, true]) {
        const error = yield* Effect.flip(
          readOperation({ ...reference, expectedAccountId: "202", allowStale }),
        );
        assert.strictEqual(error._tag, "PullRequestOperationError");
      }
      assert.strictEqual(calls, 3);
    }
  }),
);
it.effect("isolates routed caches for two credentials belonging to the same account", () =>
  Effect.gen(function* () {
    for (const operation of [
      "summary",
      "detail",
      "checks",
      "diff",
      "preview",
      "filesViewed",
    ] as const) {
      let credential = "broad";
      let calls = 0;
      const read = () =>
        Effect.suspend(() => {
          calls += 1;
          return credential === "broad"
            ? Effect.succeed(hostedChangeRequest("private content"))
            : Effect.fail(requestFailed);
        });
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities: {
              ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
              viewedFiles: "host",
            },
            getFilesViewed: () =>
              read().pipe(
                Effect.as({
                  files: [{ path: "private.ts", state: "viewed" as const }],
                  truncated: false,
                }),
              ),
            withVerifiedCredential: (_, use) =>
              Effect.suspend(() =>
                use({
                  accountId: "101",
                  viewer: "octocat",
                  credentialFingerprint: credential,
                }),
              ),
            getChangeRequest: read,
            getChangeRequestChecks: read,
            getChangeRequestSummary: read,
            getDiff: () =>
              read().pipe(
                Effect.as({ patch: "private patch", truncated: false, nextCursor: null }),
              ),
            getChangeRequestPreview: read,
          }),
        ],
      });
      const readOperation = (input: Parameters<typeof service.diff>[0]) =>
        // @effect-diagnostics-next-line unnecessaryEffectGen:off - the generator unifies the per-operation union of Effect types, which Effect.asVoid cannot infer through.
        Effect.gen(function* () {
          yield* service[operation](input);
        });
      const reference = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        host: "github.com",
        expectedAccountId: "101",
      };
      if (operation === "checks") {
        yield* service.withRoutingCredential(reference, service.detail(reference));
      }
      yield* service.withRoutingCredential(reference, readOperation(reference));
      credential = "restricted";
      for (const allowStale of [false, true]) {
        const error = yield* Effect.flip(
          service.withRoutingCredential(reference, readOperation({ ...reference, allowStale })),
        );
        assert.strictEqual(error._tag, "PullRequestOperationError");
      }
      assert.strictEqual(calls, 3);
    }
  }),
);
it.effect("rejects mismatched routing credentials before use and preserves action errors", () =>
  Effect.gen(function* () {
    let operations = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getRoutingIdentity: () => Effect.succeed({ accountId: "101", viewer: "octocat" }),
          withVerifiedCredential: (_, use) =>
            use({
              accountId: "101",
              viewer: "octocat",
              credentialFingerprint: "credential-a",
            }),
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      host: "github.com",
      expectedAccountId: "202",
    };
    const actionError = new PullRequestOperationError({
      operation: "runAction",
      detail: "ambiguous",
    });
    const operation = Effect.sync(() => {
      operations += 1;
    }).pipe(Effect.andThen(Effect.fail(actionError)));
    const rejected = yield* Effect.flip(service.withRoutingCredential(reference, operation));
    assert.strictEqual(rejected._tag, "PullRequestOperationError");
    if (rejected._tag === "PullRequestOperationError")
      assert.strictEqual(rejected.operation, "routeIdentity");
    assert.strictEqual(operations, 0);
    assert.strictEqual(
      yield* Effect.flip(
        service.withRoutingCredential({ ...reference, expectedAccountId: "101" }, operation),
      ),
      actionError,
    );
    assert.strictEqual(operations, 1);
    assert.deepStrictEqual(yield* service.routingIdentity({ host: "github.com" }), {
      accountId: "101",
      viewer: "octocat",
      host: "github.com",
      provider: "github",
    });
  }),
);
