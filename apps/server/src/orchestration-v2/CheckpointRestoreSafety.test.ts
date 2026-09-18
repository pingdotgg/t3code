import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import {
  CheckpointRollbackServiceV2,
  layer as rollbackLayer,
} from "./CheckpointRollbackService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "archived-nested",
  "project",
  "provider",
  "scope",
  "sibling",
  "stopped-provider",
  "errored-provider",
  "conversation",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      worktreePath:
        owner === "project"
          ? null
          : owner === "ancestor" || owner === "conversation"
            ? parent
            : owner === "nested" || owner === "archived-nested"
              ? nested
              : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThreads: [providerThread],
      providerSessions: [],
      providerTurns: [],
      nodes: [],
      checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: null }],
      checkpointScopes: [{ id: scopeId, cwd }],
      runs: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as OrchestrationV2ThreadProjection;
    const testLayer = rollbackLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          idAllocatorLayer,
          Layer.mock(ProjectionProjectRepository)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: parent } as never)),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThreadProjection: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: owner === "archived-nested" ? [] : ([otherThread] as never),
                archivedThreads: owner === "archived-nested" ? ([otherThread] as never) : [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: owner === "scope" ? ([{ cwd: nested }] as never) : [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions: ["provider", "stopped-provider", "errored-provider"].includes(
                  owner,
                )
                  ? ([
                      {
                        cwd: nested,
                        status:
                          owner === "provider"
                            ? "running"
                            : owner === "errored-provider"
                              ? "error"
                              : "stopped",
                      },
                    ] as never)
                  : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackServiceV2.pipe(Effect.provide(testLayer));
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "stopped-provider", "conversation"].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
