import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const layerNoTrackedFolders = Layer.merge(
  NodeServices.layer,
  Layer.mock(WorkspaceFolders.WorkspaceFolders)({
    forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
  }),
);

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
              layerNoTrackedFolders,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
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
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            layerNoTrackedFolders,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ checkpointRef }) =>
                Effect.gen(function* () {
                  yield* Ref.update(snapshots, (count) => count + 1);
                  yield* Deferred.succeed(firstSnapshotStarted, undefined);
                  yield* Effect.sleep("10 seconds");
                  yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
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
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect(
  "asks Git about a tracked repository once a turn and snapshots it only when changed",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:repositories"),
        threadId: ThreadId.make("thread:repositories"),
        runId: RunId.make("run:repositories:1"),
        nodeId: NodeId.make("node:repositories:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:repositories"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/wrapper",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const thread = { projectId: ProjectId.make("project:repositories"), worktreePath: null };
      const repositories = Array.from({ length: 30 }, (_, index) => `/wrapper/repo-${index}`);
      const [slowRepository, changedRepository] = [repositories[7]!, repositories[3]!];
      const startHead = "a".repeat(40);
      const heads = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
      const slow = yield* Ref.make(true);
      const slowStarted = yield* Deferred.make<void>();
      const othersSeen = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(WorkspaceFolders.WorkspaceFolders)({
              forThread: () =>
                Effect.succeed({
                  folders: [
                    ...repositories.map((path) => ({
                      name: path,
                      path,
                      isGitRepository: true,
                      // The first is a task folder's worktree of a tracked checkout elsewhere.
                      ...(path === repositories[0] ? { repositoryPath: "/tracked/repo-0" } : {}),
                    })),
                    { name: "notes", path: "/wrapper/notes", isGitRepository: false },
                  ],
                  extraRoots: [],
                }),
            }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: (cwd) => record(`probe ${cwd}`).pipe(Effect.as(cwd !== "/wrapper")),
              resolveCleanHead: (cwd) =>
                Effect.gen(function* () {
                  // One repository is too slow for the turn to wait on.
                  if (cwd === slowRepository && (yield* Ref.get(slow))) {
                    yield* Deferred.succeed(slowStarted, undefined);
                    yield* Effect.sleep("1 minute");
                  }
                  yield* record(`status ${cwd}`);
                  if ((yield* Ref.get(calls)).length === repositories.length - 1) {
                    yield* Deferred.succeed(othersSeen, undefined);
                  }
                  return (yield* Ref.get(heads)).get(cwd) ?? startHead;
                }),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureHeadCheckpoint: ({ cwd, head, checkpointRef }) =>
                record(`snapshot ${cwd} at ${head[0]}`).pipe(
                  Effect.andThen(
                    Ref.update(refs, (current) => new Set([...current, checkpointRef])),
                  ),
                ),
              diffCheckpoints: () => Effect.succeed("1\t0\tfile.ts\0"),
              listAuthoredPaths: () => Effect.succeed(null),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const scopes = yield* checkpoints.repositoryScopes({ rootScope: scope, ...thread });
        // The plain folder gets no scope.
        assert.deepEqual(
          scopes.map((repository) => repository.cwd),
          repositories,
        );
        // A scope works in the thread's checkout and is known by the tracked folder it stands for.
        assert.deepEqual(
          scopes.slice(0, 2).map((repository) => repository.repositoryPath),
          ["/tracked/repo-0", repositories[1]],
        );
        const captureAll = (ordinalWithinScope: number) =>
          Effect.forEach(scopes, (repository) =>
            checkpoints.captureRepository({
              scope: repository,
              runId: scope.runId!,
              nodeId: scope.nodeId,
              ordinalWithinScope,
              capturedAt: scope.createdAt,
              baselineCapturedAt: scope.createdAt,
              baselineRecorded: false,
            }),
          );

        // Every baseline shares the turn's budget; the slow repository is left without one.
        const firstTurn = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 0, thread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(slowStarted);
        yield* Deferred.await(othersSeen);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(firstTurn);
        yield* Ref.set(slow, false);

        // A turn that changes nothing writes nothing and records nothing.
        assert.isTrue((yield* captureAll(1)).every(Option.isNone));
        assert.isFalse((yield* Ref.get(calls)).some((call) => call.startsWith("snapshot")));

        // The next turn starts from what each repository's last run ended with, so only the
        // thread's own folder is read.
        yield* Ref.set(calls, []);
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1, thread });
        assert.deepEqual(yield* Ref.get(calls), ["probe /wrapper"]);

        // The turn commits in one repository: its baseline is snapshotted from where it started.
        yield* Ref.set(heads, new Map([[changedRepository, "b".repeat(40)]]));
        yield* Ref.set(calls, []);
        const recorded = (yield* captureAll(2)).flatMap(Option.toArray);
        assert.deepEqual(
          recorded.map(({ baseline, checkpoint }) => ({
            cwd: scopes.find((repository) => repository.id === checkpoint.scopeId)?.cwd,
            baseline: baseline?.ordinalWithinScope,
            ordinal: checkpoint.ordinalWithinScope,
            files: checkpoint.files.map((file) => file.path),
          })),
          [{ cwd: changedRepository, baseline: 1, ordinal: 2, files: ["file.ts"] }],
        );
        assert.deepEqual(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("snapshot")),
          [`snapshot ${changedRepository} at a`, `snapshot ${changedRepository} at b`],
        );
        assert.lengthOf(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("status")),
          repositories.length,
        );
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
          layerNoTrackedFolders,
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
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
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
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);
