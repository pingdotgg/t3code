import {
  EventId,
  SourceControlProviderError,
  SourceControlProviderKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it.effect("discovers a repository from a project shell without enrichment", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      let resolvedRoot: string | null = null;
      const result = yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(
        project,
        {
          resolve: (root) => {
            resolvedRoot = root;
            return Effect.succeed({
              canonicalKey: "github.com/pingdotgg/t3code",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:pingdotgg/t3code.git",
              },
              provider: "github" as const,
              displayName: "pingdotgg/t3code",
              owner: "pingdotgg",
              name: "t3code",
            });
          },
        },
      );
      expect(resolvedRoot).toBe("/workspace/project");
      expect(result.repository).toBe("pingdotgg/t3code");
      expect(result.project.repositoryIdentity?.canonicalKey).toBe("github.com/pingdotgg/t3code");
    }),
  );

  it.effect("refreshes the cached repository identity only when asked", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const refreshes: Array<boolean | undefined> = [];
      const resolver = {
        resolve: (_root: string, options?: { readonly refresh?: boolean }) => {
          refreshes.push(options?.refresh);
          return Effect.succeed(null);
        },
      };
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver);
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver, {
        refresh: true,
      });
      expect(refreshes).toEqual([false, true]);
    }),
  );

  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("rejects a pull-request result when the project was deleted before dispatch", () => {
    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        Option.none<Pick<OrchestrationProjectShell, "workspaceRoot">>(),
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("accepts a pull-request result while the project root is unchanged", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/original",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(true);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect.each(["pause", "unexpected", "interrupt"] as const)(
    "keeps %s discovery failures at the appropriate log level",
    (failure) => {
      const logs: Array<{ level: string; parts: ReadonlyArray<unknown> }> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        const parts = Array.isArray(message) ? message : [message];
        logs.push({ level: logLevel, parts });
      });
      const retryAt = DateTime.toEpochMillis(NOW) + 60_000;
      const paused = new SourceControlRateLimitPausedError({
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        retryAt,
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const thread = { ...threadShell("paused"), branch: "feature" };
          const activation = yield* Deferred.make<void>();
          const reads = yield* Queue.unbounded<void>();
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getShellSnapshot: () =>
                Queue.offer(reads, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: thread.projectId,
                    title: "Project",
                    workspaceRoot: "/workspace/project",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-09-20T00:00:00Z",
                    updatedAt: "2026-09-20T00:00:00Z",
                  },
                ]),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () =>
                failure === "interrupt"
                  ? Effect.interrupt
                  : Effect.fail(
                      new SourceControlProviderError({
                        provider: SourceControlProviderKind.make("github"),
                        operation: "listChangeRequests",
                        cwd: "/workspace/project",
                        detail: "paused",
                        cause:
                          failure === "pause"
                            ? new Error("provider wrapper", { cause: paused })
                            : new Error("unexpected host failure"),
                      }),
                    ),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/owner/repository",
                  provider: "github",
                  displayName: "owner/repository",
                  owner: "owner",
                  name: "repository",
                  locator: {
                    source: "git-remote",
                    remoteName: "origin",
                    remoteUrl: "https://github.com/owner/repository.git",
                  },
                }),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
            FileSystem.layerNoop({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Queue.take(reads);
            yield* service.drain;
            if (failure === "interrupt") {
              expect(logs).toEqual([]);
            } else if (failure === "pause") {
              expect(logs).toEqual([
                {
                  level: "Debug",
                  parts: [
                    "thread branch pull request lookup failed",
                    { threadIds: [thread.id], retryAt },
                  ],
                },
              ]);
            } else {
              expect(logs).toHaveLength(1);
              expect(logs[0]?.level).toBe("Warn");
              expect(logs[0]?.parts[0]).toBe("thread branch pull request lookup failed");
              expect(logs[0]?.parts[1]).toMatchObject({
                threadIds: [thread.id],
                cause: expect.stringContaining("unexpected host failure"),
              });
              expect(logs[0]?.parts[1]).toMatchObject({
                cause: expect.stringContaining("ThreadPullRequestService.test.ts:"),
              });
            }
          }).pipe(Effect.provide(dependencies));
        }),
      ).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    },
  );

  it.effect("an event for one thread reads that thread's shell, not every thread's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadShell("updated-thread");
        const other = threadShell("other-thread");
        const activation = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const reads = yield* Queue.unbounded<
          ThreadId | { readonly location?: string; readonly unsettledOnly?: boolean }
        >();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromPubSub(events),
            getShellSnapshot: (options) =>
              Queue.offer(reads, options ?? {}).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread, other],
                  archivedThreads: [],
                }),
              ),
            getThreadEventSequence: () => Effect.succeed(1),
            getThreadShell: (threadId) =>
              Queue.offer(reads, threadId).pipe(
                Effect.as([thread, other].find((candidate) => candidate.id === threadId) ?? null),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          expect(yield* Queue.take(reads)).toEqual({ location: "active", unsettledOnly: false });
          yield* service.drain;
          yield* PubSub.publish(events, {
            type: "thread.metadata-updated",
            id: EventId.make("event:metadata"),
            threadId: thread.id,
            occurredAt: NOW,
            payload: {
              createdBy: thread.createdBy,
              creationSource: thread.creationSource,
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              activeProviderThreadId: thread.activeProviderThreadId,
              lineage: thread.lineage,
              forkedFrom: null,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          expect(yield* Queue.take(reads)).toBe(thread.id);
          yield* service.drain;
          expect(yield* Queue.size(reads)).toBe(0);
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  it.effect("periodic sweeps read only unsettled threads once backfill is done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = {
          ...threadShell("settled-thread"),
          branch: "feature/settled",
          settledOverride: "settled" as const,
          settledAt: NOW,
        };
        const activation = yield* Deferred.make<void>();
        const reads = yield* Queue.unbounded<{
          readonly location?: string;
          readonly unsettledOnly?: boolean;
        }>();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getShellSnapshot: (options) =>
              Queue.offer(reads, options ?? {}).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: options?.unsettledOnly ? [] : [settled],
                  archivedThreads: [],
                }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          expect(yield* Queue.take(reads)).toEqual({ location: "active", unsettledOnly: false });
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(reads)).toEqual({ location: "active", unsettledOnly: true });
          yield* service.drain;
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );
});
