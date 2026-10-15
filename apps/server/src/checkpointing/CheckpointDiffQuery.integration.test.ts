import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provide(NodeServices.layer),
);
const layerTest = Layer.merge(layerStore, layerVcsProcess).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("bounds a filtered query through real checkpoint storage and Git", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diff-aggregate-" });
    const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      process.run({
        operation: "CheckpointDiffQuery.test.git",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const threadId = ThreadId.make("thread:aggregate-runtime");
    const runId = RunId.make("run:aggregate-runtime");
    const scopeId = CheckpointScopeId.make("scope:aggregate-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/aggregate-after");
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    // The old commit models files imported by a pull after the baseline was captured.
    yield* fs.writeFileString(path.join(cwd, "upstream.ts"), "imported\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "imported"], {
      ...globalThis.process.env,
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
    yield* Effect.forEach(
      ownPaths,
      (file) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, file), `${"x".repeat(24_000)}\n`);
        }),
      { concurrency: 16, discard: true },
    );
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });

    let patchReads = 0;
    let collectedBytes = 0;
    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                { scopeId, runId, appRunOrdinal: 1, status: "ready", ref: toCheckpointRef },
              ],
            }),
        }),
      ),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...store,
        diffCheckpoints: (input) =>
          store.diffCheckpoints(input).pipe(
            Effect.tap((patch) =>
              Effect.sync(() => {
                if (input.format !== "numstat") {
                  patchReads += 1;
                  collectedBytes += Buffer.byteLength(patch);
                }
              }),
            ),
          ),
      }),
    );
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
    yield* Effect.logInfo(
      JSON.stringify({
        samples: 1,
        patchReads,
        collectedBytes,
        responseBytes: Buffer.byteLength(result.diff),
      }),
    );
    assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff.endsWith("\n\n[truncated]"));
    assert.notInclude(result.diff, "upstream.ts");
    assert.strictEqual(patchReads, 1);
    assert.isAtMost(collectedBytes, 9_999_988);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
