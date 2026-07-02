/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { VcsUnsupportedOperationError, type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { CHECKPOINT_REFS_PREFIX } from "./Utils.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface PruneSnapshotsResult {
  readonly deleted: number;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a patch diff between two checkpoint refs.
     *
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /**
     * Prune checkpoint snapshots, keeping only the 3 most recent per session.
     *
     * Lists all checkpoint refs, groups by session, and deletes snapshots
     * beyond the 3 most recent per session. Returns the count of deleted snapshots.
     */
    readonly pruneSnapshots: (
      cwd: string,
    ) => Effect.Effect<PruneSnapshotsResult, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  const pruneSnapshots: CheckpointStore["Service"]["pruneSnapshots"] = Effect.fn(
    "pruneSnapshots",
  )(function* (cwd) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.pruneSnapshots", cwd);
    const allRefs = yield* checkpoints.listCheckpointRefs({ cwd });

    if (allRefs.length === 0) {
      return { deleted: 0 };
    }

    // Parse each ref: refs/t3/checkpoints/{threadId}/turn/{turnCount}
    const parsed = allRefs
      .map((ref) => {
        const refStr = String(ref);
        const prefix = `${CHECKPOINT_REFS_PREFIX}/`;
        const afterPrefix = refStr.slice(refStr.indexOf(prefix) + prefix.length);
        const parts = afterPrefix.split("/turn/");
        if (parts.length !== 2) return null;
        const sessionKey = parts[0];
        const turnCount = parseInt(parts[1], 10);
        if (isNaN(turnCount)) return null;
        return { ref, sessionKey, turnCount };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Group by session, keep top 3 per session
    const bySession = new Map<string, Array<{ ref: CheckpointRef; turnCount: number }>>();
    for (const p of parsed) {
      const existing = bySession.get(p.sessionKey) ?? [];
      existing.push({ ref: p.ref, turnCount: p.turnCount });
      bySession.set(p.sessionKey, existing);
    }

    const toPrune: CheckpointRef[] = [];
    for (const [, entries] of bySession) {
      entries.sort((a, b) => b.turnCount - a.turnCount);
      const exceed = entries.slice(3);
      for (const e of exceed) {
        toPrune.push(e.ref);
      }
    }

    if (toPrune.length === 0) {
      return { deleted: 0 };
    }

    yield* checkpoints.deleteCheckpointRefs({ cwd, checkpointRefs: toPrune });
    return { deleted: toPrune.length };
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
    pruneSnapshots,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
