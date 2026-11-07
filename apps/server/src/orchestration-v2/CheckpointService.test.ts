import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
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

const layerVcsProcess = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerGitCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      IdAllocator.layer,
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
      ),
    ),
  ),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect("summarizes added, deleted, renamed, and binary files in a captured checkpoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-checkpoint-kinds-" });
    const git = (...args: ReadonlyArray<string>) =>
      vcsProcess.run({ operation: "CheckpointService.test.git", command: "git", cwd, args });
    const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index % 256);
    yield* git("init");
    yield* git("config", "user.email", "test@test.com");
    yield* git("config", "user.name", "Test");
    yield* fs.writeFileString(path.join(cwd, "doomed.txt"), "a\nb\nc\n");
    yield* fs.writeFileString(path.join(cwd, "old-name.txt"), "1\n2\n3\n4\n");
    yield* fs.writeFile(path.join(cwd, "image.bin"), bytes);
    yield* git("add", ".");
    yield* git("commit", "-m", "initial");

    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:file-kinds"),
      threadId: ThreadId.make("thread:file-kinds"),
      runId: RunId.make("run:file-kinds:1"),
      nodeId: NodeId.make("node:file-kinds:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:file-kinds"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd,
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });

    yield* fs.writeFileString(path.join(cwd, "created.txt"), "one\ntwo\nthree\n");
    yield* fs.remove(path.join(cwd, "doomed.txt"));
    yield* git("mv", "old-name.txt", "new-name.txt");
    yield* fs.writeFile(path.join(cwd, "image.bin"), bytes.toReversed());

    const checkpoint = yield* checkpoints.capture({
      scope,
      ordinalWithinScope: 1,
      runId: scope.runId!,
      nodeId: scope.nodeId!,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    });

    assert.deepEqual<ReadonlyArray<object>>(checkpoint.files, [
      { path: "created.txt", kind: "added", additions: 3, deletions: 0 },
      { path: "doomed.txt", kind: "deleted", additions: 0, deletions: 3 },
      { path: "image.bin", kind: "modified", additions: 0, deletions: 0, binary: true },
      { path: "new-name.txt", kind: "renamed", additions: 0, deletions: 0 },
    ]);
  }).pipe(Effect.provide(layerGitCheckpoints)),
);
