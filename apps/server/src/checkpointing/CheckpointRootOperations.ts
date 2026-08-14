/**
 * Multi-repository checkpoint operations that fan out over a thread's Git roots.
 *
 * The reactor decides when a checkpoint action should occur. This module owns
 * which repositories participate and the best-effort mechanics of applying the
 * same checkpoint operation to every root.
 */
import type {
  CheckpointRef,
  OrchestrationThreadWorktree,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isGitRepository } from "../git/Utils.ts";
import { resolveThreadRepoRoots } from "../workspace/WorkspaceRoots.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

interface CheckpointThreadRootConfig {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly worktrees?: ReadonlyArray<OrchestrationThreadWorktree> | undefined;
}

interface CheckpointProjectRootConfig {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly repoRoots?: ReadonlyArray<string> | undefined;
}

/** Prefer configured project/worktree roots, with the provider cwd as a legacy fallback. */
export function resolveCheckpointRoots(input: {
  readonly thread: CheckpointThreadRootConfig;
  readonly projects: ReadonlyArray<CheckpointProjectRootConfig>;
  readonly sessionCwd: string | undefined;
}): ReadonlyArray<string> {
  const project = input.projects.find((candidate) => candidate.id === input.thread.projectId);
  const configuredRoots = project
    ? resolveThreadRepoRoots({
        worktreePath: input.thread.worktreePath,
        worktrees: input.thread.worktrees,
        repoRoots: project.repoRoots ?? [],
        workspaceRoot: project.workspaceRoot,
      }).filter(isGitRepository)
    : [];
  if (configuredRoots.length > 0) return configuredRoots;
  return input.sessionCwd && isGitRepository(input.sessionCwd) ? [input.sessionCwd] : [];
}

/** Capture a baseline where missing. Returns whether at least one root changed. */
export const captureBaselineAcrossRoots = Effect.fn("captureBaselineAcrossRoots")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly roots: ReadonlyArray<string>;
    readonly baselineCheckpointRef: CheckpointRef;
  }): Effect.fn.Return<boolean, never, CheckpointStore.CheckpointStore> {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const results = yield* Effect.forEach(
      input.roots,
      (root) =>
        Effect.gen(function* () {
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: root,
            checkpointRef: input.baselineCheckpointRef,
          });
          if (exists) return false;
          yield* checkpointStore.captureCheckpoint({
            cwd: root,
            checkpointRef: input.baselineCheckpointRef,
          });
          return true;
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("pre-turn baseline capture failed for root", {
              threadId: input.threadId,
              root,
              detail: error.message,
            }).pipe(Effect.as(false)),
          ),
        ),
      { concurrency: 4 },
    );
    return results.some((captured) => captured);
  },
);

export const restoreCheckpointAcrossRoots = Effect.fn("restoreCheckpointAcrossRoots")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly capturedTargets: ReadonlyArray<{
      readonly root: string;
      readonly checkpointRef: CheckpointRef;
    }>;
    readonly legacyRoots: ReadonlyArray<string>;
    readonly legacyCheckpointRef: CheckpointRef;
  }) {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const legacyRootAvailability =
      input.capturedTargets.length > 0
        ? []
        : yield* Effect.forEach(
            input.legacyRoots,
            (root) =>
              checkpointStore
                .hasCheckpointRef({ cwd: root, checkpointRef: input.legacyCheckpointRef })
                .pipe(
                  Effect.map((available) => ({ root, available })),
                  Effect.catch((error) =>
                    Effect.logWarning("checkpoint restore preflight failed for root", {
                      threadId: input.threadId,
                      turnCount: input.turnCount,
                      root,
                      detail: error.message,
                    }).pipe(Effect.as({ root, available: false })),
                  ),
                ),
            { concurrency: 4 },
          );
    const targets =
      input.capturedTargets.length > 0
        ? input.capturedTargets
        : legacyRootAvailability
            .filter(({ available }) => available)
            .map(({ root }) => ({ root, checkpointRef: input.legacyCheckpointRef }));
    const results = yield* Effect.forEach(
      targets,
      ({ root, checkpointRef }) =>
        checkpointStore.restoreCheckpoint({ cwd: root, checkpointRef, fallbackToHead: false }).pipe(
          Effect.map((restored) => ({ root, restored })),
          Effect.catch((error) =>
            Effect.logWarning("checkpoint restore failed for root", {
              threadId: input.threadId,
              turnCount: input.turnCount,
              root,
              detail: error.message,
            }).pipe(Effect.as({ root, restored: false })),
          ),
        ),
      { concurrency: 4 },
    );
    return {
      targetCount: targets.length,
      restoredRoots: results.filter((entry) => entry.restored).map((entry) => entry.root),
      failedRoots: results.filter((entry) => !entry.restored).map((entry) => entry.root),
    };
  },
);

/** Stale refs are cleanup only: attempt every root and retain the successful revert. */
export const deleteCheckpointRefsAcrossRoots = Effect.fn("deleteCheckpointRefsAcrossRoots")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly roots: ReadonlyArray<string>;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    yield* Effect.forEach(
      input.roots,
      (root) =>
        checkpointStore
          .deleteCheckpointRefs({ cwd: root, checkpointRefs: input.checkpointRefs })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete stale checkpoint refs for root", {
                threadId: input.threadId,
                root,
                detail: error.message,
              }),
            ),
          ),
      { discard: true },
    );
  },
);
