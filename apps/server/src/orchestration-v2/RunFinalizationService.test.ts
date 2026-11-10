import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
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

// Without a project the observer never touches enrichment, so its methods stay unimplemented.
const layerNoProject = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
);

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
        layerNoProject,
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
        layerNoProject,
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
        layerNoProject,
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

it.effect("resolves the identity of a project whose remote was added during the turn", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-run-finalization-identity-test-",
    });
    const git = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const processRunner = yield* ProcessRunner.ProcessRunner;
        return yield* processRunner.run({ command: "git", args: ["-C", workspaceRoot, ...args] });
      }).pipe(Effect.provide(ProcessRunner.layer));
    yield* git(["init"]);

    const projectId = ProjectId.make("project-remote-added");
    const threadId = ThreadId.make("thread-remote-added");
    const runId = RunId.make("completed-run");
    const layerEnrichment = Layer.effect(
      ProjectEnrichment.ProjectEnrichmentService,
      ProjectEnrichment.make(),
    ).pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      ),
    );
    const layer = RunFinalization.layerObserver.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerEnrichment,
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          Layer.mock(PullRequestService.PullRequestService)({
            refreshAfterTurn: () => Effect.void,
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
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                projectId,
                branch: "main",
                worktreePath: null,
                activeRunId: null,
              } as OrchestrationV2ThreadShell),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ id: projectId, workspaceRoot } as Project),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
      // A shell read before the turn caches the folder as having no repository.
      assert.isNull(yield* enrichment.readRepositoryIdentity(workspaceRoot));

      yield* git(["remote", "add", "origin", "https://github.com/t3-triage/example-29929.git"]);
      const changes = yield* enrichment.subscribeChanges;
      const observer = yield* RunFinalization.RunFinalizationObserver;
      yield* observer.refresh({ cwd: workspaceRoot, threadId, runId });

      // The refresh runs in the background; until it publishes, the cached null still reads as resolved.
      const change = yield* PubSub.take(changes);
      assert.strictEqual(
        change.enrichment.repositoryIdentity?.locator.remoteUrl,
        "https://github.com/t3-triage/example-29929.git",
        "the project's repository identity is still null after the turn added a remote",
      );
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const stubbedIdentityProject = {
  projectId: ProjectId.make("project-stubbed-identity"),
  threadId: ThreadId.make("thread-stubbed-identity"),
  runId: RunId.make("completed-run"),
  workspaceRoot: "/repo-stubbed-identity",
};
const stubbedIdentity: RepositoryIdentity = {
  canonicalKey: "example.test/stubbed-identity",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://example.test/stubbed-identity.git",
  },
};

const layerStubbedIdentityResolver = (
  resolve: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"],
) =>
  RunFinalization.layerObserver.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make()).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, { resolve }),
              Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
                invalidate: () => Effect.void,
                resolvePath: () => Effect.succeed(null),
              }),
            ),
          ),
        ),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: stubbedIdentityProject.threadId,
              projectId: stubbedIdentityProject.projectId,
              branch: "main",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: stubbedIdentityProject.projectId,
              workspaceRoot: stubbedIdentityProject.workspaceRoot,
            } as Project),
        }),
      ),
    ),
  );

it.effect("returns from the post-turn refresh while the identity resolver is still running", () => {
  const { workspaceRoot, threadId, runId } = stubbedIdentityProject;
  const releaseResolver = Deferred.makeUnsafe<void>();
  let remoteAdded = false;
  return Effect.gen(function* () {
    const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
    assert.isNull(yield* enrichment.readRepositoryIdentity(workspaceRoot));
    const changes = yield* enrichment.subscribeChanges;
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const refresh = yield* observer
      .refresh({ cwd: workspaceRoot, threadId, runId })
      .pipe(Effect.timeoutOption("1 minute"), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    assert.isTrue(
      Option.isSome(yield* Fiber.join(refresh)),
      "turn finalization waited on the identity resolver, blocking the thread's next turn",
    );

    yield* Deferred.succeed(releaseResolver, undefined);
    const change = yield* PubSub.take(changes);
    assert.strictEqual(
      change.enrichment.repositoryIdentity?.canonicalKey,
      stubbedIdentity.canonicalKey,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerStubbedIdentityResolver((_cwd, options) =>
        options?.refresh
          ? Deferred.await(releaseResolver).pipe(
              Effect.map(() => {
                remoteAdded = true;
                return stubbedIdentity;
              }),
            )
          : Effect.sync(() => (remoteAdded ? stubbedIdentity : null)),
      ),
    ),
  );
});
