import {
  NonNegativeInt,
  ThreadId,
  type OrchestrationRestoreWorkspaceCheckpointInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { withWorkspaceCheckpointLock } from "./CheckpointWorkspaceLock.ts";
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

export const restoreWorkspaceCheckpoint = Effect.fn("CheckpointWorkspaceRestore.restore")(
  function* (input: OrchestrationRestoreWorkspaceCheckpointInput) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

    const initialContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      input.threadId,
    );
    if (Option.isNone(initialContext)) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Thread '${input.threadId}' was not found.`,
      });
    }

    const cwd = initialContext.value.worktreePath ?? initialContext.value.workspaceRoot;
    if (!cwd) {
      return yield* new CheckpointWorkspaceRestoreFailedError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Thread '${input.threadId}' has no workspace path.`,
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

    return yield* withWorkspaceCheckpointLock(
      cwd,
      Effect.gen(function* () {
        // Re-read under the lock so latest-turn checks and checkpoint refs cannot
        // race a concurrent capture that lands after the pre-lock cwd lookup.
        const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
        if (Option.isNone(context)) {
          return yield* new CheckpointWorkspaceRestoreFailedError({
            threadId: input.threadId,
            turnCount: input.turnCount,
            detail: `Thread '${input.threadId}' was not found.`,
          });
        }

        const threadShell = yield* projectionSnapshotQuery.getThreadShellById(input.threadId);
        const session = Option.isSome(threadShell) ? threadShell.value.session : null;
        if (session?.activeTurnId != null || session?.status === "running") {
          return yield* new CheckpointWorkspaceRestoreFailedError({
            threadId: input.threadId,
            turnCount: input.turnCount,
            detail: "Interrupt the current turn before rewinding workspace changes.",
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
        // Capture/refresh are best-effort: restore already mutated the tree, so
        // failing the RPC here would leave clients with a stale Diff tab.
        yield* checkpointStore
          .captureCheckpoint({ cwd, checkpointRef: updatedCheckpointRef })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* workspaceEntries.refresh(cwd).pipe(Effect.ignoreCause({ log: true }));
        yield* vcsStatusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
        return { restored: true as const };
      }),
    );
  },
);
