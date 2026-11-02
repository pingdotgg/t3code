import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

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
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: () =>
              Effect.suspend(() => {
                attempts++;
                return healthy ? Effect.void : Effect.fail(timeout);
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
      yield* checkpoints.captureBaseline({ scope: otherThread, ordinalWithinScope: 0 });
      assert.strictEqual(attempts, 2, "baseline retried a repeatedly timing-out workspace");

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
    }).pipe(Effect.provide(layerTest));
  }),
);
