// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ServerConfig } from "../config.ts";
import { checkpointStartRef } from "../checkpointing/Utils.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CheckpointServiceV2,
  checkpointRefForScopeOrdinal,
  layer as checkpointServiceLayer,
} from "./CheckpointService.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

it.effect("materializes the captured baseline at the requested scope ordinal", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
    threadId: ThreadId.make("thread:materialize-baseline"),
    runId: RunId.make("run:materialize-baseline:3"),
    nodeId: NodeId.make("node:materialize-baseline:3"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
  };
  const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
    Effect.succeed(true),
  );
  const testLayer = checkpointServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        idAllocatorLayer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 2,
    });

    assert.equal(baseline.ordinalWithinScope, 2);
    assert.equal(
      baseline.ref,
      checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 2,
      }),
    );
    assert.equal(baseline.status, "ready");
    assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
      cwd: scope.cwd,
      checkpointRef: baseline.ref,
    });
  }).pipe(Effect.provide(testLayer));
});

const processLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const storeLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(processLayer))),
  Layer.provide(NodeServices.layer),
);
const integrationLayer = checkpointServiceLayer.pipe(
  Layer.provideMerge(storeLayer),
  Layer.provide(idAllocatorLayer),
  Layer.provideMerge(processLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-v2-turn-baseline-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("excludes idle edits, preserves history, and discards baselines on rollback", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-turn-baseline-" });
    const process = yield* VcsProcess.VcsProcess;
    const git = (args: ReadonlyArray<string>) =>
      process.run({
        operation: "CheckpointService.test",
        command: "git",
        cwd,
        args,
        timeoutMs: 10000,
      });
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@example.com"]);
    const readme = NodePath.join(cwd, "README.md");
    yield* fs.writeFileString(readme, "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
    const checkpoints = yield* CheckpointServiceV2;
    const store = yield* CheckpointStore.CheckpointStore;
    const scope = yield* checkpoints.prepareRootRunScope({
      threadId: ThreadId.make("thread:idle-edits"),
      runId: RunId.make("run:idle-edits"),
      rootNodeId: NodeId.make("node:idle-edits"),
      providerThreadId: ProviderThreadId.make("provider:idle-edits"),
      cwd,
      createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    });
    const capture = (ordinal: number) =>
      checkpoints.capture({
        scope,
        runId: RunId.make(`run:${ordinal}`),
        nodeId: scope.nodeId,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal,
        capturedAt: DateTime.makeUnsafe("2026-01-01T00:01:00Z"),
      });
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
    const first = yield* capture(1);
    assert.deepEqual(first.files, []);
    yield* fs.writeFileString(readme, "upstream\n");
    yield* git(["commit", "-am", "external update"]);
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
    const second = yield* capture(2);
    assert.deepEqual(second.files, []);
    assert.equal((yield* git(["show", `${first.ref}:README.md`])).stdout, "initial\n");
    yield* fs.writeFileString(NodePath.join(cwd, "outside.txt"), "outside\n");
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 });
    yield* fs.writeFileString(readme, "agent\n");
    // Duplicate start delivery must not move the baseline past agent edits.
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 });
    const third = yield* capture(3);
    assert.deepEqual(third.files, [
      { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
    ]);
    assert.equal((yield* git(["show", `${second.ref}:README.md`])).stdout, "upstream\n");
    yield* checkpoints.restore({ scope, checkpoint: second });
    assert.equal(yield* fs.readFileString(readme), "upstream\n");
    yield* checkpoints.deleteStaleRefs({ scope, checkpoints: [third] });
    assert.equal(
      yield* store.hasCheckpointRef({ cwd, checkpointRef: checkpointStartRef(third.ref) }),
      false,
    );
    yield* fs.writeFileString(readme, "new external state\n");
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 });
    assert.deepEqual((yield* capture(3)).files, []);
  }).pipe(Effect.provide(integrationLayer), Effect.scoped),
);
