import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
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
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provide(NodeServices.layer),
);
const layerWorkspaceTest = CheckpointService.layer.pipe(
  Layer.provideMerge(layerStore),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect.each(["worktree", "repository"] as const)(
  "keeps checkpoint diffs and restore ownership in their original workspace after a move to another %s",
  (destination) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-move-" });
      const firstCwd = path.join(parent, "a");
      const secondCwd = path.join(parent, "b");
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        vcs.run({ operation: "CheckpointService.test.git", command: "git", cwd, args });
      const init = Effect.fn("CheckpointService.test.init")(function* (cwd: string) {
        yield* fs.makeDirectory(cwd);
        yield* git(cwd, ["init"]);
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* fs.writeFileString(path.join(cwd, "common.txt"), "initial\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "initial"]);
      });
      yield* init(firstCwd);
      if (destination === "worktree") {
        yield* git(firstCwd, ["worktree", "add", "-b", "destination", secondCwd]);
      } else {
        yield* init(secondCwd);
      }
      yield* fs.writeFileString(path.join(secondCwd, "branch-only.txt"), "destination commit\n");
      yield* git(secondCwd, ["add", "."]);
      yield* git(secondCwd, ["commit", "-m", "destination commit"]);

      const threadId = ThreadId.make("thread:workspace-move");
      const providerThreadId = ProviderThreadId.make("provider-thread:workspace-move");
      const createdAt = DateTime.makeUnsafe("2026-11-04T00:00:00Z");
      const scopes = new Map<CheckpointScopeId, OrchestrationV2CheckpointScope>();
      const prepare = Effect.fn("CheckpointService.test.prepare")(function* (
        cwd: string,
        ordinal: number,
      ) {
        const scope = yield* checkpoints.prepareRootRunScope({
          threadId,
          providerThreadId,
          runId: RunId.make(`run:workspace-move:${ordinal}`),
          rootNodeId: NodeId.make(`node:workspace-move:${ordinal}`),
          cwd,
          createdAt,
        });
        scopes.set(scope.id, scope);
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: ordinal - 1 });
        return scope;
      });
      const capture = (scope: OrchestrationV2CheckpointScope, ordinal: number) =>
        checkpoints.capture({
          scope,
          runId: scope.runId,
          nodeId: scope.nodeId!,
          ordinalWithinScope: ordinal,
          appRunOrdinal: ordinal,
          capturedAt: createdAt,
        });
      const firstScope = yield* prepare(firstCwd, 1);
      yield* fs.writeFileString(path.join(firstCwd, "first-turn.txt"), "first turn\n");
      const first = yield* capture(firstScope, 1);
      const secondScope = yield* prepare(secondCwd, 2);
      yield* fs.writeFileString(path.join(secondCwd, "second-turn.txt"), "second turn\n");
      const second = yield* capture(secondScope, 2);
      assert.deepEqual(
        second.files.map((file) => file.path),
        ["second-turn.txt"],
      );
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope: secondScope,
        ordinalWithinScope: 1,
      });
      assert.equal(baseline.status, "ready");
      const query = yield* CheckpointDiffQuery.make.pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [
                  { id: first.runId!, ordinal: 1, status: "completed" },
                  { id: second.runId!, ordinal: 2, status: "completed" },
                ],
                checkpoints: [first, baseline, second],
                checkpointScopes: [...scopes.values()].toReversed(),
              }),
          }),
        ),
      );
      const originalDiff = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
      assert.include(originalDiff.diff, "first-turn.txt");
      assert.notInclude(originalDiff.diff, "branch-only.txt");
      const diff = yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
      assert.include(diff.diff, "second-turn.txt");
      assert.notInclude(diff.diff, "branch-only.txt");
      assert.notInclude(diff.diff, "first-turn.txt");
      const isolated = yield* isCheckpointRestoreIsolated(
        { id: threadId, worktreePath: secondCwd },
        scopes.get(first.scopeId)!,
        {
          fileSystem: fs,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
          } as never,
          projects: {} as never,
        },
      );
      assert.isFalse(isolated);
      assert.equal(scopes.get(first.scopeId)?.cwd, firstCwd);
      const thirdScope = yield* prepare(secondCwd, 3);
      assert.equal(thirdScope.id, secondScope.id);
      assert.equal(
        yield* fs.readFileString(path.join(secondCwd, "branch-only.txt")),
        "destination commit\n",
      );
    }).pipe(Effect.scoped, Effect.provide(layerWorkspaceTest)),
);
