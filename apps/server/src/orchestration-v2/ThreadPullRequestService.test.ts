import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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

  it.effect("an event for one thread reads that thread's shell, not every thread's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadShell("updated-thread");
        const other = threadShell("other-thread");
        const activation = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        // Each read: the thread id for a one-thread read, or the full read's options.
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
          // Startup backfill reads every active thread.
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
                  // The fake honors unsettledOnly like the store does.
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
          // Backfill finds the settled branch thread and must read it again.
          expect(yield* Queue.take(reads)).toEqual({ location: "active", unsettledOnly: false });
          yield* service.drain;
          // Its project is gone, so backfill finishes it on the first pass.
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(reads)).toEqual({ location: "active", unsettledOnly: true });
          yield* service.drain;
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );
});

describe("ThreadPullRequestServiceV2 restore guard", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const PROJECT_ID = ProjectId.make("project-restore-guard");

  const project: OrchestrationProjectShell = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  // A branch `git.branchPullRequest` no longer matches (already merged and
  // outgrown), still saved from before the branch moved past it.
  const savedReference: ThreadLinkedPullRequest = {
    projectId: PROJECT_ID,
    repository: "pingdotgg/t3code",
    number: 3,
    url: "https://github.com/pingdotgg/t3code/pull/3",
  };

  const thread: OrchestrationV2ThreadShell = {
    id: ThreadId.make("outgrown-thread"),
    projectId: PROJECT_ID,
    title: "outgrown-thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "develop",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("outgrown-thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
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
    branchPullRequest: savedReference,
  };

  function makePullRequestSummary(): {
    provider: "github";
    projectId: ProjectId;
    repository: string;
    number: number;
    title: string;
    url: string;
    state: "merged";
    headBranch: string;
    baseBranch: string;
    updatedAt: string;
    closedAt: null;
    mergedAt: string;
  } {
    return {
      provider: "github",
      projectId: savedReference.projectId,
      repository: savedReference.repository,
      number: savedReference.number,
      title: "Release develop into main",
      url: savedReference.url,
      state: "merged",
      headBranch: "develop",
      baseBranch: "main",
      updatedAt: "2026-04-02T15:00:00.000Z",
      closedAt: null,
      mergedAt: "2026-04-02T15:00:00.000Z",
    };
  }

  // `git.branchPullRequest` reports nothing (the branch moved past that
  // release PR); `git.branchSupersededPullRequest` says whether that is why.
  const runSynchronize = (branchSuperseded: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const activation = yield* Deferred.make<void>();
        const commands = yield* Ref.make<ReadonlyArray<{ readonly branchPullRequest: unknown }>>(
          [],
        );
        const summaryCalls = yield* Ref.make(0);
        // `service.start()` forks the startup backfill sweep into the
        // background rather than awaiting it, so `service.drain` right after
        // `start()` can race it (same as the "reads" tests above, which
        // synchronize on their own `reads` queue before draining). Signal
        // from the snapshot read the sweep always makes first.
        const sweepStarted = yield* Queue.unbounded<void>();

        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getShellSnapshot: () =>
              Queue.offer(sweepStarted, undefined).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread],
                  archivedThreads: [],
                }),
              ),
            getThreadEventSequence: () => Effect.succeed(1),
            getThreadShell: () => Effect.succeed(thread),
            dispatch: (command) =>
              command.type === "thread.pull-request.sync"
                ? Ref.update(commands, (recorded) => [
                    ...recorded,
                    { branchPullRequest: command.branchPullRequest },
                  ]).pipe(Effect.as({ sequence: 1, storedEvents: [] }))
                : Effect.die(new Error(`Unexpected command: ${command.type}`)),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(GitManager.GitManager)({
            // Nothing found by a fresh lookup: the thread's saved reference is
            // not what the branch currently matches, superseded or not.
            branchPullRequest: () => Effect.succeed(null),
            branchSupersededPullRequest: () => Effect.succeed(branchSuperseded),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            summary: () =>
              Ref.update(summaryCalls, (count) => count + 1).pipe(
                Effect.as(makePullRequestSummary()),
              ),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
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

        const service = yield* ThreadPullRequestService.make.pipe(Effect.provide(dependencies));
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(sweepStarted);
        yield* service.drain;

        return {
          commands: yield* Ref.get(commands),
          summaryCalls: yield* Ref.get(summaryCalls),
        };
      }),
    );

  it.effect(
    "clears a thread's saved branchPullRequest instead of restoring it once the branch has outgrown it",
    () =>
      Effect.gen(function* () {
        const { commands, summaryCalls } = yield* runSynchronize(true);

        // The guard answers the question itself; restoring a merged/closed
        // reference without checking it first is exactly the bug being
        // guarded against, so this would also catch a regression that calls
        // through regardless of the guard's answer.
        expect(summaryCalls).toBe(0);
        expect(commands).toHaveLength(1);
        expect(commands[0]?.branchPullRequest).toBeNull();
      }),
  );

  it.effect("still restores the saved branchPullRequest when the branch has not outgrown it", () =>
    Effect.gen(function* () {
      const { commands, summaryCalls } = yield* runSynchronize(false);

      // Restoring here reproduces the saved reference exactly, so the
      // thread is already up to date and nothing is dispatched.
      expect(summaryCalls).toBe(1);
      expect(commands).toHaveLength(0);
    }),
  );
});
