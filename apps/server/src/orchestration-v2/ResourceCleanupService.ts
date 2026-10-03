import type { CheckpointRef, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

interface CheckpointCleanupTarget {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/**
 * Each scope cwd is a target, and so is the project root with every ref: a
 * worktree shares its refs with the project repository and is often removed
 * first, by storage cleanup or by hand. Ref names derive from the thread's own
 * scope ids, so a repository that never held them deletes nothing, and no
 * other thread's refs can match.
 */
const checkpointCleanupTargets = (
  records: ProjectionStore.ProjectionRecords<"checkpointScopes" | "checkpoints">,
  workspaceRoot: string | null,
): ReadonlyArray<CheckpointCleanupTarget> => {
  const scopeCwdById = new Map(records.checkpointScopes.map((scope) => [scope.id, scope.cwd]));
  const refsByCwd = new Map<string, Set<CheckpointRef>>();
  const add = (cwd: string, ref: CheckpointRef) => {
    const refs = refsByCwd.get(cwd) ?? new Set<CheckpointRef>();
    refs.add(ref);
    refsByCwd.set(cwd, refs);
  };
  for (const checkpoint of records.checkpoints) {
    const cwd = scopeCwdById.get(checkpoint.scopeId);
    if (cwd === undefined) continue;
    add(cwd, checkpoint.ref);
    if (workspaceRoot !== null) add(workspaceRoot, checkpoint.ref);
  }
  return [...refsByCwd].map(([cwd, refs]) => ({ cwd, checkpointRefs: [...refs] }));
};

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "attachment", "checkpoint"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
  /**
   * Delete a deleted thread's checkpoint refs from each repository that holds
   * them. The refs are read from the projection when the effect runs, so a
   * capture that landed after the deletion was planned is included. A target
   * whose directory is gone or is no longer a Git repository is skipped: the
   * refs went with it, or were never ours to touch. Every target is attempted
   * before the first failure is raised, so a retry only has the remaining refs
   * left to delete.
   */
  readonly cleanupCheckpointRefs: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
    cleanupCheckpointRefs: () => Effect.void,
  }),
}) {}

export const live = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const cleanupCheckpointTarget = (target: CheckpointCleanupTarget) =>
      Effect.gen(function* () {
        // A removed worktree is the expected miss. Any other detection failure,
        // such as a Git timeout, is a real failure and goes through the retry.
        if (!(yield* fileSystem.exists(target.cwd))) return;
        if (!(yield* checkpointStore.isGitRepository(target.cwd))) return;
        yield* checkpointStore.deleteCheckpointRefs(target).pipe(
          // A project pinned to another VCS holds no refs of ours.
          Effect.catchTag("VcsUnsupportedOperationError", () => Effect.void),
        );
      }).pipe(
        Effect.mapError(
          (cause) => new ResourceCleanupError({ operation: "checkpoint", cwd: target.cwd, cause }),
        ),
      );
    return {
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
      cleanupCheckpointRefs: (threadId) =>
        Effect.gen(function* () {
          const readError = (cause: unknown) =>
            new ResourceCleanupError({ operation: "checkpoint", threadId, cause });
          // Projection maintenance may have pruned the thread already; then
          // nothing is recorded to delete.
          const records = yield* projections
            .getThreadRecords(threadId, ["checkpointScopes", "checkpoints"])
            .pipe(
              Effect.map(Option.some),
              Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeedNone),
              Effect.mapError(readError),
            );
          if (Option.isNone(records)) return;
          const project = yield* projects
            .get(records.value.thread.projectId, { includeDeleted: true })
            .pipe(Effect.mapError(readError));
          const targets = checkpointCleanupTargets(
            records.value,
            Option.isSome(project) ? project.value.workspaceRoot : null,
          );
          const failures: Array<ResourceCleanupError> = [];
          for (const target of targets) {
            const result = yield* Effect.result(cleanupCheckpointTarget(target));
            if (Result.isFailure(result)) failures.push(result.failure);
          }
          // The caller sees and logs the first failure; the rest are logged here
          // so no repository drops out of the record.
          for (const failure of failures.slice(1)) {
            yield* Effect.logWarning("Checkpoint cleanup failed in another repository", {
              cwd: failure.cwd,
              error: failure,
            });
          }
          if (failures[0] !== undefined) return yield* failures[0];
        }),
    };
  }),
);
