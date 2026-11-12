import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  type ThreadRepoWorktree,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const serviceWorktree: ThreadRepoWorktree = {
  repository: "service",
  repositoryPath: "/folder/service",
  worktreePath: "/worktrees/service/feature",
  branch: "feature",
  baseRef: null,
  origin: "created",
  attachedAt: "2026-07-28T00:00:00.000Z",
};

it.effect("gives each worktree its own path prefix, also when folder names match", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const worktree = (repository: string, worktreePath: string) => ({
      repository,
      repositoryPath: `/folder/${repository}`,
      worktreePath,
    });
    const prefixes = CheckpointService.repositoryPathPrefixes(path, [
      worktree("alpha", "/worktrees/one/shared"),
      worktree("alpha", "/worktrees/two/shared"),
      worktree("alpha", "/worktrees/shared-2"),
      worktree("beta", "/worktrees/beta/work"),
    ]);
    assert.deepEqual(
      [...prefixes.values()],
      ["alpha@shared", "alpha@shared-2", "alpha@shared-2-2", "beta"],
    );
    // Captured before prefixes were kept: both took `alpha`, and the first keeps it.
    const kept = CheckpointService.repositoryPathPrefixes(
      path,
      [worktree("alpha", "/worktrees/two/shared"), worktree("alpha", "/worktrees/one/shared")],
      [
        { ...worktree("alpha", "/worktrees/one/shared"), pathPrefix: "alpha" },
        { ...worktree("alpha", "/worktrees/two/shared"), pathPrefix: "alpha" },
      ],
    );
    assert.deepEqual([...kept.values()], ["alpha@shared", "alpha"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Turn 2 had no worktrees; turn 3 first attached beta, and its baseline sits
// at ordinal 2. Turn 2's checkpoint names that baseline.
it.effect.each([
  { stored: "marked backfilled", expected: { _tag: "found", ordinal: 2 } },
  { stored: "from before backfills were marked", expected: { _tag: "unavailable", ordinal: 1 } },
] as const)("rewinds beta to turn 1 past a borrowed entry $stored", ({ stored, expected }) => {
  const scopeId = CheckpointScopeId.make("checkpoint-scope:borrowed");
  const worktreePath = "/worktrees/beta/t3-thread";
  const entry = (ordinal: number) => ({
    repository: "beta",
    repositoryPath: "/folder/beta",
    worktreePath,
    branch: "t3/thread",
    pathPrefix: "beta",
    ref: CheckpointRef.make(`refs/t3/beta/ordinal/${ordinal}`),
    status: "ready" as const,
  });
  const history: CheckpointService.RepositoryCheckpointHistory = {
    scopeId,
    checkpoints: [
      { scopeId, ordinalWithinScope: 1, status: "ready", repositories: [] },
      {
        scopeId,
        ordinalWithinScope: 2,
        status: "ready",
        repositories: [
          stored === "marked backfilled" ? { ...entry(2), backfilled: true } : entry(2),
        ],
      },
      { scopeId, ordinalWithinScope: 3, status: "ready", repositories: [entry(3)] },
    ],
    runs: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }],
  };
  return Effect.gen(function* () {
    const snapshot = yield* CheckpointService.resolveRepositorySnapshot({
      history,
      worktreePath,
      cwd: worktreePath,
      targetOrdinal: 1,
    });
    assert.deepEqual(
      snapshot._tag === "none" ? snapshot : { _tag: snapshot._tag, ordinal: snapshot.ordinal },
      expected,
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointStore.CheckpointStore)({
          // Only beta's attach baseline, at ordinal 2, exists.
          hasCheckpointRef: ({ checkpointRef }) =>
            Effect.succeed(checkpointRef.endsWith("/ordinal/2")),
        }),
        NodeCrypto.layer,
      ),
    ),
  );
});

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect(
  "bounds a slow baseline snapshot but waits for an in-flight capture of the same ref",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
        threadId: ThreadId.make("thread:slow-baseline"),
        runId: RunId.make("run:slow-baseline:1"),
        nodeId: NodeId.make("node:slow-baseline:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/slow",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const snapshots = yield* Ref.make(0);
      const firstSnapshotStarted = yield* Deferred.make<void>();
      // Baselines with repository worktrees resolve real paths first, so the clock moves
      // only once their snapshots have started.
      const startedSnapshots = yield* Ref.make<Queue.Queue<string> | undefined>(undefined);
      const watchSnapshots = Effect.gen(function* () {
        const started = yield* Queue.unbounded<string>();
        yield* Ref.set(startedSnapshots, started);
        return (count: number) =>
          Effect.forEach(Array.from({ length: count }), () => Queue.take(started), {
            discard: true,
          });
      });
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ cwd, checkpointRef }) =>
                Effect.gen(function* () {
                  yield* Ref.update(snapshots, (count) => count + 1);
                  yield* Deferred.succeed(firstSnapshotStarted, undefined);
                  const started = yield* Ref.get(startedSnapshots);
                  if (started !== undefined) yield* Queue.offer(started, cwd);
                  yield* Effect.sleep("10 seconds");
                  yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                }),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
        const postTurn = yield* checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const waitingBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 1 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
        assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

        const slowBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 2 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(slowBaseline))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), 2);
        assert.strictEqual((yield* Ref.get(refs)).size, 1);

        // A repository worktree's baseline has the same budget and records the timeout.
        const awaitRepositoryBaseline = yield* watchSnapshots;
        const repositoryBaseline = yield* checkpoints
          .captureRepositoryBaseline({
            threadId: scope.threadId,
            repoWorktree: serviceWorktree,
            ordinalWithinScope: 0,
          })
          .pipe(Effect.forkChild);
        yield* awaitRepositoryBaseline(1);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(yield* Fiber.join(repositoryBaseline), "error");

        // Two slow repository snapshots and the workspace's share one budget.
        const started = yield* Ref.get(snapshots);
        const awaitSideBySide = yield* watchSnapshots;
        const repositoriesAndWorkspace = yield* checkpoints
          .captureBaseline({
            scope,
            ordinalWithinScope: 3,
            repoWorktrees: [
              serviceWorktree,
              {
                ...serviceWorktree,
                repository: "client",
                worktreePath: "/worktrees/client/feature",
              },
            ],
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* awaitSideBySide(3);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(repositoriesAndWorkspace))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), started + 3);

        // The workspace snapshot alone covers a checkout the thread attached itself.
        const beforeOwn = yield* Ref.get(snapshots);
        const awaitOwnCheckout = yield* watchSnapshots;
        const ownCheckout = yield* checkpoints
          .captureBaseline({
            scope,
            ordinalWithinScope: 4,
            repoWorktrees: [{ ...serviceWorktree, worktreePath: scope.cwd }],
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* awaitOwnCheckout(1);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(ownCheckout))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), beforeOwn + 1);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
        repoWorktrees: [serviceWorktree],
      });
      const repositoryBaseline = yield* checkpoints.captureRepositoryBaseline({
        threadId: scope.threadId,
        repoWorktree: serviceWorktree,
        ordinalWithinScope: 0,
      });
      return {
        baseline: baseline.status,
        turn: turn.status,
        repositoryTurn: turn.repositories?.map((entry) => entry.status),
        repositoryBaseline,
      };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, {
      baseline: "error",
      turn: "error",
      repositoryTurn: ["error"],
      repositoryBaseline: "error",
    });
  }),
);

it.effect.each([
  { diff: "is empty", numstat: "", failed: false, changed: false },
  {
    diff: "has only a merged upstream's file",
    numstat: "1\t0\tupstream.txt",
    failed: false,
    changed: true,
  },
  { diff: "fails", numstat: "", failed: true, changed: true },
] as const)(
  "counts the workspace as changed when its diff $diff: $changed",
  ({ numstat, failed, changed }) =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const result = yield* checkpoints.workspaceChanged({
        scopeId: CheckpointScopeId.make("checkpoint-scope:workspace-changed"),
        cwd: "/repo/project",
        fromCheckpointRef: CheckpointRef.make("refs/t3/project/ordinal/1"),
        toCheckpointRef: CheckpointRef.make("refs/t3/project/ordinal/2"),
      });
      assert.equal(result, changed);
    }).pipe(
      Effect.provide(
        CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                diffCheckpoints: ({ cwd }) =>
                  failed
                    ? Effect.fail(
                        new VcsProcessExitError({
                          operation: "GitVcsDriver.diffCheckpoints",
                          command: "git",
                          cwd,
                          exitCode: 128,
                          detail: "fatal: bad object",
                        }),
                      )
                    : Effect.succeed(numstat),
                // No later commit wrote anything: every changed path is a Git import.
                listAuthoredPaths: () => Effect.succeed(new Set<string>()),
              }),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("finishes repository baselines when the workspace baseline fails", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:workspace-failure"),
      threadId: ThreadId.make("thread:workspace-failure"),
      runId: RunId.make("run:workspace-failure:1"),
      nodeId: NodeId.make("node:workspace-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:workspace-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/broken-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const captured = yield* Ref.make<ReadonlyArray<string>>([]);
    const repositoryStarted = yield* Deferred.make<void>();
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: (cwd) =>
              cwd === scope.cwd
                ? Effect.fail(
                    new VcsProcessExitError({
                      operation: "GitVcsDriver.detectRepository",
                      command: "git",
                      cwd,
                      exitCode: 128,
                      detail: "fatal: bad config line 1 in file .git/config",
                    }),
                  )
                : Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: ({ cwd }) =>
              Deferred.succeed(repositoryStarted, undefined).pipe(
                Effect.andThen(Effect.sleep("1 second")),
                Effect.andThen(Ref.update(captured, (paths) => [...paths, cwd])),
              ),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 1, repoWorktrees: [serviceWorktree] })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(repositoryStarted);
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(baseline))._tag, "Failure");
      assert.deepEqual(yield* Ref.get(captured), [serviceWorktree.worktreePath]);
    }).pipe(Effect.provide(layerTest));
  }),
);
