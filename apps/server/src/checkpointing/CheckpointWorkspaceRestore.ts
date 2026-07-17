import {
  NonNegativeInt,
  ThreadId,
  type OrchestrationRestoreWorkspaceCheckpointInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";

export class CheckpointWorkspaceRestoreFailedError extends Schema.TaggedErrorClass<CheckpointWorkspaceRestoreFailedError>()(
  "CheckpointWorkspaceRestoreFailedError",
  {
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

// ponytail: per-cwd mutex; SynchronizedRef service if lock lifecycle needs cleanup
const restoreLocks = new Map<string, Semaphore.Semaphore>();

const withWorkspaceRestoreLock = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let lock = restoreLocks.get(cwd);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    restoreLocks.set(cwd, lock);
  }
  return lock.withPermit(effect);
};

export const restoreWorkspaceCheckpoint = Effect.fn("CheckpointWorkspaceRestore.restore")(
  function* (input: OrchestrationRestoreWorkspaceCheckpointInput) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(context)) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Thread '${input.threadId}' was not found.`,
      });
    }

    const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
    if (!cwd) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Thread '${input.threadId}' has no workspace path.`,
      });
    }

    const latestTurnCount = Math.max(
      0,
      ...context.value.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
    );
    if (input.turnCount !== latestTurnCount) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: "Only the latest workspace checkpoint can be rewound.",
      });
    }

    const restoreTurnCount = input.turnCount - 1;
    const checkpointRef =
      restoreTurnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : context.value.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === restoreTurnCount,
          )?.checkpointRef;
    const updatedCheckpointRef = context.value.checkpoints.find(
      (checkpoint) => checkpoint.checkpointTurnCount === input.turnCount,
    )?.checkpointRef;
    if (!checkpointRef || !updatedCheckpointRef) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Checkpoint for thread '${input.threadId}' turn ${input.turnCount} cannot be rewound.`,
      });
    }

    let filePaths: ReadonlyArray<string> | undefined;
    if (input.filePaths !== undefined) {
      if (input.filePaths.length === 0) {
        return yield* new CheckpointWorkspaceRestoreFailedError({
          threadId: input.threadId,
          turnCount: input.turnCount,
          detail: "At least one file path is required for a scoped restore.",
        });
      }
      const resolvedPaths = yield* Effect.forEach(input.filePaths, (relativePath) =>
        workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath,
          })
          .pipe(
            Effect.map((resolved) => resolved.relativePath),
            Effect.mapError(
              () =>
                new CheckpointWorkspaceRestoreFailedError({
                  threadId: input.threadId,
                  turnCount: input.turnCount,
                  detail: `File path '${relativePath}' is outside the workspace.`,
                }),
            ),
          ),
      );
      filePaths = [...new Set(resolvedPaths)];
    }

    return yield* withWorkspaceRestoreLock(
      cwd,
      Effect.gen(function* () {
        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd,
          checkpointRef,
          fallbackToHead: restoreTurnCount === 0,
          ...(filePaths ? { filePaths } : {}),
        });
        if (!restored) {
          return yield* new CheckpointWorkspaceRestoreFailedError({
            threadId: input.threadId,
            turnCount: input.turnCount,
            detail: `Filesystem checkpoint for turn ${restoreTurnCount} is unavailable.`,
          });
        }

        // Keep the latest-turn diff aligned with the restored workspace.
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: updatedCheckpointRef });
        yield* workspaceEntries.refresh(cwd);
        // ponytail: status refresh is best-effort; restore already succeeded
        yield* vcsStatusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
        return { restored: true as const };
      }),
    );
  },
);
