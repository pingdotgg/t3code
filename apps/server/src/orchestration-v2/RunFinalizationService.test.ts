import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  SourceControlProviderKind,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              captured.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
              checkpoints: [],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () =>
            Effect.gen(function* () {
              captured.push("refresh");
              return yield* new RunFinalization.RunFinalizationRefreshError({
                cwd: "/repo",
                cause: new Error("Git command timed out"),
              });
            }),
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(captured, ["checkpoint", "refresh"]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const lookedUp = Deferred.makeUnsafe<void>();
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          // Requested synchronously by refresh; the lookup itself runs in the background.
          refreshPullRequestStatus: (cwd) => {
            refreshed.push(cwd);
            return Deferred.succeed(lookedUp, undefined).pipe(Effect.as(null));
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    if (scenario.expected.length > 0) yield* Deferred.await(lookedUp);
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

it.effect("returns from the post-turn refresh without waiting for the PR lookup", () => {
  const threadId = ThreadId.make("thread-slow-forge");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "feature",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: () => Effect.never,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "feature",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const refresh = yield* observer
      .refresh({ cwd: "/repo", threadId, runId })
      .pipe(Effect.timeoutOption("1 minute"), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(refresh);
    assert.isTrue(
      Option.isSome(result),
      "turn finalization waited on the forge PR lookup, blocking the thread's next turn",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("replaces a still-running PR lookup when a newer turn finishes", () => {
  const threadId = ThreadId.make("thread-back-to-back");
  const runId = RunId.make("completed-run");
  const firstInterrupted = Deferred.makeUnsafe<void>();
  const secondLookedUp = Deferred.makeUnsafe<void>();
  let lookups = 0;
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "feature",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: () =>
            ++lookups === 1
              ? Effect.never.pipe(
                  Effect.onInterrupt(() => Deferred.succeed(firstInterrupted, undefined)),
                )
              : Deferred.succeed(secondLookedUp, undefined).pipe(Effect.as(null)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "feature",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    yield* Deferred.await(firstInterrupted);
    yield* Deferred.await(secondLookedUp);
    assert.strictEqual(lookups, 2);
  }).pipe(Effect.provide(layer));
});

it.live(
  "publishes a shell-added remote after a default-branch turn without waiting for the identity TTL",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* ProcessRunner.ProcessRunner;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-remote-" });
      const git = (args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args: ["-C", cwd, ...args] });
      yield* git(["init", "--initial-branch=main"]);
      const threadId = ThreadId.make("thread-publish-remote");
      const projectId = ProjectId.make("project-publish-remote");
      const runId = RunId.make("run-publish-remote");
      let hasRemote = false;
      const metadata = ProjectEnrichment.layer.pipe(
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provide(
          Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
            resolvePath: () => Effect.succeed(null),
            invalidate: () => Effect.void,
          }),
        ),
      );
      const layer = RunFinalization.layerObserver.pipe(
        Layer.provideMerge(metadata),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
            Layer.mock(PullRequestService.PullRequestService)({
              refreshAfterTurn: () => Effect.void,
            }),
            Layer.unwrap(
              Effect.gen(function* () {
                const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
                return Layer.mock(ProjectService.ProjectService)({
                  getById: () =>
                    enrichment.peek(cwd).pipe(
                      Effect.map((value) =>
                        Option.some({
                          id: projectId,
                          title: "Published project",
                          workspaceRoot: cwd,
                          repositoryIdentity: value.repositoryIdentity,
                          defaultModelSelection: null,
                          scripts: [],
                          createdAt: "2026-01-01T00:00:00.000Z",
                          updatedAt: "2026-01-01T00:00:00.000Z",
                          deletedAt: null,
                        }),
                      ),
                    ),
                });
              }),
            ).pipe(Layer.provide(metadata)),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () =>
                Effect.succeed({
                  id: threadId,
                  projectId,
                  branch: "main",
                  activeRunId: null,
                } as OrchestrationV2ThreadShell),
            }),
            Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
              refreshLocalStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: false,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  ...(hasRemote
                    ? {
                        sourceControlProvider: {
                          kind: SourceControlProviderKind.make("github"),
                          name: "GitHub",
                          baseUrl: "https://github.com",
                        },
                      }
                    : {}),
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const observer = yield* RunFinalization.RunFinalizationObserver;
        const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const changes = yield* enrichment.subscribeChanges;
        yield* enrichment.request(cwd);
        assert.isNull((yield* PubSub.take(changes)).enrichment.repositoryIdentity);
        yield* observer.refresh({ cwd, threadId, runId });
        yield* git(["remote", "add", "origin", "https://github.com/t3tools/turn-remote.git"]);
        hasRemote = true;
        assert.isNull(yield* resolver.resolve(cwd));
        assert.isNull((yield* enrichment.peek(cwd)).repositoryIdentity);
        yield* observer.refresh({ cwd, threadId, runId });
        const refreshed = yield* PubSub.take(changes);
        assert.equal(refreshed.workspaceRoot, cwd);
        assert.equal(
          refreshed.enrichment.repositoryIdentity?.canonicalKey,
          "github.com/t3tools/turn-remote",
        );
        assert.equal(
          (yield* enrichment.peek(cwd)).repositoryIdentity?.locator.remoteUrl,
          "https://github.com/t3tools/turn-remote.git",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it.effect("does not force a known identity when only the enrichment cache has expired", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-known-identity");
    const projectId = ProjectId.make("project-known-identity");
    const runId = RunId.make("run-known-identity");
    const checked = yield* Deferred.make<boolean>();
    let afterExpiry = false;
    const resolverLayer = Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: (_cwd, options) =>
        Effect.gen(function* () {
          if (afterExpiry) yield* Deferred.succeed(checked, options?.refresh === true);
          return {
            canonicalKey: "github.com/t3tools/known",
            rootPath: "/repo",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "https://github.com/t3tools/known.git",
            },
          };
        }),
    });
    const metadata = ProjectEnrichment.layer.pipe(
      Layer.provideMerge(resolverLayer),
      Layer.provide(
        Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
          resolvePath: () => Effect.succeed(null),
          invalidate: () => Effect.void,
        }),
      ),
    );
    const layer = RunFinalization.layerObserver.pipe(
      Layer.provideMerge(metadata),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          Layer.mock(PullRequestService.PullRequestService)({
            refreshAfterTurn: () => Effect.void,
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Known project",
                workspaceRoot: "/repo",
                repositoryIdentity: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({ id: threadId, projectId } as OrchestrationV2ThreadShell),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshLocalStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                sourceControlProvider: {
                  kind: SourceControlProviderKind.make("github"),
                  name: "GitHub",
                  baseUrl: "https://github.com",
                },
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
      const observer = yield* RunFinalization.RunFinalizationObserver;
      assert.isNotNull(yield* enrichment.readRepositoryIdentity("/repo"));
      yield* TestClock.adjust("1 minute");
      assert.isNull((yield* enrichment.peek("/repo")).repositoryIdentity);
      afterExpiry = true;
      yield* observer.refresh({ cwd: "/repo", threadId, runId });
      assert.isFalse(yield* Deferred.await(checked));
    }).pipe(Effect.provide(layer));
  }),
);
