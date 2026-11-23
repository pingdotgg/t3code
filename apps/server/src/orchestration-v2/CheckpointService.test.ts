import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
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
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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
    submodules: () => Effect.succeed([]),
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

        for (const ordinalWithinScope of [2, 3]) {
          const slowBaseline = yield* checkpoints
            .captureBaseline({ scope, ordinalWithinScope })
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("5 seconds");
          const result = yield* Fiber.join(slowBaseline);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.isTrue(Cause.isTimeoutError(result.failure.cause));
          }
        }
        const backedOffBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 4 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(backedOffBaseline))._tag, "Success");
        assert.strictEqual(yield* Ref.get(snapshots), 3);
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
      const unreadableRepository = repositories[5]!;
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
              submodules: () => Effect.succeed([]),
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
              diffCheckpoints: ({ cwd }) =>
                cwd === unreadableRepository
                  ? Effect.fail(
                      new VcsProcessExitError({
                        operation: "test.diff",
                        command: "git",
                        cwd,
                        exitCode: 128,
                        detail: "fatal: unable to read tree",
                      }),
                    )
                  : Effect.succeed("1\t0\tfile.ts\0"),
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

        // The turn commits in two repositories: each baseline is snapshotted from where it started.
        // One of them cannot list what changed, which is not the same as nothing having changed.
        yield* Ref.set(
          heads,
          new Map([
            [changedRepository, "b".repeat(40)],
            [unreadableRepository, "b".repeat(40)],
          ]),
        );
        yield* Ref.set(calls, []);
        const recorded = (yield* captureAll(2)).flatMap(Option.toArray);
        assert.deepEqual(
          recorded.map(({ baseline, checkpoint }) => ({
            cwd: scopes.find((repository) => repository.id === checkpoint.scopeId)?.cwd,
            baseline: baseline?.ordinalWithinScope,
            ordinal: checkpoint.ordinalWithinScope,
            files: checkpoint.files.map((file) => file.path),
          })),
          [
            { cwd: changedRepository, baseline: 1, ordinal: 2, files: ["file.ts"] },
            { cwd: unreadableRepository, baseline: 1, ordinal: 2, files: [] },
          ],
        );
        assert.deepEqual(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("snapshot")),
          [changedRepository, unreadableRepository].flatMap((cwd) => [
            `snapshot ${cwd} at a`,
            `snapshot ${cwd} at b`,
          ]),
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

it.effect("backs off only baseline retries after repeated workspace capture timeouts", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:slow-capture"),
      threadId: ThreadId.make("thread:slow-capture"),
      runId: RunId.make("run:slow-capture:1"),
      nodeId: NodeId.make("node:slow-capture:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:slow-capture"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/slow",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const timeout = new VcsProcessTimeoutError({
      operation: "GitVcsDriver.checkpoints.captureCheckpoint",
      command: "git",
      cwd: scope.cwd,
      timeoutMs: 30_000,
    });
    let attempts = 0;
    let healthy = false;
    let nonTimeoutFailure = false;
    const failure = new VcsProcessExitError({
      operation: "test.capture",
      command: "git",
      cwd: scope.cwd,
      exitCode: 128,
      detail: "capture failed",
    });
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          layerNoTrackedFolders,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: () =>
              Effect.suspend(() => {
                attempts++;
                return healthy ? Effect.void : Effect.fail(nonTimeoutFailure ? failure : timeout);
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = { scope, ordinalWithinScope: 0 };
      const turn = {
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId,
        nodeId: scope.nodeId,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      };
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "error");
      assert.strictEqual(attempts, 2);

      const otherThread = { ...scope, id: CheckpointScopeId.make("checkpoint-scope:other") };
      const skipped = yield* Effect.result(
        checkpoints.captureBaseline({ scope: otherThread, ordinalWithinScope: 0 }),
      );
      assert.strictEqual(attempts, 2, "baseline retried a repeatedly timing-out workspace");
      assert.strictEqual(skipped._tag, "Success");

      yield* Effect.result(
        checkpoints.captureBaseline({
          scope: { ...otherThread, cwd: "/repo/other" },
          ordinalWithinScope: 0,
        }),
      );
      assert.strictEqual(attempts, 3, "another workspace must still attempt capture");

      const failedTurn = yield* checkpoints.capture(turn);
      assert.strictEqual(failedTurn.status, "error");
      assert.strictEqual(attempts, 4, "post-turn capture must not back off");

      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 4, "baseline retries must wait for post-turn recovery");
      healthy = true;
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "ready");
      assert.strictEqual(attempts, 5);
      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 6, "a successful post-turn capture must clear backoff");

      healthy = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* checkpoints.captureBaseline(baseline);
      assert.strictEqual(attempts, 8);
      nonTimeoutFailure = true;
      assert.strictEqual((yield* checkpoints.capture(turn)).status, "error");
      nonTimeoutFailure = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual(attempts, 10, "a non-timeout failure must clear backoff");
      healthy = true;
      yield* checkpoints.captureBaseline(baseline);
      healthy = false;
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      yield* Effect.result(checkpoints.captureBaseline(baseline));
      assert.strictEqual(attempts, 13, "a successful baseline must clear the timeout streak");
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("skips post-turn captures that waited out another capture's timeout in the folder", () =>
  Effect.gen(function* () {
    const scopeFor = (name: string): OrchestrationV2CheckpointScope => ({
      id: CheckpointScopeId.make(`checkpoint-scope:shared-folder:${name}`),
      threadId: ThreadId.make(`thread:shared-folder:${name}`),
      runId: RunId.make(`run:shared-folder:${name}:1`),
      nodeId: NodeId.make(`node:shared-folder:${name}:1`),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make(`provider-thread:shared-folder:${name}`),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/shared",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    });
    const attempts = yield* Ref.make(0);
    // Outcomes for upcoming attempts; an attempt with none scripted times out.
    const script = yield* Ref.make<ReadonlyArray<"ready" | "timeout">>([]);
    const started = yield* Queue.unbounded<void>();
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          layerNoTrackedFolders,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            resolveCleanHead: () => Effect.succeed(null),
            captureCheckpoint: ({ cwd }) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (count) => count + 1);
                yield* Queue.offer(started, undefined);
                yield* Effect.sleep("30 seconds");
                const [next = "timeout", ...rest] = yield* Ref.get(script);
                yield* Ref.set(script, rest);
                if (next === "ready") return;
                return yield* new VcsProcessTimeoutError({
                  operation: "GitVcsDriver.checkpoints.captureCheckpoint",
                  command: "git",
                  cwd,
                  timeoutMs: 30_000,
                });
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const captureTurn = (scope: OrchestrationV2CheckpointScope) =>
        checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
      // A baseline's short budget running out says nothing about a post-turn capture.
      const baseline = yield* checkpoints
        .captureBaseline({ scope: scopeFor("baseline"), ordinalWithinScope: 0 })
        .pipe(Effect.result, Effect.forkChild);
      yield* Queue.take(started);
      const afterBaseline = yield* captureTurn(scopeFor("after-baseline"));
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(baseline);
      yield* Queue.take(started);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(afterBaseline)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 2);

      const first = yield* captureTurn(scopeFor("first"));
      yield* Queue.take(started);
      // Other threads in the same folder finish their turns while the first capture hangs.
      const waiting = [
        yield* captureTurn(scopeFor("second")),
        yield* captureTurn(scopeFor("third")),
      ];
      const repository = scopeFor("repository");
      const repositoryWaiting = yield* checkpoints
        .captureRepository({
          scope: repository,
          runId: repository.runId!,
          nodeId: repository.nodeId!,
          ordinalWithinScope: 1,
          capturedAt: repository.createdAt,
          baselineCapturedAt: repository.createdAt,
          baselineRecorded: true,
        })
        .pipe(Effect.forkChild);
      // A thread's root capture first materializes its baseline, which waits on the lock too.
      const root = scopeFor("root");
      const rootWaiting = yield* Effect.gen(function* () {
        const capturesBeforeLock = yield* checkpoints.capturesSoFar(root.cwd);
        yield* checkpoints.materializeBaselineCheckpoint({
          scope: root,
          ordinalWithinScope: 0,
          nodeId: root.nodeId!,
          capturedAt: root.createdAt,
        });
        return yield* checkpoints.capture({
          scope: root,
          ordinalWithinScope: 1,
          runId: root.runId!,
          nodeId: root.nodeId!,
          appRunOrdinal: 1,
          capturedAt: root.createdAt,
          capturesBeforeLock,
        });
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(first)).status, "error");
      // Room for every waiter to probe, so the count below is what fails without the fix.
      yield* TestClock.adjust("120 seconds");
      for (const fiber of waiting) {
        assert.strictEqual((yield* Fiber.join(fiber)).status, "error");
      }
      const repositoryCaptured = yield* Fiber.join(repositoryWaiting);
      assert.strictEqual(Option.getOrThrow(repositoryCaptured).checkpoint.status, "error");
      assert.strictEqual((yield* Fiber.join(rootWaiting)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 3, "each waiter spent its own full timeout");

      // A capture that starts after the timeout still probes for recovery.
      const later = yield* captureTurn(scopeFor("later"));
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(later)).status, "error");
      assert.strictEqual(yield* Ref.get(attempts), 4);

      // A success ahead in the queue does not hide a timeout that follows it.
      yield* Ref.set(script, ["ready", "timeout"]);
      const recovered = yield* captureTurn(scopeFor("recovered"));
      const relapsed = yield* captureTurn(scopeFor("relapsed"));
      const queuedBehind = yield* captureTurn(scopeFor("queued-behind"));
      yield* TestClock.adjust("90 seconds");
      assert.deepEqual(
        [
          (yield* Fiber.join(recovered)).status,
          (yield* Fiber.join(relapsed)).status,
          (yield* Fiber.join(queuedBehind)).status,
        ],
        ["ready", "error", "error"],
      );
      assert.strictEqual(yield* Ref.get(attempts), 6, "the waiter probed after a later timeout");
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("keeps the pre-rewind snapshot of a folder a failed rewind could not put back", () => {
  const targets = ["first", "second"].map((name) => ({
    scope: { id: CheckpointScopeId.make(`checkpoint-scope:rewind:${name}`), cwd: `/repo/${name}` },
    checkpoint: {
      ordinalWithinScope: 1,
      ref: CheckpointRef.make(`refs/t3/test/rewind/${name}`),
      status: "ready" as const,
    },
  }));
  const failure = new VcsProcessTimeoutError({
    operation: "test.restore",
    command: "git",
    cwd: "/repo",
    timeoutMs: 30000,
  });
  const preRewindRefs = new Map<string, string>();
  const captured: Array<string> = [];
  const existing = new Set<string>();
  const deleted: Array<{ readonly cwd: string; readonly ref: string }> = [];
  const layerTest = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        layerNoTrackedFolders,
        Layer.mock(CheckpointStore.CheckpointStore)({
          hasCheckpointRef: (input) =>
            Effect.sync(
              () =>
                targets.some((target) => target.checkpoint.ref === input.checkpointRef) ||
                existing.has(input.checkpointRef),
            ),
          captureCheckpoint: (input) =>
            Effect.sync(() => {
              captured.push(input.cwd);
              existing.add(input.checkpointRef);
              preRewindRefs.set(input.cwd, input.checkpointRef);
            }),
          // The second folder's rewind fails, and then so does putting the first one back.
          restoreCheckpoint: (input) =>
            input.checkpointRef === targets[1]!.checkpoint.ref ||
            input.checkpointRef === preRewindRefs.get("/repo/first")
              ? Effect.fail(failure)
              : Effect.succeed(true),
          deleteCheckpointRefs: (input) =>
            Effect.sync(() => {
              for (const ref of input.checkpointRefs) {
                existing.delete(ref);
                deleted.push({ cwd: input.cwd, ref });
              }
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const result = yield* Effect.result(
      checkpoints.restore({ targets, scopes: targets.map((target) => target.scope) }),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(deleted, [{ cwd: "/repo/second", ref: preRewindRefs.get("/repo/second")! }]);

    // A retry starts from a half-restored folder; the kept snapshot is not taken again.
    yield* Effect.result(
      checkpoints.restore({ targets, scopes: targets.map((target) => target.scope) }),
    );
    assert.deepEqual(captured, ["/repo/first", "/repo/second", "/repo/second"]);
  }).pipe(Effect.provide(layerTest));
});
